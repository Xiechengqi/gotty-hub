# API 与传输契约 v1

API 基路径 `/api/v1`，JSON 请求和响应；错误统一 `{ "error": "invalid_request|forbidden|authentication_required|rate_limit|password_length|rotation_pending|database_error" }`，结合 HTTP 状态处理。未知字段不授予权限。OpenAPI 路径目录见 [openapi.json](openapi.json)，设备帧结构见 [connector-v1.schema.json](connector-v1.schema.json)。动态业务校验以服务端及端到端测试为准。

## 认证

`POST /auth/otp/request`：`{email,purpose:"login"|"reset"}` → `{challenge}`。`POST /auth/otp/verify`：`{challenge,code}` → 当前账号及会话 Cookie。`POST /auth/password/login`：`{email,password}`。`POST /auth/password/verify-reset`：`{challenge,code}` 只验证，不消费成功验证码；最终 `POST /auth/password/reset`：`{challenge,code,password}` 原子消费并建立新会话。验证码最多5次尝试、10分钟；每邮箱5分钟最多5次邮件。

`GET /me` 返回 email、csrf、hub_address。后续写操作带 `X-CSRF-Token` 和 `Content-Type: application/json`；浏览器 Origin 精确匹配 HUB_ORIGIN。凭据仅存 HttpOnly SameSite Cookie；生产 Secure。`PUT /me/password`：`{password}` 撤销旧会话并返回新会话；`POST /auth/logout` 退出当前；`DELETE /me/sessions` 退出全部；`GET /me/sessions` 列出到期时间。权限和会话每500ms复查，已有连接被撤销。

## 工作台与授权

`GET /instances` 只返回邮箱有权访问的实例、角色、状态和能力；`GET /events` 是 Cookie 鉴权 SSE，事件 `instances` 每秒刷新完整授权快照。断线重新鉴权同步。`GET/PUT /me/preferences` 保存语言/主题/布局/标签，不能存认证票据。

所有者通过 `GET /instances/{id}/grants` 读取授权，`PUT` 同路径 `{email,role:"operator"|"observer"}` 更新，`DELETE /instances/{id}/grants/{email}` 撤销。所有者不能移除自己；授权变更增加版本，使旧票据/流失效。`DELETE /instances/{id}/binding` 解绑；`POST /instances/{id}/credentials/rotate` 在线两阶段轮换。

`POST /enrollments`：`{email,name,claim,grants?:[{email,role}]}`。claim 是设备本机随机64位hex（256bit），服务端保存摘要，最多50个初始授权。响应 `{id,expires_in}`；`POST /enrollments/{id}/confirm`：`{claim,code}` → `{instance_id,credential}`。同一持有证明在有效期内幂等重试。管理身份在 GoTTY 本机验证，不因持有 Hub 用户 Cookie 自动获得本机管理权。

## 浏览器 WS

先 `POST /instances/{id}/terminal-tickets` 获得30秒一次性 ticket。WS `/terminal-connections/{id}/ws` 的升级检查 Cookie 和 Origin；5秒内首条 JSON `{ticket,epoch?,offset?,channel?:"terminal"|"asr"}`，成功才创建远端流。票据绑定实例/会话/授权版本，不放 URL。

终端后续采用原有 WebTTY 字符串：`1`+base64 输入，`3`+尺寸 JSON；服务端 `1`+base64 输出，回放 epoch/offset 保持原核心实现。`{viewing:boolean}` 上报可见且聚焦视图，3秒续约、10秒过期。观察者只接收输出，不得输入/resize/文件/ASR。ASR 后续音频二进制及 `Done` 文本沿专用通道传到已配置后端。

## 设备 WS

`/connector/v1/connect` 用 Authorization Bearer 设备凭据和 `X-Instance-ID` 实例身份请求头鉴权。首帧 hello 协商 protocol=1，Hub 返回 hello_ack 及 generation。帧 `{kind,stream?,data}`；种类、限额、时序、替换与轮换参见 [架构决策](ARCHITECTURE_DECISIONS.md)。JSON data 是 WebTTY 原始字符串，避免重新解释终端内容；ASR 二进制按 base64 包装。

双方必须释放 close 对应流，未知流不能创建目标。64流/设备，128帧队列，1MiB/帧，10秒发送超时。浏览器与设备身份分离；不提供任意地址代理或本机管理 API 透传。

## 管理接口

配置管理员邮箱认证后 `/me` 和登录响应增加 `is_admin`。所有 `/admin/*` 服务端复核管理员邮箱；写操作继续要求CSRF与精确Origin。GET `/admin/dashboard` 统计平台元数据；GET `/admin/logs` 限定当前日志尾部128KiB；GET `/admin/version` 检查固定GitHub仓库最新Release；GET/POST `/admin/upgrade` 读取进度/提交升级；POST `/admin/restart` 确认重启。升级与重启互斥，冲突409 `operation_active`，发布不可达502 `release_unavailable`。
