/**
 * test/video-stream.test.mjs — 视频 socket 帧格式解析器测试。
 * 与 scrcpy 4.x Streamer.java / demuxer.c 的字节布局核对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoStreamParser, codecIdToString, PacketFlags } from "../shared/video-stream.js";

function packetHeader(ptsFlags, size) {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE(ptsFlags, 0);
  h.writeUInt32BE(size, 8);
  return h;
}

test("codec id 字符串", () => {
  assert.equal(codecIdToString(0x68323634), "h264");
  assert.equal(codecIdToString(0x68323635), "h265");
  assert.equal(codecIdToString(0x00617631), null); // AV1 已不支持
  assert.equal(codecIdToString(0x12345678), null);
});

test("完整流解析:codec id → session → 数据包", () => {
  const events = [];
  const parser = new VideoStreamParser({
    onCodecId: (c) => events.push(["codec", c]),
    onSession: (s) => events.push(["session", s]),
    onPacket: (p) => events.push(["packet", p.flags, p.pts, p.data.length]),
    onError: (e) => events.push(["error", e.message]),
  });

  const payload1 = Buffer.from("FRAMEDATA1");
  const payload2 = Buffer.from("CFGDATA");
  const stream = Buffer.concat([
    Buffer.from("h264", "ascii"), // codec id
    Buffer.from([0x80, 0, 0, 0]), // session flags
    Buffer.from([0, 0, 5, 0]), // width 1280
    Buffer.from([0, 0, 2, 0xd0]), // height 720
    packetHeader(1n << 61n, payload1.length), // key frame, pts=0
    payload1,
    packetHeader(1n << 62n, payload2.length), // config
    payload2,
  ]);
  parser.push(stream);

  assert.deepEqual(events, [
    ["codec", "h264"],
    ["session", { width: 1280, height: 720, clientResized: false }],
    ["packet", PacketFlags.KEY_FRAME, 0, payload1.length],
    ["packet", PacketFlags.CONFIG, 0, payload2.length],
  ]);
});

test("分片推送(跨 chunk 边界)", () => {
  const events = [];
  const parser = new VideoStreamParser({
    onCodecId: (c) => events.push(["codec", c]),
    onSession: () => events.push(["session"]),
    onPacket: (p) => events.push(["packet", p.data.length]),
  });
  const payload = Buffer.from("0123456789");
  const full = Buffer.concat([
    Buffer.from("h265", "ascii"),
    Buffer.from([0x80, 0, 0, 0, 0, 0, 1, 0xe0, 0, 0, 0, 0x2d]), // 480x800
    packetHeader(0n, payload.length),
    payload,
  ]);
  // 每次 3 字节地推送
  for (let i = 0; i < full.length; i += 3) {
    parser.push(full.subarray(i, i + 3));
  }
  assert.deepEqual(events, [
    ["codec", "h265"],
    ["session"],
    ["packet", payload.length],
  ]);
});

test("流中分辨率变化(session 头出现在数据包之间)", () => {
  const events = [];
  const parser = new VideoStreamParser({
    onCodecId: () => {},
    onSession: (s) => events.push(["session", s.width, s.height]),
    onPacket: (p) => events.push(["packet"]),
  });
  const a = Buffer.from("AAA");
  const b = Buffer.from("BBB");
  const stream = Buffer.concat([
    Buffer.from([0x00, 0x76, 0x70, 0x38]), // codec id "vp8"(\0vp8)
    Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0, 0x10]), // 32x16
    packetHeader(0n, a.length),
    a,
    Buffer.from([0x80, 0, 0, 1, 0, 0, 0, 0x40, 0, 0, 0, 0x20]), // 64x32, clientResized
    packetHeader(0n, b.length),
    b,
  ]);
  parser.push(stream);
  assert.deepEqual(events, [
    ["session", 32, 16],
    ["packet"],
    ["session", 64, 32],
    ["packet"],
  ]);
});

test("PTS 掩码", () => {
  const events = [];
  const parser = new VideoStreamParser({
    onCodecId: () => {},
    onSession: () => {},
    onPacket: (p) => events.push(p.pts),
  });
  const payload = Buffer.from("X");
  const pts = 123456789n;
  const withFlags = (pts & 0x1fffffffffffffffn) | (1n << 61n); // key frame + pts
  const stream = Buffer.concat([
    Buffer.from("h264", "ascii"),
    Buffer.from([0x80, 0, 0, 0, 0, 0, 0x01, 0x40, 0, 0, 0, 0x90]), // 320x400
    packetHeader(withFlags, payload.length),
    payload,
  ]);
  parser.push(stream);
  assert.equal(events[0], Number(pts));
});
