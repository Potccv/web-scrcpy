/**
 * js/input.js — 输入转发:鼠标/触摸/滚轮/键盘 → scrcpy 控制消息。
 *
 * 触摸坐标映射到设备像素坐标;多点触控每根手指使用独立 pointerId,
 * 设备端会自动合成 POINTER_DOWN/UP(与 scrcpy 客户端行为一致)。
 */
import {
  encodeTouchEvent,
  encodeScrollEvent,
  encodeInjectKeycode,
  encodeInjectText,
  encodeSetClipboard,
  encodeUhidCreate,
  encodeUhidDestroy,
  KeyEventAction,
  TouchAction,
  MotionButton,
  MetaState,
  POINTER_ID_MOUSE,
  KeyCode,
} from "../../shared/protocol.js";

/** 标准 USB HID 键盘报告描述符(8 字节报告:modifier/reserved/6 keys) */
const UHID_KEYBOARD_DESCRIPTOR = new Uint8Array([
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01,
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,
  0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
  0xc0,
]);

export class InputController {
  /**
   * @param {object} deps
   * @param {() => {width:number,height:number}|null} deps.getDeviceSize
   * @param {(bytes:Uint8Array)=>void} deps.sendControl
   * @param {() => boolean} deps.isActive 会话是否活跃
   */
  constructor(deps) {
    this.deps = deps;
    this.pointers = new Map(); // pointerId → {x, y}
    this.scrollAccY = 0;
    this.scrollAccX = 0;
    this.pinch = null; // Ctrl+拖拽缩放暂未实现
    this.clipboardSeq = 0;
    this._lastPcClipboardText = "";
    this._suppressKeyUpV = false;
    this._uhidCreated = false;
  }

  /**
   * 绑定输入监听。
   * 事件监听在 canvas 的父容器(viewport)上,而不是 canvas 本身——
   * MediaSource 模式下显示的是 video 元素(canvas 隐藏),监听 canvas 会收不到事件。
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement} [videoEl]
   */
  attach(canvas, videoEl) {
    this.canvas = canvas;
    this.videoEl = videoEl || null;
    const host = canvas.parentElement || canvas;

    host.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    host.addEventListener("pointermove", (e) => this._onPointerMove(e));
    host.addEventListener("pointerup", (e) => this._onPointerUp(e));
    host.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    host.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    host.addEventListener("contextmenu", (e) => e.preventDefault());

    // 键盘输入监听在 document 上;UI 快捷键由 hotkeys 以捕获阶段拦截并
    // preventDefault,这里只转发未被拦截的按键
    document.addEventListener("keydown", (e) => this._onKeyDown(e));
    document.addEventListener("keyup", (e) => this._onKeyUp(e));

    // 电脑端复制/剪切时同步到安卓剪贴板
    document.addEventListener("copy", (e) => this._onCopyOrCut(e));
    document.addEventListener("cut", (e) => this._onCopyOrCut(e));
  }

  _deviceSize() {
    try {
      const s = this.deps.getDeviceSize();
      return s && s.width ? s : null;
    } catch {
      return null;
    }
  }

