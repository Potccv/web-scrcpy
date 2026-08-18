/**
 * shared/nal.js — Annex-B 流拆分与视频参数集解析(H.264 SPS、H.265 SPS)。
 *
 * 这些解析用于:
 *   - 从 SPS/PPS 构建 WebCodecs 所需的 description(avcC / hvcC)与 codec 字符串
 *   - Broadway(自定义 JS 解码器)按 NAL 喂数据
 */

// ---------------------------------------------------------------------------
// 位读取器(MSB first,支持 ue(v)/se(v) Exp-Golomb)
// ---------------------------------------------------------------------------

export class BitReader {
  constructor(view, byteOffset = 0) {
    this.view = view;
    this.byteOffset = byteOffset;
    this.bitPos = 0;
  }

  readBits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byteIndex = this.byteOffset + (this.bitPos >> 3);
      const bitIndex = 7 - (this.bitPos & 7);
      const bit = (this.view[byteIndex] >> bitIndex) & 1;
      value = value * 2 + bit;
      this.bitPos++;
    }
    return value;
  }

  /** 无符号 Exp-Golomb */
  ue() {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros++;
      if (zeros > 30) throw new Error("Exp-Golomb 过长(码流可能损坏)");
    }
    return (1 << zeros) - 1 + (zeros ? this.readBits(zeros) : 0);
  }

  /** 有符号 Exp-Golomb */
  se() {
    const k = this.ue();
    return (k & 1) ? (k + 1) >> 1 : -(k >> 1);
  }
}

// ---------------------------------------------------------------------------
// Annex-B 拆分
// ---------------------------------------------------------------------------

/**
 * 把 Annex-B 码流拆成 NAL 单元列表。
 * @returns {Array<{nalType:number, data:Uint8Array}>} data 不含起始码,包含 NAL 头字节
 */
export function splitAnnexB(buffer) {
  const nals = [];
  const len = buffer.length;
  let i = 0;
  while (i < len - 2) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
      // 3 字节 [0,0,1] 与 4 字节 [0,0,0,1] 起始码,NAL 数据都从 i+3 开始
      const start = i + 3;
      // 找下一个起始码(越界比较返回 false,安全)
      let end = start;
      for (; end < len; end++) {
        if (buffer[end] === 0 && buffer[end + 1] === 0 && buffer[end + 2] === 1) break;
      }
      // 去掉尾部 trailing_zero_8bits
      let trimmed = end;
      while (trimmed > start && buffer[trimmed - 1] === 0) trimmed--;
      const data = buffer.subarray(start, trimmed);
      if (data.length) {
        nals.push({ nalType: data[0] & 0x1f, data });
      }
      i = end;
    } else {
      i++;
    }
  }
  return nals;
}

/** H.265 NAL 类型(nal_unit_type 为 6 位) */
export function hevcNalType(data) {
  return (data[0] >> 1) & 0x3f;
}

/** 去除 RBSP 的 emulation prevention bytes(0x000003 → 0x0000) */
export function removeEmulationPrevention(data) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// H.264 SPS 解析
// ---------------------------------------------------------------------------

const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * 解析 H.264 SPS(含 NAL 头字节),返回宽高、profile/level 与 avc1 codec 字符串。
 */
