/**
 * tools/fetch-vendors.mjs — 下载前端第三方资源。
 *
 * - Broadway 自定义 JS 解码器(https://github.com/mbebenita/Broadway,MIT)
 *   注意:Broadway 通过相对路径 fetch('avc.wasm') 加载 wasm(相对于页面),
 *   因此 avc.wasm 同时复制到站点根目录 public/avc.wasm。
 * - jmuxer(MediaSource 回退解码的 fMP4 封装器,https://github.com/samirkumardas/jmuxer,MIT)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "public", "vendor");

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url}:HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`${path.relative(ROOT, dest)} (${buf.length} 字节)`);
  return buf;
}

async function main() {
  const BROADWAY = "https://raw.githubusercontent.com/mbebenita/Broadway/master/Player";
  await download(`${BROADWAY}/Decoder.js`, path.join(VENDOR, "broadway", "Decoder.js"));
  await download(`${BROADWAY}/avc.wasm`, path.join(VENDOR, "broadway", "avc.wasm"));
  // Broadway 以页面相对路径 fetch('avc.wasm'),复制一份到站点根目录
  fs.copyFileSync(path.join(VENDOR, "broadway", "avc.wasm"), path.join(ROOT, "public", "avc.wasm"));
  console.log("public/avc.wasm (复制,供 Broadway 加载)");

  const tarball = "https://registry.npmjs.org/jmuxer/-/jmuxer-2.1.1.tgz";
  const tmp = path.join(ROOT, "tmp-jmuxer.tgz");
  await download(tarball, tmp);
  // 解压后取 dist/jmuxer.min.js
  const { execFileSync } = await import("node:child_process");
  const tmpDir = path.join(ROOT, "tmp-jmuxer");
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync("tar", ["-xzf", tmp, "-C", tmpDir]);
  fs.copyFileSync(path.join(tmpDir, "package", "dist", "jmuxer.min.js"), path.join(VENDOR, "jmuxer.min.js"));
  console.log(`public/vendor/jmuxer.min.js (${fs.statSync(path.join(VENDOR, "jmuxer.min.js")).size} 字节)`);
  fs.rmSync(tmp, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // libde265(H.265 自定义 JS 解码器,https://github.com/yume-chan/libde265,MIT)
  const libdir = path.join(VENDOR, "libde265");
  fs.mkdirSync(libdir, { recursive: true });
  const ltarball = `https://registry.npmjs.org/@yume-chan/libde265/-/libde265-${process.env.LIBDE265_VERSION || "1.0.0"}.tgz`;
  const ltmp = path.join(ROOT, "tmp-libde265.tgz");
  await download(ltarball, ltmp);
  const ltmpDir = path.join(ROOT, "tmp-libde265");
  fs.mkdirSync(ltmpDir, { recursive: true });
  execFileSync("tar", ["-xzf", ltmp, "-C", ltmpDir]);
  fs.copyFileSync(path.join(ltmpDir, "package", "libde265.mjs"), path.join(libdir, "libde265.mjs"));
  fs.copyFileSync(path.join(ltmpDir, "package", "libde265.wasm"), path.join(libdir, "libde265.wasm"));
  console.log("public/vendor/libde265/ (libde265.mjs + libde265.wasm,H.265 解码器)");
  fs.rmSync(ltmp, { force: true });
  fs.rmSync(ltmpDir, { recursive: true, force: true });

  // opus-decoder 已移除:音频采用 QtScrcpy 同款 PCM 直传方案(audio_codec=raw),
  // 播放端自写 s16→f32 转换,不再需要 libopus WASM 解码器。
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
