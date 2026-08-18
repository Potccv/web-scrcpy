/**
 * shared/protocol.js — scrcpy 控制协议常量与消息编码/解码。
 *
 * 同时被 Node 服务端(bridge)与浏览器端(输入转发)使用,不依赖任何运行时 API。
 * 消息字节布局与 scrcpy 4.x(app/src/control_msg.c、server ControlMessage.java)逐一核对。
 */

// ---------------------------------------------------------------------------
// 大端序写入/读取
// ---------------------------------------------------------------------------

export function write16be(view, offset, value) {
  view[offset] = (value >> 8) & 0xff;
  view[offset + 1] = value & 0xff;
}

export function write32be(view, offset, value) {
  view[offset] = (value >>> 24) & 0xff;
  view[offset + 1] = (value >>> 16) & 0xff;
  view[offset + 2] = (value >>> 8) & 0xff;
  view[offset + 3] = value & 0xff;
}

export function write64be(view, offset, value) {
  // value 为无符号 64 位整数(以 Number 或 BigInt 表示)
  let hi;
  let lo;
  if (typeof value === "bigint") {
    hi = Number(value >> 32n) >>> 0;
    lo = Number(value & 0xffffffffn) >>> 0;
  } else {
    hi = Math.floor(value / 0x100000000) >>> 0;
    lo = value >>> 0;
  }
  write32be(view, offset, hi);
  write32be(view, offset + 4, lo);
}

export function read16be(view, offset) {
  return ((view[offset] << 8) | view[offset + 1]) >>> 0;
}

export function read32be(view, offset) {
  return (
    ((view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3]) >>> 0
  );
}

export function read64be(view, offset) {
  const hi = read32be(view, offset);
  const lo = read32be(view, offset + 4);
  return hi * 0x100000000 + lo;
}

/** 无精度损失的 64 位大端读取(BigInt) */
export function read64beBig(view, offset) {
  const hi = BigInt(read32be(view, offset));
  const lo = BigInt(read32be(view, offset + 4));
  return (hi << 32n) | lo;
}

/** float [0,1] → unsigned 16-bit fixed point(f * 2^16,clamp 0xFFFF) */
export function floatToU16fp(f) {
  let u = Math.round(f * 0x10000);
  if (u >= 0xffff) u = 0xffff;
  if (u < 0) u = 0;
  return u;
}

/** float [-1,1] → signed 16-bit fixed point(f * 2^15,clamp ±0x7FFF) */
export function floatToI16fp(f) {
  let i = Math.round(f * 0x8000);
  if (i >= 0x7fff) i = 0x7fff;
  if (i <= -0x8000) i = -0x8000;
  return i;
}

/** 截断 UTF-8 字符串到不超过 maxBytes 字节,且不切断多字节字符 */
export function utf8TruncationIndex(str, maxBytes) {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length <= maxBytes) return bytes.length;
  let n = maxBytes;
  while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--; // 回退到字符起始字节
  return n;
}

// ---------------------------------------------------------------------------
// 控制消息类型(客户端 → 服务端),与 enum sc_control_msg_type 一致
// ---------------------------------------------------------------------------

export const CtrlMsgType = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
};

// ---------------------------------------------------------------------------
// 设备消息类型(服务端 → 客户端),与 DEVICE_MSG_TYPE_* 一致
// ---------------------------------------------------------------------------

export const DeviceMsgType = {
  CLIPBOARD: 0,
  ACK_CLIPBOARD: 1,
  UHID_OUTPUT: 2,
};

// ---------------------------------------------------------------------------
// 动作 / 元状态常量
// ---------------------------------------------------------------------------

export const KeyEventAction = { DOWN: 0, UP: 1, MULTI: 2 };

