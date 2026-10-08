/** Small geometry helpers shared by hazard providers. Coordinates are [lon, lat]. */

export type LonLat = [number, number];
export type Ring = LonLat[];

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(bLat - aLat) / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Even-odd point-in-polygon test for a single ring. */
export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function ringBbox(ring: Ring): Bbox {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Point in any ring (rings are treated as separate outer polygons). */
export function pointInRings(lon: number, lat: number, rings: Ring[]): boolean {
  return rings.some((r) => pointInRing(lon, lat, r));
}

/** Drop vertices closer than `tol` degrees to the previous kept one. Keeps endpoints. */
export function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length <= 4 || tol <= 0) return ring;
  const out: Ring = [];
  let last: LonLat | undefined;
  for (const p of ring) {
    if (!last || Math.abs(p[0] - last[0]) >= tol || Math.abs(p[1] - last[1]) >= tol) {
      out.push(p);
      last = p;
    }
  }
  const end = ring[ring.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out.length >= 4 ? out : ring;
}

type Geometry = { type: string; coordinates?: unknown; geometries?: Geometry[] } | null | undefined;

/** Outer rings of a (Multi)Polygon / GeometryCollection, as [lon, lat]. */
export function outerRings(g: Geometry): Ring[] {
  if (!g) return [];
  if (g.type === "Polygon") {
    const r = (g.coordinates as Ring[])[0];
    return r ? [r] : [];
  }
  if (g.type === "MultiPolygon") {
    return (g.coordinates as Ring[][]).map((p) => p[0]).filter((r): r is Ring => Boolean(r));
  }
  if (g.type === "GeometryCollection") return (g.geometries ?? []).flatMap(outerRings);
  return [];
}

/** Normalize text for loose place-name matching ("Kreis Verden" ~ "verden"). */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when any whole-word token sequence of `needle` appears in `hay`. */
export function placeMatches(hay: string, needle: string): boolean {
  const n = normalizePlace(needle);
  if (n.length < 3) return false;
  return ` ${normalizePlace(hay)} `.includes(` ${n} `);
}

/** The closest item within `maxKm`, with its distance. */
export function nearest<T>(
  items: Iterable<T>,
  lat: number,
  lon: number,
  pos: (t: T) => { lat: number; lon: number } | undefined,
  maxKm = Number.POSITIVE_INFINITY,
): { item: T; distanceKm: number } | undefined {
  let best: { item: T; distanceKm: number } | undefined;
  for (const item of items) {
    const p = pos(item);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const d = distanceKm(lat, lon, p.lat, p.lon);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { item, distanceKm: d };
  }
  return best;
}
