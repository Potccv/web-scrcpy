/**
 * server/index.mjs — Web 版 scrcpy 服务端入口。
 *
 * 职责:
 *   - 静态托管 public/(Web 前端)与 shared/(浏览器可导入的共享模块)
 *   - REST API:设备管理(adb)、全局状态
 *   - WebSocket 桥:每个客户端独立会话(支持多人同时串流不同设备/流)
 *
 * WS 二进制消息(服务端 → 浏览器):[stream 1B][flags 1B][payload]
 *   stream: 0=video(音频已移除,仅画面);flags 见 shared/video-stream.js PacketFlags
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ScrcpySession } from "./session.mjs";
import * as adb from "./adb.mjs";
import { decodeDeviceMessage, encodeGetClipboard } from "../shared/protocol.js";
import { StreamType, PacketFlags } from "../shared/video-stream.js";
import { SessionRecorder, RECORDINGS_DIR, setRecordingsDir, getDiskFree, cleanupRecordings } from "./recorder.mjs";
import { splitAnnexB } from "../shared/nal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SHARED_DIR = path.join(ROOT, "shared");
const BIN_DIR = path.join(ROOT, "bin");

// ---------------------------------------------------------------------------
// 配置加载:config.default.json 提供默认值,config.json 可覆盖;
// 环境变量(PORT/HOST/ADB_PATH)优先级高于配置文件。
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: 8080,
  host: "0.0.0.0",
  defaultCodec: "h264",
  defaultBitrate: 2_000_000,
  defaultMaxSize: 0,
  defaultMaxFps: 0,
  logLevel: "info",
  recordingDir: "tmp/recordings",
    recordingMaxAgeDays: 7,
    recordingMaxTotalBytes: 2 * 1024 ** 3,
    recordingDiskFreeWarnBytes: 1 * 1024 ** 3,
    recordingDiskFreeMinBytes: 300 * 1024 ** 2,
    recordingCleanupIntervalHours: 6,
};

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "config.json");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config.default.json");

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    if (fs.existsSync(filePath)) {
      console.warn(`[config] 配置文件解析失败,已忽略:${filePath}`);
    }
    return null;
  }
}

function normalizeConfig(raw, source = "config") {
  if (!raw || typeof raw !== "object") return {};
  const cfg = {};
  const invalid = (key) => console.warn(`[config] ${source} 字段 ${key} 非法,已回退默认值`);
  if (raw.port !== undefined) {
    if (Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) cfg.port = raw.port;
    else invalid("port");
  }
  if (raw.host !== undefined) {
    if (typeof raw.host === "string" && raw.host.trim()) cfg.host = raw.host.trim();
    else invalid("host");
  }
  if (raw.defaultCodec !== undefined) {
    if (["h264", "h265", "av1"].includes(raw.defaultCodec)) cfg.defaultCodec = raw.defaultCodec;
    else invalid("defaultCodec");
  }
  if (raw.defaultBitrate !== undefined) {
    if (Number.isFinite(raw.defaultBitrate) && raw.defaultBitrate > 0) cfg.defaultBitrate = Math.round(raw.defaultBitrate);
    else invalid("defaultBitrate");
  }
  if (raw.defaultMaxSize !== undefined) {
    if (Number.isInteger(raw.defaultMaxSize) && raw.defaultMaxSize >= 0) cfg.defaultMaxSize = raw.defaultMaxSize;
    else invalid("defaultMaxSize");
  }
  if (raw.defaultMaxFps !== undefined) {
    if (Number.isInteger(raw.defaultMaxFps) && raw.defaultMaxFps >= 0) cfg.defaultMaxFps = raw.defaultMaxFps;
    else invalid("defaultMaxFps");
  }
  if (raw.logLevel !== undefined) {
    if (["debug", "info", "warn", "error"].includes(raw.logLevel)) cfg.logLevel = raw.logLevel;
    else invalid("logLevel");
  }
  if (raw.recordingDir !== undefined) {
    if (typeof raw.recordingDir === "string" && raw.recordingDir.trim()) cfg.recordingDir = raw.recordingDir.trim();
    else invalid("recordingDir");
  }
    if (raw.recordingMaxAgeDays !== undefined) {
      if (Number.isFinite(raw.recordingMaxAgeDays) && raw.recordingMaxAgeDays > 0) cfg.recordingMaxAgeDays = raw.recordingMaxAgeDays;
      else invalid("recordingMaxAgeDays");
    }
    if (raw.recordingMaxTotalBytes !== undefined) {
      if (Number.isFinite(raw.recordingMaxTotalBytes) && raw.recordingMaxTotalBytes > 0) cfg.recordingMaxTotalBytes = Math.round(raw.recordingMaxTotalBytes);
      else invalid("recordingMaxTotalBytes");
    }
    if (raw.recordingDiskFreeWarnBytes !== undefined) {
      if (Number.isFinite(raw.recordingDiskFreeWarnBytes) && raw.recordingDiskFreeWarnBytes >= 0) cfg.recordingDiskFreeWarnBytes = Math.round(raw.recordingDiskFreeWarnBytes);
      else invalid("recordingDiskFreeWarnBytes");
    }
    if (raw.recordingDiskFreeMinBytes !== undefined) {
      if (Number.isFinite(raw.recordingDiskFreeMinBytes) && raw.recordingDiskFreeMinBytes >= 0) cfg.recordingDiskFreeMinBytes = Math.round(raw.recordingDiskFreeMinBytes);
      else invalid("recordingDiskFreeMinBytes");
    }
    if (raw.recordingCleanupIntervalHours !== undefined) {
      if (Number.isFinite(raw.recordingCleanupIntervalHours) && raw.recordingCleanupIntervalHours > 0) cfg.recordingCleanupIntervalHours = raw.recordingCleanupIntervalHours;
      else invalid("recordingCleanupIntervalHours");
    }
  return cfg;
}

function loadConfig() {
  const defaults = { ...DEFAULT_CONFIG, ...normalizeConfig(readJsonFile(DEFAULT_CONFIG_PATH), "config.default.json") };
  const user = readJsonFile(CONFIG_PATH);
  const config = { ...defaults, ...normalizeConfig(user, "config.json") };
  if (user === null && process.env.CONFIG_PATH && !fs.existsSync(CONFIG_PATH)) {
    console.warn(`[config] 指定的配置文件不存在:${CONFIG_PATH},使用默认配置`);
  }
  return config;
}

const config = loadConfig();

if (config.recordingDir) {
  try {
    setRecordingsDir(path.isAbsolute(config.recordingDir) ? config.recordingDir : path.join(ROOT, config.recordingDir));
  } catch (e) {
    console.warn(`[config] 录制目录不可用,已回退默认目录:${e.message}`);
    try {
      setRecordingsDir(path.join(ROOT, "tmp", "recordings"));
    } catch {}
  }
}

const PORT = Number(process.env.PORT || config.port || 8080);
const HOST = process.env.HOST || config.host || "0.0.0.0";
const LOG_LEVEL = config.logLevel || "info";

const RECORDING_MAX_AGE_MS = (config.recordingMaxAgeDays || 7) * 86400e3;
const RECORDING_MAX_TOTAL_BYTES = config.recordingMaxTotalBytes || (2 * 1024 ** 3);
const RECORDING_DISK_WARN_BYTES = config.recordingDiskFreeWarnBytes ?? (1 * 1024 ** 3);
const RECORDING_DISK_MIN_BYTES = config.recordingDiskFreeMinBytes ?? (300 * 1024 ** 2);
const RECORDING_CLEANUP_INTERVAL_MS = (config.recordingCleanupIntervalHours || 6) * 3600e3;

function readServerVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(BIN_DIR, "version.json"), "utf8"));
    return String(v.version);
  } catch {
    return "4.1";
  }
}

const SERVER_VERSION = readServerVersion();

// ---------------------------------------------------------------------------
// 静态文件服务
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json",
};

function serveStatic(req, res, urlPath) {
  let root;
  let rel;
  if (urlPath.startsWith("/shared/")) {
    root = SHARED_DIR;
    rel = urlPath.slice("/shared/".length);
  } else if (urlPath.startsWith("/recordings/")) {
    root = RECORDINGS_DIR;
    rel = urlPath.slice("/recordings/".length);
  } else {
    root = PUBLIC_DIR;
    rel = urlPath.slice(1);
  }
  let filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fs.stat(filePath, (err2, stat2) => {
        if (err2 || !stat2.isFile()) {
          res.writeHead(404).end("Not Found");
          return;
        }
        sendFile(res, filePath);
      });
      return;
    }
    if (err || !stat.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }
    // recordings 目录的视频作为附件下载(带文件名,兼容 IDM 等下载工具)
    sendFile(res, filePath, urlPath.startsWith("/recordings/"));
  });
}

function sendFile(res, filePath, asAttachment) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  };
  if (asAttachment) {
    // 强制下载 + 文件名(改善 IDM/浏览器下载兼容性)
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath)}"`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// 多客户端会话管理
// ---------------------------------------------------------------------------

/** @type {Map<WebSocket, object>} ws → client */
const clients = new Map();

