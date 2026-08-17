/**
 * js/decoders/broadway.js — 自定义 JS 解码器(Broadway,纯 JS/WASM 的 H.264 解码)。
 *
 * Broadway(https://github.com/mbebenita/Broadway,MIT)是完整的 H.264 解码器,
 * 不依赖浏览器原生解码能力。仅支持 H.264(编码端需使用 Baseline profile,
 * 由 app 侧通过 codecOptions=profile=1 强制)。
 *
 * 注意:解码在主线程进行,高分辨率(>720p)时可能无法实时;这是纯 JS 解码的固有限制。
 */
import { splitAnnexB } from "../../shared/nal.js";
import { createLatestFrameRenderer } from "../render-throttle.js";

export class BroadwayDecoder {
  constructor({ canvas, onFrame, onError, onInfo, onFrameDrop }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.onFrame = onFrame;
    this.onError = onError;
    this.onInfo = onInfo;
      this.onFrameDrop = onFrameDrop;
    this.decoder = null;
    this.ready = false;
    this.pending = [];
    this.meta = null;
    this.destroyed = false;
      this._decodeStart = null;
    // 渲染节流:只渲染最新帧,保证网页操作延迟正常
    this._renderer = createLatestFrameRenderer(({ buf, w, h, decodeMs }) => {
      this._resizeCanvas(w, h);
      try {
        const img = new ImageData(new Uint8ClampedArray(buf, 0, w * h * 4), w, h);
        this.ctx.putImageData(img, 0, 0);
      } catch {
        // 画布尺寸瞬间不匹配,忽略本帧
      }
      this.onFrame({ decodeMs });
    }, { onDrop: this.onFrameDrop });
  }

  static supported(codec) {
    return codec === "h264" && typeof window !== "undefined" && !!window.Decoder;
  }

  init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this.ready = false;
    this.pending = [];
    if (!window.Decoder) {
      this.onError("Broadway 解码器未加载,请检查 /vendor/broadway/Decoder.js");
      return;
    }
    this._resizeCanvas(meta.width, meta.height);
    try {
      this.decoder = new window.Decoder({ rgb: true });
    } catch (e) {
      this.onError("Broadway 初始化失败:" + e.message);
      return;
    }
    this.decoder.onDecoderReady = () => {
      this.ready = true;
      this._flush();
    };
    this.decoder.onPictureDecoded = (buf, w, h) => {
      if (this.destroyed || !w || !h) return;
      // Broadway rgb 模式输出 RGBA 拷贝,节流渲染最新帧
      let decodeMs;
        if (this._decodeStart !== null) {
          decodeMs = performance.now() - this._decodeStart;
          this._decodeStart = null;
        }
        this._renderer({ buf, w, h, decodeMs });
    };
  }

  _resizeCanvas(w, h) {
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _feed(nalData) {
    if (!this.ready) {
      this.pending.push(nalData);
      if (this.pending.length > 4000) this.pending.shift(); // 防止内存膨胀
      return;
    }
    try {
      this.decoder.decode(nalData);
    } catch (e) {
      this.onError("Broadway 解码调用失败:" + e.message);
    }
  }

  _flush() {
    for (const n of this.pending) {
      try {
        this.decoder.decode(n);
      } catch (e) {
        this.onError("Broadway 解码调用失败:" + e.message);
      }
    }
    this.pending = [];
  }

  feedPacket({ flags, data }) {
    if (this.destroyed || !this.decoder) return;
    this._decodeStart = performance.now();
      const nals = splitAnnexB(data);
    for (const nal of nals) {
      const type = nal.nalType;
      if (type === 9) continue; // AUD
      if (type === 7 || type === 8) {
        // SPS / PPS 必须按序先喂
        this._feed(nal.data);
        continue;
      }
      this._feed(nal.data);
    }
  }

  destroy() {
    this.destroyed = true;
    this.pending = [];
    if (this.decoder) {
      try {
        this.decoder.destroy && this.decoder.destroy();
      } catch {}
      this.decoder = null;
    }
  }
}
