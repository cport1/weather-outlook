/**
 * Greedy label placement on a cell grid: each label tries the right of its
 * anchor, then the left, then above/below, and is dropped if all collide.
 * Anchors of required labels are reserved up front so labels never cover
 * markers. Optional labels (e.g. city names) are placed after the required
 * ones, need a free anchor cell too, and only reserve it once placed, so a
 * dropped city never blocks anything.
 */
export interface LabelRequest {
  col: number;
  row: number;
  text: string;
  /** Low priority: placed only if room remains after every required label. */
  optional?: boolean;
}

export type PlacedLabel<T extends LabelRequest = LabelRequest> = T & { x: number; y: number };

export function placeLabels<T extends LabelRequest>(
  requests: T[],
  cols: number,
  rows: number,
  /** Cells already in use (e.g. by a details card), as `${x},${y}`. */
  reserved: Iterable<string> = [],
): PlacedLabel<T>[] {
  const taken = new Set<string>(reserved);
  const key = (x: number, y: number) => `${x},${y}`;
  for (const r of requests) if (!r.optional) taken.add(key(r.col, r.row));
  const placed: PlacedLabel<T>[] = [];
  const ordered = [...requests.filter((r) => !r.optional), ...requests.filter((r) => r.optional)];
  for (const r of ordered) {
    if (r.optional) {
      // Keep a one-cell gap around optional anchors so city dots don't crowd markers.
      let clear = true;
      for (let dx = -1; dx <= 1 && clear; dx++)
        if (taken.has(key(r.col + dx, r.row))) clear = false;
      if (!clear) continue;
    }
    const len = [...r.text].length;
    const candidates: Array<[number, number]> = [
      [r.col + 2, r.row],
      [r.col - 1 - len, r.row],
      [r.col - Math.floor(len / 2), r.row - 1],
      [r.col - Math.floor(len / 2), r.row + 1],
    ];
    for (const [x, y] of candidates) {
      if (x < 0 || y < 0 || x + len > cols || y >= rows) continue;
      // One cell of padding so neighbouring labels don't run together.
      let free = true;
      for (let i = -1; i <= len && free; i++) if (taken.has(key(x + i, y))) free = false;
      if (!free) continue;
      for (let i = 0; i < len; i++) taken.add(key(x + i, y));
      if (r.optional) taken.add(key(r.col, r.row));
      placed.push({ ...r, x, y });
      break;
    }
  }
  return placed;
}
