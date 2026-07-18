/**
 * Static self-referential facts about Sunland AI itself and its default
 * personality (Frost/霜蓝) -- what the `Identity` intent answers from.
 *
 * Deliberately NOT part of a user's personal `KnowledgeStore`: these facts
 * describe the SYSTEM, not something a user taught it, so they must never
 * count toward "a fresh user's brain starts empty" (`createSunlandEngine()`
 * without `seedDemoData` guarantees `knowledgeStore.all()` is `[]` --
 * self-knowledge must not leak into that and break the guarantee). Kept in
 * its own always-on, in-memory store instead (`createSelfKnowledgeStore()`),
 * created once per engine and never persisted or exposed on
 * `SunlandEngine.knowledgeStore`.
 *
 * This is real Knowledge (Triples), not hardcoded reply strings: Identity
 * answers are assembled from these facts by Personality exactly like any
 * other reasoning-result (see `engine/sunlandEngine.ts`'s `answerIdentity`
 * and `personality/frost.ts`'s `renderIdentity`). That is the whole point --
 * "growing what Sunland AI knows about itself" later (Knowledge Engine,
 * Stage 5+) means editing/extending the facts below, never touching the
 * Identity intent-matching or rendering code.
 */
import type { Relation, Triple } from "@/types";
import { CoreRelations } from "@/types";
import { InMemoryKnowledgeStore } from "./store";

/** Canonical subject for facts about the system as a whole. */
export const SUNLAND_SUBJECT = "Sunland AI";
/** Canonical subject for facts about the default personality specifically. */
export const FROST_SUBJECT = "霜蓝";

/**
 * Relation used for "who made this" facts. Not one of `CoreRelations` (those
 * are general-purpose reasoning relations) -- `Relation` is deliberately an
 * open `string` type precisely so a system-specific relation like this can
 * be introduced without touching `types/knowledge.ts`.
 */
export const CREATOR_RELATION: Relation = "开发者";

export const selfKnowledgeTriples: readonly Triple[] = [
  {
    subject: SUNLAND_SUBJECT,
    relation: CoreRelations.Is,
    object:
      "一个基于符号推理与知识图谱的AI系统：不依赖大语言模型，而是用显式的知识（事实）和推理规则来理解、学习与回答问题",
    negated: false,
  },
  {
    subject: FROST_SUBJECT,
    relation: CoreRelations.Is,
    object: "Sunland AI 目前的默认人格，说话自然温和、带一点点俏皮，仅负责语气，不改变任何事实或推理结论",
    negated: false,
  },
  {
    subject: SUNLAND_SUBJECT,
    relation: CoreRelations.Can,
    object: "记住你教给它的知识（比如「猫属于哺乳动物」），并在之后的对话里用上",
    negated: false,
  },
  {
    subject: SUNLAND_SUBJECT,
    relation: CoreRelations.Can,
    object: "基于已知事实做推理、回答问题，并且能解释自己是怎么得出这个答案的",
    negated: false,
  },
  {
    subject: SUNLAND_SUBJECT,
    relation: CREATOR_RELATION,
    object: "由一名独立开发者持续设计与打磨，目前仍在成长中",
    negated: false,
  },
];

/**
 * Fresh, pre-populated store of `selfKnowledgeTriples`. Cheap enough to
 * create once per engine instance (a handful of records, in-memory,
 * `source: "seed"`) -- intentionally a separate store instance from the
 * user's `knowledgeStore`, never shared or persisted.
 */
export function createSelfKnowledgeStore(): InMemoryKnowledgeStore {
  const store = new InMemoryKnowledgeStore();
  for (const triple of selfKnowledgeTriples) {
    store.add(triple, { source: "seed" });
  }
  return store;
}
