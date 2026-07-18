/**
 * Unified AI Provider contract.
 *
 * `ai.html` / `app.js` talk ONLY to this shape -- never to DeepSeek's HTTP
 * contract, never to the Sunland Core engine, directly. Adding a brand new
 * provider in the future means: write a new class implementing this
 * contract + register it in `registry.js`. Nothing in the chat page's main
 * logic needs to change.
 *
 * @typedef {{ role: "system"|"user"|"assistant", content: string }} ChatMessage
 *
 * @typedef {{
 *   conversation: import("./conversation.js").Conversation,
 *   messages: ChatMessage[],
 *   onDelta: (textSoFar: string) => void,
 *   onReasoningDelta?: (textSoFar: string) => void,
 *   signal?: AbortSignal,
 * }} SendParams
 *
 * @typedef {{ content: string, remaining?: number }} SendResult
 */

export class AIProvider {
  /** @type {string} stable id, persisted verbatim on `Conversation.provider`. */
  id = "";

  /** @type {string} label shown in the model-picker / locked-model UI. */
  displayName = "";

  /**
   * @type {boolean} whether this provider requires Pro membership just to
   * be usable at all (independent of any sub-model-level Pro gating a
   * provider may still do internally, e.g. DeepSeek's flash/pro toggle).
   * Sunland is always `false` -- free for every regular logged-in user.
   */
  requiresPro = false;

  /**
   * Send one turn and stream the reply back via `onDelta`.
   * @param {SendParams} _params
   * @returns {Promise<SendResult>}
   */
  async send(_params) {
    throw new Error(`AIProvider.send() not implemented for provider "${this.id}"`);
  }
}
