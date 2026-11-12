# Tab 左右键交互与背景一致性 Review

核验日期：2026-11-12。Hub 基线 `7c36d61`。本轮纠正标签的左右键分工，并统一标签操作菜单与顶栏的背景。

后续菜单项目精简及实例删除流程见 [TAB_MENU_REVIEW.md](TAB_MENU_REVIEW.md)。本文保留本轮交互调整的验证记录。

## 最终行为

- 左键点击直接切换实例；按住左键拖动整个标签排序，相邻标签在拖动过程中实时让位，分屏组整体移动。
- 右键选中实例并打开操作菜单；左键点击其他标签关闭菜单并切换。键盘支持 Shift+F10、菜单键及向下方向键打开菜单。
- 触屏轻点切换实例，再次轻点当前标签打开菜单；长按拖动排序。
- 标签操作菜单与 tab 行使用同一灰色背景、透明度和明暗前景。背景默认 80% 不透明，即“终端设置”中的 20% 透明度；文字和图标不随背景一起变透明。
- 前后端及旧设置缺省值统一为 20% 透明度；已有显式保存的数值（包括 50%）保留。滑条同时影响顶栏和标签操作菜单，支持预览、取消、保存及刷新恢复。

## Review 发现与处理

1. React Aria 按钮会阻止主键鼠标事件冒泡，直接把传感器从右键改成左键仍无法拖动。排序单元改在捕获阶段接收鼠标及触摸事件，保留移动阈值与长按阈值；交互测试使用实际 BoardUI 按钮覆盖这个路径。
2. Portal 菜单事件仍沿 React 组件树传播，菜单内按住鼠标移动会误触发标签排序。远程 Chromium 已复现；现在只接收来自排序单元实际 DOM 子树的手势，鼠标拖动菜单内容和触屏长按菜单均不会启动排序。
3. 触屏生成的兼容鼠标事件会提前更新选中状态，导致首次轻点未选中标签误开菜单。改为记录触摸开始时是否已选中，区分“切换”与“再次点击打开菜单”。
4. 菜单通过 portal 渲染，无法直接继承顶栏 CSS 变量。顶栏与菜单显式接收同一表面样式，保留悬停提示和明暗前景适配；实际计算样式已验证背景颜色和 alpha 一致。
5. 保留拖动取消时的焦点隔离、分屏组原子排序、菜单权限检查和重启确认。拖动不重建 xterm 或 WebSocket，Escape 取消手势不进入 Vim。

本轮代码检查与下列回归未发现剩余阻断问题。

## 验证结果

构建及测试均在 `ssh root@xianyu` 的 `/root/gotty-dataflow-review.EcmNjn` 隔离目录执行，使用独立 Hub、数据库、账号、GoTTY 身份和随机回环端口。没有在本地构建、测试或启动应用，没有改动或重启本地 2227 GoTTY，也没有替换远程现有服务。结束后检查隔离目录下的应用、浏览器和测试进程均已退出。

| 检查 | 结果 |
| --- | --- |
| 前端 | 17 个文件、69 项测试通过；TypeScript 与 Vite 构建通过 |
| Rust | `cargo fmt --all -- --check`、Clippy（`--locked --all-targets -- -D warnings`）、Hub 36 项及协议 1 项测试、构建通过 |
| 顶栏浏览器专项 | 左键切换、右键菜单、键盘入口、菜单内部拖动隔离、背景与 alpha 一致、默认值及透明度预览/取消/保存/刷新恢复通过 |
| 分屏浏览器专项 | 左键整组排序、相邻 tab 实时移动、释放不误开菜单、Escape/失焦取消、触屏首次/再次轻点及长按、菜单内部触摸隔离通过 |
| 相关回归 | 分组恢复、终端焦点与输入隔离、未保存 Vim、渲染器和连接保持、观察者权限与撤权、关闭重开、新实例自动 tab 通过 |
| 响应式与视觉 | 320 / 375 / 414 / 768 / 1280px 及横屏布局通过；检查深色和 Paper 终端下的菜单截图 |
| 浏览器错误与源码 | 两个专项均无浏览器运行错误；`git diff --check` 通过 |

最终浏览器验证针对顶栏与分屏两个专项，未将此前版本的完整工作区回归计为本轮最终完整套件通过。测试使用真实 Chromium，手机以视口和触摸事件模拟，未覆盖实体手机及 Safari / Firefox。Vite 保留已有的大分包提示。

远程证据：

- 顶栏专项：`/root/gotty-dataflow-review.EcmNjn/hub-workspace-qe2Yv9`，含 `results.json`、菜单截图及响应式截图。
- 分屏专项：`/root/gotty-dataflow-review.EcmNjn/hub-workspace-jazLyw`，含 `results.json`、分屏及触摸截图。
- 日志位于隔离目录根部：`gotty-hub-tab-mouse-frontend-final.log`、`gotty-hub-tab-mouse-rust.log`、`gotty-hub-tab-mouse-overlay-final.log`、`gotty-hub-tab-mouse-split-final.log`。
- 菜单误触拖拽的修复前复现记录：`gotty-hub-tab-menu-portal-repro.log`。

复现入口见 [WORKSPACE_RECOVERY.md](WORKSPACE_RECOVERY.md)。原透明顶栏方案及其历史验证保留于 [OVERLAY_WORKSPACE_REVIEW.md](OVERLAY_WORKSPACE_REVIEW.md)。
