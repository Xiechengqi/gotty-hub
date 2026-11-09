# 实施决策与协议约束

## ADR-001：终端专用 WSS，不复制通用代理

已审阅 http-tunnel 的 WebSocket 代理/访问策略边界和工作区 MIT 声明。Hub 使用独立的 Go/Rust v1 WSS 控制封装，未拷贝其代理实现，也不提供 target URL、TCP 端口、HTTP 请求透传或 inspector。选择简单有界 JSON 多路帧，终端字符串继续采用现有 webtty 协议；音频二进制在设备隧道内 base64 封装。牺牲少量编码开销，换取两语言可直接互测、清晰的消息和容量边界。

所有设备主动出站，只有当前 GoTTY SessionManager 与已配置 ASRBackend 能被连接。一个 Connector 对应一个已绑定实例，流 ID 不能指定其他实例。背压满时关闭受影响流；设备发送队列满则重建设备连接，不无限缓存。

## ADR-002：共享现有 webtty 与语音核心

`gotty/js/packages/terminal-core` 是 GoTTY 原有 WebTTY 和 VoiceInput 的源代码归属；GoTTY 原路径仅重新导出。Hub 固定消费 `frontend/vendor/gotty-terminal-core-0.1.0.tgz`，npm lock 校验内容，独立检出不依赖相邻目录。该包仍是第一版开发制品，正式发布新内容必须提升版本，不能替换已经对外发布的同版本 tarball。

Hub 使用 React xterm 适配器，未嵌入远程 GoTTY 网页。文件通过相同终端通道中的 ZMODEM，上传需远端运行 rz，下载需 sz；不会调用原有全局 HTTP/JSON 文件上传接口。语音录音、采样与转写合并逻辑复用 GoTTY VoiceInput，增加初始化/传输注入接口。

## ADR-003：绑定证明使用随机申请秘密

实施使用 GoTTY 本机生成的 256 位随机 claim，通过严格 HTTPS 提交申请与确认。Hub 仅保存其 SHA-256 摘要，验证码绑定申请；确认必须同时持有 claim 和邮箱验证码。这是原计划临时公私钥持有证明的简化实现：在 HTTPS 传输模型中提供设备持有证明，不引入两语言签名/密钥格式复杂度。

确认在 SQLite 事务中原子消费验证码、创建实例和授权。短期申请保留确认结果，同一 claim 重试可恢复相同设备凭据，处理网络中断或本机落盘失败。Hub 不保存原始设备凭据；该凭据由 claim 和随机实例 ID 派生，后续可独立轮换。申请到期后移除 claim 摘要及结果。

本机未设置主密码时，`--hub-state-file` 旁的 `.admin` 文件提供管理令牌；不能用匿名网页访问替代管理身份。分享访问被显式拒绝。

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
| 设备→Hub | hello | protocol=1，write/replay/files/asr 能力 |
| Hub→设备 | hello_ack | protocol=1，随机连接 generation |
| 设备→Hub | status | color、递增 revision；generation 由认证连接绑定 |
| Hub→设备 | open | stream、role、writable、epoch、offset、channel=terminal/asr |
| 双向 | data | 原有 webtty 字符串 |
| 双向 | asr_data | binary 布尔值、payload（文本或 base64） |
| Hub→设备 | view | viewing 布尔值 |
| 双向 | close | 释放对应流 |
| Hub→设备 | rotate | 新凭据，只在已认证设备连接发送 |
| 设备→Hub | rotated | 已持久化凭据的 fingerprint |
| Hub→设备 | revoked/superseded | 解绑/连接被替换 |

限制：单条帧最大1MiB；设备控制队列128条；每设备最多64流；GoTTY ASR 最多16流；ASR 单连接最多120秒和16MiB音频；文件单个64MiB；终端不接受 restart 消息。设备心跳15秒、45秒失联；初始 hello/浏览器认证超时5秒；发送超时10秒。

初期状态 SSE 使用每秒快照，断线重连重新鉴权/读取授权，不依赖 Last-Event-ID 缓存。适合首版单节点规模；后续事件增量优化必须保留权限过滤和重同步能力。

## 兼容与受控降级

未启用 `--hub-enabled` 的 GoTTY 不创建设备管理入口或状态文件，原独立访问/分享保持现有行为。Hub 不提供 iframe 兼容入口，不兼容设备协议必须升级，不能降级成无鉴权任意代理。ASR 未配置时没有语音按钮；文件依赖远端 rz/sz，缺少命令时由真实终端提示。
