# 部署与运维

## 生产部署

构建 `Dockerfile` 或 `make build`。镜像包含静态资源，以 UID 10001 运行，持久卷 `/data`。部署模板在 `deploy/compose.yaml`；复制 `deploy/hub.env.example` 到私有配置，填写实际 HTTP(S) origin 和 HUB_PASSWORD。

```sh
cd deploy
docker compose --env-file /private/hub.env config
docker compose --env-file /private/hub.env up -d --build
```

Hub binary 默认监听 `0.0.0.0:8088`，直接 HTTP 访问根据 Host 校验同源；可信代理后的 HTTPS 则根据代理覆盖的 `X-Forwarded-Proto` / `X-Forwarded-Host` 识别外部地址，登录、`hub_address`、Secure Cookie、HSTS 及浏览器 WS 校验共用同一结果。

默认可信代理为 `127.0.0.0/8`、`::1/128`，信任依据是实际 socket 对端 IP（包含IPv4映射IPv6的规范化），不依据 X-Forwarded-For。容器网桥/远程代理应填写实际代理 IP 或最小 CIDR，例如 `--trusted-proxies 172.20.0.2/32`；这会替换默认信任列表，需要同时信任回环时将它一起列出。不要对公网配置 `0.0.0.0/0`。

只支持单值 X-Forwarded-Proto（http/https）和 X-Forwarded-Host。最后一跳可信代理必须覆盖客户端的同名头，不能追加逗号链；重复/逗号链返回400 `invalid_proxy_headers`。不可信对端的转发头完全忽略；不解析 RFC Forwarded。多层代理需由最后一跳输出确定的公共地址，或用 `--origin` / `HUB_ORIGIN` 固定外部根地址，固定值优先于推断。`--origin auto` 清除旧的固定值。

`deploy/Caddyfile` 已显式覆盖这两个头，替换域名并配置 DNS 即可用于本机 HTTPS 反代；binary 可设置 `HUB_LISTEN=127.0.0.1:8088`。Compose 的宿主机端口仅向回环发布，但容器内实际对端通常为网桥IP；模板继续要求显式 HUB_ORIGIN，以免依赖容器网段猜测。代理需支持 WebSocket、SSE 不缓冲，空闲超时长于心跳；不要缓存终端请求或记录请求体。认证限流继续按实际连接IP聚合。

Nginx 的 `http` 段添加 `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`，在已配置 TLS 证书的 server 中使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

| 配置 | 用途 |
|---|---|
| HUB_ORIGIN | 可选固定外部 HTTP(S) origin，不带路径；低于 --origin，高于 config；auto 清除固定值 |
| HUB_TRUSTED_PROXIES | 可信代理 IP/CIDR，逗号分隔；低于 --trusted-proxies，高于 config；默认回环，none 禁用 |
| HUB_LISTEN | 默认 0.0.0.0:8088，可显式设为 127.0.0.1:8088 |
| HUB_DATABASE | SQLite URL，默认 ~/.gotty-hub/hub.db |
| HUB_ASSETS | 可选外部静态资源目录；默认使用 binary 内嵌资源 |
| HUB_PASSWORD | admin启动密码覆盖，低于CLI、高于config |
| HUB_HOME | 默认 ~/.gotty-hub，容器 /data |

GoTTY 需对应 Connector 版本，Hub 功能默认开启，可用 `--hub-disabled` 关闭。凭据默认 `~/.gotty/hub.json`，原子写入 0600；父目录 0700。若 `~/.gotty` 是配置文件，则改用 `~/.gotty-hub.json`。不要复制同一身份同时运行两个实例。轮换需要在线设备完成落盘确认；离线设备应解绑后重新注册。解绑会关闭浏览器流，旧设备不能再连接。

## 监测与故障处理