export const MetaState = {
  SHIFT_ON: 0x01,
  ALT_ON: 0x02,
  SYM_ON: 0x04,
  FUNCTION_ON: 0x08,
  ALT_LEFT_ON: 0x10,
  ALT_RIGHT_ON: 0x20,
  SHIFT_LEFT_ON: 0x40,
  SHIFT_RIGHT_ON: 0x80,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  CTRL_RIGHT_ON: 0x4000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x20000,
  META_RIGHT_ON: 0x40000,
  CAPS_LOCK_ON: 0x100000,
  NUM_LOCK_ON: 0x200000,
  SCROLL_LOCK_ON: 0x400000,
};

export const TouchAction = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  OUTSIDE: 4,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
  HOVER_MOVE: 7,
  SCROLL: 8,
  HOVER_ENTER: 9,
  HOVER_EXIT: 10,
  BTN_PRESS: 11,
  BTN_RELEASE: 12,
};

export const MotionButton = {
  PRIMARY: 1 << 0,
  SECONDARY: 1 << 1,
  TERTIARY: 1 << 2,
  BACK: 1 << 3,
  FORWARD: 1 << 4,
};

/** scrcpy 约定的特殊 pointerId(有符号 64 位按无符号传输) */
export const POINTER_ID_MOUSE = 0xffffffffffffffffn; // -1
export const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen; // -2
export const POINTER_ID_VIRTUAL_FINGER = 0xfffffffffffffffdn; // -3

// ---------------------------------------------------------------------------
// 常用 Android 键码(与 android/keycodes.h 一致)
// ---------------------------------------------------------------------------

export const KeyCode = {
  UNKNOWN: 0,
  SOFT_LEFT: 1,
  SOFT_RIGHT: 2,
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  NUM_0: 7,
  NUM_1: 8,
  NUM_2: 9,
  NUM_3: 10,
  NUM_4: 11,
  NUM_5: 12,
  NUM_6: 13,
  NUM_7: 14,
  NUM_8: 15,
  NUM_9: 16,
  STAR: 17,
  POUND: 18,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  CLEAR: 28,
  A: 29,
  B: 30,
  C: 31,
  D: 32,
  E: 33,
  F: 34,
  G: 35,
  H: 36,
  I: 37,
  J: 38,
  K: 39,
  L: 40,
  M: 41,
  N: 42,
  O: 43,
  P: 44,
  Q: 45,
  R: 46,
  S: 47,
  T: 48,
  U: 49,
  V: 50,
  W: 51,
  X: 52,
  Y: 53,
  Z: 54,
  COMMA: 55,
  PERIOD: 56,
  ALT_LEFT: 57,
  ALT_RIGHT: 58,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  TAB: 61,
  SPACE: 62,
  SYM: 63,
  EXPLORER: 64,
  ENVELOPE: 65,
  ENTER: 66,
  DEL: 67,
  GRAVE: 68,
  MINUS: 69,
  EQUALS: 70,
  LEFT_BRACKET: 71,
  RIGHT_BRACKET: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  APOSTROPHE: 75,
  SLASH: 76,
  AT: 77,
  NUM: 78,
  HEADSETHOOK: 79,
  FOCUS: 80,
  PLUS: 81,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89,
  MEDIA_FAST_FORWARD: 90,
  MUTE: 91,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  PICTSYMBOLS: 94,
  SWITCH_CHARSET: 95,
  BUTTON_A: 96,
  BUTTON_B: 97,
  BUTTON_C: 98,
  BUTTON_X: 99,
  BUTTON_Y: 100,
  BUTTON_Z: 101,
  BUTTON_L1: 102,
  BUTTON_R1: 103,
  BUTTON_L2: 104,
  BUTTON_R2: 105,
  BUTTON_THUMBL: 106,
  BUTTON_THUMBR: 107,
  BUTTON_START: 108,
  BUTTON_SELECT: 109,
  BUTTON_MODE: 110,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  CAPS_LOCK: 115,
  SCROLL_LOCK: 116,
  META_LEFT: 117,
  META_RIGHT: 118,
  FUNCTION: 119,
  SYSRQ: 120,
  BREAK: 121,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  FORWARD: 125,
  MEDIA_PLAY: 126,
  MEDIA_PAUSE: 127,
  MEDIA_CLOSE: 128,
  MEDIA_EJECT: 129,
  MEDIA_RECORD: 130,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
  NUM_LOCK: 143,
  NUMPAD_0: 144,
  NUMPAD_1: 145,
  NUMPAD_2: 146,
  NUMPAD_3: 147,
  NUMPAD_4: 148,
  NUMPAD_5: 149,
  NUMPAD_6: 150,
  NUMPAD_7: 151,
  NUMPAD_8: 152,
  NUMPAD_9: 153,
  NUMPAD_DIVIDE: 154,
  NUMPAD_MULTIPLY: 155,
  NUMPAD_SUBTRACT: 156,
  NUMPAD_ADD: 157,
  NUMPAD_DOT: 158,
  NUMPAD_COMMA: 159,
  NUMPAD_ENTER: 160,
  NUMPAD_EQUALS: 161,
  NUMPAD_LEFT_PAREN: 162,
  NUMPAD_RIGHT_PAREN: 163,
  VOLUME_MUTE: 164,
  INFO: 165,
  CHANNEL_UP: 166,
  CHANNEL_DOWN: 167,
  ZOOM_IN: 168,
  ZOOM_OUT: 169,
  TV: 170,
  WINDOW: 171,
  GUIDE: 172,
  DVR: 173,
  BOOKMARK: 174,
  CAPTIONS: 175,
  SETTINGS: 176,
  APP_SWITCH: 187,
  LANGUAGE_SWITCH: 204,
  ASSIST: 219,
  BRIGHTNESS_DOWN: 220,
  BRIGHTNESS_UP: 221,
  MEDIA_AUDIO_TRACK: 222,
  SLEEP: 223,
  WAKEUP: 224,
};

