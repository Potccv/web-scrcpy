/**
 * shared/mp4-muxer.mjs — 把 H.264/H.265 Annex-B 视频流封装为 MP4 文件。
 *
 * 用于服务端录制串流:scrcpy 视频 payload 是 Annex-B 码流(H.264/H.265,
 * 与串流编码格式一致),这里将其封装成标准 MP4(avc1/hvc1 sample entry),
 * 供浏览器下载与播放。纯 Node 实现,无外部依赖。
 *
 * 时间戳:帧的 pts 来自 scrcpy 帧头(微秒),timescale 取 1_000_000。
 */
import { splitAnnexB, hevcNalType, buildAvcc, buildHvcc, parseSpsH264, BitReader } from "./nal.js";

const H264_SPS = 7;
const H264_PPS = 8;
const H265_VPS = 32;
const H265_SPS = 33;
const H265_PPS = 34;

const TIMESCALE = 1_000_000; // 微秒

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff, 0);
  return b;
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
}

function identityMatrix() {
  const m = Buffer.alloc(36);
  m.writeUInt32BE(0x00010000, 0);
  m.writeUInt32BE(0, 4);
  m.writeUInt32BE(0, 8);
  m.writeUInt32BE(0, 12);
  m.writeUInt32BE(0x00010000, 16);
  m.writeUInt32BE(0, 20);
  m.writeUInt32BE(0, 24);
  m.writeUInt32BE(0, 28);
  m.writeUInt32BE(0x40000000, 32);
  return m;
}

