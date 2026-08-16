# Web Scrcpy — 浏览器串流控制安卓设备

在浏览器中通过局域网串流并控制安卓手机 / 安卓模拟器(虚拟机),基于官方
[scrcpy](https://github.com/Genymobile/scrcpy)(v4.1)服务端与协议实现。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. 通过 Web 连接局域网安卓手机/模拟器 | 服务端封装 `adb`:`adb devices` 列表、`adb connect ip:port` 无线连接、模拟器自动识别;浏览器页面通过 WebSocket 接收视频流、发送控制指令 |
| 2. 可选视频编码格式 | H.264 / H.265(HEVC)可选,下拉切换,运行中可热切换(重启编码器) |
| 3. 浏览器原生解码 + 自定义 JS 解码 | 解码器注册表:`WebCodecs`(原生)、`MediaSource+jmuxer`(原生回退)、**自定义 JS/WASM 解码**:H.264 → Broadway(纯 JS),H.265 → libde265(WASM),均不依赖浏览器原生解码;支持「自动选择」与手动指定 |
| 4. 按键展示帧数/传输速率等 | `Ctrl+Shift+i`(Mac:`Cmd+Shift+i`)呼出统计面板:解码帧率、传输速率(kbps/Mbps)、接收包数/总量、端到端延迟(RTT)、分辨率、编码格式、解码器;`Ctrl+Shift+h` 查看全部快捷键 |
| 5. 标准码率档位 + 自定义码率 | 预设 1 / 2 / 4 / 8 / 16 Mbps 五档(快捷键 `Ctrl+Shift+1~5`),另有自定义码率输入框(`Ctrl+Shift+0` 聚焦),运行中即时生效 |
| 6. 多人在线 | 每个浏览器标签页是独立客户端,服务端按 WebSocket 连接隔离会话,可同时多人各自串流不同设备/参数 |
| 7. 码率严格限制 | H.264/H.265 强制 CBR(bitrate-mode=2),编码器在超码率时自动降低量化质量;桥端实时统计实际码率,持续超过档位时**自动下调编码目标码率(降画质)**,有余量再恢复 |
| 8. 解码能力检测 | 内置检测:切换编码时自动提示该编码在 WebCodecs/MediaSource/自定义JS 各后端的支持情况;「🔍 检测解码能力」按钮显示完整报告 |

## 架构

```
┌─────────────┐   WebSocket(视频流/控制消息)       ┌─────────────────────┐
│   浏览器      │ ───────────────────────────────▶ │  Node.js 桥(本机)    │
│ WebCodecs/  │ ◀─────────────────────────────── │  · HTTP 静态+API     │
│ MSE/JS-WASM │   原始 scrcpy 控制消息(binary)    │  · 多客户端会话管理  │
│ +JS解码      │                                │  · 视频帧解复用      │
└─────────────┘                                └──────────┬──────────┘
                                                          │ adb push / reverse / shell
                                               ┌──────────▼──────────┐
                                               │  安卓设备(手机/模拟器) │
                                               │  scrcpy-server.jar  │
                                               └─────────────────────┘
```

- 服务端复用官方 `scrcpy-server.jar`(v4.1,已内置在 `bin/`),通过
  `adb reverse localabstract:scrcpy_<scid>` 建立隧道,再以
  `app_process` 启动设备端服务器 —— 与官方 scrcpy 客户端完全一致。
- 设备端建立 **2 条连接**:video → control(仅传输画面,不含音频)。
- 视频 socket 帧格式(与 scrcpy 4.x `Streamer.java` / `demuxer.c` 逐字节核对):
  64 字节设备名 → 4 字节 codec id → 12 字节 session 头(宽高)→
  12 字节帧头(PTS + config/key 标志)+ 负载。
  桥解析后按 `[stream 1B][flags 1B][payload]` 转发给浏览器
  (stream:0=视频)。
- 控制消息(触摸/按键/滚轮/剪贴板等)浏览器按 scrcpy 控制协议编码为二进制,
  经桥原样写回设备;设备→浏览器的剪贴板同步消息也被解析转发。

## 快速开始

依赖:Node.js ≥ 18、`adb`(Android Platform Tools,已加入 PATH)。

```bash
# 1. 安装依赖
npm install

# 2. (可选)重新下载 scrcpy 服务器与前端资源
npm run fetch        # 自动下载 scrcpy-server.jar、Broadway、jmuxer

# 3. 启动
npm start            # 默认 0.0.0.0:8080
```

启动后:
- 本机打开 <http://127.0.0.1:8080>
- 同一局域网的其他电脑打开 `http://<本机IP>:8080` 即可

### 准备设备

**安卓模拟器(虚拟机)**:启动模拟器后自动出现在设备列表,直接选择即可。

**安卓手机(局域网无线)**:

1. 手机与电脑处于同一局域网。
2. Android 11+:手机「开发者选项 → 无线调试 → 使用配对码配对设备」;
   或 Android 10 及以下:先用 USB 连接电脑执行 `adb tcpip 5555`,再拔线。
3. 在页面左侧「设备连接」填入手机 IP(端口默认 5555),点击「连接」。
4. 首次连接时在手机上确认授权弹窗。

### 使用

1. 选择设备 → 配置「编码格式 / 解码方式 / 码率 / 分辨率 / 帧率」→ 点击「开始串流」。
2. 在画布上点击后即可用鼠标/触摸/键盘操作设备;普通按键直接输入到设备。
3. 运行中修改编码/码率/分辨率会**自动重启串流**(约 1~2 秒)。
4. 工具栏可:旋转、返回、Home、最近任务、同步剪贴板、截图、全屏。

### 快捷键(MOD = Ctrl+Shift,Mac 为 Cmd+Shift)

| 按键 | 功能 |
| --- | --- |
| `MOD + i` | 显示/隐藏统计面板(帧率、传输速率、延迟) |
| `MOD + h` | 快捷键帮助 |
| `MOD + f` | 全屏 |
| `MOD + r` | 设备旋转 90° |
| `MOD + s` | 截图(PNG) |
| `MOD + b` / `MOD + Home` / `MOD + End` | 设备返回 / Home / 最近任务 |
| `MOD + u` | 设备屏幕开关 |
| `MOD + n` / `MOD + e` / `MOD + c` | 通知栏 / 快捷设置 / 收起面板 |
| `MOD + 1~5` | 切换码率档位(1/2/4/8/16 Mbps) |
| `MOD + 0` | 聚焦自定义码率输入框 |
| `MOD + ↑/↓` | 音量 +/− |
| `Esc` | 关闭面板 / 退出全屏 |

## 部署指南

### 安装系统依赖(Linux)

需要:**Node.js ≥ 18**(含 npm)、**adb**(见下文「安装 adb」)、`git`(可选,用于拉取代码)。

**Ubuntu/Debian**:

```bash
apt install -y nodejs npm git
node -v    # 验证 Node ≥ 18
```

**系统源 Node 版本过旧时**,用官方源升级(仅 Debian/Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

**Alpine Linux**:

```bash
apk add nodejs npm git
node -v    # 验证 Node ≥ 18
```


### 安装 adb(必需)

项目**依赖 `adb`**(Android Platform Tools)执行设备连接、推送 scrcpy 服务器、建立隧道等操作,服务器上必须安装并加入 PATH:

**Ubuntu/Debian**(简单,但系统源版本可能较旧):

```bash
apt install -y android-tools-adb
adb version   # 验证
```

**Alpine Linux**:

```bash
apk add android-tools
adb version   # 验证
```

**官方 Platform Tools**(推荐,版本最新):

```bash
# 从 https://developer.android.com/tools/releases/platform-tools 下载 linux 版
unzip platform-tools-latest-linux.zip -d /opt
ln -s /opt/platform-tools/adb /usr/local/bin/adb
adb version   # 验证
```

如 adb 不在 PATH(例如 systemd 服务的 PATH 较精简),可用 `ADB_PATH` 环境变量指定完整路径:

```ini
Environment=ADB_PATH=/opt/platform-tools/adb
```

### 运行方式

**开发 / 局域网直连**(最简单):

```bash
# 1. 拉取项目
git clone https://github.com/Potccv/web-scrcpy.git
cd web-scrcpy

# 2. 安装依赖并启动
npm install
npm start                 # 默认监听 0.0.0.0:8080
PORT=xxxx npm start       # 自定义端口(xxxx 替换为实际端口)
```

同一局域网的其他设备访问 `http://<本机IP>:端口` 即可(手机配好 adb 无线调试)。


### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADB_PATH` | `adb`(PATH 中) | adb 可执行文件路径(可选) |

**生产部署**(建议):systemd 服务 + nginx 反向代理 + HTTPS,见下文。

### systemd 服务示例

`/etc/systemd/system/web-scrcpy.service`:

```ini
[Unit]
Description=Web Scrcpy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/web-scrcpy
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now web-scrcpy
```

### Alpine Linux(OpenRC)服务示例

Alpine 默认使用 **OpenRC**(无 systemd)。

OpenRC 服务脚本 `/etc/init.d/web-scrcpy`:

```sh
#!/sbin/openrc-run

name="Web Scrcpy"
command="/usr/bin/node"
command_args="/opt/web-scrcpy/server/index.mjs"
command_background="yes"
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/web-scrcpy.log"
error_log="/var/log/web-scrcpy.log"


depend() {
    need net
}
```

```bash
chmod +x /etc/init.d/web-scrcpy
rc-update add web-scrcpy default
rc-service web-scrcpy start
rc-service web-scrcpy status
```

> nginx 在 Debian/Ubuntu 上配置文件位于 `/etc/nginx/sites-available/`(或 `/etc/nginx/nginx.conf`);
> nginx 在 Alpine 上配置文件位于 `/etc/nginx/http.d/`(或 `/etc/nginx/nginx.conf`)


### nginx 反向代理(HTTPS + WebSocket)

> **必须用 HTTPS**:WebCodecs 是 Secure Context 专用 API,http 下不可用;
> 串流是长连接,代理超时需调大;`/ws` 需转发 WebSocket 升级头。

```nginx
server {
    listen 80;
    server_name scrcpy.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name scrcpy.example.com;
    ssl_certificate         /path/fullchain.cer;
    ssl_certificate_key     /path/example.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;     # 串流长连接,默认 60s 会断
        proxy_send_timeout 3600s;
    }
}
```

`nginx -t && nginx -s reload` 生效。

### 录制文件管理

- 服务端录制输出到 `tmp/recordings/`(已 gitignore),浏览器下载后文件仍保留在服务器。
- **自动清理**:文件保留 **7 天**,总量超 **2GB** 时删除最旧的;服务启动、每次录制结束、每 6 小时各清理一次。
- **磁盘保护**:剩余空间 < 1GB 时向所有在线客户端发送警告;剩余 < 300MB 时拒绝开始新录制。
- 调整策略:修改 `server/recorder.mjs` 的 `cleanupRecordings()` 参数与 `server/index.mjs` 的阈值。

### 常见部署问题

- **页面能开但点"开始"无反应**:多半是 `/ws` 未转发 WebSocket 升级头,或代理超时被断(见上)。
- **选 WebCodecs 报"无法解码"**:确认通过 **HTTPS 访问**(http 下 WebCodecs 不可用);H.265 需浏览器硬件支持,可改用「自定义JS」解码。
- **IDM 等下载工具报 SSL 错误**:下载用 HTTPS 且证书需完整(fullchain);IDM 需在「连接 → SSL」取消"验证服务器证书"。
- **防火墙**:生产环境需放行 HTTP/HTTPS 端口;同一局域网直连需放行服务端口。

## 解码方式说明

| 解码器 | 说明 | 适用编码 |
| --- | --- | --- |
| WebCodecs(原生) | `VideoDecoder`,性能最好、延迟最低 | H.264/H.265(以 `isConfigSupported` 探测) |
| MediaSource(原生回退) | `MediaSource` + jmuxer(fMP4 封装) | 主要是 H.264(H.265 见 Safari) |
| 自定义 JS/WASM 解码 | **纯 JS/WASM,不依赖浏览器原生解码**:H.264 → Broadway,H.265 → libde265(`@yume-chan/libde265`) | H.264 + H.265(建议 ≤720p) |

- 「自动选择」按 WebCodecs → MediaSource → 自定义 JS 的优先级挑选可用后端。
- 选择「自定义JS解码」时,编码格式限定为 H.264/H.265;H.264 会强制编码端
  Baseline profile(Broadway 仅支持 Baseline),H.265 无需额外参数。
- **H.265 低延迟**:libde265 解码在 **Web Worker** 中执行(不阻塞 UI),并带
  **积压丢帧控制** —— 解码跟不上输入时清空队列、重置解码器并等待下一个关键帧,
  防止延迟无限累积(参考 [h265web.js](https://github.com/numberwolf/h265web.js)
  的 worker 解码 + 丢帧思路);YUV→RGB 转换也在 Worker 中完成。
- **渲染节流**:所有解码器只渲染最新一帧(丢中间帧),解码/转换再快也不会让
  主线程渲染积压 —— **对端延迟高时,网页点击/键盘操作延迟始终正常**。
- 想接入其他解码器,按 `public/js/decoders/*.js` 的接口(构造
  `{codec,canvas,onFrame,onError}`、`init(meta)`、`feedPacket({flags,data})`、
  `destroy()`)实现并在 `decoders/index.js` 注册即可。

## 码率限制

- 选择码率档位后,H.264/H.265 编码强制 **CBR**(`bitrate-mode=2`):编码器在
  内容复杂、目标码率不足时通过降低量化质量(画质)来贴近码率上限。
- 桥端每秒统计实际转发码率,若持续超过档位约 20%:**自动下调编码目标码率**
  (降画质),并通知浏览器(状态栏显示 `≤X Mbps(已限)`,统计面板显示目标/实际);
  码率有余量时自动恢复。自动调整不会改变你选择的档位。
- 自定义码率同样受此硬限制约束。

## 多人同时使用

- 每个浏览器标签页/窗口都是一个独立客户端:服务端按 WebSocket 连接隔离会话,
  视频流、控制消息、参数切换互不干扰。
- 多个人可以同时连同一台设备(设备端会运行多个 scrcpy 实例)或不同设备;
  服务端状态接口(`/api/status`)会列出所有活跃会话。
- 关闭标签页会自动释放其占用的设备会话。

## 常见问题

- **提示无法执行 adb**:请安装 Android Platform Tools 并加入 PATH,重启服务。
- **设备列表为空**:确认手机已开启无线调试并接受授权;模拟器请确认已启动。
- **H.265 无法启动**:设备端缺少对应硬件编码器(模拟器常见),请改用 H.264。
- **画面不出来**:浏览器解码能力不足时,尝试切换解码方式
  (H.264 + 自定义JS解码 通常都能跑);或降低分辨率/帧率。
- **卡顿**:降低码率档位或分辨率,使用 WebCodecs 解码,手机靠近路由器。
- **多标签页**:同一时间只允许一个串流客户端。

## 目录结构

```
bin/                    scrcpy-server.jar + 版本号(fetch 脚本生成)
shared/                 服务端/浏览器共享的协议模块(控制消息、视频帧解析)
server/                 Node.js 桥:index(HTTP/WS/多客户端)、adb、session(会话)
public/                 前端
  js/                   app(主逻辑)、input(输入转发)、stats(统计)、hotkeys、
                        nal(H.264/HEVC 参数集解析)
  js/decoders/          解码器注册表:webcodecs / mse / broadway(h264) / libde265(h265)
  vendor/               Broadway、libde265、jmuxer
tools/                  fetch-scrcpy-server.mjs、fetch-vendors.mjs
test/                   单元测试 + 端到端冒烟测试(含 mock 设备)
```

## 测试

```bash
npm test   # 30 个测试:协议字节级编码、视频帧解析、SPS 解析、端到端冒烟
```

端到端测试使用 `test/mock-adb` 模拟 adb 与安卓设备(推送合成 H.264 流),
无需真机即可验证完整链路。

### 真机验证记录

已在局域网设备(redroid13 arm64 / Android 13)实测通过:

- H.264 / H.265 串流均成功(1280x720,config+关键帧+delta 包完整,SPS 解析分辨率与元数据一致)
- **H.265 解码**:抓取真机 h265 码流(331 包)在 Node 中经 libde265 实测解码出 327 帧,无错误
- **码率限制**:启动参数确认 `video_codec_options=bitrate-mode=2`(CBR)生效
- **多人并发**:两个客户端同时串流互不干扰,会话独立启停(2→1→0),ping/pong 正常
- 运行中热切换:码率 8M→4M、分辨率调整,均自动重启并恢复
- 控制消息(触摸/按键)往返无错误;设备端编码器支持情况由「检测解码能力」与启动时的服务器日志提示
- 真机测试中发现并修复三个 mock 环境测不出的问题:
  1. `scid` 随机数超过 `int` 上限导致设备端 `Integer.parseInt` 崩溃 → 限制为 31 位
  2. 服务器默认 `cleanup=true` 会在退出时删除设备端 jar,与桥的重新 push 产生竞态 → 启动参数加 `cleanup=false`

真机串流测试脚本见 `tmp/real-device-test.mjs`(h265、双客户端)与
`tmp/stream-test.mjs`(主流程)。

## 说明

- 本项目基于 scrcpy 的开源协议实现(scrcpy 4.x,MPL-2.0),服务端复用官方
  `scrcpy-server.jar`;前端解码器 Broadway(MIT)与 jmuxer(MIT)。
- 仅建议在可信局域网内使用,服务未内置鉴权。
- 本项目由DeepSeekv4Flash0731全权开发