// ---------------------------------------------------------------------------
// 消息编码(均返回新的 Uint8Array)
// ---------------------------------------------------------------------------

/**
 * 注入按键事件。返回 14 字节消息(与 scrcpy 4.x control_msg.c 序列化一致):
 *   [type 1B][action 1B][keycode 4B BE][repeat 4B BE][metastate 4B BE]
 * @param {number} action KeyEventAction
 * @param {number} keycode KeyCode
 * @param {number} repeat 重复次数,通常 0
 * @param {number} metastate MetaState 位掩码
 */
export function encodeInjectKeycode(action, keycode, repeat = 0, metastate = 0) {
  const buf = new Uint8Array(14);
  buf[0] = CtrlMsgType.INJECT_KEYCODE;
  buf[1] = action;
  write32be(buf, 2, keycode);
  write32be(buf, 6, repeat);
  write32be(buf, 10, metastate);
  return buf;
}

/**
 * 注入文本(通过 KeyCharacterMap)。文本按 UTF-8 截断到 300 字节。
 */
export function encodeInjectText(text) {
  const bytes = new TextEncoder().encode(text);
  const len = Math.min(bytes.length, 300);
  const cut = utf8TruncationIndex(text, len);
  const buf = new Uint8Array(1 + 4 + cut);
  buf[0] = CtrlMsgType.INJECT_TEXT;
  write32be(buf, 1, cut);
  buf.set(new TextEncoder().encode(text).subarray(0, cut), 5);
  return buf;
}

function writePosition(buf, offset, x, y, screenW, screenH) {
  write32be(buf, offset, x);
  write32be(buf, offset + 4, y);
  write16be(buf, offset + 8, screenW);
  write16be(buf, offset + 10, screenH);
}

/**
 * 注入触摸/鼠标事件。返回 32 字节消息。
 * position 为设备像素坐标,screenW/screenH 为设备屏幕尺寸。
 * @param {number} action TouchAction
 * @param {bigint|number} pointerId
 * @param {number} x
 * @param {number} y
 * @param {number} screenW
 * @param {number} screenH
 * @param {number} pressure 0..1
 * @param {number} actionButton MotionButton 位掩码
 * @param {number} buttons MotionButton 位掩码
 */
