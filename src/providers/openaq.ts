import type { AqStation } from "../domain/details.ts";
import type { Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * OpenAQ v3 ground-station readings. Optional: only used when
 * OPENAQ_API_KEY is set (the v3 API requires an `X-API-Key` header).
 */

const API = "https://api.openaq.org/v3";

interface LocationsResponse {
  results: Array<{
    id: number;
    name: string | null;
    locality?: string | null;
    distance?: number | null;
    sensors: Array<{ id: number; parameter: { name: string; units: string } }>;
    datetimeLast?: { utc: string } | null;
  }>;
}

interface LatestResponse {
  results: Array<{ datetime: { utc: string }; value: number; sensorsId: number }>;
}

export function parseOpenAq(
  locations: LocationsResponse,
  latest: LatestResponse,
): AqStation | undefined {
  const loc = locations.results[0];
  if (!loc) return undefined;
  const sensors = new Map(loc.sensors.map((s) => [s.id, s.parameter]));
  const readings: AqStation["readings"] = {};
  let time: string | undefined;
  for (const r of latest.results) {
    const p = sensors.get(r.sensorsId);
    // OpenAQ uses negative sentinels (e.g. -999) for invalid readings.
    if (!p || !Number.isFinite(r.value) || r.value < 0) continue;
    readings[p.name] = { value: r.value, units: p.units };
    if (!time || r.datetime.utc > time) time = r.datetime.utc;
  }
  return {
    provider: "openaq",
    id: loc.id,
    name: [loc.name, loc.locality].filter(Boolean).join(", ") || `#${loc.id}`,
    distanceKm: typeof loc.distance === "number" ? Math.round(loc.distance / 100) / 10 : undefined,
    time: time ?? loc.datetimeLast?.utc,
    readings,
  };
}

export async function fetchOpenAq(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
  apiKey: string,
): Promise<AqStation | undefined> {
  const headers = { "X-API-Key": apiKey };
  const params = new URLSearchParams({
    coordinates: `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,
    radius: "25000",
    limit: "5",
  });
  const locations = await http.json<LocationsResponse>(`${API}/locations?${params}`, {
    ttlMs: 7 * 86_400_000,
    headers,
  });
  // Results are sorted by distance when querying by coordinates.
  locations.results.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  const first = locations.results[0];
  if (!first) return undefined;
  const latest = await http.json<LatestResponse>(`${API}/locations/${first.id}/latest`, {
    ttlMs: 30 * 60_000,
    headers,
  });
  return parseOpenAq(locations, latest);
}
