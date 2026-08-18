/**
 * server/adb.mjs — adb 命令行封装。
 * 所有命令使用参数数组形式执行,避免 shell 注入;spawn 的 shell 命令除外。
 */
import { execFile, spawn } from "node:child_process";

const ADB = process.env.ADB_PATH || "adb";

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout: opts.timeout || 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err.code ?? 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export function adbPath() {
  return ADB;
}

/** 确保 adb 服务可用;返回错误信息或 null */
export async function checkAdb() {
  const r = await run(["version"]);
  if (r.code !== 0) {
    return `无法执行 adb(${ADB}):${r.stderr.trim() || r.stdout.trim() || "未安装"}。请先安装 Android Platform Tools 并加入 PATH。`;
  }
  return null;
}

/**
 * 解析 `adb devices -l` 输出。
 * 返回 [{ serial, state, product, model, device, transportId }]
 */
export async function listDevices() {
  const r = await run(["devices", "-l"]);
  if (r.code !== 0) {
    throw new Error(`adb devices 失败:${r.stderr.trim() || r.stdout.trim()}`);
  }
  const devices = [];
  const lines = r.stdout.split("\n").slice(1); // 跳过 "List of devices attached"
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const device = { serial: parts[0], state: parts[1] };
    for (let i = 2; i < parts.length; i++) {
      const [k, v] = parts[i].split(":");
      if (k && v !== undefined) device[k] = v;
    }
    devices.push(device);
  }
  return devices;
}

/** adb connect host:port */
export async function connect(host, port) {
  const target = port ? `${host}:${port}` : host;
  const r = await run(["connect", target], { timeout: 15000 });
  const out = (r.stdout + r.stderr).trim();
  return { ok: r.code === 0 && /connected|already connected/i.test(out), message: out };
}

export async function disconnect(serial) {
  const r = await run(["disconnect", serial]);
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

export async function push(serial, localPath, remotePath) {
  const r = await run(["-s", serial, "push", localPath, remotePath], { timeout: 60000 });
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

export async function reverse(serial, localAbstract, tcpPort) {
  const r = await run(["-s", serial, "reverse", `localabstract:${localAbstract}`, `tcp:${tcpPort}`]);
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

export async function reverseRemove(serial, localAbstract) {
  const r = await run(["-s", serial, "reverse", "--remove", `localabstract:${localAbstract}`]);
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

export async function getprop(serial, name) {
  const r = await run(["-s", serial, "shell", "getprop", name]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * 获取设备当前显示分辨率(wm size)。
 * 返回 { ok, width, height, raw }。
 */
export async function getDisplaySize(serial) {
  const r = await run(["-s", serial, "shell", "wm", "size"], { timeout: 10000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (!m) {
    return { ok: false, width: 0, height: 0, raw: text, message: "无法获取设备分辨率" };
  }

  // 尝试读取当前屏幕方向:0/2=竖屏,1/3=横屏
  let orientation = null;
  try {
    const o = await run(["-s", serial, "shell", "dumpsys", "input"], { timeout: 10000 });
    const om = o.stdout.match(/SurfaceOrientation:\s*(\d+)/);
    if (om) orientation = Number(om[1]);
  } catch {}

  let width = Number(m[1]);
  let height = Number(m[2]);
  // 如果系统报告横屏但 wm size 仍是竖屏尺寸,则交换宽高
  if ((orientation === 1 || orientation === 3) && width < height) {
    [width, height] = [height, width];
  }

  return { ok: true, width, height, orientation, raw: text };
}

/**
 * 查询设备支持的视频编码器(scrcpy list_encoders)。
 * 返回 { ok, codecs, encoders, raw, message }。
 */
export async function listEncoders(serial, { serverJar, version = "4.1" } = {}) {
  const remotePath = "/data/local/tmp/scrcpy-server.jar";
  if (serverJar) {
    const p = await push(serial, serverJar, remotePath);
    if (!p.ok) {
      return { ok: false, codecs: [], encoders: [], message: `推送 scrcpy-server 失败:${p.message}` };
    }
  }

  const r = await run(
    [
      "-s",
      serial,
      "shell",
      `CLASSPATH=${remotePath}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      version,
      "list_encoders=true",
      "log_level=info",
    ],
    { timeout: 20000 }
  );

  const text = `${r.stdout}\n${r.stderr}`;
  const codecs = [];
  const encoders = [];
  for (const line of text.split("\n")) {
    const m = line.match(/--video-codec=([a-z0-9]+)/);
    if (m) {
      const codec = m[1];
      if (!codecs.includes(codec)) codecs.push(codec);
      const enc = line.match(/--video-encoder=([^\s]+)/);
      if (enc) encoders.push({ codec, encoder: enc[1], line: line.trim() });
    }
  }

  return {
    ok: r.code === 0 || codecs.length > 0,
    codecs,
    encoders,
    raw: text,
    message: r.code === 0 ? "" : r.stderr.trim() || r.stdout.trim(),
  };
}

/**
 * 在设备上启动 scrcpy 服务器(app_process)。
 * 返回子进程;stdout/stderr 为服务器日志。
 */
export function spawnServer(serial, args) {
  const shellArgs = [
    "-s",
    serial,
    "shell",
    "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    ...args,
  ];
  return spawn(ADB, shellArgs, { stdio: ["ignore", "pipe", "pipe"] });
}
