import type { Alert, Location } from "./domain/types.ts";
import {
  fetchEcccAlertsForPoint,
  fetchMeteoAlarm,
  fetchMetnoAlerts,
  fetchSwic,
  METEOALARM_FEEDS,
} from "./providers/alerts-intl.ts";
import { fetchNwsAlertsForPoint } from "./providers/nws.ts";
import type { HttpClient } from "./util/http.ts";

export const US_LIKE = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);

export interface AlertSource {
  /** Provider name used in ProviderError entries. */
  provider: string;
  fetch(http: HttpClient, location: Location): Promise<Alert[]>;
}

/** Place names to match against providers that only give area names. */
export function placeNames(location: Location): string[] {
  return [location.name, location.region].filter((s): s is string => Boolean(s?.trim()));
}

/**
 * Pick the best alert provider for a location: NWS (US), Environment Canada,
 * MET Norway, MeteoAlarm (Europe), else WMO SWIC headlines. With no country
 * code we try NWS, which fails fast outside the US.
 */
export function alertSourceFor(location: Location): AlertSource {
  const cc = location.countryCode?.toUpperCase();
  if (!cc || US_LIKE.has(cc)) {
    return {
      provider: "nws-alerts",
      fetch: (http, l) => fetchNwsAlertsForPoint(http, l.lat, l.lon),
    };
  }
  if (cc === "CA") {
    return { provider: "eccc", fetch: (http, l) => fetchEcccAlertsForPoint(http, l.lat, l.lon) };
  }
  if (cc === "NO" || cc === "SJ") {
    return { provider: "met-norway", fetch: (http, l) => fetchMetnoAlerts(http, l) };
  }
  if (METEOALARM_FEEDS[cc]) {
    return { provider: "meteoalarm", fetch: (http, l) => fetchMeteoAlarm(http, cc, placeNames(l)) };
  }
  return { provider: "wmo-swic", fetch: (http, l) => fetchSwic(http, cc, placeNames(l)) };
}
