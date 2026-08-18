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

// h265web.js 官方公开的免费 token(来自项目 README,非用户私密凭据)。
// 旧版 raw265 内核初始化 WASM 时需要传入该字符串。
const H265WEB_TOKEN =
  "base64:QXV0aG9yOmNoYW5neWFubG9uZ3xudW1iZXJ3b2xmLEdpdGh1YjpodHRwczovL2dpdGh1Yi5jb20vbnVtYmVyd29sZixFbWFpbDpwb3JzY2hlZ3QyM0Bmb3htYWlsLmNvbSxRUTo1MzEzNjU4NzIsSG9tZVBhZ2U6aHR0cDovL3h2aWRlby52aWRlbyxEaXNjb3JkOm51bWJlcndvbGYjODY5NCx3ZWNoYXI6bnVtYmVyd29sZjExLEJlaWppbmcsV29ya0luOkJhaWR1";

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
      !!(window.new265webjs || window.H265webjsPlayer) &&
      ["h264", "h265", "av1"].includes(codec)
    );
  }

  init(meta) {
    this.destroyed = false;
    this.meta = meta;
    this._resizeCanvas(meta.width, meta.height);

    return new Promise((resolve, reject) => {
      if (!window.new265webjs && !window.H265webjsPlayer) {
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
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}/ws-raw?token=${encodeURIComponent(this.mediaToken)}`;

        // 优先使用旧版 raw265 播放内核(new265webjs),它专为 raw265/raw HEVC/AVC 裸流设计;
        // 新版 H265webjsPlayer 的 raw265 在部分环境下不出图。
        let player;
        if (window.new265webjs) {
          const config = {
            type: "raw265",
            player: this.container.id,
            width: meta.width || 640,
            height: meta.height || 360,
            token: H265WEB_TOKEN,
            extInfo: {
              rawFps: 30,
              ignoreAudio: 1,
              autoPlay: true,
              readyShow: true,
              cacheLength: 30,
            },
          };
          player = window.new265webjs(url, config);
        } else {
          player = window.H265webjsPlayer();
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
            token: H265WEB_TOKEN,
            type: "raw265",
            format_type: "raw265",
            extInfo: {
              rawFps: 30,
              ignoreAudio: 1,
              autoPlay: true,
              readyShow: true,
              cacheLength: 30,
            },
          });
          if (!ok) {
            const err = new Error("h265web.js build 失败");
            this.onError && this.onError(err.message);
            reject(err);
            return;
          }
          player.load_media(url);
        }

        this.player = player;
        player.onLoadFinish = () => {
          this._ready = true;
          this.onFrame && this.onFrame({});
          if (player.play) {
            const p = player.play();
            if (p && p.catch) p.catch(() => {});
          }
        };
        player.onError = (err) => {
          const msg = (err && (err.message || err.msg || JSON.stringify(err))) || "h265web.js 解码错误";
          this.onError && this.onError("h265web.js: " + msg);
        };
        // 兼容旧版/新版不同回调命名
        player.on_error_callback = player.onError;
        player.on_ready_show_done_callback = player.onLoadFinish;

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
