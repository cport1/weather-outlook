import { computeAstronomy } from "./domain/astronomy.ts";
import { type Location, type ProviderError, type Report, SCHEMA_VERSION } from "./domain/types.ts";
import { fetchNwsAlertsForPoint } from "./providers/nws.ts";
import { fetchAirQuality, fetchForecast } from "./providers/open-meteo.ts";
import type { Units } from "./render/units.ts";
import type { HttpClient } from "./util/http.ts";

const US_LIKE = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);

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

export interface ReportOptions {
  refresh?: boolean;
  /** Skip providers the caller won't show (`--format`, `--fields`). All default to true. */
  include?: { forecast?: boolean; airQuality?: boolean; alerts?: boolean };
}

export async function buildReport(
  http: HttpClient,
  location: Location,
  units: Units,
  opts: ReportOptions = {},
): Promise<Report> {
  const errors: ProviderError[] = [];
  const want = { forecast: true, airQuality: true, alerts: true, ...opts.include };
  // Only ask NWS when we're plausibly in the US; unknown country → try anyway, it fails fast.
  const wantNws =
    want.alerts && (!location.countryCode || US_LIKE.has(location.countryCode.toUpperCase()));
  const [forecast, airQuality, alerts] = await Promise.all([
    want.forecast
      ? attempt("open-meteo", errors, () =>
          fetchForecast(http, location, { refresh: opts.refresh }),
        )
      : undefined,
    want.airQuality
      ? attempt("open-meteo-aq", errors, () => fetchAirQuality(http, location))
      : undefined,
    wantNws
      ? attempt("nws-alerts", errors, () =>
          fetchNwsAlertsForPoint(http, location.lat, location.lon),
        )
      : Promise.resolve([]),
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    units,
    location,
    forecast,
    airQuality,
    astronomy: computeAstronomy(location.lat, location.lon),
    alerts: alerts ?? [],
    errors,
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
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

const FIELD_ALIASES: Record<string, ReportField> = { aq: "airQuality", air: "airQuality" };

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
export function fieldsNeeds(fields: ReportField[]): NonNullable<ReportOptions["include"]> {
  const has = (...f: ReportField[]) => f.some((x) => fields.includes(x));
  return {
    forecast: has("current", "hourly", "daily", "forecast"),
    airQuality: has("airQuality"),
    alerts: has("alerts"),
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
