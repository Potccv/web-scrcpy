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
  KeyEventAction,
  TouchAction,
  MotionButton,
  MetaState,
  POINTER_ID_MOUSE,
  KeyCode,
} from "../../shared/protocol.js";

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
    this.scrollAccY += e.deltaY;
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

  _onKeyDown(e) {
    // UI 快捷键(由 app/hotkeys 处理)不转发给设备
    if (e.defaultPrevented) return;
    if (!this._isActive()) return;
    // 焦点在输入控件时不转发
    const tag = (e.target && e.target.tagName) || "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

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
    const tag = (e.target && e.target.tagName) || "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
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
