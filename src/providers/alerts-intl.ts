import type { Alert, Severity } from "../domain/types.ts";
import { outerRings, placeMatches, pointInRings, type Ring } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";
import { sortAlerts } from "./nws.ts";

/**
 * Weather warnings outside the US:
 * - Environment Canada (OGC API, polygons)
 * - MET Norway MetAlerts (GeoJSON, polygons)
 * - MeteoAlarm per-country feeds (no polygons, matched by area name)
 * - WMO Severe Weather Information Centre (global headlines, no geometry)
 */

const CAP_SEVERITY: Record<string, Severity> = {
  Extreme: "extreme",
  Severe: "severe",
  Moderate: "moderate",
  Minor: "minor",
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- Environment and Climate Change Canada ------------------------------------------

const ECCC = "https://api.weather.gc.ca/collections/weather-alerts/items";

interface EcccFeature {
  id: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    alert_type?: string;
    alert_name_en?: string;
    alert_text_en?: string;
    risk_colour_en?: string | null;
    feature_name_en?: string;
    province?: string;
    status_en?: string;
    publication_datetime?: string;
    validity_datetime?: string;
    expiration_datetime?: string;
    event_end_datetime?: string | null;
  };
}

function ecccSeverity(p: EcccFeature["properties"]): Severity {
  const colour = p.risk_colour_en?.toLowerCase();
  if (colour === "red") return "extreme";
  if (colour === "orange") return "severe";
  if (colour === "yellow") return p.alert_type === "warning" ? "severe" : "moderate";
  if (p.alert_type === "warning") return "severe";
  if (p.alert_type === "watch") return "moderate";
  return "minor";
}

/** One Alert per ECCC alert, merging its per-region features (ended ones dropped). */
export function parseEccc(raw: { features: EcccFeature[] }): Alert[] {
  const byAlert = new Map<string, Alert>();
  for (const f of raw.features) {
    const p = f.properties;
    if (p.status_en === "ended") continue;
    const key = f.id.split("_")[0] ?? f.id;
    const rings = outerRings(f.geometry as never) as Ring[];
    const prev = byAlert.get(key);
    if (prev) {
      prev.polygon = [...(prev.polygon ?? []), ...rings];
      if (p.feature_name_en && !prev.areas?.includes(p.feature_name_en)) {
        prev.areas = `${prev.areas}; ${p.feature_name_en}`;
      }
      continue;
    }
    const event = capitalize(p.alert_name_en ?? "Weather alert");
    byAlert.set(key, {
      id: `eccc-${key}`,
      provider: "eccc",
      event,
      headline: `${event} in effect`,
      description: p.alert_text_en,
      severity: ecccSeverity(p),
      areas: [p.feature_name_en, p.province].filter(Boolean).join(", "),
      onset: p.validity_datetime ?? p.publication_datetime,
      expires: p.event_end_datetime ?? p.expiration_datetime,
      polygon: rings.length ? rings : undefined,
    });
  }
  return sortAlerts([...byAlert.values()]);
}

/** Canadian alerts intersecting a bbox (whole country by default). */
export async function fetchEcccAlerts(
  http: HttpClient,
  bbox: [number, number, number, number] = [-141, 41, -52, 84],
): Promise<Alert[]> {
  const raw = await http.json<{ features: EcccFeature[] }>(
    `${ECCC}?f=json&lang=en&limit=1000&bbox=${bbox.map((n) => n.toFixed(2)).join(",")}`,
    { ttlMs: 5 * 60_000, timeoutMs: 20_000 },
  );
  return parseEccc(raw);
}

/** ECCC alerts covering a point (tiny bbox query, then exact point-in-polygon). */
export async function fetchEcccAlertsForPoint(
  http: HttpClient,
  lat: number,
  lon: number,
): Promise<Alert[]> {
  const d = 0.02;
  const alerts = await fetchEcccAlerts(http, [lon - d, lat - d, lon + d, lat + d]);
  return alerts.filter((a) => !a.polygon || pointInRings(lon, lat, a.polygon));
}

// --- MET Norway ------------------------------------------------------------------

const METNO = "https://api.met.no/weatherapi/metalerts/2.0/current.json";

