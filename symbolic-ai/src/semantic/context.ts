import type {
  IntentName,
  ParseResult,
  QueryKind,
} from "@/types";
import type {
  SemanticCandidate,
  SemanticContext,
  SemanticContextEntityKind,
  SemanticContextEntityReference,
  SemanticContextQueryShape,
  SemanticContextUpdate,
  SemanticTurnSummary,
  UnderstandingDecision,
} from "./types";

export type SemanticContextMode = "off" | "enabled";

export const SEMANTIC_CONTEXT_LIMITS = Object.freeze({
  maximumTurns: 6,
  maximumConceptsPerTurn: 8,
  maximumEntitiesPerTurn: 4,
  maximumEntityValueLength: 80,
  maximumRelationLength: 48,
  maximumTurnIdLength: 128,
});

const INTENT_NAMES: ReadonlySet<IntentName> = new Set([
  "Greeting",
  "Thanks",
  "Farewell",
  "Identity",
  "RememberName",
  "RecallName",
]);

const QUERY_KINDS: ReadonlySet<QueryKind> = new Set([
  "object-of",
  "verify",
  "locate",
]);

const ENTITY_KINDS: ReadonlySet<SemanticContextEntityKind> = new Set([
  "subject",
  "object",
  "self",
]);

const CONTEXT_PRONOUNS = new Set([
  "它",
  "这个",
  "那个",
  "这",
  "那",
]);

const CONTEXT_SELF_REFERENCES = new Set([
  "你",
  "sunland ai",
  "sunland ai · beta",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength
  ) {
    return null;
  }
  return normalized;
}

export function isSemanticContextPronoun(value: string): boolean {
  return CONTEXT_PRONOUNS.has(
    value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und"),
  );
}

export function isSemanticSelfReference(value: string): boolean {
  return CONTEXT_SELF_REFERENCES.has(
    value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und"),
  );
}

function contextEntity(
  value: unknown,
): SemanticContextEntityReference | null {
  if (
    !isRecord(value) ||
    !ENTITY_KINDS.has(value.kind as SemanticContextEntityKind)
  ) {
    return null;
  }
  const entityValue = boundedText(
    value.value,
    SEMANTIC_CONTEXT_LIMITS.maximumEntityValueLength,
  );
  if (entityValue === null) return null;

  return Object.freeze({
    kind: value.kind as SemanticContextEntityKind,
    value: entityValue,
  });
}

function queryShape(value: unknown): SemanticContextQueryShape | undefined {
  if (!isRecord(value) || !QUERY_KINDS.has(value.kind as QueryKind)) {
    return undefined;
  }
  const relation = boundedText(
    value.relation,
    SEMANTIC_CONTEXT_LIMITS.maximumRelationLength,
  );
  if (relation === null || typeof value.hasObject !== "boolean") {
    return undefined;
  }

  return Object.freeze({
    kind: value.kind as QueryKind,
    relation,
    hasObject: value.hasObject,
  });
}

function turnSummary(value: unknown): SemanticTurnSummary | null {
  if (
    !isRecord(value) ||
    (value.speaker !== "user" && value.speaker !== "assistant")
  ) {
    return null;
  }
  const turnId = boundedText(
    value.turnId,
    SEMANTIC_CONTEXT_LIMITS.maximumTurnIdLength,
  );
  if (turnId === null) return null;

  const acceptedIntent =
    typeof value.acceptedIntent === "string" &&
    INTENT_NAMES.has(value.acceptedIntent as IntentName)
      ? (value.acceptedIntent as IntentName)
      : undefined;
  const concepts = Object.freeze(
    (Array.isArray(value.concepts) ? value.concepts : [])
      .map((concept) =>
        boundedText(
          concept,
          SEMANTIC_CONTEXT_LIMITS.maximumEntityValueLength,
        ),
      )
      .filter((concept): concept is string => concept !== null)
      .slice(0, SEMANTIC_CONTEXT_LIMITS.maximumConceptsPerTurn),
  );
  const entityReferences = Object.freeze(
    (Array.isArray(value.entityReferences)
      ? value.entityReferences
      : [])
      .map(contextEntity)
      .filter(
        (
          entity,
        ): entity is SemanticContextEntityReference => entity !== null,
      )
      .slice(0, SEMANTIC_CONTEXT_LIMITS.maximumEntitiesPerTurn),
  );
  const focusEntity = contextEntity(value.focusEntity);
  const relation = boundedText(
    value.relation,
    SEMANTIC_CONTEXT_LIMITS.maximumRelationLength,
  );
  const shape = queryShape(value.queryShape);

  return Object.freeze({
    turnId,
    speaker: value.speaker,
    ...(acceptedIntent === undefined ? {} : { acceptedIntent }),
    concepts,
    entityReferences,
    ...(focusEntity === null ? {} : { focusEntity }),
    ...(relation === null ? {} : { relation }),
    ...(shape === undefined ? {} : { queryShape: shape }),
  });
}

export function createEmptySemanticContext(): SemanticContext {
  return Object.freeze({
    schemaVersion: 1,
    version: 0,
    recentTurns: Object.freeze([]),
  });
}

/**
 * Fail-closed, record-by-record normalization for host-restored context.
 * Missing or damaged context becomes empty; malformed turns are discarded
 * without affecting valid neighbors.
 */
