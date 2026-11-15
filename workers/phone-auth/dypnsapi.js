import { PhoneAuthError, requireSmsEnabled } from './errors.js';
import { requestJson } from './http.js';

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

// RPC metadata puts all Dypnsapi parameters in query; the POST body is empty.
export async function signAcs3Request(options = {}) {
  if (!options || typeof options !== 'object') throw new PhoneAuthError('SMS_CONFIG', 503);
  const { host, action, version, query, date, nonce, accessKeyId, accessKeySecret, securityToken } = options;
  if (!nonempty(host, 253) || !/^[a-z0-9.-]+\.aliyuncs\.com$/.test(host) ||
      !nonempty(action, 64) || !/^[A-Za-z][A-Za-z0-9]*$/.test(action) ||
      !nonempty(version, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(version) ||
      !nonempty(date, 20) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || !nonempty(nonce, 128) || !/^[A-Za-z0-9_-]+$/.test(nonce) ||
      !nonempty(accessKeyId, 128) || !/^[A-Za-z0-9_-]+$/.test(accessKeyId) || !nonempty(accessKeySecret) ||
      (securityToken !== undefined && !nonempty(securityToken, 8192)) ||
      !query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length > 64 ||
      Object.entries(query).some(([key, value]) => !nonempty(key, 128) ||
        !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 16384 ||
        (typeof value === 'number' && !Number.isFinite(value)))) {
    throw new PhoneAuthError('SMS_CONFIG', 503);
  }
  try {
    const queryString = Object.keys(query).sort().map((key) => `${encode(key)}=${encode(query[key])}`).join('&');
    const payloadHash = await hash('');
    const headers = {
      host, 'x-acs-action': action, 'x-acs-content-sha256': payloadHash,
      'x-acs-date': date, 'x-acs-signature-nonce': nonce, 'x-acs-version': version,
    };
    if (securityToken) headers['x-acs-security-token'] = securityToken;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonical = ['POST', '/', queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const key = await crypto.subtle.importKey('raw', encoder.encode(accessKeySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`ACS3-HMAC-SHA256\n${await hash(canonical)}`)));
    headers.authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
    return { url: `https://${host}/?${queryString}`, init: { method: 'POST', headers, body: '' } };
  } catch {
    throw new PhoneAuthError('SMS_CONFIG', 503);
  }
}

function nonempty(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function configuration(env) {
  requireSmsEnabled(env);
  const timeout = env.PHONE_API_TIMEOUT_MS === undefined ? 5000 :
    typeof env.PHONE_API_TIMEOUT_MS === 'string' && /^\d+$/.test(env.PHONE_API_TIMEOUT_MS) ? Number(env.PHONE_API_TIMEOUT_MS) : NaN;
  if (!nonempty(env.PHONE_ALIYUN_ACCESS_KEY_ID, 128) || !/^[A-Za-z0-9_-]+$/.test(env.PHONE_ALIYUN_ACCESS_KEY_ID) ||
      !nonempty(env.PHONE_ALIYUN_ACCESS_KEY_SECRET) || !nonempty(env.PHONE_SMS_SIGN_NAME, 128) ||
      !nonempty(env.PHONE_SMS_TEMPLATE_CODE, 128) || !/^[A-Za-z0-9_-]+$/.test(env.PHONE_SMS_TEMPLATE_CODE) ||
      (env.PHONE_ALIYUN_SECURITY_TOKEN !== undefined && !nonempty(env.PHONE_ALIYUN_SECURITY_TOKEN, 8192)) ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 10000) {
    throw new PhoneAuthError('SMS_CONFIG', 503);
  }
  return { timeout };
}

function validate(input, check = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PhoneAuthError('INVALID_REQUEST', 400);
  const { phone, scheme, outId, code } = input;
  if (typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone) ||
      !nonempty(scheme, 20) || !nonempty(outId, 128) || !/^[A-Za-z0-9_-]+$/.test(outId) ||
      (check && (typeof code !== 'string' || !/^\d{6}$/.test(code)))) {
    throw new PhoneAuthError('INVALID_REQUEST', 400);
  }
}

const RATE_CODES = new Set(['BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL', 'biz.FREQUENCY', 'isv.BUSINESS_LIMIT_CONTROL', 'isp.QPS_LIMIT', 'LimitExceeded.SmsCode']);
const AUTH_CODES = new Set(['isv.RAM_PERMISSION_DENY', 'isp.RAM_PERMISSION_DENY', 'isv.FORBIDDEN_ACTION',
  'InvalidAccessKeyId.NotFound', 'SignatureDoesNotMatch', 'InvalidSecurityToken.Expired', 'InvalidTimeStamp.Expired']);
const CONFIG_CODES = new Set(['MOBILE_NUMBER_ILLEGAL', 'INVALID_PARAMETERS', 'FUNCTION_NOT_OPENED', 'isv.MOBILE_NUMBER_ILLEGAL',
  'isv.INVALID_PARAMETERS', 'isv.VERIFY_SCHEME_NOT_EXIST', 'isv.PRODUCT_UNSUBSCRIBE', 'isv.PRODUCT_UN_SUBSCRIPT',
  'isv.OUT_OF_SERVICE', 'isv.ACCOUNT_NOT_EXISTS', 'isv.ACCOUNT_ABNORMAL', 'EntityNotExist.SmsTemplateCode',
  'EntityNotExist.SmsSignName', 'InvalidParameter.SmsTemplateCode']);

function providerError(data, status, check) {
  if (RATE_CODES.has(data.Code) || status === 429) return new PhoneAuthError('PROVIDER_RATE_LIMITED', 429);
  if (AUTH_CODES.has(data.Code) || status === 401 || status === 403) return new PhoneAuthError('PROVIDER_AUTH', 503);
  if (CONFIG_CODES.has(data.Code)) return new PhoneAuthError('PROVIDER_CONFIG', 503);
  if (check && data.Code === 'isv.ValidateFail') return new PhoneAuthError('CODE_INVALID', 400);
  return new PhoneAuthError('PROVIDER_UNAVAILABLE', 503);
}

export class DypnsapiClient {
  constructor(env, { fetchImpl = (url, init) => globalThis.fetch(url, init), now = Date.now, nonce = () => crypto.randomUUID() } = {}) {
    configuration(env);
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonce = nonce;
  }

  async send(input) {
    const { timeout } = configuration(this.env);
    validate(input);
    await this.#call('SendSmsVerifyCode', {
      CountryCode: '86', PhoneNumber: input.phone, SchemeName: input.scheme, OutId: input.outId,
      SignName: this.env.PHONE_SMS_SIGN_NAME, TemplateCode: this.env.PHONE_SMS_TEMPLATE_CODE,
      TemplateParam: JSON.stringify({ code: '##code##', min: '5' }), CodeLength: 6, CodeType: 1,
      ValidTime: 300, Interval: 60, DuplicatePolicy: 1, ReturnVerifyCode: false, AutoRetry: 0,
    }, timeout);
    return { accepted: true };
  }

  async check(input) {
    const { timeout } = configuration(this.env);
    validate(input, true);
    const data = await this.#call('CheckSmsVerifyCode', {
      CountryCode: '86', PhoneNumber: input.phone, SchemeName: input.scheme, OutId: input.outId, VerifyCode: input.code,
    }, timeout);
    if (data.Model?.VerifyResult !== 'PASS') throw new PhoneAuthError('CODE_INVALID', 400);
    return { verified: true };
  }

  async #call(action, query, timeoutMs) {
    try {
      const signed = await signAcs3Request({
        host: 'dypnsapi.aliyuncs.com', action, version: '2017-05-25', query,
        date: new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce: this.nonce(),
        accessKeyId: this.env.PHONE_ALIYUN_ACCESS_KEY_ID, accessKeySecret: this.env.PHONE_ALIYUN_ACCESS_KEY_SECRET,
        securityToken: this.env.PHONE_ALIYUN_SECURITY_TOKEN,
      });
      const { status, data } = await requestJson(signed.url, signed.init, { fetchImpl: this.fetchImpl, timeoutMs });
      if (status < 200 || status >= 300 || data.Success !== true || data.Code !== 'OK') {
        throw providerError(data, status, action === 'CheckSmsVerifyCode');
      }
      return data;
    } catch (error) {
      if (error instanceof PhoneAuthError) throw error;
      throw new PhoneAuthError('PROVIDER_UNAVAILABLE', 503);
    }
  }
}
