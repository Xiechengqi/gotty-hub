# 首次配置、管理员与 Release

## 单文件启动

从 GitHub Release 下载 `gotty-hub-linux-amd64` 或 `gotty-hub-linux-arm64`，使用同名 `.sha256` 校验后赋予执行权限。前端已经嵌入，不需要在旁边保留 frontend/dist。

首次直接运行 `./gotty-hub` 会交互要求两个非空值：Resend API key（隐藏回显）和管理员邮箱。未连接终端且缺少值时拒绝启动，并给出子命令用法。输入后保存到 `~/.gotty-hub/config`，JSON格式，权限0600，目录0700。

```sh
./gotty-hub config --resend-api-key 'YOUR_RESEND_KEY' --admin-email 'admin@example.com'
./gotty-hub
```

`configure` 是 `config` 的别名；config 子命令仅保存配置。`check` 验证配置后退出。`--help`、`--version` 不触发配置引导。

临时覆盖配置并启动：

```sh
./gotty-hub serve --resend-api-key 'OVERRIDE_KEY' --admin-email 'other@example.com'
```

优先级：命令行参数 > `RESEND_API_KEY` / `HUB_ADMIN_EMAIL` > config。serve 覆盖仅本次运行；config 子命令才更新已有配置。初次启动若值由环境或参数提供，同样持久化首次配置。命令行参数可能出现在本机进程列表；交互或私有环境注入适合处理密钥。

默认监听127.0.0.1:8088，origin为http://127.0.0.1:8088。生产通过反向代理配置真实 `HUB_ORIGIN=https://hub.example.com`，需要时设置 HUB_LISTEN；非本机公开origin必须HTTPS。`HUB_MAIL_FROM` 设置验证过的发件人，默认使用Resend测试发件人 `onboarding@resend.dev`（其投递范围受Resend限制）。不要求增加第三个首次必填输入。

## 数据布局

```text
~/.gotty-hub/
  config             # resend_api_key / admin_email
  hub.db             # SQLite（可能伴随WAL/SHM）
  logs/hub.log.*     # 按天轮换，保留最近7个日志文件
  mail/              # 仅HUB_DEV=1开发邮箱
  upgrade.json       # 升级进度与结果
  updates/
    previous.bin     # 上一版本程序
    hub-*.db         # 升级前SQLite一致性快照
```

容器/隔离测试可用 `HUB_HOME` 改变整个根目录，默认仍是 `~/.gotty-hub`。兼容已有 `HUB_DATABASE` / `HUB_ASSETS` / `HUB_DEV_MAIL_DIR` 显式覆盖；普通安装无需配置。升级下载的临时可执行文件放在当前binary同目录，以保证原子rename，失败清理。此目录需可写。

旧版本若使用工作目录hub.db，请停服、一致性备份并将数据库迁到新目录，或暂时显式设置HUB_DATABASE；不要遗漏活动WAL。

## 管理员后台

管理员用配置邮箱完成正常验证码/密码认证后，在右上角齿轮的“账号与安全”中进入“管理后台”。没有默认密码、万能token或匿名后台；普通用户的管理员API访问返回403。运行中管理员邮箱以本次进程有效配置为准，改config后重启生效。

- 统计概览：用户、注册/在线实例、有效会话、待投递邮件、运行时间、版本/commit。
- 升级与重启：检查GitHub最新Release，展示下载进度；按钮二次确认。后台操作有独占锁，禁止同时升级/重启。
- 系统日志：管理员读取当前日志末尾最多128KiB，3秒刷新。不会记录邮件key、Cookie、设备凭据或终端输入输出。API不接受任意文件路径。

重启采用Unix exec，保留PID、启动参数及环境；先停止监听，给现有连接3秒退出，再重启，设备和浏览器自动重连。当前共享PTY在GoTTY侧保持运行。容器建议用镜像升级，容器内非root用户无法替换只读镜像中的程序时，在线升级会安全失败并保留旧程序。

升级固定使用 `Xiechengqi/gotty-hub` 的发布资产，不接受任意下载地址。下载最大256MiB、SHA256校验、执行 `--version` 预检后，SQLite `VACUUM INTO` 一致性备份与旧程序副本写入updates，再原子替换并重启。下载失败/校验失败不替换程序；新进程按目标commit核对升级完成状态。GitHub API受限流时回退公开Release重定向页面。

升级后若启动失败，停止服务，用updates/previous.bin替换程序；涉及不兼容迁移时同时恢复配对的hub-*.db备份。不要用旧程序盲目读取新schema。备份包含账号、授权和会话元数据，保持目录私有；自行按运维保留策略清理旧升级备份。

## GitHub Actions

仓库远程地址：`https://github.com/Xiechengqi/gotty-hub.git`，未将用户令牌写进remote或仓库。

`.github/workflows/build-release.yml` 参考miao的前端→双架构构建→发布流程：

1. 推送main、推送v*标签或手动dispatch触发。
2. 前端构建、浏览器UI回归；Rust格式/Clippy/单测/配置引导测试。
3. Zig交叉编译Linux amd64/arm64静态musl单文件。
4. 输出两个binary及各自SHA256文件，GitHub Actions内置GITHUB_TOKEN发布Release。
5. main/dispatch生成唯一build-run-attempt-sha标签并设为latest；v*使用明确版本标签。保留历史Release，不删除旧Release或强推latest标签。

CI权限只在发布job提升contents:write；无个人令牌或Resend密钥。check工作流继续验证PR。实际执行记录与本轮验证见 IMPLEMENTATION_REVIEW.md。
