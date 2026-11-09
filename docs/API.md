# API 与传输契约 v1

API 基路径 `/api/v1`，JSON 请求和响应；错误统一 `{ "error": "invalid_request|forbidden|authentication_required|rate_limit|password_length|invalid_username|username_taken|user_not_found|registration_expired|rotation_pending|config_write_failed|database_error" }`，结合 HTTP 状态处理。未知字段不授予权限。OpenAPI 路径目录见 [openapi.json](openapi.json)，设备帧结构见 [connector-v1.schema.json](connector-v1.schema.json)。动态业务校验以服务端及端到端测试为准。

## 认证

`POST /auth/register`：`{username,password}` → `{id,username,csrf,hub_address,is_admin:false}` 及会话 Cookie。用户名去除首尾空白并规范为小写，3–64 位 ASCII 字母/数字/点/下划线/短横线，首位必须为字母或数字。重复或保留的 `admin` 返回409 `username_taken`；注册不能提升管理员权限。普通用户密码12–256字节，使用Argon2id保存哈希。

`POST /auth/password/login`：`{username,password}`；错误凭据返回401 `invalid_credentials`。管理员固定用户名 `admin`，首次监听前创建，密码取本次有效CLI/环境/config，非空且不超过256字节。`GET /me` 返回 `id,username,csrf,hub_address,is_admin`。

后续写操作带 `X-CSRF-Token` 和 `Content-Type: application/json`；浏览器 Origin 精确匹配 HUB_ORIGIN。会话使用HttpOnly SameSite Cookie，生产Secure。`PUT /me/password`：`{password}` 撤销旧会话并返回新会话，admin同时更新私有config；启动参数仍具有最高优先级。`POST /auth/logout`退出当前；`DELETE /me/sessions`退出全部；`GET /me/sessions`列出到期时间。权限和会话每500ms复查。忘记密码使用服务器本机 `users reset-password --username USER` 命令。

## 工作台与授权

`GET /instances` 只返回当前用户有权访问的实例、角色、状态和能力；`GET /events` 是 Cookie 鉴权 SSE，事件 `instances` 每秒刷新完整授权快照。断线重新鉴权同步。`GET/PUT /me/preferences` 保存语言/主题/布局/标签，不能存认证票据。

所有者通过 `GET /instances/{id}/grants` 读取授权，`PUT` 同路径 `{username,role:"operator"|"observer"}` 更新，`DELETE /instances/{id}/grants/{username}` 撤销。所有者不能移除自己；授权变更增加版本，使旧票据/流失效。`DELETE /instances/{id}/binding` 解绑；`POST /instances/{id}/credentials/rotate` 在线两阶段轮换。

`POST /instances/register`：`{username,name,request_id,claim}` → `{instance_id,credential,protocol:1}`。公开且限流的设备注册接口，必须提供已存在用户名，否则404 `user_not_found`，不隐式创建用户。实例名由GoTTY自动生成，request_id/claim由本机生成并在请求前私有落盘，均为256位随机hex，用户无需输入或验证。

事务原子创建实例、owner授权和幂等记录。相同请求ID、用户和claim恢复相同结果；不同持有秘密或用户拒绝。解绑或轮换后不可通过旧注册请求恢复凭据，返回409 `registration_expired`。Hub只保存claim与设备凭据摘要；GoTTY后端私有保存设备秘密，不返回页面。知道用户名可将新设备注册给该用户，不能登录用户或访问其已有实例。

GoTTY本机 `GET -/hub` 返回地址、用户名、实例ID与连接状态；`POST -/hub` 仅接收 `{URL,Username}`。主站使用既有GoTTY权限；无密码且显式启用Hub时允许主站管理，分享页面一律拒绝。错误 `{error,message}`，未知用户保留404与错误码，前端提供Hub注册链接。

## 浏览器 WS

先 `POST /instances/{id}/terminal-tickets` 获得30秒一次性 ticket。WS `/terminal-connections/{id}/ws` 的升级检查 Cookie 和 Origin；5秒内首条 JSON `{ticket,epoch?,offset?,channel?:"terminal"|"asr"}`，成功才创建远端流。票据绑定实例/会话/授权版本，不放 URL。

终端后续采用原有 WebTTY 字符串：`1`+base64 输入，`3`+尺寸 JSON；服务端 `1`+base64 输出，回放 epoch/offset 保持原核心实现。`{viewing:boolean}` 上报可见且聚焦视图，3秒续约、10秒过期。观察者只接收输出，不得输入/resize/文件/ASR。ASR 后续音频二进制及 `Done` 文本沿专用通道传到已配置后端。

## 设备 WS

`/connector/v1/connect` 用 Authorization Bearer 设备凭据和 `X-Instance-ID` 实例身份请求头鉴权。首帧 hello 协商 protocol=1，Hub 返回 hello_ack 及 generation。帧 `{kind,stream?,data}`；种类、限额、时序、替换与轮换参见 [架构决策](ARCHITECTURE_DECISIONS.md)。JSON data 是 WebTTY 原始字符串，避免重新解释终端内容；ASR 二进制按 base64 包装。

双方必须释放 close 对应流，未知流不能创建目标。64流/设备，128帧队列，1MiB/帧，10秒发送超时。浏览器与设备身份分离；不提供任意地址代理或本机管理 API 透传。

## 管理接口

`/me` 和登录响应包含 `is_admin`。所有 `/admin/*` 服务端复核数据库管理员标记；写操作继续要求CSRF与精确Origin。GET `/admin/dashboard` 统计平台元数据；GET `/admin/logs` 限定当前日志尾部128KiB；GET `/admin/version` 检查固定GitHub仓库最新Release；GET/POST `/admin/upgrade` 读取进度/提交升级；POST `/admin/restart` 确认重启。升级与重启互斥，冲突409 `operation_active`，发布不可达502 `release_unavailable`。
