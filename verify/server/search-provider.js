import { VERIFY_LIMITS } from "./constants.js";
import { VerifyError } from "./errors.js";
import { cleanText } from "./json-utils.js";

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    return url;
  } catch {
    return null;
  }
}

export function isPublicHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host === "0.0.0.0" || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/u.test(host)) return false;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part))) {
    const octets = parts.map(Number);
    if (octets.some(octet => octet > 255)) return false;
    if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) return false;
    if (octets[0] === 169 && octets[1] === 254) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
  }
  return true;
}

export function canonicalizeUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function normalizeSearchResult(value) {
  const url = canonicalizeUrl(value?.url);
  const title = cleanText(value?.title, 300);
  if (!url || !title || !isPublicHostname(new URL(url).hostname)) return null;
  const publishedAt = cleanText(value?.publishedAt, 80);
  return {
    title,
    url,
    snippet: cleanText(value?.snippet, 1_200),
    ...(publishedAt ? { publishedAt } : {}),
    source: cleanText(value?.source, 160) || new URL(url).hostname.replace(/^www\./, ""),
    ...(value?.sourceEvaluation ? { sourceEvaluation: value.sourceEvaluation } : {}),
  };
}

function searchHttpError(status, providerLabel) {
  if (status === 401) {
    return new VerifyError("SEARCH_AUTH_ERROR", `${providerLabel} 搜索认证失败。`, 503);
  }
  if (status === 403) {
    return new VerifyError("SEARCH_FORBIDDEN", `${providerLabel} 搜索访问被拒绝。`, 503);
  }
  if (status === 429) {
    return new VerifyError("SEARCH_RATE_LIMITED", `${providerLabel} 搜索额度或请求频率受限。`, 503);
  }
  if (status >= 500) {
    return new VerifyError("SEARCH_PROVIDER_ERROR", `${providerLabel} 搜索服务暂时不可用。`, 502);
  }
  return new VerifyError("SEARCH_PROVIDER_ERROR", `${providerLabel} 搜索请求被拒绝（${status}）。`, 502);
}

async function fetchJsonWithTimeout(url, init, fetchImpl, timeoutMs, providerLabel = "联网") {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new VerifyError("SEARCH_TIMEOUT", "联网搜索超时。", 504);
    }
    throw new VerifyError("SEARCH_PROVIDER_ERROR", "联网搜索服务请求失败。", 502);
  }
  if (!response.ok) throw searchHttpError(response.status, providerLabel);
  try {
    return await response.json();
  } catch {
    throw new VerifyError("SEARCH_RESPONSE_INVALID", `${providerLabel} 搜索返回了无效响应。`, 502);
  }
}

export class TavilySearchProvider {
  constructor(apiKey, fetchImpl = fetch) {
    this.name = "tavily";
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, options = {}) {
    const limit = Math.max(1, Math.min(
      Number(options.limit) || VERIFY_LIMITS.maxResultsPerQuery,
      VERIFY_LIMITS.maxResultsPerQuery,
    ));
    const payload = await fetchJsonWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: cleanText(query, 180),
        search_depth: "advanced",
        chunks_per_source: 2,
        max_results: limit,
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        auto_parameters: false,
      }),
    }, this.fetchImpl, options.timeoutMs || VERIFY_LIMITS.searchTimeoutMs, "Tavily");

    return (Array.isArray(payload?.results) ? payload.results : [])
      .map((item) => normalizeSearchResult({
        title: item?.title,
        url: item?.url,
        snippet: item?.content ?? item?.snippet,
        publishedAt: item?.published_date ?? item?.publishedDate,
        source: item?.source,
      }))
      .filter(Boolean)
      .slice(0, limit);
  }
}

