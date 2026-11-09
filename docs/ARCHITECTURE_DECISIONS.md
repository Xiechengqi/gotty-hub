# 实施决策与协议约束

## ADR-001：终端专用 WSS，不复制通用代理

已审阅 http-tunnel 的 WebSocket 代理/访问策略边界和工作区 MIT 声明。Hub 使用独立的 Go/Rust v1 WSS 控制封装，未拷贝其代理实现，也不提供 target URL、TCP 端口、HTTP 请求透传或 inspector。选择简单有界 JSON 多路帧，终端字符串继续采用现有 webtty 协议；音频二进制在设备隧道内 base64 封装。牺牲少量编码开销，换取两语言可直接互测、清晰的消息和容量边界。

所有设备主动出站，只有当前 GoTTY SessionManager 与已配置 ASRBackend 能被连接。一个 Connector 对应一个已绑定实例，流 ID 不能指定其他实例。背压满时关闭受影响流；设备发送队列满则重建设备连接，不无限缓存。

## ADR-002：共享现有 webtty 与语音核心

`gotty/js/packages/terminal-core` 是 GoTTY 原有 WebTTY、VoiceInput、显示偏好翻译/默认值、移动快捷键布局与编码、软件键盘视口检测的源代码归属；GoTTY 原路径仅重新导出。Hub 固定消费 `frontend/vendor/gotty-terminal-core-0.2.1.tgz`，npm lock 校验内容，独立检出不依赖相邻目录。发布新内容必须提升版本，不能替换已经对外发布的同版本 tarball。

Hub 使用 React xterm 适配器，未嵌入远程 GoTTY 网页。文件支持原有WebTTY `7`消息的原生上传（包括拖放），也支持同一终端通道中的ZMODEM，后者上传需rz、下载需sz；文件权限继续由Hub角色及GoTTY PermitWrite双重校验。语音录音、采样与转写合并逻辑复用 GoTTY VoiceInput，增加初始化/传输注入接口。

## ADR-003：用户名账号与一次设备注册

Hub公开用户名/密码注册；用户ID是内部关联身份，规范用户名用于登录和授权输入。普通用户密码使用Argon2id。保留admin名称，本机启动在监听前创建管理员；admin密码按要求保存于0600 config，CLI优先覆盖，登录仍使用数据库哈希。

GoTTY接入填写Hub URL及用户名，可选显示名字；同一owner下名称唯一，注册和改名均由数据库约束，重复返回409。Hub必须先有该账号，不隐式创建。GoTTY本机生成256位request_id和claim并在请求前落盘。Hub在同一事务创建实例、owner授权、幂等记录，仅保存秘密摘要；响应丢失或最终保存失败可持有相同claim恢复结果。轮换/解绑后原申请不可恢复设备凭据。

知道用户名可以将自己控制的新GoTTY注册给该账号；这不授予账号会话或其他实例权限。Connector使用独立设备凭据。GoTTY主站管理沿用原访问权限，有密码时复用登录态，无密码且启用Hub时允许主站访问者配置；所有分享页面禁止Hub管理。

## ADR-004：颜色由设备统一发布

已绑定 GoTTY 的活动在真实 PTY 输出路径采样；内部 probe 被过滤的输出不计活动。GoTTY 维护查看租约（10秒）、停止阈值（6秒）、待查看状态以及递增 revision；查看租约由实际可见且聚焦的终端每3秒刷新。Hub 的选择背景不参与状态判定。

GoTTY 直接页轮询实例同一快照，Hub 经设备控制通道接收，再以每秒 SSE 快照分发至授权用户。离线判断独立于颜色，不能把灰点解释为离线。网络传输有延迟，保证同一 revision 一致，不宣称任意两个浏览器在同一毫秒显示必然一致。

多人按任一有效查看租约聚合，查看时红色并清除待查看；离开后有输出为黄，6秒没有新输出且需要提醒为绿，否则灰。明确离开查看后保留1秒防抖，失联查看则按10秒租约过期。若需调整，须修改共享语义并更新时序测试。

## ADR-005：权限与凭据轮换

Cookie 会话、一次性30秒终端票据和设备凭据互相独立。票据绑定会话、实例及授权版本。浏览器 WS 第一条消息认证成功前不打开 PTY。

每次输入前及每500毫秒复查会话/授权版本，权限变化导致流关闭；GoTTY 再次检查只读和本机 PermitWrite。观察者不能发送 resize、文件数据、ASR 或 restart。

设备轮换为两阶段：Hub 保存下一凭据摘要 → 发送新秘密 → GoTTY 原子落盘 → 回传指纹 → Hub 按指纹提交。未确认前保留旧凭据，重连使用下一凭据也可完成提交；禁止并发轮换覆盖待确认值。设备替换与解绑使用不同消息，旧设备被替换时暂停重连，不清空共享绑定文件或与新设备反复抢占。

## 协议 v1

帧：`{kind, stream?, data}`。已实现种类：

