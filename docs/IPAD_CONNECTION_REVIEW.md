# iPad 终端反复重连修复与 review

## 问题边界

Hub 与直连 GoTTY 使用不同的连接握手，直连正常不能证明 Hub 的浏览器策略、取票或生命周期处理正常。远程正式 Hub 原先仅下发 `connect-src 'self'`；部分旧 WebKit 不用该指令匹配同地址 WS/WSS。源码同时存在“WS 打开后才取票”和“恢复页面时探测尚未完成初始化的连接”两处时序缺陷。终端解析繁忙时，心跳回复还会排在渲染队列后，被误判为失联。

本轮修复这些可确认的缺陷，并补齐错误分类和日志。尚未取得用户实际 iPad 的系统版本、控制台或连接抓取，因此不能认定其中某项就是该设备的唯一根因，也不承诺兼容所有旧 Safari。

## 最终行为

| 场景 | 行为 |
| --- | --- |
| 浏览器安全策略 | 在 `'self'` 外显式允许经来源校验的当前地址 WS/WSS，不使用通配地址；保留脚本哈希和 Wasm 权限，不新增 JavaScript `unsafe-eval` |
| 新建或恢复连接 | 旧解析队列排空后取一次性 ticket，收到 ticket 才创建 WS，打开后立即发送认证，避免把网络取票和历史解析计入服务端 5 秒认证期限 |
| 等待超时 | 取票、建连、等待首条终端协议响应分别最多 10 秒；取消和销毁会清理请求、计时器与监听器 |
| 页面恢复 | 不探测尚未初始化的连接；Pong 独立于渲染队列处理，减少大量输出导致的误断线 |
| 普通连接中断 | 继续退避重连；传输层 OPEN 不重置退避，收到协议消息并持续连接 5 秒后才重置 |
| 认证失败 | 票据过期/无效或认证超时最多自动换票重试一次；反复失败显示登录/刷新指引 |
| 确定的安全策略或权限拒绝 | 显示具体原因并停止自动重连；页面恢复事件不能绕过，终端菜单“刷新”可主动重试 |
| 限流 | 至少等待 60 秒后重试；后台收到限流、页面恢复和 online 事件均保留等待期限 |
| 排查连接 | 记录独立 connection_id、实例、认证/传输阶段、升级拒绝状态和静态关闭原因；认证前失败也有日志，不记录凭据或终端内容 |

HTTPS 页仅声明同地址 WSS；HTTP 页声明同地址 WS/WSS，以兼容保留 Host 但不转发协议的 TLS 代理。1006 仍按网络、代理及权限诊断处理，只有收到匹配的 CSP 事件或同步 SecurityError 才判为安全策略拦截。代理另外下发的 CSP 仍需与实际 WS 地址兼容。

## 整体 review

- 共享 terminal-core 升至 0.9.0，GoTTY 嵌入 JS/sourcemap 与 Hub vendor、安装依赖及锁文件保持一致；不变更服务端数据协议、尺寸策略和历史预算。
- 重连屏障保留已提交的回放位置。重复刷新会使旧屏障失效，销毁后不能创建新连接；历史解析不会拖延新连接的认证。
- CSP 事件只影响尚未打开的匹配连接。已建立的终端不会因另一连接收到去掉路径的 CSP 报告而被关闭；report-only 事件和无关路径被忽略。
- 连接关闭只通知一次；票据等待、上传、管理请求、诊断请求、计时器和策略监听均随连接结束清理。观察者权限、上传确认、控制消息关联保留。
- 服务端仍验证 Cookie、Origin、一次性票据和授权版本。新增来源只取自规范化校验结果；日志只使用静态原因和独立连接标识。
- GitHub Actions 未新增 UI 测试。浏览器回归是显式运行的隔离脚本，未接入 CI。

## 验证

构建和测试仅在 `ssh xianyu` 的 `/root/gotty-ipad-review.vAgNws` 隔离目录运行，使用独立二进制、账号、数据库、绑定文件和回环端口。本地仅编辑源码及同步构建产物；未替换或重启正式 Hub，也未操作本地正在运行的 GoTTY。

| 检查 | 结果 |
| --- | --- |
| GoTTY 前端全量测试、TypeScript、Webpack、Go 二进制构建 | 135 项全量测试通过；补充重复刷新/销毁边界后，21 项连接与回放专项测试通过；生产构建通过 |
| Hub 前端全量测试、TypeScript、Vite | 127 项通过，生产构建通过 |
| Rust workspace 测试、格式检查、Clippy、发布构建 | 38 项测试通过，Clippy 无警告，构建通过 |
| 共享资源一致性 | vendor 中 33 个文件对照共享源码与安装依赖一致；锁文件 SHA512 与 GoTTY 嵌入 sourcemap 源码核对通过 |
| Chromium 连接回归 | 真实延迟取票 5.5 秒、等待期恢复事件、正常输入、重连保留历史、真实 CSP 拦截、停止重试与手动刷新通过 |
| WebKit 平板尺寸回归 | 1024×768、触摸环境下 Hub 输入、页面恢复、终端刷新、历史保留、直连 GoTTY 输入及真实 CSP 拦截停止重试通过 |
| 多端视口回归 | 桌面/移动端共享网格、逐帧切换、Vim、历史锚点、软刷新、键盘避让和直连通过 |
| 数据流回归 | 3,800 行历史与完整刷新、Unicode、长行、未保存 Vim 状态、1,400 行重排及 5,000 行历史上限通过 |
| 自适应尺寸回归 | 手机先连后桌面接入无小屏闪现；隐藏标签保留、后台过期、恢复、长断线、刷新、未保存 Vim 内容及直连混用通过 |

连接回归结果位于 `hub-workspace-eUdUmB/results.json`，视口回归位于 `hub-workspace-3KVKpe/results.json`，数据流回归位于 `hub-workspace-Niui1E/results.json`，自适应回归位于 `hub-workspace-AlK5Tc/results.json`；均无浏览器 pageerror。运行入口为 `WORKSPACE_SUITE=connections node tests/workspace-regressions.cjs`，需显式提供隔离的 HUB_BINARY、GOTTY_BINARY 和浏览器路径，WebKit 通过 WEBKIT_EXECUTABLE 启用。

Linux WebKit 是现代浏览器内核验证，不能替代实体 iPad、实际 Safari 版本及真实休眠/网络环境验收。真实 iPad 的最终恢复情况仍需部署后验证；本轮没有部署。

参考：[MDN connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)、[WebSocket 与 CSP self 的 WebKit 兼容性讨论](https://github.com/w3c/webappsec-csp/issues/7)。
