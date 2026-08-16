/**
 * server/recorder.mjs — 服务端会话录制(输出 MP4,编码与串流一致)。
 *
 * 录制的是 scrcpy 视频 socket 的原始 Annex-B 码流(H.264/H.265),
 * 因此输出文件的编码格式天然与串流编码一致。流程:
 *   1. 开始录制:用会话缓存的参数集(SPS/PPS)初始化,立即开始录制
 *   2. 第一个关键帧(IDR)前丢弃普通帧,保证文件从头可解码
 *   3. 停止录制:finish() 封装 MP4 并写入 tmp/recordings/,返回下载路径
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mp4Recorder } from "../shared/mp4-muxer.mjs";
import { splitAnnexB, hevcNalType } from "../shared/nal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = path.join(__dirname, "..", "tmp", "recordings");

export function ensureRecordingsDir() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

/** 磁盘剩余空间(字节) */
export function getDiskFree() {
  try {
    ensureRecordingsDir();
    const st = fs.statfsSync(RECORDINGS_DIR);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return { free: Infinity, total: Infinity };
  }
}

/**
 * 清理录制文件:超过保留天数、或总量超上限时删除最旧的。
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] 文件保留时长(默认 7 天)
 * @param {number} [opts.maxTotalBytes] 录制总量上限(默认 2GB)
 * @returns {{deleted:string[], freed:number, totalBytes:number}}
 */
export function cleanupRecordings({ maxAgeMs = 7 * 86400e3, maxTotalBytes = 2 * 1024 ** 3 } = {}) {
  let files = [];
  try {
    files = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => {
        const p = path.join(RECORDINGS_DIR, f);
        const st = fs.statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return { deleted: [], freed: 0, totalBytes: 0 };
  }
  const now = Date.now();
  let total = files.reduce((s, f) => s + f.size, 0);
  const deleted = [];
  let freed = 0;
  const remove = (f) => {
    try {
      fs.unlinkSync(f.p);
      deleted.push(f.p);
      total -= f.size;
      freed += f.size;
    } catch {}
  };
  // 1. 超过保留时长的文件
  for (const f of files) {
    if (now - f.mtime > maxAgeMs) remove(f);
  }
  // 2. 总量超限时删除最旧的文件
  if (total > maxTotalBytes) {
    const rest = files
      .filter((f) => !deleted.includes(f.p))
      .sort((a, b) => a.mtime - b.mtime);
    for (const f of rest) {
      if (total <= maxTotalBytes) break;
      remove(f);
    }
  }
  return { deleted, freed, totalBytes: total };
}

/** 帧内是否包含 IDR NAL(不依赖设备的 KEY_FRAME flag,部分模拟器不设置该标志) */
function containsIdr(data, codec) {
  for (const nal of splitAnnexB(data)) {
    if (codec === "h264") {
      if (nal.nalType === 5) return true; // IDR
    } else {
      const t = hevcNalType(nal.data);
      if (t === 19 || t === 20) return true; // IDR_W_RADL / IDR_N_LP
    }
  }
  return false;
}

export class SessionRecorder {
  /**
   * @param {object} opts
   * @param {"h264"|"h265"} opts.codec 串流编码
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {string} [opts.serial] 用于生成文件名
   * @param {number} [opts.maxBytes] 内存上限,达到后自动停止录制
   */
  constructor({ codec, width = 0, height = 0, serial = "device", maxBytes = 1 << 30 }) {
    this.recorder = new Mp4Recorder({ codec, width, height, maxBytes });
    this.serial = serial;
    // 参数集来自会话缓存的 config 包(handleConfig 注入),录制立即开始
    this.armed = true;
    this.frameCount = 0;
    this.startedAt = Date.now();
    // 时间戳归一化:第一帧(可能是几秒前的缓存关键帧)pts 归零,
    // 避免其旧时间戳被计入视频时长(否则录制 10s 会得到 17s 的视频)
    this._ptsBase = null;
    // 等待新关键帧模式(避免开头是录制前的旧画面)
    this.pendingStart = false;
    this.cacheData = null;
  }

  /** 收到 config 包:提取参数集 */
  handleConfig(data) {
    this.recorder.addConfig(data);
  }

  /**
   * 用会话缓存的关键帧作为文件第一帧(保证 MP4 从 IDR 开始,播放器可解码)。
   * 之后 handlePacket 写入的帧都以此帧为参考起点。
   */
  addInitialKeyFrame(data, pts) {
    if (this.frameCount === 0) {
      // 缓存关键帧可能是录制开始前几秒的旧帧,pts 归零作基准
      this.recorder.addFrame(data, { pts: 0, isKey: true });
      this.frameCount = 1;
    }
  }

  /**
   * 等待新的关键帧再开始录制(避免视频开头是录制前几秒的旧缓存画面)。
   * 调用后 handlePacket 会丢弃普通帧,直到收到关键帧才写入。
   * @param {Buffer} cacheData 兜底用缓存帧(超时后使用)
   */
  setPendingStart(cacheData) {
    this.pendingStart = true;
    this.cacheData = cacheData;
  }

  /** 超时兜底:用缓存的关键帧作为第一帧开始录制(无缓存帧时继续等待关键帧) */
  startWithCache() {
    if (!this.pendingStart) return;
    if (!this.cacheData) return;
    this.pendingStart = false;
    this.recorder.addFrame(this.cacheData, { pts: 0, isKey: true });
    this.frameCount = 1;
  }

  /** 用设备新输出的关键帧(当前画面)作为第一帧开始录制 */
  startWithKeyFrame(data, pts) {
    if (!this.pendingStart) return;
    this.pendingStart = false;
    this.recorder.addFrame(data, { pts: 0, isKey: true });
    this.frameCount = 1;
  }

  /** 收到视频帧(第一个关键帧到达前丢弃非关键帧,保证文件从 IDR 开始可解码) */
  handlePacket({ data, pts, isKey }) {
    if (!this.armed) return;
    const key = isKey || containsIdr(data, this.recorder.codec);
    if (this.pendingStart) {
      // 等待新的关键帧作为录制起点
      if (!key) return;
      this.startWithKeyFrame(data, pts);
      return;
    }
    if (this.frameCount === 0 && !key) return;
    // 时间戳归一化:第一个真实帧为基准(从 1 帧时长开始),后续相对递增
    let effPts;
    if (this._ptsBase === null) {
      this._ptsBase = pts;
      effPts = 33_333; // 1 帧时长(微秒,≈30fps)
    } else {
      effPts = (pts - this._ptsBase) + 33_333;
    }
    const ok = this.recorder.addFrame(data, { pts: effPts, isKey: key });
    if (ok) this.frameCount++;
    return ok;
  }

  /** 会话参数切换(restart)后需重新等待 config 包 */
  resetArm() {
    this.armed = false;
  }

  /**
   * 停止录制并生成 MP4 文件。
   * @returns {{filePath:string, filename:string, frames:number, bytes:number, limitHit:boolean}}
   */
  finish() {
    const buffer = this.recorder.finish();
    ensureRecordingsDir();
    const filename = `rec-${String(this.serial).replace(/[^0-9A-Za-z._-]/g, "_")}-${Date.now()}.mp4`;
    const filePath = path.join(RECORDINGS_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return { filePath, filename, frames: this.frameCount, bytes: buffer.length, limitHit: this.recorder.limitHit };
  }
}