export function encodeTouchEvent(action, pointerId, x, y, screenW, screenH, pressure = 1, actionButton = 0, buttons = 0) {
  const buf = new Uint8Array(32);
  buf[0] = CtrlMsgType.INJECT_TOUCH_EVENT;
  buf[1] = action;
  write64be(buf, 2, pointerId);
  writePosition(buf, 10, x, y, screenW, screenH);
  write16be(buf, 22, floatToU16fp(pressure));
  write32be(buf, 24, actionButton);
  write32be(buf, 28, buttons);
  return buf;
}

/**
 * 注入滚动事件。返回 21 字节消息。
 * hscroll/vscroll 约定取值范围 [-16,16],内部先除以 16 再转为 16 位定点。
 */
export function encodeScrollEvent(x, y, screenW, screenH, hscroll, vscroll, buttons = 0) {
  const buf = new Uint8Array(21);
  buf[0] = CtrlMsgType.INJECT_SCROLL_EVENT;
  writePosition(buf, 1, x, y, screenW, screenH);
  const h = Math.max(-1, Math.min(1, hscroll / 16));
  const v = Math.max(-1, Math.min(1, vscroll / 16));
  write16be(buf, 13, floatToI16fp(h) & 0xffff);
  write16be(buf, 15, floatToI16fp(v) & 0xffff);
  write32be(buf, 17, buttons);
  return buf;
}

/** 返回键或点亮屏幕(action 仅 DOWN 有点亮效果)。返回 2 字节。 */
export function encodeBackOrScreenOn(action = KeyEventAction.DOWN) {
  const buf = new Uint8Array(2);
  buf[0] = CtrlMsgType.BACK_OR_SCREEN_ON;
  buf[1] = action;
  return buf;
}

/** 请求设备剪贴板内容。返回 2 字节(scrcpy 4.x:copyKey 为 1 字节)。copyKey: 0=none, 1=copy, 2=cut */
export function encodeGetClipboard(copyKey = 0) {
  const buf = new Uint8Array(2);
  buf[0] = CtrlMsgType.GET_CLIPBOARD;
  buf[1] = copyKey;
  return buf;
}

/** 设置设备剪贴板。 */
export function encodeSetClipboard(sequence, text, paste = false) {
  const bytes = new TextEncoder().encode(text);
  const maxLen = (1 << 18) - 14; // SC_CONTROL_MSG_CLIPBOARD_TEXT_MAX_LENGTH
  const cut = Math.min(bytes.length, maxLen);
  const buf = new Uint8Array(1 + 8 + 1 + 4 + cut);
  buf[0] = CtrlMsgType.SET_CLIPBOARD;
  write64be(buf, 1, sequence);
  buf[9] = paste ? 1 : 0;
  write32be(buf, 10, cut);
  buf.set(bytes.subarray(0, cut), 14);
  return buf;
}

/** 开关屏幕电源。返回 2 字节。 */
export function encodeSetDisplayPower(on) {
  const buf = new Uint8Array(2);
  buf[0] = CtrlMsgType.SET_DISPLAY_POWER;
  buf[1] = on ? 1 : 0;
  return buf;
}

/** 请求设备旋转(顺时针 90°)。返回 1 字节。 */
export function encodeRotateDevice() {
  return new Uint8Array([CtrlMsgType.ROTATE_DEVICE]);
}

/** 展开通知栏。 */
export function encodeExpandNotificationPanel() {
  return new Uint8Array([CtrlMsgType.EXPAND_NOTIFICATION_PANEL]);
}

/** 展开快捷设置。 */
export function encodeExpandSettingsPanel() {
  return new Uint8Array([CtrlMsgType.EXPAND_SETTINGS_PANEL]);
}

/** 收起通知栏/快捷设置。 */
export function encodeCollapsePanels() {
  return new Uint8Array([CtrlMsgType.COLLAPSE_PANELS]);
}

/** 重置视频流(重开编码器,使用启动时的参数)。返回 1 字节。 */
export function encodeResetVideo() {
  return new Uint8Array([CtrlMsgType.RESET_VIDEO]);
}