function clientSessionStatus(client) {
  const s = client.session;
  if (!s) return { active: false };
  return {
    active: true,
    serial: s.serial,
    codec: s.params.codec,
    bitrate: s.params.bitrate,
    maxSize: s.params.maxSize,
    maxFps: s.params.maxFps,
    deviceName: client.meta.deviceName,
    width: client.meta.width,
    height: client.meta.height,
    codecOnWire: client.meta.codec,
  };
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // 客户端可能已断开
    }
  }
}

// ---------------------------------------------------------------------------
// 会话生命周期(按客户端)
// ---------------------------------------------------------------------------

async function startSessionForClient(client, params) {
  if (client.session) {
    throw new Error("已有会话在运行,请先停止");
  }
  await client.stopPromise; // 等待上一次停止完成
  const {
    serial,
    codec = config.defaultCodec || "h264",
    bitrate = config.defaultBitrate || 8_000_000,
    maxSize = config.defaultMaxSize ?? 0,
    maxFps = config.defaultMaxFps ?? 0,
    codecOptions = "",
  } = params;
  if (!serial) throw new Error("缺少设备序列号");

  client.meta = { codec: null, width: null, height: null, deviceName: null };
      const s = new ScrcpySession({
    serial,
    version: SERVER_VERSION,
    codec,
    bitrate,
    maxSize,
    maxFps,
    codecOptions: withCbr(codec, codecOptions),
    onEvent: (evt) => handleSessionEvent(client, evt),
  });
  client.session = s;
  initRateControl(client, { target: bitrate, cap: bitrate });
  try {
    await s.start();
  } catch (err) {
    if (client.session === s) client.session = null;
    sendJson(client.ws, { type: "state", state: "error", message: err.message });
    throw err;
  }
  sendJson(client.ws, { type: "state", state: "connected", ...clientSessionStatus(client) });
}

