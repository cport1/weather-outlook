import type { HttpClient } from "../util/http.ts";

/**
 * NOAA SWPC OVATION aurora nowcast: probability (0–100) of visible aurora on
 * a 1° grid, ~30–90 minutes ahead. The raw file is ~1 MB of JSON, so it is
 * packed into a Uint8Array right away.
 */
export const AURORA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

export interface AuroraGrid {
  observed?: string;
  forecast?: string;
  /** 360 × 181: index = (lat + 90) * 360 + lon, lon in 0..359. */
  prob: Uint8Array;
  max: number;
}

interface OvationResponse {
  "Observation Time"?: string;
  "Forecast Time"?: string;
  coordinates: Array<[number, number, number]>;
}

export function parseAurora(raw: OvationResponse): AuroraGrid {
  const prob = new Uint8Array(360 * 181);
  let max = 0;
  for (const [lon, lat, p] of raw.coordinates) {
    const x = ((Math.round(lon) % 360) + 360) % 360;
    const y = Math.round(lat) + 90;
    if (y < 0 || y > 180) continue;
    const v = Math.max(0, Math.min(100, Math.round(p)));
    prob[y * 360 + x] = v;
    if (v > max) max = v;
  }
  return { observed: raw["Observation Time"], forecast: raw["Forecast Time"], prob, max };
}

export async function fetchAurora(http: HttpClient): Promise<AuroraGrid> {
  const raw = await http.json<OvationResponse>(AURORA_URL, {
    ttlMs: 30 * 60_000,
    timeoutMs: 20_000,
  });
  return parseAurora(raw);
}

/** Bilinear probability at any lon/lat (lon wraps). */
export function auroraAt(g: AuroraGrid, lon: number, lat: number): number {
  const x = ((lon % 360) + 360) % 360;
  const y = Math.max(0, Math.min(180, lat + 90));
  const x0 = Math.floor(x);
  const y0 = Math.min(179, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const at = (xi: number, yi: number) => g.prob[yi * 360 + (xi % 360)] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}
