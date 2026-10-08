import type { Marine, TideEvent, WavePoint } from "../domain/details.ts";
import type { Location } from "../domain/types.ts";
import { nearest } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";
import { withOffset } from "./open-meteo.ts";

/**
 * Marine data for coastal locations: Open-Meteo Marine (waves + SST),
 * NOAA CO-OPS tide predictions from the nearest station, and the latest
 * observation from the nearest NDBC buoy.
 */

const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const COOPS_STATIONS =
  "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions";
const COOPS_DATA = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
/** One file with the latest observation of every NDBC station (~100 KB, includes lat/lon). */
const NDBC_LATEST = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt";

const TIDE_MAX_KM = 60;
const BUOY_MAX_KM = 150;

type Series = Record<string, Array<number | string | null> | undefined>;
interface MarineResponse {
  utc_offset_seconds: number;
  current?: Record<string, number | string | null>;
  hourly?: Series & { time: string[] };
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Undefined when the point is inland (Open-Meteo returns nulls there). */
export function parseWaves(raw: MarineResponse): Marine["waves"] {
  const c = raw.current ?? {};
  const current: WavePoint = {
    time: withOffset(String(c.time ?? ""), raw.utc_offset_seconds),
    height: num(c.wave_height),
    period: num(c.wave_period),
    direction: num(c.wave_direction),
    seaSurfaceTemperature: num(c.sea_surface_temperature),
  };
  const h = raw.hourly;
  const hourly: WavePoint[] = (h?.time ?? []).map((t, i) => ({
    time: withOffset(t, raw.utc_offset_seconds),
    height: num(h?.wave_height?.[i]),
    period: num(h?.wave_period?.[i]),
    direction: num(h?.wave_direction?.[i]),
    seaSurfaceTemperature: num(h?.sea_surface_temperature?.[i]),
  }));
  const any = (p: WavePoint) => p.height !== undefined || p.seaSurfaceTemperature !== undefined;
  if (!any(current) && !hourly.some(any)) return undefined;
  return { provider: "open-meteo-marine", current, hourly };
}

interface CoopsStation {
  id: string;
  name: string;
  state?: string;
  lat: number;
  lng: number;
}

export function nearestTideStation(
  raw: { stations: CoopsStation[] },
  lat: number,
  lon: number,
  maxKm = TIDE_MAX_KM,
) {
  const hit = nearest(raw.stations, lat, lon, (s) => ({ lat: s.lat, lon: s.lng }), maxKm);
  if (!hit) return undefined;
  const s = hit.item;
  return {
    id: s.id,
    name: s.state ? `${s.name}, ${s.state}` : s.name,
    lat: s.lat,
    lon: s.lng,
    distanceKm: Math.round(hit.distanceKm * 10) / 10,
  };
}

interface CoopsPredictions {
  predictions?: Array<{ t: string; v: string; type?: string }>;
  error?: { message: string };
}

/** CO-OPS times are "yyyy-MM-dd HH:mm" in the requested zone (we ask for GMT). */
const coopsTime = (t: string) => `${t.replace(" ", "T")}:00Z`;

export function parseTideEvents(raw: CoopsPredictions): TideEvent[] {
  if (raw.error) throw new Error(raw.error.message);
  return (raw.predictions ?? [])
    .map((p) => ({
      time: coopsTime(p.t),
      height: Number(p.v),
      type: (p.type === "H" ? "high" : "low") as TideEvent["type"],
    }))
    .filter((e) => Number.isFinite(e.height));
}

export function parseTideCurve(raw: CoopsPredictions): Array<{ time: string; height: number }> {
  if (raw.error) throw new Error(raw.error.message);
  return (raw.predictions ?? [])
    .map((p) => ({ time: coopsTime(p.t), height: Number(p.v) }))
    .filter((p) => Number.isFinite(p.height));
}

export interface NdbcRow {
  id?: string;
  time?: string;
  values: Record<string, number | undefined>;
}

/**
 * NDBC fixed-width text (realtime2 or latest_obs). Columns are named by the
 * first `#` header line; `MM` marks a missing value.
 */
export function parseNdbc(text: string): NdbcRow[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = lines[0]?.replace(/^#/, "").trim().split(/\s+/) ?? [];
  const rows: NdbcRow[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const cells = line.trim().split(/\s+/);
    const values: Record<string, number | undefined> = {};
    let id: string | undefined;
    header.forEach((name, i) => {
      const cell = cells[i];
      if (name === "STN") {
        id = cell;
        return;
      }
      if (cell === undefined || cell === "MM") return;
      const v = Number(cell);
      if (Number.isFinite(v)) values[name] = v;
    });
    const year = values.YYYY ?? values.YY;
    const time =
      year !== undefined &&
      values.MM !== undefined &&
      values.DD !== undefined &&
      values.hh !== undefined
        ? new Date(
            Date.UTC(year, values.MM - 1, values.DD, values.hh, values.mm ?? 0),
          ).toISOString()
        : undefined;
    rows.push({ id, time, values });
  }
  return rows;
}

export function nearestBuoy(
  rows: NdbcRow[],
  lat: number,
  lon: number,
  now = Date.now(),
  maxKm = BUOY_MAX_KM,
): Marine["buoy"] {
  const fresh = rows.filter(
    (r) =>
      r.id &&
      r.time &&
      now - Date.parse(r.time) < 6 * 3_600_000 &&
      (r.values.WVHT !== undefined || r.values.WTMP !== undefined || r.values.WSPD !== undefined),
  );
  const pos = (r: NdbcRow) =>
    r.values.LAT !== undefined && r.values.LON !== undefined
      ? { lat: r.values.LAT, lon: r.values.LON }
      : undefined;
  // Prefer a real wave buoy; fall back to the nearest coastal (C-MAN/PORTS) station.
  const hit =
    nearest(
      fresh.filter((r) => r.values.WVHT !== undefined),
      lat,
      lon,
      pos,
      maxKm,
    ) ?? nearest(fresh, lat, lon, pos, maxKm);
  if (!hit) return undefined;
  const v = hit.item.values;
  const kmh = (ms: number | undefined) => (ms === undefined ? undefined : Math.round(ms * 36) / 10);
  return {
    provider: "ndbc",
    id: hit.item.id ?? "",
    lat: v.LAT ?? 0,
    lon: v.LON ?? 0,
    distanceKm: Math.round(hit.distanceKm * 10) / 10,
    time: hit.item.time ?? "",
    windDirection: v.WDIR,
    windSpeed: kmh(v.WSPD),
    windGust: kmh(v.GST),
    waveHeight: v.WVHT,
    dominantPeriod: v.DPD,
    waveDirection: v.MWD,
    pressure: v.PRES,
    airTemperature: v.ATMP,
    waterTemperature: v.WTMP,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

async function fetchTides(
  http: HttpClient,
  lat: number,
  lon: number,
  now = new Date(),
): Promise<Marine["tides"]> {
  const stations = await http.json<{ stations: CoopsStation[] }>(COOPS_STATIONS, {
    ttlMs: 30 * 86_400_000,
    timeoutMs: 30_000,
  });
  const station = nearestTideStation(stations, lat, lon);
  if (!station) return undefined;
  // Start at UTC midnight so the URL (and cache entry) is stable all day; 72 h covers "next 48 h".
  const base = {
    begin_date: ymd(now),
    range: "72",
    station: station.id,
    product: "predictions",
    datum: "MLLW",
    units: "metric",
    time_zone: "gmt",
    format: "json",
    application: "wxo",
  };
  const [hilo, curve] = await Promise.all([
    http.json<CoopsPredictions>(
      `${COOPS_DATA}?${new URLSearchParams({ ...base, interval: "hilo" })}`,
      {
        ttlMs: 12 * 3_600_000,
      },
    ),
    http.json<CoopsPredictions>(
      `${COOPS_DATA}?${new URLSearchParams({ ...base, interval: "h" })}`,
      {
        ttlMs: 12 * 3_600_000,
      },
    ),
  ]);
  return {
    provider: "noaa-coops",
    station,
    events: parseTideEvents(hilo),
    curve: parseTideCurve(curve),
  };
}

async function fetchBuoy(http: HttpClient, lat: number, lon: number): Promise<Marine["buoy"]> {
  const text = await http.text(NDBC_LATEST, { ttlMs: 30 * 60_000, timeoutMs: 20_000 });
  return nearestBuoy(parseNdbc(text), lat, lon);
}

/** Resolves to undefined for inland locations, so nothing else is downloaded. */
export async function fetchMarine(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
): Promise<Marine | undefined> {
  const vars = "wave_height,wave_direction,wave_period,sea_surface_temperature";
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: vars,
    hourly: vars,
    forecast_days: "3",
    timezone: "auto",
  });
  const waves = parseWaves(
    await http.json<MarineResponse>(`${MARINE_URL}?${params}`, { ttlMs: 60 * 60_000 }),
  );
  if (!waves) return undefined;
  const [tides, buoy] = await Promise.all([
    fetchTides(http, loc.lat, loc.lon).catch(() => undefined),
    fetchBuoy(http, loc.lat, loc.lon).catch(() => undefined),
  ]);
  return { waves, tides, buoy };
}
