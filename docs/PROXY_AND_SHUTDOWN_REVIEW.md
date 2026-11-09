# HTTPS 反代登录与前台退出修复 Review

本轮范围：修复 HTTPS 反代下登录的 `origin_mismatch` 和前台 Ctrl-C 无法退出；统一后台重启/升级的生命周期。不改变 GoTTY 终端、远端 PTY、实例凭据、授权及用户名账号结构。

## 根因与处理

| 问题 | 原因 | 处理 |
|---|---|---|
| HTTPS 域名登录失败 | 未固定 HUB_ORIGIN 时按 `http://Host` 校验；浏览器实际 Origin 为 HTTPS，且代理可能改写 Host | 新增可信代理外部地址解析，默认信任回环 socket 对端，可配置 IP/CIDR；认证、Cookie、hub_address、HSTS 和浏览器 WS 共用解析结果 |
| Ctrl-C 卡住 | 单次信号监听触发 Axum 排空后，SSE 响应体无限持续；原超时仅用于管理员重启；信号处理器被 Tokio 接管后再次 Ctrl-C 不恢复默认退出 | 持续监听信号、统一取消令牌、主动结束 SSE/WS/后台任务、连接排空3秒、进程总退出上限5秒；第二次退出信号强制结束 |
| 升级任务影响退出 | 下载/版本探测/清理原先不受统一取消管理 | 追踪升级任务并取消下载；暂存文件 RAII 清理，版本探测 kill_on_drop，最终原子替换前再次检查退出状态 |
| 新增配置可能丢失 | 原管理员密码修改以仅含 password 的对象重写 config | 读取已有配置并仅更新 password，保留 origin/trusted_proxies |

Axum HTTP 排空直接受 SSE 这类响应体影响；升级后的 WebSocket 由框架独立任务驱动，因此另外追踪其生命周期，不能把 WS 本身误认作 HTTP 排空计数。

## 信任与配置复核

- `--origin` > `HUB_ORIGIN` > config.origin > 请求推断；`auto` 清除固定地址。显式地址始终严格校验，转发头不能覆盖。
- `--trusted-proxies` > `HUB_TRUSTED_PROXIES` > config.trusted_proxies > 回环默认值。支持逗号分隔的 IP/CIDR，`none` 禁用转发头；不增加首次密码引导项。
- 根据真实 ConnectInfo socket 对端信任代理，规范化 IPv4 映射 IPv6；X-Forwarded-For 不能授予信任。不可信来源的转发头完全忽略。
- 单值 X-Forwarded-Proto / X-Forwarded-Host；可信来源发送重复、逗号链或无效值时拒绝。不解析 RFC Forwarded；最后一跳代理必须覆盖客户端头，Caddy/Nginx 文档均据此配置。
- 浏览器 WS 仍需 Cookie、Origin 和一次性票据；CSRF、授权复查、设备身份校验保留。日志只增加规范化 origin 诊断，不输出密码、Cookie 或设备凭据。

## 退出与竞争条件复核

- 首次 SIGINT/SIGTERM 或后台重启触发同一退出路径；退出信号覆盖 Restart 状态，后续信号强制退出，不会让 Ctrl-C 后重新拉起。
- SSE 在取消后返回 EOF；浏览器/设备 WS 取消等待、数据库检查和发送操作，发送有200毫秒预算的关闭帧；正常退出1001、重启1012。初始 hello/票据等待也可取消。
- 升级后的连接在提交 upgrade 前取得追踪令牌；清理 worker、延时重启和升级任务均纳入任务追踪。
- 连接排空最多3秒；数据库、日志析构、阻塞工作及运行时清理也纳入独立线程保证的5秒总上限。正常退出码0，总期限超时124，第二次信号130。
- 普通退出不发送 revoked/superseded，不删除身份、授权或会话，不终止 GoTTY PTY。升级取消保留现有程序；已完成原子替换时不自动回退。
- 后台 exec 保留 PID、启动参数和环境，正确携带已经消耗的 stdin 密码覆盖。

## 验证

本地只执行允许的单元/内存测试、静态检查及构建：Rust 25 个服务端测试和1个协议测试；Clippy（全部 targets、warnings 为错误）；cargo fmt；Rust build；前端7个测试及生产构建；共享 terminal-core 来源一致性、脚本语法及 diff 空白检查。密码相关测试共用隔离锁，避免独立测试运行时互相触发生产的4并发哈希限额。

新增 `tests/proxy-shutdown.cjs` 并接入 check 和 release 的 amd64 Rust 检查：独立进程经过真实 HTTPS 反代验证登录、Secure Cookie、公开地址、WSS 终端转发、SSE、exec PID/参数/环境/stdin 密码与会话保留；分别验证带活动/空闲连接的 SIGINT、SIGTERM、慢 HTTP 请求体的有界退出和第二次 SIGINT 强退。配置 CLI 测试补充网络设置持久化、优先级、auto/none 和无效 CIDR。进程脚本要求 CI 环境；按要求未在本地启动服务、做部署验证、运行浏览器或截图。

CI 结果以当前提交的 GitHub Actions 为准。本轮 review 未发现剩余阻断项。容器/远程代理需要填写实际代理 IP/CIDR 或固定公共 origin；实际域名证书、代理网络和部署环境仍需使用方配置。
