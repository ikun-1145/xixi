/**
 * Join an opener / core content / closer into one reply, skipping any empty
 * parts and avoiding double spaces. Kept generic (not persona-specific) so
 * any future persona can reuse it instead of re-implementing string joining.
 */
export function compose(...parts: ReadonlyArray<string | undefined | null>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(" ");
}
