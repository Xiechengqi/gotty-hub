# GoTTY Hub

自托管 GoTTY 终端工作台：GoTTY 主动出站连接 Hub，浏览器通过用户名和密码登录访问获授权实例。Rust/Axum + SQLite 后端、GoTTY Go Connector、React/BoardUI + 原生 xterm 前端。终端复用 GoTTY WebTTY 核心，不嵌入远程管理网页，不提供通用代理。

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

默认监听 `0.0.0.0:8088`，可通过 `HUB_LISTEN` 覆盖。未设置 `HUB_ORIGIN` 时，按当前 HTTP 请求的 Host 做同源校验，可直接通过 `http://服务器IP:8088` 登录。`HUB_ORIGIN` 可将访问地址固定为指定的 HTTP(S) 根地址；HTTPS 反向代理应设置为外部地址，例如：

```sh
HUB_ORIGIN=https://hub.example.com ./gotty-hub
```

## 本地运行

需要 Rust（见 Cargo.lock）、Node.js 24、GoTTY 对应版本；浏览器测试需要 Chromium，文件测试需要 rz/sz。

```sh
cd frontend
npm ci
npm run build
cd ..
HUB_ORIGIN=http://localhost:5178 cargo run --locked
```

另一个终端启动前端：

```sh
cd frontend
npm run dev -- --port 5178
```

打开 http://localhost:5178。Vite 将 API/Connector 转发到 8088。首次设置 admin 密码，然后在 Web 注册普通账号。开发模式显式固定的 HUB_ORIGIN 应与浏览器访问地址一致；直接访问后端可不设置此变量，由请求 Host 自动确定 HTTP origin。

GoTTY 启动示例：

```sh
gotty --permit-write bash
```

GoTTY 的 Hub 功能默认开启，可用 `--hub-disabled` 关闭。在 GoTTY 页面点击右上角 Hub 图标，只填写 Hub 地址和已注册的用户名，一次提交完成接入；实例名称自动生成。HTTP 和 HTTPS 默认均可使用，无需额外开关；可通过 `--hub-allow-http=false` 仅允许 HTTPS。用户名不存在时会提示先前往 Hub Web 注册并提供链接。已有 GoTTY 密码时复用登录态；无密码且启用 Hub 时，主站访问者可管理绑定，所有分享页面均无权管理。

## 构建与验证

推送 `main` 后，GitHub Actions 会自动构建 Linux amd64/arm64 单文件程序，更新固定的 `latest` Release 和同名下载文件。

```sh
make build
make check
cargo test --locked
cd frontend && npx playwright install chromium && npm run test:ui
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

单节点首版，一个实例对应 GoTTY 当前共享 PTY。标签关闭不停止远端命令。iOS/Android 真机、容器运行和公网 TLS 需在目标环境验收；本地浏览器模拟不代替实机验证。