async function stopSessionForClient(client) {
  const s = client.session;
  client.session = null;
  if (client.recording) {
    console.log("[record] 会话停止,丢弃未完成的录制");
    client.recording = null;
  }
  client.meta = { codec: null, width: null, height: null, deviceName: null };
      client.stopPromise = s ? s.stop().catch(() => {}) : Promise.resolve();
  await client.stopPromise;
  sendJson(client.ws, { type: "state", state: "stopped" });
}

async function restartSessionForClient(client, patch) {
  if (!client.session) throw new Error("会话未运行");
  const autoRate = !!patch._autoRate;
  if (autoRate) delete patch._autoRate;
  const s = client.session;
  client.session = null; // 防止并发操作
  await s.stop();
  if (client.stopPromise) {
    await client.stopPromise.catch(() => {});
  }
  client.session = s;
  s.setParams(patch);
  if (client.recording) {
    // 参数切换后编码器重新初始化,录制继续(新的 config 包会更新参数集)
    sendJson(client.ws, { type: "log", level: "warn", message: "编码参数已切换,录制继续" });
  }
  if (patch.bitrate !== undefined && !autoRate) {
    // 用户手动调整码率档位:重置码率控制目标
    initRateControl(client, { target: patch.bitrate, cap: patch.bitrate });
  }
  if (patch.codec !== undefined) {
    s.setParams({ codecOptions: withCbr(patch.codec, patch.codecOptions !== undefined ? patch.codecOptions : s.params.codecOptions) });
  }
  client.meta = { codec: null, width: null, height: null, deviceName: null };
      sendJson(client.ws, { type: "state", state: "restarting", ...clientSessionStatus(client) });
  try {
    await s.start();
  } catch (err) {
    if (client.session === s) client.session = null;
    sendJson(client.ws, { type: "state", state: "error", message: err.message });
    throw err;
  }
  sendJson(client.ws, { type: "state", state: "connected", ...clientSessionStatus(client) });
}

