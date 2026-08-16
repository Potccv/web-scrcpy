/**
 * test/nal.test.mjs — H.264 SPS 解析测试(合成码流)与 Annex-B 拆分。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpsH264, buildAvcc, splitAnnexB, parseSpsH265 } from "../shared/nal.js";

// 极简位写入器(仅用于测试构造 SPS)
class BitWriter {
  constructor() {
    this.bits = [];
  }
  w(v, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1);
  }
  /** 无符号 Exp-Golomb */
  ue(v) {
    const codeNum = v + 1;
    const zeros = 31 - Math.clz32(codeNum);
    this.w(0, zeros);
    this.w(1, 1);
    this.w(codeNum - (1 << zeros), zeros);
  }
  toBytes() {
    while (this.bits.length % 8) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    }
    return out;
  }
}

/** 构造 SPS(不裁剪、无 VUI);high profile 附带 chroma 字段 */
function makeSps(widthMb, heightMb, profileIdc, levelIdc) {
  const w = new BitWriter();
  w.w(0x67, 8); // NAL 头:type 7
  w.w(profileIdc, 8);
  w.w(0x00, 8); // constraint 字节
  w.w(levelIdc, 8);
  w.ue(0); // seq_parameter_set_id
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    w.ue(1); // chroma_format_idc = 1 (4:2:0)
    w.ue(0); // bit_depth_luma_minus8
    w.ue(0); // bit_depth_chroma_minus8
    w.w(0, 1); // qpprime_y_zero_transform_bypass_flag
    w.w(0, 1); // seq_scaling_matrix_present_flag
  }
  w.ue(0); // log2_max_frame_num_minus4
  w.ue(0); // pic_order_cnt_type
  w.ue(0); // log2_max_pic_order_cnt_lsb_minus4
  w.ue(1); // max_num_ref_frames
  w.w(0, 1); // gaps_in_frame_num_value_allowed_flag
  w.ue(widthMb - 1); // pic_width_in_mbs_minus1
  w.ue(heightMb - 1); // pic_height_in_map_units_minus1
  w.w(1, 1); // frame_mbs_only_flag
  w.w(1, 1); // direct_8x8_inference_flag
  w.w(0, 1); // frame_cropping_flag
  w.w(0, 1); // vui_parameters_present_flag
  return w.toBytes();
}

test("解析合成 SPS(1280x720 baseline 3.1)", () => {
  const sps = makeSps(80, 45, 0x42, 0x1f); // 1280/16=80, 720/16=45
  const info = parseSpsH264(sps);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.equal(info.profileIdc, 0x42);
  assert.equal(info.levelIdc, 0x1f);
  assert.equal(info.codec, "avc1.42001F");
});

test("解析合成 SPS(1920x1080 high 4.1)", () => {
  const sps = makeSps(120, 68, 0x64, 0x29); // 1080/16=67.5 → 68 map units
  const info = parseSpsH264(sps);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1088); // 68*16
  assert.equal(info.codec, "avc1.640029");
});

test("buildAvcc 结构", () => {
  const sps = makeSps(80, 45, 0x42, 0x1f);
  const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
  const avcc = buildAvcc(sps, pps);
  assert.equal(avcc[0], 1); // configurationVersion
  assert.equal(avcc[1], 0x42); // profile
  assert.equal(avcc[2], 0x00); // constraint
  assert.equal(avcc[3], 0x1f); // level
  assert.equal(avcc[4], 0xff); // lengthSizeMinusOne=3
  assert.equal(avcc[5], 0xe1); // 1 个 SPS
  const spsLen = (avcc[6] << 8) | avcc[7];
  assert.equal(spsLen, sps.length);
  assert.deepEqual(Array.from(avcc.slice(8, 8 + sps.length)), Array.from(sps));
  assert.equal(avcc[8 + sps.length], 1); // 1 个 PPS
});

test("Annex-B 拆分(4 字节与 3 字节起始码)", () => {
  const sps = makeSps(80, 45, 0x42, 0x1f);
  const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
  const idr = new Uint8Array([0x65, 1, 2, 3, 4]);
  const stream = new Uint8Array([
    ...new Uint8Array([0, 0, 0, 1]),
    ...sps,
    ...new Uint8Array([0, 0, 1]),
    ...pps,
    ...new Uint8Array([0, 0, 0, 1]),
    ...idr,
    ...new Uint8Array([0, 0, 1]),
    ...new Uint8Array([0x09, 0xf0]), // AUD
  ]);
  const nals = splitAnnexB(stream);
  assert.equal(nals.length, 4);
  assert.deepEqual([nals[0].nalType, nals[1].nalType, nals[2].nalType, nals[3].nalType], [7, 8, 5, 9]);
  assert.deepEqual(Array.from(nals[2].data), Array.from(idr));
});

test("H.265 非法输入不崩溃", () => {
  assert.throws(() => parseSpsH265(new Uint8Array([0x01, 0x02, 0x03])));
});
