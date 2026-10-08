import { type Hazards, type ProviderError, SCHEMA_VERSION, type Storm } from "./domain/types.ts";
import { fetchFirmsHotspots, fetchNifcIncidents } from "./providers/fires.ts";
import { fetchGdacsCyclones } from "./providers/gdacs.ts";
import { fetchNhcStorms } from "./providers/nhc.ts";
import { fetchSpaceWeather } from "./providers/swpc.ts";
import { fetchQuakes } from "./providers/usgs.ts";
import type { HttpClient } from "./util/http.ts";

async function attempt<T>(
  provider: string,
  errors: ProviderError[],
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push({ provider, message: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

/** Prefer NHC's detailed tracks; add GDACS storms from basins NHC doesn't cover. */
export function mergeStorms(nhc: Storm[], gdacs: Storm[]): Storm[] {
  const known = new Set(nhc.map((s) => s.name.toLowerCase()));
  const extra = gdacs.filter(
    (g) =>
      !known.has(g.name.toLowerCase()) &&
      !nhc.some((s) => Math.abs(s.lat - g.lat) < 2 && Math.abs(s.lon - g.lon) < 2),
  );
  return [...nhc, ...extra].sort((a, b) => b.category - a.category);
}

export interface HazardOptions {
  hotspots?: boolean;
}

export async function fetchHazards(http: HttpClient, opts: HazardOptions = {}): Promise<Hazards> {
  const errors: ProviderError[] = [];
  const [nhc, gdacs, fires, hotspots, quakes, space] = await Promise.all([
    attempt("nhc", errors, () => fetchNhcStorms(http), []),
    attempt("gdacs", errors, () => fetchGdacsCyclones(http), []),
    attempt("nifc", errors, () => fetchNifcIncidents(http), []),
    opts.hotspots === false
      ? Promise.resolve([])
      : attempt("firms", errors, () => fetchFirmsHotspots(http), []),
    attempt("usgs", errors, () => fetchQuakes(http, "2.5_day"), []),
    attempt("swpc", errors, () => fetchSpaceWeather(http), undefined),
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    storms: mergeStorms(nhc, gdacs),
    fires,
    hotspots,
    quakes,
    space,
    errors,
  };
}