export class BraveSearchProvider {
  constructor(apiKey, fetchImpl = fetch) {
    this.name = "brave";
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, options = {}) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", cleanText(query, 180));
    url.searchParams.set("count", String(Math.min(options.limit || 5, 10)));
    url.searchParams.set("safesearch", "moderate");
    const payload = await fetchJsonWithTimeout(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey,
      },
    }, this.fetchImpl, options.timeoutMs || VERIFY_LIMITS.searchTimeoutMs, "Brave");

    return (payload?.web?.results || [])
      .map((item) => normalizeSearchResult({
        title: item?.title,
        url: item?.url,
        snippet: item?.description ?? item?.extra_snippets?.join(" "),
        publishedAt: item?.page_age,
        source: item?.profile?.long_name,
      }))
      .filter(Boolean)
      .slice(0, options.limit || 5);
  }
}

export class SearxngSearchProvider {
  constructor(baseUrl, apiKey = "", fetchImpl = fetch) {
    const parsed = safeHttpUrl(baseUrl);
    if (!parsed || (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw new VerifyError("SEARCH_CONFIG_INVALID", "SEARXNG_BASE_URL 必须是 HTTPS 地址。", 503);
    }
    this.name = "searxng";
    this.baseUrl = parsed;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, options = {}) {
    const url = new URL(this.baseUrl.toString());
    url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
    url.searchParams.set("q", cleanText(query, 180));
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    const headers = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const payload = await fetchJsonWithTimeout(url, { headers }, this.fetchImpl,
      options.timeoutMs || VERIFY_LIMITS.searchTimeoutMs, "SearXNG");

    return (payload?.results || [])
      .map((item) => normalizeSearchResult({
        title: item?.title,
        url: item?.url,
        snippet: item?.content,
        publishedAt: item?.publishedDate,
        source: item?.engine,
      }))
      .filter(Boolean)
      .slice(0, options.limit || 5);
  }
}

export class FallbackSearchProvider {
  constructor(providers) {
    this.providers = providers;
    this.name = providers[0]?.name || "unknown";
  }

  async search(query, options = {}) {
    let primaryError;
    for (const provider of this.providers) {
      try {
        return await provider.search(query, options);
      } catch (error) {
        primaryError ||= error;
      }
    }
    if (primaryError instanceof VerifyError) throw primaryError;
    throw new VerifyError("SEARCH_PROVIDER_ERROR", "联网搜索服务请求失败。", 502);
  }
}

function createConfiguredProvider(name, env, fetchImpl) {
  if (name === "tavily" && env.TAVILY_API_KEY) {
    return new TavilySearchProvider(env.TAVILY_API_KEY, fetchImpl);
  }
  if (name === "brave" && env.BRAVE_SEARCH_API_KEY) {
    return new BraveSearchProvider(env.BRAVE_SEARCH_API_KEY, fetchImpl);
  }
  if (name === "searxng" && env.SEARXNG_BASE_URL) {
    return new SearxngSearchProvider(env.SEARXNG_BASE_URL, env.SEARXNG_API_KEY, fetchImpl);
  }
  return null;
}

export function createSearchProvider(env = {}, fetchImpl = fetch) {
  const preferred = cleanText(env.SEARCH_PROVIDER, 32).toLowerCase();
  if (preferred && !["tavily", "brave", "searxng"].includes(preferred)) {
    throw new VerifyError("SEARCH_CONFIG_INVALID", "SEARCH_PROVIDER 配置无效。", 503);
  }
  if (preferred) {
    const provider = createConfiguredProvider(preferred, env, fetchImpl);
    if (provider) return provider;
  } else {
    const providers = ["tavily", "brave", "searxng"]
      .map((name) => createConfiguredProvider(name, env, fetchImpl))
      .filter(Boolean);
    if (providers.length === 1) return providers[0];
    if (providers.length > 1) return new FallbackSearchProvider(providers);
  }
  throw new VerifyError(
    "SEARCH_UNAVAILABLE",
    "联网搜索暂不可用：搜索服务尚未配置。",
    503,
    { required: ["TAVILY_API_KEY", "或 BRAVE_SEARCH_API_KEY", "或 SEARXNG_BASE_URL"] },
  );
}

export function deduplicateResults(results) {
  const seen = new Set();
  const unique = [];
  let duplicatesRemoved = 0;
  for (const item of results) {
    const normalized = normalizeSearchResult(item);
    if (!normalized) continue;
    const key = normalized.url.toLocaleLowerCase();
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return { results: unique, duplicatesRemoved };
}
