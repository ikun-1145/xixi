// Preproduction egress is strictly service-bound and fail-closed.
// Never route synthetic tests to real Waffo or the live Supabase project.
const ENDPOINTS = Object.freeze({
  provider: "https://waffo-provider.preprod.invalid/v1/graphql",
  rpc: "https://waffo-rpc.preprod.invalid/rest/v1/rpc/",
});
export function paymentEgress(env, kind, liveUrl) {
  if (env?.WAFFO_PREPROD_ISOLATED !== "true") {
    return { url: liveUrl, fetchImpl: (url, options) => fetch(url, options) };
  }
  if (!Object.hasOwn(ENDPOINTS, kind)) throw new Error("preprod_unknown_egress");
  const binding = kind === "provider" ? env.WAFFO_PREPROD_PROVIDER : env.WAFFO_PREPROD_RPC;
  if (typeof binding?.fetch !== "function") throw new Error("preprod_service_binding_missing");
  const suffix = kind === "rpc" ? String(liveUrl).split("/").at(-1) : "";
  if (kind === "rpc" && !/^[a-z_]{3,80}$/.test(suffix)) throw new Error("preprod_rpc_name_invalid");
  const url = ENDPOINTS[kind] + suffix;
  return { url, fetchImpl: (requestUrl, options) => binding.fetch(requestUrl, options) };
}
