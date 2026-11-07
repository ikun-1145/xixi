import { PhoneAuthError } from './errors.js';

export async function requestJson(url, init, { fetchImpl = (url, init) => globalThis.fetch(url, init), timeoutMs = 5000, maxBytes = 16384 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 ||
      typeof fetchImpl !== 'function' || (init?.method && init.method !== 'POST')) {
    throw new PhoneAuthError('SMS_CONFIG', 503);
  }
  const controller = new AbortController();
  let reader;
  let finished = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PhoneAuthError('UPSTREAM_TIMEOUT', 504));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      const response = await fetchImpl(url, { ...init, method: 'POST', redirect: 'manual', signal: controller.signal });
      if (controller.signal.aborted) {
        response.body?.cancel().catch(() => {});
        throw new PhoneAuthError('UPSTREAM_TIMEOUT', 504);
      }
      if (response.status < 200 || response.status >= 600 || (response.status >= 300 && response.status < 400)) {
        response.body?.cancel().catch(() => {});
        throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        response.body?.cancel().catch(() => {});
        throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
      }
      if (!response.body) throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
        chunks.push(value);
      }
      finished = true;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let data;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PhoneAuthError('UPSTREAM_PROTOCOL', 502);
      return { status: response.status, data };
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw new PhoneAuthError('UPSTREAM_TIMEOUT', 504);
    if (error instanceof PhoneAuthError) throw error;
    throw new PhoneAuthError('UPSTREAM_UNAVAILABLE', 503);
  } finally {
    clearTimeout(timer);
    if (reader) {
      if (!finished) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