/**
 * H.264/H.265 强制 CBR(bitrate-mode=2),使编码器贴近目标码率;
 * 超过时编码器通过降低量化质量来控制码率(即"超过则降画质")。
 */
function withCbr(codec, codecOptions) {
  if (codec !== "h264" && codec !== "h265") return codecOptions || "";
  const opts = codecOptions ? codecOptions.split(",").filter(Boolean) : [];
  if (!opts.some((o) => o.startsWith("bitrate-mode"))) {
    opts.push("bitrate-mode=2");
  }
  return opts.join(",");
}

// ---------------------------------------------------------------------------
// 会话操作串行队列:start/stop/config 重启互斥执行,
// 避免并发 restart 的竞态(如"会话未运行"错误、restart 互相杀死进程)
// ---------------------------------------------------------------------------

function enqueueOp(client, fn) {
  client._opQueue = client._opQueue.then(fn).catch(() => {});
  return client._opQueue;
}

/** 自动码率调整的重启:排队执行,已在排队中则跳过(避免 2 秒定时器堆积) */
function queueAutoRestart(client, patch) {
  if (client._rateRestartPending) return;
  client._rateRestartPending = true;
  enqueueOp(client, async () => {
    try {
      await restartSessionForClient(client, patch);
    } finally {
      client._rateRestartPending = false;
    }
  });
}

// ---------------------------------------------------------------------------
// 码率硬限制:实测码率超过档位时自动下调编码器目标(降画质)
// ---------------------------------------------------------------------------

function initRateControl(client, { target, cap }) {
  client.rateControl = {
    target, // 用户选择的档位
    cap, // 当前允许的上限
    bytes: 0,
    windowStart: Date.now(),
    ema: 0,
    lowered: false,
    cooldownUntil: 0,
    lastActionAt: 0,
  };
}

/** 每 2 秒由全局定时器调用 */
function checkRateLimits() {
  for (const client of clients.values()) {
    const rc = client.rateControl;
    const s = client.session;
    if (!rc || !s || !s.params.bitrate) continue;

    const now = Date.now();
    const dt = (now - rc.windowStart) / 1000;
    if (dt < 1.5) continue;
    const bps = (rc.bytes * 8) / dt;
    rc.bytes = 0;
    rc.windowStart = now;
    rc.ema = rc.ema === 0 ? bps : rc.ema * 0.6 + bps * 0.4;

    const target = rc.target;
    // 超限:实测 EMA 超过档位 1.2 倍 → 降低编码目标码率(≈降画质)
    if (rc.ema > target * 1.2 && now > rc.cooldownUntil) {
      const newBitrate = Math.max(500_000, Math.round((s.params.bitrate * 0.7) / 500_000) * 500_000);
      if (newBitrate < s.params.bitrate) {
        rc.cap = newBitrate;
        rc.lowered = true;
        rc.cooldownUntil = now + 20_000; // 冷却 20 秒
        sendJson(client.ws, {
          type: "log",
          level: "warn",
          message: `实际码率(${(rc.ema / 1_000_000).toFixed(2)}Mbps)超过档位,已自动降低编码质量至 ${(newBitrate / 1_000_000).toFixed(1)}Mbps`,
        });
        sendJson(client.ws, { type: "rateLimit", bitrate: newBitrate, actual: Math.round(rc.ema) });
        queueAutoRestart(client, { bitrate: newBitrate, _autoRate: true });
      }
      continue;
    }
    // 有余量且曾被降档:恢复一档
    if (rc.lowered && rc.ema < target * 0.6 && now > rc.cooldownUntil + 10_000 && s.params.bitrate < target) {
      const newBitrate = Math.min(target, Math.round((s.params.bitrate * 1.4) / 500_000) * 500_000);
      rc.cap = newBitrate;
      rc.cooldownUntil = now + 20_000;
      sendJson(client.ws, {
        type: "log",
        level: "info",
        message: `实际码率充足(${(rc.ema / 1_000_000).toFixed(2)}Mbps),已恢复编码质量至 ${(newBitrate / 1_000_000).toFixed(1)}Mbps`,
      });
      sendJson(client.ws, { type: "rateLimit", bitrate: newBitrate, actual: Math.round(rc.ema) });
      queueAutoRestart(client, { bitrate: newBitrate, _autoRate: true });
    }
  }
}
setInterval(checkRateLimits, 2000);