| 方向 | kind | 数据 |
|---|---|---|
| 设备→Hub | hello | protocol=1，write/replay/files/asr/controls 能力 |
| Hub→设备 | hello_ack | protocol=1，随机连接 generation |
| 设备→Hub | status | color、递增 revision；generation 由认证连接绑定 |
| Hub→设备 | open | stream、role、writable、epoch、offset、channel=terminal/asr |
| 双向 | data | 原有 webtty 字符串 |
| 双向 | asr_data | binary 布尔值、payload（文本或 base64） |
| Hub→设备 | control | 已认证终端stream、请求id、白名单action、payload；仅owner |
| 设备→Hub | control_result | 请求id、value或error |
| Hub→设备 | view | viewing 布尔值 |
| 双向 | close | 释放对应流 |
| Hub→设备 | rotate | 新凭据，只在已认证设备连接发送 |
| 设备→Hub | rotated | 已持久化凭据的 fingerprint |
| Hub→设备 | revoked/superseded | 解绑/连接被替换 |

限制：单条帧最大1MiB；设备控制队列128条；每设备最多64流；GoTTY ASR 最多16流；ASR 单连接最多120秒和16MiB音频；文件单个64MiB；原有终端字符串不接受restart消息；服务重启和分享管理仅经controls能力协商的owner命名操作通道，单请求16KiB、每设备同时一个操作。设备心跳15秒、45秒失联；初始 hello/浏览器认证超时5秒；发送超时10秒。

初期状态 SSE 使用每秒快照，断线重连重新鉴权/读取授权，不依赖 Last-Event-ID 缓存。适合首版单节点规模；后续事件增量优化必须保留权限过滤和重同步能力。

## 兼容与受控降级

GoTTY 默认开启 Hub；使用 `--hub-disabled` 时不创建设备管理入口或状态文件，原独立访问/分享保持现有行为。Hub 不提供 iframe 兼容入口，不兼容设备协议必须升级，不能降级成无鉴权任意代理。ASR 未配置时没有语音按钮；原生上传不依赖rz，ZMODEM依赖远端rz/sz。旧Connector不声明controls时隐藏管理按钮；完整显示目录和改名需两端更新。


## ADR-006：可信代理外部地址与统一退出

地址始终按请求解析，接受任意映射到 Hub 的域名和 IP；旧 CLI/环境/config 的固定 origin 兼容接受但忽略。authority 来自 Host 或可信代理的单值 X-Forwarded-Host；浏览器 Origin / 前端 X-Hub-Origin 只能为匹配 authority 的地址确定 HTTP/HTTPS，不能选择其他主机或端口，两者同时存在时必须一致。后者支持不含 Origin 的同源 GET，不能代替浏览器 WS 的必需 Origin。没有浏览器来源时使用可信 X-Forwarded-Proto 或 HTTP。只按真实 socket 对端信任回环或显式 IP/CIDR，不解析 Forwarded/X-Forwarded-For 链；代理必须覆盖客户端头，不可信来源忽略转发头，可信来源有歧义时拒绝。认证、Secure Cookie、hub_address、HSTS和浏览器WS共用单次解析地址，保留跨站请求拦截与CSRF。换域名无需修改配置或重启 Hub。

SIGINT/SIGTERM/后台重启通过同一取消令牌和任务追踪器通知SSE、设备/浏览器WS、清理任务与升级下载；首次退出信号可覆盖重启，后续信号强制结束。Axum排空包含持续HTTP响应体，因此SSE必须主动结束；升级后的WS任务另行追踪，不能依赖HTTP排空。连接预算3秒，数据库/日志/运行时在内总退出上限5秒，由独立线程保证；不把普通关闭解释为设备撤销。正常退出1001、重启1012，保留远端PTY及持久身份。CI独立进程验证真实TLS反代、长连接、exec及OS信号，本地仅单元/内存测试和构建。

## ADR-007：资源快照与独立加载恢复

binary 内嵌资源与 HUB_ASSETS 都在启动时读为不可变快照；HTML 重新验证，带构建 hash 的资源长期 immutable，缺失资源不能回退为 HTML，错误响应 no-store。SHA256 ETag 支持 GET/HEAD/304。保留当前及前两代原始 hash 资源，内置升级在替换 binary 前检查归档完整性并落盘，不用新版文件冒充旧 URL。

独立内联 bootstrap 在 React 挂载前验证应用与 xterm CSS；CSS/JS 超时或失败最多自动重试两次，之后显示手动重试和重新加载。字体短暂等待后允许降级，运行中的终端不会被资源恢复逻辑自动刷新。CSP 只为构建 HTML 中 bootstrap 的精确字节授权 SHA256，不开放 unsafe-inline 脚本或 eval。

## ADR-008：终端工具及统一实例顺序

终端移动键盘复用 GoTTY 两行 16 键及一次性修饰/导航长按；工具按钮使用固定位置，显示设置和分享管理在按钮旁展开，保持 GoTTY 的深色面板、尺寸、间距及主题/字体选项。Hub 权限仍决定写入、上传及远端管理能力。

侧边栏全实例与已打开标签使用同一份实例 ID 顺序；任一处拖动更新这份顺序，标签仅取已打开子集。鼠标、触摸长按及键盘均支持；各栏只在本栏选择拖动目标。顺序保存至用户 preferences，SSE 更新保序，新项追加，撤权项移除。按 ID 保持终端组件，不因排序重建连接。