export function normalizeSemanticContext(value: unknown): SemanticContext {
  if (!isRecord(value)) return createEmptySemanticContext();

  const version =
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version >= 0
      ? value.version
      : 0;
  const recentTurns = Object.freeze(
    (Array.isArray(value.recentTurns) ? value.recentTurns : [])
      .map(turnSummary)
      .filter((turn): turn is SemanticTurnSummary => turn !== null)
      .slice(-SEMANTIC_CONTEXT_LIMITS.maximumTurns),
  );

  return Object.freeze({
    schemaVersion: 1,
    version,
    recentTurns,
  });
}

function entityReference(
  kind: SemanticContextEntityKind,
  value: string,
): SemanticContextEntityReference {
  return Object.freeze({ kind, value: value.trim().replace(/\s+/gu, " ") });
}

function isSelfSubject(value: string): boolean {
  return isSemanticSelfReference(value);
}

function conceptsForAcceptedDecision(
  decision: Extract<UnderstandingDecision, { readonly kind: "accept" }>,
): readonly string[] {
  const candidates: readonly SemanticCandidate[] = [
    decision.selectedCandidate,
    ...decision.secondaryCandidates,
  ];
  return Object.freeze(
    [...new Set(candidates.flatMap(({ concepts }) => concepts.map(({ id }) => id)))]
      .sort()
      .slice(0, SEMANTIC_CONTEXT_LIMITS.maximumConceptsPerTurn),
  );
}

function summaryForResult(
  turnId: string,
  result: ParseResult,
  decision: Extract<UnderstandingDecision, { readonly kind: "accept" }>,
): SemanticTurnSummary | null {
  const concepts = conceptsForAcceptedDecision(decision);

  switch (result.type) {
    case "query": {
      const subject = entityReference(
        isSelfSubject(result.subject) ? "self" : "subject",
        isSelfSubject(result.subject) ? "Sunland AI · Beta" : result.subject,
      );
      return Object.freeze({
        turnId,
        speaker: "user",
        concepts,
        entityReferences: Object.freeze([subject]),
        focusEntity: subject,
        relation: result.relation,
        queryShape: Object.freeze({
          kind: result.kind,
          relation: result.relation,
          hasObject: result.object !== undefined,
        }),
      });
    }
    case "statement": {
      const subject = entityReference("subject", result.subject);
      return Object.freeze({
        turnId,
        speaker: "user",
        concepts,
        entityReferences: Object.freeze([subject]),
        focusEntity: subject,
        relation: result.relation,
      });
    }
    case "intent": {
      if (result.intent === "Identity") {
        const self = entityReference("self", "Sunland AI · Beta");
        return Object.freeze({
          turnId,
          speaker: "user",
          acceptedIntent: result.intent,
          concepts,
          entityReferences: Object.freeze([self]),
          focusEntity: self,
          relation: result.entities[1] === "capability" ? "会" : "是",
        });
      }
      if (result.intent === "RememberName") {
        return Object.freeze({
          turnId,
          speaker: "user",
          acceptedIntent: result.intent,
          concepts,
          entityReferences: Object.freeze([]),
        });
      }
      return null;
    }
    case "unknown":
      return null;
  }
}

export interface CreateSemanticContextUpdateOptions {
  readonly context: SemanticContext;
  readonly decision: UnderstandingDecision;
  readonly executedResult: ParseResult | null;
  readonly turnId: string;
  readonly executionSucceeded: boolean;
  readonly canCommit: boolean;
}

/**
 * Produces an optimistic update only after an accepted interpretation has
 * actually completed. It never applies or persists the update itself.
 */
export function createSemanticContextUpdate(
  options: CreateSemanticContextUpdateOptions,
): SemanticContextUpdate {
  const context = normalizeSemanticContext(options.context);
  if (
    !options.canCommit ||
    !options.executionSucceeded ||
    options.decision.kind !== "accept" ||
    options.executedResult === null
  ) {
    return Object.freeze({
      kind: "none",
      baseVersion: context.version,
    });
  }

  const turnId = boundedText(
    options.turnId,
    SEMANTIC_CONTEXT_LIMITS.maximumTurnIdLength,
  );
  if (turnId === null) {
    return Object.freeze({
      kind: "none",
      baseVersion: context.version,
    });
  }
  const summary = summaryForResult(
    turnId,
    options.executedResult,
    options.decision,
  );
  if (summary === null) {
    return Object.freeze({
      kind: "none",
      baseVersion: context.version,
    });
  }

  const nextVersion = context.version + 1;
  const nextContext = Object.freeze({
    schemaVersion: 1 as const,
    version: nextVersion,
    recentTurns: Object.freeze(
      [...context.recentTurns, summary].slice(
        -SEMANTIC_CONTEXT_LIMITS.maximumTurns,
      ),
    ),
  });

  return Object.freeze({
    kind: "replace",
    baseVersion: context.version,
    nextVersion,
    context: nextContext,
  });
}

/**
 * Applies an update only to the exact snapshot it was produced from. A late
 * response therefore cannot overwrite a newer conversation context.
 */
export function applySemanticContextUpdate(
  currentValue: unknown,
  update: SemanticContextUpdate,
): SemanticContext {
  const current = normalizeSemanticContext(currentValue);
  if (
    update.kind !== "replace" ||
    update.baseVersion !== current.version ||
    update.nextVersion !== update.baseVersion + 1 ||
    update.context.version !== update.nextVersion
  ) {
    return current;
  }
  return normalizeSemanticContext(update.context);
}