  _toDevice(e) {
    const size = this._deviceSize();
    if (!size) return null;
    // 当前显示的画面元素:MediaSource 模式是 video,其他模式是 canvas
    const visible =
      this.videoEl && this.videoEl.style.display !== "none" ? this.videoEl : this.canvas;
    if (!visible || !visible.offsetWidth || !visible.offsetHeight) return null;
    const rect = visible.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * size.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * size.height);
    return {
      x: Math.max(0, Math.min(size.width - 1, x)),
      y: Math.max(0, Math.min(size.height - 1, y)),
      size,
    };
  }

  _isActive() {
    return this.deps.isActive() && this.deps.getDeviceSize() !== null;
  }

  _sendTouch(action, pointerId, x, y, size, pressure, actionButton, buttons) {
    this.deps.sendControl(
      encodeTouchEvent(action, pointerId, x, y, size.width, size.height, pressure, actionButton, buttons)
    );
  }

  _onPointerDown(e) {
    if (!this._isActive()) return;
    e.preventDefault();
    if (e.target && e.target.setPointerCapture) {
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch {}
    }
    const p = this._toDevice(e);
    if (!p) return;

    if (e.pointerType === "mouse") {
      this.pointers.set("mouse", p);
      const btn = MotionButton.PRIMARY;
      this._sendTouch(TouchAction.DOWN, POINTER_ID_MOUSE, p.x, p.y, p.size, 1, btn, btn);
      return;
    }

    const id = BigInt(e.pointerId + 1);
    this.pointers.set(e.pointerId, p);
    this._sendTouch(TouchAction.DOWN, id, p.x, p.y, p.size, 1, 0, 0);
  }

  _onPointerMove(e) {
    if (!this._isActive()) return;
    e.preventDefault();
    const p = this._toDevice(e);
    if (!p) return;

    if (e.pointerType === "mouse") {
      if (!this.pointers.has("mouse")) {
        // 未按下的移动发送 hover 事件
        const btn = MotionButton.PRIMARY;
        this._sendTouch(TouchAction.HOVER_MOVE, POINTER_ID_MOUSE, p.x, p.y, p.size, 0, 0, 0);
        return;
      }
      this.pointers.set("mouse", p);
      const btn = MotionButton.PRIMARY;
      this._sendTouch(TouchAction.MOVE, POINTER_ID_MOUSE, p.x, p.y, p.size, 1, 0, btn);
      return;
    }

    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, p);
      const id = BigInt(e.pointerId + 1);
      this._sendTouch(TouchAction.MOVE, id, p.x, p.y, p.size, 1, 0, 0);
    }
  }

  _onPointerUp(e) {
    if (!this._isActive()) return;
    const p = this._toDevice(e);

    if (e.pointerType === "mouse") {
      if (!this.pointers.has("mouse")) return;
      this.pointers.delete("mouse");
      if (!p) return;
      this._sendTouch(TouchAction.UP, POINTER_ID_MOUSE, p.x, p.y, p.size, 0, 0, 0);
      return;
    }

    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (!p) return;
    const id = BigInt(e.pointerId + 1);
    this._sendTouch(TouchAction.UP, id, p.x, p.y, p.size, 0, 0, 0);
  }

  _onWheel(e) {
    if (!this._isActive()) return;
    e.preventDefault();
    const p = this._toDevice(e);
    if (!p) return;

    // 滚轮一格 ≈ ±100 浏览器单位;累积到整格再发送,与 scrcpy 的 ±1/格 对齐
    // 浏览器 WheelEvent.deltaY 向下为正,而 Android AXIS_VSCROLL 向上为正,
    // 所以纵向取反;横向两者都是向右为正,不需要取反。
    this.scrollAccY += -e.deltaY;
    this.scrollAccX += e.deltaX;
    const dy = Math.trunc(this.scrollAccY / 100);
    const dx = Math.trunc(this.scrollAccX / 100);
    if (dy !== 0) this.scrollAccY -= dy * 100;
    if (dx !== 0) this.scrollAccX -= dx * 100;
    if (dy === 0 && dx === 0) return;

    const vscroll = Math.max(-16, Math.min(16, dy));
    const hscroll = Math.max(-16, Math.min(16, dx));
    this.deps.sendControl(
      encodeScrollEvent(p.x, p.y, p.size.width, p.size.height, hscroll, vscroll, 0)
    );
  }

  // -------------------------------------------------------------------------
  // 剪贴板同步(电脑 → 安卓)
  // -------------------------------------------------------------------------

  _sendClipboardToDevice(text, paste = false) {
    if (!text || !this._isActive()) return;
    const seq = ++this.clipboardSeq;
    this.deps.sendControl(encodeSetClipboard(seq, text, paste));
  }

  _copyTextFromEvent(e) {
    try {
      if (e.clipboardData && typeof e.clipboardData.getData === "function") {
        const t = e.clipboardData.getData("text/plain");
        if (t) return t;
      }
    } catch {}
    const el = document.activeElement;
    if (
      el &&
      (el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && /^(text|search|url|tel|password|email|number)$/i.test(el.type)))
    ) {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (end > start) return el.value.substring(start, end);
    }
    const sel = window.getSelection && window.getSelection();
    return sel ? sel.toString() : "";
  }

  _onCopyOrCut(e) {
    if (!this._isActive()) return;
    const text = this._copyTextFromEvent(e);
    if (text) {
      this._lastPcClipboardText = text;
      this._sendClipboardToDevice(text, false);
    }
  }

  async _readPcClipboardText() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const t = await navigator.clipboard.readText();
        if (t) return t;
      } catch {}
    }
    // 非安全上下文(LAN HTTP)没有 navigator.clipboard 时,用隐藏文本框 + execCommand('paste') 读取
    if (typeof document === "undefined") return Promise.resolve("");
    return new Promise((resolve) => {
      try {
        const ta = document.createElement("textarea");
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        let settled = false;
        const finish = (text) => {
          if (settled) return;
          settled = true;
          ta.remove();
          resolve(text || "");
        };
        ta.addEventListener("paste", (e) => {
          e.preventDefault();
          const text = e.clipboardData && e.clipboardData.getData("text/plain");
          finish(text);
        });
        ta.focus();
        document.execCommand("paste");
        setTimeout(() => finish(""), 80);
      } catch {
        resolve("");
      }
    });
  }

  async _pasteFromPcClipboard(e) {
    if (!this._isActive()) return;
    let text = this._lastPcClipboardText || "";
    const read = await this._readPcClipboardText();
    if (read) text = read;
    if (text) {
      this._lastPcClipboardText = text;
      this._sendClipboardToDevice(text, true);
    } else {
      // 读不到电脑剪贴板时退回普通 Ctrl+V,让安卓粘贴自身剪贴板
      const kc = this._keycodeFromPrintable("v");
      if (kc !== null) this._sendKey(kc, e);
    }
  }

  // -------------------------------------------------------------------------
  // 键盘
  // -------------------------------------------------------------------------

  _metaFromEvent(e) {
    let meta = 0;
    if (e.shiftKey) meta |= MetaState.SHIFT_ON;
    if (e.ctrlKey) meta |= MetaState.CTRL_ON;
    if (e.altKey) meta |= MetaState.ALT_ON;
    if (e.metaKey) meta |= MetaState.META_ON;
    return meta;
  }

  _sendKey(keycode, e) {
    const meta = this._metaFromEvent(e);
    this.deps.sendControl(encodeInjectKeycode(KeyEventAction.DOWN, keycode, 0, meta));
    this.deps.sendControl(encodeInjectKeycode(KeyEventAction.UP, keycode, 0, meta));
  }

  /** 注入一段文本到安卓当前焦点输入框(支持中文等 Unicode)。 */
  injectText(text) {
    if (!text || !this._isActive()) return;
    this.deps.sendControl(encodeInjectText(text));
  }

  /** 通过剪贴板 + 粘贴将文本输入安卓(中文等 INJECT_TEXT 不支持的字符更可靠)。 */
  pasteText(text) {
    if (!text || !this._isActive()) return;
    this._sendClipboardToDevice(text, true);
  }

  /** 创建 UHID 物理键盘,使安卓系统认为已连接硬件键盘,从而隐藏软键盘。 */
  createUhidKeyboard() {
    // 不需要等到视频尺寸就绪,只要会话已激活即可创建设备
    if (!this.deps.isActive() || this._uhidCreated) return;
    this._uhidCreated = true;
    this.deps.sendControl(
      encodeUhidCreate(0, 0x18d1, 0x0212, "web-scrcpy keyboard", UHID_KEYBOARD_DESCRIPTOR)
    );
  }

  /** 销毁 UHID 键盘。 */
  destroyUhidKeyboard() {
    if (!this._uhidCreated) return;
    this._uhidCreated = false;
    this.deps.sendControl(encodeUhidDestroy(0));
  }

  _onKeyDown(e) {
    // UI 快捷键(由 app/hotkeys 处理)不转发给设备
    if (e.defaultPrevented) return;
    if (!this._isActive()) return;
    // 输入法组合中:交给浏览器隐藏输入框处理,不转发给安卓
    if (e.isComposing || e.keyCode === 229) return;
    // 焦点在普通输入控件时不转发;隐藏 IME 输入框除外
    const tag = (e.target && e.target.tagName) || "";
    const isImeInput = e.target && e.target.id === "ime-input";
    if (!isImeInput && ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

    const key = e.key;
    const special = {
      Enter: KeyCode.ENTER,
      Backspace: KeyCode.DEL,
      Tab: KeyCode.TAB,
      ArrowUp: KeyCode.DPAD_UP,
      ArrowDown: KeyCode.DPAD_DOWN,
      ArrowLeft: KeyCode.DPAD_LEFT,
      ArrowRight: KeyCode.DPAD_RIGHT,
      PageUp: KeyCode.PAGE_UP,
      PageDown: KeyCode.PAGE_DOWN,
      Delete: KeyCode.FORWARD_DEL,
      Insert: KeyCode.INSERT,
      Home: KeyCode.HOME,
      End: KeyCode.APP_SWITCH,
      "=": KeyCode.VOLUME_UP,
      "+": KeyCode.VOLUME_UP,
      "-": KeyCode.VOLUME_DOWN,
    }[key];

    if (special !== undefined) {
      e.preventDefault();
      this._sendKey(special, e);
      return;
    }

    // Ctrl/Cmd+V:先把电脑剪贴板同步到安卓并触发粘贴
    if ((e.ctrlKey || e.metaKey) && !e.altKey && key.toLowerCase() === "v") {
      e.preventDefault();
      this._suppressKeyUpV = true;
      this._pasteFromPcClipboard(e);
      return;
    }

    // 可打印字符(含 Shift 大小写)通过 KeyCharacterMap 注入文本
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.deps.sendControl(encodeInjectText(key));
      return;
    }

    // Ctrl/Cmd/Alt 组合键 → 键码 + 元状态(设备端应用快捷键)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const kc = this._keycodeFromPrintable(key);
      if (kc !== null) {
        e.preventDefault();
        this._sendKey(kc, e);
      }
    }
  }

  _keycodeFromPrintable(key) {
    if (key.length === 1) {
      const upper = key.toUpperCase();
      const code = upper.charCodeAt(0);
      if (code >= 65 && code <= 90) return KeyCode.A + (code - 65);
      if (code >= 48 && code <= 57) return KeyCode.NUM_0 + (code - 48);
      return {
        " ": KeyCode.SPACE,
        ",": KeyCode.COMMA,
        ".": KeyCode.PERIOD,
        "/": KeyCode.SLASH,
        ";": KeyCode.SEMICOLON,
        "'": KeyCode.APOSTROPHE,
        "[": KeyCode.LEFT_BRACKET,
        "]": KeyCode.RIGHT_BRACKET,
        "\\": KeyCode.BACKSLASH,
        "-": KeyCode.MINUS,
        "=": KeyCode.EQUALS,
        "`": KeyCode.GRAVE,
      }[key] ?? null;
    }
    return null;
  }

  _onKeyUp(e) {
    if (e.defaultPrevented) return;
    if (!this._isActive()) return;
    // 输入法组合中:不转发 keyup
    if (e.isComposing || e.keyCode === 229) return;
    // Ctrl/Cmd+V 已在 keydown 转成剪贴板同步,不再向设备发送 keyup
    if (this._suppressKeyUpV && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      this._suppressKeyUpV = false;
      return;
    }
    const tag = (e.target && e.target.tagName) || "";
    const isImeInput = e.target && e.target.id === "ime-input";
    if (!isImeInput && ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const special = {
      Enter: KeyCode.ENTER,
      Backspace: KeyCode.DEL,
      Tab: KeyCode.TAB,
      ArrowUp: KeyCode.DPAD_UP,
      ArrowDown: KeyCode.DPAD_DOWN,
      ArrowLeft: KeyCode.DPAD_LEFT,
      ArrowRight: KeyCode.DPAD_RIGHT,
      PageUp: KeyCode.PAGE_UP,
      PageDown: KeyCode.PAGE_DOWN,
      Delete: KeyCode.FORWARD_DEL,
      Insert: KeyCode.INSERT,
      Home: KeyCode.HOME,
      End: KeyCode.APP_SWITCH,
      "=": KeyCode.VOLUME_UP,
      "+": KeyCode.VOLUME_UP,
      "-": KeyCode.VOLUME_DOWN,
    }[e.key];
    if (special !== undefined) {
      e.preventDefault();
      this.deps.sendControl(encodeInjectKeycode(KeyEventAction.UP, special, 0, this._metaFromEvent(e)));
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      const kc = this._keycodeFromPrintable(e.key);
      if (kc !== null) {
        e.preventDefault();
        this.deps.sendControl(encodeInjectKeycode(KeyEventAction.UP, kc, 0, this._metaFromEvent(e)));
      }
    }
  }
}