// ---------------------------------------------------------------------------
// 录制文件维护:启动清理一次 + 按配置间隔定时清理;磁盘空间不足时提醒
// ---------------------------------------------------------------------------

cleanupRecordings({ maxAgeMs: RECORDING_MAX_AGE_MS, maxTotalBytes: RECORDING_MAX_TOTAL_BYTES });
setInterval(() => {
  const r = cleanupRecordings({ maxAgeMs: RECORDING_MAX_AGE_MS, maxTotalBytes: RECORDING_MAX_TOTAL_BYTES });
  if (r.deleted.length) {
    console.log(`[recordings] 已清理 ${r.deleted.length} 个过期录制文件`);
  }
}, RECORDING_CLEANUP_INTERVAL_MS);

// 磁盘空间低时向所有在线客户端发送提醒(有节流,避免刷屏)
let lastDiskWarnAt = 0;
setInterval(() => {
  const now = Date.now();
  if (now - lastDiskWarnAt < 10 * 60e3) return; // 10 分钟一次
  const disk = getDiskFree();
  if (disk.free < RECORDING_DISK_WARN_BYTES) {
    lastDiskWarnAt = now;
    const msg = `磁盘剩余空间不足:${(disk.free / 1024 ** 3).toFixed(2)}GB,录制文件可能无法保存`;
    console.log("[recordings]", msg);
    for (const c of clients.values()) {
      sendJson(c.ws, { type: "log", level: "warn", message: msg });
    }
  }
}, 60e3);

function handleSessionEvent(client, evt) {
  const ws = client.ws;
  switch (evt.type) {
    case "codec":
      client.meta.codec = evt.codec;
      sendJson(ws, { type: "meta", ...client.meta });
      break;
    case "session":
      client.meta.width = evt.width;
      client.meta.height = evt.height;
      sendJson(ws, { type: "meta", ...client.meta });
      break;
    case "packet": {
        
      if (ws && ws.readyState === WebSocket.OPEN) {
        const buf = Buffer.allocUnsafe(2 + evt.data.length);
        buf[0] = StreamType.VIDEO;
        buf[1] = evt.flags;
        evt.data.copy(buf, 2);
        ws.send(buf, { binary: true });
        if (client.rateControl) {
          client.rateControl.bytes += evt.data.length; // 仅统计视频字节
        }
      }
      // h265web.js 等解码器使用独立的裸流 WebSocket(/ws-raw),只转发视频 payload
      if (client.mediaWs && client.mediaWs.readyState === WebSocket.OPEN) {
        try {
          client.mediaWs.send(evt.data);
        } catch {}
      }
      // 无条件缓存最新参数集与关键帧(录制开始时用于初始化文件头)
      if (evt.flags & PacketFlags.CONFIG) {
        client.lastConfig = Buffer.from(evt.data);
      }
      if (evt.flags & PacketFlags.KEY_FRAME || (client.lastConfig && splitAnnexB(evt.data).some((n) => n.nalType === 5))) {
        client.lastKeyFrame = { data: Buffer.from(evt.data), pts: evt.pts, time: Date.now() };
      }
      if (client.recording) {
        if (evt.flags & PacketFlags.CONFIG) {
          client.recording.handleConfig(evt.data);
        } else {
          const ok = client.recording.handlePacket({
            data: evt.data,
            pts: evt.pts,
            isKey: !!(evt.flags & PacketFlags.KEY_FRAME),
          });
          if (ok === false && !client.recording.limitNotified) {
            client.recording.limitNotified = true;
            sendJson(ws, { type: "record", action: "limit" });
          }
        }
      }
      break;
    }
    case "controlData":
      handleDeviceControlData(client, evt.data);
      break;
    case "connected":
      client.meta.deviceName = evt.deviceName;
      console.log(`[session] 设备已连接:${evt.deviceName}`);
      sendJson(ws, { type: "connected", deviceName: evt.deviceName });
      break;
    case "disconnected":
              sendJson(ws, { type: "disconnected", reason: evt.reason });
      break;
    case "processExit": {
      const logs = client.session && client.session.serverLogs ? client.session.serverLogs : [];
      const errLines = logs.filter((l) => /error|exception/i.test(l)).slice(-2);
      const tail = (errLines.length ? errLines : logs.slice(-3)).join(" | ");
      const reason = `设备端服务器异常退出(code=${evt.code})${tail ? ":" + tail : ""}`;
              sendJson(ws, { type: "error", message: reason });
      sendJson(ws, { type: "disconnected", reason });
      if (client.session && client.session.childExited) {
        client.session = null;
      }
      break;
    }
    case "error":
      sendJson(ws, { type: "error", message: evt.message });
      break;
    case "log":
      console.log("[session]", evt.message);
      sendJson(ws, { type: "log", level: "info", message: evt.message });
      break;
    case "serverError":
      sendJson(ws, { type: "log", level: "error", message: evt.message });
      break;
    default:
      break;
  }
}

