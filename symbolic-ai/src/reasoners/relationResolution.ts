import {
  CoreRelations,
  type ParsedQuery,
  type Relation,
} from "@/types";

export type RelationResolutionMode = "exact" | "fallback";

export interface RelationResolutionEvidence {
  readonly mode: RelationResolutionMode;
  readonly queriedRelation: Relation;
  readonly matchedRelation: Relation;
  readonly policyId: string;
}

export interface RelationResolutionOptions {
  /** Hosts disable fallback for a query completed from conversation context. */
  readonly contextResolved?: boolean;
  /** Semantic negation detection blocks fallback without reparsing raw text. */
  readonly negatedInput?: boolean;
}

export interface RelationFallbackRule {
  readonly queriedRelation: Relation;
  readonly matchedRelation: Relation;
  /**
   * `属于 -> 是` is only a read-compatibility bridge for old records shaped
   * as `subject 是 一种<object>`. It never authorizes a general `是` match.
   */
  readonly legacyClassificationOnly: boolean;
}

export interface RelationResolutionPolicy {
  readonly id: string;
  fallbackFor(
    query: ParsedQuery,
    options?: RelationResolutionOptions,
  ): RelationFallbackRule | null;
}

export const RELATION_RESOLUTION_POLICY_ID =
  "relation-alignment-v1";

const FALLBACK_RULES: readonly RelationFallbackRule[] =
  Object.freeze([
    Object.freeze({
      queriedRelation: CoreRelations.Is,
      matchedRelation: CoreRelations.IsA,
      legacyClassificationOnly: false,
    }),
    Object.freeze({
      queriedRelation: CoreRelations.IsA,
      matchedRelation: CoreRelations.Is,
      legacyClassificationOnly: true,
    }),
  ]);

/**
 * Read-only, deliberately bounded relation alignment.
 *
 * Exact matching is always executed before this policy is consulted.
 * Fallback is limited to complete object-of queries; verify queries,
 * context-completed queries and negated inputs never qualify.
 */
export const relationResolutionPolicy: RelationResolutionPolicy =
  Object.freeze({
    id: RELATION_RESOLUTION_POLICY_ID,
    fallbackFor(
      query: ParsedQuery,
      options: RelationResolutionOptions = {},
    ): RelationFallbackRule | null {
      if (
        query.kind !== "object-of" ||
        query.object !== undefined ||
        options.contextResolved === true ||
        options.negatedInput === true
      ) {
        return null;
      }

      return (
        FALLBACK_RULES.find(
          ({ queriedRelation }) =>
            queriedRelation === query.relation,
        ) ?? null
      );
    },
  });

export function createRelationResolutionEvidence(
  mode: RelationResolutionMode,
  queriedRelation: Relation,
  matchedRelation: Relation,
  policy: RelationResolutionPolicy = relationResolutionPolicy,
): RelationResolutionEvidence {
  return Object.freeze({
    mode,
    queriedRelation,
    matchedRelation,
    policyId: policy.id,
  });
}
