import type { Nowcast, NowcastPoint } from "../domain/details.ts";
import type { Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { withOffset } from "./open-meteo.ts";

/**
 * Short-range precipitation nowcast for the next ~2 hours. MET Norway's
 * radar nowcast (5-minute steps) inside the Nordic area, otherwise
 * Open-Meteo's `minutely_15` data.
 */

const OM_URL = "https://api.open-meteo.com/v1/forecast";
const METNO_NOWCAST = "https://api.met.no/weatherapi/nowcast/2.0/complete";

/** Below this rate (mm/h) we call it dry. */
const WET = 0.1;
const HORIZON_MIN = 120;

/** Rough MET Norway nowcast coverage (Norway, Sweden, Finland, Denmark + coasts). */
export function inNordicArea(lat: number, lon: number): boolean {
  return lat >= 54 && lat <= 72 && lon >= 3 && lon <= 32;
}

function intensity(rate: number): string {
  if (rate >= 7.6) return "Heavy";
  if (rate >= 2.5) return "Moderate";
  return "Light";
}

function inMinutes(ms: number): string {
  const m = Math.max(5, Math.round(ms / 60_000 / 5) * 5);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `~${h} h ${r} min` : `~${h} h`;
}

/** One-sentence summary: "Light rain starting in ~30 min", "Rain stopping in ~15 min", … */
export function nowcastHeadline(points: NowcastPoint[], now = Date.now()): string {
  const ahead = points.filter((p) => {
    const t = Date.parse(p.time);
    return t >= now - 15 * 60_000 && t <= now + HORIZON_MIN * 60_000;
  });
  if (!ahead.length) return "No nowcast available";
  const first = ahead[0] as NowcastPoint;
  const last = ahead[ahead.length - 1] as NowcastPoint;
  const span = Math.max(0, Date.parse(last.time) - now);
  const horizon = span >= 110 * 60_000 ? "2 hours" : inMinutes(span).replace("~", "");
  const kind = (p: NowcastPoint) => (p.snow ? "snow" : "rain");
  const peak = Math.max(...ahead.map((p) => p.rate));
  if (first.rate >= WET) {
    const stop = ahead.find((p) => p.rate < WET);
    const k = kind(first);
    if (!stop) return `${intensity(peak)} ${k} for the next ${horizon}`;
    return `${k[0]?.toUpperCase()}${k.slice(1)} stopping in ${inMinutes(Date.parse(stop.time) - now)}`;
  }
  const start = ahead.find((p) => p.rate >= WET);
  if (!start) return `No precipitation expected for the next ${horizon}`;
  const startIdx = ahead.indexOf(start);
  const peakAfter = Math.max(...ahead.slice(startIdx).map((p) => p.rate));
  return `${intensity(peakAfter)} ${kind(start)} starting in ${inMinutes(Date.parse(start.time) - now)}`;
}

interface Minutely15Response {
  utc_offset_seconds: number;
  minutely_15?: {
    time: string[];
    precipitation?: Array<number | null>;
    snowfall?: Array<number | null>;
  };
}

export function parseMinutely15(raw: Minutely15Response, now = Date.now()): Nowcast | undefined {
  const m = raw.minutely_15;
  if (!m?.time.length) return undefined;
  const points: NowcastPoint[] = m.time.map((t, i) => ({
    time: withOffset(t, raw.utc_offset_seconds),
    // mm per 15 minutes → mm/h
    rate: Math.round((m.precipitation?.[i] ?? 0) * 4 * 100) / 100,
    snow: (m.snowfall?.[i] ?? 0) > 0 || undefined,
  }));
  return { provider: "open-meteo", interval: 15, points, headline: nowcastHeadline(points, now) };
}

interface MetNowcastResponse {
  properties: {
    meta?: { radar_coverage?: string };
    timeseries: Array<{
      time: string;
      data: { instant: { details: { precipitation_rate?: number; air_temperature?: number } } };
    }>;
  };
}

export function parseMetNowcast(raw: MetNowcastResponse, now = Date.now()): Nowcast | undefined {
  const ts = raw.properties.timeseries;
  if (!ts.length || (raw.properties.meta?.radar_coverage ?? "ok") !== "ok") return undefined;
  // Temperature is only given on the first step; use it to label snow.
  const t0 = ts[0]?.data.instant.details.air_temperature;
  const points: NowcastPoint[] = ts.map((t) => ({
    time: t.time,
    rate: t.data.instant.details.precipitation_rate ?? 0,
    snow: t0 !== undefined && t0 <= 0 ? true : undefined,
  }));
  return { provider: "met-norway", interval: 5, points, headline: nowcastHeadline(points, now) };
}

export async function fetchNowcast(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
): Promise<Nowcast | undefined> {
  if (inNordicArea(loc.lat, loc.lon)) {
    try {
      const url = `${METNO_NOWCAST}?lat=${Number(loc.lat.toFixed(4))}&lon=${Number(loc.lon.toFixed(4))}`;
      const met = parseMetNowcast(await http.json<MetNowcastResponse>(url, { ttlMs: 5 * 60_000 }));
      if (met) return met;
    } catch {
      // outside radar coverage (422) → fall back to Open-Meteo
    }
  }
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    minutely_15: "precipitation,snowfall",
    forecast_minutely_15: "10",
    past_minutely_15: "1",
    timezone: "auto",
  });
  const raw = await http.json<Minutely15Response>(`${OM_URL}?${params}`, { ttlMs: 10 * 60_000 });
  return parseMinutely15(raw);
}
