/**
 * tools/fetch-scrcpy-server.mjs — 下载 scrcpy 官方服务器 jar 并记录版本。
 *
 * 用法:node tools/fetch-scrcpy-server.mjs [版本号]
 * 不带参数时自动获取最新 release 版本。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BIN_DIR = path.join(ROOT, "bin");

async function getLatestVersion() {
  const res = await fetch("https://api.github.com/repos/Genymobile/scrcpy/releases/latest");
  if (!res.ok) throw new Error("获取 scrcpy 最新版本失败:HTTP " + res.status);
  const json = await res.json();
  return json.tag_name.replace(/^v/, "");
}

async function main() {
  const version = process.argv[2] || (await getLatestVersion());
  const url = `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`;
  console.log(`下载 scrcpy-server v${version} …`);
  console.log(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败:HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, "scrcpy-server.jar"), buf);
  fs.writeFileSync(path.join(BIN_DIR, "version.json"), JSON.stringify({ version }, null, 2));
  console.log(`已保存 bin/scrcpy-server.jar(${buf.length} 字节),版本 ${version}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