- `/healthz`：进程存活。`/readyz`：数据库查询。
- `/api/v1/diagnostics`：需要 Cookie 会话的汇总信息，不包含终端负载或凭据。
- 实例离线：检查 GoTTY 到 Hub 的 DNS/TLS/防火墙及 WSS。设备每15秒心跳，45秒失联；自动退避重连。Hub 重启时先显示离线，认证重连后恢复。
- 浏览器401/403：`origin_mismatch` 表示浏览器 Origin 与解析出的外部地址不同。先检查旧的 CLI/环境/config 固定值，再检查代理真实对端是否在可信列表、代理是否覆盖上述两个头。日志只记录规范化的预期/实际 origin，不记录密码或会话。`invalid_proxy_headers` 表示可信代理发送了无效或含歧义的头；密码错误为401 `invalid_credentials`。
- 文件：服务器安装 rz/sz；单文件64MiB，观察者禁用。取消后终端应可继续输入。
- ASR：仅使用 GoTTY 配置的 ASRBackend；HTTPS 下授予麦克风权限；每流120秒/16MiB。不开放通用上游 URL。
- 磁盘满/数据库错误：停止接入写入、释放空间，检查 SQLite 完整性；错误不会授予新权限。部署监控应包含磁盘剩余、进程内存、WS 断开率。

## 停止与重启

Ctrl-C（SIGINT）、SIGTERM 和后台重启共用退出流程：停止接入新请求（503 `server_shutting_down`）、结束 SSE 的响应体，主动关闭设备和浏览器 WS（普通退出1001，重启1012），取消清理任务/下载任务。连接排空预算3秒；数据库、日志及 Tokio 运行时清理也受5秒总期限约束。独立看门线程覆盖异步任务和日志析构；超限退出码124，再次发送退出信号立即退出码130。正常排空退出码0。退出信号优先于待执行重启，防止 Ctrl-C 后重新拉起。

Hub退出只关闭传输，不发送解绑/替换消息，不删除实例凭据、授权或用户会话；远端 GoTTY PTY 保持运行。GoTTY及浏览器使用既有退避策略重连。升级下载取消会清理暂存文件并终止版本探测子进程；已完成原子替换时不自动回退新版程序。强制退出后，下次启动将未完成升级标记为 interrupted。

## 一致性备份和恢复

生产备份需保护账号、密码哈希、授权、凭据摘要及包含admin密码的私有config。推荐用 SQLite online backup；不要只复制正在写入的主文件而遗漏 WAL。

```sh
umask 077
sqlite3 "$HOME/.gotty-hub/hub.db" ".backup '/private/backup/hub.db'"
sqlite3 /private/backup/hub.db 'PRAGMA integrity_check;'
```

也可停止 Hub 后同时备份数据库及 WAL/SHM。GoTTY 身份文件单独加密备份，保留0600，Hub config与数据库一起私有备份。

恢复时停止 Hub，保留故障现场，恢复备份数据库，修正文件属主和权限，再启动匹配版本。旧备份可能重新引入已撤销的会话/凭据；安全恢复后删除全部 sessions/tickets 并轮换设备凭据或重新绑定。浏览器需重新登录。

## 升级、回滚与发布

1. 记录二进制/镜像 digest、共享核心 tarball integrity 和迁移版本，做一致性备份。
2. 在隔离环境用备份副本启动新版本，检查迁移、登录、设备重连和真实命令往返。
3. 更新 Hub，再更新 GoTTY；v1 仅支持 protocol=1，未知版本拒绝，不降级通用代理。单节点重启会断开连接，PTY 留在 GoTTY。
4. 回滚先停新版本，使用升级前备份与旧版本配对恢复。不要直接让旧二进制运行新 schema。
5. `docker buildx build --platform linux/amd64,linux/arm64 ...` 可构建多架构发布；外部 registry 推送独立执行。本次未推送镜像或改动生产。

兼容矩阵：Hub0.2 / Connector协议1 / terminal-core0.2.0 / schema 0001+0002（实例名唯一约束）。未启用 Hub 的 GoTTY 继续独立工作；无 ASR 能力时降级键盘输入。默认限额和状态时序见架构决策。

管理员、数据路径、单文件引导和在线更新以 [ADMINISTRATION.md](ADMINISTRATION.md) 为准；容器HUB_HOME=/data对应命名卷。
