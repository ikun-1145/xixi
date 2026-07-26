import { createConfidence, type Confidence } from "./types";

export type SemanticLexiconCategory =
  | "conversation"
  | "identity"
  | "memory"
  | "knowledge"
  | "relation";

export type LexiconMatchMode = "whole-input" | "prefix" | "infix";

export type LexiconCandidateKind = "intent" | "statement" | "query";

export interface SemanticLexiconConstraints {
  readonly matchMode: LexiconMatchMode;
  readonly allowedCandidateKinds: readonly LexiconCandidateKind[];
  readonly requiresFollowingEntity?: boolean;
}

export interface SemanticLexiconEntry {
  readonly id: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly category: SemanticLexiconCategory;
  readonly baseWeight: Confidence;
  readonly constraints: SemanticLexiconConstraints;
  /**
   * True means the concept may participate in a side-effecting candidate.
   * It never authorizes a side effect by itself.
   */
  readonly sideEffectSafe: boolean;
}

interface LexiconDefinition {
  readonly id: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly category: SemanticLexiconCategory;
  readonly baseWeight: number;
  readonly constraints: SemanticLexiconConstraints;
  readonly sideEffectSafe: boolean;
}

function freezeEntry(definition: LexiconDefinition): SemanticLexiconEntry {
  return Object.freeze({
    ...definition,
    aliases: Object.freeze([...definition.aliases]),
    baseWeight: createConfidence(definition.baseWeight),
    constraints: Object.freeze({
      ...definition.constraints,
      allowedCandidateKinds: Object.freeze([
        ...definition.constraints.allowedCandidateKinds,
      ]),
    }),
  });
}

export const SEMANTIC_LEXICON: readonly SemanticLexiconEntry[] = Object.freeze(
  ([
    {
      id: "greeting",
      canonical: "你好",
      aliases: ["你好", "您好", "嗨", "哈喽", "hello", "hi", "hey"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"],
      },
      sideEffectSafe: false,
    },
    {
      id: "thanks",
      canonical: "谢谢",
      aliases: ["谢谢", "谢了", "感谢", "多谢", "thanks", "thank you", "thx"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"],
      },
      sideEffectSafe: false,
    },
    {
      id: "goodbye",
      canonical: "再见",
      aliases: ["再见", "拜拜", "先走", "bye", "goodbye", "see you"],
      category: "conversation",
      baseWeight: 0.92,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["intent"],
      },
      sideEffectSafe: false,
    },
    {
      id: "identity-name",
      canonical: "你叫什么",
      aliases: ["你叫什么", "你叫啥", "你的名字是什么"],
      category: "identity",
      baseWeight: 0.94,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"],
      },
      sideEffectSafe: false,
    },
    {
      id: "identity-self",
      canonical: "你是谁",
      aliases: [
        "你是谁",
        "你是什么",
        "sunland ai是什么",
        "sunland ai 是什么",
      ],
      category: "identity",
      baseWeight: 0.94,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"],
      },
      sideEffectSafe: false,
    },
    {
      id: "remember-name",
      canonical: "我叫",
      aliases: ["我叫", "我的名字是", "你可以叫我", "叫我"],
      category: "memory",
      baseWeight: 0.9,
      constraints: {
        matchMode: "prefix",
        allowedCandidateKinds: ["statement"],
        requiresFollowingEntity: true,
      },
      sideEffectSafe: true,
    },
    {
      id: "recall-name",
      canonical: "我叫什么",
      aliases: [
        "我叫什么",
        "我叫什么名字",
        "你记得我叫什么吗",
        "你记得我的名字吗",
        "你还记得我的名字吗",
        "还记得我是谁吗",
      ],
      category: "memory",
      baseWeight: 0.93,
      constraints: {
        matchMode: "whole-input",
        allowedCandidateKinds: ["query"],
      },
      sideEffectSafe: false,
    },
    {
      id: "teaching",
      canonical: "教你",
      aliases: ["教你", "告诉你一个知识", "记住这个事实"],
      category: "knowledge",
      baseWeight: 0.82,
      constraints: {
        matchMode: "prefix",
        allowedCandidateKinds: ["statement"],
        requiresFollowingEntity: true,
      },
      sideEffectSafe: true,
    },
    {
      id: "query-definition",
      canonical: "是什么",
      aliases: ["是什么", "是啥", "指什么", "什么意思"],
      category: "knowledge",
      baseWeight: 0.84,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["query"],
      },
      sideEffectSafe: false,
    },
    {
      id: "is-a",
      canonical: "属于",
      aliases: ["属于", "是一种", "算是", "归类为", "是"],
      category: "relation",
      baseWeight: 0.86,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"],
      },
      sideEffectSafe: true,
    },
    {
      id: "can",
      canonical: "会",
      aliases: ["会", "能", "能够"],
      category: "relation",
      baseWeight: 0.78,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"],
      },
      sideEffectSafe: true,
    },
    {
      id: "has",
      canonical: "有",
      aliases: ["有", "拥有", "具备"],
      category: "relation",
      baseWeight: 0.8,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"],
      },
      sideEffectSafe: true,
    },
    {
      id: "means",
      canonical: "意思是",
      aliases: ["意思是", "是什么意思", "表示", "指的是"],
      category: "relation",
      baseWeight: 0.84,
      constraints: {
        matchMode: "infix",
        allowedCandidateKinds: ["statement", "query"],
      },
      sideEffectSafe: true,
    },
  ] satisfies readonly LexiconDefinition[]).map(freezeEntry),
);

function normalizeLookupKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

export function findLexiconConceptById(
  id: string,
): SemanticLexiconEntry | null {
  return SEMANTIC_LEXICON.find((entry) => entry.id === id) ?? null;
}

export function findLexiconConceptsByAlias(
  alias: string,
): readonly SemanticLexiconEntry[] {
  const lookupKey = normalizeLookupKey(alias);
  if (lookupKey.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    SEMANTIC_LEXICON.filter((entry) =>
      entry.aliases.some(
        (candidate) => normalizeLookupKey(candidate) === lookupKey,
      ),
    ),
  );
}

export function findLexiconConceptsByCanonical(
  canonical: string,
): readonly SemanticLexiconEntry[] {
  const lookupKey = normalizeLookupKey(canonical);
  if (lookupKey.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    SEMANTIC_LEXICON.filter(
      (entry) => normalizeLookupKey(entry.canonical) === lookupKey,
    ),
  );
}

export interface LexiconAliasConflict {
  readonly alias: string;
  readonly conceptIds: readonly string[];
}

export function findLexiconAliasConflicts(): readonly LexiconAliasConflict[] {
  const aliases = new Set(
    SEMANTIC_LEXICON.flatMap((entry) =>
      entry.aliases.map((alias) => normalizeLookupKey(alias)),
    ),
  );
  const conflicts: LexiconAliasConflict[] = [];

  for (const alias of aliases) {
    const conceptIds = findLexiconConceptsByAlias(alias).map(
      (entry) => entry.id,
    );

    if (conceptIds.length > 1) {
      conflicts.push(
        Object.freeze({
          alias,
          conceptIds: Object.freeze(conceptIds),
        }),
      );
    }
  }

  return Object.freeze(conflicts);
}
