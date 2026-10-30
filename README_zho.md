<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | 🇨🇳 <b>简体中文</b> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 HYDRA-UMC 多机器人微工厂的无头式 API/WebSocket 后端

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-377%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.2-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **诚实检查——今天真正可运行的部分：** Express + WebSocket 引擎、其 REST 和 WebSocket 接口（58 条路径上的 63 个操作）、带刷新令牌轮换和 scrypt 的 JWT 登录、mDNS 发现、机器人预约与修订、播放，以及通往 CAN-OTA、遥测、语音、本地 AI 服务和连接器中枢的中继都是真实的，并针对测试自己启动的本服务器真实实例做过测试：377 个单元测试加 28 个端到端契约脚本，全部通过。与硬件相关、此处未验证的部分：到带 STM32H745 板的真实 HYDRA-UMC CM5 的连接，这是真实代码，但只通过 API 和契约层验证过。TLS、蓝牙 LE、MQTT 桥以及 Prometheus 和 Grafana 栈都是真实的、可选的，默认关闭。

---

> **安全与安防现状:**本生态系统不是经认证的安全系统。目前尚无硬件 E-STOP 通路,没有由固件强制执行的限位或联锁,也没有经过验证的运动指令;固件映像使用 CRC-32 和 Ed25519 签名校验,发布构建会拒绝已公开的开发密钥(中继之后的工具头和扩展板仍运行 URTC 的引导程序,它们使用共享密钥的 HMAC-SHA256 而不是签名);TLS 与双向 TLS 均为可选项,默认关闭;自制电路板尚未组装或测试。在依赖此处任何说法来保障人身安全之前,请先阅读[安全基线](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)和[威胁模型](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)。

---

## 📋 速览

| | |
|---|---|
| 版本 | `0.8.1.2` |
| 成熟度 | 可用 |
| 测试 | 377 (`npm run test:unit`) |
| 技术栈 | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| 目标 | HYDRA-UMC 工作单元的 Raspberry Pi CM5 |
| 真实硬件 | 尚未：此版本没有在真实硬件上运行的记录 |

