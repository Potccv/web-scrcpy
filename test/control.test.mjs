/**
 * test/control.test.mjs — 控制消息编码的字节级测试。
 * 期望值与 scrcpy 4.x app/src/control_msg.c 的序列化逻辑逐字节核对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeInjectKeycode,
  encodeInjectText,
  encodeTouchEvent,
  encodeScrollEvent,
  encodeBackOrScreenOn,
  encodeGetClipboard,
  encodeSetClipboard,
  encodeSetDisplayPower,
  encodeRotateDevice,
  encodeExpandNotificationPanel,
  encodeExpandSettingsPanel,
  encodeCollapsePanels,
  encodeStartApp,
  encodeResizeDisplay,
  decodeDeviceMessage,
  KeyEventAction,
  TouchAction,
  MotionButton,
  KeyCode,
  utf8TruncationIndex,
} from "../shared/protocol.js";

test("injectKeycode 编码", () => {
  // [type=0][action=0][keycode=4 BACK][repeat=0][meta=0]
  const buf = encodeInjectKeycode(KeyEventAction.DOWN, KeyCode.BACK, 0, 0);
  assert.equal(buf.length, 14);
  assert.deepEqual(Array.from(buf), [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("injectKeycode 带 meta", () => {
  // Ctrl+Shift+C: meta = CTRL_ON|SHIFT_ON = 0x1001
  const buf = encodeInjectKeycode(KeyEventAction.DOWN, KeyCode.C, 0, 0x1001);
  assert.deepEqual(Array.from(buf.slice(10, 14)), [0, 0, 0x10, 0x01]);
});

test("injectText 编码", () => {
  const buf = encodeInjectText("hello");
  assert.equal(buf.length, 1 + 4 + 5);
  assert.deepEqual(Array.from(buf), [1, 0, 0, 0, 5, 104, 101, 108, 108, 111]);
});

test("injectText 中文 UTF-8", () => {
  const buf = encodeInjectText("你好");
  assert.equal(buf[0], 1);
  const len = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
  assert.equal(len, 6); // 每个汉字 3 字节
  assert.deepEqual(Array.from(buf.slice(5)), [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
});

test("utf8TruncationIndex 不切断多字节字符", () => {
  const s = "你a好b";
  const bytes = new TextEncoder().encode(s);
  const idx = utf8TruncationIndex(s, 4); // 4 字节:你(3)+a(1)
  assert.equal(idx, 4);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, idx)), "你a");
});

test("touchEvent 编码(鼠标,pointerId=-1)", () => {
  const buf = encodeTouchEvent(
    TouchAction.DOWN,
    0xffffffffffffffffn, // POINTER_ID_MOUSE
    100,
    200,
    1080,
    1920,
    1,
    MotionButton.PRIMARY,
    MotionButton.PRIMARY
  );
  assert.equal(buf.length, 32);
  const expected = [
    2, 0, // type, action
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // pointerId -1
    0, 0, 0, 100, // x
    0, 0, 0, 200, // y
    0x04, 0x38, // screenW 1080
    0x07, 0x80, // screenH 1920
    0xff, 0xff, // pressure u16fp(1.0)
    0, 0, 0, 1, // actionButton PRIMARY
    0, 0, 0, 1, // buttons PRIMARY
  ];
  assert.deepEqual(Array.from(buf), expected);
});

test("touchEvent 压力转换", () => {
  const buf = encodeTouchEvent(TouchAction.UP, 1n, 0, 0, 100, 100, 0, 0, 0);
  assert.equal(buf[22], 0);
  assert.equal(buf[23], 0);
});

test("scrollEvent 编码", () => {
  // 布局:hscroll 在 13-14,vscroll 在 15-16;协议先除以 16 再转 i16fp
  const buf = encodeScrollEvent(50, 60, 1080, 1920, 0, -16, 0);
  assert.equal(buf.length, 21);
  assert.equal(buf[0], 3);
  assert.deepEqual(Array.from(buf.slice(15, 17)), [0x80, 0x00]); // vscroll=-16 → -1
  // hscroll=16 → +1 → 0x7FFF
  const buf2 = encodeScrollEvent(50, 60, 1080, 1920, 16, 0, 0);
  assert.deepEqual(Array.from(buf2.slice(13, 15)), [0x7f, 0xff]);
  // hscroll=1 → 1/16 → 2048
  const buf3 = encodeScrollEvent(50, 60, 1080, 1920, 1, 0, 0);
  assert.deepEqual(Array.from(buf3.slice(13, 15)), [0x08, 0x00]);
});

test("backOrScreenOn / 各类单字节消息", () => {
  assert.deepEqual(Array.from(encodeBackOrScreenOn(0)), [4, 0]);
  assert.deepEqual(Array.from(encodeRotateDevice()), [11]);
  assert.deepEqual(Array.from(encodeExpandNotificationPanel()), [5]);
  assert.deepEqual(Array.from(encodeExpandSettingsPanel()), [6]);
  assert.deepEqual(Array.from(encodeCollapsePanels()), [7]);
  assert.deepEqual(Array.from(encodeSetDisplayPower(true)), [10, 1]);
  assert.deepEqual(Array.from(encodeGetClipboard(1)), [8, 1]);
});

test("setClipboard 编码", () => {
  const buf = encodeSetClipboard(1n, "abc", true);
  // [9][sequence 8B BE=1][paste=1][len=3]"abc"
  assert.deepEqual(Array.from(buf), [
    9, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 3, 97, 98, 99,
  ]);
});

test("startApp 编码", () => {
  const name = "com.android.settings";
  const buf = encodeStartApp(name);
  assert.equal(buf[0], 16);
  assert.equal(buf[1], name.length);
  assert.equal(new TextDecoder().decode(buf.slice(2)), name);
});

test("resizeDisplay 编码", () => {
  assert.deepEqual(Array.from(encodeResizeDisplay(800, 600)), [21, 0x03, 0x20, 0x02, 0x58]);
});

test("设备消息解码:CLIPBOARD", () => {
  const msg = decodeDeviceMessage(new Uint8Array([0, 0, 0, 0, 2, 104, 105]), 0, 7);
  assert.equal(msg.type, 0);
  assert.equal(msg.consumed, 7);
  assert.equal(msg.text, "hi");
});

test("设备消息解码:ACK_CLIPBOARD", () => {
  const msg = decodeDeviceMessage(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 42]), 0, 9);
  assert.equal(msg.type, 1);
  assert.equal(msg.sequence, 42);
});

test("设备消息解码:数据不足返回 null", () => {
  assert.equal(decodeDeviceMessage(new Uint8Array([0, 0, 0, 0, 10]), 0, 5), null);
});
