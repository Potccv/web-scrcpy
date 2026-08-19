/**
 * shared/video-stream.js — scrcpy 视频 socket 帧格式的增量解析器。
 *
 * 字节布局(与 scrcpy 4.x Streamer.java / demuxer.c 核对):
 *   1) 4 字节 codec id(ASCII:"h264"/"h265"/"\0av1";0=流被禁用;1=配置错误)
 *   2) 视频流随后是 12 字节 session 头:[0x80.. flags 4B][width 4B BE][height 4B BE]
 *      (flags 最高位为 session 标记,bit0 表示 client_resized)
 *   3) 之后重复:12 字节帧头:[pts+flags 8B BE][payload size 4B BE] + payload
 *      flags: bit62=config(SPS/PPS), bit61=keyframe;PTS = 值 & (2^61 - 1)
 *
 * 该解析器由 Node 桥使用;浏览器端接收桥转发后的结构化数据。
 */
import { read32be, read64beBig } from "./protocol.js";

export const CODEC_ID = {
  H264: 0x68323634, // "h264"
  H265: 0x68323635, // "h265"
  AV1: 0x00617631, // "\0av1" (scrcpy 4.x 对 AV1 使用前导 0 的 4 字节 ID)
};

export function codecIdToString(id) {
  for (const [name, value] of Object.entries(CODEC_ID)) {
    if (value === id) return name.toLowerCase();
  }
  return null;
}

export const PACKET_FLAG_CONFIG = 1n << 62n;
export const PACKET_FLAG_KEY_FRAME = 1n << 61n;
export const PACKET_PTS_MASK = (1n << 61n) - 1n;

const SESSION_FLAG_MASK = 0x80000000;

/** 视频数据包标志位(桥 → 浏览器 WS 二进制消息的第二个字节) */
export const PacketFlags = {
  CONFIG: 0x01,
  KEY_FRAME: 0x02,
};

/** WS 二进制消息的流类型(第一个字节) */
export const StreamType = {
  VIDEO: 0,
};

/**
 * 增量解析视频 socket 数据。用法:
 *   const p = new VideoStreamParser({ hasSessionHeader: true, onCodecId, onSession, onPacket, onError });
 *   p.push(chunk); // 可多次调用
 * hasSessionHeader=false 时用于无 12 字节 session 头的数据(如音频,已不使用)。
 */
export class VideoStreamParser {
  constructor({ hasSessionHeader = true, onCodecId, onSession, onPacket, onError }) {
    this.hasSessionHeader = hasSessionHeader;
    this.onCodecId = onCodecId;
    this.onSession = onSession;
    this.onPacket = onPacket;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
    this.phase = "codec-id"; // codec-id -> (session) -> packet
    this.codecId = null;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this.phase === "codec-id") {
        if (this.buffer.length < 4) return;
        this.codecId = read32be(this.buffer, 0);
        this.buffer = this.buffer.subarray(4);
        if (this.codecId === 0) {
          // 设备显式禁用该流(如无法采集):仅作提示
          this.onCodecId && this.onCodecId(null);
          this.phase = "disabled";
          return;
        }
        if (this.codecId === 1) {
          this.onError && this.onError(new Error("设备端视频流配置错误"));
          this.phase = "disabled";
          return;
        }
        this.onCodecId && this.onCodecId(codecIdToString(this.codecId));
        this.phase = this.hasSessionHeader ? "session" : "packet";
      } else if (this.phase === "session") {
        if (this.buffer.length < 12) return;
        const flags = read32be(this.buffer, 0);
        if (!(flags & SESSION_FLAG_MASK)) {
          this.onError && this.onError(new Error("协议错误:期望 session 头"));
          this.phase = "disabled";
          return;
        }
        const width = read32be(this.buffer, 4);
        const height = read32be(this.buffer, 8);
        const clientResized = !!(flags & 1);
        this.buffer = this.buffer.subarray(12);
        this.onSession && this.onSession({ width, height, clientResized });
        this.phase = "packet";
      } else if (this.phase === "packet") {
        // session 头可能正好落在一个新的 TCP chunk 开头;进入 packet 解析前也要检测,
        // 否则会把 session 头误当普通包头发送给前端。
        if (this.buffer.length >= 4) {
          const startFlags = read32be(this.buffer, 0);
          const isSessionStart =
            (startFlags & 0x80000000) !== 0 && (startFlags & ~0x80000001) === 0;
          if (isSessionStart) {
            this.phase = "session";
            continue;
          }
        }
        if (this.buffer.length < 12) return;
        const ptsFlags = read64beBig(this.buffer, 0);
        const size = read32be(this.buffer, 8);
        if (size === 0) {
          this.onError && this.onError(new Error("协议错误:数据包长度为 0"));
          this.phase = "disabled";
          return;
        }
        if (this.buffer.length < 12 + size) return;
        const payload = this.buffer.subarray(12, 12 + size);
        this.buffer = this.buffer.subarray(12 + size);
        const config = (ptsFlags & PACKET_FLAG_CONFIG) !== 0n;
        const keyFrame = (ptsFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
        const pts = Number(ptsFlags & PACKET_PTS_MASK);
        let flags = 0;
        if (config) flags |= PacketFlags.CONFIG;
        if (keyFrame) flags |= PacketFlags.KEY_FRAME;
        this.onPacket && this.onPacket({ flags, pts, data: payload });
        // session 头也可能在包序列中间出现(如分辨率变化),回到 session 阶段检测。
        // 注意:不能只判断首字节最高位,否则 H.264/H.265 负载中任意 >=0x80 的字节
        // 都会误判为 session 头(旋转后会出现巨大错误宽高)。
        if (this.buffer.length >= 4) {
          const flags = read32be(this.buffer, 0);
          const isSessionFlags = (flags & 0x80000000) !== 0 && (flags & ~0x80000001) === 0;
          if (isSessionFlags) {
            this.phase = "session";
          }
        }
      } else {
        return; // disabled
      }
    }
  }
}