**跳转：** [概述](#-概述) · [架构](#-架构) · [功能](#-功能) · [安全与防护](#-安全与防护) · [接口](#-接口) · [配置](#-配置) · [快速开始](#-快速开始) · [测试](#-测试) · [故障排除](#-故障排除) · [仓库结构](#-仓库结构) · [相关项目](#-相关项目)

## 🚦 项目状态

每一行是本仓库的一个部分，灯号表示它今天做到了哪一步。内容依据仓库能够展示的证据（测试、构建、运行），而不是计划。

🟢 已完成并验证 · 🟡 可用，有已知限制 · 🟠 部分完成或尚未验证 · 🔴 未完成或不可用

| 领域 | 状态 | 在这里的含义 |
|---|---|---|
| 软件 | 🟡 | 主要用途可用；上面的诚实性检查列出了仍然缺少的内容 |
| 测试 | 🟢 | 377 项自动测试，每次变更都会运行 |
| 真实硬件 | 🔴 | 尚未：此版本没有在真实硬件上运行的记录 |
| 文档 | 🟢 | 八种语言的 README，每次变更都会与清单核对 |

## 🎯 概述

HYDRA-UMC SERVER 是驱动 HYDRA-UMC 多机器人微工厂单元的独立后端：一个基于 Node.js/Express + WebSocket 的引擎，负责管理机器人状态、将其持久化到磁盘、验证每一次写入操作，并向所有已连接客户端广播实时更新。它本身不附带任何用户界面或前端构建步骤——是一个纯粹的 API + WebSocket 服务，设计为在真正紧邻机器人的机器上（通常是 Raspberry Pi CM5）以无头方式运行（无浏览器、无显示器）。

第二版契约已完整：条件写入（命令与占用上的 `If-Match`、`GET /api/robot/:id`）、原子的 `table` 命令、只追加的审计记录（`GET /api/audit`，哈希链，可关闭）以及 WebSocket 的 `claims` 消息。摄像头密码不再出现在进程列表或日志中。参见 `docs/CONTRACT_V2.md`。

它**可以**选择性地将 **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 自身构建好的前端作为静态文件提供服务，以满足常见的“一台机器、一个来源”部署方式——只需运行一次 **`build-frontend.sh`/`.bat`**（从同级检出的 STUDIO 构建并将输出复制到本仓库自身的 `public/` 目录，已加入 gitignore），本服务器在下次启动时便会在 `/` 路径提供该前端。这正是 HYDRA-UMC-ANDROID-CONTROL、HYDRA-UMC-IOS-CONTROL 和 HYDRA-UMC-DSI 能够在各自的应用内 WebView 中嵌入真实 STUDIO 3D 视口的原因，它们都指向同一台服务器自身的 `ip:port`。这完全是可选的：跳过该脚本，本服务器将保持上文所述的完全无头状态——`public/` 目录根本不会存在，且所有路由在两种情况下均能同样正常工作。

同一个 `build-frontend.sh`/`.bat` 脚本还会构建本仓库自身的 **[`admin-ui/`](admin-ui/README.md)**——一个用于管理本 SERVER 自身的小型独立面板（已连接设备、自身的日志文件、自身的端口/名称、自身的用户账户），服务于 `/admin` 路径。这刻意地**不**涉及机器人控制（那始终仅由 STUDIO 负责）——是对上述无头设计的一个明确、狭窄的例外，而非对其的推翻。

本项目曾经是 **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 的一部分，后者曾以“混合单体”形式发布：一个 Node.js 进程既运行机器人控制引擎，又提供 Vite/React 网页仪表盘（Vite 自身的开发中间件直接接入同一个 Express 应用）。该进程现已一分为二：

- **HYDRA-UMC SERVER**（本仓库）——引擎本身：机器人/控制器状态、REST + WebSocket API、身份验证、mDNS 发现、模型提交。无界面、无打包工具、无前端构建步骤。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**——现在是一个纯粹的 Vite/React 客户端，通过网络与本服务器通信，与本 API 的所有其他客户端完全一致。

## 🧩 在 HYDRA-UMC 中的角色

**HYDRA-UMC-SERVER** 是单元的引擎：一个无界面的 Node.js 和 Express 后端，保存机器人状态并写入磁盘，要求每次写入带有角色，并通过一个 WebSocket 向所有客户端推送实时更新。所有客户端（STUDIO、SUITE、手机应用、触摸屏、手表、命令行工具）都经过它，只有它决定谁能移动哪个机器人以及移动多远。

## 🏛️ 架构

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### 存在的原因

将引擎从网页仪表盘中拆分出来是一项经过深思熟虑的变更，而非为改而改：

- **资源隔离。** 一个占满浏览器自身标签页资源的重型 3D 视图，不再与实际负责移动机器人的代码共享同一个进程（因而也不再共享 CPU/IO 争用）。即便网页 UI 卡死，本服务器仍会持续响应来自任何其他已连接客户端的紧急停止指令。
- **真正的无头控制器。** 该进程可在主机上完全不加载任何 UI 的情况下运行——工业单元的“大脑”并不需要打开浏览器标签页才能工作。在资源受限的硬件（Raspberry Pi CM5）上，为真正重要的部分——运动学与控制——释放出 RAM/CPU。
- **独立的生命周期。** 网页 UI 可以重新部署、重启，或热替换为更新的构建版本，而完全不影响本进程——发布 UI 修复无需任何机器人控制停机时间。
- **灵活的托管方式。** 本服务器旨在运行于它所控制的硬件上（或紧邻其旁）；而渲染它的客户端则可以完全托管于其他任何地方，通过网络访问，与该 API 的其他远程客户端完全一致。

## ✨ 功能

### 数据与持久化

本服务器所拥有的一切均存放于 `data/` 目录下，首次运行时自动创建：

- `data/settings.json`——完整的状态树：控制器、机器人、系统配置。绝不作为静态文件提供（明确返回 404）——只能通过经过身份验证的 `/api/settings` 路由访问。
- `data/users.json`——账户凭证（经 scrypt 哈希加盐处理，绝不以明文存储）。同样绝不以静态方式提供。
- `data/logs/server.log`——每一条指令的仅追加式工业日志。
- `data/WORKS/`——已保存的机器人轨迹，默认每个机器人一个文件夹，以纯静态文件形式提供（索引及各个工作文件）。
- `data/model_submissions.json` 及提交的模型文件夹本身——[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF) 的“将完成的机器人模型直接推送到本服务器目录”流程在服务端的对应部分。
- `data/totp.json` - 已开启第二步验证的账户的第二因素(可选，在其所有者开启之前对每个账户都是关闭的):每个密钥使用 `HYDRA_UMC_TOTP_KEY`(或由 `JWT_SECRET` 派生的密钥)通过 AES-GCM 加密，十个恢复码只以哈希形式保存；在有账户开启第二步之前，这个文件并不存在。

## 🔒 安全与防护

| 威胁 | 防御 | 位置 |
|---|---|---|
| 用已知密钥签名的令牌 | `NODE_ENV=production` 时，如果 `JWT_SECRET` 为空、是示例值或过短，或没有初始管理员，服务器拒绝启动；开发时使用内置值并打印 `[SECURITY]` 警告 | `src/auth.ts`, `src/secretsPolicy.ts` |
| 对登录的暴力破解，或大量停止请求 | 每个地址每 15 分钟最多 5 次登录失败（`429`），每分钟 120 次刷新和 60 次全局停止，均可用 `LOGIN_RATE_LIMIT_MAX`、`REFRESH_RATE_LIMIT_MAX` 和 `STOP_ALL_RATE_LIMIT_MAX` 调整；密码使用带随机盐的 scrypt，同时最多 4 个、排队最多 20 个，洪水请求无法拖垮服务器 | `src/auth.ts`, `src/users.ts` |
| 被盗的令牌，或从地址中读取的令牌 | 访问令牌会过期（`JWT_EXPIRES_IN`，默认 30 天，在可信局域网之外建议 24 小时），并由轮换的刷新令牌续期；WebSocket 以 `hydra.bearer` 子协议接收令牌，除非 `HYDRA_UMC_WS_QUERY_TOKEN=allow` 重新允许，否则拒绝 `?token=`，每次启动都会警告 | `src/refresh_tokens.ts`, `src/ws.ts` |
| 两个客户端移动同一个机器人，或机器人不该收到的命令 | 机器人被预约给一个账户和窗口，写入需要 `If-Match`（过期的修订号得到 `412`），观察者角色不能写入，点动幅度和热床最高目标温度来自管理员设置的安全限制；无论预约如何，全局停止都有效 | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| 网络上任何人都能看到摄像头画面 | 实时画面、照片和录像需要有效期 5 分钟的签名票据（或持有者令牌）；最多 8 个摄像头；摄像头密码不会出现在进程列表和日志中；`HYDRA_UMC_CAMERA_AUTH=open` 是临时的退出开关 | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| 超大或恶意的请求，以及开放的跨源访问 | JSON 请求体上限 1 MB（仅大文件上传路由为 50 MB）；`CORS_ALLOWED_ORIGINS` 是允许列表，在生产环境中未设置时拒绝所有浏览器跨源请求（开发环境允许任何来源并给出警告）；`settings.json` 和 `users.json` 绝不会作为文件提供 | `src/server.ts` |
| 弱访问选项一直开着：语音文字、识别置信度、MAVLink 签名、蓝牙、MQTT、TLS | 每一项都有管理员通过 `PUT /api/admin/server-config`（仅管理员）编辑的开关，默认值保守，且环境变量优先于已保存的值；响应会列出 `voice_heard_text_on`、`voice_confidence_off`、`mavlink_unsigned_allowed` 和 `mavlink_signing_off` 等警告；语音中继会用管理员的设置替换客户端发送的任何 `options`，MAVLink 密钥文件在保存路径前会被检查（32 字节或 64 个十六进制字符） | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| 被篡改的“谁做了什么”记录 | 只追加的审计记录，条目通过哈希链接（`GET /api/audit`，`?verify=1` 检查链条）；服务器日志按大小轮转；写入任何内容之前都会先脱敏以去除机密 | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**它绝不做的事：** 充当经过认证的安全功能。限制和停止是此进程中的软件；其背后还没有硬件紧急停止路径、固件强制的限制或真实的控制板。

## 🔌 接口

### API 与 WebSocket 接口

每一个路由、WebSocket 消息契约、身份验证机制以及逐客户端的远程访问模型，均记录于 **[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** 中——这是与本服务器通信的任何组件（包括 HYDRA-UMC STUDIO 自身的客户端代码）的唯一权威来源。简而言之：

- `/api/*` 下的 REST API——设置读写、原子化机器人指令（点动/播放/暂停/停止/工具/阀门/泵/速度/视觉）、账户管理、工作文件上传/下载、模型提交、系统指标、发现服务。
- 单一的 `/ws` WebSocket 端点（承载令牌通过 `hydra.bearer` 子协议传递，查询字符串中的令牌会被拒绝，除非安装方重新允许），在状态发生变化时向所有已连接客户端广播完整树形的 `settings` 快照及更轻量的 `delta` 更新。
- `POST /api/stop-all` 是全局停止:一次调用,向任何已登录账户开放,无论预约如何,都会停止所有机器人并关闭所有阀门和泵,并为每个机器人返回一个结果。
- 蓝牙 LE(默认关闭):CM5 附近的手机可以读取机器人状态,并在管理员允许时发送命令;服务器只有在网络客户端所用的同一路由作出响应之后才会确认。详见 [`docs/BLE_GATT.md`](docs/BLE_GATT.md)。
- 每次写入均需 JWT 承载令牌身份验证；三种账户角色（`admin`、`operator`、只读的 `viewer`）分别控制设置/用户管理写入与日常机器人操作的权限。
- `_hydra._tcp` mDNS/Bonjour 广播，实现局域网内零配置发现，另配有一个纯粹的 `GET /api/hydra-info` 供子网扫描使用。
- `GET /metrics`——Prometheus 导出格式（`prom-client`），供下文“📊 监控”一节所述的可选 Grafana 仪表盘使用。

CORS 通过一个可配置的白名单（`CORS_ALLOWED_ORIGINS`，见下文“环境变量”）启用，因为本服务器的客户端不再保证与其自身同源。若未设置，在 `NODE_ENV=production` 之外始终保持完全开放（这是当前本地开发下的零配置行为）；在生产环境中，则会拒绝所有跨源浏览器请求，直至设置该白名单为止——完整推理过程见 `src/server.ts` 中 `app.use(cors(corsOptions))` 上方的注释。

### 监控（可选）

`GET /metrics` 以 Prometheus 格式导出进程运行时长、已连接的 WebSocket 客户端数、`settings.json` 写入延迟、按类型统计的原子机器人指令、身份验证失败次数，以及与 `GET /api/system/metrics` 相同的 CPU/内存/温度数据。一套可直接运行的 Prometheus + Grafana 技术栈（附带一个起始仪表盘）位于 **[`monitoring/`](monitoring/README.md)**：在该目录下执行 `docker compose up -d` 即可运行。完全可选——服务器本身的工作并不依赖此处的任何内容。

| 主题或路由 | 内容 |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | 登录（有频率限制）、轮换刷新令牌、退出 |
| `/api/users`, `/api/users/:username` | 列出、创建、修改和删除账户（`admin`、`operator`、`viewer`）；仅管理员 |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | 状态树和原子的带类型命令（点动、播放、暂停、停止、工具、阀门、泵、速度、视觉、工作台），带 `If-Match` |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | 预约、启用点动、谁持有什么、全局停止和安全限制 |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | 管理：访问开关、已连接的应用、服务器日志、重启和安全限制；仅管理员 |
| `/api/camera/*`, `/api/cameras/status` | 摄像头流、快照、录像、PTZ 和 `POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | 主机信息、进程监控、生态系统服务的状态与控制、蓝牙配对 |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | 到语音服务、手表状态和本地 AI 服务的中继 |
| `/ws` | 一个 WebSocket：完整的 `settings` 快照、轻量的 `delta` 更新和 `claims` 消息；令牌作为 `hydra.bearer` 子协议传送 |
| `GET /api/hydra-info`, `_hydra._tcp` | 发现：远程契约版本（`remoteApiVersion` 2）、应用版本以及控制器和机器人的数量，通过 mDNS 公布 |
| `/admin`, `/dashboard-ai`, `/` | 可选的静态页面，仅在 `build-frontend` 于本仓库旁构建后才提供：管理面板、DASHBOARD-AI 和 STUDIO |
| `/metrics` | Prometheus 文本：运行时间、WebSocket 客户端、写入延迟、按类型的命令、认证失败、主机数据 |

## ⚙️ 配置

### 环境变量

均为可选项——本服务器在零配置的情况下即可运行，对下列每个变量都使用内置的、便于开发的默认值。在将本服务器暴露到完全受信任的局域网之外之前（例如通过路由器的 NAT/端口转发暴露到公网，这会将威胁模型从“仅限受信局域网”变为“任何人皆可访问”），请设置真实的值（参见 `.env.example`）：

- `JWT_SECRET`——为每一个登录令牌签名。若未设置，将使用 `src/server.ts` 中内置的固定开发值（适用于本地开发，不适用于可从受信网络之外访问的部署）。可在你的 shell 中导出，或通过你所选的进程管理器/容器进行配置（systemd 的 `Environment=`、`pm2` 自身的环境配置、Docker 的 `-e` 等）。
- `NODE_ENV`——对任何真实部署都应设置为 `production`。此设置会控制下面两个回退行为（开放的 CORS、静默使用默认值），并在 `JWT_SECRET` 或预置的 `admin`/`admin` 账户仍处于默认值时开启醒目的启动警告。未设置（或设置为其他值）则保持当前宽松的开发行为。
- `CORS_ALLOWED_ORIGINS`——允许向本 API 发起跨源浏览器请求的来源列表，以逗号分隔——真正相关的场景是 HYDRA-UMC STUDIO 从与本服务器不同的主机/端口提供服务（例如 `https://studio.example.com`，开发环境下则是 `http://192.168.1.20:5173`）。示例：
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`。
  若未设置：`NODE_ENV != production` 时允许任意来源（本地开发无需任何设置，与本项目历史行为一致）；`NODE_ENV = production` 时则**拒绝**所有跨源浏览器请求，直至设置此项，并附有醒目的启动警告。非浏览器客户端（curl、HYDRA-UMC SUITE、移动控制应用）无论哪种情况均不受影响——CORS 仅是浏览器机制。
- `JWT_EXPIRES_IN`——登录令牌的有效期。可使用 `jsonwebtoken` 自身 `expiresIn` 选项所接受的任意字符串（`"24h"`、`"7d"`、纯数字秒数等）。若未设置则默认为 `30d`（本项目最初对受信局域网的假设）。**可从受信局域网之外访问的服务器应将其设置得更短——`24h` 是一个合理的起始值**——泄露的长期有效令牌除了修改该账户密码之外，无法单独撤销。
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS`——仅对 `POST /api/login` 进行限流（其他所有路由均不受影响）。若两者均未设置，默认为每个 IP 每 15 分钟 5 次尝试；触发限流时返回明确的 JSON 错误 `429`，而非泛泛的 `500`。
- `REFRESH_RATE_LIMIT_MAX`——`POST /api/refresh` 每个时间窗口和每个 IP 的请求额度（默认 120）。上文的登录限流只统计失败的登录。
- `TLS_CERT_PATH` / `TLS_KEY_PATH`——**两者均**设置后，可将服务器（REST API + 共享同一监听器的 `/ws` WebSocket）从纯 HTTP/WS 切换为 HTTPS/WSS。详见下文“TLS / HTTPS”。任一未设置则保持当前的纯 HTTP 行为不变。
- `HYDRA_UMC_CAMERA_AUTH`——摄像头画面(实时流、已保存的照片和录像)**默认**要求短时效 `?ticket=`(由 `POST /api/camera/ticket` 发给已登录客户端)或 Bearer 令牌;`HYDRA_UMC_CAMERA_AUTH=open` 是供尚未请求票据的客户端使用的临时退路。
- `HYDRA_UMC_WS_QUERY_TOKEN`——`/ws?token=` **默认被拒绝**(令牌以 `hydra.bearer` 子协议传递);`HYDRA_UMC_WS_QUERY_TOKEN=allow` 是供尚未迁移的客户端使用的临时退路。只要设置了退路,服务器每次启动都会发出警告。
- `HYDRA_UMC_BLE_GATT`——蓝牙 LE 服务:`off`(默认)、`state`(手机读取状态)或 `commands`(并发送命令,每条命令都带有账户的访问令牌)。`HYDRA_UMC_BLE_ENCRYPTION=off` 不再要求加密链路(默认要求)。两者也可在服务器管理界面中设置;更改在下次启动时生效。主机上需要 BlueZ、`python3-dbus` 和 `python3-gi`。
- `HYDRA_UMC_MQTT_BRIDGE`——连接单元 MQTT 代理的桥:`off`(默认)、`state`(每个机器人的状态发布到保留主题)或 `commands`(并且发布到某机器人主题上的命令,经与网络客户端相同的路由、使用由 `HYDRA_UMC_MQTT_COMMAND_USER` 指定的专用账户的令牌执行)。地址、主题前缀和用户名也可在 Server Admin 界面设置;密码只能通过环境变量设置。参见 [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md)。
- `HYDRA_UMC_INFO_AUTH=required`——要求已登录的客户端才能获取只读的主机信息(`/metrics`、`/api/system/metrics`、`/api/system/supervisor`、`/api/ecosystem/status`、`/api/models`)。默认关闭,以便尚未在这些路由上发送令牌的客户端继续可用;生产环境启动时在关闭期间会发出警告。
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`、`HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`、`HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`、`HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED`——管理员也可以在 Server Admin 中设置的语音和 UAV 选项(`data/server-config.json` 中的 `voice` 和 `mavlink`):语音回复是否复述听到的内容(`1` 为开启,默认关闭)、接受启动运动的请求之前语音识别所需的最低置信度(0 到 1,默认 0.6),以及 MAVLink 2 签名的密钥文件和是否仍接受未签名的消息(默认不签名,并拒绝未签名的消息)。环境变量优先于已保存的值,此时界面将该值显示为已固定。
- `HYDRA_UMC_AI_ACCESS=admin` - 将通往本地 AI 服务的中继（`/api/ai/*`）限制为仅管理员可用。默认关闭，因此与以前一样，任何已登录用户都可使用。
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`、`HYDRA_UMC_VLA_ENGINE_TOKEN`、`HYDRA_UMC_COGNITIVE_NODE_TOKEN`、`HYDRA_UMC_DETECTION_HEF_TOKEN`、`HYDRA_UMC_VISION_NODE_TOKEN` 和 `HYDRA_UMC_ANOMALY_TOKEN`(用于中继 `/api/ai/*`)、`HYDRA_UMC_VISION_STREAMER_TOKEN`(用于摄像头流)以及 `HYDRA_UMC_DATALAKE_READ_TOKEN`,否则 `HYDRA_UMC_DATALAKE_TOKEN`(用于遥测)——本服务器向要求令牌的服务出示的 Bearer 令牌;每个变量也读取 `..._FILE`,即首行为令牌的文件。它们是各服务自己读取的名称,因此同一个环境文件可同时供两者使用,任何客户端都看不到它们。未配置令牌的服务与以前完全一样地访问。中继还会拒绝既不是管理员也不是操作员的会话,只有管理员才能更改异常检测器的基线(除 `/detect` 之外的任何 `POST`);`vision-node` 和 `anomaly-detector` 加入该中继。
- `HYDRA_UMC_VOICE_UI_RESULT_KEY`（或 `..._FILE`）- HYDRA-UMC-VOICE-UI 为已确认的语音结果签名所用的密钥（16 个字符或更长，与其持有的值相同）。`POST /api/voice/confirm` 以已登录用户为主体转发确认，只有当 `confirmed` 应答指明该用户且签名验证通过时才会采信；没有密钥时应答以 `verified: false` 转交，而设置 `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` 则改为拒绝。该路由不执行任何操作。
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL`（以及 `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` 或 `..._FILE`，和 `HYDRA_UMC_TELEMETRY_INTERVAL_MS`，100 到 60000，默认 1000）- 启用遥测生产者：本服务器广播的每个机器人增量中的数值（位置、关节、播放状态）会按每个机器人一个 `robot_state` 样本、每个间隔至多一个并合并后发送给 HYDRA-UMC-TELEMETRY-COLLECTOR，使数据湖有真实的数据可存。缺少地址时关闭；它不会延迟任何命令，只保留有限的数据，失败后暂停 30 秒。
- `/dashboard-ai` - 如果 HYDRA-UMC-DASHBOARD-AI 与本仓库并列检出，`build-frontend` 会构建它，本服务器在此路径提供。该页面通过中继读取数据湖（`/api/ai/datalake/*`，只读：仅允许对 `/query`、`/aggregate`、`/stats`、`/stats/range`、`/series` 和 `/health` 的 `GET`，其余一律拒绝）和异常检测器（`/api/ai/anomaly-detector/*`），使用在同一浏览器中登录 STUDIO 的用户会话，因此适用本服务器的角色和服务令牌。这样，异常检测器就可以用 `HYDRA_UMC_ANOMALY_PROTECT_READS=1` 启动。
- `HYDRA_UMC_LOG_MAX_BYTES` 和 `HYDRA_UMC_LOG_KEEP` - 服务器日志轮转的大小（默认 10 MB）以及保留的已轮转文件数量（默认 1）。
- `HYDRA_UMC_SETTINGS_STORE`、`HYDRA_UMC_SETTINGS_BACKUPS` 和 `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - 默认情况下，设置（`settings.json` 和点位文件）作为带日志的“要么全部成功、要么全部不生效”的整体写入：被中断的写入会在下次启动时完成或丢弃，`settings.json` 的副本保存在 `data/backups/`（10 份，最多每 600 秒一份），损坏的 `settings.json` 会从最新的完好副本恢复。`HYDRA_UMC_SETTINGS_STORE=plain` 恢复为逐个文件写入；`HYDRA_UMC_SETTINGS_BACKUPS=0` 关闭副本。
- AI 中继的访问权限、主机信息是否要求登录以及 TLS（证书和密钥路径，并显示证书的 SHA-256 指纹），管理员也可以在控制应用的“服务器管理”界面中修改。环境变量中设置的值优先并显示为锁定；关闭登录要求前会请求确认；TLS 在下次启动时生效。
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS`——全局停止(`POST /api/stop-all`)每个地址的额度,与登录的额度分开(默认每分钟 60 次)。在生产环境中,服务器还会拒绝使用部署模板中的示例 `JWT_SECRET`/引导密码、少于 32 个字符的 `JWT_SECRET` 或少于 12 个字符的引导密码启动。

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

以下访问开关就是 STUDIO 和 SUITE 的 Server Admin 画面所编辑的那些。每一项都按相同顺序决定：先是部署环境变量（画面中显示为锁定），然后是管理员保存在 `data/server-config.json` 中的值，最后是保守的默认值。其余一切由上面列出的变量涵盖。

| 变量 | 默认值 | 设置内容 |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | 谁可以使用本地 AI 中继：`open` 为任何已登录账户，`admin` 仅管理员 |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | 关闭 | 对只读主机信息（指标、进程监控、生态系统状态）要求登录 |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | 关闭（明文 HTTP） | 使用你指定的证书和密钥启用 HTTPS 与 WSS；画面显示正在使用的证书指纹 |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | 供服务器附近手机使用的蓝牙 LE：`off`、`state`（仅发布状态）或 `commands`（也接受命令）；未知词表示关闭 |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | 开启 | 命令特征值的写入和状态的读取只在加密链路上进行；只有变量为 `off` 才会关闭 |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | 连接单元代理的 MQTT 桥：`off`、`state` 或 `commands`，以及其 URL、前缀和用户 |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | 关闭 | 语音回复会复述所说的话；这属于个人数据，所以默认关闭，变量中只有恰好为 `1` 才会开启 |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | 语音识别器接受启动运动请求所需的最低置信度（0 到 1）；0 表示关闭检查，停止命令从不被拦下，变量中的无效数字会被忽略 |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | 空（不签名） | UAV 桥的 MAVLink 2 签名：包含 32 字节密钥的文件路径（32 个原始字节或 64 个十六进制字符）；只保存路径，绝不保存密钥，桥在启动时读取 |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | 关闭 | 仍接受未签名的消息（尚不签名的载具）；开启期间画面会给出警告 |

## 🚀 快速开始

需要 Node.js 22 或更高版本及 npm。服务器无需配置即可以适合开发的默认值运行；在它能被可信局域网之外访问之前，请设置“配置”一节中的变量。

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

服务器监听 `0.0.0.0:3000`；它的全部状态都在 `data/` 中。本仓库有意不提供 Dockerfile：由 HYDRA-UMC-OS 在 CM5 上安装它（`provisioning/install_server.sh`）。运行中的版本可从 `GET /api/hydra-info`（`appVersion`）读取；只有根目录的 `build*.sh` 和 `build*.bat` 会生成带版本的发布构建，`npm run build` 只编译。

## 🧪 测试

运行 `npm run test:unit` 会执行 377 个自动测试。 此外，`npm test` 会运行 OpenAPI 检查，以及针对本服务器真实实例的 `tools/` 中 28 个端到端契约脚本（发现、无凭据和有凭据登录、生产环境引导、机器人命令与归属、刷新令牌、语音中继及其错误路径、播放、全局停止、蓝牙和 MQTT 桥、摄像头媒体、AI 与连接器中枢中继、观察者角色等）；全部通过。都不需要硬件。

CI 运行 `HYDRA_UMC_CI=1 python tools/ci_validate.py`，检查清单、文档、八个 README 和图片。

## 🏗️ 构建与发布

### 系统要求

- [Node.js](https://nodejs.org/)（建议 v18 或更高版本）
- npm

### 安装

```bash
npm install
```

### 开发模式

直接使用 `tsx` 运行 API/WebSocket 服务器（无打包工具，不涉及前端）：
- **Windows：** 双击 `dev.bat`，或运行 `npm run dev`
- **Linux/Mac：** 运行 `./dev.sh` 或 `npm run dev`

### 生产构建

使用 esbuild 将服务器打包为单个可部署文件：
- **Windows：** 使用 `build.bat` 执行带版本递增的发布构建；仅编译时使用 `npm run build`。
- **Linux/Mac：** 使用 `./build.sh` 执行带版本递增的发布构建；仅编译时使用 `npm run build`。

随后以生产模式启动服务器：
```bash
npm start
```

服务器监听 `0.0.0.0:3000`——可通过 `http://localhost:3000` 或局域网内的 `http://<你的本地IP>:3000` 访问。所有状态均持久化于 `data/` 目录。

本仓库有意不提供 Dockerfile：服务器由 [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)（`provisioning/install_server.sh`）打包并安装到 CM5 上。

## 🩺 故障排除

| 你看到 | 原因 | 处理 |
|---|---|---|
| 生产环境下服务器启动时停止 | `NODE_ENV=production` 要求真实的 `JWT_SECRET`（至少 32 个字符，不能是示例值），且首次启动需要初始管理员 | 设置 `JWT_SECRET`、`HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME` 和 `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD`（见 `docs/PRODUCTION_BOOTSTRAP.md`） |
| 登录时出现 `429` | 同一地址在 15 分钟内登录失败超过 5 次 | 等待时间窗口结束；只在可信网络中提高 `LOGIN_RATE_LIMIT_MAX` |
| 浏览器应用被 CORS 拦截 | 生产环境中未设置 `CORS_ALLOWED_ORIGINS` 会拒绝所有浏览器跨源请求（curl、SUITE 和手机应用不受影响） | 用页面的来源设置 `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` |
| WebSocket 立即关闭，或摄像头画面无法加载 | 客户端把令牌放在地址中（`/ws?token=`，默认被拒绝），或不带票据打开画面（默认必需） | 使用 `hydra.bearer` 子协议和 `POST /api/camera/ticket`；退出开关 `HYDRA_UMC_WS_QUERY_TOKEN=allow` 和 `HYDRA_UMC_CAMERA_AUTH=open` 只是临时的 |
| 访问开关因被锁定而被拒绝，或 MAVLink 密钥文件被拒绝 | 该值由环境变量设置（优先于已保存的值），或密钥文件无法读取，或不是 32 字节或 64 个十六进制字符 | 修改或移除该变量并重启，或修正文件；MAVLink 桥在启动时读取其选项 |

## 📂 仓库结构

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>目录树的文本版本</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       源代码
│   ├── server.ts              精简的启动文件，把下列模块连接起来；/api 路由在 src/routes/，实时连接在 ws.ts，设置文件在 settingsStore.ts
│   ├── kinematics.ts          原子点动端点使用的逆运动学辅助工具
│   ├── metrics.ts             支撑 GET /metrics——Prometheus 文本格式输出（prom-client）
│   ├── ble/                   蓝牙 LE 服务:帧、网关(命令、确认、状态)与辅助程序传输
│   ├── users.ts               账户存储（scrypt 密码哈希）
│   ├── routes/                按领域划分的 /api 路由: 认证、设置、机器人预约、命令、安全限值、摄像头、蓝牙、管理、系统、到同级服务的中继、本地 AI、助手、工作文件、电源、信息和静态文件
│   ├── auth.ts                令牌校验、管理员关卡和速率限制器;刷新令牌存储;生产环境接受的签名密钥与首个密码;访问选项;向被中继服务出示的令牌
│   ├── claimPolicy.ts         谁控制哪台机器人;操作员对单台机器人的编辑;所有客户端必须遵守的限值;一次请求完成的 XY 工作台移动;以服务器为准的回放
│   ├── settingsStore.ts       磁盘上的设置文件、其备份、多个文件的全有或全无写入、审计记录与日志轮转
│   ├── ws.ts                  实时连接中心 (WebSocket)、通往单元代理的 MQTT 桥及其启动,以及第一个遥测生产者
│   ├── cameraHealth.ts        摄像头流是否真的在送出画面、IP 摄像头探测与 PTZ、流进程监督器,以及摄像头画面的短时效票据
│   └── ecosystemStatus.ts     生态系统的发现与存活检测、服务端口注册表、主机指标、进程运行时 (mDNS、端口)、纯策略辅助函数、机密脱敏、蓝牙配对辅助、上游地址以及语音请求的确认
├── admin-ui/                  为本服务器自身独立提供的 Vite/React 管理面板
├── data/                      运行时状态——设置、用户、日志、工作文件、已保存的点位
├── docs/                      项目文档
├── images/                    媒体与图示
├── systemd/                   服务单元
├── tools/                     项目工具和 CI 检查
├── tests/                     自动测试
├── monitoring/                可选的 Prometheus + Grafana 技术栈——见 monitoring/README.md
├── scripts/                   蓝牙 LE 辅助程序（BlueZ）和一个旧版本辅助脚本
├── .github/                   CI 工作流和 Issue 模板
├── bump_manifest_version.py   将 hydra-umc.project.json 的版本与原生版本同步（--sync）
├── build.bat / build.sh       安装依赖 + 生产构建
├── dev.bat / dev.sh           安装依赖 + 启动开发服务器
├── package.json               包的元数据和脚本
├── tsconfig.json              TypeScript 配置
├── CHANGELOG.md               每个版本的变更
├── LICENSE
├── build-test.sh              不修改内容的构建检查
├── hydra-umc.project.json     清单：版本、成熟度、系列
└── test.sh                    运行测试
```

</details>

## 🗺️ 路线图与已知限制

**目前已知的限制**

* 与带 STM32H745 板的真实 CM5 的连接（`spi_bridge`）是真实的代码，但只通过 API 和契约层验证过；从来没有实体板卡来完成最后一跳。
* 服务器监听所有接口（`0.0.0.0`）；目前还没有监听地址开关，因此限制暴露面的是防火墙或上面的访问开关。
* 开发环境（`NODE_ENV` 不是 `production`）使用内置签名密钥、`admin`/`admin` 账户和开放的 CORS 策略，各自带警告；生产环境拒绝它们。
* TLS、蓝牙 LE 和 MQTT 桥是可选的，默认关闭。

**下一步：** 每条新路由都遵循同一份清单（在 `docs/REMOTE_API.md` 中记录，在 `docs/openapi.json` 中命名，在 SDK 的客户端中定义类型）。

## 🌍 语言

本 README 和仓库文档提供八种语言：英语、西班牙语、德语、法语、意大利语、日语、中文和葡萄牙语（葡萄牙）。它们同时编写，并由 CI 检查八个文件拥有相同的章节和相同的链接。 本仓库没有自己的界面或消息目录，因此没有需要翻译的界面文字。

## 🔗 相关项目

本项目是同一作者(JuanenRac / Electro Hobby 3D)打造的 HYDRA-UMC 机器人生态系统的一部分。值得了解,因为某个请求实际上可能是关于这些项目之一,而非本仓库本身。

**子项目** —— 每一个都是真实的客户端或协调桥接,仅通过本服务器的 API 与机器人车队通信
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— 具有实时多机器人 3D 可视化的网页控制面板。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— 面向多台服务器的桌面(PySide6)集群指挥中心,打包为独立可执行文件。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— 具有生物识别登录和配对 Wear OS 伴侣应用的原生 Android 控制应用。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— 具有实时 WebSocket 同步的 iOS/iPadOS 控制应用(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— 面向机载 7 英寸 DSI 触摸屏的原生触控界面,直接嵌入 CM5 本体。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** —— 通过 VDA 5050 MQTT 发布者为 AGV/AMR 车队提供的协调边界(仅针对仿真车队测试)。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** —— 具备 GRBL 状态/控制字节访问能力的高层 CNC 单元协调器(仅针对模拟器测试)。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** —— 面向足式/人形机器人的协调边界,带有 Boston Dynamics Spot 指令发送器(仅针对模拟器测试)。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** —— 读取 3 路钥匙/外壳/联锁 GPIO 信号的激光单元协调器(仅针对模拟芯片测试;无法使激光器上膛或发射)。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** —— 面向 OpenPnP 贴片机板级流程的安全高层协调器。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** —— 面向 Moonraker/Klipper 3D 打印机的安全协调边界,具备真实的受控作业指令。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** —— 带有惰性导入 rclpy ROS 2 传输层的协调器(尚未在 ROS 2 环境中运行)。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** —— 面向搭载摄像头的无人机的协调边界,带有 MAVLink 指令发送器(仅针对模拟器测试)。

**直接相关**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** —— 本服务器通过回环连接向其中继有限的、经过认证的语音对话轮次,网关令牌始终保留在服务器端,因此语音永远不会直接变成机器人指令。
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— 机器人手臂主板设计(尚无已组装的电路板);本服务器自身的 `spi_bridge` 服务计划通过 CM5↔STM32H745 的 SPI-OTA 连接与之通信(仅针对模拟替身测试)。

**生态系统中的其他项目**

*核心硬件与平台*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** —— 面向本服务器所运行的 CM5 的可复现 Raspberry Pi OS 产品层——只读代理、经过验证的配置/配置文件、WiFi 首次配网。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** —— 每个桥接都据此校验自身指令的共享 JSON-Schema 契约与软件作业门限边界(并非经认证的安全功能)。
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — 面向外部机器连接器的声明式适配器清单注册与校验工具；把 SDK 自身的契约理念扩展到外部机器，而不取代工业网关类项目。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— 将完成的模型推送到本服务器自身目录的桌面版图形化 URDF 创建/编辑工具。
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — 桌面 STL 模型编辑器，在 HYDRA-UMC-EDITOR-URDF 编辑的同一模型目录中变换/替换/移除/添加真实部件。

*URTC 工具平台*
- **[URTC](https://github.com/JuanenRac/URTC)** —— 面向实体 Universal Robot Tool Controller 板卡的固件,通过 CAN 总线支持 25 种以上工具配置。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** —— 面向 URTC 板卡的桌面图形烧录工具,支持 CAN-OTA 以及全芯片 SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** —— 面向 URTC 板卡的桌面实时 CAN 总线诊断工具,每种工具配置对应一个面板。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— 通过 Web Serial API 实现的浏览器版 URTC-TESTER 替代方案,无需本地安装。
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** —— URTC CAN 总线前的网关：允许的标识符列表、速率限制和会话密钥；软件已在计算机上测试，尚未在真实总线上测试。

*视觉 AI 节点(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** —— 面向 Hailo-8 视觉流水线的集成中枢,具备逐阶段的真实硬件就绪检测。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** —— 具备 Hailo 架构/校验和安全加载验证的真实编译模型注册表。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** —— 具备真实 HailoRT 集成边界的真实 GStreamer 流水线 + MediaMTX 配置生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** —— 以区域状态为授权条件的 Position-Based Visual Servoing 修正律;尚无摄像头位姿估计。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** —— 从文件读取物体位置的 v0 区域入侵、校准新鲜度与 E-STOP 请求逻辑;没有检测器为其供数,也尚未连接任何物理 E-STOP。

*认知 AI 节点(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** —— 面向 Hailo-10 认知流水线(LLM/VLA/语音编排)的集成中枢。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** —— 面向 Vision-Language-Action 模型的真实动作 token 编解码与轨迹生成。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** —— 基于真实规则的任务分解,以及针对 MCU 错误码的语义化错误恢复。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** —— 面向本生态系统自身 Markdown 文档的真实纯标准库 TF-IDF 文档检索。
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — 面向生态系统自身的本地、按策略门控的 AI 维护技师——观察、诊断并提出修复建议;两个最高风险等级目前特意尚未实现。

*编排与集群*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** —— 具备真实 gRPC/Protobuf 健康报告契约与任务状态机的集成中枢。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** —— 基于真实 HTTP API 的真实优先级任务队列,支持去重。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** —— 具备重试/退避与身份不匹配检测的真实基于 gRPC 的车队健康看门狗。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** —— 具备真实障碍物/工作空间碰撞校验的真实基于 RRT 的三维路径规划器。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** —— 经过多单元收敛属性测试的真实 CRDT LWW-Element-Map 状态同步。

*数字孪生与仿真*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** —— 面向数字孪生引擎的集成中枢,具备真实的版本兼容性同步契约。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** —— 在仿真与真实硬件之间带有软件碰撞联锁的硬件在环路由器(未在真实硬件上测试)。
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** —— 面向真实 URDF 子集的真实正向运动学与关节限位校验。
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** —— 具备 YOLO/COCO 标注导出功能的真实程序化 2D 场景生成器。

*数据与分析*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** —— 具备真实数据摄入/查询 HTTP API 的真实 sqlite3 时序数据存储。
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** —— 具备漂移监测能力的真实 FFT + 统计基线异常检测器。
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** —— 基于 DATALAKE 历史数据的真实 OEE/可用率计算,支持可复现的 CSV 导出。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** —— 面向 DATALAKE 的真实 CAN/WebSocket 数据摄入管道,支持序列去重。

*工业网关*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** —— 中继至工业协议的集成中枢,具备真实的指令白名单/背压控制层。
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** —— 经真实二进制协议客户端会话验证的真实 OPC-UA 地址空间。
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** —— 具备可选按客户端认证与主题 ACL 的真实 MQTT 代理。
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** —— 具备降级模式输出的真实 MTConnect `/probe` 与 `/current` XML 端点。

*辅助工具与生态系统运维*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** —— 基于 DATALAKE/ANOMALY-DETECTOR 的智能摘要与异常高亮面板,具备诚实的统计回退机制。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** —— 具备真实、稳定退出码契约的车队 CLI,是本服务器自身 API 的真实在线客户端。
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** —— 带有触觉提醒模式与配对手机语音中继的 WearOS 伴侣应用(尚未在实体手表上运行)。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** —— 面向板卡安装机架的固件,具备真实的工具 ID 解码与 Smart Idle 预热逻辑。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** —— 面向热成像/RGB 检测工具头的固件及真实 Python 视觉伴侣程序。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** —— 发现、克隆并更新本生态系统中每个仓库的管理类桌面工具。
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** —— 构建即刻可烧录、预装生态系统最新版本的 CM5 镜像的 Windows/Linux 桌面工具,具备类似 Raspberry Pi Imager 风格的首次启动 Wi-Fi/用户/SSH 配置。
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — 维护事件协调器：一个低权限的边缘角色采集经过脱敏的库存/健康快照，一个控制面角色以只读方式渲染它，并请求某个 AI 提供方给出诊断建议——从不应用补丁，也从不部署任何内容。
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — 可复现的开发主机（Raspberry Pi 5 / CM5），保存整个生态系统的源代码，并在持久队列下运行有界的构建/测试任务；这是专用的开发角色，明确区别于运行中的 CM5。

## 📚 文档

更多阅读：

* [生态系统的安全基线](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [生态系统的威胁模型](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [本仓库的更新日志](CHANGELOG.md)
* [本仓库的许可证](LICENSE.md)

## 🤝 参与贡献与社区

* 提交 pull request 之前，请运行 `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py`（或 `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`）：它必须输出 `CI_VALIDATION=PASS`。此检查不要运行 `build.sh` 或 `build.bat`；构建不是检查。
* 八个 README 由 HYDRA-UMC-DOCS 中的同一个源生成；请勿手工编辑。修改源文件，再用 `tools/make_readmes.py` 重新生成。
* 不要在 README 中声称尚未运行过的内容：属实时请写“仅模拟”或“尚未在硬件上试过”。
* 请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)、[SECURITY.md](SECURITY.md) 和 [SUPPORT.md](SUPPORT.md)。

## 👤 作者

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 许可证

GPL-3.0-or-later - [LICENSE](LICENSE).
