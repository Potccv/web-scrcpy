/**
 * js/app.js — Web 版 scrcpy 前端主逻辑。
 *
 * 会话生命周期(启动/停止/参数切换)通过 WebSocket JSON 消息完成,
 * 每个浏览器标签页是一个独立客户端,服务端按连接隔离会话
 * (支持多人在线,各自串流不同设备/参数)。
 */
import { CODECS, BITRATE_PRESETS, MAX_SIZE_PRESETS, FPS_PRESETS, encodeGetClipboard } from "../../shared/protocol.js";
import { StreamType, PacketFlags } from "../../shared/video-stream.js";
import { resolveDecoder, createDecoder, decoderLabel, getDecoderOptions, customJsDecoderLabel, h265webDecoderLabel, probeSupport, formatProbeResult, decoderSupports } from "./decoders/index.js";
import { Stats } from "./stats.js";
import { InputController } from "./input.js";
import { setupHotkeys, HOTKEYS, deviceKeyHandlers } from "./hotkeys.js";

const $ = (id) => document.getElementById(id);

/** 触发浏览器下载 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

class App {
  constructor() {
    this.ws = null;
    this.wsRetry = 0;
    this.sessionActive = false;
    this.sessionState = "idle"; // idle | starting | connected | restarting
    this.meta = { codec: null, width: null, height: null, deviceName: null };
    this.applied = { codec: null, width: null, height: null };
    this._metaGen = 0;
    this.decoderId = null;
    this.decoder = null;
    this.mediaToken = null;
    this.supportedCodecs = null;
    this._encoderReqId = 0;
    this.deviceDisplay = null;
    this._displayReqId = 0;
    this.codecOptions = "";
    this.rateLimit = null; // {bitrate, actual}
    this.deviceSerial = ""; // 当前选中的设备(列表形式)
    this.recording = false; // 服务端录制状态
    this.localRecording = null; // {recorder, chunks, source, mime}
    this.pingTimer = null;
    this._lastToast = null;
    this._lastPts = 0;
    this.status = null;
      this.configDefaults = null;

    this.stats = new Stats($("stats-overlay"));
    this.input = new InputController({
      getDeviceSize: () => (this.meta.width ? { width: this.meta.width, height: this.meta.height } : null),
      sendControl: (bytes) => this.sendControl(bytes),
      isActive: () => this.sessionActive,
    });
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  async init() {
    this._cacheDom();
    this._buildSelects();
      await this._loadConfigDefaults();
    this._bindUi();
    this.input.attach($("screen-canvas"), $("screen-video"));
    this._setupHotkeys();
    this._connectWs();
    this._initTheme();
    if (this.dom.logBox) this.dom.logBox.innerHTML = ""; // 清掉占位符,日志滚动追加
    this.stats.update(true);

    setInterval(() => this.stats.update(), 500);
    setInterval(() => this._ping(), 2000);
    await this.refreshStatus();
    this.refreshDevices();
  }

    /** 从服务端配置读取默认串流参数(码率/分辨率/帧率/编码) */
    async _loadConfigDefaults() {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) return;
        const cfg = await res.json();
        this.configDefaults = cfg;
        if (cfg.defaultCodec && this.dom.codecSelect.querySelector(`option[value="${cfg.defaultCodec}"]`)) {
          this.dom.codecSelect.value = cfg.defaultCodec;
        }
        if (cfg.defaultBitrate) {
          const opt = this.dom.bitrateSelect.querySelector(`option[value="${cfg.defaultBitrate}"]`);
          if (opt) {
            this.dom.bitrateSelect.value = String(cfg.defaultBitrate);
          } else {
            this.dom.bitrateSelect.value = "custom";
            this.dom.customBitrate.value = (cfg.defaultBitrate / 1_000_000).toFixed(1);
            this.dom.customBitrate.style.display = "inline-block";
            this.dom.applyBitrateBtn.style.display = "inline-block";
          }
        }
        if (cfg.defaultMaxSize !== undefined) {
          const opt = this.dom.sizeSelect.querySelector(`option[value="${cfg.defaultMaxSize}"]`);
          if (opt) {
            this.dom.sizeSelect.value = String(cfg.defaultMaxSize);
          } else if (cfg.defaultMaxSize > 0) {
            this.dom.sizeSelect.value = "custom";
            this.dom.customSize.value = String(cfg.defaultMaxSize);
            this._syncSizeCustom();
          }
        }
        if (cfg.defaultMaxFps !== undefined) {
          const opt = this.dom.fpsSelect.querySelector(`option[value="${cfg.defaultMaxFps}"]`);
          if (opt) this.dom.fpsSelect.value = String(cfg.defaultMaxFps);
        }
        if (cfg.logLevel) this._log("服务端配置已加载: logLevel=" + cfg.logLevel);
      } catch (e) {
        // 配置接口不可用不影响前端启动
      }
    }

  _cacheDom() {
    this.dom = {
      deviceList: $("device-list"),
      refreshDevicesBtn: $("refresh-devices"),
      disconnectBtn: $("disconnect-btn"),
      renameBtn: $("rename-btn"),
      connectHost: $("connect-host"),
      connectPort: $("connect-port"),
      connectBtn: $("connect-btn"),
      codecSelect: $("codec-select"),
      bitrateSelect: $("bitrate-select"),
      customBitrate: $("custom-bitrate"),
      applyBitrateBtn: $("apply-bitrate"),
      sizeSelect: $("size-select"),
      customSize: $("custom-size"),
      applySizeBtn: $("apply-size"),
      fpsSelect: $("fps-select"),
      decoderSelect: $("decoder-select"),
      probeBtn: $("probe-btn"),
      probeResult: $("probe-result"),
      startBtn: $("start-btn"),
      stopBtn: $("stop-btn"),
      canvas: $("screen-canvas"),
      videoEl: $("screen-video"),
      viewport: $("viewport"),
      statsOverlay: $("stats-overlay"),
      helpOverlay: $("help-overlay"),
      statusBar: $("status-bar"),
      statusState: $("status-state"),
      statusDevice: $("status-device"),
      statusCodec: $("status-codec"),
      statusBitrate: $("status-bitrate"),
      statusDecoder: $("status-decoder"),
      toast: $("toast"),
      logBox: $("log-box"),
      hotkeyList: $("hotkey-list"),
      screenshotBtn: $("screenshot"),
      fullscreenBtn: $("fullscreen"),
      rotateBtn: $("rotate"),
      backBtn: $("back"),
      homeBtn: $("home"),
      appSwitchBtn: $("app-switch"),
      statsBtn: $("stats-toggle"),
      helpBtn: $("help-toggle"),
      themeModeBtn: $("theme-mode"),
      getClipboardBtn: $("get-clipboard"),
      volUpBtn: $("vol-up"),
      volDownBtn: $("vol-down"),
      recordBtn: $("record"),
      recordLocalBtn: $("record-local"),
      sidebar: $("sidebar"),
    };
  }

  _buildSelects() {
    for (const c of CODECS) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.label} — ${c.note}`;
      opt.dataset.label = opt.textContent;
      if (c.id === "h264") opt.selected = true;
      this.dom.codecSelect.appendChild(opt);
    }

    for (let i = 0; i < BITRATE_PRESETS.length; i++) {
      const p = BITRATE_PRESETS[i];
      const opt = document.createElement("option");
      opt.value = String(p.value);
      opt.textContent = p.label;
      if (p.value === 2_000_000) opt.selected = true;
      this.dom.bitrateSelect.appendChild(opt);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "自定义…";
    this.dom.bitrateSelect.appendChild(custom);

    this._buildSizeOptions();
    for (const f of FPS_PRESETS) {
      const opt = document.createElement("option");
      opt.value = String(f.value);
      opt.textContent = f.label;
      this.dom.fpsSelect.appendChild(opt);
    }
    this._buildDecoderOptions();

    for (const [k, desc] of HOTKEYS) {
      const li = document.createElement("li");
      li.innerHTML = `<code>${k}</code><span>${desc}</span>`;
      this.dom.hotkeyList.appendChild(li);
    }
  }

  /** 根据当前编码格式重建“解码方式”下拉框(每个编码只显示对应的解码项) */
  _buildDecoderOptions() {
    const codec = this.dom.codecSelect ? this.dom.codecSelect.value : "h264";
    const previous = this.dom.decoderSelect.value;
    this.dom.decoderSelect.innerHTML = "";
    for (const d of getDecoderOptions(codec)) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.label;
      this.dom.decoderSelect.appendChild(opt);
    }
    // 尽量保留用户之前选择的解码方式;若新编码不支持则回退到第一项(auto)
    if (previous && [...this.dom.decoderSelect.options].some((o) => o.value === previous)) {
      this.dom.decoderSelect.value = previous;
    }
  }

  /** 查询当前设备支持的编码器,并更新编码格式下拉框的可用状态 */
  async updateDeviceEncoderSupport(serial) {
    const reqId = ++this._encoderReqId;
    if (!serial) return;
    try {
      const res = await fetch(`/api/device/encoders?serial=${encodeURIComponent(serial)}`);
      const json = await res.json();
      if (reqId !== this._encoderReqId) return; // 已切换设备,丢弃过期结果
      if (Array.isArray(json.codecs) && json.codecs.length > 0) {
        this.supportedCodecs = json.codecs;
      } else {
        // 查询失败时回退为“不限制”,避免误伤可用编码
        this.supportedCodecs = null;
      }
    } catch {
      if (reqId !== this._encoderReqId) return;
      this.supportedCodecs = null;
    }
    this._applyCodecSupport();
  }

  /** 根据设备支持的编码器禁用/恢复编码格式选项 */
  _applyCodecSupport() {
    const supported = this.supportedCodecs;
    const select = this.dom.codecSelect;
    if (!select) return;

    for (const opt of select.options) {
      const original = opt.dataset.label || opt.textContent;
      if (supported && supported.length && !supported.includes(opt.value)) {
        opt.disabled = true;
        opt.textContent = `${original} (设备不支持)`;
      } else {
        opt.disabled = false;
        opt.textContent = original;
      }
    }

    if (supported && supported.length && !supported.includes(select.value)) {
      // 当前编码设备不支持时切回 H.264(默认兼容编码)
      select.value = "h264";
      this._onCodecOrDecoderChange();
    }
  }

  /** 查询当前设备显示分辨率,用于生成带横/竖屏尺寸的分辨率选项 */
  async updateDeviceDisplay(serial) {
    const reqId = ++this._displayReqId;
    if (!serial) return;
    try {
      const res = await fetch(`/api/device/display?serial=${encodeURIComponent(serial)}`);
      const json = await res.json();
      if (reqId !== this._displayReqId) return;
      if (json.ok && json.width && json.height) {
        this.deviceDisplay = { width: json.width, height: json.height };
      } else {
        this.deviceDisplay = null;
      }
    } catch {
      if (reqId !== this._displayReqId) return;
      this.deviceDisplay = null;
    }
    this._buildSizeOptions();
  }

  /** 根据设备当前显示分辨率生成“分辨率”下拉框 */
  _buildSizeOptions() {
    const select = this.dom.sizeSelect;
    if (!select) return;
    const prev = select.value;
    select.innerHTML = "";
    const d = this.deviceDisplay;
    const add = (value, label) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    };

    add("0", d ? `原始分辨率 (${d.width}x${d.height})` : "原始分辨率");
    for (const s of MAX_SIZE_PRESETS) {
      if (s.value === 0) continue;
      let label = s.label;
      if (d && d.width && d.height) {
        const landscape = d.width >= d.height;
        const max = s.value;
        let w;
        let h;
        if (landscape) {
          w = max;
          h = Math.round((max * d.height) / d.width);
        } else {
          h = max;
          w = Math.round((max * d.width) / d.height);
        }
        label = `${max} (${w}x${h})`;
      }
      add(String(s.value), label);
    }
    add("custom", "自定义…");

    if (prev && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    } else {
      select.value = "0";
    }
    this._syncSizeCustom();
  }

  /** 分辨率下拉框变化:自定义时显示输入框,预设时立即应用 */
  _onSizeChange() {
    this._syncSizeCustom();
    if (this.dom.sizeSelect.value !== "custom") {
      this._onSessionParamChange();
    }
  }

  _syncSizeCustom() {
    const custom = this.dom.sizeSelect.value === "custom";
    if (this.dom.customSize) this.dom.customSize.style.display = custom ? "inline-block" : "none";
    if (this.dom.applySizeBtn) this.dom.applySizeBtn.style.display = custom ? "inline-block" : "none";
  }

  _applyCustomSize() {
    const v = Number(this.dom.customSize.value);
    if (!Number.isFinite(v) || v <= 0) {
      this._toast("请输入有效的分辨率(最长边像素)", 3000);
      return;
    }
    this._applyConfig({ maxSize: Math.round(v) });
  }

  _bindUi() {
    const d = this.dom;
    d.refreshDevicesBtn.addEventListener("click", () => this.refreshDevices());
    d.disconnectBtn.addEventListener("click", () => this.disconnectDevice());
    d.renameBtn.addEventListener("click", () => this.renameDevice());
    d.connectBtn.addEventListener("click", () => this.connectDevice());
    d.startBtn.addEventListener("click", () => this.startSession());
    d.stopBtn.addEventListener("click", () => this.stopSession());
    d.bitrateSelect.addEventListener("change", () => this._onBitrateChange());
    d.applyBitrateBtn.addEventListener("click", () => this._applyCustomBitrate());
    d.codecSelect.addEventListener("change", () => this._onCodecOrDecoderChange());
    d.decoderSelect.addEventListener("change", () => this._onCodecOrDecoderChange());
    d.probeBtn.addEventListener("click", () => this.showProbe());
    d.sizeSelect.addEventListener("change", () => this._onSizeChange());
    d.applySizeBtn.addEventListener("click", () => this._applyCustomSize());
    d.fpsSelect.addEventListener("change", () => this._onSessionParamChange());
    d.themeModeBtn.addEventListener("click", () => this._toggleThemeMode());

    const toolbar = {
      rotateBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).rotateDevice()),
      backBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).deviceBack()),
      homeBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).deviceHome()),
      appSwitchBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).deviceAppSwitch()),
      screenshotBtn: () => this.screenshot(),
      fullscreenBtn: () => this.toggleFullscreen(),
      statsBtn: () => this.toggleStats(),
      helpBtn: () => this.toggleHelp(),
      getClipboardBtn: () => this.sendControl(encodeGetClipboard(1)),
      volUpBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).volumeUp()),
      volDownBtn: () => this.sendControl(deviceKeyHandlers(this.sendControl.bind(this)).volumeDown()),
      recordBtn: () => this.toggleRecording(),
      recordLocalBtn: () => this.toggleLocalRecording(),
    };
    for (const [id, fn] of Object.entries(toolbar)) {
      d[id].addEventListener("click", fn);
    }
  }

  _setupHotkeys() {
    const dev = deviceKeyHandlers((bytes) => this.sendControl(bytes));
    setupHotkeys({
      ...dev,
      toggleStats: () => this.toggleStats(),
      toggleHelp: () => this.toggleHelp(),
      toggleFullscreen: () => this.toggleFullscreen(),
      screenshot: () => this.screenshot(),
      setBitratePreset: (i) => {
        if (BITRATE_PRESETS[i]) {
          this.dom.bitrateSelect.value = String(BITRATE_PRESETS[i].value);
          this._onBitrateChange();
        }
      },
      focusCustomBitrate: () => {
        this.dom.bitrateSelect.value = "custom";
        this.dom.customBitrate.focus();
        this.dom.customBitrate.select();
      },
      onEscape: () => {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else if (this.dom.helpOverlay.classList.contains("visible")) {
          this.toggleHelp(false);
        } else if (this.dom.statsOverlay.classList.contains("visible")) {
          this.toggleStats(false);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  _connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.wsRetry = 0;
      this._log("WebSocket 已连接");
    };
    this.ws.onclose = () => {
      this._log("WebSocket 断开,尝试重连…");
      this.sessionActive = false;
      this._destroyDecoder();
      if (this.sessionState !== "idle") {
        this._setSessionState("idle");
      }
      setTimeout(() => this._connectWs(), Math.min(5000, 1000 * 2 ** this.wsRetry++));
    };
    this.ws.onerror = () => {};
    this.ws.onmessage = (evt) => this._onWsMessage(evt);
  }

  _onWsMessage(evt) {
    if (typeof evt.data === "string") {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      this._onWsJson(msg);
      return;
    }

    // 二进制:[stream 1B][flags 1B][payload]
    const data = new Uint8Array(evt.data);
    if (data.length < 3) return;
    const stream = data[0];
    const flags = data[1];
    this.stats.addBytes(data.length);
    this.stats.addPacket();
    if (this.decoder) {
      this.decoder.feedPacket({ flags, data: data.subarray(2), pts: this._lastPts++ });
    }
  }

  _onWsJson(msg) {
    switch (msg.type) {
      case "ready":
        if (msg.mediaToken) this.mediaToken = msg.mediaToken;
        this._log(`已连接服务端(在线客户端 ${msg.clientCount || 1} 个)`);
        break;
      case "state":
        this._onSessionState(msg);
        break;
      case "meta":
        this._onMeta(msg);
        break;
      case "connected":
        this.meta.deviceName = msg.deviceName;
        this.stats.setMeta({ deviceName: msg.deviceName });
        break;
      case "pong":
        this.stats.onPong(msg.t);
        break;
      case "deviceMsg":
        this._onDeviceMsg(msg);
        break;
      case "rateLimit":
        this.rateLimit = { bitrate: msg.bitrate, actual: msg.actual };
        this.stats.setTargetBitrate(msg.bitrate);
        this._syncStatusBar();
        break;
      case "record":
        this._onRecordMsg(msg);
        break;
      case "disconnected":
        this._toast("设备连接断开:" + (msg.reason || ""), 4000);
        this.sessionActive = false;
        this._destroyDecoder();
        this.rateLimit = null;
        this._setSessionState("idle");
        this._resetScreen();
        break;
      case "error":
        this._toast("错误:" + msg.message, 7000);
        if (this.sessionState === "starting" || this.sessionState === "restarting") {
          this._setSessionState("idle");
        }
        break;
      case "log":
        this._log(msg.level === "error" || msg.level === "warn" ? "⚠ " + msg.message : msg.message);
        if (msg.level === "warn") this._toast(msg.message, 6000);
        break;
        
          
          break;
      default:
        break;
    }
  }

  _onSessionState(msg) {
    const st = msg.state;
    if (st === "connected") {
      this.sessionActive = true;
      this._setSessionState("connected");
      this._syncStatusBar(msg);
    } else if (st === "restarting") {
      this._setSessionState("restarting");
    } else if (st === "stopped") {
      this.sessionActive = false;
      this._setSessionState("idle");
      this._destroyDecoder();
      this.meta = { codec: null, width: null, height: null, deviceName: null };
      this.applied = { codec: null, width: null, height: null };
      this.rateLimit = null;
      this._resetScreen();
    } else if (st === "error") {
      this.sessionActive = false;
      this._toast("会话错误:" + (msg.message || ""), 6000);
      this._setSessionState("idle");
    }
  }

  _onMeta(msg) {
    const changed =
      msg.codec !== this.meta.codec || msg.width !== this.meta.width || msg.height !== this.meta.height;
    this.meta.codec = msg.codec;
    this.meta.width = msg.width;
    this.meta.height = msg.height;
    this.stats.setMeta({ codec: msg.codec, width: msg.width, height: msg.height });
    if (changed) {
      this._applyMeta();
    }
  }

  async _applyMeta() {
    const { codec, width, height } = this.meta;
    if (!codec || !width || !height) return;
    if (codec === this.applied.codec && width === this.applied.width && height === this.applied.height) return;
    const gen = ++this._metaGen;
    this._setSessionState("connected");

    // WebCodecs 支持在下一个 config 包到达时自动重建解码器;旋转/切分辨率时
    // 不必先销毁,避免旧解码器销毁/新解码器初始化期间的竞态与报错。
    if (this.decoderId === "webcodecs" && this.decoder && this.applied.codec === codec) {
      this.applied = { codec, width, height };
      this.dom.canvas.width = width;
      this.dom.canvas.height = height;
      const tip = $("empty-tip");
      if (tip) tip.style.display = "none";
      this._syncStatusBar();
      return;
    }

    this._destroyDecoder();
    this.dom.videoEl.pause();
    const isMse = this.decoderId === "mse";
    this.dom.videoEl.style.display = isMse ? "block" : "none";
    this.dom.canvas.style.display = isMse ? "none" : "block";
    this.dom.canvas.width = width;
    this.dom.canvas.height = height;
    const tip = $("empty-tip");
    if (tip) tip.style.display = "none";

    try {
      const decoder = createDecoder(this.decoderId, {
        codec,
        canvas: this.dom.canvas,
        videoEl: this.dom.videoEl,
        mediaToken: this.mediaToken,
        onFrame: (info) => this.stats.addFrame(info || {}),
        onError: (m) => {
            this.stats.addDecodeError();
            this._toast("解码器错误:" + m, 6000);
          },
        onInfo: (m) => this._toast(m, 3000),
          onFrameDrop: () => this.stats.addDroppedFrame(),
      });
      this.decoder = decoder;
      await decoder.init({ codec, width, height });
      // 旋转/切流期间可能又收到新的 meta,丢弃过期初始化结果
      if (gen !== this._metaGen) {
        if (this.decoder === decoder) this._destroyDecoder();
        return;
      }
      this.applied = { codec, width, height };
      const label = this.decoderId === "custom-js"
        ? customJsDecoderLabel(codec)
        : this.decoderId === "h265web"
          ? h265webDecoderLabel(codec)
          : decoderLabel(this.decoderId);
      this.decoderLabel = label;
      this.stats.setDecoder(label + (this.codecOptions ? " (profile=baseline)" : ""));
      this._syncStatusBar();
      this._log(`视频流就绪:${codec.toUpperCase()} ${width}x${height} 解码器=${label}`);
      if ((this.decoderId === "custom-js" || this.decoderId === "h265web") && width * height > 1280 * 720) {
        this._toast("当前为 JS/WASM 软解,高分辨率下可能有明显延迟;建议降低分辨率或改用 WebCodecs", 6000);
      }
    } catch (e) {
      if (gen !== this._metaGen) return;
      this._toast("解码器初始化失败:" + e.message, 6000);
    }
  }

  _onDeviceMsg(msg) {
    if (msg.kind === "clipboard") {
      this._toast("设备剪贴板已同步", 2500);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(msg.text).catch(() => {});
      }
    } else if (msg.kind === "ackClipboard") {
      this._toast("设备剪贴板已更新", 2500);
    }
  }

  // -------------------------------------------------------------------------
  // 会话控制(经 WS)
  // -------------------------------------------------------------------------

  _currentParams() {
    let bitrate = Number(this.dom.bitrateSelect.value);
    if (this.dom.bitrateSelect.value === "custom") {
      bitrate = Number(this.dom.customBitrate.value) * 1_000_000;
      if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = 2_000_000;
    }
    let maxSize = Number(this.dom.sizeSelect.value) || 0;
    if (this.dom.sizeSelect.value === "custom") {
      maxSize = Number(this.dom.customSize.value) || 0;
    }
    return {
      codec: this.dom.codecSelect.value,
      bitrate,
      maxSize,
      maxFps: Number(this.dom.fpsSelect.value) || 0,
      decoder: this.dom.decoderSelect.value,
    };
  }

  async _resolveDecoderParams(params) {
    if (params.decoder === "custom-js" && !["h264", "h265"].includes(params.codec)) {
      throw new Error("自定义JS解码支持 H.264 / H.265,请切换编码格式(或选择 WebCodecs)");
    }
    const resolved = await resolveDecoder(params.decoder, params.codec);
    this.decoderId = resolved.decoderId;
    this.codecOptions = resolved.codecOptions;
    if (resolved.warning) this._toast(resolved.warning, 5000);
    return resolved;
  }

  async startSession() {
    const params = this._currentParams();
    const serial = this.deviceSerial;
    if (!serial) {
      this._toast("请先选择设备", 3000);
      return;
    }
    try {
      await this._resolveDecoderParams(params);
    } catch (e) {
      this._toast(e.message, 5000);
      return;
    }


    this._setSessionState("starting");
    this._destroyDecoder();
    this.meta = { codec: null, width: null, height: null, deviceName: null };
    this.applied = { codec: null, width: null, height: null };
    this.stats.reset();
    this.stats.setTargetBitrate(params.bitrate);
    this.rateLimit = null;

    const sent = this.sendJson({
      type: "start",
      serial,
      codec: params.codec,
      bitrate: params.bitrate,
      maxSize: params.maxSize,
      maxFps: params.maxFps,
      codecOptions: this.codecOptions,
    });
    if (!sent) {
      this._setSessionState("idle");
      this._toast("WebSocket 未连接,无法启动", 4000);
      return;
    }
    this._log(`请求启动串流:${serial} codec=${params.codec} bitrate=${params.bitrate}`);
  }

  stopSession() {
    this.sendJson({ type: "stop" });
  }

  _onBitrateChange() {
    const v = this.dom.bitrateSelect.value;
    if (v === "custom") {
      this.dom.customBitrate.style.display = "inline-block";
      this.dom.applyBitrateBtn.style.display = "inline-block";
      return;
    }
    this.dom.customBitrate.style.display = "none";
    this.dom.applyBitrateBtn.style.display = "none";
    this._applyConfig({ bitrate: Number(v) });
  }

  _applyCustomBitrate() {
    const mbps = Number(this.dom.customBitrate.value);
    if (!Number.isFinite(mbps) || mbps <= 0) {
      this._toast("请输入有效的码率(Mbps)", 3000);
      return;
    }
    this._applyConfig({ bitrate: Math.round(mbps * 1_000_000) });
  }

  async _onCodecOrDecoderChange() {
    this._buildDecoderOptions();
    const custom = this.dom.bitrateSelect.value === "custom";
    this.dom.customBitrate.style.display = custom ? "inline-block" : "none";
    this.dom.applyBitrateBtn.style.display = custom ? "inline-block" : "none";
    const params = this._currentParams();
    if (params.decoder === "custom-js" && !["h264", "h265"].includes(params.codec)) {
      this._toast("自定义JS解码支持 H.264/H.265,当前编码需使用 WebCodecs", 5000);
    }
    if (params.decoder === "webcodecs") {
      // 提前探测:浏览器 WebCodecs 是否真的支持当前编码(避免无画面)
      decoderSupports("webcodecs", params.codec).then((ok) => {
        if (!ok && this.dom.decoderSelect.value === "webcodecs") {
          this._toast(
            `当前浏览器 WebCodecs 不支持 ${params.codec.toUpperCase()},请改用「自定义JS」或「MediaSource」解码`,
            6000
          );
        }
      });
    }
    // 解码方式/编码变化:重新解析解码器,强制下次重建(运行中切换立即生效)
    try {
      const resolved = await resolveDecoder(params.decoder, params.codec);
      this.decoderId = resolved.decoderId;
      this.codecOptions = resolved.codecOptions;
      if (resolved.warning) this._toast(resolved.warning, 5000);
    } catch (e) {
      this._toast("解码方式不可用:" + e.message, 5000);
      return;
    }
    this.applied = { codec: null, width: null, height: null };
    this._probeCurrentCodec();
    if (this.sessionActive) {
      this._applyConfig({});
    }
  }

  /** 检测当前所选编码的支持情况并展示(任务:解码能力提示) */
  async _probeCurrentCodec() {
    const params = this._currentParams();
    const codec = params.codec;
    const probe = await probeSupport();
    const row = (name, ok) => (ok ? `<span class="ok">✓ ${name}</span>` : `<span class="no">✗ ${name}</span>`);
    const videoRows = [
      "WebCodecs(原生): " + row("可用", probe.webcodecs[codec]),
      "h265web.js: " + row("可用", probe.h265web[codec]),
      "MediaSource(回退): " + row("可用", probe.mse[codec]),
      "自定义JS/WASM: " + row("可用", probe.customJs[codec]),
    ];
    this.dom.probeResult.innerHTML = `<b>${codec.toUpperCase()}</b> 解码能力\n` + videoRows.join("\n");
    this.dom.probeResult.classList.add("show");
  }

  /** 完整能力检测报告 */
  async showProbe() {
    const probe = await probeSupport();
    const text = formatProbeResult(probe);
    this.dom.probeResult.innerHTML = "视频解码能力\n" + text;
    this.dom.probeResult.classList.add("show");
  }

  _onSessionParamChange() {
    if (this.sessionActive) {
      this._applyConfig({});
    }
  }

  _applyConfig(patch) {
    const params = this._currentParams();
    if (this.decoderId === "custom-js" && !["h264", "h265"].includes(params.codec)) return;
    const bitrate = patch.bitrate !== undefined ? patch.bitrate : params.bitrate;
    // 切换码率后立即更新统计面板的目标码率(等 restart 完成前即可看到新值)
    this.stats.setTargetBitrate(bitrate);
    if (patch.bitrate !== undefined) {
      // 手动调整码率:清除自动降档的残留状态,状态栏不再显示"已限"
      this.rateLimit = null;
      this._syncStatusBar();
    }
    const payload = {
      codec: params.codec,
      bitrate: params.bitrate,
      maxSize: params.maxSize,
      maxFps: params.maxFps,
      codecOptions: this.decoderId === "custom-js" && params.codec === "h264" ? "profile=1" : "",
      ...patch,
    };
    this._log(`切换参数:${JSON.stringify(payload)}`);
    this.sendJson({ type: "config", ...payload });
    this._toast("正在应用新参数(约1~2秒)…", 2000);
  }

  // -------------------------------------------------------------------------
  // 工具栏操作
  // -------------------------------------------------------------------------

  sendControl(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
      return true;
    }
    return false;
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  toggleStats(force) {
    const show = force !== undefined ? force : !this.dom.statsOverlay.classList.contains("visible");
    this.dom.statsOverlay.classList.toggle("visible", show);
    if (show) this.stats.update(true);
    this._repositionStats();
  }

  toggleHelp(force) {
    const show = force !== undefined ? force : !this.dom.helpOverlay.classList.contains("visible");
    this.dom.helpOverlay.classList.toggle("visible", show);
    this._repositionStats();
  }

  /**
   * 统计面板位置:帮助打开时移到帮助右侧(间隔与帮助距侧栏一致),
   * 关闭帮助后回到左上角。
   */
  _repositionStats() {
    const stats = this.dom.statsOverlay;
    const help = this.dom.helpOverlay;
    if (!stats) return;
    const helpVisible = help.classList.contains("visible");
    const statsVisible = stats.classList.contains("visible");
    if (helpVisible && statsVisible) {
      // stats 是 viewport 的子元素,left 相对 viewport;
      // help 的 getBoundingClientRect 是屏幕坐标,需减去 viewport 偏移
      const vp = this.dom.viewport.getBoundingClientRect();
      const r = help.getBoundingClientRect();
      stats.style.left = r.right - vp.left + 10 + "px";
      stats.style.top = "10px";
    } else if (!helpVisible) {
      // 关闭帮助:回到左上角(清除内联定位,用 CSS 默认)
      stats.style.left = "";
      stats.style.top = "";
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.dom.viewport.requestFullscreen && this.dom.viewport.requestFullscreen();
    }
  }

  screenshot() {
    const canvas = this.dom.canvas;
    if (!canvas.width || !canvas.height) {
      this._toast("尚无画面可截图", 3000);
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, "scrcpy-" + Date.now() + ".png");
    }, "image/png");
  }

  // -------------------------------------------------------------------------
  // 录制(输出 MP4,编码与串流一致)
  // -------------------------------------------------------------------------

  /** 顶栏录制按钮:切换开始/停止 */
  toggleRecording() {
    if (!this.sessionActive) {
      this._toast("请先开始串流", 3000);
      return;
    }
    if (!this.meta.codec) {
      this._toast("视频流尚未就绪,请稍候再试", 3000);
      return;
    }
    if (this.recording) {
      this.sendJson({ type: "record", action: "stop" });
      this._setRecordingUi(false, "停止中…");
    } else {
      this.sendJson({ type: "record", action: "start" });
      this._setRecordingUi(true, "⏹ 停止");
      this._toast("正在等待画面更新,开始录制…", 2500);
    }
  }

  _setRecordingUi(on, label) {
    this.recording = on;
    this.dom.recordBtn.textContent = label;
    this.dom.recordBtn.classList.toggle("recording", on);
  }

  _onRecordMsg(msg) {
    switch (msg.action) {
      case "started":
        // UI 已在点击时切换
        break;
      case "recording":
        this._toast("录制中(MP4)…", 2000);
        break;
      case "waiting":
        this._toast("画面无变化,请操作设备(点击/滑动),录制将自动开始", 4000);
        break;
      case "limit":
        this._setRecordingUi(false, "⏺ 录制");
        this._toast("录制内容过大,已自动停止并保存", 4000);
        break;
      case "empty":
        this._setRecordingUi(false, "⏺ 录制");
        this._toast("未录制到画面:设备画面没有变化,请操作设备后重试", 4000);
        break;
      case "stopped":
        this._setRecordingUi(false, "⏺ 录制");
        if (msg.url) {
          const a = document.createElement("a");
          a.href = msg.url;
          a.download = msg.filename || "recording.mp4";
          document.body.appendChild(a);
          a.click();
          a.remove();
          this._toast(
            `录制完成:${msg.frames || 0} 帧,${((msg.bytes || 0) / 1048576).toFixed(1)} MB`,
            5000
          );
        } else {
          this._toast("录制已停止", 2500);
        }
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 浏览器本地录制(MediaRecorder 直接录画面,停止即下载)
  // -------------------------------------------------------------------------

  /** 探测浏览器支持的录制格式(优先 MP4/H.264,回退 WebM) */
  _pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return null;
    const candidates = [
      'video/mp4;codecs="avc1.42E01E"',
      "video/mp4",
      'video/webm;codecs="vp9"',
      'video/webm;codecs="vp8"',
      "video/webm",
    ];
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch {}
    }
    return null;
  }

  /** 顶栏"本机录屏"按钮:切换开始/停止 */
  toggleLocalRecording() {
    if (!this.sessionActive) {
      this._toast("请先开始串流", 3000);
      return;
    }
    if (this.localRecording) {
      this._stopLocalRecording();
    } else {
      this._startLocalRecording();
    }
  }

  _startLocalRecording() {
    if (typeof MediaRecorder === "undefined") {
      this._toast("当前浏览器不支持 MediaRecorder", 4000);
      return;
    }
    // 录制源:canvas 显示时用 canvas(webcodecs / 自定义 JS),否则用 video(MSE)
    let stream = null;
    let source = "canvas";
    if (this.dom.canvas.width > 0 && this.dom.canvas.height > 0) {
      if (this.dom.canvas.captureStream) {
        stream = this.dom.canvas.captureStream(30);
      }
    } else if (this.dom.videoEl.captureStream && !this.dom.videoEl.paused) {
      stream = this.dom.videoEl.captureStream();
      source = "video";
    }
    if (!stream) {
      this._toast("尚无画面可录制", 3000);
      return;
    }
    const mime = this._pickRecorderMime();
    let recorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      this._toast("无法创建录制器:" + e.message, 4000);
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : type.includes("quicktime") ? "mov" : "webm";
      const blob = new Blob(chunks, { type });
      if (blob.size > 0) {
        downloadBlob(blob, `rec-local-${Date.now()}.${ext}`);
        this._toast(`本机录屏完成:${(blob.size / 1048576).toFixed(1)} MB (${ext})`, 5000);
      } else {
        this._toast("本机录屏未获取到画面数据(画面无变化?)", 4000);
      }
      this.localRecording = null;
      this._setLocalRecordingUi(false, "🎬 本机录屏");
    };
    recorder.start(500); // 每 500ms 收集一次数据
    this.localRecording = { recorder, source, mime };
    // canvas.captureStream 只在画布重绘时出帧;用 rAF 强制重绘,保证录制时长连续
    this._localRaf = () => {
      if (!this.localRecording) return;
      const canvas = this.dom.canvas;
      if (source === "canvas" && canvas.width && canvas.height) {
        try {
          canvas.getContext("2d").drawImage(canvas, 0, 0);
        } catch {}
      }
      requestAnimationFrame(this._localRaf);
    };
    requestAnimationFrame(this._localRaf);
    this._setLocalRecordingUi(true, "⏹ 停止录屏");
    this._toast(`开始本机录屏(${source === "canvas" ? "画布" : "视频"}画面)…`, 2500);
  }

  _stopLocalRecording() {
    const rec = this.localRecording;
    if (!rec) return;
    this.localRecording = null;
    if (this._localRaf) {
      cancelAnimationFrame(this._localRaf);
      this._localRaf = null;
    }
    try {
      rec.recorder.stop();
    } catch {
      // 已停止或异常,onstop 可能不触发
      this._setLocalRecordingUi(false, "🎬 本机录屏");
    }
  }

  _setLocalRecordingUi(on, label) {
    const btn = this.dom.recordLocalBtn;
    if (!btn) return;
    btn.textContent = label;
    btn.classList.toggle("recording", on);
  }

  // -------------------------------------------------------------------------
  // 主题:默认自动跟随系统,手动切换后本会话不再跟随(刷新恢复自动)
  // -------------------------------------------------------------------------

  _initTheme() {
    // 默认自动跟随系统主题;用户手动切换后本会话内不再跟随,刷新后回到跟随系统
    this._themeAuto = true;
    this._themeMode = "light"; // 手动模式的起点(进入手动时以当前主题为准)
    this._renderThemeUi();
    this._applyTheme();
    // 跟随系统:监听系统主题变化
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (this._themeAuto) this._applyTheme();
      });
    }
  }

  _toggleThemeMode() {
    if (this._themeAuto) {
      // 用户主动切换:退出跟随系统,以当前实际主题为起点,避免跳变
      this._themeAuto = false;
      this._themeMode = document.documentElement.dataset.theme || "light";
    }
    this._themeMode = this._themeMode === "light" ? "dark" : "light";
    this._renderThemeUi();
    this._applyTheme();
  }

  _applyTheme() {
    let theme;
    if (this._themeAuto) {
      theme =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    } else {
      theme = this._themeMode;
    }
    document.documentElement.dataset.theme = theme;
  }

  /** 亮暗开关 UI 状态:按当前实际主题显示太阳(亮)/月亮(暗) */
  _renderThemeUi() {
    const modeBtn = this.dom.themeModeBtn;
    if (!modeBtn) return;
    const cur = this._themeAuto
      ? window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : this._themeMode;
    modeBtn.classList.toggle("light", cur === "light");
    modeBtn.classList.toggle("dark", cur === "dark");
  }

  // -------------------------------------------------------------------------
  // 设备管理
  // -------------------------------------------------------------------------

  async refreshStatus() {
    try {
      const res = await fetch("/api/status");
      this.status = await res.json();
      if (this.status.adb) {
        this._toast("⚠ " + this.status.adb, 8000);
      }
      if (this.status.devices) {
        this._populateDevices(this.status.devices);
      }
    } catch (e) {
      this._toast("无法连接服务端:" + e.message, 5000);
    }
  }

  async refreshDevices() {
    try {
      const res = await fetch("/api/devices");
      const json = await res.json();
      this._populateDevices(json.devices || []);
    } catch (e) {
      this._toast("获取设备列表失败:" + e.message, 4000);
    }
  }

  // -------------------------------------------------------------------------
  // 设备别名(localStorage 持久化)
  // -------------------------------------------------------------------------

  _aliasMap() {
    try {
      return JSON.parse(localStorage.getItem("scrcpy-device-aliases") || "{}");
    } catch {
      return {};
    }
  }

  _saveAlias(serial, alias) {
    const m = this._aliasMap();
    if (alias) m[serial] = alias;
    else delete m[serial];
    try {
      localStorage.setItem("scrcpy-device-aliases", JSON.stringify(m));
    } catch {}
  }

  /** 给当前选中的设备命名(弹窗输入,留空清除) */
  renameDevice() {
    const serial = this.deviceSerial;
    if (!serial) {
      this._toast("请先选择要命名的设备", 3000);
      return;
    }
    const current = this._aliasMap()[serial] || "";
    const alias = prompt(`给设备 ${serial} 起个别名(留空清除):`, current);
    if (alias === null) return;
    const name = alias.trim();
    this._saveAlias(serial, name);
    if (this.status && this.status.devices) {
      this._populateDevices(this.status.devices);
    }
    this._toast(name ? `已命名 ${serial} 为「${name}」` : "已清除别名", 3000);
  }

  _populateDevices(devices) {
    const list = this.dom.deviceList;
    list.innerHTML = "";
    const aliases = this._aliasMap();
    const prev = this.deviceSerial;
    let first = null;
    for (const d of devices) {
      if (d.state !== "device") continue;
      const item = document.createElement("div");
      item.className = "device-item";
      item.dataset.serial = d.serial;
      const alias = aliases[d.serial];
      const nameEl = document.createElement("span");
      nameEl.className = "dev-name";
      nameEl.textContent = alias || d.model || d.serial;
      const subEl = document.createElement("span");
      subEl.className = "dev-sub";
      subEl.textContent = alias ? `${d.serial}${d.model ? " (" + d.model + ")" : ""}` : d.serial;
      item.appendChild(nameEl);
      item.appendChild(subEl);
      item.addEventListener("click", () => this._selectDevice(d.serial, item));
      list.appendChild(item);
      if (!first) first = d.serial;
    }
    if (!list.children.length) {
      list.innerHTML = '<div class="device-empty">未发现可用设备</div>';
      this._toast("未发现已授权设备:请连接手机(无线调试)或启动模拟器,并接受授权弹窗", 6000);
      this.deviceSerial = "";
      return;
    }
    // 恢复或默认选中
    if (prev && list.querySelector(`[data-serial="${prev}"]`)) {
      this._selectDevice(prev, list.querySelector(`[data-serial="${prev}"]`));
    } else {
      this._selectDevice(first, list.firstChild);
    }
  }

  _selectDevice(serial, el) {
    this.deviceSerial = serial;
    const list = this.dom.deviceList;
    for (const c of list.children) {
      c.classList.toggle("active", c === el);
    }
    this.updateDeviceEncoderSupport(serial);
    this.updateDeviceDisplay(serial);
  }

  async connectDevice() {
    const host = this.dom.connectHost.value.trim();
    if (!host) {
      this._toast("请输入设备 IP", 3000);
      return;
    }
    const port = Number(this.dom.connectPort.value) || 5555;
    this._toast(`正在连接 ${host}:${port} …`, 2000);
    try {
      const res = await fetch("/api/devices/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port }),
      });
      const json = await res.json();
      this._toast(json.message, 5000);
      await this.refreshDevices();
    } catch (e) {
      this._toast("连接失败:" + e.message, 4000);
    }
  }

  /** 断开当前选中的设备(adb disconnect) */
  async disconnectDevice() {
    const serial = this.deviceSerial;
    if (!serial) {
      this._toast("请先选择要断开的设备", 3000);
      return;
    }
    this._toast(`正在断开 ${serial} …`, 2000);
    try {
      const res = await fetch("/api/devices/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }),
      });
      const json = await res.json();
      this._toast(json.message || "已断开", 4000);
      await this.refreshDevices();
    } catch (e) {
      this._toast("断开失败:" + e.message, 4000);
    }
  }

  // -------------------------------------------------------------------------
  // 状态与工具
  // -------------------------------------------------------------------------

  _setSessionState(state) {
    this.sessionState = state;
    const map = {
      idle: ["空闲", ""],
      starting: ["启动中…", "busy"],
      connected: ["已连接", "ok"],
      restarting: ["切换参数中…", "busy"],
    };
    const [label, cls] = map[state] || [state, ""];
    this.dom.statusState.textContent = label;
    this.dom.statusState.className = "state-badge " + cls;
    this.dom.startBtn.disabled = state === "starting" || state === "connected" || state === "restarting";
    this.dom.stopBtn.disabled = state !== "connected" && state !== "restarting";
  }

  _syncStatusBar(session) {
    const s = session || {
      codec: this.meta.codec,
      bitrate: this._currentParams().bitrate,
      width: this.meta.width,
      height: this.meta.height,
      serial: this.deviceSerial,
    };
    this.dom.statusDevice.textContent = s.serial || "-";
    this.dom.statusCodec.textContent = (s.codec || this.meta.codec || "-").toUpperCase();
    const bitrate = s.bitrate || 0;
    let bitrateText = bitrate ? (bitrate / 1_000_000).toFixed(1) + " Mbps" : "-";
    if (this.rateLimit && this.rateLimit.bitrate) {
      bitrateText = `≤${(this.rateLimit.bitrate / 1_000_000).toFixed(1)}M(已限)`;
    }
    this.dom.statusBitrate.textContent = bitrateText;
    this.dom.statusDecoder.textContent = this.decoderLabel || "-";
    if (this.meta.width) {
      this.dom.statusCodec.textContent += ` ${this.meta.width}×${this.meta.height}`;
    }
  }

  /** 会话停止/断开后把画面恢复为初始状态(清空画布,显示占位提示) */
  _resetScreen() {
    this.decoderLabel = null;
    if (this.recording) this._setRecordingUi(false, "⏺ 录制");
    if (this.localRecording) {
      if (this._localRaf) {
        cancelAnimationFrame(this._localRaf);
        this._localRaf = null;
      }
      this.localRecording = null;
      this._setLocalRecordingUi(false, "🎬 本机录屏");
    }
    try {
      const ctx = this.dom.canvas.getContext("2d");
      ctx.clearRect(0, 0, this.dom.canvas.width, this.dom.canvas.height);
      this.dom.canvas.width = 0;
      this.dom.canvas.height = 0;
    } catch {}
    try {
      this.dom.videoEl.pause();
      this.dom.videoEl.removeAttribute("src");
      this.dom.videoEl.load();
    } catch {}
    this.dom.videoEl.style.display = "none";
    this.dom.canvas.style.display = "block";
    const tip = $("empty-tip");
    if (tip) tip.style.display = "";
    this._syncStatusBar();
  }

  _destroyDecoder() {
    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch {}
      this.decoder = null;
    }
  }

  _ping() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionActive) {
      this.sendJson({ type: "ping", t: performance.now() });
    }
  }

  _toast(msg, ms = 3000) {
    this.dom.toast.textContent = msg;
    this.dom.toast.classList.add("show");
    clearTimeout(this._lastToast);
    this._lastToast = setTimeout(() => this.dom.toast.classList.remove("show"), ms);
  }

  _log(msg) {
    console.log("[scrcpy-web]", msg);
    if (this.dom.logBox) {
      const box = this.dom.logBox;
      const line = document.createElement("div");
      line.textContent = msg;
      box.appendChild(line);
      // 限制行数,防止无限增长
      while (box.children.length > 300) {
        box.removeChild(box.firstChild);
      }
      // 滚动到最新一行
      box.scrollTop = box.scrollHeight;
    }
  }
}

const app = new App();
app.init();
window.__scrcpyApp = app; // 便于调试
