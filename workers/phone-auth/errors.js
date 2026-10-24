const MESSAGES = Object.freeze({
  SMS_DISABLED: '短信认证暂未启用',
  SMS_CONFIG: '短信认证配置不可用',
  INVALID_REQUEST: '请求参数无效',
  REAUTH_REQUIRED: '请先重新验证身份',
  CAPTCHA_FAILED: '人机验证未通过',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  BUDGET_EXCEEDED: '短信服务额度暂不可用',
  SERVICE_UNAVAILABLE: '短信认证服务暂不可用',
  CHALLENGE_INVALID: '验证请求无效',
  CHALLENGE_EXPIRED: '验证请求已过期',
  CHALLENGE_USED: '验证请求已使用',
  CODE_INVALID: '验证码无效或已过期',
  PROVIDER_RATE_LIMITED: '短信服务请求过于频繁',
  PROVIDER_AUTH: '短信服务认证不可用',
  PROVIDER_CONFIG: '短信服务配置不可用',
  PROVIDER_UNAVAILABLE: '短信服务暂不可用',
  UPSTREAM_TIMEOUT: '短信服务请求超时',
  UPSTREAM_UNAVAILABLE: '短信服务连接不可用',
  UPSTREAM_PROTOCOL: '短信服务响应异常',
  IDENTITY_DISABLED: '手机号认证暂未启用',
  IDENTITY_CONFIG: '手机号身份服务配置不可用',
  IDENTITY_UNAVAILABLE: '手机号身份服务暂不可用',
  UNAUTHORIZED: '请先登录后再操作',
  ACCOUNT_NOT_ACTIVE: '当前账号无法执行此操作',
  ACCOUNT_BANNED: '当前账号不可用',
  PHONE_KEY_MISMATCH: '手机号身份密钥配置不一致',
  PHONE_CONFLICT: '该手机号已绑定其他账号',
  PHONE_ALREADY_BOUND: '账号已绑定手机号',
  PHONE_NOT_BOUND: '账号尚未绑定手机号',
  REAUTH_INVALID: '近期身份验证已失效，请重新验证',
  ALTERNATIVE_LOGIN_REQUIRED: '请先验证其他可用登录方式',
  OPERATION_CONFLICT: '操作请求冲突，请重新验证',
  DELETION_CONFLICT: '账号注销状态冲突',
});

export class PhoneAuthError extends Error {
  constructor(code, status = 400) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'SERVICE_UNAVAILABLE';
    super(MESSAGES[safeCode]);
    this.name = 'PhoneAuthError';
    this.code = safeCode;
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 503;
  }
}

export function requireSmsEnabled(env) {
  if (env?.PHONE_SMS_ENABLED !== 'true') throw new PhoneAuthError('SMS_DISABLED', 503);
}