// 录制管理:开始录制 → RESET_VIDEO 触发设备重发参数集+关键帧;
// 停止录制 → 封装 MP4 写入 tmp/recordings/ 并回传下载地址
async function handleRecord(client, action) {
  if (action === "start") {
    const s = client.session;
    if (!s) throw new Error("请先开始串流");
    if (client.recording) throw new Error("已在录制中");
    if (!client.meta.codec) throw new Error("视频流尚未就绪,请稍候");
    // 磁盘空间检查:剩余低于配置阈值时拒绝录制,避免录到一半写满磁盘
    const disk = getDiskFree();
    if (disk.free < RECORDING_DISK_MIN_BYTES) {
      throw new Error(`磁盘剩余空间不足(${(disk.free / 1024 ** 2).toFixed(0)}MB),无法开始录制`);
    }
    client.recording = new SessionRecorder({
      codec: client.meta.codec,
      width: client.meta.width || 0,
      height: client.meta.height || 0,
      serial: s.serial,
    });
    // 参数集:avcC/hvcC 由会话缓存的 config 提供
    if (client.lastConfig) {
      client.recording.handleConfig(client.lastConfig);
    }
    // 关键帧策略:
    //  - 若编码器尚未启用 i-frame-interval,重启会话应用之 —— 重启后设备输出的
    //    第一个关键帧就是"当前画面",既避免视频开头是录制前的旧画面(突变),
    //    又保证关键帧间隔正常(可拖动进度条)。录制结束恢复原参数。
    //  - 不发送 RESET_VIDEO:redroid 上重置编码器后视频输出会卡死。
    const codecOptionsNow = s.params.codecOptions || "";
    if (!codecOptionsNow.includes("i-frame-interval")) {
      const base = codecOptionsNow.replace(/i-frame-interval=[^,]*,?/g, "").replace(/,$/, "");
      client._recBaseCodecOptions = base;
      const newOpts = (base ? base + "," : "") + "i-frame-interval=2";
      // 等待重启后新会话输出的关键帧(当前画面)作为第一帧
      client.recording.setPendingStart(client.lastKeyFrame ? client.lastKeyFrame.data : null);
      client.recording.startTimeout = setTimeout(() => {
        if (client.recording && client.recording.pendingStart) {
          client.recording.startWithCache();
        }
      }, 3000);
      enqueueOp(client, () => restartSessionForClient(client, { codecOptions: newOpts }));
    } else if (client.lastKeyFrame) {
      // 已有 i-frame-interval:直接用缓存关键帧(通常较新)
      client.recording.addInitialKeyFrame(client.lastKeyFrame.data, client.lastKeyFrame.pts);
    }
    // 3 秒仍无新帧写入则提示用户操作设备(静止画面不产生视频帧)
    client.recording.waitingTimer = setTimeout(() => {
      if (client.recording && client.recording.frameCount <= 1) {
        sendJson(client.ws, { type: "record", action: "waiting" });
      }
    }, 3000);
    sendJson(client.ws, { type: "record", action: "started" });
    sendJson(client.ws, { type: "record", action: "recording" });
    return;
  }
  if (action === "stop") {
    const rec = client.recording;
    if (!rec) throw new Error("没有正在进行的录制");
    client.recording = null;
    clearTimeout(rec.waitingTimer);
    clearTimeout(rec.startTimeout);
    try {
      const r = rec.finish();
      sendJson(client.ws, {
        type: "record",
        action: "stopped",
        url: "/recordings/" + r.filename,
        filename: r.filename,
        frames: r.frames,
        bytes: r.bytes,
        limitHit: r.limitHit,
      });
    } catch (e) {
      if (rec.frameCount === 0) {
        sendJson(client.ws, { type: "record", action: "empty" });
      } else {
        sendJson(client.ws, { type: "error", message: "录制失败:" + e.message });
      }
    }
    // 录制结束后清理过期/超量文件
    cleanupRecordings({ maxAgeMs: RECORDING_MAX_AGE_MS, maxTotalBytes: RECORDING_MAX_TOTAL_BYTES });
    // 录制期间改过编码参数(i-frame-interval):恢复原参数
    if (client._recBaseCodecOptions !== undefined && client.session) {
      const base = client._recBaseCodecOptions;
      client._recBaseCodecOptions = undefined;
      enqueueOp(client, () => restartSessionForClient(client, { codecOptions: base }));
    }
    return;
  }
  throw new Error("未知的录制操作:" + action);
}

