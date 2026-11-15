import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { DypnsapiClient, signAcs3Request } from '../workers/phone-auth/dypnsapi.js';
import { PhoneAuthError, requireSmsEnabled } from '../workers/phone-auth/errors.js';
import { requestJson } from '../workers/phone-auth/http.js';

// Every permitted network response is injected below; accidental live calls fail.
mock.method(globalThis, 'fetch', async () => { throw new Error('Live network is forbidden in SMS tests'); });

const env = () => ({
  PHONE_SMS_ENABLED: 'true', PHONE_ALIYUN_ACCESS_KEY_ID: 'test-key-id',
  PHONE_ALIYUN_ACCESS_KEY_SECRET: 'test-key-secret', PHONE_SMS_SIGN_NAME: '测试签名',
  PHONE_SMS_TEMPLATE_CODE: '100001',
});
const input = { phone: '13800138000', scheme: 'sunland_login', outId: 'test-challenge-001' };
const success = (extra = {}) => Response.json({ Success: true, Code: 'OK', ...extra });
const codeIs = (code, status) => (error) => {
  assert.ok(error instanceof PhoneAuthError);
  assert.equal(error.code, code);
  if (status) assert.equal(error.status, status);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, /13800138000|123456|test-key|private|raw|https:/);
  return true;
};

test('ACS3 matches the official RunInstances fixed signing vector', async () => {
  const signed = await signAcs3Request({
    host: 'ecs.cn-shanghai.aliyuncs.com', action: 'RunInstances', version: '2014-05-26',
    query: { RegionId: 'cn-shanghai', ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd' },
    date: '2023-10-26T10:22:32Z', nonce: '3156853299f313e23d1673dc12e1703d',
    accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret',
  });
  assert.equal(signed.init.method, 'POST');
  assert.equal(signed.init.body, '');
  assert.equal(signed.url, 'https://ecs.cn-shanghai.aliyuncs.com/?ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai');
  assert.equal(signed.init.headers.authorization, 'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
});

test('provider is disabled by default, fails closed on configuration, and rechecks its gate', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return success(); };
  for (const value of [undefined, '', false, true, 'TRUE', 'false']) {
    assert.throws(() => requireSmsEnabled({ PHONE_SMS_ENABLED: value }), codeIs('SMS_DISABLED', 503));
    assert.throws(() => new DypnsapiClient({ ...env(), PHONE_SMS_ENABLED: value }, { fetchImpl }), codeIs('SMS_DISABLED', 503));
  }
  for (const key of ['PHONE_ALIYUN_ACCESS_KEY_ID', 'PHONE_ALIYUN_ACCESS_KEY_SECRET', 'PHONE_SMS_SIGN_NAME', 'PHONE_SMS_TEMPLATE_CODE']) {
    assert.throws(() => new DypnsapiClient({ ...env(), [key]: '' }, { fetchImpl }), codeIs('SMS_CONFIG', 503));
  }
  for (const value of ['0', '10001', '-1', 'NaN', '1.5', true, null]) {
    assert.throws(() => new DypnsapiClient({ ...env(), PHONE_API_TIMEOUT_MS: value }, { fetchImpl }), codeIs('SMS_CONFIG', 503));
  }
  const config = env();
  const client = new DypnsapiClient(config, { fetchImpl });
  config.PHONE_SMS_ENABLED = 'false';
  await assert.rejects(client.send(input), codeIs('SMS_DISABLED', 503));
  await assert.rejects(client.check({ ...input, code: '123456' }), codeIs('SMS_DISABLED', 503));
  config.PHONE_SMS_ENABLED = 'true';
  config.PHONE_SMS_TEMPLATE_CODE = '';
  await assert.rejects(client.send(input), codeIs('SMS_CONFIG', 503));
  assert.equal(requests, 0);
});

