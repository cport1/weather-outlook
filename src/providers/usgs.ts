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