interface MetnoFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    id: string;
    event?: string;
    eventAwarenessName?: string;
    title?: string;
    description?: string;
    instruction?: string;
    consequences?: string;
    severity?: string;
    area?: string;
  };
  when?: { interval?: [string, string] };
}

export function parseMetno(raw: { features: MetnoFeature[] }): Alert[] {
  return sortAlerts(
    raw.features.map((f) => {
      const p = f.properties;
      const rings = outerRings(f.geometry as never) as Ring[];
      return {
        id: `metno-${p.id}`,
        provider: "met-norway",
        event: p.eventAwarenessName ?? capitalize(p.event ?? "Weather warning"),
        headline: p.title?.trim(),
        description: [p.description, p.consequences].filter(Boolean).join("\n\n") || undefined,
        instruction: p.instruction,
        severity: CAP_SEVERITY[p.severity ?? ""] ?? "unknown",
        areas: p.area,
        onset: f.when?.interval?.[0],
        expires: f.when?.interval?.[1],
        polygon: rings.length ? rings : undefined,
      };
    }),
  );
}

/** Norwegian warnings, optionally only those covering a point. */
export async function fetchMetnoAlerts(
  http: HttpClient,
  point?: { lat: number; lon: number },
): Promise<Alert[]> {
  const q = point ? `&lat=${point.lat.toFixed(3)}&lon=${point.lon.toFixed(3)}` : "";
  const raw = await http.json<{ features: MetnoFeature[] }>(`${METNO}?lang=en${q}`, {
    ttlMs: 5 * 60_000,
  });
  return parseMetno(raw);
}

// --- MeteoAlarm --------------------------------------------------------------------

/** ISO 3166-1 alpha-2 → MeteoAlarm feed slug (verified against feeds.meteoalarm.org). */
export const METEOALARM_FEEDS: Record<string, string> = {
  AT: "austria",
  BA: "bosnia-herzegovina",
  BE: "belgium",
  BG: "bulgaria",
  CH: "switzerland",
  CY: "cyprus",
  CZ: "czechia",
  DE: "germany",
  DK: "denmark",
  EE: "estonia",
  ES: "spain",
  FI: "finland",
  FR: "france",
  GB: "united-kingdom",
  GR: "greece",
  HR: "croatia",
  HU: "hungary",
  IE: "ireland",
  IL: "israel",
  IS: "iceland",
  IT: "italy",
  LT: "lithuania",
  LU: "luxembourg",
  LV: "latvia",
  MD: "moldova",
  ME: "montenegro",
  MK: "republic-of-north-macedonia",
  MT: "malta",
  NL: "netherlands",
  NO: "norway",
  PL: "poland",
  PT: "portugal",
  RO: "romania",
  RS: "serbia",
  SE: "sweden",
  SI: "slovenia",
  SK: "slovakia",
  UA: "ukraine",
};

interface CapInfo {
  language?: string;
  event?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  severity?: string;
  urgency?: string;
  onset?: string;
  effective?: string;
  expires?: string;
  area?: Array<{ areaDesc: string }>;
  parameter?: Array<{ valueName: string; value: string }>;
}
interface MeteoAlarmWarning {
  alert: { identifier: string; info: CapInfo[] };
}

/**
 * Narrow alerts to the first place name that matches any of their areas.
 * Places go from specific to broad (city, then region), so a city match wins
 * over a whole-region match. Identical event/area/onset repeats are collapsed.
 */
