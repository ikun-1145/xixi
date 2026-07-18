/**
 * Core knowledge representation.
 *
 * Knowledge is NEVER stored as free text. Every fact is a graph triple:
 *   (subject) --relation--> (object)
 *
 * These types are the shared vocabulary for the parser, knowledge store,
 * reasoning engine and visualization layers.
 */

/** Opaque identifier (uuid or generated). */
export type Id = string;

/**
 * A relation is kept as an open string to allow rule/ontology plugins to
 * introduce new relations without touching core types. Well-known relations
 * are provided as constants below for consistency.
 */
export type Relation = string;

/** Canonical relations understood by the built-in reasoners. */
export const CoreRelations = {
  /** Inheritance / subclass-of, e.g. 猫 属于 哺乳动物 */
  IsA: "属于",
  /** Identity / instance-of, e.g. 苏格拉底 是 人 */
  Is: "是",
  /** Capability, e.g. 鸟 会 飞 */
  Can: "会",
  /** Preference, e.g. 猫 喜欢 鱼 */
  Likes: "喜欢",
  /** Spatial location, e.g. 猫 在 屋顶 */
  LocatedIn: "在",
} as const;

export type CoreRelation = (typeof CoreRelations)[keyof typeof CoreRelations];

/** How a fact entered the system. Keeps provenance explicit and auditable. */
export type KnowledgeSource = "user" | "inference" | "seed" | "import";

/**
 * The atomic unit of knowledge.
 *
 * `negated` is first-class so the reasoner can detect contradictions such as
 * `鸟 会 飞` vs `企鹅 不会 飞` (the second is `{ relation: "会", negated: true }`).
 */
export interface Triple {
  readonly subject: string;
  readonly relation: Relation;
  readonly object: string;
  /** true when the fact asserts the negation, e.g. 企鹅 不会 飞. */
  readonly negated: boolean;
}

/** A persisted, provenance-tracked fact. */
export interface KnowledgeRecord extends Triple {
  readonly id: Id;
  /** Belief strength in the closed interval [0, 1]. */
  readonly confidence: number;
  readonly source: KnowledgeSource;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
}

/** A partial pattern used to match facts in the store (undefined = wildcard). */
export type TriplePattern = Partial<Triple>;
