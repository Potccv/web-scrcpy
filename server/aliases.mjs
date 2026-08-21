/**
 * server/aliases.mjs — 设备别名服务端持久化。
 *
 * 别名以 JSON 文件保存在服务器本地(tmp/device-aliases.json),
 * 所有访问同一服务端的用户共享同一份别名。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_FILE = path.join(__dirname, "..", "tmp", "device-aliases.json");

function readAliases() {
  try {
    const data = JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

let aliases = readAliases();

function persistAliases() {
  fs.mkdirSync(path.dirname(ALIASES_FILE), { recursive: true });
  fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
}

/** 返回当前全部别名副本:{ serial: alias } */
export function getAliases() {
  return { ...aliases };
}

/**
 * 设置或清除设备别名。
 * @param {string} serial 设备序列号
 * @param {string} [alias] 别名;空字符串/undefined 表示清除
 * @returns {{ [serial: string]: string }} 更新后的全部别名
 */
export function setAlias(serial, alias) {
  const key = String(serial).trim();
  if (!key) throw new Error("缺少设备序列号");

  const name = typeof alias === "string" ? alias.trim() : "";
  if (name) {
    aliases[key] = name;
  } else {
    delete aliases[key];
  }

  persistAliases();
  return getAliases();
}