test('provider sends documented dynamic OTP parameters and verifies only PASS without exposing payloads', async () => {
  const calls = [];
  const client = new DypnsapiClient({ ...env(), PHONE_ALIYUN_SECURITY_TOKEN: 'token+/=' }, {
    now: () => Date.parse('2026-10-24T01:02:03Z'), nonce: () => 'mock-nonce',
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return success({ Model: { VerifyResult: 'PASS', VerifyCode: '123456', RequestId: 'private' } }); },
  });
  assert.deepEqual(await client.send(input), { accepted: true });
  assert.deepEqual(await client.check({ ...input, code: '123456' }), { verified: true });
  assert.equal(calls.length, 2);
  const send = calls[0];
  assert.equal(send.url.hostname, 'dypnsapi.aliyuncs.com');
  assert.equal(send.init.method, 'POST');
  assert.equal(send.init.redirect, 'manual');
  assert.equal(send.init.body, '');
  assert.equal(send.init.headers['x-acs-version'], '2017-05-25');
  assert.equal(send.init.headers['x-acs-date'], '2026-10-24T01:02:03Z');
  assert.equal(send.init.headers['x-acs-action'], 'SendSmsVerifyCode');
  assert.equal(send.init.headers['x-acs-security-token'], 'token+/=');
  assert.match(send.init.headers.authorization, /;x-acs-security-token;/);
  assert.deepEqual(Object.fromEntries(send.url.searchParams), {
    AutoRetry: '0', CodeLength: '6', CodeType: '1', CountryCode: '86', DuplicatePolicy: '1', Interval: '60',
    OutId: input.outId, PhoneNumber: input.phone, ReturnVerifyCode: 'false', SchemeName: input.scheme,
    SignName: '测试签名', TemplateCode: '100001', TemplateParam: '{"code":"##code##","min":"5"}', ValidTime: '300',
  });
  assert.equal(calls[1].init.headers['x-acs-action'], 'CheckSmsVerifyCode');
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), {
    CountryCode: '86', OutId: input.outId, PhoneNumber: input.phone, SchemeName: input.scheme, VerifyCode: '123456',
  });
  for (const Model of [{ VerifyResult: 'UNKNOWN' }, { VerifyResult: 'pass' }, {}, undefined]) {
    const invalid = new DypnsapiClient(env(), { fetchImpl: async () => success({ Model }) });
    await assert.rejects(invalid.check({ ...input, code: '123456' }), codeIs('CODE_INVALID', 400));
  }
});

test('provider validates all request and header inputs before making any network request', async () => {
  let count = 0;
  const client = new DypnsapiClient(env(), { fetchImpl: async () => { count++; return success(); } });
  for (const phone of [null, 13800138000, '+8613800138000', '12800138000', '1380013800', '138001380000', '13800138000\n', '１３８００１３８０００']) {
    await assert.rejects(client.send({ ...input, phone }), codeIs('INVALID_REQUEST', 400));
  }
  for (const scheme of ['', 'a'.repeat(21), 'scheme\n', null, 123]) {
    await assert.rejects(client.send({ ...input, scheme }), codeIs('INVALID_REQUEST', 400));
  }
  for (const outId of ['', 'a'.repeat(129), 'x&purpose=other', null, 123]) {
    await assert.rejects(client.send({ ...input, outId }), codeIs('INVALID_REQUEST', 400));
  }
  for (const code of ['', '12345', '1234567', 123456, '123456\n', '１２３４５６']) {
    await assert.rejects(client.check({ ...input, code }), codeIs('INVALID_REQUEST', 400));
  }
  for (const key of ['PHONE_ALIYUN_ACCESS_KEY_ID', 'PHONE_SMS_SIGN_NAME', 'PHONE_SMS_TEMPLATE_CODE', 'PHONE_ALIYUN_SECURITY_TOKEN']) {
    assert.throws(() => new DypnsapiClient({ ...env(), [key]: 'unsafe\nvalue' }), codeIs('SMS_CONFIG', 503));
  }
  assert.equal(count, 0);
});

test('HTTP helper limits responses, refuses redirects, and removes raw exceptions', async () => {
  const reply = await requestJson('https://example.invalid/', { method: 'POST' }, { fetchImpl: async () => Response.json({ Success: false, Code: 'denied' }, { status: 403 }) });
  assert.deepEqual(reply, { status: 403, data: { Success: false, Code: 'denied' } });
  for (const fetchImpl of [
    async () => new Response('', { status: 302, headers: { location: 'https://private.invalid/' } }),
    async () => new Response('not json private'),
    async () => Response.json(null),
    async () => Response.json([]),
    async () => new Response(' '.repeat(100), { headers: { 'content-length': '100' } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(100))); controller.close(); } })),
  ]) {
    await assert.rejects(requestJson('https://example.invalid/', {}, { fetchImpl, maxBytes: 32 }), codeIs('UPSTREAM_PROTOCOL', 502));
  }
  await assert.rejects(requestJson('https://example.invalid/', {}, { fetchImpl: async () => { throw new Error('raw private credentials'); } }), codeIs('UPSTREAM_UNAVAILABLE', 503));
  for (const timeoutMs of [0, 10001, -1, NaN, '5', 1.1]) {
    await assert.rejects(requestJson('https://example.invalid/', {}, { timeoutMs }), codeIs('SMS_CONFIG', 503));
  }
});