export function parseSpsH264(sps) {
  const r = new BitReader(sps);
  r.readBits(1); // forbidden_zero_bit
  r.readBits(2); // nal_ref_idc
  const nalType = r.readBits(5);
  if (nalType !== 7) throw new Error("不是 SPS NAL(type=" + nalType + ")");

  const profileIdc = r.readBits(8);
  const constraintByte = r.readBits(8);
  const levelIdc = r.readBits(8);

  r.ue(); // seq_parameter_set_id

  if (H264_HIGH_PROFILES.has(profileIdc)) {
    const chromaFormat = r.ue();
    if (chromaFormat === 3) r.readBits(1); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.readBits(1); // qpprime_y_zero_transform_bypass_flag
    if (r.readBits(1)) {
      // seq_scaling_matrix_present_flag
      const count = chromaFormat === 3 ? 12 : 8;
      for (let i = 0; i < count; i++) {
        if (r.readBits(1)) {
          const size = i < 6 ? 16 : 64;
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < size; j++) {
            if (nextScale !== 0) {
              const delta = r.se();
              nextScale = (lastScale + delta + 256) % 256;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.readBits(1); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const numRefFrames = r.ue();
    for (let i = 0; i < numRefFrames; i++) r.se();
  }

  r.ue(); // max_num_ref_frames
  r.readBits(1); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = r.ue();
  const picHeightInMapUnitsMinus1 = r.ue();
  const frameMbsOnlyFlag = r.readBits(1);
  if (!frameMbsOnlyFlag) r.readBits(1); // mb_adaptive_frame_field_flag
  r.readBits(1); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.readBits(1)) {
    // frame_cropping_flag
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  const cropUnitX = 1;
  const cropUnitY = 2 - frameMbsOnlyFlag;
  const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * cropUnitX * 2;
  const height =
    (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * cropUnitY * 2;

  const codec = "avc1." + hex2(profileIdc) + hex2(constraintByte) + hex2(levelIdc);
  return { profileIdc, constraintByte, levelIdc, width, height, codec };
}

/** 从 SPS/PPS 构建 avcC(AVCDecoderConfigurationRecord),供 WebCodecs description 使用 */
export function buildAvcc(sps, pps) {
  const spsInfo = parseSpsH264(sps);
  const spsArr = Array.isArray(sps) ? sps : [sps];
  const ppsArr = Array.isArray(pps) ? pps : [pps];
  let size = 7 + 1;
  for (const s of spsArr) size += 2 + s.length;
  size += 1;
  for (const p of ppsArr) size += 2 + p.length;
  const out = new Uint8Array(size);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = spsInfo.profileIdc;
  out[o++] = spsInfo.constraintByte;
  out[o++] = spsInfo.levelIdc;
  out[o++] = 0xff; // 0xFC | lengthSizeMinusOne(3)
  out[o++] = 0xe0 | spsArr.length;
  for (const s of spsArr) {
    out[o++] = (s.length >> 8) & 0xff;
    out[o++] = s.length & 0xff;
    out.set(s, o);
    o += s.length;
  }
  out[o++] = ppsArr.length;
  for (const p of ppsArr) {
    out[o++] = (p.length >> 8) & 0xff;
    out[o++] = p.length & 0xff;
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// H.265 SPS 解析(profile/tier/level)与 hvcC 构建
// ---------------------------------------------------------------------------

export function parseSpsH265(sps) {
  const type = (sps[0] >> 1) & 0x3f;
  if (type !== 33) throw new Error("不是 HEVC SPS NAL(type=" + type + ")");
  // SPS 的 RBSP 中含有 emulation prevention bytes(0x000003),必须先去除,
  // 否则 profile_tier_level 等字段会错位,导致 levelIdc=0 等错误 codec string。
  const rbsp = removeEmulationPrevention(sps.subarray(2));
  const r = new BitReader(rbsp, 0); // 已跳过 2 字节 NAL 头
  r.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.readBits(3);
  r.readBits(1); // sps_temporal_id_nesting_flag
  // profile_tier_level
  const profileSpace = r.readBits(2);
  const tierFlag = r.readBits(1);
  const profileIdc = r.readBits(5);
  const compatibilityFlags = r.readBits(32);
  const constraintFlags = r.readBits(48);
  const levelIdc = r.readBits(8);
  if (maxSubLayersMinus1 > 0) {
    r.readBits(2); // reserved
    for (let i = maxSubLayersMinus1; i < 8; i++) r.readBits(1);
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      r.readBits(2); // reserved
      r.readBits(2); // profile_present_flag, level_present_flag
      if (r.readBits(1)) r.readBits(88); // sub_layer_profile_space...constraint
      if (r.readBits(1)) r.readBits(8); // sub_layer_level_idc
    }
  }
  // 生成 WebCodecs 可识别的 HEVC codec string:
  //   hvc1.<profile_idc>.<profile_compatibility_flags>.<tier><level>.<constraint bytes>
  // 示例:hvc1.1.6.L93.B0
  const compatHex = compatibilityFlags.toString(16).toUpperCase();
  const c = BigInt(constraintFlags);
  const constraintBytes = [];
  for (let i = 5; i >= 0; i--) {
    constraintBytes.push(Number((c >> BigInt(i * 8)) & 0xffn));
  }
  // 去掉尾部全 0 的 constraint 字节,至少保留一个字节
  while (constraintBytes.length > 1 && constraintBytes[constraintBytes.length - 1] === 0) {
    constraintBytes.pop();
  }
  const constraintStr = constraintBytes
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(".");
  const codec =
    "hvc1." + profileIdc + "." + compatHex + "." + (tierFlag ? "H" : "L") + levelIdc + "." + constraintStr;

  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatibilityFlags,
    constraintFlags,
    levelIdc,
    codec,
  };
}

/**
 * 从 VPS/SPS/PPS NAL 构建 hvcC(HEVCDecoderConfigurationRecord)。
 */
export function buildHvcc(vps, sps, pps) {
  const spsInfo = parseSpsH265(sps);
  const arrays = [
    { type: 32, nals: Array.isArray(vps) ? vps : [vps] },
    { type: 33, nals: Array.isArray(sps) ? sps : [sps] },
    { type: 34, nals: Array.isArray(pps) ? pps : [pps] },
  ];
  let size = 23; // 22 字节固定头 + numOfArrays
  for (const arr of arrays) {
    size += 3; // array header + numNalus
    for (const nal of arr.nals) size += 2 + nal.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = ((spsInfo.profileSpace & 3) << 6) | ((spsInfo.tierFlag & 1) << 5) | (spsInfo.profileIdc & 0x1f);
  out[o++] = (spsInfo.compatibilityFlags >>> 24) & 0xff;
  out[o++] = (spsInfo.compatibilityFlags >>> 16) & 0xff;
  out[o++] = (spsInfo.compatibilityFlags >>> 8) & 0xff;
  out[o++] = spsInfo.compatibilityFlags & 0xff;
  const c = BigInt(spsInfo.constraintFlags);
  for (let i = 5; i >= 0; i--) {
    out[o++] = Number((c >> BigInt(i * 8)) & 0xffn);
  }
  out[o++] = spsInfo.levelIdc;
  out[o++] = 0xf0; // min_spatial_segmentation_idc = 0
  out[o++] = 0x00;
  out[o++] = 0xfc; // parallelismType = 0
  out[o++] = 0xfd; // chromaFormat = 1 (4:2:0)
  out[o++] = 0xf8; // bitDepthLumaMinus8 = 0
  out[o++] = 0xf8; // bitDepthChromaMinus8 = 0
  out[o++] = 0x00; // avgFrameRate hi
  out[o++] = 0x00; // avgFrameRate lo
  out[o++] = 0x03; // constantFrameRate=0, numTemporalLayers=0, temporalIdNested=0, lengthSizeMinusOne=3
  out[o++] = arrays.length;
  for (const arr of arrays) {
    out[o++] = 0x80 | (arr.type & 0x3f); // array_completeness=1
    out[o++] = (arr.nals.length >> 8) & 0xff;
    out[o++] = arr.nals.length & 0xff;
    for (const nal of arr.nals) {
      out[o++] = (nal.length >> 8) & 0xff;
      out[o++] = nal.length & 0xff;
      out.set(nal, o);
      o += nal.length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function hex2(n) {
  return n.toString(16).padStart(2, "0").toUpperCase();
}
