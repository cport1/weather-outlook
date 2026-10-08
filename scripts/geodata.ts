// Regenerates the small bundled geodata in src/data/ from Natural Earth (public domain).
// Usage: bun scripts/geodata.ts
//
//  - admin1-lines.json: first-order admin boundaries (states/provinces) outside the US
//    (US states come from us-atlas), simplified and delta-encoded at 0.01°.
//  - places.json: populated places [name, lon, lat, rank, pop], rank 0 = most important.
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from "geojson";

const BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const TOLERANCE = 0.06; // degrees (~6 km): below a braille pixel at the zooms admin-1 lines appear
const MIN_LENGTH = 0.2; // drop boundary slivers shorter than this (degrees)
const Q = 100; // 0.01° quantization

async function load<G extends LineString | MultiLineString | Point>(
  name: string,
): Promise<FeatureCollection<G>> {
  const res = await fetch(`${BASE}${name}.geojson`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()) as FeatureCollection<G>;
}

type Pt = [number, number];

/** Douglas–Peucker line simplification. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = pts[a] as Pt;
    const [bx, by] = pts[b] as Pt;
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i] as Pt;
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Join segments that share endpoints into longer polylines (Natural Earth splits them a lot). */
function chain(parts: Pt[][]): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const byEnd = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const l = byEnd.get(k);
    if (l) l.push(i);
    else byEnd.set(k, [i]);
  };
  parts.forEach((p, i) => {
    add(key(p[0] as Pt), i);
    add(key(p[p.length - 1] as Pt), i);
  });
  const used = new Uint8Array(parts.length);
  const next = (end: Pt): Pt[] | undefined => {
    for (const j of byEnd.get(key(end)) ?? []) {
      if (used[j]) continue;
      used[j] = 1;
      const p = parts[j] as Pt[];
      return key(p[0] as Pt) === key(end) ? p : [...p].reverse();
    }
    return undefined;
  };
  const out: Pt[][] = [];
  parts.forEach((p, i) => {
    if (used[i]) return;
    used[i] = 1;
    let line = [...p];
    for (let n = next(line[line.length - 1] as Pt); n; n = next(line[line.length - 1] as Pt))
      line = line.concat(n.slice(1));
    for (let n = next(line[0] as Pt); n; n = next(line[0] as Pt))
      line = [...n].reverse().slice(0, -1).concat(line);
    out.push(line);
  });
  return out;
}

function encode(pts: Pt[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of pts) {
    const qx = Math.round(x * Q);
    const qy = Math.round(y * Q);
    out.push(qx - px, qy - py);
    px = qx;
    py = qy;
  }
  return out;
}

const admin = await load<LineString | MultiLineString>("ne_10m_admin_1_states_provinces_lines");
const raw: Pt[][] = [];
for (const f of admin.features as Array<Feature<LineString | MultiLineString | null>>) {
  const g = f.geometry;
  if (!g || f.properties?.ADM0_A3 === "USA") continue;
  for (const part of g.type === "LineString" ? [g.coordinates] : g.coordinates) raw.push(part as Pt[]);
}
const lines: number[][] = [];
let points = 0;
for (const part of chain(raw)) {
  let len = 0;
  for (let i = 1; i < part.length; i++) {
    const a = part[i - 1] as Pt;
    const b = part[i] as Pt;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (len < MIN_LENGTH) continue;
  const s = simplify(part, TOLERANCE);
  if (s.length < 2) continue;
  points += s.length;
  lines.push(encode(s));
}
await Bun.write("src/data/admin1-lines.json", JSON.stringify({ q: Q, lines }));
console.log(`admin1-lines.json: ${lines.length} lines, ${points} points`);

const places = await load<Point>("ne_50m_populated_places_simple");
const rows = places.features
  .map((f) => {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry.coordinates as Pt;
    // Lower is more important: Natural Earth scalerank, nudged up for capitals/megacities.
    const rank = Math.max(0, (p.scalerank as number) - (p.adm0cap ? 1 : 0) - (p.megacity ? 1 : 0));
    return [
      String(p.nameascii ?? p.name),
      Math.round(lon * Q) / Q,
      Math.round(lat * Q) / Q,
      rank,
      p.pop_max as number,
    ] as const;
  })
  .sort((a, b) => a[3] - b[3] || b[4] - a[4]);
await Bun.write("src/data/places.json", JSON.stringify(rows));
console.log(`places.json: ${rows.length} places`);
