# 终端设置与字体

入口为右上角“设置 → 终端设置”，普通账号和管理员均可使用。最大化或折叠导航后，设置入口位于工作区右上角。配色主题包含背景、前景、光标、选区和 ANSI 调色板，字号允许 8–48px；默认值为 Nord、14px、Source Code Pro。

对话框只预览草稿，点击“保存并应用”后更新当前账号的全部已打开终端及以后打开的终端。取消或保存失败保留原设置。应用设置只更新 xterm 选项与行列尺寸，不重建连接，不停止远端 PTY；尺寸变化可能使全屏程序重新排版。独立 GoTTY 页面继续使用自己的显示面板和浏览器偏好，不与 Hub 账号相互覆盖。

## 字体与缓存

| 字体 | 来源 |
| --- | --- |
| Source Code Pro | 随程序提供，默认加载 |
| JetBrains Mono、Fira Code、DejaVu Sans Mono、Cascadia Code | 随程序提供，首次选择时从当前站点加载 |
| Monaco、Menlo | 仅使用当前设备已安装的系统字体 |
| monospace | 浏览器默认等宽字体 |

5 个开源字体共有 11 个 WOFF2 文件，总计 1,302,620 字节；默认 Source Code Pro 正体和斜体合计 164,576 字节。保留源字体完整字符覆盖和可用字重/斜体，不额外捆绑大型 CJK 字库；中文等缺失字形由系统回退字体补齐。构建包含各字体的许可、来源、源文件摘要、WOFF2 摘要和字节数。

字体状态区分可下载、加载中、已缓存、已加载、设备不可用和失败重试。缓存保存字体数据而非“安装成功”标记，刷新时从 IndexedDB 读取并重新注册到当前文档。并发终端复用同一加载任务。缓存损坏会删除对应项并重新下载；浏览器禁止 IndexedDB 或容量不足时仍可直接加载，持久缓存无法保证。字体失败时运行终端回退 Source Code Pro/monospace，保留账号原选择。

不需要用户在操作系统安装字体，不使用第三方字体 CDN 或 Service Worker，支持局域网 HTTP。缓存按浏览器及 origin（协议、主机、端口）隔离；更换地址、清除站点数据、隐私模式或浏览器回收存储后可能重新下载。不同账号可以复用无用户数据的字体文件，但账号显示设置彼此隔离。

## 保存与兼容

`GET /api/v1/me/terminal-settings` 返回 `{revision, settings}`；首次返回修订号 0、settings 为 null。`PUT` 接收同样结构，settings 包含 `schemaVersion: 1`、`theme`、`fontSize`、`fontId`。请求需登录和 CSRF，服务端严格验证字段及目录白名单。修订号不匹配返回 409 `terminal_settings_conflict`；关闭后重新打开对话框可基于同步后的设置继续编辑，不覆盖其他标签页的新值。

表 `terminal_settings` 在迁移 0003 中添加，随账号删除级联清理。布局 API 不读写此表。已有账号保存前继续使用旧实例的浏览器偏好；第一次打开新对话框以当前终端显示值预填，用户保存后统一。没有旧设置时使用默认值。旧实例键不删除，升级不会自动把某一个实例的选择覆盖到其他实例。

发布需包含完整前端资源和共享包 0.3.0。升级前按运维文档备份 SQLite；回滚使用旧二进制配套的升级前备份，不手工删除迁移记录或把旧程序直接指向新 schema。旧实例浏览器键可供旧版恢复，但新版账号设置不会反向写回旧键。

## 维护

主题源位于 GoTTY 的 `server/terminaldata/themes.json`，执行 `python3 scripts/sync-terminal-themes.py` 生成共享目录；Makefile 在主题源更新时自动重新生成。字体更新使用 GoTTY 的 `scripts/update-terminal-fonts.py`，需要 `fonttools[woff]` 和 curl，固定上游版本并生成清单与内容版本文件名。更新共享核心后提升包版本，重新打包到 Hub vendor，更新 npm lock，并执行 `scripts/check-core.py /path/to/gotty` 验证源文件、字体摘要及授权完整性。
