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