/** 启动应用(name 为包名或组件名,≤255 字节)。scrcpy 4.x:1 字节长度前缀。 */
export function encodeStartApp(name) {
  const bytes = new TextEncoder().encode(name);
  const cut = Math.min(bytes.length, 255);
  const buf = new Uint8Array(1 + 1 + cut);
  buf[0] = CtrlMsgType.START_APP;
  buf[1] = cut;
  buf.set(bytes.subarray(0, cut), 2);
  return buf;
}

/** 调整虚拟显示器尺寸(仅虚拟显示器)。返回 5 字节。 */
export function encodeResizeDisplay(width, height) {
  const buf = new Uint8Array(5);
  buf[0] = CtrlMsgType.RESIZE_DISPLAY;
  write16be(buf, 1, width);
  write16be(buf, 3, height);
  return buf;
}

// ---------------------------------------------------------------------------
// 设备消息解码(服务端 → 客户端)
// ---------------------------------------------------------------------------

/**
 * 解析一条设备消息。返回 { type, consumed, ... } 或 null(数据不足)。
 * 未知类型返回 { type: -1, consumed: 1 }。
 */
export function decodeDeviceMessage(view, offset, length) {
  if (length < 1) return null;
  const type = view[offset];
  switch (type) {
    case DeviceMsgType.CLIPBOARD: {
      if (length < 5) return null;
      const textLen = read32be(view, offset + 1);
      if (length < 5 + textLen) return null;
      const text = new TextDecoder().decode(view.subarray(offset + 5, offset + 5 + textLen));
      return { type, consumed: 5 + textLen, text };
    }
    case DeviceMsgType.ACK_CLIPBOARD: {
      if (length < 9) return null;
      return { type, consumed: 9, sequence: read64be(view, offset + 1) };
    }
    case DeviceMsgType.UHID_OUTPUT: {
      if (length < 5) return null;
      const id = read16be(view, offset + 1);
      const size = read16be(view, offset + 3);
      if (length < 5 + size) return null;
      return { type, consumed: 5 + size, id, size, data: view.slice(offset + 5, offset + 5 + size) };
    }
    default:
      return { type: -1, consumed: 1 };
  }
}

// ---------------------------------------------------------------------------
// 码率档位(需求:标准档位 + 自定义)
// ---------------------------------------------------------------------------

export const BITRATE_PRESETS = [
  { label: "1 Mbps", value: 1_000_000 },
  { label: "2 Mbps", value: 2_000_000 },
  { label: "4 Mbps", value: 4_000_000 },
  { label: "8 Mbps", value: 8_000_000 },
];

export const DEFAULT_BITRATE = 2_000_000;

// ---------------------------------------------------------------------------
// 支持的视频编码(scrcpy 服务器可选的 video_codec)
// ---------------------------------------------------------------------------

export const CODECS = [
  { id: "h264", label: "H.264 (AVC)", scrcpyName: "h264", browserCodec: "avc1", note: "兼容性最好,低延迟" },
  { id: "h265", label: "H.265 (HEVC)", scrcpyName: "h265", browserCodec: "hvc1", note: "同等码率画质更好,需设备与浏览器都支持" },
  { id: "av1", label: "AV1", scrcpyName: "av1", browserCodec: "av01", note: "压缩率高,需设备编码器与浏览器支持" },
];

export function codecById(id) {
  return CODECS.find((c) => c.id === id) || null;
}

// ---------------------------------------------------------------------------
// 分辨率 / 帧率档位
// ---------------------------------------------------------------------------

export const MAX_SIZE_PRESETS = [
  { label: "原始分辨率", value: 0 },
  { label: "1920 (1080p)", value: 1920 },
  { label: "1280 (720p)", value: 1280 },
  { label: "854 (480p)", value: 854 },
];

export const FPS_PRESETS = [
  { label: "不限制", value: 0 },
  { label: "60", value: 60 },
  { label: "30", value: 30 },
  { label: "15", value: 15 },
];
