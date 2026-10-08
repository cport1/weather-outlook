import data from "../data/places.json" with { type: "json" };
import type { RGB } from "./color.ts";
import type { MapMarker } from "./worldmap.ts";

/** Natural Earth 1:50m populated places (see scripts/geodata.ts). */
export interface Place {
  name: string;
  lon: number;
  lat: number;
  /** 0 = most prominent (megacities, capitals); grows as places get smaller. */
  rank: number;
  pop: number;
}

type Row = [string, number, number, number, number];

/** Sorted by rank, then population, so earlier entries win label collisions. */
export const PLACES: readonly Place[] = (data as unknown as Row[]).map(
  ([name, lon, lat, rank, pop]) => ({ name, lon, lat, rank, pop }),
);

/** Densest rank to show at a zoom level; label collision avoidance thins the rest. */
export function placeRankForZoom(zoom: number): number {
  if (zoom < 2) return 0;
  if (zoom < 4) return 1;
  if (zoom < 6) return 2;
  if (zoom < 10) return 3;
  if (zoom < 20) return 4;
  return 99;
}

/**
 * City dots + names as optional markers: each only appears if its label
 * finds room after hazards and other required labels are placed.
 */
export function placeMarkers(
  zoom: number,
  color: RGB,
  opts: { maxRank?: number; limit?: number } = {},
): MapMarker[] {
  const maxRank = opts.maxRank ?? placeRankForZoom(zoom);
  const out: MapMarker[] = [];
  for (const p of PLACES) {
    if (p.rank > maxRank) break;
    out.push({ lon: p.lon, lat: p.lat, glyph: "◦", color, label: p.name, optional: true });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}
