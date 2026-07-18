/**
 * Illustrative starter facts for bootstrapping/demoing the reasoning engine.
 *
 * Deliberately includes an inheritance chain (猫→哺乳动物→动物, 苏格拉底→人→动物)
 * for Stage 4's transitivity rule, and the classic 企鹅/鸟/飞 exception
 * (企鹅 属于 鸟, 鸟 会 飞, but 企鹅 不会 飞 negated) so the future conflict
 * resolver has a real contradiction to resolve from day one, matching the
 * example already used in `types/knowledge.ts`'s doc comments.
 */
import type { Triple } from "@/types";
import { CoreRelations, type KnowledgeStore } from "@/types";

export const seedTriples: readonly Triple[] = [
  { subject: "猫", relation: CoreRelations.IsA, object: "哺乳动物", negated: false },
  { subject: "哺乳动物", relation: CoreRelations.IsA, object: "动物", negated: false },
  { subject: "苏格拉底", relation: CoreRelations.Is, object: "人", negated: false },
  { subject: "人", relation: CoreRelations.IsA, object: "动物", negated: false },
  { subject: "鸟", relation: CoreRelations.Can, object: "飞", negated: false },
  { subject: "企鹅", relation: CoreRelations.IsA, object: "鸟", negated: false },
  { subject: "企鹅", relation: CoreRelations.Can, object: "飞", negated: true },
  { subject: "猫", relation: CoreRelations.Likes, object: "鱼", negated: false },
  { subject: "猫", relation: CoreRelations.LocatedIn, object: "屋顶", negated: false },
];

/** Populates `store` with `seedTriples` (source: "seed"). Safe to call once at startup. */
export function seedKnowledgeStore(store: KnowledgeStore): void {
  for (const triple of seedTriples) {
    store.add(triple, { source: "seed" });
  }
}
