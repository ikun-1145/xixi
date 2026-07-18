import { DeepSeekProvider } from "./DeepSeekProvider.js";
import { SunlandProvider } from "./SunlandProvider.js";

/**
 * Build the Provider registry for one page session.
 *
 * A FACTORY (not a module-level singleton) so `app.js` can construct it
 * AFTER `apiFetch` is defined and pass it in explicitly -- this file never
 * imports anything from `app.js`, so there is no circular-import risk
 * however this eventually gets wired up in Stage 3.7.
 *
 * Adding a third provider in the future = one new class + one new line in
 * the `Map` below. Nothing calling `getProvider()` ever needs to change.
 *
 * @param {{ sendRequest: (body: object) => Promise<Response> }} deps
 *   `sendRequest` is `app.js`'s existing `apiFetch`, injected.
 */
export function createProviderRegistry({ sendRequest }) {
  const providers = new Map([
    ["deepseek", new DeepSeekProvider({ sendRequest })],
    ["sunland", new SunlandProvider()],
  ]);

  return {
    /** Resolve a provider by id; falls back to "deepseek" for old/unknown ids. */
    get(id) {
      return providers.get(id) ?? providers.get("deepseek");
    },
    /** Every registered provider, e.g. for rendering the new-chat picker. */
    list() {
      return Array.from(providers.values());
    },
  };
}
