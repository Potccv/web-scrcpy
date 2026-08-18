/**
 * js/decoders/h265web.js — h265web.js 解码后端。
 *
 * h265web.js(numberwolf/h265web.js)是同时支持 H.264/H.265/AV1 的浏览器播放器:
 *   - 硬解优先(WebCodecs/MSE)
 *   - 软解回退(WASM/FFmpeg)
 *   - 本后端通过服务端新增的 /ws-raw 裸流 WebSocket 获取原始视频 payload,
 *     交给 h265web.js 的 raw265 播放内核进行解封装/解码/渲染。
 *
 * 注意:
 *   - AV1 支持依赖 Chrome 等浏览器和 h265web.js 的 AV1 能力,设备端还需支持 AV1 编码。
 *   - 渲染采用隐藏容器内 h265web.js 的 canvas,再复制到主画布,保持与其它解码器一致的 UI。
 */
let uid = 0;

export class H265webDecoder {
  constructor({ canvas, mediaToken, onFrame, onError, onInfo, onFrameDrop }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.mediaToken = mediaToken || "";
    this.onFrame = onFrame;
    this.onError = onError;
    this.onInfo = onInfo;
    this.onFrameDrop = onFrameDrop;
    this.player = null;
    this.container = null;
    this.meta = null;
    this.destroyed = false;
    this._ready = false;
    this._raf = null;
    this._lastFrameAt = 0;
  }

  static supported(codec) {
    return (
      typeof window !== "undefined" &&
      !!window.H265webjsPlayer &&
      ["h264", "h265", "av1"].includes(codec)
    );
  }

  init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this._resizeCanvas(meta.width, meta.height);

    return new Promise((resolve, reject) => {
      if (!window.H265webjsPlayer) {
        const err = new Error("h265web.js 未加载,请检查 /vendor/h265web/h265web.js");
        this.onError && this.onError(err.message);
        reject(err);
        return;
      }
      if (!this.mediaToken) {
        const err = new Error("h265web.js 需要服务端 mediaToken,请等待 WebSocket ready 后再开始");
        this.onError && this.onError(err.message);
        reject(err);
        return;
      }

      try {
        this._createContainer();
        const player = window.H265webjsPlayer();
        this.player = player;

        player.on_error_callback = (err) => {
          const msg = (err && (err.message || err.msg || JSON.stringify(err))) || "h265web.js 解码错误";
          this.onError && this.onError("h265web.js: " + msg);
        };

        player.on_ready_show_done_callback = () => {
          this._ready = true;
          this.onFrame && this.onFrame({});
          if (player.play) {
            const p = player.play();
            if (p && p.catch) p.catch(() => {});
          }
        };

        player.video_probe_callback = (info) => {
          if (info && info.meta && info.meta.size) {
            this._resizeCanvas(info.meta.size.width, info.meta.size.height);
          }
        };

        // 注意:video_render_callback 属于 software-only 回调,设置后会强制 h265web.js
        // 走 WASM 软解;为保留其“硬解优先 + 软解回退”能力,这里不绑定该回调,
        // 帧统计在复制画布的 rAF 中按时间节流近似统计。
        const ok = player.build({
          player_id: this.container.id,
          base_url: "/vendor/h265web/",
          wasm_js_uri: "h265web_wasm.js",
          wasm_wasm_uri: "h265web_wasm.wasm",
          ext_src_js_uri: "extjs.js",
          ext_wasm_js_uri: "extwasm.js",
          width: meta.width || 640,
          height: meta.height || 360,
          color: "#000",
          auto_play: true,
          ignore_audio: true,
          type: "raw265",
          format_type: "raw265",
          extInfo: {
            rawFps: 30,
            ignoreAudio: 1,
            autoPlay: true,
            cacheLength: 30,
          },
        });

        if (!ok) {
          const err = new Error("h265web.js build 失败");
          this.onError && this.onError(err.message);
          reject(err);
          return;
        }

        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}/ws-raw?token=${encodeURIComponent(this.mediaToken)}`;
        player.load_media(url);
        this._startCopyLoop();
        resolve();
      } catch (e) {
        const err = new Error("h265web.js 初始化失败:" + e.message);
        this.onError && this.onError(err.message);
        reject(err);
      }
    });
  }

  _createContainer() {
    const id = "h265web-" + (++uid) + "-" + Math.random().toString(36).slice(2);
    this.container = document.createElement("div");
    this.container.id = id;
    this.container.style.cssText =
      "position:absolute;left:-9999px;top:0;width:" +
      (this.meta?.width || 640) +
      "px;height:" +
      (this.meta?.height || 360) +
      "px;overflow:hidden;pointer-events:none;background:#000;z-index:-1;";
    document.body.appendChild(this.container);
  }

  _resizeCanvas(w, h) {
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _startCopyLoop() {
    if (this._raf) return;
    const tick = () => {
      if (this.destroyed) return;
      if (this.container && this.canvas.isConnected) {
        const src = this.container.querySelector("canvas");
        if (src && src.width > 0 && src.height > 0) {
          try {
            this._resizeCanvas(src.width, src.height);
            this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
            const now = performance.now();
            if (now - this._lastFrameAt > 100) {
              this._lastFrameAt = now;
              this.onFrame && this.onFrame({});
            }
          } catch {
            // 尺寸变化瞬间可能失败,忽略
          }
        }
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  feedPacket() {
    // h265web.js 通过 /ws-raw 直接读取裸流,这里无需手动喂包。
  }

  destroy() {
    this.destroyed = true;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this.player) {
      try {
        this.player.release && this.player.release();
      } catch {}
      this.player = null;
    }
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }
}
