/**
 * js/decoders/webcodecs.js — 浏览器原生解码(WebCodecs VideoDecoder)。
 *
 * 支持 H.264/H.265/AV1。
 *   - H.264: 由配置包(SPS/PPS)构建 avcC description 与 avc1 codec 字符串
 *   - H.265: 由配置包(VPS/SPS/PPS)构建 hvcC description
 *   - AV1: 直接喂 OBU,使用通用 av01 codec 字符串(description 可选)
 */
import { splitAnnexB, parseSpsH264, buildAvcc, parseSpsH265, buildHvcc } from "../../shared/nal.js";
import { PacketFlags } from "../../../shared/video-stream.js";
import { createLatestFrameRenderer } from "../render-throttle.js";

/** 判断数据是否为 Annex-B 格式(start code 开头) */
function isAnnexB(data) {
  return (
    data.length >= 4 &&
    data[0] === 0 &&
    data[1] === 0 &&
    (data[2] === 1 || (data[2] === 0 && data[3] === 1))
  );
}

/**
 * Annex-B(start code)转 AVCC(4 字节长度前缀)。
 * WebCodecs 提供 avcC/hvcC 作为 description 时,EncodedVideoChunk 数据必须是
 * AVCC 格式;直接喂 Annex-B 会让 Chrome 把 start code 误当长度前缀而解码失败
 * (典型报错:"Unable to determine size of bitstream buffer")。
 * 注意:不能用"总长相等"判断是否已转换——4 字节 start code 的单 NAL 帧
 * (4+len == 4+len)会误判,必须按起始码检测。
 */
function annexBToAvcc(data) {
  if (!isAnnexB(data)) return data; // 已是长度前缀格式,无需转换
  const nals = splitAnnexB(data);
  let total = 0;
  for (const n of nals) total += 4 + n.data.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    new DataView(out.buffer).setUint32(o, n.data.length, false);
    out.set(n.data, o + 4);
    o += 4 + n.data.length;
  }
  return out;
}

/**
 * 帧内是否含 IDR NAL。redroid/部分设备的 MediaCodec 不设置
 * BUFFER_FLAG_KEY_FRAME,前端不能依赖该标志判断关键帧,
 * 否则 WebCodecs 会把关键帧标成 delta 而无法开始解码。
 */
function containsIdr(data, codec) {
  for (const nal of splitAnnexB(data)) {
    if (codec === "h264") {
      if (nal.nalType === 5) return true; // IDR
    } else if (codec === "h265") {
      const t = (nal.data[0] >> 1) & 0x3f;
      if (t === 19 || t === 20) return true; // IDR_W_RADL / IDR_N_LP
    }
  }
  return false;
}

