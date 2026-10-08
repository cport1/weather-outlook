import type { Quake } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url?: string;
    tsunami?: number;
    alert?: string | null;
  };
  geometry: { coordinates: [number, number, number] };
}

export type QuakeFeed = "2.5_day" | "4.5_week" | "significant_month" | "all_hour";

export function parseQuakes(raw: { features: UsgsFeature[] }): Quake[] {
  return raw.features
    .filter((f) => f.properties.mag !== null)
    .map((f) => ({
      id: f.id,
      provider: "usgs",
      magnitude: f.properties.mag as number,
      place: f.properties.place ?? "Unknown location",
      time: new Date(f.properties.time).toISOString(),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      depthKm: f.geometry.coordinates[2],
      tsunami: f.properties.tsunami === 1,
      alert: f.properties.alert ?? undefined,
      url: f.properties.url,
    }))
    .sort((a, b) => b.magnitude - a.magnitude);
}

export async function fetchQuakes(http: HttpClient, feed: QuakeFeed = "2.5_day"): Promise<Quake[]> {
  const raw = await http.json<{ features: UsgsFeature[] }>(
    `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`,
    { ttlMs: 5 * 60_000 },
  );
  return parseQuakes(raw);
}

/**
 * Small quakes near a point (FDSN event service), newest first.
 * The start date is day-aligned so the cache key stays stable between refreshes.
 */
export async function fetchNearbyQuakes(
  http: HttpClient,
  lat: number,
  lon: number,
  opts: { radiusKm?: number; minMagnitude?: number; days?: number; now?: Date } = {},
): Promise<Quake[]> {
  const now = opts.now ?? new Date();
  const start = new Date(now.getTime() - (opts.days ?? 7) * 86_400_000).toISOString().slice(0, 10);
  const url =
    "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
    `&latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&maxradiuskm=${opts.radiusKm ?? 300}` +
    `&minmagnitude=${opts.minMagnitude ?? 1.5}&starttime=${start}&orderby=time&limit=100`;
  const raw = await http.json<{ features: UsgsFeature[] }>(url, {
    ttlMs: 5 * 60_000,
    timeoutMs: 15_000,
  });
  return parseQuakes(raw).sort((a, b) => b.time.localeCompare(a.time));
}
