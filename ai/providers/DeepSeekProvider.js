import { AIProvider } from "./AIProvider.js";

/**
 * Thin adapter around the EXISTING DeepSeek request flow. Deliberately does
 * NOT reimplement auth/token-refresh/retry logic -- that stays exactly
 * where it already lives (`apiFetch` in `app.js`), injected in here as
 * `sendRequest` via the constructor rather than imported, for two reasons:
 *   1. Zero circular-import risk (`app.js` will import `registry.js`, which
 *      must therefore never import anything back from `app.js`).
 *   2. This class stays 100% unit-testable with a mock `sendRequest`,
 *      without needing `app.js`'s DOM/login-guard code to run at all.
 *
 * STAGE NOTE: this file is written now (Stage 3.5) but not yet wired into
 * the live send-message flow -- that surgical, minimal-diff swap into
 * `app.js` happens in Stage 3.7. Until then, the SSE-parsing loop below is
 * a second copy of what `app.js`'s current inline send flow already does;
 * Stage 3.7 deletes that inline copy so exactly one copy remains (this
 * one). The auth-sensitive parts (`apiFetch` itself) are never duplicated.
 */
export class DeepSeekProvider extends AIProvider {
  /**
   * @param {{ sendRequest: (body: object) => Promise<Response> }} deps
   *   `sendRequest` must match `app.js`'s existing `apiFetch(body)` shape.
   */
  constructor({ sendRequest }) {
    super();
    this.id = "deepseek";
    this.displayName = "DeepSeek";
    // The Provider layer itself never gates DeepSeek behind Pro -- the
    // EXISTING flash/pro sub-model Pro-check inside app.js's model menu is
    // untouched and keeps working exactly as it does today.
    this.requiresPro = false;
    this._sendRequest = sendRequest;
  }

  async send({ conversation, messages, onDelta, onReasoningDelta }) {
    const model = conversation?.model ?? "deepseek-v4-flash";
    const res = await this._sendRequest({ model, messages, deep: conversation?.deep ?? false });

    if (res && res.status === 429) {
      const err = new Error("rate-limited");
      err.code = "RATE_LIMITED";
      throw err;
    }
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(errText || `DeepSeek 请求失败 (${res.status})`);
      err.code = "HTTP_ERROR";
      err.status = res.status;
      throw err;
    }

    const remainHeader = res.headers.get("x-remain");
    const remaining = remainHeader !== null ? parseInt(remainHeader, 10) : undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let reasoning = "";
    let fullText = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break outer;

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta ?? {};

        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoningDelta?.(reasoning);
        }
        if (delta.content) {
          fullText += delta.content;
          onDelta?.(fullText);
        }
      }
    }

    return { content: fullText, remaining };
  }
}
