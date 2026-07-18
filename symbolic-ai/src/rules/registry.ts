/**
 * Default active-rules registry.
 *
 * Same Strategy-pattern shape as every other registry in this codebase
 * (`parser/intents/registry.ts`, `personality/registry.ts`): adding a new
 * `InferenceRule` (e.g. capability propagation, later) is one new file +
 * one line here — never a change to `graphReasoner.ts` itself.
 */
import type { InferenceRule } from "@/types";
import { isaTransitivityRule } from "./isaTransitivity";

export const defaultRules: readonly InferenceRule[] = [isaTransitivityRule];
