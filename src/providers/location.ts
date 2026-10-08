import type { Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { geocode } from "./open-meteo.ts";

interface IpWhoResponse {
  success: boolean;
  city?: string;
  region?: string;
  country?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
  timezone?: { id?: string };
}

export async function locateByIp(http: HttpClient): Promise<Location> {
  const raw = await http.json<IpWhoResponse>("https://ipwho.is/", { ttlMs: 60 * 60_000 });
  if (!raw.success || raw.latitude === undefined || raw.longitude === undefined) {
    throw new Error("Could not determine your location from your IP address");
  }
  return {
    name: raw.city ?? "Your location",
    region: raw.region,
    country: raw.country,
    countryCode: raw.country_code,
    lat: raw.latitude,
    lon: raw.longitude,
    timezone: raw.timezone?.id,
    source: "ip",
  };
}

const COORDS_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseCoords(q: string): { lat: number; lon: number } | undefined {
  const m = COORDS_RE.exec(q);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

/**
 * Resolve a free-form query into a location.
 * Accepts "lat,lon", "City", "City, Region", or nothing (IP geolocation).
 */
export async function resolveLocation(http: HttpClient, query?: string): Promise<Location> {
  if (!query?.trim()) return locateByIp(http);
  const coords = parseCoords(query);
  if (coords) {
    return {
      name: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
      ...coords,
      source: "coords",
    };
  }
  // Open-Meteo's geocoder matches on place name only, so search the first
  // segment and use any remaining segments to rank (e.g. "Paris, TX").
  const [head = query, ...rest] = query.split(",").map((s) => s.trim());
  const results = await geocode(http, head, 10);
  if (!results.length) throw new Error(`No place found matching "${query}"`);
  if (!rest.length) return results[0] as Location;
  const hint = rest.join(" ").toLowerCase();
  const scored = results.map((r) => {
    const hay = [r.region, r.country, r.countryCode].filter(Boolean).join(" ").toLowerCase();
    return {
      r,
      score:
        hay.includes(hint) || hint.split(/\s+/).some((h) => hay.split(/\s+/).includes(h)) ? 1 : 0,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.r as Location;
}
