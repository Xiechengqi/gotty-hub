export function errorText(code:string,locale:string):string{
 const messages:Record<string,[string,string]>={
 username_taken:['该用户名已注册，请直接登录。','This username is already registered. Sign in instead.'],
 invalid_username:['用户名需要 3–64 位字母、数字、点、短横线或下划线，且以字母或数字开头。','Use 3–64 letters, digits, dots, hyphens or underscores, starting with a letter or digit.'],
 user_not_found:['用户不存在，请先在 Hub 注册。','User not found. Register on Hub first.'],
 config_write_failed:['无法保存管理员密码，请检查服务器配置文件权限。','Unable to save the admin password. Check configuration permissions.'],
 registration_expired:['此设备注册已失效，请重新接入。','This device registration is no longer valid. Connect again.'],
 operation_active:["已有升级或重启操作正在执行。","An upgrade or restart is already running."],
 release_unavailable:["暂时无法获取 GitHub Release，请稍后重试。","GitHub release is unavailable. Please try again later."],
 invalid_request:['请求无效，请检查后重试。','Invalid request. Check the form and try again.'],
 invalid_credentials:['用户名或密码错误。','Incorrect username or password.'],
 authentication_required:['登录已失效，请重新登录。','Your session expired. Please sign in again.'],
 forbidden:['无权执行此操作，请检查登录状态与授权。','Access denied. Check your session and instance access.'],
 origin_mismatch:['访问地址校验失败，请检查 Hub 外部地址和反向代理配置。','Address validation failed. Check the public Hub address and reverse proxy configuration.'],
 invalid_proxy_headers:['反向代理地址信息无效，请检查代理配置。','Invalid proxy address headers. Check the reverse proxy configuration.'],
 server_shutting_down:['Hub 正在关闭或重启，请稍后重试。','Hub is shutting down or restarting. Please try again shortly.'],
 rate_limit:['请求过于频繁，请稍后重试。','Too many requests. Please try again later.'],
 password_length:['密码需要 12 到 256 字节。','Use a password between 12 and 256 bytes.'],
 database_error:['服务暂时不可用，请稍后重试。','The service is temporarily unavailable.'],
 terminal_settings_conflict:['终端设置已在其他页面更新。请重新打开设置后再保存。','Terminal settings changed in another page. Reopen settings before saving.'],
 };
 return messages[code]?.[locale==='zh-CN'?0:1]??code;
}
