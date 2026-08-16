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
