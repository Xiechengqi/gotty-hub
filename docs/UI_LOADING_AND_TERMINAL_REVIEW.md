# 页面加载、终端一致性及实例排序 Review

日期：2026-11-09。范围：GoTTY Hub 与 GoTTY 两个仓库；保留任意域名访问、可信代理边界及有界退出的既有实现。

## 证据与修复

此前故障截图中账号、实例和 React 内容已经加载，但应用布局及 xterm helper 样式均未生效，可以确认共用 CSS 未应用。现有证据不能确定当时是哪段缓存、网络或反向代理链路丢失资源；另有 TLS EOF/超时现象，WS 1006 也不能解释整页 CSS 缺失。本次从服务端资源契约、升级一致性、页面恢复和诊断四处修复，未把未知原因写成已证实结论。

- 服务端启动时固定资源快照，明确 HTML/无 hash 文件与 hash 文件的缓存策略，支持内容 ETag、HEAD/304；缺失资源空 404，错误 no-store。保留当前及前两代原始 hash 资源，升级前 checkpoint。
- 独立 bootstrap 内联最小样式及恢复逻辑，确认应用/xterm CSS 后再挂载 React，CSS/JS 有超时、有界重试和主动恢复；CSP 使用精确 SHA256 授权。字体失败不永久阻塞。致命渲染错误提供主动重新加载，运行中的终端不自动刷新。
- 静态响应及 WS 握手/关闭日志带构建标识和必要状态，不记录凭据、query 或终端内容。HTTP 响应体消费完成不等于 TLS 代理已完整交付，诊断边界见 [运维文档](OPERATIONS.md)。

## 本轮新增需求

GoTTY terminal-core 升为 0.2.1，将原版移动快捷键布局、编码和视口检测抽为共享源。Hub 使用同一套两行 16 键：`Esc / - | Home ↑ End PgUp`、`Tab Ctrl Alt Shift ← ↓ → PgDn`。支持一次性 Ctrl/Alt/Shift、应用光标模式、导航长按、粘贴透传；仅在可见可写终端的软件键盘打开时显示，保留输入焦点并重算终端尺寸。

右侧工具按钮按 GoTTY 的固定槽位排列，隐藏权限受限按钮时不挤动其他按钮；显示设置和分享管理由居中弹窗改为按钮旁深色浮层，支持边界避让、Escape、外部点击及互斥。主题圆点、字体、字号和分享表单的到期单位、密码选项及记录操作与 GoTTY 对齐，权限仍由 Hub 与远端双重验证。

侧边栏和 tab 共用全实例顺序，任一边排序都会同步，保存至当前账号 preferences；新增实例追加、撤权项移除，定期 SSE 不覆盖自定义顺序。鼠标拖动、触摸长按和键盘 Space/方向键/Space 均可用，Escape 取消。终端组件按实例 ID 保持挂载，排序不会主动重建连接。

## Review 发现及修正

1. 仅能解析的资源 manifest 仍可能缺条目；checkpoint 现对照当前全部 hash 文件及摘要核对完整性，损坏或不完整则重建。
2. CSS 阻塞模块时 DOMContentLoaded 也可能不触发；bootstrap 改为解析期间探测 root，不能依赖该事件启动超时恢复。
3. 浏览器不能发送 1008/1013 作为主动关闭码；适配器使用允许的 4001/4013，并向共享 WebTTY 保留对应语义。显式关闭失活连接仍通知 WebTTY，保留探测后的自动重连。
4. Dnd 键盘坐标计算默认会看到其他栏；现过滤同栏目标，防止误选。持久化依赖稳定的顺序值，避免每秒 SSE 重置保存计时器；账号切换取消旧偏好请求的回写。
5. 分享面板快速关闭再打开时，旧请求可能阻止首次刷新；增加有清理的短暂等待，并维持单个远端控制请求。密码模式互斥、关闭清除秘密，导航长按在取消/失焦/卸载时停止。
6. WS 打开流的队列已满时明确关闭为 1013；心跳和发送均有期限，退出时保留原 1001/1012 及关闭预算。

## 验证与边界

本地只执行单元/内存路由测试、类型检查、Clippy、语法检查及构建；未启动 Hub 或 GoTTY 服务，未执行浏览器、反代部署或截图。GoTTY 原按键测试继续覆盖被抽出的共享实现；Hub 回归覆盖资源缓存/归档损坏修复、CSS/JS 恢复、16 键/修饰/长按取消、控制消息、分享密码互斥/到期校验和统一顺序。

已通过：Hub 前端 24 项单测、TypeScript 和 Vite 生产构建；Rust 33 项 server 单测及 1 项 protocol 单测、fmt、Clippy（warnings 视为错误）和 binary 构建；GoTTY 前端 78 项单测、TypeScript、webpack 生产构建及 Go 编译。共享包与 GoTTY 源逐文件一致，构建 HTML 的 bootstrap 字节及资源引用、Node/Python/workflow 语法、git diff 空白检查均通过。前端构建仍有大 bundle 提示，GoTTY 的 Bootstrap/Sass 弃用提示未阻止构建。

CI 增加真实 binary 经 HTTPS 反代的生产页面检查：缓存和 CSP、旧资源保留、应用/xterm 样式、工具按钮位置、浮层行为、双向排序和持久化、连接数量、CSS/JS 失败/超时/恢复、375px 移动视口和 Ctrl+C 经设备隧道传输。该检查只在 CI 启动服务/浏览器，无截图；本地未执行，推送后也不等待其结果。真实移动设备的系统键盘仍可能存在浏览器平台差异，需要设备回归。

## 2026-11-10：远程 Actions 失败复核

同一提交 `0246485` 的 [check](https://github.com/Xiechengqi/gotty-hub/actions/runs/42663837395) 与 [Build and Release](https://github.com/Xiechengqi/gotty-hub/actions/runs/42663837285) 均在生产页面浏览器检查失败。前端单测、Vite 页面 UI 测试、Rust 检查、进程/代理测试与资源 HTTP 契约均已通过；arm64 发布编译也已通过。生产页面加载 xterm 图片插件时，SIXEL 解码器异步调用 `WebAssembly.instantiate()`，被 Hub 的 `script-src` 拒绝，产生未处理的页面错误。Vite 测试没有 Hub 的真实响应头，因此未覆盖这一差异。

修复仅在 `script-src` 增加 `wasm-unsafe-eval`，保留 bootstrap 精确 hash、同源脚本限制及页面零错误断言，不开放 JavaScript `unsafe-eval` 或任意内联脚本。Rust 和生产 HTTP 检查均按精确 token 集合核对 CSP，并从实际 HTML 重算 bootstrap hash，防止弱字符串断言漏掉额外权限。

`check.yml` 在所有分支 push 和 PR 上验证；发布流程在 main push、版本 tag 和手动触发时验证并发布。main push 上的有效检查已被发布流程覆盖，独立 check 存在重复；删除它不会解决本次失败，因为发布流程也执行同一生产页面检查。技术上可删除，但会失去 PR/其他分支的独立验证。建议保留 PR 检查、取消 main push 的重复检查；本次按分析范围保留工作流配置。

本次本地复核通过 Rust 33 项 server 单测及 1 项 protocol 单测、fmt、Clippy（warnings 视为错误）、binary 编译、Node 脚本语法和 diff 空白检查。Review 确认其余 CSP 指令保持原有权限，生产页面零错误断言仍保留。未启动本地服务、反代或浏览器，未截图；修复后的生产浏览器结果由新一轮 Actions 验证，推送后不等待构建完成。
