/**
 * js/nal.js — Annex-B 流拆分与视频参数集解析(H.264 SPS、H.265 SPS、AV1 序列头)。
 *
 * 这些解析用于:
 *   - 从 SPS/PPS 构建 WebCodecs 所需的 description(avcC / hvcC)与 codec 字符串
 *   - 从 AV1 序列头推导 codec 字符串
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
  const r = new BitReader(sps, 2); // 跳过 2 字节 NAL 头
  const type = (sps[0] >> 1) & 0x3f;
  if (type !== 33) throw new Error("不是 HEVC SPS NAL(type=" + type + ")");
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
  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatibilityFlags,
    constraintFlags,
    levelIdc,
    codec: "hvc1." + profileIdc + "." + (tierFlag ? "H" : "L") + "." + levelIdc + ".B0",
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
// AV1 序列头解析(推导 av01 codec 字符串)
// ---------------------------------------------------------------------------

/** 解析 AV1 序列头 OBU(不含 OBU 头),按 AV1 规范顺序读取。 */
export function parseAv1SeqHeader(obuPayload) {
  const r = new BitReader(obuPayload);
  const profile = r.readBits(2);
  r.readBits(1); // still_picture
  const reducedStillPictureHeader = r.readBits(1);
  let level = 0;
  let tier = 0;
  let decoderModelInfoPresent = false;
  if (reducedStillPictureHeader) {
    level = r.readBits(5);
  } else {
    const timingInfoPresent = r.readBits(1);
    if (timingInfoPresent) {
      r.readBits(32); // num_units_in_display_tick
      r.readBits(32); // time_scale
      if (r.readBits(1)) {
        // equal_picture_interval → uvlc: num_ticks_per_picture_minus_1
        for (;;) {
          const b = r.readBits(8);
          if (!(b & 0x80)) break;
        }
      }
      decoderModelInfoPresent = r.readBits(1) === 1;
      if (decoderModelInfoPresent) {
        r.readBits(5); // buffer_delay_length_minus_1
        r.readBits(32); // num_units_in_decoding_tick
        r.readBits(5); // buffer_removal_time_length_minus_1
        r.readBits(5); // frame_presentation_time_length_minus_1
      }
    }
    const initialDisplayDelayPresent = r.readBits(1);
    if (initialDisplayDelayPresent) {
      for (let i = 0; i < 32; i++) {
        if (r.readBits(1)) r.readBits(4); // initial_display_delay_minus_1
      }
    }
    const operatingPointsCnt = r.readBits(5);
    for (let i = 0; i <= operatingPointsCnt; i++) {
      r.readBits(12); // operating_point_idc
      const lvl = r.readBits(5);
      if (i === 0) level = lvl;
      if (lvl > 7) {
        const t = r.readBits(1);
        if (i === 0) tier = t;
      }
      if (decoderModelInfoPresent && initialDisplayDelayPresent) {
        r.readBits(4);
      }
    }
  }
  // 剩余帧尺寸与特性标志,仅需跳过直到 bit_depth
  r.readBits(4); // frame_width_bits_minus_1
  r.readBits(4); // frame_height_bits_minus_1
  r.readBits(5); // max_frame_width_minus_1
  r.readBits(5); // max_frame_height_minus_1
  const frameIdNumbersPresent = r.readBits(1);
  if (frameIdNumbersPresent) {
    r.readBits(4); // delta_frame_id_length_minus_2
    r.readBits(3); // additional_frame_id_length_minus_1
  }
  r.readBits(1); // use_128x128_superblock
  r.readBits(1); // enable_filter_intra
  r.readBits(1); // enable_intra_edge_filter
  r.readBits(1); // enable_interintra_compound
  r.readBits(1); // enable_masked_compound
  r.readBits(1); // enable_warped_motion
  r.readBits(1); // enable_dual_filter
  const enableOrderHint = r.readBits(1);
  if (enableOrderHint) {
    r.readBits(1); // enable_jnt_comp
    r.readBits(1); // enable_ref_frame_mvs
    const screenContentTools = r.readBits(1);
    if (screenContentTools === 1) {
      if (r.readBits(1) === 1) r.readBits(1); // seq_force_integer_mv
    }
  }
  r.readBits(1); // enable_superres
  r.readBits(1); // enable_cdef
  r.readBits(1); // enable_restoration
  // color_config
  const highBitdepth = r.readBits(1);
  let bitDepth;
  if (profile === 2) {
    const twelveBit = r.readBits(1);
    bitDepth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
  } else {
    bitDepth = highBitdepth ? 10 : 8;
  }
  const tierChar = tier ? "H" : "M";
  return {
    profile,
    level,
    tier,
    bitDepth,
    codec: "av01." + profile + "." + String(level).padStart(2, "0") + tierChar + "." + String(bitDepth).padStart(2, "0"),
  };
}

/** 从 Annex-B 数据包中查找 AV1 序列头 OBU 并解析 codec 字符串 */
export function parseAv1CodecFromPacket(data) {
  const obus = splitObus(data);
  for (const obu of obus) {
    if (obu.type === 1) {
      return parseAv1SeqHeader(obu.payload);
    }
  }
  return null;
}

function splitObus(data) {
  const result = [];
  let i = 0;
  while (i < data.length) {
    const header = data[i++];
    const type = (header >> 3) & 0x0f;
    const hasSize = (header >> 2) & 1;
    let payload = null;
    if (hasSize) {
      let size = 0;
      let shift = 0;
      for (;;) {
        if (i >= data.length) break;
        const b = data[i++];
        size |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      payload = data.subarray(i, i + size);
      i += size;
    } else {
      payload = data.subarray(i);
      i = data.length;
    }
    result.push({ type, payload });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function hex2(n) {
  return n.toString(16).padStart(2, "0").toUpperCase();
}
