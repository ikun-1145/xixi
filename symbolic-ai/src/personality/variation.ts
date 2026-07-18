/**
 * Deterministic phrase variation.
 *
 * A persona shouldn't sound robotic (always the exact same sentence for the
 * same kind of moment), but unit tests must stay reproducible — so instead of
 * `Math.random()`, we pick a variant deterministically from a seed string
 * (e.g. the query's subject+relation). The SAME input always renders the
 * SAME way (testable, explainable), while DIFFERENT inputs get variety.
 */

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Deterministically pick one item from `items`, keyed by `seed`. */
export function pickBySeed<T>(items: readonly T[], seed: string): T {
  if (items.length === 0) {
    throw new Error("pickBySeed: `items` must not be empty");
  }
  const index = hashString(seed) % items.length;
  // Non-null: index is in [0, items.length) and items.length > 0 was checked above.
  return items[index]!;
}