export function narrowByPlace(
  cands: Array<{ alert: Alert; areas: string[] }>,
  places: string[],
): Alert[] {
  if (!places.length) return sortAlerts(cands.map((c) => c.alert));
  for (const p of places) {
    const hits = cands.filter((c) => c.areas.some((a) => placeMatches(a, p)));
    if (!hits.length) continue;
    const seen = new Set<string>();
    const out: Alert[] = [];
    for (const c of hits) {
      const areas = c.areas.filter((a) => placeMatches(a, p)).join("; ");
      const key = `${c.alert.event}|${areas}|${c.alert.onset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c.alert, areas });
    }
    return sortAlerts(out);
  }
  return [];
}

/**
 * MeteoAlarm warnings for `places` (feeds have no polygons, only EMMA/NUTS
 * geocodes, so we match area names). Expired warnings are dropped.
 */
export function parseMeteoAlarm(
  raw: { warnings: MeteoAlarmWarning[] },
  places: string[],
  now = new Date(),
): Alert[] {
  const cands: Array<{ alert: Alert; areas: string[] }> = [];
  for (const w of raw.warnings) {
    const infos = w.alert.info ?? [];
    const info = infos.find((i) => i.language?.toLowerCase().startsWith("en")) ?? infos[0];
    if (!info) continue;
    if (info.expires && Date.parse(info.expires) < now.getTime()) continue;
    // Awareness level 1 (green) means "no particular awareness required".
    const awareness = info.parameter?.find((x) => x.valueName === "awareness_level")?.value;
    if (awareness?.startsWith("1;")) continue;
    const areas = (info.area ?? []).map((a) => a.areaDesc);
    cands.push({
      areas,
      alert: {
        id: `meteoalarm-${w.alert.identifier}`,
        provider: "meteoalarm",
        event: capitalize(info.event ?? "Weather warning"),
        headline: info.headline,
        description: info.description,
        instruction: info.instruction,
        severity: CAP_SEVERITY[info.severity ?? ""] ?? "unknown",
        urgency: info.urgency,
        areas: areas.join("; "),
        onset: info.onset ?? info.effective,
        expires: info.expires,
      },
    });
  }
  return narrowByPlace(cands, places);
}

export async function fetchMeteoAlarm(
  http: HttpClient,
  countryCode: string,
  places: string[],
): Promise<Alert[]> {
  const slug = METEOALARM_FEEDS[countryCode.toUpperCase()];
  if (!slug) return [];
  const raw = await http.json<{ warnings: MeteoAlarmWarning[] }>(
    `https://feeds.meteoalarm.org/api/v1/warnings/feeds-${slug}`,
    { ttlMs: 10 * 60_000, timeoutMs: 20_000 },
  );
  return parseMeteoAlarm(raw, places);
}

// --- WMO SWIC ------------------------------------------------------------------------

interface SwicItem {
  id: string;
  event?: string;
  headline?: string;
  areaDesc?: string;
  sent?: string;
  effective?: string;
  expires?: string;
  /** 1 minor … 4 extreme. */
  s?: number;
  capURL?: string | null;
  url?: string | null;
}

const SWIC_SEVERITY: Severity[] = ["unknown", "minor", "moderate", "severe", "extreme"];
const swicTime = (s: string | undefined) => (s ? `${s.replace(" ", "T")}Z` : undefined);

/** Country (ISO alpha-2) of a SWIC item, from its CAP path ("au-bom-en/…"). */
export function swicCountry(item: SwicItem): string | undefined {
  const path = item.capURL ?? item.url ?? "";
  const m = path.match(/^([a-z]{2})-/);
  return m?.[1]?.toUpperCase();
}

/** WMO SWIC headlines for a country, matched to `places` by area name. */
export function parseSwic(
  raw: { items: SwicItem[] },
  countryCode: string,
  places: string[],
): Alert[] {
  const cc = countryCode.toUpperCase();
  return narrowByPlace(
    raw.items
      .filter((i) => swicCountry(i) === cc)
      .map((i) => ({
        areas: [i.areaDesc ?? ""],
        alert: {
          id: `wmo-${i.id}`,
          provider: "wmo-swic",
          event: capitalize(i.event ?? "Weather warning"),
          headline: i.headline,
          severity: SWIC_SEVERITY[i.s ?? 0] ?? "unknown",
          areas: i.areaDesc,
          onset: swicTime(i.effective || i.sent),
          expires: swicTime(i.expires || undefined),
        },
      })),
    places,
  );
}

export async function fetchSwic(
  http: HttpClient,
  countryCode: string,
  places: string[],
): Promise<Alert[]> {
  const raw = await http.json<{ items: SwicItem[] }>(
    "https://severeweather.wmo.int/v2/json/wmo_all.json",
    { ttlMs: 15 * 60_000, timeoutMs: 20_000 },
  );
  return parseSwic(raw, countryCode, places);
}
