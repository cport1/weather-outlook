import { alertSourceFor, US_LIKE } from "./alerts.ts";
import { computeAstronomy } from "./domain/astronomy.ts";
import type { Nowcast } from "./domain/details.ts";
import {
  type Forecast,
  type Location,
  type ProviderError,
  type Report,
  SCHEMA_VERSION,
} from "./domain/types.ts";
import { fetchClimate } from "./providers/climate.ts";
import { fetchMarine } from "./providers/marine.ts";
import { fetchModelComparison } from "./providers/models.ts";
import { fetchNowcast } from "./providers/nowcast.ts";
import { fetchNwsDetails } from "./providers/nws-forecast.ts";
import { fetchAirQuality, fetchForecast } from "./providers/open-meteo.ts";
import { fetchOpenAq } from "./providers/openaq.ts";
import { openMeteo, type ResolvedProvider } from "./providers/registry.ts";
import { fetchOutlooks, risksAt } from "./providers/spc.ts";
import type { Units } from "./render/units.ts";
import type { HttpClient } from "./util/http.ts";

/** Run a provider call, capturing failure as a ProviderError instead of throwing. */
async function attempt<T>(
  provider: string,
  errors: ProviderError[],
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    errors.push({ provider, message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** Everything buildReport can fetch. */
export interface ReportInclude {
  forecast?: boolean;
  airQuality?: boolean;
  alerts?: boolean;
  /** Minute-scale precipitation (Open-Meteo minutely_15 / MET Norway nowcast). */
  nowcast?: boolean;
  /** NWS text forecast, observation, grid extras and AFD (US only). */
  nws?: boolean;
  /** Multi-model + ensemble comparison. */
  models?: boolean;
  /** Waves, tides and buoys (coastal only). */
  marine?: boolean;
  /** 30-year normals vs the forecast (needs the forecast). */
  climate?: boolean;
}

export interface ReportOptions {
  refresh?: boolean;
  /**
   * Skip providers the caller won't show (`--format`, `--fields`). Without it
   * everything is fetched; with it, anything not set to true is skipped.
   */
  include?: ReportInclude;
  /** Primary forecast source (default Open-Meteo). */
  provider?: ResolvedProvider;
  env?: Record<string, string | undefined>;
}

const ALL: Required<ReportInclude> = {
  forecast: true,
  airQuality: true,
  alerts: true,
  nowcast: true,
  nws: true,
  models: true,
  marine: true,
  climate: true,
};

export async function buildReport(
  http: HttpClient,
  location: Location,
  units: Units,
  opts: ReportOptions = {},
): Promise<Report> {
  const errors: ProviderError[] = [];
  const env = opts.env ?? process.env;
  const want: Required<ReportInclude> = opts.include
    ? (Object.fromEntries(
        Object.keys(ALL).map((k) => [k, opts.include?.[k as keyof ReportInclude] === true]),
      ) as Required<ReportInclude>)
    : ALL;
  // Regional alert provider (NWS, Environment Canada, MET Norway, MeteoAlarm, WMO).
  const alertSource = alertSourceFor(location);
  // SPC/WPC outlooks and NWS products only cover the US.
  const cc = location.countryCode?.toUpperCase();
  const inUs = cc ? US_LIKE.has(cc) : location.lon < -60 && location.lat > 20;
  const wantOutlooks = want.alerts && inUs;
  const chosen = opts.provider ?? { provider: openMeteo };

  let keyedNowcast: Nowcast | undefined;
  // Climate compares against the forecast, so it needs one even when it isn't shown.
  const primary: Promise<Forecast | undefined> =
    want.forecast || want.climate
      ? (async () => {
          if (chosen.provider.id !== openMeteo.id) {
            const res = await attempt(chosen.provider.id, errors, () =>
              chosen.provider.fetch(http, location, { key: chosen.key, refresh: opts.refresh }),
            );
            if (res) {
              keyedNowcast = res.nowcast;
              return res.forecast;
            }
            // Fall through to Open-Meteo so a bad key never leaves the report empty.
          }
          return attempt("open-meteo", errors, () =>
            fetchForecast(http, location, { refresh: opts.refresh }),
          );
        })()
      : Promise.resolve(undefined);

  const openAqKey = env.OPENAQ_API_KEY?.trim();
  const [forecast, airQuality, stations, alerts, outlooks, nws, models, marine, nowcast, climate] =
    await Promise.all([
      primary,
      want.airQuality
        ? attempt("open-meteo-aq", errors, () => fetchAirQuality(http, location))
        : undefined,
      want.airQuality && openAqKey
        ? attempt("openaq", errors, () => fetchOpenAq(http, location, openAqKey))
        : undefined,
      want.alerts
        ? attempt(alertSource.provider, errors, () => alertSource.fetch(http, location))
        : Promise.resolve([]),
      wantOutlooks
        ? attempt("spc", errors, () => fetchOutlooks(http, "day1"))
        : Promise.resolve(undefined),
      want.nws && inUs
        ? attempt("nws", errors, () => fetchNwsDetails(http, location.lat, location.lon))
        : undefined,
      want.models
        ? attempt("models", errors, () => fetchModelComparison(http, location))
        : undefined,
      want.marine ? attempt("marine", errors, () => fetchMarine(http, location)) : undefined,
      want.nowcast ? attempt("nowcast", errors, () => fetchNowcast(http, location)) : undefined,
      want.climate
        ? primary.then((fc) =>
            fc?.daily.length
              ? attempt("climate", errors, () => fetchClimate(http, location, fc.daily))
              : undefined,
          )
        : undefined,
    ]);
  if (airQuality && stations) airQuality.stations = [stations];
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    units,
    location,
    forecast: want.forecast ? forecast : undefined,
    airQuality,
    astronomy: computeAstronomy(location.lat, location.lon),
    alerts: alerts ?? [],
    risks: outlooks ? risksAt(outlooks, location.lat, location.lon) : undefined,
    errors,
    nowcast: want.nowcast ? (keyedNowcast ?? nowcast) : undefined,
    nws,
    models,
    marine,
    climate,
  };
}

/** Top-level `--fields` names; `current`, `hourly` and `daily` reach into the forecast. */
export const REPORT_FIELDS = [
  "location",
  "current",
  "hourly",
  "daily",
  "forecast",
  "airQuality",
  "astronomy",
  "alerts",
  "errors",
  "nowcast",
  "nws",
  "models",
  "marine",
  "climate",
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

const FIELD_ALIASES: Record<string, ReportField> = {
  aq: "airQuality",
  air: "airQuality",
  minutely: "nowcast",
  tides: "marine",
  waves: "marine",
  normals: "climate",
};

export function parseFields(spec: string): ReportField[] {
  const out: ReportField[] = [];
  for (const raw of spec.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const field = FIELD_ALIASES[name] ?? REPORT_FIELDS.find((f) => f.toLowerCase() === name);
    if (!field) {
      throw new Error(`Unknown field "${raw.trim()}". Valid fields: ${REPORT_FIELDS.join(", ")}`);
    }
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

/** Providers a field projection actually needs. */
export function fieldsNeeds(fields: ReportField[]): ReportInclude {
  const has = (...f: ReportField[]) => f.some((x) => fields.includes(x));
  return {
    forecast: has("current", "hourly", "daily", "forecast"),
    airQuality: has("airQuality"),
    alerts: has("alerts"),
    nowcast: has("nowcast"),
    nws: has("nws"),
    models: has("models"),
    marine: has("marine"),
    climate: has("climate"),
  };
}

/** `--json --fields current,alerts`: the envelope plus just the requested parts. */
export function projectReport(report: Report, fields: ReportField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    units: report.units,
  };
  for (const f of fields) {
    if (f === "current" || f === "hourly" || f === "daily") out[f] = report.forecast?.[f];
    else out[f] = report[f];
  }
  return out;
}