// 设备 → 浏览器控制消息(剪贴板等)的增量解析与转发
function handleDeviceControlData(client, chunk) {  let buf = client.deviceMsgBuffer.length ? Buffer.concat([client.deviceMsgBuffer, chunk]) : chunk;
  for (;;) {
    const msg = decodeDeviceMessage(buf, 0, buf.length);
    if (!msg) break; // 数据不足
    buf = buf.subarray(msg.consumed);
    if (buf.length === 0) buf = Buffer.alloc(0);
    if (msg.type === -1) continue; // 未知类型,丢弃一个字节
    switch (msg.type) {
      case 0: // CLIPBOARD
        sendJson(client.ws, { type: "deviceMsg", kind: "clipboard", text: msg.text });
        break;
      case 1: // ACK_CLIPBOARD
        sendJson(client.ws, { type: "deviceMsg", kind: "ackClipboard", sequence: msg.sequence });
        break;
      case 2: // UHID_OUTPUT
        sendJson(client.ws, { type: "deviceMsg", kind: "uhid", id: msg.id, data: Array.from(msg.data) });
        break;
      default:
        break;
    }
  }
  client.deviceMsgBuffer = buf;
}

// ---------------------------------------------------------------------------
// HTTP + REST API
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendRes(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (method === "GET" && p === "/api/status") {
    const adbError = await adb.checkAdb();
    let devices = [];
    let devicesError = null;
    if (!adbError) {
      try {
        devices = await adb.listDevices();
      } catch (e) {
        devicesError = e.message;
      }
    }
    const sessions = [];
    for (const client of clients.values()) {
      if (client.session) sessions.push(clientSessionStatus(client));
    }
    return sendRes(res, 200, {
      adb: adbError,
      devices,
      devicesError,
      sessions,
      clientCount: clients.size,
      serverVersion: SERVER_VERSION,
      jarPresent: fs.existsSync(path.join(BIN_DIR, "scrcpy-server.jar")),
    });
  }

    if (method === "GET" && p === "/api/config") {
      return sendRes(res, 200, {
        port: PORT,
        host: HOST,
        defaultCodec: config.defaultCodec,
        defaultBitrate: config.defaultBitrate,
        defaultMaxSize: config.defaultMaxSize,
        defaultMaxFps: config.defaultMaxFps,
        logLevel: LOG_LEVEL,
        recordingDir: config.recordingDir,
          recordingMaxAgeDays: config.recordingMaxAgeDays,
          recordingMaxTotalBytes: config.recordingMaxTotalBytes,
          recordingDiskFreeWarnBytes: config.recordingDiskFreeWarnBytes,
          recordingDiskFreeMinBytes: config.recordingDiskFreeMinBytes,
          recordingCleanupIntervalHours: config.recordingCleanupIntervalHours,
      });
    }

  if (method === "GET" && p === "/api/devices") {
    const devices = await adb.listDevices();
    return sendRes(res, 200, { devices });
  }

  if (method === "POST" && p === "/api/devices/connect") {
    const body = await readBody(req);
    const result = await adb.connect(body.host || "", Number(body.port) || 0);
    return sendRes(res, result.ok ? 200 : 400, result);
  }

  if (method === "POST" && p === "/api/devices/disconnect") {
    const body = await readBody(req);
    const result = await adb.disconnect(body.serial);
    return sendRes(res, 200, result);
  }

  return sendRes(res, 404, { error: "Not Found" });
}

