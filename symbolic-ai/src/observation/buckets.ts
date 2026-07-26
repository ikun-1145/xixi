import type {
  DurationBucket,
  KnowledgeCountBucket,
  ReasonerPathBucket,
} from "./types";

function isAvailableNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

export function bucketDuration(
  durationMs: number | null,
): DurationBucket {
  if (!isAvailableNumber(durationMs)) return "unavailable";
  if (durationMs < 1) return "under-1ms";
  if (durationMs < 5) return "1-5ms";
  if (durationMs < 16) return "5-16ms";
  if (durationMs < 50) return "16-50ms";
  return "over-50ms";
}

export function bucketKnowledgeCount(
  count: number | null,
): KnowledgeCountBucket {
  if (
    !isAvailableNumber(count) ||
    !Number.isSafeInteger(count)
  ) {
    return "unavailable";
  }
  if (count === 0) return "0";
  if (count < 100) return "1-99";
  if (count < 1_000) return "100-999";
  if (count < 5_000) return "1000-4999";
  return "5000-plus";
}

/**
 * Path length is the number of graph edges. `0` means the Reasoner ran but
 * found no answer; `null` means no reliable path measurement was available.
 */
export function bucketReasonerPath(
  pathLength: number | null,
): ReasonerPathBucket {
  if (!isAvailableNumber(pathLength)) return "unavailable";
  if (!Number.isSafeInteger(pathLength)) return "unavailable";
  if (pathLength === 0) return "none";
  if (pathLength === 1) return "direct";
  if (pathLength <= 5) return "2-5";
  if (pathLength <= 20) return "6-20";
  if (pathLength <= 50) return "21-50";
  return "51-plus";
}
