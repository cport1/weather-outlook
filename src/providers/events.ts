import type { GeoEvent } from "../domain/types.ts";
import { distanceKm, outerRings } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * Point events from global disaster feeds: USGS elevated volcanoes (HANS),
 * NASA EONET open events and GDACS floods/droughts/volcanoes.
 */

const HANS = "https://volcanoes.usgs.gov/hans-public/api/volcano";
// Storms, fires and quakes have dedicated providers; ice is not very interesting.
const EONET =
  "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes,floods,landslides,drought,dustHaze,snow,tempExtremes";
const GDACS_EVENTS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP";

type Level = NonNullable<GeoEvent["level"]>;
const LEVELS = new Set<string>(["green", "yellow", "orange", "red"]);
const level = (s: string | undefined): Level | undefined => {
  const l = s?.toLowerCase();
  return l && LEVELS.has(l) ? (l as Level) : undefined;
};

// --- USGS HANS ---------------------------------------------------------------

export interface HansElevated {
  volcano_name: string;
  vnum: string;
  obs_abbr?: string;
  obs_fullname?: string;
  color_code?: string;
  alert_level?: string;
  sent_utc?: string;
  notice_url?: string;
}
export interface HansVolcano {
  vnum: string;
  latitude: number;
  longitude: number;
}

export function parseHans(elevated: HansElevated[], coords: Map<string, HansVolcano>): GeoEvent[] {
  const out: GeoEvent[] = [];
  for (const v of elevated) {
    const c = coords.get(v.vnum);
    if (!c) continue;
    out.push({
      id: `hans-${v.vnum}`,
      provider: "usgs-hans",
      kind: "volcano",
      title: v.volcano_name,
      lat: c.latitude,
      lon: c.longitude,
      level: level(v.color_code),
      detail: [v.alert_level, v.obs_abbr?.toUpperCase()].filter(Boolean).join(" · "),
      updated: v.sent_utc ? `${v.sent_utc.replace(" ", "T")}Z` : undefined,
      url: v.notice_url,
    });
  }
  return out;
}

export async function fetchUsgsVolcanoes(http: HttpClient): Promise<GeoEvent[]> {
  const elevated = await http.json<HansElevated[]>(`${HANS}/getElevatedVolcanoes`, {
    ttlMs: 30 * 60_000,
  });
  const coords = new Map<string, HansVolcano>();
  await Promise.all(
    elevated.map(async (v) => {
      // Volcano locations never change, so cache them for a week.
      const c = await http
        .json<HansVolcano>(`${HANS}/getVolcano/${v.vnum}`, { ttlMs: 7 * 86_400_000 })
        .catch(() => undefined);
      if (c && Number.isFinite(c.latitude)) coords.set(v.vnum, c);
    }),
  );
  return parseHans(elevated, coords);
}

// --- NASA EONET ----------------------------------------------------------------

interface EonetEvent {
  id: string;
  title: string;
  link?: string;
  categories: Array<{ id: string }>;
  sources?: Array<{ url?: string }>;
  geometry: Array<{
    date?: string;
    type: string;
    coordinates: unknown;
    magnitudeValue?: number | null;
    magnitudeUnit?: string | null;
  }>;
}

const EONET_KIND: Record<string, GeoEvent["kind"]> = {
  volcanoes: "volcano",
  floods: "flood",
  drought: "drought",
  landslides: "landslide",
  dustHaze: "dust",
  snow: "snow",
  tempExtremes: "heat",
};

function centroid(g: EonetEvent["geometry"][number]): [number, number] | undefined {
  if (g.type === "Point") return g.coordinates as [number, number];
  const ring = outerRings(g as never)[0];
  if (!ring?.length) return undefined;
  const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return [lon, lat];
}

export function parseEonet(raw: { events: EonetEvent[] }): GeoEvent[] {
  const out: GeoEvent[] = [];
  for (const e of raw.events) {
    const kind = EONET_KIND[e.categories[0]?.id ?? ""];
    const g = e.geometry.at(-1);
    const c = g && centroid(g);
    if (!kind || !g || !c) continue;
    out.push({
      id: e.id,
      provider: "eonet",
      kind,
      title: e.title,
      lon: c[0],
      lat: c[1],
      detail:
        g.magnitudeValue != null
          ? `${g.magnitudeValue} ${g.magnitudeUnit ?? ""}`.trim()
          : undefined,
      updated: g.date,
      url: e.sources?.[0]?.url ?? e.link,
    });
  }
  return out;
}

export async function fetchEonetEvents(http: HttpClient): Promise<GeoEvent[]> {
  // EONET serves JSON with an rss+xml content type, so read text and parse it ourselves.
  const text = await http.text(EONET, { ttlMs: 60 * 60_000, timeoutMs: 20_000 });
  return parseEonet(JSON.parse(text));
}

// --- GDACS ----------------------------------------------------------------------

interface GdacsEventFeature {
  geometry: { type: string; coordinates: [number, number] } | null;
  properties: {
    eventtype: string;
    eventid: number;
    name: string;
    alertlevel?: string;
    iscurrent?: string | boolean;
    country?: string;
    todate?: string;
    severitydata?: { severitytext?: string };
    url?: { report?: string };
  };
}

const GDACS_KIND: Record<string, GeoEvent["kind"]> = { FL: "flood", DR: "drought", VO: "volcano" };

export function parseGdacsEvents(raw: { features: GdacsEventFeature[] }): GeoEvent[] {
  const out: GeoEvent[] = [];
  for (const f of raw.features) {
    const p = f.properties;
    const kind = GDACS_KIND[p.eventtype];
    if (!kind || f.geometry?.type !== "Point" || String(p.iscurrent) === "false") continue;
    const sev = p.severitydata?.severitytext?.trim();
    out.push({
      id: `gdacs-${p.eventtype}-${p.eventid}`,
      provider: "gdacs",
      kind,
      title: p.name,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      level: level(p.alertlevel),
      detail: sev && !/^Magnitude 0\b/.test(sev) ? sev : undefined,
      updated: p.todate ? `${p.todate}Z` : undefined,
      url: p.url?.report,
    });
  }
  return out;
}

export async function fetchGdacsEvents(http: HttpClient): Promise<GeoEvent[]> {
  const raw = await http.json<{ features: GdacsEventFeature[] }>(GDACS_EVENTS, {
    ttlMs: 30 * 60_000,
    timeoutMs: 20_000,
  });
  return parseGdacsEvents(raw);
}

const LEVEL_RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1, green: 0 };

/** Merge feeds in priority order, dropping later duplicates of the same kind within 30 km. */
export function mergeEvents(...sources: GeoEvent[][]): GeoEvent[] {
  const out: GeoEvent[] = [];
  for (const list of sources) {
    for (const e of list) {
      const dup = out.some((o) => o.kind === e.kind && distanceKm(o.lat, o.lon, e.lat, e.lon) < 30);
      if (!dup) out.push(e);
    }
  }
  return out.sort(
    (a, b) =>
      (LEVEL_RANK[b.level ?? ""] ?? -1) - (LEVEL_RANK[a.level ?? ""] ?? -1) ||
      (b.updated ?? "").localeCompare(a.updated ?? ""),
  );
}
