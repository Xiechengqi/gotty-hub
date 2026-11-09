# GoTTY Hub

自托管 GoTTY 终端工作台：GoTTY 主动出站连接 Hub，浏览器通过邮箱认证访问获授权实例。Rust/Axum + SQLite 后端、GoTTY Go Connector、React/BoardUI + 原生 xterm 前端。终端复用 GoTTY WebTTY 核心，不嵌入远程管理网页，不提供通用代理。

已实现邮箱验证码/密码登录、密码重置、授权角色、一次性终端票据、设备注册/轮换/解绑、实时状态、多标签/双分屏、折叠/最大化、ZMODEM 文件和可选 ASR。默认页面连接真实后端；`?preview=1` 仅用于保留 UI 演示。

## 首次配置与管理员

发布 binary 已嵌入前端。首次直接运行会交互设置两个非空值：Resend API key、admin email，保存到 `~/.gotty-hub/config`；数据库、日志与升级数据默认也在 `~/.gotty-hub`。可运行 `gotty-hub config --resend-api-key KEY --admin-email EMAIL` 保存，或 `gotty-hub serve --resend-api-key KEY --admin-email EMAIL` 临时覆盖（参数优先于 config）。管理员登录后从账号齿轮进入统计、升级/重启、日志后台。详见 [管理员与发布说明](docs/ADMINISTRATION.md)。

## 本地运行

需要 Rust（见 Cargo.lock）、Node.js 24、GoTTY 对应版本；浏览器测试需要 Chromium，文件测试需要 rz/sz。

```sh
cd frontend
npm ci
npm run build
cd ..
HUB_DEV=1 HUB_ORIGIN=http://localhost:5178 cargo run --locked
```

另一个终端启动前端：

```sh
cd frontend
npm run dev -- --port 5178
```

打开 http://localhost:5178。Vite 将 API/Connector 转发到 8088。首次仍需设置上述两个值；开发邮件写入 `~/.gotty-hub/mail/`，从本机读取验证码；不会发送真实邮件。直接访问后端时将 HUB_ORIGIN 设置为浏览器实际使用的 origin，例如 `http://127.0.0.1:8088`。不同主机名/端口不能混用。

GoTTY 启动示例：

```sh
gotty --permit-write --hub-enabled --hub-allow-http bash
```

在 GoTTY 页面打开“接入 Hub”，填写 Hub 地址、实例名和所有者邮箱，使用邮件验证码确认。无主密码时，需要读取 `~/.gotty/hub.json.admin` 的本机管理令牌；不可交给分享访问者。生产去掉 `--hub-allow-http`，使用 HTTPS Hub。

## 构建与验证

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

测试自动隔离端口、SQLite、开发邮箱和设备身份，清理进程；不会调用真实 Resend。语音测试使用本地确定性 ASR fixture。共享核心通过带 npm integrity 的 `frontend/vendor/` 包锁定，Hub 可独立构建。

## 文档

- [完整规划与实施状态](docs/IMPLEMENTATION_PLAN.md)
- [架构决策、协议及兼容边界](docs/ARCHITECTURE_DECISIONS.md)
- [API 与协议契约](docs/API.md)
- [部署、备份恢复和升级](docs/OPERATIONS.md)
- [整体 Review 与验证记录](docs/IMPLEMENTATION_REVIEW.md)

单节点首版，一个实例对应 GoTTY 当前共享 PTY。标签关闭不停止远端命令。iOS/Android 真机、真实 Resend、容器运行和公网 TLS 需在目标环境验收；本地浏览器模拟不代替实机验证。
