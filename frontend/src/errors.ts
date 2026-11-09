export function errorText(code:string,locale:string):string{
 const messages:Record<string,[string,string]>={
 operation_active:["已有升级或重启操作正在执行。","An upgrade or restart is already running."],
 release_unavailable:["暂时无法获取 GitHub Release，请稍后重试。","GitHub release is unavailable. Please try again later."],
 invalid_request:['请求无效或验证码错误、过期，请检查后重试。','Invalid request or expired/incorrect verification code.'],
 invalid_credentials:['邮箱或密码错误。','Incorrect email or password.'],
 authentication_required:['登录已失效，请重新登录。','Your session expired. Please sign in again.'],
 forbidden:['无权执行此操作，请检查登录状态与授权。','Access denied. Check your session and instance access.'],
 rate_limit:['请求过于频繁，请稍后重试。','Too many requests. Please try again later.'],
 password_length:['密码需要 12 到 256 字节。','Use a password between 12 and 256 bytes.'],
 rotation_pending:['设备凭据轮换尚未完成，请等待设备确认。','Credential rotation is waiting for device confirmation.'],
 database_error:['服务暂时不可用，请稍后重试。','The service is temporarily unavailable.'],
 };
 return messages[code]?.[locale==='zh-CN'?0:1]??code;
}
