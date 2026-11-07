/**
 * Changed range between two versions of a rows array. Edits share structure, so rows
 * that did not change keep their objects: a single-cell edit is a one-row range, an
 * appended row an empty-to-one range at the end.
 *
 * `before[start, beforeEnd)` was replaced by `after[start, afterEnd)`; everything before
 * `start` is identical, and everything after the range is identical but shifted by
 * `afterEnd - beforeEnd`.
 */
export interface RowDiff {
  readonly start: number;
  readonly beforeEnd: number;
  readonly afterEnd: number;
}

/** Longest common prefix and suffix by object identity. O(unchanged prefix + suffix). */
export function rowDiff<T>(before: readonly T[], after: readonly T[]): RowDiff {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < shorter - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { start, beforeEnd: before.length - suffix, afterEnd: after.length - suffix };
}

/**
 * `list` with `list[start, end)` replaced by `items`, in place when that is cheap.
 * Avoids `splice(...items)`, whose argument count is limited by the stack.
 */
export function replaceRange<T>(list: T[], start: number, end: number, items: readonly T[]): T[] {
  if (items.length <= 1_000) {
    list.splice(start, end - start, ...items);
    return list;
  }
  const out = list.slice(0, start);
  for (const item of items) out.push(item);
  for (let i = end; i < list.length; i++) out.push(list[i]!);
  return out;
}
