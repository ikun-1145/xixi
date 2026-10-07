// Shared proof contract reference. Runtime validation lives in the Worker normalizer.
import { normalizeAndValidateProviderOrder } from '../worker.js';

export const MERCHANDISE = Object.freeze({
  planId: '16b23966c0a711f183dc5254001e7c00',
  skuId: '16b98478c0a711f1bb735254001e7c00',
  amountCents: 1500,
});

export function canonicalAfdianProof(raw) {
  return normalizeAndValidateProviderOrder(raw);
}
