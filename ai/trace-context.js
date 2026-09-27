const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const traceCapableServices = new Set();

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}

export function generateTraceId() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomHex(16);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error("Secure trace ID unavailable");
}

export function generateSpanId() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomHex(8);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error("Secure span ID unavailable");
}

export function parseTraceparent(value) {
  const match = typeof value === "string" ? TRACEPARENT.exec(value) : null;
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

export function validateTraceparent(value) {
  return parseTraceparent(value) !== null;
}

export function createTraceparent(traceId, spanId, flags = "01") {
  if (!TRACE_ID.test(traceId) || /^0+$/.test(traceId) ||
      !SPAN_ID.test(spanId) || /^0+$/.test(spanId) || !/^[0-9a-f]{2}$/.test(flags)) return null;
  return `00-${traceId}-${spanId}-${flags}`;
}

export function createTraceContext() {
  try {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    return { traceId, spanId, traceparent: createTraceparent(traceId, spanId) };
  } catch {
    // Tracing must never prevent an AI request when secure randomness is unavailable.
    return null;
  }
}

export function responseTraceId(response, fallback = null) {
  const id = response?.headers?.get?.("X-Sunland-Trace-Id");
  return typeof id === "string" && TRACE_ID.test(id) && !/^0+$/.test(id)
    ? id
    : fallback;
}

// A newly published browser may run ahead of the API/Edge release. Sending a
// custom header before the server allows it causes the browser to block the
// request at CORS preflight. Learn support from an exposed response header;
// the first request still receives a server-generated trace ID after rollout.
export function traceparentFor(service, context) {
  return traceCapableServices.has(service) ? context?.traceparent ?? null : null;
}

export function observeTraceResponse(service, response, fallback = null) {
  const serverId = responseTraceId(response);
  if (serverId) traceCapableServices.add(service);
  return serverId ?? (traceCapableServices.has(service) ? fallback : null);
}
