# 管理员、配置与 Release

## 初始化与密码优先级

管理员用户名固定为 `admin`，不可通过Web注册或CLI改名。首次完全不带参数启动 `gotty-hub` 会在终端隐藏输入管理员密码；空白密码重新询问，只需输入一次，无确认步骤。首次无参数启动始终执行引导；自动化环境使用 `serve` 或显式参数。

服务默认监听 `0.0.0.0:8088`，`HUB_LISTEN` 可覆盖。默认支持直接 HTTP 和可信代理后的 HTTPS；根据真实 socket 对端决定是否采信单值 `X-Forwarded-Proto` / `X-Forwarded-Host`，不使用 X-Forwarded-For 判断信任。默认仅信任回环地址，其他代理需配置 IP/CIDR；完整示例见 [OPERATIONS.md](OPERATIONS.md)。

```sh
./gotty-hub
./gotty-hub --password 'YOUR_ADMIN_PASSWORD'
./gotty-hub serve --password 'YOUR_ADMIN_PASSWORD'
./gotty-hub config --password 'YOUR_ADMIN_PASSWORD'
```

也支持 `--password-stdin` 从stdin读取；只移除最后的换行，密码首尾空格参与校验。`--password` 与 `--password-stdin` 互斥，可位于子命令前后。`configure`是`config`别名；`check`检查配置后退出；help/version不触发引导。

优先级：CLI > `HUB_PASSWORD` > `~/.gotty-hub/config`。首次初始化会保存有效密码；已有配置下的启动覆盖仅对本次进程生效，`config`子命令显式持久化。有效密码与数据库不同会更新admin密码哈希并撤销其旧会话。普通用户密码至少12字节；admin密码非空且最多256字节。

config按要求保存原始admin密码：

```json
{"password":"YOUR_ADMIN_PASSWORD"}
```

可选网络设置也保存于同一 config，不增加首次密码引导项：

```json
{
  "password": "YOUR_ADMIN_PASSWORD",
  "origin": "https://hub.example.com",
  "trusted_proxies": ["127.0.0.1/32", "::1/128"]
}
```

`origin` 优先级为 `--origin` > `HUB_ORIGIN` > config > 自动识别，`--origin auto` 清除固定地址。可信代理优先级为 `--trusted-proxies`（逗号分隔）> `HUB_TRUSTED_PROXIES` > config 的 `trusted_proxies` 数组 > 回环默认值；`none` 或空数组禁用转发头。启动覆盖只对本次进程生效，`config` 子命令保存生效的参数；`check` 同时校验网络设置。Web 修改管理员密码保留这些字段。

config权限0600、目录0700。数据库保存Argon2id哈希。Web修改admin密码同时保存config；下次启动如仍有CLI或环境覆盖，以覆盖值为准。通过stdin启动也支持后台exec重启，不会重复读取已耗尽的管道。

## 数据目录与恢复访问

```text
~/.gotty-hub/
  config
  hub.db
  logs/hub.log.*
  upgrade.json
  updates/previous.bin
  updates/hub-*.db
```

`HUB_HOME`可覆盖整个目录；`HUB_DATABASE` / `HUB_ASSETS`可显式覆盖数据库及静态资源位置。当前0.2使用全新用户名schema，以全新数据目录初始化。

普通用户在Web注册用户名和密码。忘记密码时，在服务器运行：

```sh
./gotty-hub users reset-password --username USER
./gotty-hub users reset-password --username USER --new-password 'NEW_PASSWORD'
./gotty-hub users reset-password --username USER --new-password-stdin
```

重置撤销该用户所有会话。admin也可通过修改config并重启，或启动传入`--password`恢复访问。本机命令使用与服务相同的HUB_HOME/数据库设置。

## 管理后台与在线更新

admin登录后从右上角齿轮进入“管理后台”。普通用户API访问返回403；写操作要求会话、CSRF和精确Origin。

- 统计：用户、注册/在线/离线实例、有效会话、运行时间、版本及commit。
- 升级/重启：固定GitHub仓库的最新Release、进度和互斥操作；继续保留系统操作确认。
- 日志：当前日志末尾最多128KiB，3秒刷新，保留最近7个日志文件；不记录密码、Cookie、设备秘密或终端负载。

重启使用Unix exec，保留PID、启动参数及环境；`--password-stdin` 的有效密码通过环境带入，避免重复读取已耗尽管道。Ctrl-C / SIGTERM 和后台重启共用取消流程，主动结束 SSE、WebSocket、清理任务及未完成升级。连接排空最多3秒，数据库关闭、日志刷新及运行时清理合计总上限5秒；达到总期限强制退出码124，第二次退出信号立即强制退出码130。正常退出码0。退出信号覆盖待执行的重启；不撤销设备身份或用户会话，GoTTY侧PTY继续运行。

升级仅下载 `Xiechengqi/gotty-hub` 的发布资产，最大256MiB，验证SHA256及 `--version`，拒绝低于当前程序版本的资产。替换前保存SQLite一致性备份及旧程序，再原子替换并重启。GitHub API受限时回退公开Release页面。容器通常使用镜像升级；程序目录不可写时在线替换会失败并保留原程序。

回滚时停止服务，使用配套的previous.bin、数据库和config备份恢复。保持升级备份目录私有。

## GitHub Actions

仓库远程地址：`https://github.com/Xiechengqi/gotty-hub.git`，未将用户令牌写进remote或仓库。

`.github/workflows/build-release.yml` 参考miao的前端→双架构构建→发布流程：

1. 推送main、推送v*标签或手动dispatch触发。
2. 前端构建、浏览器UI回归；Rust格式/Clippy/单测/配置引导测试；独立进程的HTTPS反代、WSS/SSE、信号退出及exec重启回归。
3. Zig交叉编译Linux amd64/arm64静态musl单文件。
4. 输出两个binary及各自SHA256文件，GitHub Actions内置GITHUB_TOKEN发布Release。
5. 所有触发方式统一发布名为 `latest`、标签为 `latest` 的 Release；校验产物后将标签更新到当前提交，重复发布覆盖同名 binary 和 SHA256 文件。工作流串行执行，发布说明记录实际 commit，并提供下载到 `/usr/local/bin` 后执行 `chmod +x` 的安装命令。

CI权限只在发布job提升contents:write；无个人令牌或外部邮件服务密钥。check工作流继续验证PR。本轮验证见 [USERNAME_AUTH_REVIEW.md](USERNAME_AUTH_REVIEW.md)，早期发布记录保留在历史review中。
