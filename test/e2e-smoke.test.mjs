/**
 * test/e2e-smoke.test.mjs — 端到端冒烟测试(使用 test/mock-adb 模拟设备)。
 *
 * 验证:静态/API → WS 会话生命周期 → adb 隧道 → 视频/音频流解复用 → 转发 →
 * 控制消息回写 → 运行中参数切换 → 双客户端隔离。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import { encodeTouchEvent, TouchAction } from "../shared/protocol.js";
import { StreamType } from "../shared/video-stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MOCK_ADB = path.join(__dirname, "mock-adb");
const RECORD_FILE = path.join(os.tmpdir(), "wsscrcpy-mock-control.bin");

let server;
let port;
let serverOutput = "";

before(async () => {
  fs.rmSync(RECORD_FILE, { force: true });
  port = 18080 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
    env: { ...process.env, PORT: String(port), ADB_PATH: MOCK_ADB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverOutput += String(d)));
  server.stderr.on("data", (d) => (serverOutput += String(d)));
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    return res.ok;
  }, 15000);
});

after(() => {
  server && server.kill("SIGKILL");
});

function waitFor(fn, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch {}
      if (Date.now() - start > timeout) return reject(new Error("waitFor 超时"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function postJson(p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function connectWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const video = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) video.push(Buffer.from(data));
    else messages.push(JSON.parse(data.toString()));
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages, video }));
    ws.on("error", reject);
  });
}

async function startSession(client, extra = {}) {
  const c = await connectWs();
  c.ws.send(
    JSON.stringify({
      type: "start",
      serial: "emulator-5554",
      codec: "h264",
      bitrate: 8_000_000,
      maxSize: 0,
      maxFps: 0,
      codecOptions: "",
      ...extra,
    })
  );
  await waitFor(
    () => c.messages.some((m) => m.type === "meta" && m.codec === "h264" && m.width === 1280 && m.height === 720),
    15000
  );
  return c;
}

test("静态页面与共享模块可访问", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Web Scrcpy"));
  for (const u of ["/js/app.js", "/js/decoders/libde265.js", "/shared/protocol.js", "/vendor/libde265/libde265.mjs", "/vendor/libde265/libde265.wasm", "/avc.wasm"]) {
    const r = await fetch(`http://127.0.0.1:${port}${u}`);
    assert.equal(r.status, 200, u);
  }
});

test("设备列表 API", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const json = await res.json();
  assert.equal(json.adb, null);
  assert.ok(json.devices.some((d) => d.serial === "emulator-5554" && d.state === "device"));
});

test("会话启动 → 视频/音频流转发 → 控制消息回写 → 停止", async () => {
  const c = await startSession();

  // 视频:config + 关键帧
  await waitFor(() => c.video.length >= 3, 15000);
  const first = c.video[0];
  assert.equal(first[0], StreamType.VIDEO);
  assert.equal(first[1] & 0x01, 0x01); // config(SPS/PPS)
  assert.ok(c.video.some((b) => b[1] & 0x02), "应存在关键帧包");

  // 控制消息回写
  const touch = encodeTouchEvent(TouchAction.DOWN, 1n, 100, 200, 1280, 720, 1, 0, 0);
  c.ws.send(touch);
  const touchBytes = Array.from(touch);
  const contains = (r) => {
    for (let i = 0; i + touchBytes.length <= r.length; i++) {
      let ok = true;
      for (let j = 0; j < touchBytes.length; j++) {
        if (r[i + j] !== touchBytes[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  await waitFor(() => fs.existsSync(RECORD_FILE) && contains(fs.readFileSync(RECORD_FILE)), 5000);

  // 设备剪贴板推送
  await waitFor(() => c.messages.some((m) => m.type === "deviceMsg" && m.kind === "clipboard"), 5000);
  const clip = c.messages.find((m) => m.type === "deviceMsg" && m.kind === "clipboard");
  assert.equal(clip.text, "mock-clipboard");

  // 停止
  c.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => c.messages.some((m) => m.type === "state" && m.state === "stopped"), 8000);
  c.ws.close();

  // 等待服务端会话清理完成
  await waitFor(async () => {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    return st.sessions.length === 0;
  }, 8000);
});

test("运行中切换码率(会话重启)", async () => {
  const c = await startSession();
  await waitFor(() => c.video.length >= 1, 15000);

  const before = c.messages.length;
  c.ws.send(JSON.stringify({ type: "config", bitrate: 4_000_000 }));
  await waitFor(() => {
    const ri = c.messages.findIndex((m, i) => i > before && m.type === "state" && m.state === "restarting");
    if (ri < 0) return false;
    return c.messages.some((m, i) => i > ri && m.type === "state" && m.state === "connected");
  }, 20000);
  const ri = c.messages.findIndex((m) => m.type === "state" && m.state === "restarting");
  assert.ok(ri >= before, "应收到 restarting 状态");
  assert.ok(c.messages.some((m) => m.type === "state" && m.state === "connected"), "应恢复 connected");
  const metaAfter = c.messages.filter((m) => m.type === "meta" && m.codec === "h264" && m.width === 1280);
  assert.ok(metaAfter.length >= 2, "重启后应再次收到 meta");

  c.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => c.messages.some((m) => m.type === "state" && m.state === "stopped"), 8000);
  c.ws.close();
  await waitFor(async () => {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    return st.sessions.length === 0;
  }, 8000);
});

test("双客户端同时串流互不干扰", async () => {
  const c1 = await startSession({ bitrate: 6_000_000 });
  const c2 = await startSession({ bitrate: 2_000_000 });

  // 两个客户端都收到自己的视频
  await waitFor(() => c1.video.length >= 2 && c2.video.length >= 2, 15000);
  const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(st.sessions.length, 2, "应有两个活跃会话");

  // 关闭 c1,会话数应降为 1,c2 不受影响
  c1.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(async () => {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    return s.sessions.length === 1;
  }, 8000);
  const v2before = c2.video.length;
  await waitFor(() => c2.video.length > v2before, 5000);
  assert.ok(c2.messages.some((m) => m.type === "meta" && m.width === 1280), "c2 视频流仍在运行");

  c2.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => c2.messages.some((m) => m.type === "state" && m.state === "stopped"), 8000);
  c1.ws.close();
  c2.ws.close();
  await waitFor(async () => {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    return s.sessions.length === 0;
  }, 8000);
});
