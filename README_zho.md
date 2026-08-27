<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  🇨🇳 <b>简体中文</b> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 HYDRA-UMC 多机器人微工厂的无头式 API/WebSocket 后端

<p align="left">
  <img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="WebSocket">
</p>


---

## 🎯 概述

HYDRA-UMC SERVER 是驱动 HYDRA-UMC 多机器人微工厂单元的独立后端：一个基于 Node.js/Express + WebSocket 的引擎，负责管理机器人状态、将其持久化到磁盘、验证每一次写入操作，并向所有已连接客户端广播实时更新。它本身不附带任何用户界面或前端构建步骤——是一个纯粹的 API + WebSocket 服务，设计为在真正紧邻机器人的机器上（通常是 Raspberry Pi CM5）以无头方式运行（无浏览器、无显示器）。

它**可以**选择性地将 **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 自身构建好的前端作为静态文件提供服务，以满足常见的“一台机器、一个来源”部署方式——只需运行一次 **`build-frontend.sh`/`.bat`**（从同级检出的 STUDIO 构建并将输出复制到本仓库自身的 `public/` 目录，已加入 gitignore），本服务器在下次启动时便会在 `/` 路径提供该前端。这正是 HYDRA-UMC-ANDROID-CONTROL、HYDRA-UMC-IOS-CONTROL 和 HYDRA-UMC-DSI 能够在各自的应用内 WebView 中嵌入真实 STUDIO 3D 视口的原因，它们都指向同一台服务器自身的 `ip:port`。这完全是可选的：跳过该脚本，本服务器将保持上文所述的完全无头状态——`public/` 目录根本不会存在，且所有路由在两种情况下均能同样正常工作。

同一个 `build-frontend.sh`/`.bat` 脚本还会构建本仓库自身的 **[`admin-ui/`](admin-ui/README.md)**——一个用于管理本 SERVER 自身的小型独立面板（已连接设备、自身的日志文件、自身的端口/名称、自身的用户账户），服务于 `/admin` 路径。这刻意地**不**涉及机器人控制（那始终仅由 STUDIO 负责）——是对上述无头设计的一个明确、狭窄的例外，而非对其的推翻。

本项目曾经是 **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 的一部分，后者曾以“混合单体”形式发布：一个 Node.js 进程既运行机器人控制引擎，又提供 Vite/React 网页仪表盘（Vite 自身的开发中间件直接接入同一个 Express 应用）。该进程现已一分为二：

- **HYDRA-UMC SERVER**（本仓库）——引擎本身：机器人/控制器状态、REST + WebSocket API、身份验证、mDNS 发现、模型提交。无界面、无打包工具、无前端构建步骤。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**——现在是一个纯粹的 Vite/React 客户端，通过网络与本服务器通信，与本 API 的所有其他客户端完全一致。

## 🧩 存在的原因

将引擎从网页仪表盘中拆分出来是一项经过深思熟虑的变更，而非为改而改：

- **资源隔离。** 一个占满浏览器自身标签页资源的重型 3D 视图，不再与实际负责移动机器人的代码共享同一个进程（因而也不再共享 CPU/IO 争用）。即便网页 UI 卡死，本服务器仍会持续响应来自任何其他已连接客户端的紧急停止指令。
- **真正的无头控制器。** 该进程可在主机上完全不加载任何 UI 的情况下运行——工业单元的“大脑”并不需要打开浏览器标签页才能工作。在资源受限的硬件（Raspberry Pi CM5）上，为真正重要的部分——运动学与控制——释放出 RAM/CPU。
- **独立的生命周期。** 网页 UI 可以重新部署、重启，或热替换为更新的构建版本，而完全不影响本进程——发布 UI 修复无需任何机器人控制停机时间。
- **灵活的托管方式。** 本服务器旨在运行于它所控制的硬件上（或紧邻其旁）；而渲染它的客户端则可以完全托管于其他任何地方，通过网络访问，与该 API 的其他远程客户端完全一致。

## 🔌 API 与 WebSocket 接口

