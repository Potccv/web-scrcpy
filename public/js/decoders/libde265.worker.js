/**
 * js/decoders/libde265.worker.js — H.265(libde265 WASM)解码工作线程。
 *
 * 与主线程解耦,避免 WASM 解码阻塞 UI 导致延迟累积;带积压丢帧控制:
 * 当待解码数据量超过阈值(解码跟不上输入)时,清空队列并重置解码器,
 * 只保留下一个关键帧(IRAP)重新开始,防止延迟无限增长。
 *
 * 消息格式:
 *   {type:'init'} → {type:'ready'}
 *   {type:'nals', data: ArrayBuffer, count: n} — n 个 NAL 的合并数据,
 *    每个 NAL 以 4 字节大端长度前缀分隔
 *   {type:'flush'}
 *   {type:'destroy'}
 *   → {type:'frame', width,height,yStride,uStride,vStride,y,u,v}(transfer)
 *   → {type:'error', message}
 */
let module_ = null;
let decoder = null;
let decoderReady = false;
let nalQueue = []; // {data: Uint8Array, keyframe: boolean}
let queuedBytes = 0;
let waitingForKey = false;
let pumping = false;

const MAX_QUEUED_BYTES = 4 * 1024 * 1024; // 4MB 排队数据视为积压

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      try {
        const m = await import("/vendor/libde265/libde265.mjs");
        module_ = m.default ? await m.default() : await m;
        decoder = new module_.Decoder();
        decoderReady = true;
        self.postMessage({ type: "ready" });
        // 初始化期间到达的 NAL 已入队,现在开始解码
        scheduleDrain(true);
      } catch (err) {
        self.postMessage({ type: "error", message: "libde265 初始化失败:" + err.message });
      }
      break;
    }
    case "nals": {
      const buf = new Uint8Array(msg.data);
      const count = msg.count || 0;
      let off = 0;
      for (let i = 0; i < count && off + 4 <= buf.length; i++) {
        const len = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
        off += 4;
        if (off + len > buf.length) break;
        const nal = buf.slice(off, off + len);
        off += len;
        pushNal(nal, msg.keyframe);
      }
      if (decoderReady) scheduleDrain();
      break;
    }
    case "flush":
      scheduleDrain(true);
      break;
    case "destroy":
      self.close();
      break;
    default:
      break;
  }
};

function pushNal(data, isKey) {
  if (decoderReady && queuedBytes >= MAX_QUEUED_BYTES) {
    // 积压:丢弃排队数据,重置解码器,等待关键帧
    nalQueue = [];
    queuedBytes = 0;
    waitingForKey = true;
    try {
      decoder.reset();
    } catch {}
  }
  if (waitingForKey) {
    if (isKey) {
      waitingForKey = false;
      nalQueue.push({ data, keyframe: true });
      queuedBytes += data.length;
    }
    // 积压恢复前丢弃非关键帧
    return;
  }
  nalQueue.push({ data, keyframe: isKey });
  queuedBytes += data.length;
}

function scheduleDrain(force = false) {
  if (pumping && !force) return;
  setTimeout(drain, 0);
}

function drain() {
  if (pumping) return;
  pumping = true;
  try {
    // 1) 喂入排队中的 NAL(限量,避免长时间阻塞消息循环)
    let fed = 0;
    while (nalQueue.length && fed < 400) {
      const { data } = nalQueue.shift();
      queuedBytes -= data.length;
      try {
        decoder.pushNal(data, 0n);
        decoder.pushEndOfNal();
      } catch {}
      fed++;
    }
    // 2) 解码并取帧(限量)
    let guard = 0;
    for (;;) {
      let result;
      try {
        result = decoder.decode();
      } catch {
        break;
      }
      if (!module_.isOk(result.error)) {
        if (result.error === module_.Error.ERROR_WAITING_FOR_INPUT_DATA) break;
        if (result.error !== module_.Error.ERROR_IMAGE_BUFFER_FULL) {
          // 非致命错误:上报但继续(等待后续数据)
          self.postMessage({ type: "error", message: "libde265 解码警告:" + module_.getErrorText(result.error) });
          break;
        }
      }
      const image = decoder.getNextPicture();
      if (image) {
        postFrame(image);
        try {
          image.delete();
        } catch {}
        if (++guard >= 6) break; // 每轮最多输出 6 帧
      } else if (!result.more) {
        break;
      }
    }
  } finally {
    pumping = false;
  }
  if (nalQueue.length) {
    setTimeout(drain, 0);
  }
}

// YUV→RGB 查表(在 worker 中完成,主线程只负责 putImageData,减主线程负载)
const CR = new Int16Array(256);
const CB = new Int16Array(256);
const CGU = new Int16Array(256);
const CGV = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  CR[i] = Math.round(1.402 * (i - 128));
  CB[i] = Math.round(1.772 * (i - 128));
  CGU[i] = Math.round(0.344136 * (i - 128));
  CGV[i] = Math.round(0.714136 * (i - 128));
}

function postFrame(image) {
  try {
    const w = image.getWidth(0);
    const h = image.getHeight(0);
    if (!w || !h) return;
    const y = image.getImagePlane(0);
    const u = image.getImagePlane(1);
    const v = image.getImagePlane(2);
    const yb = y.bytes;
    const ub = u.bytes;
    const vb = v.bytes;
    // YUV420 → RGBA(查表)
    const rgba = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) {
      const yRow = j * y.stride;
      const uRow = (j >> 1) * u.stride;
      const vRow = (j >> 1) * v.stride;
      let o = j * w * 4;
      for (let i = 0; i < w; i++) {
        const Y = yb[yRow + i];
        const U = ub[uRow + (i >> 1)];
        const V = vb[vRow + (i >> 1)];
        rgba[o] = clamp(Y + CR[V]);
        rgba[o + 1] = clamp(Y - CGU[U] - CGV[V]);
        rgba[o + 2] = clamp(Y + CB[U]);
        rgba[o + 3] = 255;
        o += 4;
      }
    }
    self.postMessage({ type: "frame", width: w, height: h, rgba: rgba.buffer }, [rgba.buffer]);
  } catch {
    // 取帧/转换失败忽略
  }
}

function clamp(x) {
  return x < 0 ? 0 : x > 255 ? 255 : x;
}
