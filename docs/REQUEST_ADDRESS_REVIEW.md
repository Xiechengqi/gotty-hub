# 任意访问域名与 HTTPS 地址识别 Review

## 根因

线上浏览器使用 `https://tty.hn1.pp2pdf.com`，Hub 却记录预期地址为 `http://tty.hn1.pp2pdf.com`。旧实现没有取得可信的 `X-Forwarded-Proto: https` 时，按 HTTP 构造校验地址；静态页面导航通常没有 Origin，能够打开，但登录 POST 携带 HTTPS Origin，在验证密码前被拒绝。现有日志只能确定未取得可信 HTTPS 信息，不能区分代理未发送、转发过程中改写或真实对端不在可信列表。

显式指定 `--origin https://tty.hn1.pp2pdf.com` 后成功，验证了地址识别问题。该方案会固定域名；继续保存 config.origin，还会在以后换域名时沿用旧地址，不能满足随访问域名自动适配的要求。

## 最终行为

- 不维护域名白名单或全局固定地址。每次请求按 Host 确定域名/端口；真实 socket 对端可信时，可使用其覆盖的 X-Forwarded-Host。
- 浏览器 Origin 只能为匹配该 authority 的地址确定 HTTP/HTTPS；其他域名、端口、无效值、重复头和逗号链仍被拒绝。HTTPS 反代保留外部 Host 时，不依赖转发头即可登录和连接终端。
- 所有前端 API 请求携带 X-Hub-Origin（location.origin），让不含 Origin 的 GET /me 在刷新后仍返回正确 HTTPS 地址。该提示也检查域名/端口，与真正 Origin 冲突时拒绝；终端 WebSocket 仍必须提供真正的 Origin。
- 没有浏览器来源的设备/运维请求，scheme 使用可信 X-Forwarded-Proto 或 HTTP。Cookie Secure、hub_address、HSTS、认证及浏览器 WebSocket 共用解析结果。
- 旧 --origin、HUB_ORIGIN、config.origin 兼容接受但忽略，已有 config 无需清理。保存 config 或更新管理员密码时不再写入 origin；密码和可信代理配置继续保留。
- Compose、环境示例和开发命令取消固定域名要求。升级到该版本后，更换域名不需要执行 origin 配置命令，也不需要仅为换域名重启 Hub；新域名需解析并反代到服务，浏览器在新域名重新登录。

## 整体复核

任意访问域名与跨站请求分别处理：浏览器来源仍需匹配本次请求的 Host / 可信转发 Host；不从任意 Origin 获取可替换主机，不放开所有代理 IP。默认仍只信任回环，X-Forwarded-For 不授予信任；可信代理的歧义转发头继续返回 400。反代改写 Host 时，需保留外部 Host 或配置真实代理 IP 并覆盖 X-Forwarded-Host。

登录仍验证密码；写操作继续验证会话、权限和 CSRF；终端仍验证会话、必需 Origin、一次性票据及实例权限。Cookie 为域名隔离的 HttpOnly / SameSite=Strict，HTTPS 登录保留 Secure。旧固定域名不会覆盖当前请求；修改管理员密码不会丢失可信代理配置。未改动设备身份、绑定、远端 PTY 或退出流程。

## 验证

本地按约束只执行单元/内存测试、静态检查和构建：

- Rust：29 项服务端测试及 1 项协议测试通过，覆盖无代理 HTTPS 信息、旧 origin、连续换域名、IPv4/IPv6、端口、HTTPS Cookie、刷新地址、跨站/冲突来源、CSRF 和密码校验。
- cargo fmt、Clippy（全部 targets，warnings 为错误）、cargo build 通过。
- 前端 7 项单元测试及 TypeScript / Vite 生产构建通过。
- CI Node/Python 脚本语法和 git diff 空白检查通过。

CI 回归脚本已补充 Host-only TLS 反代、连续换域名、遗留 CLI/环境/config origin、HTTPS 刷新、真实 WSS 数据往返、外域和缺失 Origin 拒绝；保留原有真实代理及信号退出/重启检查。按用户要求未在本地启动 Hub、部署、执行浏览器验证或截图，真实进程回归由 GitHub Actions 执行；推送后不等待构建完成。本轮静态复核和已执行检查未发现阻断项。