每一个路由、WebSocket 消息契约、身份验证机制以及逐客户端的远程访问模型，均记录于 **[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** 中——这是与本服务器通信的任何组件（包括 HYDRA-UMC STUDIO 自身的客户端代码）的唯一权威来源。简而言之：

- `/api/*` 下的 REST API——设置读写、原子化机器人指令（点动/播放/暂停/停止/工具/阀门/泵/速度/视觉）、账户管理、工作文件上传/下载、模型提交、系统指标、发现服务。
- 单一的 `/ws` WebSocket 端点（查询字符串中携带承载令牌），在状态发生变化时向所有已连接客户端广播完整树形的 `settings` 快照及更轻量的 `delta` 更新。
- 每次写入均需 JWT 承载令牌身份验证；两种账户角色（`admin`、`operator`）分别控制设置/用户管理写入与日常机器人操作的权限。
- `_hydra._tcp` mDNS/Bonjour 广播，实现局域网内零配置发现，另配有一个纯粹的 `GET /api/hydra-info` 供子网扫描使用。
- `GET /metrics`——Prometheus 导出格式（`prom-client`），供下文“📊 监控”一节所述的可选 Grafana 仪表盘使用。

CORS 通过一个可配置的白名单（`CORS_ALLOWED_ORIGINS`，见下文“环境变量”）启用，因为本服务器的客户端不再保证与其自身同源。若未设置，在 `NODE_ENV=production` 之外始终保持完全开放（这是当前本地开发下的零配置行为）；在生产环境中，则会拒绝所有跨源浏览器请求，直至设置该白名单为止——完整推理过程见 `src/server.ts` 中 `app.use(cors(corsOptions))` 上方的注释。

## 💾 数据与持久化

本服务器所拥有的一切均存放于 `data/` 目录下，首次运行时自动创建：

- `data/settings.json`——完整的状态树：控制器、机器人、系统配置。绝不作为静态文件提供（明确返回 404）——只能通过经过身份验证的 `/api/settings` 路由访问。
- `data/users.json`——账户凭证（经 scrypt 哈希加盐处理，绝不以明文存储）。同样绝不以静态方式提供。
- `data/logs/server.log`——每一条指令的仅追加式工业日志。
- `data/WORKS/`——已保存的机器人轨迹，默认每个机器人一个文件夹，以纯静态文件形式提供（索引及各个工作文件）。
- `data/model_submissions.json` 及提交的模型文件夹本身——[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF) 的“将完成的机器人模型直接推送到本服务器目录”流程在服务端的对应部分。

## 📂 仓库结构

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # Express 应用 + WebSocketServer + 所有 /api 路由
│   ├── kinematics.ts   # 原子点动端点使用的逆运动学辅助工具
│   └── users.ts        # 账户存储（scrypt 密码哈希）
├── data/                # 运行时状态——设置、用户、日志、工作文件
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   └── WORKS/
├── docs/
│   └── REMOTE_API.md    # 完整契约：每个路由、WS 协议、身份验证
├── monitoring/           # 可选的 Prometheus + Grafana 技术栈——见 monitoring/README.md
├── scripts/
│   └── bump-version.mjs # 里程表式版本递增，在每次构建前运行
├── build.bat / build.sh # 安装依赖 + 生产构建
├── dev.bat / dev.sh      # 安装依赖 + 启动开发服务器
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

## 🛠️ 开发环境

### 系统要求
- [Node.js](https://nodejs.org/)（建议 v18 或更高版本）
- npm

### 安装

```bash
npm install
```

### 环境变量

均为可选项——本服务器在零配置的情况下即可运行，对下列每个变量都使用内置的、便于开发的默认值。在将本服务器暴露到完全受信任的局域网之外之前（例如通过路由器的 NAT/端口转发暴露到公网，这会将威胁模型从“仅限受信局域网”变为“任何人皆可访问”），请设置真实的值（参见 `.env.example`）：

- `JWT_SECRET`——为每一个登录令牌签名。若未设置，将使用 `src/server.ts` 中内置的固定开发值（适用于本地开发，不适用于可从受信网络之外访问的部署）。可在你的 shell 中导出，或通过你所选的进程管理器/容器进行配置（systemd 的 `Environment=`、`pm2` 自身的环境配置、Docker 的 `-e` 等）。
- `NODE_ENV`——对任何真实部署都应设置为 `production`。此设置会控制下面两个回退行为（开放的 CORS、静默使用默认值），并在 `JWT_SECRET` 或预置的 `admin`/`admin` 账户仍处于默认值时开启醒目的启动警告。未设置（或设置为其他值）则保持当前宽松的开发行为。
- `CORS_ALLOWED_ORIGINS`——允许向本 API 发起跨源浏览器请求的来源列表，以逗号分隔——真正相关的场景是 HYDRA-UMC STUDIO 从与本服务器不同的主机/端口提供服务（例如 `https://studio.example.com`，开发环境下则是 `http://192.168.1.20:5173`）。示例：
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`。
  若未设置：`NODE_ENV != production` 时允许任意来源（本地开发无需任何设置，与本项目历史行为一致）；`NODE_ENV = production` 时则**拒绝**所有跨源浏览器请求，直至设置此项，并附有醒目的启动警告。非浏览器客户端（curl、HYDRA-UMC SUITE、移动控制应用）无论哪种情况均不受影响——CORS 仅是浏览器机制。
- `JWT_EXPIRES_IN`——登录令牌的有效期。可使用 `jsonwebtoken` 自身 `expiresIn` 选项所接受的任意字符串（`"24h"`、`"7d"`、纯数字秒数等）。若未设置则默认为 `30d`（本项目最初对受信局域网的假设）。**可从受信局域网之外访问的服务器应将其设置得更短——`24h` 是一个合理的起始值**——泄露的长期有效令牌除了修改该账户密码之外，无法单独撤销。
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS`——仅对 `POST /api/login` 进行限流（其他所有路由均不受影响）。若两者均未设置，默认为每个 IP 每 15 分钟 5 次尝试；触发限流时返回明确的 JSON 错误 `429`，而非泛泛的 `500`。
- `TLS_CERT_PATH` / `TLS_KEY_PATH`——**两者均**设置后，可将服务器（REST API + 共享同一监听器的 `/ws` WebSocket）从纯 HTTP/WS 切换为 HTTPS/WSS。详见下文“TLS / HTTPS”。任一未设置则保持当前的纯 HTTP 行为不变。

### TLS / HTTPS

默认关闭——本服务器一直以纯 HTTP/WS 方式运行，除非你主动开启，否则依然如此。设置 `TLS_CERT_PATH` 和 `TLS_KEY_PATH`（见上文）指向一份 PEM 证书及其对应的私钥，共享的 REST + WebSocket 监听器便会切换为 `https.createServer()`——`/ws` 会随之自动变为 WSS，无需额外配置。若证书/密钥路径已设置但不可读或无效，启动将明确失败（抛出真实的 `fs` 错误），而不会静默回退到纯 HTTP。

这在本服务器可从完全受信局域网之外访问时（例如通过路由器的 NAT/端口转发暴露以进行远程测试）尤为重要——纯 HTTP 意味着每一个承载令牌、每一条机器人指令，以及 admin/operator 登录本身，都以明文形式穿越网络。

获取证书：

- **拥有指向本服务器的域名**——使用 [Let's Encrypt](https://letsencrypt.org/)（例如通过 [Certbot](https://certbot.eff.org/)）获取真实的、浏览器信任的证书，免费且可自动续期。将 `TLS_CERT_PATH` / `TLS_KEY_PATH` 指向生成的 `fullchain.pem` / `privkey.pem`。
- **本地测试，无域名**——自签名证书足以运行 HTTPS/WSS 代码路径（浏览器及大多数 HTTP 客户端会警告/要求显式的信任覆盖，这在测试中是预期且正常的）：
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  然后设置 `TLS_CERT_PATH=./cert.pem` 和 `TLS_KEY_PATH=./key.pem`。

### 开发模式

直接使用 `tsx` 运行 API/WebSocket 服务器（无打包工具，不涉及前端）：
- **Windows：** 双击 `dev.bat`，或运行 `npm run dev`
- **Linux/Mac：** 运行 `./dev.sh` 或 `npm run dev`

### 生产构建

使用 esbuild 将服务器打包为单个可部署文件：
- **Windows：** 双击 `build.bat`，或运行 `npm run build`
- **Linux/Mac：** 运行 `./build.sh` 或 `npm run build`

随后以生产模式启动服务器：
```bash
npm start
```

服务器监听 `0.0.0.0:3000`——可通过 `http://localhost:3000` 或局域网内的 `http://<你的本地IP>:3000` 访问。所有状态均持久化于 `data/` 目录。

### 版本管理

每次真正执行 `npm run build` 都会自动递增 `package.json` 自身的 `version`（`scripts/bump-version.mjs`，作为 `build` 脚本的第一步运行）——采用十进制“里程表”方式：每次构建 patch 位 +1，超过 9 后向 minor 位（minor 超过 9 后向 major 位）进位，而不会出现两位数字段（`0.0.9` -> `0.1.0`，而非 `0.0.10`）。当前运行版本可通过 `GET /api/hydra-info`（`appVersion`）实时读取，完整历史记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 📊 监控（可选）

`GET /metrics` 以 Prometheus 格式导出进程运行时长、已连接的 WebSocket 客户端数、`settings.json` 写入延迟、按类型统计的原子机器人指令、身份验证失败次数，以及与 `GET /api/system/metrics` 相同的 CPU/内存/温度数据。一套可直接运行的 Prometheus + Grafana 技术栈（附带一个起始仪表盘）位于 **[`monitoring/`](monitoring/README.md)**：在该目录下执行 `docker compose up -d` 即可运行。完全可选——服务器本身的工作并不依赖此处的任何内容。

## 🔗 相关项目

本项目是同一作者（JuanenRac / Electro Hobby 3D）打造的更大规模机器人生态系统的一部分，该生态系统涵盖固件、控制软件、AI 节点及车队工具等众多项目。值得了解，因为某个请求实际所指的可能正是这些项目之一，而非本仓库。

### 与本服务器直接相关

- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** —— 通过 OPC-UA/MQTT 暴露本服务器的状态。
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** —— 摄取本服务器产生的日志。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** —— 摄取本服务器产生的日志。
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** —— 协调本服务器的多个实例。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** —— 协调本服务器的多个实例并管理它们的故障转移。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** —— 桥接本服务器与数字孪生系统。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** —— 针对本服务器的 API 执行车队级 DevOps 操作。

### 生态系统的其余部分

**HYDRA-UMC 平台** —— 多机器人微工厂单元
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— 主板本体：Raspberry Pi CM5 主机 + 双核 STM32H745 实时协处理器，通过 CAN-OTA/SPI-OTA 协调最多 8 个分布式机器人手臂。自有硬件 + 固件，GPL-3.0/CERN-OHL-S v2/CC BY-SA 4.0。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— HYDRA-UMC 的网页控制仪表盘：多机器人 3D 可视化、运动学/轨迹录制、面向整个平台的 CAN-OTA 刷写与测试。React + Vite + Three.js——现在是一个纯前端客户端，通过网络与本服务器通信，与下方所有其他客户端完全一致。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— 通过 Wi-Fi/蓝牙控制 HYDRA-UMC 的 Android 应用。真实可用的应用——完整的远程控制功能集、JWT 身份验证、加密凭证存储。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— 通过 Wi-Fi 控制 HYDRA-UMC 的 iOS/iPadOS 应用，基于 Flutter 构建（跨平台，可在 Windows 上验证，无需 Mac；最终 `.ipa` 打包仍需 Xcode）。真实可用的应用——功能集与 Android 应用相同。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— 桌面端（Python/PySide6）集群指挥中心：多控制器网络发现、实时双向同步、真实的 3D 机器人视口、类 Photoshop 的可停靠工作区。真实可用，并非占位程序。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— 桌面端（Python/PySide6）图形化 URDF 创建/编辑工具，服务于本项目自身的模型目录：从 GitHub 或本地文件夹拉取源文件，验证自由度可行性，通过实时 3D 预览编辑颜色/比例/运动学，并将完成的结果直接推送到本服务器的目录中。真实可用，并非占位程序。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— 面向 HYDRA-UMC 自身 5"/7" DSI 触摸屏（两种尺寸分辨率均为 1280×720）的原生 Flutter 触控界面，运行于 Compute Module 5 上，直接从主板控制同一台服务器。真实可用的雏形，全部 6 个目录界面均已连接到实时服务器；尚未在真实硬件上运行真正的 Linux 目标构建。

**URTC 平台** —— 每个 HYDRA-UMC 机器人手臂所携带的工具头控制器
- **[URTC](https://github.com/JuanenRac/URTC)** —— 通用机器人工具控制器：基于 STM32F303 的 CAN 总线工具头控制器，25 个已完整实现的工具配置文件，支持 CAN-OTA 固件更新。
- **[URTC Flasher](https://github.com/JuanenRac/URTC-FLASHER)** —— 面向 URTC 板卡的桌面端 CAN-OTA + 全芯片 SWD/JTAG 刷写工具（Windows/Linux）。
- **[URTC Tester](https://github.com/JuanenRac/URTC-TESTER)** —— 面向 URTC 板卡的桌面端实时 CAN 总线诊断工具，每个工具配置文件对应一个面板（Windows/Linux）。
- **[URTC Web Studio](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— 上述两款桌面工具的浏览器端替代方案（Web Serial API + SLCAN），无需本地安装。

**👁️ Vision AI Node (Hailo-8)**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 Cognitive AI Node (Hailo-10)**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 Orchestration & Swarm**
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)

**🎮 Digital Twin & Simulation**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 Data & Analytics**
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🏭 Industrial Gateway**
- [HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)
- [HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)
- [HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)

**🛠️ Complementary Tools**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)

---

## 👤 作者

**JuanenRac**（Electro Hobby 3D）
📧 electrohobby3d@gmail.com
📺 youtube.com/@electrohobby3d

---

## 📜 许可证与版权声明

HYDRA-UMC SERVER 版权所有 (c) 2026 JuanenRac（Electro Hobby 3D）。分发本项目或其衍生作品时必须包含此声明。

本应用的源代码依据 **GNU 通用公共许可证 v3.0（GPL-3.0）** 提供。完整文本见
https://www.gnu.org/licenses/gpl-3.0.html。

文档（本 README 及其自身的翻译版本——`README_spa.md`、`README_ita.md`、`README_fra.md`、`README_deu.md`、`README_zho.md`、`README_jpn.md`）依据 **知识共享 署名-相同方式共享 4.0 国际许可协议（CC BY-SA 4.0）** 提供。完整文本见
https://creativecommons.org/licenses/by-sa/4.0/。
