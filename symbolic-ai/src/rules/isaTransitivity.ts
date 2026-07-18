/**
 * isA (属于 / subclass-of) transitivity — Sunland AI's first real inference
 * rule (Stage 6 — Knowledge Graph v1).
 *
 * If A 属于 B and B 属于 C, then A 属于 C — and this chains through any
 * number of hops (A 属于 B 属于 C 属于 D ⇒ A 属于 D, etc.). This is the
 * ONLY inference rule implemented at this stage, per the user's explicit
 * scope: "第一阶段只支持 isA... 不要急于支持几十种 Relation。" Every other
 * relation (会/喜欢/在/是) is still answered by direct fact lookup only —
 * this rule never looks at anything except un-negated `CoreRelations.IsA`
 * ("属于") edges.
 *
 * Design-decision flag: "isA" in the user's spec is mapped onto the
 * pre-existing `CoreRelations.IsA` ("属于"), documented since Stage 1 as
 * "Inheritance / subclass-of" — semantically exactly "isA" in the
 * knowledge-representation sense. `CoreRelations.Is` ("是") is documented as
 * "Identity / instance-of" instead (e.g. "苏格拉底 是 人") and is
 * deliberately NOT made transitive here — a judgment call, not an
 * oversight, kept consistent with the types already established before this
 * stage began.
 *
 * Deliberately excludes negated edges ("A 不属于 B" is a denial, not a
 * subclass relationship to chain through) and deliberately guards against
 * cycles (a malformed or adversarial graph like A属于B, B属于A must not hang
 * or infinite-loop) via a per-path `visited` set.
 *
 * Pure and side-effect-free per the `InferenceRule` contract: reads
 * `known: KnowledgeQuery` only, never mutates a store.
 */
import type { Inference, InferenceRule, KnowledgeQuery, KnowledgeRecord, ReasoningStep, Triple } from "@/types";
import { CoreRelations } from "@/types";

const RULE_ID = "isa-transitivity";

interface PathState {
  readonly node: string;
  readonly path: readonly string[];
  readonly records: readonly KnowledgeRecord[];
}

/** Build the adjacency list of un-negated 属于 edges: subject -> outgoing edges. */
function buildAdjacency(known: KnowledgeQuery): Map<string, KnowledgeRecord[]> {
  const edges = known.match({ relation: CoreRelations.IsA, negated: false });
  const adjacency = new Map<string, KnowledgeRecord[]>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.subject) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.subject, outgoing);
  }
  return adjacency;
}

/**
 * Turns a chain of edges (A属于B, B属于C, ...) into the iterative derivation
 * `ReasoningStep`s the `ReasoningStep` doc comment illustrates: each step
 * combines the conclusion accumulated so far with the next edge, e.g. for
 * 猫→动物→生物: one step, "猫 属于 动物，动物 属于 生物 ⇒ 猫 属于 生物".
 */
function buildSteps(records: readonly KnowledgeRecord[]): readonly ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  let accumulated: Triple = {
    subject: records[0]!.subject,
    relation: CoreRelations.IsA,
    object: records[0]!.object,
    negated: false,
  };

  for (let i = 1; i < records.length; i += 1) {
    const edge = records[i]!;
    const conclusion: Triple = {
      subject: accumulated.subject,
      relation: CoreRelations.IsA,
      object: edge.object,
      negated: false,
    };
    steps.push({
      ruleId: RULE_ID,
      description:
        `${accumulated.subject} 属于 ${accumulated.object}，` +
        `${edge.subject} 属于 ${edge.object} ⇒ ${conclusion.subject} 属于 ${conclusion.object}`,
      premises: [accumulated, { subject: edge.subject, relation: CoreRelations.IsA, object: edge.object, negated: false }],
      conclusion,
    });
    accumulated = conclusion;
  }

  return steps;
}

function buildInference(records: readonly KnowledgeRecord[]): Inference {
  const subject = records[0]!.subject;
  const object = records[records.length - 1]!.object;
  const path = [subject, ...records.map((record) => record.object)];
  const confidence = records.reduce((product, record) => product * record.confidence, 1);

  return {
    conclusion: { subject, relation: CoreRelations.IsA, object, negated: false },
    confidence,
    steps: buildSteps(records),
    path,
  };
}

export const isaTransitivityRule: InferenceRule = {
  id: RULE_ID,
  name: "isA transitivity",
  description: "若 A 属于 B 且 B 属于 C，则推出 A 属于 C（可多级传递）。",

  apply(known: KnowledgeQuery): readonly Inference[] {
    const adjacency = buildAdjacency(known);
    const inferences: Inference[] = [];

    for (const startSubject of adjacency.keys()) {
      const visited = new Set<string>([startSubject]);
      const queue: PathState[] = [{ node: startSubject, path: [startSubject], records: [] }];

      while (queue.length > 0) {
        const current = queue.shift()!;
        const outgoing = adjacency.get(current.node) ?? [];

        for (const edge of outgoing) {
          if (visited.has(edge.object)) continue; // guard against cycles
          visited.add(edge.object);
          const records = [...current.records, edge];
          queue.push({ node: edge.object, path: [...current.path, edge.object], records });

          // A single direct edge is already a known fact, not a derivation --
          // only emit once transitivity has actually chained through >=2 hops.
          if (records.length >= 2) {
            inferences.push(buildInference(records));
          }
        }
      }
    }

    return inferences;
  },
};
