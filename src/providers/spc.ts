import type { RiskArea, RiskSummary } from "../domain/types.ts";
import { outerRings, pointInRings, type Ring } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * US outlooks as filled risk polygons:
 * - SPC convective Day 1-3 categorical (+ Day 1 tornado/wind/hail probabilities)
 * - SPC fire weather Day 1 (wind/RH and dry thunder)
 * - WPC excessive rainfall Day 1-3
 * SPC files carry their own `fill` colors; empty outlooks are a single
 * feature with an empty GeometryCollection.
 */

const SPC = "https://www.spc.noaa.gov/products";
const WPC_ERO = "https://www.wpc.ncep.noaa.gov/exper/eromap/geojson";

interface OutlookFeature {
  geometry: { type: string; coordinates?: unknown; geometries?: unknown[] } | null;
  properties: {
    DN?: number;
    LABEL?: string;
    LABEL2?: string;
    fill?: string;
    VALID_ISO?: string;
    EXPIRE_ISO?: string;
    // WPC ERO
    OUTLOOK?: string;
    START_TIME?: string;
    END_TIME?: string;
  };
}
export interface OutlookCollection {
  features: OutlookFeature[];
}

export const CATEGORICAL = ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"] as const;
const CATEGORICAL_NAME: Record<string, string> = {
  TSTM: "General thunderstorms",
  MRGL: "Marginal risk",
  SLGT: "Slight risk",
  ENH: "Enhanced risk",
  MDT: "Moderate risk",
  HIGH: "High risk",
};
const FIRE_LEVEL: Record<string, number> = { IDRT: 1, ELEV: 1, SDRT: 2, CRIT: 2, EXTM: 3 };
const FIRE_NAME: Record<string, string> = {
  ELEV: "Elevated fire weather",
  CRIT: "Critical fire weather",
  EXTM: "Extremely critical fire weather",
  IDRT: "Isolated dry thunderstorms",
  SDRT: "Scattered dry thunderstorms",
};
const ERO: Array<[RegExp, string, number, string]> = [
  [/^marginal/i, "MRGL", 1, "#66c266"],
  [/^slight/i, "SLGT", 2, "#ffd966"],
  [/^moderate/i, "MDT", 3, "#ff4040"],
  [/^high/i, "HIGH", 4, "#ff40ff"],
];

type Product = RiskArea["product"];

/** Parse one SPC outlook GeoJSON (categorical, probabilistic or fire weather). */
export function parseSpcOutlook(fc: OutlookCollection, product: Product, day: number): RiskArea[] {
  const out: RiskArea[] = [];
  for (const f of fc.features) {
    const rings = outerRings(f.geometry as never) as Ring[];
    const p = f.properties;
    const code = (p.LABEL ?? "").toUpperCase();
    if (!rings.length || !code) continue;
    let label = code;
    let level = p.DN ?? 0;
    let name = p.LABEL2 || code;
    if (product === "categorical") {
      level = CATEGORICAL.indexOf(code as (typeof CATEGORICAL)[number]) + 1;
      if (level <= 0) continue;
      name = CATEGORICAL_NAME[code] ?? name;
    } else if (product === "fire") {
      level = FIRE_LEVEL[code] ?? 1;
      name = FIRE_NAME[code] ?? name;
    } else if (/^0?\.\d+$/.test(code)) {
      label = `${Math.round(Number(code) * 100)}%`;
    } else if (code === "SIGN") {
      label = "SIG";
      level = 100;
      name = p.LABEL2 || "Significant severe";
    }
    out.push({
      product,
      day,
      label,
      name,
      level,
      fill: p.fill || undefined,
      valid: p.VALID_ISO,
      expires: p.EXPIRE_ISO,
      rings,
    });
  }
  return out;
}

const wpcTime = (s: string | undefined) => (s ? `${s.replace(" ", "T")}Z` : undefined);

/** Parse a WPC excessive rainfall outlook. */
export function parseEro(fc: OutlookCollection, day: number): RiskArea[] {
  const out: RiskArea[] = [];
  for (const f of fc.features) {
    const rings = outerRings(f.geometry as never) as Ring[];
    const text = f.properties.OUTLOOK ?? "";
    const match = ERO.find(([re]) => re.test(text));
    if (!rings.length || !match) continue;
    const [, label, level, fill] = match;
    out.push({
      product: "rainfall",
      day,
      label,
      name: `${text.replace(/\s*\(.*\)$/, "")} risk of excessive rainfall`,
      level,
      fill,
      valid: wpcTime(f.properties.START_TIME),
      expires: wpcTime(f.properties.END_TIME),
      rings,
    });
  }
  return out;
}

/** Highest-level risk per product/day covering a point. */
export function risksAt(areas: RiskArea[], lat: number, lon: number): RiskSummary[] {
  const best = new Map<string, RiskSummary>();
  for (const a of areas) {
    if (a.label === "SIG" || !pointInRings(lon, lat, a.rings)) continue;
    const key = `${a.product}:${a.day}`;
    const prev = best.get(key);
    if (!prev || a.level > prev.level) {
      const { rings: _rings, ...summary } = a;
      best.set(key, summary);
    }
  }
  return [...best.values()].sort((a, b) => a.day - b.day || a.product.localeCompare(b.product));
}

const OPTS = { ttlMs: 30 * 60_000, timeoutMs: 15_000 };

/** Fetch all outlooks; a single failing product is skipped rather than failing the set. */
export async function fetchOutlooks(
  http: HttpClient,
  which: "all" | "day1" = "all",
): Promise<RiskArea[]> {
  const spc = (path: string, product: Product, day: number) =>
    http
      .json<OutlookCollection>(`${SPC}/${path}`, OPTS)
      .then((fc) => parseSpcOutlook(fc, product, day));
  const ero = (day: number) =>
    http
      .json<OutlookCollection>(`${WPC_ERO}/Day${day}_Latest.geojson`, OPTS)
      .then((fc) => parseEro(fc, day));
  const jobs: Array<Promise<RiskArea[]>> = [
    spc("outlook/day1otlk_cat.nolyr.geojson", "categorical", 1),
    spc("fire_wx/day1fw_windrh.nolyr.geojson", "fire", 1),
    spc("fire_wx/day1fw_dryt.nolyr.geojson", "fire", 1),
    ero(1),
  ];
  if (which === "all") {
    jobs.push(
      spc("outlook/day1otlk_torn.nolyr.geojson", "tornado", 1),
      spc("outlook/day1otlk_wind.nolyr.geojson", "wind", 1),
      spc("outlook/day1otlk_hail.nolyr.geojson", "hail", 1),
      spc("outlook/day2otlk_cat.nolyr.geojson", "categorical", 2),
      spc("outlook/day3otlk_cat.nolyr.geojson", "categorical", 3),
      ero(2),
      ero(3),
    );
  }
  const settled = await Promise.allSettled(jobs);
  const ok = settled.filter((r) => r.status === "fulfilled");
  if (!ok.length && settled[0]?.status === "rejected") throw settled[0].reason;
  return ok.flatMap((r) => r.value);
}
