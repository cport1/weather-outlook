import type { ModelComparison, ModelSeries } from "../domain/details.ts";
import type { Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { withOffset } from "./open-meteo.ts";

/**
 * Model comparison: deterministic models from Open-Meteo, an ensemble
 * (min/max/mean band) from the Open-Meteo ensemble API, and MET Norway's
 * locationforecast as a fully independent source.
 */

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
const METNO_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

export const MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "best_match", label: "Best match" },
  { id: "gfs_seamless", label: "GFS" },
  { id: "ecmwf_ifs025", label: "ECMWF" },
  { id: "icon_seamless", label: "ICON" },
];
const ENSEMBLE_MODEL = "ecmwf_ifs025";
const DAYS = 7;

interface HourlyResponse {
  utc_offset_seconds: number;
  hourly: Record<string, Array<number | null> | undefined> & { time: string[] };
}

interface MetNoResponse {
  properties: {
    timeseries: Array<{
      time: string;
      data: { instant: { details: { air_temperature?: number } } };
    }>;
  };
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function parseModels(raw: HourlyResponse): { times: string[]; models: ModelSeries[] } {
  const times = raw.hourly.time.map((t) => withOffset(t, raw.utc_offset_seconds));
  const models: ModelSeries[] = [];
  for (const m of MODELS) {
    const series = raw.hourly[`temperature_2m_${m.id}`];
    if (!series?.some(finite)) continue;
    models.push({
      id: m.id,
      label: m.label,
      temperature: series.map((v) => (finite(v) ? v : null)),
    });
  }
  return { times, models };
}

export function parseEnsemble(raw: HourlyResponse, model = ENSEMBLE_MODEL) {
  const members = Object.entries(raw.hourly)
    .filter(([k]) => k === "temperature_2m" || k.startsWith("temperature_2m_member"))
    .map(([, v]) => (v ?? []) as Array<number | null>);
  const n = raw.hourly.time.length;
  const min: Array<number | null> = [];
  const max: Array<number | null> = [];
  const mean: Array<number | null> = [];
  const std: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    const vals = members.map((m) => m[i]).filter(finite);
    if (!vals.length) {
      min.push(null);
      max.push(null);
      mean.push(null);
      std.push(null);
      continue;
    }
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    min.push(Math.min(...vals));
    max.push(Math.max(...vals));
    mean.push(Math.round(mu * 10) / 10);
    std.push(Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length));
  }
  return {
    times: raw.hourly.time.map((t) => withOffset(t, raw.utc_offset_seconds)),
    ensemble: { model, members: members.length, min, max, mean },
    std,
  };
}

/** MET Norway series re-sampled onto `times` (hourly for ~2.5 days, then 6-hourly → nulls between). */
export function alignMetNo(raw: MetNoResponse, times: string[]): Array<number | null> {
  const byHour = new Map<number, number>();
  for (const t of raw.properties.timeseries) {
    const v = t.data.instant.details.air_temperature;
    if (finite(v)) byHour.set(Date.parse(t.time), v);
  }
  return times.map((t) => byHour.get(Date.parse(t)) ?? null);
}

/**
 * Forecast confidence from ensemble spread (and model disagreement): 100 means
 * the members agree to within a fraction of a degree over the next `hours`.
 */
export function confidence(
  times: string[],
  std: Array<number | null> | undefined,
  models: ModelSeries[],
  now = Date.now(),
  hours = 72,
): ModelComparison["confidence"] {
  const idx = times
    .map((t, i) => [Date.parse(t), i] as const)
    .filter(([t]) => t >= now - 3_600_000 && t <= now + hours * 3_600_000)
    .map(([, i]) => i);
  if (!idx.length) return undefined;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const spread = avg(idx.map((i) => std?.[i]).filter(finite));
  const modelSpread = avg(
    idx
      .map((i) => models.map((m) => m.temperature[i]).filter(finite))
      .filter((v) => v.length >= 2)
      .map((v) => Math.max(...v) - Math.min(...v)),
  );
  // Without an ensemble, the model range is roughly 2.5 standard deviations wide.
  const sigma = spread ?? (modelSpread !== undefined ? modelSpread / 2.5 : undefined);
  if (sigma === undefined) return undefined;
  const score = Math.round(Math.max(0, Math.min(100, 100 - sigma * 15)));
  return {
    score,
    label: score >= 75 ? "high" : score >= 50 ? "moderate" : "low",
    spread: Math.round(sigma * 10) / 10,
    modelSpread: modelSpread !== undefined ? Math.round(modelSpread * 10) / 10 : undefined,
    hours,
  };
}

export async function fetchModelComparison(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
): Promise<ModelComparison> {
  const common = {
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    hourly: "temperature_2m",
    forecast_days: String(DAYS),
    timezone: "auto",
  };
  const det = new URLSearchParams({ ...common, models: MODELS.map((m) => m.id).join(",") });
  const ens = new URLSearchParams({ ...common, models: ENSEMBLE_MODEL });
  // MET Norway asks for at most 4 decimals in coordinates.
  const metUrl = `${METNO_URL}?lat=${Number(loc.lat.toFixed(4))}&lon=${Number(loc.lon.toFixed(4))}`;
  const [detRaw, ensRaw, metRaw] = await Promise.all([
    http.json<HourlyResponse>(`${FORECAST_URL}?${det}`, { ttlMs: 30 * 60_000 }),
    http
      .json<HourlyResponse>(`${ENSEMBLE_URL}?${ens}`, { ttlMs: 60 * 60_000 })
      .catch(() => undefined),
    http.json<MetNoResponse>(metUrl, { ttlMs: 30 * 60_000 }).catch(() => undefined),
  ]);
  const { times, models } = parseModels(detRaw);
  if (metRaw) {
    const met = alignMetNo(metRaw, times);
    if (met.some(finite)) models.push({ id: "met_norway", label: "MET Norway", temperature: met });
  }
  const e = ensRaw ? parseEnsemble(ensRaw) : undefined;
  // The ensemble shares the forecast's hourly grid; guard anyway.
  const aligned = e && e.times.length === times.length && e.times[0] === times[0];
  return {
    times,
    models,
    ensemble: aligned ? e.ensemble : undefined,
    confidence: confidence(times, aligned ? e.std : undefined, models),
  };
}
