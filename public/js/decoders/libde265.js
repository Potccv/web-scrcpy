/**
 * js/decoders/libde265.js — 自定义 JS/WASM 解码器:H.265(HEVC)。
 *
 * 基于 @yume-chan/libde265(https://github.com/yume-chan/libde265,MIT,
 * libde265 的 WebAssembly 构建),不依赖浏览器原生 HEVC 解码。
 * 解码与 YUV→RGB 转换均在 Web Worker 中进行(js/decoders/libde265.worker.js),
 * 主线程只负责最新帧渲染(渲染节流:丢中间帧,保证网页操作延迟正常)。
 */
import { splitAnnexB, hevcNalType } from "../../shared/nal.js";
import { PacketFlags } from "../../../shared/video-stream.js";
import { createLatestFrameRenderer } from "../render-throttle.js";

// HEVC IRAP(关键帧)NAL type:16~23;参数集 VPS/SPS/PPS(32/33/34)也作为重同步点
function isKeyNal(type) {
  return (type >= 16 && type <= 23) || type === 32 || type === 33 || type === 34;
}

export class Libde265Decoder {
  constructor({ canvas, onFrame, onError, onInfo, onFrameDrop }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.onFrame = onFrame;
    this.onError = onError;
    this.onInfo = onInfo;
      this.onFrameDrop = onFrameDrop;
    this.worker = null;
    this.meta = null;
      this._decodeId = 0;
      this._pendingDecodeAt = new Map();
    this.destroyed = false;
    // 渲染节流:只渲染最新帧
    this._renderer = createLatestFrameRenderer(({ rgba, w, h, decodeMs }) => {
      this._resizeCanvas(w, h);
      try {
        this.ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
      } catch {
        // 画布尺寸瞬间不匹配,忽略本帧
      }
      this.onFrame({ decodeMs });
    }, { onDrop: this.onFrameDrop });
  }

  static supported(codec) {
    return codec === "h265" && typeof Worker !== "undefined";
  }

  init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this._resizeCanvas(meta.width, meta.height);
    return new Promise((resolve, reject) => {
      try {
        this.worker = new Worker("/js/decoders/libde265.worker.js", { type: "module" });
      } catch (e) {
        this.onError && this.onError("创建解码工作线程失败:" + e.message);
        reject(e);
        return;
      }
      this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
      this.worker.onerror = (e) => {
        this.onError && this.onError("解码工作线程错误:" + (e.message || "unknown"));
      };
      this.worker.postMessage({ type: "init" });
      const onReady = (e) => {
        if (e.data && e.data.type === "ready") {
          this.worker.removeEventListener("message", onReady);
          resolve();
        } else if (e.data && e.data.type === "error") {
          this.worker.removeEventListener("message", onReady);
          this.onError && this.onError(e.data.message);
          reject(new Error(e.data.message));
        }
      };
      this.worker.addEventListener("message", onReady);
    });
  }

  _resizeCanvas(w, h) {
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  feedPacket({ flags, data }) {
    if (this.destroyed || !this.worker) return;
    const nals = splitAnnexB(data);
    // 把本包所有要发送的 NAL 合并为 [len4][data...] 一次投递,减少消息数
    const parts = [];
    let total = 0;
    let hasKey = (flags & PacketFlags.KEY_FRAME) !== 0;
    for (const nal of nals) {
      const type = hevcNalType(nal.data);
      if (type === 35 || type === 39 || type === 40) continue; // AUD / SEI
      if (isKeyNal(type)) hasKey = true;
      parts.push(nal.data);
      total += nal.data.length + 4;
    }
    if (!parts.length) return;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      merged[off++] = (part.length >>> 24) & 0xff;
      merged[off++] = (part.length >>> 16) & 0xff;
      merged[off++] = (part.length >>> 8) & 0xff;
      merged[off++] = part.length & 0xff;
      merged.set(part, off);
      off += part.length;
    }
    const buf = merged.buffer;
    const decodeId = ++this._decodeId;
      this._pendingDecodeAt.set(decodeId, performance.now());
      if (this._pendingDecodeAt.size > 120) {
        const oldest = this._pendingDecodeAt.keys().next().value;
        this._pendingDecodeAt.delete(oldest);
      }
      this.worker.postMessage({ type: "nals", data: buf, count: parts.length, keyframe: hasKey, id: decodeId }, [buf]);
  }

  _onWorkerMessage(msg) {
    if (this.destroyed) return;
    switch (msg.type) {
      case "frame":
        let decodeMs;
          if (msg.decodeId && this._pendingDecodeAt.has(msg.decodeId)) {
            decodeMs = performance.now() - this._pendingDecodeAt.get(msg.decodeId);
            this._pendingDecodeAt.delete(msg.decodeId);
          }
          this._renderer({ rgba: new Uint8ClampedArray(msg.rgba), w: msg.width, h: msg.height, decodeMs });
        break;
      case "error":
        this.onError && this.onError(msg.message);
        break;
      default:
        break;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this._pendingDecodeAt) this._pendingDecodeAt.clear();
    if (this.worker) {
      try {
        this.worker.postMessage({ type: "destroy" });
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
  }
}