test('provider classifies whitelisted API codes without parsing provider messages', async () => {
  const groups = [
    ['PROVIDER_RATE_LIMITED', 429, ['BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL', 'biz.FREQUENCY', 'isv.BUSINESS_LIMIT_CONTROL', 'isp.QPS_LIMIT', 'LimitExceeded.SmsCode']],
    ['PROVIDER_AUTH', 503, ['isv.RAM_PERMISSION_DENY', 'isp.RAM_PERMISSION_DENY', 'isv.FORBIDDEN_ACTION']],
    ['PROVIDER_CONFIG', 503, ['MOBILE_NUMBER_ILLEGAL', 'INVALID_PARAMETERS', 'FUNCTION_NOT_OPENED', 'isv.MOBILE_NUMBER_ILLEGAL', 'isv.INVALID_PARAMETERS', 'isv.VERIFY_SCHEME_NOT_EXIST', 'isv.PRODUCT_UNSUBSCRIBE', 'isv.PRODUCT_UN_SUBSCRIPT', 'isv.OUT_OF_SERVICE', 'isv.ACCOUNT_NOT_EXISTS', 'isv.ACCOUNT_ABNORMAL', 'EntityNotExist.SmsTemplateCode', 'EntityNotExist.SmsSignName', 'InvalidParameter.SmsTemplateCode']],
    ['CODE_INVALID', 400, ['isv.ValidateFail']],
    ['PROVIDER_UNAVAILABLE', 503, ['UNKNOWN_NEW_ERROR', 'isp.SYSTEM_ERROR']],
  ];
  for (const [mapped, status, codes] of groups) {
    for (const Code of codes) {
      let calls = 0;
      const client = new DypnsapiClient(env(), { fetchImpl: async () => {
        calls++;
        return Response.json({ Success: false, Code, Message: 'raw private 13800138000 123456', RequestId: 'private' }, { status: 400 });
      } });
      await assert.rejects(client.check({ ...input, code: '123456' }), codeIs(mapped, status));
      assert.equal(calls, 1, 'never retry a provider failure');
    }
  }
  for (const [status, mapped] of [[429, 'PROVIDER_RATE_LIMITED'], [401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [500, 'PROVIDER_UNAVAILABLE']]) {
    const client = new DypnsapiClient(env(), { fetchImpl: async () => Response.json({ Code: 'unknown', Message: 'FREQUENCY_FAIL' }, { status }) });
    await assert.rejects(client.send(input), codeIs(mapped));
  }
  for (const body of [{ Code: 'OK', Success: 'true' }, { Code: 'OK', Success: 1 }, { Success: true }, {}, { Code: 'WRONG', Success: true }]) {
    const client = new DypnsapiClient(env(), { fetchImpl: async () => Response.json(body) });
    await assert.rejects(client.send(input), codeIs('PROVIDER_UNAVAILABLE', 503));
  }
});

test('HTTP total deadline covers a fetch or streamed body that ignores AbortSignal', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })),
  ]) {
    const started = Date.now();
    await assert.rejects(requestJson('https://example.invalid/', {}, { fetchImpl, timeoutMs: 10 }), codeIs('UPSTREAM_TIMEOUT', 504));
    assert.ok(Date.now() - started < 1000);
  }
});

test('ACS3 uses RFC3986 sorting/encoding and authenticates optional STS headers', async () => {
  const args = {
    host: 'dypnsapi.aliyuncs.com', action: 'SendSmsVerifyCode', version: '2017-05-25',
    query: { z: " !'()*~+/?#中文", A: 'first' }, date: '2026-10-24T01:02:03Z', nonce: 'test-nonce',
    accessKeyId: 'test-key-id', accessKeySecret: 'test-key-secret',
  };
  const plain = await signAcs3Request(args);
  const sts = await signAcs3Request({ ...args, securityToken: 'secret+/=' });
  assert.equal(plain.url, 'https://dypnsapi.aliyuncs.com/?A=first&z=%20%21%27%28%29%2A~%2B%2F%3F%23%E4%B8%AD%E6%96%87');
  assert.equal(sts.init.headers['x-acs-security-token'], 'secret+/=');
  assert.match(sts.init.headers.authorization, /;x-acs-security-token;/);
  assert.notEqual(sts.init.headers.authorization.split('Signature=')[1], plain.init.headers.authorization.split('Signature=')[1]);
});

