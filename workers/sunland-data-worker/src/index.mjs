const UPSTREAM_URL = "https://furrycons.furfantasia.dpdns.org/event-data";
const DETAIL_BASE_URL = "https://www.furryfusion.net";
const REQUEST_TIMEOUT_MS = 15_000;

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
});

function cleanText(value, maxLength = 4096) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function validHttpUrl(value) {
  const text = cleanText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  const text = cleanText(value, 10);
  const match = text?.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`;
}

function normalizeTimestamp(value, fallback) {
  const text = cleanText(value, 128);
  if (!text || Number.isNaN(Date.parse(text))) return fallback;
  return new Date(text).toISOString();
}

function splitAddress(value) {
  const address = cleanText(value, 240);
  if (!address) return { address: null, province: null, city: null };
  const parts = address.split("·").map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return { address, province: null, city: address };
  }
  return {
    address,
    province: parts[0],
    city: parts.slice(1).join("·"),
  };
}

function resolveSourceUrl(path, matchedEvent) {
  const sourcePath = cleanText(path, 2048);
  if (sourcePath) {
    try {
      const url = new URL(sourcePath, DETAIL_BASE_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { sourcePath, sourceUrl: null, error: "INVALID_SOURCE_PATH" };
      }
      return { sourcePath, sourceUrl: url.href, error: null };
    } catch {
      return { sourcePath, sourceUrl: null, error: "INVALID_SOURCE_PATH" };
    }
  }
  return {
    sourcePath: null,
    sourceUrl: validHttpUrl(matchedEvent?.cnUrl)
      ?? validHttpUrl(matchedEvent?.globalUrl),
    error: null,
  };
}

function eventError(sourceId, index, reason) {
  return { source_id: sourceId, index, reason };
}

export function normalizeEvent(raw, index, updatedAt) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { event: null, rejected: eventError(null, index, "EVENT_NOT_OBJECT") };
  }

  if (typeof raw.id !== "string" && typeof raw.id !== "number") {
    return { event: null, rejected: eventError(null, index, "MISSING_SOURCE_ID") };
  }
  const sourceId = cleanText(String(raw.id), 200);
  if (!sourceId) {
    return { event: null, rejected: eventError(null, index, "MISSING_SOURCE_ID") };
  }
  const name = cleanText(raw.name, 200);
  if (!name) {
    return { event: null, rejected: eventError(sourceId, index, "MISSING_NAME") };
  }
  const startAt = normalizeDate(raw.time_start);
  if (!startAt) {
    return { event: null, rejected: eventError(sourceId, index, "INVALID_START_DATE") };
  }
  const endAt = normalizeDate(raw.time_end);
  if (!endAt) {
    return { event: null, rejected: eventError(sourceId, index, "INVALID_END_DATE") };
  }
  if (Date.parse(endAt) < Date.parse(startAt)) {
    return { event: null, rejected: eventError(sourceId, index, "END_BEFORE_START") };
  }

  const matchedEvent = raw.matchedEvent;
  if (matchedEvent != null && (
    typeof matchedEvent !== "object" || Array.isArray(matchedEvent)
  )) {
    return { event: null, rejected: eventError(sourceId, index, "INVALID_MATCHED_EVENT") };
  }

  const address = splitAddress(raw.address);
  if (raw.path != null && typeof raw.path !== "string") {
    return { event: null, rejected: eventError(sourceId, index, "INVALID_SOURCE_PATH") };
  }
  const resolvedSource = resolveSourceUrl(raw.path, matchedEvent);
  if (resolvedSource.error) {
    return { event: null, rejected: eventError(sourceId, index, resolvedSource.error) };
  }
  if (raw.state != null && !Number.isInteger(raw.state)) {
    return { event: null, rejected: eventError(sourceId, index, "INVALID_STATE") };
  }
  const sourceState = raw.state ?? null;

  return {
    rejected: null,
    event: {
      source_id: sourceId,
      name,
      full_name: cleanText(raw.fullName, 300) ?? name,
      start_at: startAt,
      end_at: endAt,
      province: address.province,
      city: address.city,
      address: address.address,
      venue: cleanText(matchedEvent?.address, 300),
      cover: validHttpUrl(raw.image) ?? validHttpUrl(matchedEvent?.coverUrl),
      status: sourceState === 1 ? "preview" : sourceState === 2 ? "confirmed" : null,
      source_state: sourceState,
      source_state_text: cleanText(raw.stateText, 120),
      source_url: resolvedSource.sourceUrl,
      source_path: resolvedSource.sourcePath,
      detail: cleanText(matchedEvent?.detail, 20_000),
      organization: cleanText(matchedEvent?.organization?.name, 300)
        ?? cleanText(raw.title, 300),
      updated_at: updatedAt,
    },
  };
}

export class UpstreamContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "UpstreamContractError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeSnapshot(payload, fetchedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Upstream response must be an object",
    );
  }
  if (payload.success !== true) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Upstream success must be true",
    );
  }
  if (!Array.isArray(payload.data)) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Upstream data must be an array",
    );
  }
  if (!Number.isInteger(payload.total) || payload.total < 0) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Upstream total must be a non-negative integer",
    );
  }
  if (payload.data.length !== payload.total) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Upstream total does not match data length",
      { total: payload.total, data_length: payload.data.length },
    );
  }

  const fallbackTimestamp = normalizeTimestamp(fetchedAt, new Date().toISOString());
  const updatedAt = normalizeTimestamp(payload.lastUpdated, fallbackTimestamp);
  const normalized = payload.data.map((raw, index) => normalizeEvent(raw, index, updatedAt));
  const rejected = normalized.filter(item => item.rejected).map(item => item.rejected);
  if (rejected.length) {
    throw new UpstreamContractError(
      "UPSTREAM_EVENT_INVALID",
      "One or more upstream events could not be normalized",
      { total: payload.total, rejected },
    );
  }

  const events = normalized.map(item => item.event);
  const seen = new Map();
  const duplicates = [];
  events.forEach((event, index) => {
    const key = `${event.name}\u0000${event.start_at}`;
    const previous = seen.get(key);
    if (previous == null) {
      seen.set(key, index);
    } else {
      duplicates.push({
        name: event.name,
        start_at: event.start_at,
        indexes: [previous, index],
      });
    }
  });
  if (duplicates.length) {
    throw new UpstreamContractError(
      "UPSTREAM_DUPLICATE_EVENT",
      "Upstream contains duplicate (name, start_at) keys",
      { total: payload.total, duplicates },
    );
  }
  if (events.length !== payload.total) {
    throw new UpstreamContractError(
      "UPSTREAM_SCHEMA_INVALID",
      "Normalized event count does not match upstream total",
      { total: payload.total, events_length: events.length },
    );
  }
  return { events };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function handleRequest(request, fetchImpl = fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonResponse({
      error: "METHOD_NOT_ALLOWED",
      message: "Only GET and OPTIONS are supported",
      details: {},
    }, 405);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(UPSTREAM_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return jsonResponse({
        error: "UPSTREAM_REQUEST_FAILED",
        message: `Upstream returned HTTP ${response.status}`,
        details: { status: response.status },
      }, 502);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return jsonResponse({
        error: "UPSTREAM_SCHEMA_INVALID",
        message: "Upstream response is not valid JSON",
        details: {},
      }, 502);
    }
    return jsonResponse(normalizeSnapshot(payload, new Date().toISOString()));
  } catch (error) {
    if (error instanceof UpstreamContractError) {
      console.error(JSON.stringify({
        level: "error",
        code: error.code,
        message: error.message,
        details: error.details,
      }));
      return jsonResponse({
        error: error.code,
        message: error.message,
        details: error.details,
      }, 502);
    }
    console.error(JSON.stringify({
      level: "error",
      code: "UPSTREAM_REQUEST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }));
    return jsonResponse({
      error: "UPSTREAM_REQUEST_FAILED",
      message: "Unable to fetch upstream event data",
      details: {},
    }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
