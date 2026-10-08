/**
 * Greedy label placement on a cell grid: each label tries the right of its
 * anchor, then the left, then above/below, and is dropped if all collide.
 * Anchors themselves are reserved up front so labels never cover markers.
 */
export interface LabelRequest {
  col: number;
  row: number;
  text: string;
}

export type PlacedLabel<T extends LabelRequest = LabelRequest> = T & { x: number; y: number };

export function placeLabels<T extends LabelRequest>(
  requests: T[],
  cols: number,
  rows: number,
): PlacedLabel<T>[] {
  const taken = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const r of requests) taken.add(key(r.col, r.row));
  const placed: PlacedLabel<T>[] = [];
  for (const r of requests) {
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
      placed.push({ ...r, x, y });
      break;
    }
  }
  return placed;
}
