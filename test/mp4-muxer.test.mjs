/**
 * test/mp4-muxer.test.mjs — MP4 封装器测试。
 * 用 ffmpeg 生成真实的 H.264 / H.265 Annex-B 测试流,切分为帧后喂给
 * Mp4Recorder,再用 ffprobe 校验输出文件的编码、分辨率、时长与帧数。
 * 需要系统安装 ffmpeg / ffprobe。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mp4Recorder, parseHevcDimensions } from "../shared/mp4-muxer.mjs";
import { splitAnnexB, hevcNalType } from "../shared/nal.js";

const H264_VCL = new Set([1, 2, 3, 4, 5]);
const H265_VCL = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);

function ffmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 生成指定编码的 Annex-B 测试流 */
function generateAnnexB(codec, width, height, seconds) {
  const file = path.join(os.tmpdir(), `test-${codec}-${Date.now()}.${codec === "h264" ? "h264" : "h265"}`);
  const args = [
    "-y", "-f", "lavfi",
    "-i", `testsrc=duration=${seconds}:size=${width}x${height}:rate=10`,
    "-c:v", codec === "h264" ? "libx264" : "libx265",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-x264-params", "keyint=30:min-keyint=30",
    "-x265-params", "keyint=30:min-keyint=30",
    "-f", codec === "h264" ? "h264" : "hevc",
    file,
  ];
  execFileSync("ffmpeg", args, { stdio: "ignore" });
  const data = fs.readFileSync(file);
  fs.unlinkSync(file);
  return data;
}

/**
 * 把 Annex-B 码流按 Access Unit 切帧:VCL NAL 开始新的一帧,
 * 前置的参数集/SEI 归入后续第一帧。
 */
function splitIntoFrames(data, isHevc) {
  const nals = splitAnnexB(data);
  const frames = [];
  let cur = [];
  let hasVcl = false;
  for (const nal of nals) {
    const type = isHevc ? hevcNalType(nal.data) : nal.nalType;
    const isVcl = isHevc ? H265_VCL.has(type) : H264_VCL.has(type);
    if (isVcl && hasVcl) {
      frames.push(cur);
      cur = [];
      hasVcl = false;
    }
    cur.push(nal);
    if (isVcl) hasVcl = true;
  }
  if (cur.length) frames.push(cur);
  // 每帧重新拼成 Annex-B(4 字节 start code)
  return frames.map((nals) => {
    const parts = [];
    for (const nal of nals) {
      parts.push(Buffer.from([0, 0, 0, 1]));
      parts.push(Buffer.from(nal.data.buffer, nal.data.byteOffset, nal.data.length));
    }
    return Buffer.concat(parts);
  });
}

function probeMp4(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_name,width,height,nb_frames",
    "-show_entries", "format=duration,size",
    "-of", "json",
    file,
  ]).toString();
  return JSON.parse(out);
}

function runMuxTest(codec, width, height) {
  const raw = generateAnnexB(codec, width, height, 2);
  const isHevc = codec === "h265";
  const frames = splitIntoFrames(raw, isHevc);
  assert.ok(frames.length >= 15, `应切出约 20 帧,实际 ${frames.length}`);

  const rec = new Mp4Recorder({ codec });
  // 第一帧(关键帧)内含参数集,其余帧直接喂
  frames.forEach((f, i) => {
    rec.addFrame(f, { pts: i * 100_000, isKey: i === 0 || i % 30 === 0 });
  });
  assert.ok(rec.sps, "应提取到 SPS");
  assert.ok(rec.pps, "应提取到 PPS");

  const mp4 = rec.finish();
  assert.ok(mp4.length > 1000, "MP4 应有内容");

  const file = path.join(os.tmpdir(), `mux-test-${codec}-${Date.now()}.mp4`);
  fs.writeFileSync(file, mp4);
  const info = probeMp4(file);
  fs.unlinkSync(file);

  const stream = info.streams[0];
  assert.equal(stream.codec_name, codec === "h264" ? "h264" : "hevc");
  assert.equal(stream.width, width);
  assert.equal(stream.height, height);
  const nbFrames = Number(stream.nb_frames || 0);
  assert.ok(Math.abs(nbFrames - frames.length) <= 2, `帧数应约等于 ${frames.length},实际 ${nbFrames}`);
  const duration = Number(info.format.duration);
  assert.ok(duration > 1.5 && duration < 3, `时长应约 2 秒,实际 ${duration}`);
  return { frames: nbFrames, duration };
}

