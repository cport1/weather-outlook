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

const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  PR: "Puerto Rico",
};

/** Expand a disambiguation hint like "TX" or "Texas, US" into lowercase match terms. */
export function hintTerms(hint: string): string[] {
  const raw = hint.trim();
  const state = US_STATES[raw.toUpperCase()];
  const expanded = state ? `${state} us` : raw;
  return expanded
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
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
  const terms = hintTerms(rest.join(" "));
  const scored = results.map((r) => {
    const hay = [r.region, r.country, r.countryCode]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .split(/\s+/);
    // Count matched terms so "Springfield, IL" beats a result matching only "US".
    return { r, score: terms.filter((t) => hay.includes(t)).length };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.r as Location;
}
