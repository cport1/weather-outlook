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

export async function buildReport(
  http: HttpClient,
  location: Location,
  units: Units,
  opts: { refresh?: boolean } = {},
): Promise<Report> {
  const errors: ProviderError[] = [];
  // Only ask NWS when we're plausibly in the US; unknown country → try anyway, it fails fast.
  const wantNws = !location.countryCode || US_LIKE.has(location.countryCode.toUpperCase());
  const [forecast, airQuality, alerts] = await Promise.all([
    attempt("open-meteo", errors, () => fetchForecast(http, location, { refresh: opts.refresh })),
    attempt("open-meteo-aq", errors, () => fetchAirQuality(http, location)),
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
