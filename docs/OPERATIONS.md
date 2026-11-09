# 部署与运维

## 生产部署

构建 `Dockerfile` 或 `make build`。镜像包含静态资源，以 UID 10001 运行，持久卷 `/data`。部署模板在 `deploy/compose.yaml`；复制 `deploy/hub.env.example` 到私有配置，填写真实 HTTPS origin、验证过的发件人和 Resend 密钥、HUB_ADMIN_EMAIL。不要开启 HUB_DEV，也不要将开发邮箱目录公开提供下载。

```sh
cd deploy
docker compose --env-file /private/hub.env config
docker compose --env-file /private/hub.env up -d --build
```

`deploy/Caddyfile` 提供宿主机反向代理示例，替换域名并配置 DNS。8088 仅绑定回环；对外通过 Caddy HTTPS。代理需支持 WebSocket、SSE 不缓冲，空闲超时长于心跳；不要把终端请求缓存或记录请求体。Hub 不信任任意 X-Forwarded-For，代理后的公共认证限流按代理地址聚合，扩大规模前需单独设计可信代理策略。

| 配置 | 用途 |
|---|---|
| HUB_ORIGIN | 唯一外部 HTTP(S) origin；生产必须 HTTPS，不带路径 |
| HUB_LISTEN | 默认 127.0.0.1:8088，容器内 0.0.0.0:8088 |
| HUB_DATABASE | SQLite URL，默认 ~/.gotty-hub/hub.db |
| HUB_ASSETS | 可选外部静态资源目录；默认使用 binary 内嵌资源 |
| HUB_MAIL_FROM / RESEND_API_KEY | 验证过的发件人及服务端邮件密钥 |
| HUB_DEV / HUB_DEV_MAIL_DIR | 仅本地开发；私有目录保存测试验证码 |

GoTTY 需对应 Connector 版本，开启 `--hub-enabled`。凭据默认 `~/.gotty/hub.json`，原子写入 0600；父目录 0700。不要复制同一身份同时运行两个实例。轮换需要在线设备完成落盘确认；离线设备应解绑后重新注册。解绑会关闭浏览器流，旧设备不能再连接。

## 监测与故障处理

- `/healthz`：进程存活。`/readyz`：数据库查询。
- `/api/v1/diagnostics`：需要 Cookie 会话的汇总信息，不包含终端负载或凭据。
- 实例离线：检查 GoTTY 到 Hub 的 DNS/TLS/防火墙及 WSS。设备每15秒心跳，45秒失联；自动退避重连。Hub 重启时先显示离线，认证重连后恢复。
- 浏览器401/403：检查精确 origin、Cookie、CSRF、会话到期及实例授权；重新登录，不能绕过鉴权重试输入。
- 邮件失败：检查 Resend 密钥、已验证域名和 outbox 队列。worker 有幂等键与有界重试，到期消息不再发送；不要人工把旧验证码重新发出。
- 文件：服务器安装 rz/sz；单文件64MiB，观察者禁用。取消后终端应可继续输入。
- ASR：仅使用 GoTTY 配置的 ASRBackend；HTTPS 下授予麦克风权限；每流120秒/16MiB。不开放通用上游 URL。
- 磁盘满/数据库错误：停止接入写入、释放空间，检查 SQLite 完整性；错误不会授予新权限。部署监控应包含磁盘剩余、进程内存、WS 断开率、邮件积压。

## 一致性备份和恢复

生产备份需保护邮箱、授权和凭据摘要。推荐用 SQLite online backup；不要只复制正在写入的主文件而遗漏 WAL。

```sh
umask 077
sqlite3 /var/lib/gotty-hub/hub.db ".backup '/private/backup/hub.db'"
sqlite3 /private/backup/hub.db 'PRAGMA integrity_check;'
```

也可停止 Hub 后同时备份数据库及 WAL/SHM。GoTTY 身份文件单独加密备份，保留0600；Resend 密钥通过私有 secret 管理。

恢复时停止 Hub，保留故障现场，恢复备份数据库，修正文件属主和权限，再启动匹配版本。旧备份可能重新引入已撤销的会话/凭据；安全恢复后删除全部 sessions/tickets 并轮换设备凭据或重新绑定。浏览器需重新登录。

## 升级、回滚与发布

1. 记录二进制/镜像 digest、共享核心 tarball integrity 和迁移版本，做一致性备份。
2. 在隔离环境用备份副本启动新版本，检查迁移、登录、设备重连和真实命令往返。
3. 更新 Hub，再更新 GoTTY；v1 仅支持 protocol=1，未知版本拒绝，不降级通用代理。单节点重启会断开连接，PTY 留在 GoTTY。
4. 回滚先停新版本，使用升级前备份与旧版本配对恢复。不要直接让旧二进制运行新 schema。
5. `docker buildx build --platform linux/amd64,linux/arm64 ...` 可构建多架构发布；外部 registry 推送独立执行。本次未推送镜像或改动生产。

兼容矩阵：Hub0.1 / Connector协议1 / terminal-core0.1.0 / 迁移0001–0003。未启用 Hub 的 GoTTY 继续独立工作；无 ASR 能力时降级键盘输入。默认限额和状态时序见架构决策。

管理员、数据路径、单文件引导和在线更新以 [ADMINISTRATION.md](ADMINISTRATION.md) 为准；容器HUB_HOME=/data对应命名卷。
