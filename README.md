# GoTTY Hub

自托管 GoTTY 终端工作台：GoTTY 主动出站连接 Hub，浏览器通过用户名和密码登录访问获授权实例。Rust/Axum + SQLite 后端、GoTTY Go Connector、React/BoardUI + 原生 xterm 前端。终端复用 GoTTY WebTTY 与显示偏好核心，不嵌入远程管理网页，不提供通用代理。

已实现公开用户名注册/密码登录、本机密码重置、授权角色、一次性终端票据、设备注册/轮换/解绑、实时状态、多标签/双分屏、折叠/最大化、ZMODEM 文件和可选 ASR。默认页面连接真实后端；`?preview=1` 仅用于保留 UI 演示。

## 安装

Linux amd64：

```sh
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-amd64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

Linux arm64：

```sh
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-arm64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

## 首次配置与管理员

发布 binary 已嵌入前端。管理员用户名固定为 `admin`，首次直接运行只需交互设置密码，保存到权限 `0600` 的 `~/.gotty-hub/config`；数据库、日志和升级数据也默认存放在 `~/.gotty-hub`。

```sh
./gotty-hub
# 或用启动参数覆盖 config 中的密码
./gotty-hub serve --password 'YOUR_ADMIN_PASSWORD'
# 显式保存配置；也支持 --password-stdin
./gotty-hub config --password 'YOUR_ADMIN_PASSWORD'
```

优先级：`--password` / `--password-stdin` > `HUB_PASSWORD` > config。管理员从右上角账号齿轮进入统计、升级/重启、日志后台。普通用户在 Web 注册用户名和密码后即可登录。详见 [管理员与发布说明](docs/ADMINISTRATION.md)。当前 0.2 为全新账号结构，使用全新数据目录初始化。

默认监听 `0.0.0.0:8088`，可通过 `HUB_LISTEN` 覆盖。直接通过服务器 IP 或任意指向 Hub 的域名访问，均无需配置外部地址；更换域名后继续运行 `gotty-hub` 即可。保留外部 `Host` 的 HTTPS 反代即使未发送转发头，也能根据浏览器来源识别 HTTPS、设置 Secure Cookie，登录、刷新与终端 WebSocket 使用当前访问地址。旧的 `--origin`、`HUB_ORIGIN` 和 config 中的 `origin` 兼容接受并忽略，不会锁定旧域名。

浏览器来源仍需匹配本次请求的域名和端口。若代理改写了 `Host`，需保留外部 `Host`，或由可信代理覆盖 `X-Forwarded-Host`；默认只信任回环代理，容器或跨机器代理可配置可信代理 IP/CIDR。代理配置遵循 `--trusted-proxies` > `HUB_TRUSTED_PROXIES` > config；`--trusted-proxies none` 禁用转发头。代理示例见 [部署与运维](docs/OPERATIONS.md)。

前台 Ctrl-C / SIGTERM 和后台重启共用退出流程：主动结束 SSE/WebSocket，连接排空最多3秒，含数据库/日志/运行时清理的总退出上限5秒；再次发送退出信号立即强制结束。退出信号优先于待执行重启，保留设备绑定、用户会话和远程 PTY。

## 本地运行

需要 Rust（见 Cargo.lock）、Node.js 24、GoTTY 对应版本；浏览器测试需要 Chromium，文件测试需要 rz/sz。

```sh
cd frontend
npm ci
npm run build
cd ..
cargo run --locked
```

另一个终端启动前端：

```sh
cd frontend
npm run dev -- --port 5178
```

打开 http://localhost:5178。Vite 保留请求 Host，将 API/Connector 转发到 8088。首次设置 admin 密码，然后在 Web 注册普通账号。前端与后端均按当前请求地址工作，无需设置域名或 origin。

GoTTY 启动示例：

```sh
gotty --permit-write bash
```

GoTTY 的 Hub 功能默认开启，可用 `--hub-disabled` 关闭。在 GoTTY 页面点击右上角 Hub 图标，在按钮旁展开的面板中填写 Hub 地址和已注册的用户名，可选填写显示名字，留空自动生成。同一用户下名称重复会拒绝接入并提示修改。接入成功后以绿色背景提示，配置变为只读，可编辑、重新接入或断开并保留配置。HTTP 和 HTTPS 默认均可使用，无需额外开关；可通过 `--hub-allow-http=false` 仅允许 HTTPS。用户名不存在时会提示先前往 Hub Web 注册并提供链接。已有 GoTTY 密码时复用登录态；无密码且启用 Hub 时，主站访问者可管理绑定，所有分享页面均无权管理。

## 构建与验证

推送 `main` 后，GitHub Actions 会自动构建 Linux amd64/arm64 单文件程序，更新固定的 `latest` Release 和同名下载文件。

```sh
make build
make check
cargo test --locked
cd frontend && npm test && npx playwright install chromium && npm run test:ui
```

真实集成测试要求先构建 GoTTY 二进制，再设置 `GOTTY_BIN`：

```sh
GOTTY_BIN=/absolute/path/gotty python3 tests/run-integration.py
HUB_LOAD_SECONDS=1800 GOTTY_BIN=/absolute/path/gotty python3 tests/run-load.py
```

测试自动隔离端口、SQLite、账号和设备身份，清理进程；无需邮件服务。语音测试使用本地确定性 ASR fixture。共享核心通过带 npm integrity 的 `frontend/vendor/` 包锁定，Hub 可独立构建。

## 文档

- [用户名账号与单步接入规划](docs/USERNAME_AUTH_PLAN.md)
- [本次整体 Review](docs/USERNAME_AUTH_REVIEW.md)
- [架构决策、协议及兼容边界](docs/ARCHITECTURE_DECISIONS.md)
- [API 与协议契约](docs/API.md)
- [部署、备份恢复和升级](docs/OPERATIONS.md)
- [历史实施与发布记录](docs/IMPLEMENTATION_REVIEW.md)
- [反代登录与进程退出 Review](docs/PROXY_AND_SHUTDOWN_REVIEW.md)

单节点首版，一个实例对应 GoTTY 当前共享 PTY。标签关闭不停止远端命令。iOS/Android 真机、容器运行和公网 TLS 需在目标环境验收；本地浏览器模拟不代替实机验证。

终端主题、字体、右侧工具栏与接入面板本次对齐及权限边界，见 [终端与接入 Review](docs/TERMINAL_AND_BINDING_REVIEW.md)。
