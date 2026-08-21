/**
 * server/session.mjs — scrcpy 会话生命周期。
 *
 * 流程(与 scrcpy 4.x server.c 的默认 reverse 隧道一致):
 *   1. adb push server.jar 到设备
 *   2. 本地监听 127.0.0.1:0,取随机端口
 *   3. adb reverse localabstract:scrcpy_<scid> tcp:<本地端口>
 *   4. adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server <版本> <参数...>
 *   5. 接受两条连接:第 1 条 = video,第 2 条 = control(仅传输画面,不含音频)
 *   6. video socket:读 64 字节设备名 → 帧格式解析(codec id → session → packets)
 *   7. control socket:双向转发(设备 → 浏览器原始字节;浏览器 → 设备原始字节)
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoStreamParser } from "../shared/video-stream.js";
import { encodeBackOrScreenOn } from "../shared/protocol.js";
import * as adb from "./adb.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";
const DEVICE_NAME_FIELD_LENGTH = 64;
const ACCEPT_TIMEOUT_MS = 30_000;

function randomScid() {
  // 设备端 Options.parse 用 Integer.parseInt(十进制),scid 必须 ≤ 2^31-1
  return Math.floor(Math.random() * 0x80000000).toString(16).padStart(8, "0");
}

/** 校验服务器参数,禁止 shell 特殊字符(与 scrcpy validate_string 一致) */
function validateParam(s) {
  if (/[ ;'"*$?&`#\\|<>[\]{}()!~\r\n]/.test(s)) {
    throw new Error(`非法的服务器参数:${s}`);
  }
}

export class ScrcpySession {
  /**
   * @param {object} opts
   * @param {string} opts.serial 设备序列号
   * @param {string} opts.version scrcpy 服务器版本(必须与 jar 一致)
   * @param {string} [opts.serverJar] 本地 jar 路径
   * @param {string} [opts.codec] h264/h265/av1
   * @param {number} [opts.bitrate]
   * @param {number} [opts.maxSize] 0 = 原始
   * @param {number} [opts.maxFps] 0 = 不限制
   * @param {string} [opts.codecOptions] 逗号分隔的 key=value 编码器参数
   * @param {(evt: object) => void} opts.onEvent
   */
  constructor(opts) {
    this.serial = opts.serial;
    this.version = opts.version;
    this.serverJar = opts.serverJar || path.join(__dirname, "..", "bin", "scrcpy-server.jar");
    this.params = {
      codec: opts.codec || "h264",
      bitrate: opts.bitrate || 8_000_000,
      maxSize: opts.maxSize || 0,
      maxFps: opts.maxFps || 0,
      codecOptions: opts.codecOptions || "",
    };
    this.onEvent = opts.onEvent || (() => {});
    this.started = false;
    this.scid = null;
    this.localServer = null;
    this.localPort = 0;
    this.child = null;
    this.videoSocket = null;
    this.controlSocket = null;
    this.videoParser = null;
    this.serverLogs = [];
    this._acceptTimer = null;
    this._stopping = false;
    this._videoBuffer = Buffer.alloc(0);
    this._controlBuffer = Buffer.alloc(0);
    this._deviceNameRead = false;
    this.sdkInt = null;
  }

  get codec() {
    return this.params.codec;
  }

  _emit(evt) {
    try {
      this.onEvent(evt);
    } catch (err) {
      // 事件回调异常不应影响会话
    }
  }

  _log(message) {
    this._emit({ type: "log", message });
  }

  /** 修改会话参数(下次 restart 生效) */
  setParams(patch) {
    Object.assign(this.params, patch);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this._stopping = false;
    this.scid = randomScid();

    try {
      await this._pushServer();
      await this._openTunnel();
      await this._detectSdk();
      this._spawnServerProcess();
      await this._acceptConnections();
      // 点亮设备屏幕(与 scrcpy power_on 行为一致)
      this.sendControl(encodeBackOrScreenOn(0));
      this._log(`会话已连接:${this.serial} codec=${this.params.codec} bitrate=${this.params.bitrate}`);
    } catch (err) {
      this.started = false;
      await this._cleanup();
      this._emit({ type: "error", message: err.message });
      throw err;
    }
  }

  async _pushServer() {
    const r = await adb.push(this.serial, this.serverJar, DEVICE_SERVER_PATH);
    if (!r.ok) {
      throw new Error(`推送服务器到设备失败:${r.message}`);
    }
  }

  async _openTunnel() {
    this.localServer = net.createServer();
    await new Promise((resolve, reject) => {
      this.localServer.once("error", reject);
      this.localServer.listen(0, "127.0.0.1", () => {
        this.localServer.removeListener("error", reject);
        resolve();
      });
    });
    this.localPort = this.localServer.address().port;
    this._connections = [];
    this.localServer.on("connection", (socket) => {
      this._connections.push(socket);
      this._maybeDispatch();
    });

    const name = `scrcpy_${this.scid}`;
    // 清理可能残留的 reverse
    await adb.reverseRemove(this.serial, name);
    const r = await adb.reverse(this.serial, name, this.localPort);
    if (!r.ok) {
      throw new Error(`建立 adb reverse 隧道失败:${r.message}`);
    }
  }

  async _detectSdk() {
    try {
      const sdk = await adb.getprop(this.serial, "ro.build.version.sdk");
      const n = sdk ? parseInt(sdk, 10) : NaN;
      this.sdkInt = Number.isFinite(n) ? n : null;
    } catch {
      this.sdkInt = null;
    }
  }

  _spawnServerProcess() {
    const p = this.params;
    const args = [this.version, `scid=${this.scid}`, "log_level=info"];
    args.push("video=true", `video_codec=${p.codec}`, `video_bit_rate=${p.bitrate}`);
    args.push("audio=false", "control=true"); // 仅传输画面,不含音频
    // 服务器默认 cleanup=true:正常退出时会删除设备端 jar。
    // 桥依赖 jar 常驻(重启时会先 push 再启动,删除会产生竞态),因此禁用。
    args.push("cleanup=false");
    if (p.maxSize) args.push(`max_size=${p.maxSize}`);
    if (p.maxFps) args.push(`max_fps=${p.maxFps}`);
    // 隐藏安卓系统输入法,改由网页端输入框 + 电脑输入法输入(仅 Android 10+)
    if (this.sdkInt !== null && this.sdkInt >= 29) {
      args.push("display_ime_policy=hide");
    } else if (this.sdkInt !== null) {
      this._log(`当前 Android SDK ${this.sdkInt} < 29,不支持隐藏输入法`);
    }
    if (p.codecOptions) {
      validateParam(p.codecOptions);
      args.push(`video_codec_options=${p.codecOptions}`);
    }
    args.forEach(validateParam);

    this._log(`启动服务器:app_process ${args.join(" ")}`);
    this.child = adb.spawnServer(this.serial, args);

    this.child.stdout.on("data", (d) => {
      this._onServerOutput(String(d));
    });
    this.child.stderr.on("data", (d) => {
      this._onServerOutput(String(d));
    });
    this.child.on("close", (code) => {
      this._log(`服务器进程退出(code=${code})`);
      if (!this._stopping) {
        this._emit({ type: "processExit", code });
      }
    });
  }

  /** 设备端服务器进程是否已退出 */
  get childExited() {
    return !!this.child && this.child.exitCode !== null;
  }

  _onServerOutput(text) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      this.serverLogs.push(t);
      if (this.serverLogs.length > 200) this.serverLogs.shift();
      this._emit({ type: "log", message: t });
      if (/error|exception|fatal/i.test(t)) {
        this._emit({ type: "serverError", message: t });
      }
    }
  }

  _maybeDispatch() {
    if (!this._connections) return;
    // 设备端按 video → control 顺序发起两条连接(仅画面,无音频)
    const video = this._connections[0];
    const control = this._connections[1];
    if (video && !this.videoSocket) {
      this.videoSocket = video;
      this._attachVideoSocket();
    }
    if (control && !this.controlSocket) {
      this.controlSocket = control;
      this._attachControlSocket();
    }
  }

  _attachVideoSocket() {
    this._deviceNameRead = false;
    this.videoParser = new VideoStreamParser({
      onCodecId: (codec) => {
        if (codec === null) {
          this._emit({ type: "error", message: "无法识别的视频编码(设备可能不支持所选编码)" });
        } else {
          this._emit({ type: "codec", codec });
        }
      },
      onSession: ({ width, height, clientResized }) => {
        this._emit({ type: "session", width, height, clientResized });
      },
      onPacket: ({ flags, pts, data }) => {
        this._emit({ type: "packet", flags, pts, data });
      },
      onError: (err) => {
        this._emit({ type: "error", message: err.message });
      },
    });
    // 统一的数据分发:先读完 64 字节设备名,再交给帧解析器
    this.videoSocket.on("data", (chunk) => this._onVideoData(chunk));
    this.videoSocket.on("error", () => {});
    this.videoSocket.on("close", () => {
      if (!this._stopping) {
        this._emit({ type: "disconnected", reason: "视频连接已断开" });
      }
    });
  }

  _onVideoData(chunk) {
    if (!this._deviceNameRead) {
      this._videoBuffer = this._videoBuffer.length ? Buffer.concat([this._videoBuffer, chunk]) : chunk;
      if (this._videoBuffer.length < DEVICE_NAME_FIELD_LENGTH) return;
      const name = this._videoBuffer.subarray(0, DEVICE_NAME_FIELD_LENGTH).toString("utf8").replace(/\0+$/, "");
      this._videoBuffer = this._videoBuffer.subarray(DEVICE_NAME_FIELD_LENGTH);
      this._deviceNameRead = true;
      this._emit({ type: "connected", deviceName: name });
      if (this._videoBuffer.length) {
        this.videoParser.push(this._videoBuffer);
        this._videoBuffer = Buffer.alloc(0);
      }
      return;
    }
    this.videoParser.push(chunk);
  }


  _attachControlSocket() {
    this.controlSocket.setNoDelay(true);
    this.controlSocket.on("data", (chunk) => {
      this._emit({ type: "controlData", data: chunk });
    });
    this.controlSocket.on("error", () => {});
    this.controlSocket.on("close", () => {
      if (!this._stopping) {
        this._emit({ type: "disconnected", reason: "控制连接已断开" });
      }
    });
  }

  async _acceptConnections() {
    await new Promise((resolve, reject) => {
      const check = () => {
        const done = !!this.videoSocket && !!this.controlSocket;
        if (done) {
          clearTimeout(this._acceptTimeout);
          clearInterval(this._acceptTimer);
          resolve();
        } else if (this.child && this.child.exitCode !== null) {
          clearTimeout(this._acceptTimeout);
          clearInterval(this._acceptTimer);
          const tail = this.serverLogs.slice(-10).join(" | ");
          reject(new Error(`设备端服务器提前退出:${tail || `exit code ${this.child.exitCode}`}`));
        } else if (this._stopping) {
          clearTimeout(this._acceptTimeout);
          clearInterval(this._acceptTimer);
          reject(new Error("会话已停止"));
        }
      };
      this._acceptTimer = setInterval(check, 200);
      this._acceptTimeout = setTimeout(() => {
        clearInterval(this._acceptTimer);
        const tail = this.serverLogs.slice(-10).join(" | ");
        reject(new Error(`等待设备连接超时(30s)${tail ? ":" + tail : ""}`));
      }, ACCEPT_TIMEOUT_MS);
    });
  }

  /** 向设备控制 socket 写入原始控制消息 */
  sendControl(buf) {
    if (this.controlSocket && !this.controlSocket.destroyed) {
      this.controlSocket.write(buf);
      return true;
    }
    return false;
  }

  /** 以新参数重启会话(用于切换编码/码率/分辨率) */
  async restart(patch = {}) {
    await this.stop();
    this.setParams(patch);
    await this.start();
  }

  async stop() {
    this._stopping = true;
    this.started = false;
    clearTimeout(this._acceptTimeout);
    clearInterval(this._acceptTimer);
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }
    await this._cleanup();
  }

  async _cleanup() {
    for (const socket of [this.videoSocket, this.controlSocket, ...(this._connections || [])]) {
      if (socket && !socket.destroyed) {
        try {
          socket.destroy();
        } catch {}
      }
    }
    this.videoSocket = null;
    this.controlSocket = null;
    this._connections = [];

    if (this.localServer) {
      try {
        this.localServer.close();
      } catch {}
      this.localServer = null;
    }

    if (this.scid) {
      try {
        await adb.reverseRemove(this.serial, `scrcpy_${this.scid}`);
      } catch {}
    }
  }

  destroy() {
    this.stop().catch(() => {});
  }
}
