<h4 align="right"><a href="README_EN.md">English</a> | <strong>简体中文</strong></h4>

<p align="center">
  <img src="resources/icon.svg" alt="GoTTY icon" width="72" height="72">
</p>

<h1 align="center">GoTTY Hub</h1>

<p align="center"><strong>把分散的 GoTTY 实例接入同一个终端工作台。</strong></p>

<p align="center">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust">
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react">
  <img alt="Terminal" src="https://img.shields.io/badge/xterm.js-6.x-111827?style=flat-square">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-amd64%20%2F%20arm64-2563eb?style=flat-square&logo=linux">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

GoTTY Hub 是 [GoTTY](https://github.com/Xiechengqi/gotty) 的自托管终端工作台。各台设备上的 GoTTY 主动连接 Hub，用户通过一个网页登录、切换终端和管理实例授权，无需浏览器直接访问每台设备的 GoTTY 端口。

Hub 以单个二进制程序发布，内嵌 React / xterm.js 前端，使用 Rust / Axum 和 SQLite 提供账号、设备连接及终端中继。终端复用 GoTTY 的 WebTTY 与显示偏好核心，PTY 和命令进程始终运行在 GoTTY 所在设备。

典型链路：

```text
browser
  -> HTTP / WebSocket
  -> gotty-hub
  -> authenticated terminal relay
  -> gotty (over its outbound WS / WSS connection)
  -> PTY
  -> local command / shell
```

每个实例对应 GoTTY 当前共享的 PTY。多个浏览器可以访问同一会话，关闭 Hub 标签不会停止远端命令。

## 特性

- 用户名 / 密码注册和登录，固定 `admin` 管理员账号，首次启动交互设置管理员密码。
- 侧边栏直接显示有权访问的实例，支持多标签、双分屏、折叠导航和终端最大化。
- 侧边栏和标签行支持鼠标拖动、触摸长按和键盘排序，两处顺序同步并保存到用户偏好。
- 状态点与远端 GoTTY 同步：红色为正在查看、黄色为未查看时有新输出、绿色为输出已停止但尚未查看、灰色为无未读输出；离线使用独立图标。
- xterm.js 终端，默认 Nord 主题、内置 Source Code Pro 字体和 14px 字号；主题、字号和字体在“设置 → 终端设置”统一调整，保存到当前账号并应用于全部终端。
- 其他开源字体按需从本站加载并缓存到浏览器，刷新后复用字体数据；光标和回滚设置继续由 GoTTY 配置提供。
- 右侧工具栏提供连接数、刷新当前终端、清屏、文件上传，以及按权限开放的远端重启和分享管理；重启使用电源图标并需确认。
- 移动端软键盘打开时显示与 GoTTY 一致的两行 16 键，支持一次性 Ctrl / Alt / Shift 和导航键长按。
- 所有者、操作者、观察者三种角色；终端输入、文件和语音同时受 Hub 授权与 GoTTY 配置约束。
- 原生文件上传、拖放上传、ZMODEM 传输和可选 ASR 语音输入；ZMODEM 需要远端安装 `rz` / `sz`。
- 自动重连和输出回放，支持设备凭据轮换、断开和解绑。
- 右上角“设置”菜单提供终端设置、控制台（统计、在线升级、重启和日志，仅 `admin`）、修改密码，以及退出当前账号或所有设备；最大化或折叠导航后仍可访问终端设置。
- Linux amd64 / arm64 单文件发布，默认数据目录为 `~/.gotty-hub`。

## 快速开始

Linux amd64 安装：

```bash
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-amd64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

Linux arm64 安装：

```bash
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-arm64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

首次启动：

```bash
gotty-hub
```

按提示输入一个非空管理员密码。用户名固定为 `admin`，密码保存到权限为 `0600` 的 `~/.gotty-hub/config`；后续启动读取已保存的配置。

默认监听 `0.0.0.0:8088`。本机浏览器打开：

```text
http://localhost:8088
```

远程访问时将 `localhost` 替换为服务器 IP 或指向 Hub 的域名。使用 `admin` 登录可进入控制台，也可以在登录页注册普通账号。

## 接入 GoTTY

在需要接入的设备安装当前版本的 [GoTTY](https://github.com/Xiechengqi/gotty)，启动一个可交互终端：

```bash
gotty --permit-write bash
```

在 Hub 网页注册账号后，打开 GoTTY 页面，点击右上角“接入 Hub”，在按钮旁展开的面板中填写：

| 字段 | 说明 |
| --- | --- |
| Hub 地址 | GoTTY 设备可访问的 Hub 根地址，例如 `https://hub.example.com` |
| 用户名 | 已在 Hub 注册的用户名，例如 `alice` |
| Hub 中显示的名字 | 可选，例如 `dev-workspace`；留空自动生成 |

接入只需 Hub 地址和用户名，无需输入 Hub 密码或验证码。用户名不存在时会提示先到 Hub 注册。同一用户下的实例名去除首尾空白后，ASCII 字母不区分大小写，重名会拒绝接入并给出提示。

成功后显示绿色提示，配置变为只读；可以通过“编辑”修改配置、“重新接入”复用身份，或“断开”停止连接并保留配置。GoTTY 的 Hub 功能默认开启，HTTP 和 HTTPS 均可使用；`--hub-disabled` 关闭 Hub 功能，`--hub-allow-http=false` 仅允许 HTTPS。

绑定凭据按稳定的监听地址、端口和路径隔离，保存在 GoTTY 设备的 `~/.gotty/hub/<标识>.json`；若 `~/.gotty` 是配置文件，则使用 `~/.gotty-hub-bindings/<标识>.json`。同一身份文件禁止多个进程同时使用。旧共享文件不会被自动复用，迁移方法见 [实例身份迁移](docs/WORKSPACE_RECOVERY.md)。已有 GoTTY 密码时复用登录态，无密码时主站访问者可以管理绑定；分享页面不能管理 Hub 配置。

## 账号与权限

普通用户名为 3–64 位 ASCII 字母、数字、点、连字符或下划线，以字母或数字开头，登录时不区分大小写。普通用户密码为 12–256 字节，数据库保存 Argon2id 哈希。

实例所有者可以在实例设置中向其他已注册用户授权：

| 角色 | 能力 |
| --- | --- |
| 所有者 | 使用终端、管理授权、轮换设备凭据、解绑；设备支持时可重启 GoTTY 和管理分享 |
| 操作者 | 使用终端输入、文件传输和已启用的语音输入 |
| 观察者 | 查看终端和调整自己账号的终端显示设置 |

写入能力仍由 GoTTY 的 `--permit-write` 控制；观察者始终只读。知道用户名可以将自己控制的 GoTTY 注册给该用户，但不能因此登录该账号或访问其已有实例。

忘记普通用户密码时，在 Hub 服务器上执行：

```bash
gotty-hub users reset-password --username alice
```

重置后撤销该用户已有会话。管理员可通过修改本地配置或启动时传入 `--password` 恢复访问。

## 配置文件

默认配置路径为 `~/.gotty-hub/config`，内容为 JSON：

```json
{
  "password": "YOUR_ADMIN_PASSWORD"
}
```

该文件保存原始管理员密码，权限为 `0600`，父目录为 `0700`。管理员密码非空、不能全为空白，最多 256 字节。

启动时临时覆盖管理员密码：

```bash
gotty-hub serve --password 'YOUR_ADMIN_PASSWORD'
```

显式保存配置，或检查已保存的配置：

```bash
gotty-hub config --password 'YOUR_ADMIN_PASSWORD'
gotty-hub check
```

密码优先级为 `--password` / `--password-stdin` > `HUB_PASSWORD` > config。已有配置时，启动参数和环境变量覆盖只对本次进程生效；`config` 子命令负责持久化，也支持 `configure` 别名。密码从标准输入传入时使用 `--password-stdin`。

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `HUB_LISTEN` | 监听地址，默认 `0.0.0.0:8088` |
| `HUB_HOME` | 数据根目录，默认 `~/.gotty-hub`；覆盖值必须是绝对路径 |
| `HUB_PASSWORD` | 覆盖管理员密码，优先级低于 CLI、高于 config |
| `HUB_TRUSTED_PROXIES` | 可信代理 IP / CIDR，逗号分隔；默认只信任回环，`none` 禁用转发头 |
| `HUB_DATABASE` | 自定义 SQLite 连接 URL，默认使用数据目录中的 `hub.db` |
| `HUB_ASSETS` | 可选的完整前端构建目录；默认使用内嵌资源，外部资源在启动时固定为快照 |

可信代理配置优先级为 `--trusted-proxies` > `HUB_TRUSTED_PROXIES` > config 的 `trusted_proxies` 数组 > 回环默认值。完整说明见 [管理员与配置](docs/ADMINISTRATION.md)。

## 控制台

以 `admin` 登录后，点击导航栏右上角“设置”，选择“控制台”：

- **统计**：用户数、注册 / 在线 / 离线实例、有效会话、运行时间、版本和提交信息。
- **升级 / 重启**：检查本仓库的 `latest` Release，校验 SHA256，备份旧程序和数据库后替换并重启。
- **日志**：查看当前日志末尾，自动刷新；日志不记录密码、Cookie、设备秘密或终端负载。

前台 Ctrl-C / SIGTERM 与后台重启共用退出流程，主动关闭 SSE / WebSocket，保留用户会话、设备绑定和远端 PTY。连接排空最多 3 秒，总退出上限 5 秒；再次发送退出信号会立即强制结束。

## 反向代理

Hub 接受任意指向它的域名或 IP，更换域名无需修改配置或重启 Hub。`--origin`、`HUB_ORIGIN` 和旧 config 中的 `origin` 已弃用，兼容接受但忽略。

HTTPS 通过反向代理提供。保留外部 `Host` 时，浏览器来源可用于识别当前 HTTPS 地址；若代理改写了 `Host`，由可信代理覆盖 `X-Forwarded-Host`。浏览器来源的域名和端口仍需匹配本次请求地址。

Nginx 的 `http` 段添加：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

在已配置域名和 TLS 证书的 `server` 中使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

代理需支持 WebSocket，并关闭 SSE 缓冲。容器或跨机器代理改写 `Host` 时，应配置实际代理的 IP / CIDR。Caddy、Docker Compose、备份恢复和页面资源缓存说明见 [部署与运维](docs/OPERATIONS.md)。

## 文件和运行态

| 路径 | 用途 |
| --- | --- |
| `~/.gotty-hub/config` | 管理员密码及可选可信代理配置 |
| `~/.gotty-hub/hub.db` | SQLite 账号、授权、会话、实例和用户偏好 |
| `~/.gotty-hub/logs/hub.log.*` | 轮转日志 |
| `~/.gotty-hub/ui-assets/` | 当前及前两代前端 hash 资源归档 |
| `~/.gotty-hub/upgrade.json` | 升级状态 |
| `~/.gotty-hub/updates/` | 升级暂存、旧程序和数据库备份 |

`HUB_HOME` 覆盖整个数据根目录。GoTTY 的 PTY、命令和设备身份保留在各自设备上。

## 构建

需要 Rust stable、Node.js 24、npm 和 GNU Make：

```bash
git clone https://github.com/Xiechengqi/gotty-hub.git
cd gotty-hub
make build
```

产物为 `target/release/gotty-hub`，包含前端静态资源。共享终端核心通过 `frontend/vendor/` 中带 npm integrity 的版本包锁定，Hub 可独立构建。

开发时，完成前端构建后启动后端：

```bash
cargo run --locked
```

另一个终端启动 Vite：

```bash
cd frontend
npm run dev -- --port 5178
```

打开 `http://localhost:5178`；Vite 将 API / Connector 转发到 `8088`。`?preview=1` 仅展示演示数据。

## 验证与发布

单元测试和静态检查：

```bash
make check
cargo test --locked
(cd frontend && npm test)
python3 scripts/check-core.py
git diff --check
```

[发布工作流](.github/workflows/build-release.yml) 在推送 `main`、推送 `v*` 标签或手动触发时运行前端测试、Rust 检查，以及隔离进程中的配置引导、HTTPS 反代、WSS / SSE、退出重启和生产页面回归。

验证通过后构建 Linux amd64 / arm64 静态 musl 二进制及 SHA256 文件，统一更新名为 `latest`、标签为 `latest` 的 Release。下载地址保持不变，发布说明记录实际提交。真实 GoTTY 集成和负载脚本分别见 [run-integration.py](tests/run-integration.py) 与 [run-load.py](tests/run-load.py)。

## 项目文档

- [管理员、配置与在线更新](docs/ADMINISTRATION.md)
- [部署、反向代理、备份与恢复](docs/OPERATIONS.md)
- [架构决策、协议及兼容边界](docs/ARCHITECTURE_DECISIONS.md)
- [API 与设备协议](docs/API.md)
- [终端与设备接入 Review](docs/TERMINAL_AND_BINDING_REVIEW.md)
- [页面加载、移动终端与同步排序 Review](docs/UI_LOADING_AND_TERMINAL_REVIEW.md)
- [账号终端设置与字体缓存](docs/TERMINAL_SETTINGS.md)
- [终端设置与字体整体 Review](docs/TERMINAL_SETTINGS_REVIEW.md)
- [实施规划](docs/IMPLEMENTATION_PLAN.md) 与 [历史 Review](docs/IMPLEMENTATION_REVIEW.md)

## License

[MIT](LICENSE)

真实浏览器回归（12 个 GoTTY、Vim、回放、布局恢复与移动端）见 [workspace-regressions.cjs](tests/workspace-regressions.cjs)，运行方式见 [工作区修复与迁移](docs/WORKSPACE_RECOVERY.md)。