// ---------------------------------------------------------------------------
// WebSocket 桥
// ---------------------------------------------------------------------------

function setupWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    const client = {
      ws,
      session: null,
      stopPromise: Promise.resolve(),
      meta: { codec: null, width: null, height: null, deviceName: null },
      deviceMsgBuffer: Buffer.alloc(0),
      lastConfig: null,
      recording: null,
      mediaToken: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      mediaWs: null,
      _opQueue: Promise.resolve(),
      _rateRestartPending: false,
        
    };
    clients.set(ws, client);
    console.log(`[ws] 客户端已连接(当前 ${clients.size} 个)`);
    sendJson(ws, { type: "ready", clientCount: clients.size, mediaToken: client.mediaToken });

    ws.on("message", (data, isBinary) => {
        
      if (isBinary) {
        // 原始 scrcpy 控制消息 → 设备
        if (client.session) {
          client.session.sendControl(Buffer.from(data));
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleClientJson(client, msg);
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (client.mediaWs) {
        try {
          client.mediaWs.close();
        } catch {}
        client.mediaWs = null;
      }
      if (client.session) {
        stopSessionForClient(client).catch(() => {});
      }
      console.log(`[ws] 客户端断开(当前 ${clients.size} 个)`);
    });

    ws.on("error", () => {});
  });

  // 独立裸流 WebSocket:h265web.js 等播放器直接读取原始视频 payload(无 [stream][flags] 头)
  const mediaWss = new WebSocketServer({ noServer: true });

  // 统一 upgrade 路由:/ws 为主控制/视频桥,/ws-raw 为 h265web.js 裸流
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    if (url.pathname === "/ws-raw") {
      mediaWss.handleUpgrade(req, socket, head, (ws) => {
        const token = url.searchParams.get("token") || "";
        let client = null;
        for (const c of clients.values()) {
          if (c.mediaToken === token) {
            client = c;
            break;
          }
        }
        if (!client) {
          ws.close(4001, "invalid media token");
          return;
        }
        client.mediaWs = ws;
        ws.on("message", () => {
          // h265web.js 打开连接后会发送 "Hello WebSockets!" 文本,忽略即可
        });
        ws.on("close", () => {
          if (client && client.mediaWs === ws) client.mediaWs = null;
        });
        ws.on("error", () => {});
      });
      return;
    }
    socket.destroy();
  });

  return wss;
}

function handleClientJson(client, msg) {
  switch (msg.type) {
    case "ping":
      sendJson(client.ws, { type: "pong", t: msg.t });
      break;
    case "start":
      enqueueOp(client, () => startSessionForClient(client, msg));
      break;
    case "stop":
      enqueueOp(client, () => stopSessionForClient(client));
      break;
    case "config": {
      const patch = {};
      for (const k of ["codec", "bitrate", "maxSize", "maxFps", "codecOptions"]) {
        if (msg[k] !== undefined) patch[k] = msg[k];
      }
      enqueueOp(client, () => restartSessionForClient(client, patch));
      break;
    }
    case "getClipboard":
      if (client.session) {
        // COPY 键触发剪贴板变化,autosync 会推送 CLIPBOARD 消息
        client.session.sendControl(Buffer.from(encodeGetClipboard(1))); // GET_CLIPBOARD + COPY_KEY_COPY
      }
      break;
    case "record":
      handleRecord(client, msg.action).catch((err) =>
        sendJson(client.ws, { type: "error", message: err.message })
      );
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => sendRes(res, 500, { error: err.message }));
    return;
  }
  serveStatic(req, res, url.pathname);
});

setupWebSocket(server);

server.listen(PORT, HOST, () => {
  console.log("==============================================");
  console.log(` Web 版 scrcpy 已启动`);
  console.log(` 本机访问: http://127.0.0.1:${PORT}`);
  console.log(` 局域网访问: http://<本机IP>:${PORT}`);
  console.log(` 服务器版本: ${SERVER_VERSION}`);
  console.log("==============================================");
});

async function shutdown() {
  for (const client of clients.values()) {
    if (client.session) {
      await client.session.stop().catch(() => {});
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
