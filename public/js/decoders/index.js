/**
 * js/decoders/index.js — 解码器注册表与自动选择。
 *
 * 解码后端:
 *   - webcodecs:浏览器原生解码(WebCodecs VideoDecoder)
 *   - mse:浏览器原生解码(MediaSource + jmuxer),WebCodecs 不可用时的回退
 *   - custom-js:自定义 JS/WASM 解码器,不依赖浏览器原生解码能力
 *       · H.264 → Broadway(纯 JS/WASM)
 *       · H.265 → libde265(@yume-chan/libde265,WASM)
 *
 * 每种后端暴露 supported(codec),自动模式按优先级选择第一个可用的后端。
 */
import { WebCodecsDecoder } from "./webcodecs.js";
import { MseDecoder } from "./mse.js";
import { BroadwayDecoder } from "./broadway.js";
import { Libde265Decoder } from "./libde265.js";

export const DECODER_OPTIONS = [
  { id: "auto", label: "自动选择" },
  { id: "webcodecs", label: "WebCodecs(浏览器原生)" },
  { id: "custom-js", label: "自定义JS/WASM解码(Broadway/libde265)" },
  { id: "mse", label: "MediaSource(延迟高,不推荐)" },
];

export function decoderLabel(id) {
  const opt = DECODER_OPTIONS.find((o) => o.id === id);
  return opt ? opt.label : id;
}

export function customJsDecoderLabel(codec) {
  if (codec === "h264") return "自定义JS(Broadway)";
  if (codec === "h265") return "自定义JS(libde265)";
  return "自定义JS";
}

/**
 * 创建解码器实例。
 * @param {string} decoderId 'webcodecs' | 'mse' | 'custom-js'
 * @param {object} opts 含 codec(必填),其余为 {canvas, videoEl, onFrame, onError, onInfo}
 */
export function createDecoder(decoderId, opts) {
  switch (decoderId) {
    case "webcodecs":
      return new WebCodecsDecoder(opts);
    case "mse":
      return new MseDecoder(opts);
    case "custom-js":
      if (opts.codec === "h265") return new Libde265Decoder(opts);
      if (opts.codec === "h264") return new BroadwayDecoder(opts);
      throw new Error("自定义 JS 解码器暂不支持 " + opts.codec + ",支持 H.264/H.265");
    default:
      throw new Error("未知解码器:" + decoderId);
  }
}

/**
 * 探测指定解码后端是否支持某编码。
 * @returns {Promise<boolean>}
 */
export async function decoderSupports(decoderId, codec) {
  switch (decoderId) {
    case "webcodecs":
      return WebCodecsDecoder.supported(codec);
    case "mse":
      return MseDecoder.supported(codec);
    case "custom-js":
      if (codec === "h264") return BroadwayDecoder.supported(codec);
      if (codec === "h265") return Libde265Decoder.supported(codec);
      return false;
    default:
      return false;
  }
}

/**
 * 根据用户选择与编码格式确定最终解码器,并返回需要传给服务端的编码器参数。
 *
 * @param {string} userChoice 'auto' | 'webcodecs' | 'mse' | 'custom-js'
 * @param {string} codec h264/h265
 * @returns {Promise<{decoderId:string, codecOptions:string, warning?:string, label:string}>}
 */
export async function resolveDecoder(userChoice, codec) {
  // 自动选择:WebCodecs 优先,其次自定义JS(纯软件,兼容性最好),MediaSource 最后(延迟高)
  const candidates =
    userChoice === "auto" ? ["webcodecs", "custom-js", "mse"] : [userChoice];

  for (const id of candidates) {
    if (await decoderSupports(id, codec)) {
      let codecOptions = "";
      let warning = "";
      let label = decoderLabel(id);
      if (id === "custom-js") {
        if (codec === "h264") {
          // Broadway 仅支持 H.264 Baseline,强制编码端使用 baseline profile
          codecOptions = "profile=1";
          label = customJsDecoderLabel(codec);
          warning = "自定义JS解码(H.264/Broadway)已强制编码端使用 Baseline profile;建议分辨率 ≤720p";
        } else {
          label = customJsDecoderLabel(codec);
          warning = "自定义JS解码(H.265/libde265)在浏览器内纯 WASM 解码;高分辨率可能无法实时,建议 ≤720p";
        }
      }
      return { decoderId: id, codecOptions, warning, label };
    }
  }

  const hint = {
    h264: "请确认浏览器支持 WebCodecs,或使用 Chrome/Edge",
    h265: "H.265 需要浏览器 WebCodecs(HEVC)支持(如 Chrome 硬件解码、Safari),或使用「自定义JS解码」",
  }[codec];
  throw new Error(`当前浏览器没有可用的解码后端支持 ${codec.toUpperCase()}:${hint || ""}`);
}

const VIDEO_CODECS = ["h264", "h265"];

/**
 * 探测当前浏览器对每种编码 × 每种解码后端的支持情况(用于能力检测提示)。
 * @returns {Promise<{webcodecs: object, mse: object, customJs: object}>}
 *         每项为 {codec: boolean} 映射
 */
export async function probeSupport() {
  const result = { webcodecs: {}, mse: {}, customJs: {} };
  const tasks = [];
  for (const codec of VIDEO_CODECS) {
    tasks.push(
      decoderSupports("webcodecs", codec).then((v) => (result.webcodecs[codec] = v)),
      decoderSupports("mse", codec).then((v) => (result.mse[codec] = v)),
      decoderSupports("custom-js", codec).then((v) => (result.customJs[codec] = v))
    );
  }
  await Promise.all(tasks);
  return result;
}

/** 把探测结果格式化为可读文本 */
export function formatProbeResult(probe) {
  const label = {
    h264: "H.264", h265: "H.265(HEVC)",
  };
  const backend = [
    ["WebCodecs(原生)", probe.webcodecs],
    ["MediaSource(回退)", probe.mse],
    ["自定义JS/WASM", probe.customJs],
  ];
  const lines = [];
  for (const [name, map] of backend) {
    const parts = VIDEO_CODECS.map((c) => `${label[c]}:${map[c] ? "✓" : "✗"}`);
    lines.push(`${name}\n  ${parts.join("  ")}`);
  }
  return lines.join("\n");
}