test('public errors never carry arbitrary code/message content', () => {
  for (const value of ['raw private 13800138000', '__proto__', 'constructor', null]) {
    const error = new PhoneAuthError(value, 0);
    assert.equal(error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /raw|private|13800138000/);
  }
});

test('invalid provider calls and signing options fail with fixed errors before fetch', async () => {
  let calls = 0;
  const client = new DypnsapiClient(env(), { fetchImpl: async () => { calls++; return success(); } });
  for (const value of [null, undefined, 'private', 42, [], {}]) {
    await assert.rejects(client.send(value), codeIs('INVALID_REQUEST', 400));
    await assert.rejects(client.check(value), codeIs('INVALID_REQUEST', 400));
  }
  assert.equal(calls, 0);
  assert.equal(client.call, undefined, 'raw provider call cannot bypass the feature gate');
  await assert.rejects(signAcs3Request({}), codeIs('SMS_CONFIG', 503));
});

test('provider classifies documented gateway signing errors as credential failures', async () => {
  for (const Code of ['InvalidAccessKeyId.NotFound', 'SignatureDoesNotMatch', 'InvalidSecurityToken.Expired', 'InvalidTimeStamp.Expired']) {
    const client = new DypnsapiClient(env(), { fetchImpl: async () => Response.json({ Code }, { status: 400 }) });
    await assert.rejects(client.send(input), codeIs('PROVIDER_AUTH', 503));
  }
});

test('provider propagates sanitized transport failures once and hides local signing exceptions', async () => {
  for (const [expected, fetchImpl] of [
    ['UPSTREAM_TIMEOUT', async () => new Promise(() => {})],
    ['UPSTREAM_UNAVAILABLE', async () => { throw new Error('raw private'); }],
    ['UPSTREAM_PROTOCOL', async () => new Response('raw private')],
  ]) {
    let requests = 0;
    const client = new DypnsapiClient({ ...env(), PHONE_API_TIMEOUT_MS: '10' }, { fetchImpl: (...args) => { requests++; return fetchImpl(...args); } });
    await assert.rejects(client.send(input), codeIs(expected));
    assert.equal(requests, 1);
  }
  const client = new DypnsapiClient(env(), { now: () => { throw new Error('raw private'); } });
  await assert.rejects(client.send(input), codeIs('PROVIDER_UNAVAILABLE', 503));
});

test('HTTP cleans up late responses, stream failures and invalid UTF8 without leaking their content', async () => {
  let lateCancelled = false;
  await assert.rejects(requestJson('https://example.invalid/', {}, {
    timeoutMs: 1,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(new ReadableStream({ cancel() { lateCancelled = true; } }));
    },
  }), codeIs('UPSTREAM_TIMEOUT', 504));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lateCancelled, true);
  for (const fetchImpl of [
    async () => new Response(new Uint8Array([0xff])),
    async () => new Response(null, { status: 204 }),
    async () => new Response('{}', { headers: { 'content-length': '-1' } }),
  ]) {
    await assert.rejects(requestJson('https://example.invalid/', {}, { fetchImpl }), codeIs('UPSTREAM_PROTOCOL', 502));
  }
  await assert.rejects(requestJson('https://example.invalid/', {}, {
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('raw private')); } })),
  }), codeIs('UPSTREAM_UNAVAILABLE', 503));
  for (const maxBytes of [0, 1.5, '5', 1048577]) {
    await assert.rejects(requestJson('https://example.invalid/', {}, { maxBytes }), codeIs('SMS_CONFIG', 503));
  }
});

test('signing rejects unencodable query input and header injection with fixed errors', async () => {
  const args = { host: 'dypnsapi.aliyuncs.com', action: 'SendSmsVerifyCode', version: '2017-05-25',
    query: { Value: 'ok' }, date: '2026-10-24T01:02:03Z', nonce: 'test-nonce',
    accessKeyId: 'test-key-id', accessKeySecret: 'test-key-secret' };
  for (const changes of [
    { query: { Value: '\ud800' } }, { securityToken: 'unsafe\r\n' }, { host: 'evil.invalid/path' },
    { nonce: 'unsafe\t' }, { query: { Value: Infinity } }, { accessKeySecret: '' }, { date: 'private' },
  ]) {
    await assert.rejects(signAcs3Request({ ...args, ...changes }), codeIs('SMS_CONFIG', 503));
  }
});
