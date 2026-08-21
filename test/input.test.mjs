import test from "node:test";
import assert from "node:assert/strict";

import { InputController } from "../public/js/input.js";

function makeController() {
  const sent = [];
  const controller = new InputController({
    getDeviceSize: () => ({ width: 1080, height: 1920 }),
    sendControl: (buf) => sent.push(new Uint8Array(buf)),
    isActive: () => true,
  });
  controller.canvas = {
    offsetWidth: 100,
    offsetHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  return { controller, sent };
}

function fakeWheelEvent({ deltaY, deltaX = 0 }) {
  return {
    clientX: 50,
    clientY: 60,
    deltaY,
    deltaX,
    preventDefault() {},
  };
}

test("滚轮向下(WheelEvent.deltaY>0)应编码为 Android 纵向负向滚动", () => {
  const { controller, sent } = makeController();
  // 16 格 * 100 = 1600,取整后 vscroll=-16 → 协议值 -1.0
  controller._onWheel(fakeWheelEvent({ deltaY: 1600 }));
  assert.equal(sent.length, 1);
  assert.deepEqual(Array.from(sent[0].slice(15, 17)), [0x80, 0x00]);
});

test("滚轮向上(WheelEvent.deltaY<0)应编码为 Android 纵向正向滚动", () => {
  const { controller, sent } = makeController();
  // -16 格 * 100 = -1600,取整后 vscroll=16 → 协议值 1.0
  controller._onWheel(fakeWheelEvent({ deltaY: -1600 }));
  assert.equal(sent.length, 1);
  assert.deepEqual(Array.from(sent[0].slice(15, 17)), [0x7f, 0xff]);
});

test("injectText 注入中文到安卓", () => {
  const { controller, sent } = makeController();
  controller.injectText("中文");
  assert.equal(sent.length, 1);
  const buf = sent[0];
  assert.equal(buf[0], 1); // INJECT_TEXT
  assert.equal(new TextDecoder().decode(buf.slice(5)), "中文");
});

test("createUhidKeyboard 发送 UHID_CREATE", () => {
  const { controller, sent } = makeController();
  controller.createUhidKeyboard();
  assert.equal(sent.length, 1);
  const buf = sent[0];
  assert.equal(buf[0], 12); // UHID_CREATE
  assert.deepEqual(Array.from(buf.slice(1, 3)), [0, 0]); // id=0
  const nameLen = buf[7];
  const descSize = (buf[8 + nameLen] << 8) | buf[9 + nameLen];
  assert.ok(descSize > 0, "应包含 HID 报告描述符");
});

test("destroyUhidKeyboard 发送 UHID_DESTROY", () => {
  const { controller, sent } = makeController();
  controller.createUhidKeyboard();
  controller.destroyUhidKeyboard();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0], 14); // UHID_DESTROY
});

test("pasteText 通过剪贴板+粘贴输入中文", () => {
  const { controller, sent } = makeController();
  controller.pasteText("中文");
  assert.equal(sent.length, 1);
  const buf = sent[0];
  assert.equal(buf[0], 9); // SET_CLIPBOARD
  assert.equal(buf[9], 1); // paste=true
  assert.equal(new TextDecoder().decode(buf.slice(14)), "中文");
});

test("电脑→安卓:发送 SET_CLIPBOARD(paste=true)", () => {
  const { controller, sent } = makeController();
  controller._sendClipboardToDevice("hello", true);
  assert.equal(sent.length, 1);
  const buf = sent[0];
  assert.equal(buf[0], 9); // SET_CLIPBOARD
  assert.equal(buf[9], 1); // paste=true
  assert.deepEqual(Array.from(buf.slice(1, 9)), [0, 0, 0, 0, 0, 0, 0, 1]); // sequence=1
  assert.equal(new TextDecoder().decode(buf.slice(14)), "hello");
});

test("Ctrl+V 将电脑剪贴板同步到安卓并触发粘贴", async () => {
  const { controller, sent } = makeController();
  const originalClipboard = navigator.clipboard;
  navigator.clipboard = { readText: async () => "pc-text" };
  try {
    const e = {
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      target: { tagName: "BODY" },
    };
    controller._onKeyDown(e);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(e.defaultPrevented, true);
    assert.equal(sent.length, 1);
    const buf = sent[0];
    assert.equal(buf[0], 9); // SET_CLIPBOARD
    assert.equal(buf[9], 1); // paste=true
    assert.equal(new TextDecoder().decode(buf.slice(14)), "pc-text");
  } finally {
    navigator.clipboard = originalClipboard;
  }
});
