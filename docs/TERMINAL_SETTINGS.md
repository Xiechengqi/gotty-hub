# 终端设置与字体

入口为右上角“设置 → 终端设置”，普通账号和管理员均可使用。最大化或折叠导航后，设置入口位于工作区右上角。配色主题包含背景、前景、光标、选区和 ANSI 调色板，字号允许 8–48px；默认值为 Nord、14px、内置 DejaVu Sans Mono。两端共享普通字重 400、粗体字重 700、行高系数 1、字间距 0，不把普通文字强制加粗。

对话框只预览草稿，点击“保存并应用”后更新当前账号的全部已打开终端及以后打开的终端。取消或保存失败保留原设置。应用设置只更新 xterm 选项与行列尺寸，不重建连接，不停止远端 PTY；尺寸变化可能使全屏程序重新排版。独立 GoTTY 页面继续使用自己的显示面板和浏览器偏好，不与 Hub 账号相互覆盖。

“横向滑动切换标签”为当前浏览器的交互设置，桌面 macOS 默认开启，其他平台默认关闭，均可手动调整。该选项按账号保存到本浏览器的 `gotty-hub:interaction:<编码后的账号 ID>`，不会写入终端外观 API 或同步到其他设备。取消和保存失败不提交手势草稿，“恢复默认”采用当前设备的默认值。详细行为、验证结果和 Mac 真机验收范围见 [横滑切换 review](TAB_SWIPE_REVIEW.md)。

Paper 在中文界面显示为“柔和米色”，背景 `#f5f5d5` 参考阮一峰博客的纸张底色，默认文字为 `#333333`；光标、选区和 ANSI 16 色配套调整。16 个 ANSI 前景色对默认背景的对比度均不低于 4.5∶1，白色槽位采用适合浅底阅读的灰色。选择保存在现有账号设置中，刷新后恢复，默认主题仍为 Nord。独立 GoTTY 的页面留白和安全区也跟随所选主题背景。

预览使用真正的只读 xterm，与运行终端共享字体加载、字重、行高和渲染参数，包含中英文、普通/粗体、红绿 diff 背景、主题 ANSI 颜色和框线。优先使用 WebGL，设备不可用或上下文丢失时使用 DOM 渲染。预览不会建立连接或向远端发送输入、尺寸；关闭弹窗会释放预览终端。较大字号在窄屏中可以横向滚动查看。

终端主题控制默认配色及 ANSI 16 色；程序指定的 256 色、RGB 真彩色和显式背景仍按程序输出呈现。Vim 等应用若设置了自己的背景，可在应用内使用浅色配色方案或默认终端背景；终端主题不会改写其配置。

## 字体与缓存

| 字体 | 来源 |
| --- | --- |
| DejaVu Sans Mono | 随程序提供，默认加载 |
| JetBrains Mono、Fira Code、Source Code Pro、Cascadia Code | 随程序提供，首次选择时从当前站点加载 |
| Monaco、Menlo | 仅使用当前设备已安装的系统字体 |
| monospace | 浏览器默认等宽字体 |

5 个开源字体共有 11 个 WOFF2 文件，总计 1,302,620 字节；默认 DejaVu Sans Mono 提供 400/700 字重的正体和斜体，共四个文件，505,336 字节。保留源字体完整字符覆盖和可用字重/斜体，不额外捆绑大型 CJK 字库；中文等缺失字形由系统回退字体补齐，跨操作系统可能有差异。构建包含各字体的许可、来源、源文件摘要、WOFF2 摘要和字节数。

字体状态区分可下载、加载中、已缓存、已加载、设备不可用和失败重试。缓存保存字体数据而非“安装成功”标记，刷新时从 IndexedDB 读取并重新注册到当前文档。并发终端复用同一加载任务。下载期间沿用已加载的字体，完成后清除旧字格/字形缓存再重新测量；过期请求不会覆盖后续选择。缓存损坏会删除对应项并重新下载；浏览器禁止 IndexedDB 或容量不足时仍可直接加载，持久缓存无法保证。字体失败时运行终端回退 DejaVu Sans Mono，再失败则使用 monospace，并显示提示，保留账号原选择。

不需要用户在操作系统安装字体，不使用第三方字体 CDN 或 Service Worker，支持局域网 HTTP。缓存按浏览器及 origin（协议、主机、端口）隔离；更换地址、清除站点数据、隐私模式或浏览器回收存储后可能重新下载。不同账号可以复用无用户数据的字体文件，但账号显示设置彼此隔离。

## 保存与兼容

`GET /api/v1/me/terminal-settings` 返回 `{revision, settings}`；首次返回修订号 0、settings 为 null。`PUT` 接收同样结构，settings 包含 `schemaVersion: 1`、`theme`、`fontSize`、`fontId`。请求需登录和 CSRF，服务端严格验证字段及目录白名单。修订号不匹配返回 409 `terminal_settings_conflict`；关闭后重新打开对话框可基于同步后的设置继续编辑，不覆盖其他标签页的新值。

表 `terminal_settings` 在迁移 0003 中添加，随账号删除级联清理。布局 API 不读写此表。已有账号保存前继续使用旧实例的浏览器偏好；第一次打开新对话框以当前终端显示值预填，用户保存后统一。没有旧设置时使用默认值。旧实例键不删除，升级不会自动把某一个实例的选择覆盖到其他实例。

发布需包含完整前端资源和共享包 0.3.2，GoTTY 必须重新构建内嵌前端资源和二进制。新默认仅作用于没有显式偏好的用户；已保存的 Source Code Pro 或其他字体不会被覆盖，可用“恢复默认”切换。Paper 和字体调整沿用 schemaVersion 1 和现有终端设置表，无需新增数据库迁移；前后端需配套升级，旧版服务端不接受新增的主题名。升级前按运维文档备份 SQLite；回滚使用旧二进制配套的升级前备份，不手工删除迁移记录或把旧程序直接指向新 schema。旧实例浏览器键可供旧版恢复，但新版账号设置不会反向写回旧键。

## 维护

主题源位于 GoTTY 的 `server/terminaldata/themes.json`，执行 `python3 scripts/sync-terminal-themes.py` 生成共享目录；Makefile 在主题源更新时自动重新生成。字体更新使用 GoTTY 的 `scripts/update-terminal-fonts.py`，需要 `fonttools[woff]` 和 curl，固定上游版本并生成清单与内容版本文件名。更新共享核心后提升包版本，重新打包到 Hub vendor，更新 npm lock，并执行 `scripts/check-core.py /path/to/gotty` 验证源文件、字体摘要及授权完整性。

渲染诊断位于 Hub `.xterm-host` / `.terminal-preview-host` 的 `data-font-requested`、`data-font-applied`、`data-font-status` 和 `data-terminal-renderer`。独立 GoTTY 的字体属性位于 `.xterm`，渲染器属性位于 `#terminal`。这些属性记录主字体及加载状态，不声明中文、emoji 等每个字符实际使用的系统回退字体。

真实浏览器对比使用 `HUB_BINARY=/path/to/gotty-hub GOTTY_BINARY=/path/to/gotty CHROMIUM_EXECUTABLE=/path/to/chrome npm --prefix frontend run test:rendering`。测试启动隔离实例，让两端连接同一个 PTY，检查 ANSI 输出截图、DPR 1/1.25/2、浏览器真实 125% 缩放、冷加载/缓存、WebGL/DOM 回退和下载失败恢复。运行完整 `test:workspace` 还会覆盖字体切换不重连、缓存损坏恢复、双分屏、Vim 会话和移动端设置。