/** 粗略检测 AV1 OBU 流中是否包含 Sequence Header(关键帧/参数集)。 */
function containsAv1Keyframe(data) {
  let offset = 0;
  while (offset < data.length) {
    const header = data[offset];
    const obuType = (header >> 3) & 0xf;
    const hasExtension = (header >> 2) & 0x1;
    const hasSize = (header >> 1) & 0x1;
    let pos = offset + 1;
    if (hasExtension) pos++;
    if (hasSize) {
      let size = 0;
      let shift = 0;
      let b = 0;
      do {
        if (pos >= data.length) break;
        b = data[pos++];
        size |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (obuType === 1) return true; // sequence header OBU
      offset = pos + size;
    } else {
      if (obuType === 1) return true;
      break; // 无 size 字段时无法继续安全扫描
    }
  }
  return false;
}

export class WebCodecsDecoder {
  constructor({ canvas, onFrame, onError, onInfo, onFrameDrop }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.onFrame = onFrame;
    this.onError = onError;
    this.onInfo = onInfo;
    this.onFrameDrop = onFrameDrop;
    this.decoder = null;
    this.meta = null;
    this.configArmed = false;
    this.cfgKey = null;
    this.codecString = null;
    this.lastTs = -1;
    this.tsOffset = 0;
    this.destroyed = false;
    this.pendingConfig = null;
    this.videoColorSpace = null;
    this._av1Config = null;
    this._av1NeedKey = false;
    this._av1Retry = 0;
    this._decodeStartByTs = new Map();
    // 渲染节流:只渲染最新帧(丢中间帧),保证网页操作延迟正常
    this._renderer = createLatestFrameRenderer(
      (frame) => {
        try {
          // 使用 visibleRect 作为源并缩放到画布;H.265 的 visibleRect 已在
          // _onOutput 中按 codedRect 修正,因此这里总是绘制完整编码帧。
          const rect = frame.visibleRect || {
            x: 0,
            y: 0,
            width: frame.displayWidth || frame.codedWidth || this.canvas.width,
            height: frame.displayHeight || frame.codedHeight || this.canvas.height,
          };
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, this.canvas.width, this.canvas.height);
        } catch {
          // 尺寸变化瞬间可能失败,忽略
        }
        const ts = frame && frame.timestamp;
        let decodeMs;
        if (ts !== undefined && ts !== null && this._decodeStartByTs.has(ts)) {
          decodeMs = performance.now() - this._decodeStartByTs.get(ts);
          this._decodeStartByTs.delete(ts);
        }
        frame.close();
        this.onFrame({ decodeMs });
      },
      { closeFrame: (f) => { try { f.close(); } catch {} }, onDrop: this.onFrameDrop }
    );
  }

  static async supported(codec) {
    if (typeof VideoDecoder === "undefined") return false;
    const candidates = {
      h264: ["avc1.42E01F", "avc1.64001F"],
      h265: [
        "hvc1.1.6.L120.90",
        "hev1.1.6.L120.90",
        "hvc1.1.6.L150.80",
        "hvc1.1.6.L93.B0",
        "hev1.1.6.L93.B0",
        "hvc1.1.60000000.L150.B0",
      ],
      av1: [
        "av01.0.04M.08",
        "av01.0.09M.08",
        "av01.0.08M.08",
        "av01.0.10M.08",
        "av01.0.04M.10",
        "av01.0.09M.10",
      ],
    }[codec];
    if (!candidates) return false;
    // Edge/Windows 上 HEVC 的 isConfigSupported 在并发探测时可能瞬时返回 false。
    // H.265 先用单个主用 codec 串重试最多 10 次,直到返回 true,避免误判为不支持。
    if (codec === "h265") {
      const primary = "hvc1.1.6.L120.90";
      for (let i = 0; i < 10; i++) {
        try {
          const r = await VideoDecoder.isConfigSupported({ codec: primary });
          if (r && r.supported) return true;
        } catch {
          // 继续重试
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // 其余 codec 或 H.265 重试仍失败时,再逐个尝试候选
    for (const c of candidates) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: c });
        if (r && r.supported) return true;
      } catch {
        // 继续尝试下一个
      }
    }
    return false;
  }

  async init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this._resizeCanvas(meta.width, meta.height);
    // h264/h265 等配置包提供 description(avcC/hvcC)
    this.configArmed = false;
    // 补处理在 init 前到达的 config 包
    if (this.pendingConfig) {
      const data = this.pendingConfig;
      this.pendingConfig = null;
      this._handleConfig(data, meta.codec);
    }
  }

  _handleConfig(data, codec) {
    if (codec === "h264") this._handleConfigH264(data);
    else if (codec === "h265") this._handleConfigH265(data);
    else if (codec === "av1") this._handleConfigAV1(data);
  }

  _resizeCanvas(w, h) {
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _createDecoder(config) {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {}
    }
    const decoder = new VideoDecoder({
      output: (frame) => this._onOutput(frame),
      error: (e) => this._onDecoderError(e),
    });
    this.decoder = decoder;
    try {
      const cfg = { ...config, hardwareAcceleration: "no-preference" };
        if (config.colorSpace) cfg.colorSpace = config.colorSpace;
        decoder.configure(cfg);
    } catch (e) {
      this.decoder = null;
      this.onError(
        "WebCodecs 配置失败:" +
          e.message +
          ",请切换解码方式(如「自定义JS」或「MediaSource」)"
      );
    }
  }

  _onOutput(frame) {
    if (this.destroyed || !this.canvas.isConnected) {
      frame.close();
      return;
    }
      // 部分浏览器不会从 HEVC 码流中继承 BT.709/limited range 元数据,
      // 导致输出 VideoFrame 被当作 BT.601/full range 渲染而泛白。
      // 这里按 H.265 的常见配置补一份颜色空间(无法包装时继续使用原帧)。
      if (this.videoColorSpace && frame && typeof VideoFrame === "function") {
        try {
          const cs = frame.colorSpace;
          if (!cs || cs.matrix !== this.videoColorSpace.matrix || cs.fullRange === true) {
            const wrapped = new VideoFrame(frame, {
              timestamp: frame.timestamp,
              duration: frame.duration,
              colorSpace: this.videoColorSpace,
            });
            frame.close();
            frame = wrapped;
          }
        } catch {
          // 当前浏览器不支持在 VideoFrame 构造时覆盖 colorSpace,保留原帧
        }
      }
    if (
      this.meta &&
      this.meta.codec === "h265" &&
      frame.visibleRect &&
      (frame.visibleRect.width < frame.codedWidth || frame.visibleRect.height < frame.codedHeight)
    ) {
      // Edge/Windows 的 HEVC 解码器有时会把 visibleRect 报告成编码帧的一部分(例如 1280x720,
      // 而 coded 是 2560x1600),导致画面只显示左上角区域。这里尝试用完整 codedRect 重建
      // VideoFrame 的 visibleRect,让浏览器绘制完整编码帧。
      try {
        const coded = frame.codedRect || {
          x: 0,
          y: 0,
          width: frame.codedWidth,
          height: frame.codedHeight,
        };
        const wrapped = new VideoFrame(frame, {
          timestamp: frame.timestamp,
          duration: frame.duration,
          visibleRect: {
            x: coded.x,
            y: coded.y,
            width: coded.width,
            height: coded.height,
          },
          displayWidth: coded.width,
          displayHeight: coded.height,
        });
        frame.close();
        frame = wrapped;
      } catch (e) {
        // 重建失败则按原帧绘制
      }
    }
    this._renderer(frame);
  }

  _onDecoderError(e) {
    // AV1 的某些设备首帧可能无法被浏览器解码,尝试丢弃该帧并等待下一个关键帧重建解码器。
    if (this.meta && this.meta.codec === "av1" && this._av1Retry < 5) {
      this._av1Retry++;
      this._av1NeedKey = true;
      this.configArmed = false;
      try {
        this.decoder.close();
      } catch {}
      this.decoder = null;
      return;
    }
    // 浏览器/系统不支持当前编码的 WebCodecs 解码(如 H.265 无硬件、H.264 无专有 codec)
    this.configArmed = false;
    try {
      this.decoder.close();
    } catch {}
    this.decoder = null;
    this.onError(
      "WebCodecs 无法解码" +
        (this.codecString || "") +
        ":浏览器/系统不支持该编码(或当前配置不被接受),请切换解码方式(如「自定义JS」或「MediaSource」)" +
        (e && e.message ? "(" + e.message + ")" : "")
    );
  }

  _handleConfigH264(data) {
    const nals = splitAnnexB(data);
    const sps = nals.find((n) => n.nalType === 7);
    const pps = nals.find((n) => n.nalType === 8);
    if (!sps || !pps) return;
    let info;
    try {
      info = parseSpsH264(sps.data);
    } catch (e) {
      this.onError("H.264 SPS 解析失败:" + e.message);
      return;
    }
    const avcc = buildAvcc(sps.data, pps.data);
    const key = info.codec + "@" + info.width + "x" + info.height;
    // 每次收到 config 都重建解码器:即使 SPS/PPS 与之前相同,编码器重启后
    // WebCodecs 内部状态也需要重新 configure,否则会报 “Unable to determine size of bitstream buffer”。
    this.cfgKey = key;
    this.codecString = info.codec;
    this._resizeCanvas(info.width, info.height);
    this.videoColorSpace = null; // H.264 按码流自身元数据,不强制覆盖
      this._createDecoder({ codec: info.codec, description: avcc, optimizeForLatency: true, colorSpace: this.videoColorSpace });
    this.configArmed = true;
  }

  _handleConfigH265(data) {
    const nals = splitAnnexB(data);
    const vps = nals.find((n) => ((n.data[0] >> 1) & 0x3f) === 32);
    const sps = nals.find((n) => ((n.data[0] >> 1) & 0x3f) === 33);
    const pps = nals.find((n) => ((n.data[0] >> 1) & 0x3f) === 34);
    if (!vps || !sps || !pps) return;
    let info;
    try {
      info = parseSpsH265(sps.data);
    } catch (e) {
      this.onError("H.265 SPS 解析失败:" + e.message);
      return;
    }
    const hvcc = buildHvcc(vps.data, sps.data, pps.data);
    const key = info.codec + "@" + this.meta.width + "x" + this.meta.height;
    // 每次收到 config 都重建解码器,处理编码器重启后状态重置问题
    this.cfgKey = key;
    this.codecString = info.codec;
    this.videoColorSpace = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
      this._createDecoder({ codec: info.codec, description: hvcc, optimizeForLatency: true, colorSpace: this.videoColorSpace });
    this.configArmed = true;
  }

  _handleConfigAV1(data) {
    // scrcpy 的 AV1 CONFIG 包是 4 字节 AV1CodecConfigurationRecord:
    //   byte0: marker=1 + version=1
    //   byte1: seq_profile(3) + seq_level_idx_0(5)
    //   byte2: seq_tier_0(1) + high_bitdepth(1) + twelve_bit(1) + ...
    // WebCodecs 的 av01 codec 字符串必须与 seq_level_idx 一致(如 09M),
    // 不能写死 04M,否则 Edge/Chrome 会报 “无法解码”。
    let codec = "av01.0.04M.08";
    if (data && data.length >= 4 && data[0] === 0x81) {
      const profile = (data[1] >> 5) & 0x7;
      const levelIdx = data[1] & 0x1f;
      const tier = (data[2] >> 7) & 0x1;
      const highBitdepth = (data[2] >> 6) & 0x1;
      const twelveBit = (data[2] >> 5) & 0x1;
      const bitDepth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
      codec = `av01.${profile}.${String(levelIdx).padStart(2, "0")}${tier ? "H" : "M"}.${String(bitDepth).padStart(2, "0")}`;
    }
    this.codecString = codec;
    this._av1Config = data;
    this._av1NeedKey = false;
    this._resizeCanvas(this.meta?.width || 0, this.meta?.height || 0);
    this._createDecoder({
      codec,
      codedWidth: this.meta?.width || 0,
      codedHeight: this.meta?.height || 0,
      optimizeForLatency: true,
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });
    this.configArmed = true;
  }

  _nextTs(pts) {
    if (Number.isFinite(pts) && pts >= 0) {
      if (pts >= this.lastTs) {
        this.lastTs = pts;
        return pts + this.tsOffset;
      }
      // 时间戳回退(如重启流):整体平移保证单调
      this.tsOffset += this.lastTs - pts;
      this.lastTs = pts;
      return pts + this.tsOffset;
    }
    return ++this.lastTs;
  }

  feedPacket({ flags, data, pts }) {
    if (this.destroyed) return;
    const codec = this.meta && this.meta.codec;

    // config 包必须先处理:h264/h265 的解码器要等参数集(SPS/PPS)才会创建,
    // 不能受 !this.decoder 限制(否则 config 被丢弃,解码器永远无法创建)
    if (flags & PacketFlags.CONFIG) {
      if (codec) {
        this._handleConfig(data, codec);
      } else {
        this.pendingConfig = data; // meta 未就绪(init 前),缓存待 init 补处理
      }
      return;
    }

    // AV1 错误恢复:丢弃导致解码失败的关键帧,等下一个关键帧到达时重建解码器
    if (codec === "av1" && this._av1NeedKey) {
      const isKey =
        (flags & PacketFlags.KEY_FRAME) !== 0 || containsAv1Keyframe(data);
      if (isKey && this._av1Config) {
        this._handleConfigAV1(this._av1Config);
      } else {
        return;
      }
    }

    if (!this.decoder || !this.configArmed) return; // 尚未拿到参数集,丢弃

    const ts = this._nextTs(pts);
    // 关键帧判断:NAL 检测优先(设备可能不设置 KEY_FRAME 标志);
    // 若第一帧被标为 delta,WebCodecs 解码器会直接报错
    const isKey =
      (flags & PacketFlags.KEY_FRAME) !== 0 ||
      containsIdr(data, codec) ||
      (codec === "av1" && containsAv1Keyframe(data));
    // 编码器重启时,scrcpy 可能只发关键帧而不单独发 CONFIG 包;
    // 此时关键帧内会携带 SPS/PPS(或 VPS/SPS/PPS),需要先喂给解码器完成重建。
    if (isKey && (codec === "h264" || codec === "h265")) {
      const nals = splitAnnexB(data);
      const hasParams =
        codec === "h264"
          ? nals.some((n) => n.nalType === 7 || n.nalType === 8)
          : nals.some((n) => {
              const t = (n.data[0] >> 1) & 0x3f;
              return t === 32 || t === 33 || t === 34;
            });
      if (hasParams) {
        this._handleConfig(data, codec);
      }
    }
    const type = isKey ? "key" : "delta";
    // h264/h265 有 avcC/hvcC description,chunk 需为 AVCC 格式;AV1 直接使用 OBU
    const chunkData = codec === "h264" || codec === "h265" ? annexBToAvcc(data) : data;
    try {
      this._decodeStartByTs.set(ts, performance.now());
        if (this._decodeStartByTs.size > 200) {
          const oldest = this._decodeStartByTs.keys().next().value;
          this._decodeStartByTs.delete(oldest);
        }
        this.decoder.decode(new EncodedVideoChunk({ type, timestamp: ts, data: chunkData }));
        // 注意:不要对 AV1 每帧调用 flush(),否则 flush 后下一帧必须是关键帧,
        // 实时流中后续 delta 帧会直接报 “A key frame is required after configure() or flush()”。
    } catch (e) {
      this.onError("WebCodecs 解码调用失败:" + e.message);
    }
  }

  destroy() {
    this.destroyed = true;
      if (this._decodeStartByTs) this._decodeStartByTs.clear();
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {}
      this.decoder = null;
    }
  }
}
