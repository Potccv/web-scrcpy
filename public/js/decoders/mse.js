/**
 * js/decoders/mse.js — 浏览器原生解码回退方案:MediaSource + jmuxer(fMP4 muxing)。
 *
 * 适用于 WebCodecs 不可用或所选编码浏览器 WebCodecs 不支持的情况
 * (例如 Firefox 的 H.264、Safari 的 H.265 等)。jmuxer 负责把 Annex-B 码流
 * 转换为 fMP4 并送入 MediaSource。
 */
export class MseDecoder {
  constructor({ videoEl, onFrame, onError, onInfo, onFrameDrop }) {
    this.videoEl = videoEl;
    this.onFrame = onFrame;
    this.onError = onError;
    this.onInfo = onInfo;
      this.onFrameDrop = onFrameDrop;
    this.jmuxer = null;
    this.meta = null;
    this.destroyed = false;
    this._rafHandle = null;
    this._lastFrameTime = 0;
      this._lastFeedAt = null;
  }

  static supported(codec) {
    // 注意:jmuxer 库挂载的是 window.JMuxer(大写 M)
    if (typeof MediaSource === "undefined" || !window.JMuxer) return false;
    // H.264 所有主流浏览器都支持;H.265 仅 Safari/Edge(Chromium 部分平台);
    // 其余编码交给 MSE 是否支持
    if (codec === "h264" || codec === "h265") return true;
    return false;
  }

  async init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this._pending = []; // MediaSource open 前缓存的数据
    this._ready = false;
    try {
      // jmuxer 2.x API:new JMuxer({ node: videoElement, ... }) —— node 必填
      this.jmuxer = new window.JMuxer({
        node: this.videoEl,
        mode: "video",
        videoCodec: meta.codec === "h265" ? "H265" : "H264",
        // flushingTime 为 0 会每帧立即 flush+appendBuffer,主线程频繁阻塞
        // 导致画面卡顿;150ms 批量刷新,兼顾低延迟与流畅
        flushingTime: 150,
        // 缓冲上限 200ms,防止延迟积累
        maxDelay: 200,
        fps: 30,
        debug: false,
        onReady: () => {
          // MediaSource 已打开、轨道就绪,补喂缓存的数据
          this._ready = true;
          for (const data of this._pending) this._feed(data);
          this._pending = [];
        },
      });
    } catch (e) {
      this.onError("MSE/jmuxer 初始化失败:" + e.message + ",请改用「自定义JS」解码");
      return;
    }
    // video 解码错误(码流不被支持时触发)
    this._onVideoError = (e) => {
      const msg = this.videoEl.error && this.videoEl.error.message;
      this.onError(
        "MSE 解码错误:浏览器无法解码当前码流" + (msg ? "(" + msg + ")" : "") + ",请改用「自定义JS」解码"
      );
    };
    this.videoEl.addEventListener("error", this._onVideoError);
    this.videoEl.play().catch(() => {});
    this._setupFrameCounter();
  }

  _setupFrameCounter() {
    if ("requestVideoFrameCallback" in this.videoEl) {
      const tick = () => {
        if (this.destroyed) return;
        this._rafHandle = this.videoEl.requestVideoFrameCallback(tick);
        const decodeMs = this._lastFeedAt !== null ? performance.now() - this._lastFeedAt : undefined;
        this.onFrame({ decodeMs });
      };
      this._rafHandle = this.videoEl.requestVideoFrameCallback(tick);
    } else {
      // 回退:以 rAF 近似
      const raf = () => {
        if (this.destroyed) return;
        requestAnimationFrame(raf);
        const now = performance.now();
        if (this.videoEl.readyState >= 2 && now - this._lastFrameTime > 30) {
          this._lastFrameTime = now;
          const decodeMs = this._lastFeedAt !== null ? performance.now() - this._lastFeedAt : undefined;
          this.onFrame({ decodeMs });
        }
      };
      requestAnimationFrame(raf);
    }
  }

  feedPacket({ flags, data, pts }) {
    if (this.destroyed || !this.jmuxer) return;
    // 用包到达间隔估算实际帧时长:redroid 帧率是动态的(静止 ~2fps,操作时更高),
    // jmuxer 固定 fps 会导致时间轴失真、缓冲无限积累(画面延迟持续增大)。
    // 到达间隔(局域网传输快)近似帧间隔。
    const now = performance.now();
    if (this._lastArrive != null) {
      const gap = now - this._lastArrive;
      if (gap >= 1 && gap <= 2000) {
        this._lastFrameMs = gap; // 最近一次帧间隔(ms)
      }
    }
    this._lastArrive = now;
      this._lastFeedAt = now;
    if (!this._ready) {
      // MediaSource 尚未就绪:缓存数据,onReady 后补喂(避免丢关键帧)
      this._pending.push(data);
      return;
    }
    this._feed(data);
  }

  _feed(data) {
    try {
      // jmuxer 2.x API:feed({ video: Uint8Array, duration }),duration 为该段帧总时长(ms)
      this.jmuxer.feed({ video: data, duration: Math.round(this._lastFrameMs || 0) });
    } catch (e) {
      this.onError("MSE/jmuxer 写入失败:" + e.message);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this._onVideoError) {
      this.videoEl.removeEventListener("error", this._onVideoError);
      this._onVideoError = null;
    }
    if (this._rafHandle && "cancelVideoFrameCallback" in this.videoEl) {
      try {
        this.videoEl.cancelVideoFrameCallback(this._rafHandle);
      } catch {}
    }
    if (this.jmuxer) {
      try {
        this.jmuxer.destroy();
      } catch {}
      this.jmuxer = null;
    }
    try {
      this.videoEl.removeAttribute("src");
      this.videoEl.load();
    } catch {}
  }
}
