import { type Hazards, type ProviderError, SCHEMA_VERSION, type Storm } from "./domain/types.ts";
import { fetchEcccAlerts, fetchMetnoAlerts } from "./providers/alerts-intl.ts";
import {
  fetchEonetEvents,
  fetchGdacsEvents,
  fetchUsgsVolcanoes,
  mergeEvents,
} from "./providers/events.ts";
import {
  fetchCalFire,
  fetchCanadaFires,
  fetchCwfisHotspots,
  fetchFirmsHotspots,
  fetchNifcIncidents,
  fetchNifcPerimeters,
  mergeFires,
} from "./providers/fires.ts";
import { fetchGdacsCyclones } from "./providers/gdacs.ts";
import { fetchJtwcStorms } from "./providers/jtwc.ts";
import { fetchNhcStorms } from "./providers/nhc.ts";
import { fetchNwsAlertsNational } from "./providers/nws.ts";
import { fetchOutlooks } from "./providers/spc.ts";
import { fetchSpaceWeather } from "./providers/swpc.ts";
import { fetchNearbyQuakes, fetchQuakes } from "./providers/usgs.ts";
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

/**
 * Merge storm lists in priority order (NHC's detailed tracks, then JTWC, then
 * GDACS), dropping later storms that duplicate an earlier one by name or position.
 */
export function mergeStorms(...sources: Storm[][]): Storm[] {
  const out: Storm[] = [];
  for (const list of sources) {
    for (const s of list) {
      const dup = out.some(
        (o) =>
          o.name.toLowerCase() === s.name.toLowerCase() ||
          (Math.abs(o.lat - s.lat) < 2 && Math.abs(o.lon - s.lon) < 2),
      );
      if (!dup) out.push(s);
    }
  }
  return out.sort((a, b) => b.category - a.category);
}

export interface HazardOptions {
  hotspots?: boolean;
  /** NASA FIRMS MAP_KEY for higher-resolution VIIRS hotspots (default: env FIRMS_MAP_KEY). */
  firmsKey?: string;
  /** Location for the nearby small-quake query. */
  near?: { lat: number; lon: number };
  /** Regional alert polygons for the map (NWS national, Canada, Norway). Default true. */
  alerts?: boolean;
  /** How many NWS forecast zones to fetch for polygon-less severe alerts (0 = none). */
  alertZones?: number;
}

export async function fetchHazards(http: HttpClient, opts: HazardOptions = {}): Promise<Hazards> {
  const errors: ProviderError[] = [];
  const near = opts.near;
  const wantAlerts = opts.alerts !== false;
  const [
    nhc,
    jtwc,
    gdacs,
    nifc,
    calfire,
    canada,
    perimeters,
    hotspots,
    cwfisHotspots,
    quakes,
    nearbyQuakes,
    space,
    nwsAlerts,
    ecccAlerts,
    metnoAlerts,
    volcanoes,
    eonet,
    gdacsEvents,
    outlooks,
  ] = await Promise.all([
    attempt("nhc", errors, () => fetchNhcStorms(http), []),
    attempt("jtwc", errors, () => fetchJtwcStorms(http), []),
    attempt("gdacs", errors, () => fetchGdacsCyclones(http), []),
    attempt("nifc", errors, () => fetchNifcIncidents(http), []),
    attempt("calfire", errors, () => fetchCalFire(http), []),
    attempt("cwfif", errors, () => fetchCanadaFires(http), []),
    attempt("nifc-perimeters", errors, () => fetchNifcPerimeters(http), []),
    opts.hotspots === false
      ? Promise.resolve([])
      : attempt(
          "firms",
          errors,
          () =>
            fetchFirmsHotspots(http, opts.firmsKey ?? process.env.FIRMS_MAP_KEY, (message) =>
              errors.push({ provider: "firms", message }),
            ),
          [],
        ),
    opts.hotspots === false
      ? Promise.resolve([])
      : attempt("cwfis", errors, () => fetchCwfisHotspots(http), []),
    attempt("usgs", errors, () => fetchQuakes(http, "2.5_day"), []),
    near
      ? attempt("usgs-fdsn", errors, () => fetchNearbyQuakes(http, near.lat, near.lon), [])
      : Promise.resolve(undefined),
    attempt("swpc", errors, () => fetchSpaceWeather(http), undefined),
    wantAlerts
      ? attempt(
          "nws-national",
          errors,
          () => fetchNwsAlertsNational(http, { maxZones: opts.alertZones ?? 0 }),
          [],
        )
      : Promise.resolve([]),
    wantAlerts ? attempt("eccc", errors, () => fetchEcccAlerts(http), []) : Promise.resolve([]),
    wantAlerts
      ? attempt("met-norway", errors, () => fetchMetnoAlerts(http), [])
      : Promise.resolve([]),
    attempt("usgs-hans", errors, () => fetchUsgsVolcanoes(http), []),
    attempt("eonet", errors, () => fetchEonetEvents(http), []),
    attempt("gdacs-events", errors, () => fetchGdacsEvents(http), []),
    attempt("spc", errors, () => fetchOutlooks(http), []),
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    storms: mergeStorms(nhc, jtwc, gdacs),
    fires: mergeFires(nifc, calfire, canada),
    hotspots: [...hotspots, ...cwfisHotspots],
    quakes,
    space,
    alerts: wantAlerts ? [...nwsAlerts, ...ecccAlerts, ...metnoAlerts] : undefined,
    nearbyQuakes,
    perimeters,
    events: mergeEvents(volcanoes, gdacsEvents, eonet),
    outlooks,
    errors,
  };
}