test("H.264 流封装为 MP4(320x240)", { skip: !ffmpegAvailable() }, () => {
  runMuxTest("h264", 320, 240);
});

test("H.265 流封装为 MP4(320x240)", { skip: !ffmpegAvailable() }, () => {
  runMuxTest("h265", 320, 240);
});

test("H.265 SPS 宽高解析", () => {
  if (!ffmpegAvailable()) return;
  const raw = generateAnnexB("h265", 640, 360, 1);
  const nals = splitAnnexB(raw);
  const sps = nals.find((n) => hevcNalType(n.data) === 33);
  assert.ok(sps, "应有 SPS");
  const d = parseHevcDimensions(sps.data);
  assert.ok(d, "宽高应可解析");
  assert.equal(d.width, 640);
  assert.equal(d.height, 360);
});

test("无参数集时 finish 抛错", () => {
  const rec = new Mp4Recorder({ codec: "h264" });
  rec.addFrame(Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]), { pts: 0, isKey: true });
  assert.throws(() => rec.finish(), /缺少视频参数集/);
});

test("未知编码抛错", () => {
  assert.throws(() => new Mp4Recorder({ codec: "av1" }), /不支持的录制编码/);
});

// ---------------------------------------------------------------------------
// WebCodecs AVCC 转换(Annex-B → 长度前缀)
// ---------------------------------------------------------------------------

/** 复刻 webcodecs.js 的 annexBToAvcc(含 isAnnexB 检测,保持与实现一致) */
function isAnnexBLocal(data) {
  return (
    data.length >= 4 &&
    data[0] === 0 &&
    data[1] === 0 &&
    (data[2] === 1 || (data[2] === 0 && data[3] === 1))
  );
}
function annexBToAvccLocal(data) {
  if (!isAnnexBLocal(data)) return data;
  const nals = splitAnnexB(data);
  let total = 0;
  for (const n of nals) total += 4 + n.data.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    new DataView(out.buffer).setUint32(o, n.data.length, false);
    out.set(n.data, o + 4);
    o += 4 + n.data.length;
  }
  return out;
}

/** 按 AVCC 长度前缀拆分,验证与 Annex-B 拆分结果一致 */
function splitAvcc(data) {
  const nals = [];
  let o = 0;
  while (o + 4 <= data.length) {
    const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(o, false);
    o += 4;
    if (o + len > data.length) throw new Error("AVCC 数据损坏");
    nals.push(data.subarray(o, o + len));
    o += len;
  }
  return nals;
}

test("4 字节 start code 的单 NAL 帧必须被转换(修复误判)", () => {
  // 构造:00 00 00 01 + 单个 P 帧 NAL(nalType 1)
  const nal = new Uint8Array([0x41, 0x9a, 0x22, 0x01, 0x02, 0x03, 0x04]);
  const annexB = new Uint8Array(4 + nal.length);
  annexB.set([0, 0, 0, 1], 0);
  annexB.set(nal, 4);
  const avcc = annexBToAvccLocal(annexB);
  // 必须是长度前缀格式:前 4 字节 = 长度,且不等于原始数据
  assert.notDeepEqual(Buffer.from(avcc), Buffer.from(annexB), "必须转换,不能原样返回");
  assert.equal(new DataView(avcc.buffer).getUint32(0, false), nal.length, "长度前缀正确");
  assert.deepEqual(Buffer.from(avcc.subarray(4)), Buffer.from(nal), "NAL 内容一致");
});

test("已是 AVCC 格式的数据不做二次转换", () => {
  const avcc = new Uint8Array([0, 0, 0, 4, 0x41, 0x9a, 0x22, 0x01]);
  assert.equal(annexBToAvccLocal(avcc), avcc, "AVCC 数据原样返回");
});

test("Annex-B → AVCC 转换正确(与原始 NAL 一致)", { skip: !ffmpegAvailable() }, () => {
  const raw = generateAnnexB("h264", 320, 240, 1);
  const avcc = annexBToAvccLocal(raw);
  const annexBnals = splitAnnexB(raw);
  const avccNals = splitAvcc(avcc);
  assert.equal(avccNals.length, annexBnals.length, "NAL 数量一致");
  for (let i = 0; i < annexBnals.length; i++) {
    const a = Buffer.from(annexBnals[i].data.buffer, annexBnals[i].data.byteOffset, annexBnals[i].data.length);
    const b = Buffer.from(avccNals[i].buffer, avccNals[i].byteOffset, avccNals[i].length);
    assert.deepEqual(b, a, `NAL #${i} 内容一致`);
  }
});