/** Annex-B 码流(带 start code)转 length-prefixed 格式(4 字节长度 + NAL) */
function toLengthPrefixed(data) {
  const nals = splitAnnexB(data);
  const parts = [];
  for (const nal of nals) {
    const len = nal.data.length;
    const b = Buffer.allocUnsafe(4 + len);
    b.writeUInt32BE(len, 0);
    Buffer.from(nal.data.buffer, nal.data.byteOffset, len).copy(b, 4);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** 去除 RBSP 的 emulation prevention bytes(0x000003 → 0x0000) */
function removeEmulationPrevention(data) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

/** 解析 HEVC SPS 的宽高(含 conformance window),失败返回 null */
export function parseHevcDimensions(sps) {
  try {
    if (((sps[0] >> 1) & 0x3f) !== H265_SPS) return null;
    // 跳过 2 字节 NAL 头后为 RBSP,需去除 emulation prevention bytes
    const rbsp = removeEmulationPrevention(sps.subarray(2));
    const r = new BitReader(rbsp, 0);
    r.readBits(4); // sps_video_parameter_set_id
    const maxSubLayers = r.readBits(3);
    r.readBits(1); // sps_temporal_id_nesting_flag
    // profile_tier_level(general 部分)
    r.readBits(2); // profile_space
    r.readBits(1); // tier_flag
    r.readBits(5); // profile_idc
    r.readBits(32); // compatibility flags
    r.readBits(48); // constraint flags
    r.readBits(8); // level_idc
    if (maxSubLayers > 0) {
      r.readBits(2); // reserved
      for (let i = maxSubLayers; i < 8; i++) r.readBits(1);
      for (let i = 0; i < maxSubLayers; i++) {
        r.readBits(2); // reserved
        const profilePresent = r.readBits(1);
        const levelPresent = r.readBits(1);
        if (profilePresent) r.readBits(88);
        if (levelPresent) r.readBits(8);
      }
    }
    r.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.readBits(1); // separate_colour_plane_flag
    const picWidth = r.ue();
    const picHeight = r.ue();
    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    if (r.readBits(1)) {
      // conformance_window_flag
      left = r.ue();
      right = r.ue();
      top = r.ue();
      bottom = r.ue();
    }
    return {
      width: picWidth - (left + right) * subWidthC,
      height: picHeight - (top + bottom) * subHeightC,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MP4 box 构建
// ---------------------------------------------------------------------------

function buildFtyp(codec) {
  const brand = codec === "h264" ? "isomiso2avc1mp41" : "isomiso2hvc1mp41";
  return box("ftyp", Buffer.from("isom", "latin1"), u32(0), Buffer.from(brand, "latin1"));
}

function buildMvhd(duration) {
  return box(
    "mvhd",
    u32(0), // version + flags
    u32(0), // creation_time
    u32(0), // modification_time
    u32(TIMESCALE),
    u32(duration),
    u32(0x00010000), // rate
    u16(0x0100), // volume
    Buffer.alloc(10), // reserved
    identityMatrix(),
    Buffer.alloc(24), // pre_defined
    u32(2) // next_track_ID
  );
}

function buildTkhd(duration, width, height) {
  return box(
    "tkhd",
    u32(0x00000003), // version 0 + flags (enabled|in_movie)
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1), // track_ID
    u32(0), // reserved
    u32(duration),
    Buffer.alloc(8), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume
    u16(0), // reserved
    identityMatrix(),
    u32(Math.round(width * 0x10000)),
    u32(Math.round(height * 0x10000))
  );
}

function buildMdhd(duration) {
  return box(
    "mdhd",
    u32(0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(TIMESCALE),
    u32(duration),
    u16(0x55c4), // language: und
    u16(0) // pre_defined
  );
}

function buildHdlr() {
  return box(
    "hdlr",
    u32(0),
    u32(0), // pre_defined
    Buffer.from("vide", "latin1"),
    Buffer.alloc(12), // reserved
    Buffer.from("VideoHandler\0", "latin1")
  );
}

function buildVmhd() {
  return box("vmhd", u32(1), u16(0), Buffer.alloc(6));
}

function buildDinf() {
  const dref = box(
    "dref",
    u32(0),
    u32(1),
    box("url ", u32(1)) // flags=1:self-contained
  );
  return box("dinf", dref);
}

function buildSampleEntry(codec, width, height, configBox) {
  const name = Buffer.alloc(32);
  const n = Buffer.from("WebScrcpy", "latin1");
  name[0] = n.length;
  n.copy(name, 1);
  const body = Buffer.concat([
    Buffer.alloc(6), // reserved
    u16(1), // data_reference_index
    u16(0), u16(0), Buffer.alloc(12), // pre_defined / reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), // horiz/vert resolution
    u32(0), // reserved
    u16(1), // frame_count
    name,
    u16(0x0018), // depth
    u16(0xffff), // pre_defined(-1)
    configBox,
  ]);
  return box(codec === "h264" ? "avc1" : "hvc1", body);
}

function buildStsd(codec, width, height, configBox) {
  return box("stsd", u32(0), u32(1), buildSampleEntry(codec, width, height, configBox));
}

function buildStts(entries) {
  return box(
    "stts",
    u32(0),
    u32(entries.length),
    ...entries.map((e) => Buffer.concat([u32(e.count), u32(e.delta)]))
  );
}

function buildStss(samples) {
  return box("stss", u32(0), u32(samples.length), ...samples.map(u32));
}

function buildStsc(sampleCount) {
  return box("stsc", u32(0), u32(1), u32(1), u32(sampleCount), u32(1));
}

function buildStsz(sizes) {
  return box("stsz", u32(0), u32(0), u32(sizes.length), ...sizes.map(u32));
}

function buildStco(offset) {
  return box("stco", u32(0), u32(1), u32(offset));
}

// ---------------------------------------------------------------------------
// Mp4Recorder
// ---------------------------------------------------------------------------

/**
 * 录制器:逐帧接收 Annex-B 视频数据,finish() 时输出完整 MP4 Buffer。
 *
 * @example
 *   const rec = new Mp4Recorder({ codec: "h264" });
 *   rec.addConfig(spsPpsPacket);          // config 包(参数集)
 *   rec.addFrame(idrPacket, { pts, isKey: true });
 *   rec.addFrame(pFramePacket, { pts });
 *   const mp4 = rec.finish();
 */
export class Mp4Recorder {
  /**
   * @param {object} opts
   * @param {"h264"|"h265"} opts.codec 串流编码格式(输出 MP4 的编码与此一致)
   * @param {number} [opts.width] 宽(缺省时从 SPS 解析)
   * @param {number} [opts.height] 高
   * @param {number} [opts.maxBytes] 内存上限,超过后 addFrame 返回 false(自动停止录制)
   */
  constructor({ codec, width = 0, height = 0, maxBytes = 1 << 30 }) {
    if (codec !== "h264" && codec !== "h265") {
      throw new Error("不支持的录制编码:" + codec);
    }
    this.codec = codec;
    this.width = width;
    this.height = height;
    this.maxBytes = maxBytes;
    this.vps = null;
    this.sps = null;
    this.pps = null;
    this._frames = []; // {pts, isKey, size, data(length-prefixed)}
    this._bytes = 0;
    this._limitHit = false;
  }

  get frameCount() {
    return this._frames.length;
  }

  get bytes() {
    return this._bytes;
  }

  /** 达到内存上限(自动停止) */
  get limitHit() {
    return this._limitHit;
  }

  /** 记录 config 包(含 VPS/SPS/PPS 参数集),本身不构成帧 */
  addConfig(data) {
    this._extractParams(data);
  }

  /**
   * 记录一帧(Annex-B 格式,可含多个 NAL)。
   * @param {Buffer|Uint8Array} data 帧的 Annex-B 数据
   * @param {object} [meta]
   * @param {number} [meta.pts] 帧时间戳(微秒)
   * @param {boolean} [meta.isKey] 是否关键帧
   * @returns {boolean} false 表示已达内存上限,该帧未写入
   */
  addFrame(data, { pts = 0, isKey = false } = {}) {
    if (this._limitHit) return false;
    this._extractParams(data);
    const lp = toLengthPrefixed(data);
    if (this._bytes + lp.length > this.maxBytes) {
      this._limitHit = true;
      return false;
    }
    this._frames.push({ pts, isKey, size: lp.length, data: lp });
    this._bytes += lp.length;
    return true;
  }

  _extractParams(data) {
    for (const nal of splitAnnexB(data)) {
      if (this.codec === "h264") {
        if (nal.nalType === H264_SPS) this.sps = Buffer.from(nal.data);
        else if (nal.nalType === H264_PPS) this.pps = Buffer.from(nal.data);
      } else {
        const t = hevcNalType(nal.data);
        if (t === H265_VPS) this.vps = Buffer.from(nal.data);
        else if (t === H265_SPS) this.sps = Buffer.from(nal.data);
        else if (t === H265_PPS) this.pps = Buffer.from(nal.data);
      }
    }
  }

  /** 封装为 MP4 Buffer */
  finish() {
    const frames = this._frames;
    if (!frames.length) throw new Error("没有可封装的帧");
    const hasParams =
      this.codec === "h264"
        ? this.sps && this.pps
        : this.vps && this.sps && this.pps;
    if (!hasParams) {
      throw new Error("缺少视频参数集(SPS/PPS),无法封装 MP4");
    }

    // 分辨率:优先构造参数,其次从 SPS 解析
    let width = this.width;
    let height = this.height;
    if (!width || !height) {
      try {
        if (this.codec === "h264") {
          const info = parseSpsH264(this.sps);
          width = width || info.width;
          height = height || info.height;
        } else {
          const d = parseHevcDimensions(this.sps);
          if (d) {
            width = width || d.width;
            height = height || d.height;
          }
        }
      } catch {
        // 解析失败时保留 0,下方报错
      }
    }
    if (!width || !height) throw new Error("未知视频分辨率,无法封装 MP4");

    // 时长(微秒)
    let firstPts = frames[0].pts;
    let lastPts = frames[0].pts;
    for (const f of frames) {
      if (f.pts < firstPts) firstPts = f.pts;
      if (f.pts > lastPts) lastPts = f.pts;
    }
    let duration = lastPts - firstPts;
    if (duration <= 0) duration = Math.round((frames.length * TIMESCALE) / 30); // 兜底 30fps
    if (duration > 0xffffffff) throw new Error("录制时长超出 MP4 支持范围(约 71 分钟)");

    // stts:合并相邻相同 delta
    const sttsEntries = [];
    for (let i = 1; i < frames.length; i++) {
      const delta = Math.max(1, frames[i].pts - frames[i - 1].pts);
      const last = sttsEntries[sttsEntries.length - 1];
      if (last && last.delta === delta) last.count++;
      else sttsEntries.push({ count: 1, delta });
    }
    if (!sttsEntries.length) sttsEntries.push({ count: 1, delta: duration || TIMESCALE });

    const keySamples = [];
    frames.forEach((f, i) => {
      if (f.isKey) keySamples.push(i + 1); // 1-based
    });

    // 帧数据全部装入 mdat
    const mdatPayload = Buffer.concat(frames.map((f) => f.data));
    const ftyp = buildFtyp(this.codec);
    const mdatBox = box("mdat", mdatPayload);
    const mdatOffset = ftyp.length + 8; // mdat payload 相对文件头

    const configBox = box(
      this.codec === "h264" ? "avcC" : "hvcC",
      this.codec === "h264"
        ? Buffer.from(buildAvcc(this.sps, this.pps))
        : Buffer.from(buildHvcc(this.vps, this.sps, this.pps))
    );

    const stbl = box(
      "stbl",
      buildStsd(this.codec, width, height, configBox),
      buildStts(sttsEntries),
      keySamples.length ? buildStss(keySamples) : Buffer.alloc(0),
      buildStsc(frames.length),
      buildStsz(frames.map((f) => f.size)),
      buildStco(mdatOffset)
    );
    const minf = box("minf", buildVmhd(), buildDinf(), stbl);
    const mdia = box("mdia", buildMdhd(duration), buildHdlr(), minf);
    const trak = box("trak", buildTkhd(duration, width, height), mdia);
    const moov = box("moov", buildMvhd(duration), trak);

    return Buffer.concat([ftyp, mdatBox, moov]);
  }
}
