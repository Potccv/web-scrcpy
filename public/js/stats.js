/**
 * js/stats.js — 实时统计(帧率、传输速率、延迟等)与悬浮层渲染。
 *
 * 键盘快捷键(需求:通过按键展示帧数/传输速率等):
 *   i — 切换统计面板
 *   h — 帮助面板
 *   f — 全屏
 *   r — 设备旋转
 *   s — 截图
 *   1~5 — 切换码率档位
 *   0 — 聚焦自定义码率输入框
 */
export class Stats {
  constructor(overlayEl) {
    this.el = overlayEl;
    this.reset();
  }

  reset() {
    this._bytes = 0;
    this._packets = 0;
    this._totalBytes = 0;
    this._framesInWindow = 0;
    this._windowStart = performance.now();
    this._rateBps = 0;
    this.rtt = null;
    this.rttLast = null;
    this.meta = { codec: null, width: null, height: null, deviceName: null };
    this.decoderName = null;
    this.codecOptions = "";
    this.targetBitrate = null;
    this.lastUpdate = 0;
  }

  /** 设置目标码率档位(用于对比实际传输速率) */
  setTargetBitrate(bps) {
    this.targetBitrate = bps;
  }

  /** 累计收到的字节数(含 WS 帧头),用于计算传输速率与接收总量 */
  addBytes(bytes) {
    this._bytes += bytes;
    this._totalBytes += bytes;
  }

  addPacket() {
    this._packets++;
  }

  addFrame() {
    this._framesInWindow++;
  }

  setMeta(meta) {
    Object.assign(this.meta, meta);
  }

  setDecoder(name) {
    this.decoderName = name;
  }

  /** 收到 pong 时计算 RTT */
  onPong(t) {
    this.rtt = Math.round(performance.now() - t);
    this.rttLast = this.rtt;
  }

  /** 每 500ms 由 app 调用一次 */
  update(force = false) {
    const now = performance.now();
    const dt = now - this._windowStart;
    if (!force && dt < 400) return;

    const bytes = this._bytes;
    this._bytes = 0;
    const instBps = dt > 0 ? (bytes * 8 * 1000) / dt : 0;
    this._rateBps = this._rateBps === 0 ? instBps : this._rateBps * 0.7 + instBps * 0.3;

    const fps = (this._framesInWindow * 1000) / Math.max(dt, 1);
    this._framesInWindow = 0;
    this._windowStart = now;

    this._render(fps);
  }

  _fmtRate(bps) {
    if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(2) + " Mbps";
    if (bps >= 1000) return (bps / 1000).toFixed(1) + " kbps";
    return Math.round(bps) + " bps";
  }

  _fmtBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }

  _render(fps) {
    const m = this.meta;
    const lines = [];
    if (m.deviceName) lines.push(["设备", m.deviceName]);
    lines.push(["编码格式", m.codec ? m.codec.toUpperCase() : "-"]);
    lines.push(["分辨率", m.width && m.height ? m.width + "×" + m.height : "-"]);
    lines.push(["解码器", this.decoderName || "-"]);
    lines.push(["解码帧率", fps.toFixed(1) + " FPS"]);
    lines.push(["传输速率", this._fmtRate(this._rateBps)]);
    lines.push(["目标码率", this.targetBitrate ? this._fmtRate(this.targetBitrate) : "-"]);
    lines.push(["接收总量", this._packets + " 包 / " + this._fmtBytes(this._totalBytes)]);
    lines.push(["端到端延迟", this.rtt !== null ? this.rtt + " ms" : "-"]);

    let html = "";
    for (const [k, v] of lines) {
      html += `<div class="stat-row"><span class="stat-key">${k}</span><span class="stat-val">${v}</span></div>`;
    }
    this.el.innerHTML = html;
  }
}
