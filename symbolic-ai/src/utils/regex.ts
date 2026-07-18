/**
 * Escape a literal string so it can be safely embedded inside a RegExp
 * pattern (e.g. `new RegExp(escapeRegExp(userSuppliedRelation))`).
 *
 * Chinese relation words (属于, 是, 会...) never contain regex metacharacters,
 * but plugin authors may register relations that do (e.g. "A+B"), so every
 * pattern factory in `parser/patterns` runs relation strings through this
 * before interpolating them into a RegExp literal.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
