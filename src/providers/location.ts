import type { Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";
import { type GeocodeCandidate, geocodeCandidates, lookupTimezone } from "./open-meteo.ts";

// ─── IP geolocation ────────────────────────────────────────────────────────

type IpFix = Omit<Location, "source">;

interface IpApiCoResponse {
  error?: boolean;
  reason?: string;
  city?: string;
  region?: string;
  country_name?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

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

interface GeoJsResponse {
  city?: string;
  region?: string;
  country?: string;
  country_code?: string;
  latitude?: string;
  longitude?: string;
  timezone?: string;
}

interface IpInfoResponse {
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  timezone?: string;
}

const finite = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function fix(
  lat: unknown,
  lon: unknown,
  rest: Omit<IpFix, "lat" | "lon" | "name"> & { name?: string },
): IpFix | undefined {
  const la = finite(lat);
  const lo = finite(lon);
  if (la === undefined || lo === undefined) return undefined;
  return { ...rest, name: rest.name || "Your location", lat: la, lon: lo };
}

export function parseIpApiCo(raw: IpApiCoResponse): IpFix | undefined {
  if (raw.error) return undefined;
  return fix(raw.latitude, raw.longitude, {
    name: raw.city,
    region: raw.region,
    country: raw.country_name,
    countryCode: raw.country_code,
    timezone: raw.timezone,
  });
}

export function parseIpWho(raw: IpWhoResponse): IpFix | undefined {
  if (!raw.success) return undefined;
  return fix(raw.latitude, raw.longitude, {
    name: raw.city,
    region: raw.region,
    country: raw.country,
    countryCode: raw.country_code,
    timezone: raw.timezone?.id,
  });
}

export function parseGeoJs(raw: GeoJsResponse): IpFix | undefined {
  return fix(raw.latitude, raw.longitude, {
    name: raw.city,
    region: raw.region,
    country: raw.country,
    countryCode: raw.country_code,
    timezone: raw.timezone,
  });
}

export function parseIpInfo(raw: IpInfoResponse): IpFix | undefined {
  const [lat, lon] = (raw.loc ?? "").split(",");
  // ipinfo's `country` is the ISO code, not a name.
  return fix(lat, lon, {
    name: raw.city,
    region: raw.region,
    countryCode: raw.country,
    timezone: raw.timezone,
  });
}

/**
 * Keyless IP geolocation services, tried in order. ip-api.com is absent because
 * its free tier is http-only; reallyfreegeoip sits behind a Cloudflare challenge.
 */
export const IP_PROVIDERS: ReadonlyArray<{
  name: string;
  url: string;
  parse: (raw: never) => IpFix | undefined;
}> = [
  { name: "ipapi.co", url: "https://ipapi.co/json/", parse: parseIpApiCo },
  { name: "ipwho.is", url: "https://ipwho.is/", parse: parseIpWho },
  { name: "geojs", url: "https://get.geojs.io/v1/ip/geo.json", parse: parseGeoJs },
  { name: "ipinfo.io", url: "https://ipinfo.io/json", parse: parseIpInfo },
];

export async function locateByIp(http: HttpClient): Promise<Location> {
  const failures: string[] = [];
  for (const p of IP_PROVIDERS) {
    try {
      const raw = await http.json<never>(p.url, {
        ttlMs: 60 * 60_000,
        timeoutMs: 4_000,
        retries: 0,
      });
      const hit = p.parse(raw);
      if (hit) return { ...hit, source: "ip" };
      failures.push(`${p.name}: no coordinates`);
    } catch (err) {
      failures.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Could not determine your location from your IP address (${failures.join("; ")}). Pass a place name instead.`,
  );
}

// ─── Reverse geocoding ─────────────────────────────────────────────────────

export interface PlaceName {
  name: string;
  region?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
}

interface NominatimReverse {
  error?: string;
  name?: string;
  address?: Record<string, string | undefined>;
}

interface PhotonReverse {
  features?: Array<{ properties?: Record<string, string | undefined> }>;
}

interface BigDataCloudReverse {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryName?: string;
  countryCode?: string;
  localityInfo?: { informative?: Array<{ name?: string; description?: string }> };
}

const nonEmpty = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);

export function parseNominatim(raw: NominatimReverse): PlaceName | undefined {
  if (raw.error || !raw.address) return undefined;
  const a = raw.address;
  const name = nonEmpty(
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.county ?? raw.name,
  );
  if (!name) return undefined;
  return {
    name,
    region: nonEmpty(a.state),
    country: nonEmpty(a.country),
    countryCode: nonEmpty(a.country_code)?.toUpperCase(),
  };
}

export function parsePhoton(raw: PhotonReverse): PlaceName | undefined {
  const p = raw.features?.[0]?.properties;
  if (!p) return undefined;
  const name = nonEmpty(p.city ?? p.town ?? p.village ?? p.county ?? p.name);
  if (!name) return undefined;
  return {
    name,
    region: nonEmpty(p.state),
    country: nonEmpty(p.country),
    countryCode: nonEmpty(p.countrycode)?.toUpperCase(),
  };
}

export function parseBigDataCloud(raw: BigDataCloudReverse): PlaceName | undefined {
  const name = nonEmpty(raw.city) ?? nonEmpty(raw.locality);
  if (!name) return undefined;
  const tz = raw.localityInfo?.informative?.find((i) => i.description === "time zone")?.name;
  return {
    name,
    region: nonEmpty(raw.principalSubdivision),
    country: nonEmpty(raw.countryName),
    countryCode: nonEmpty(raw.countryCode),
    timezone: tz?.includes("/") ? tz : undefined,
  };
}

/**
 * Name a coordinate: Nominatim (rate-limited to 1 req/s by the HTTP client,
 * per its usage policy) → Photon → BigDataCloud's keyless client endpoint.
 */
export async function reverseGeocode(
  http: HttpClient,
  lat: number,
  lon: number,
): Promise<PlaceName | undefined> {
  const la = lat.toFixed(3);
  const lo = lon.toFixed(3);
  const opts = { ttlMs: 30 * 24 * 3600_000, timeoutMs: 5_000, retries: 0 };
  const chain: Array<[string, (raw: never) => PlaceName | undefined]> = [
    [
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${la}&lon=${lo}&zoom=10&accept-language=en`,
      parseNominatim,
    ],
    [`https://photon.komoot.io/reverse?lat=${la}&lon=${lo}&limit=1&lang=en`, parsePhoton],
    [
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${la}&longitude=${lo}&localityLanguage=en`,
      parseBigDataCloud,
    ],
  ];
  for (const [url, parse] of chain) {
    try {
      const hit = parse(await http.json<never>(url, opts));
      if (hit) return hit;
    } catch {
      // Try the next service.
    }
  }
  return undefined;
}

// ─── Forward geocoding ─────────────────────────────────────────────────────

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

/** Asks the user to choose among ambiguous matches; resolves to an index into `choices`. */
export type Picker = (query: string, choices: Location[]) => Promise<number>;

export interface ResolveOptions {
  /** Called when a place name is ambiguous. Omit (non-TTY) to take the best match. */
  pick?: Picker;
  /** Name coordinates via reverse geocoding. Default true. */
  reverse?: boolean;
}

export function describePlace(
  l: Pick<Location, "name" | "region" | "country" | "countryCode">,
): string {
  return [l.name, l.region, l.country ?? l.countryCode].filter(Boolean).join(", ");
}

type Ranked = GeocodeCandidate & { score: number };

/**
 * Matches close enough that guessing would be rude: several results share the
 * top score and exact name, and the first isn't an order of magnitude bigger
 * than the next (so "Paris" means Paris, France, but "Springfield" asks).
 */
export function ambiguousMatches(name: string, ranked: Ranked[]): Location[] {
  const top = ranked[0];
  if (!top) return [];
  const q = name.trim().toLowerCase();
  const peers = ranked.filter((c) => c.score === top.score && c.location.name.toLowerCase() === q);
  const [a, b] = peers;
  if (!a || !b) return [];
  if (a.population && b.population !== undefined && a.population >= 10 * b.population) return [];
  return peers.map((c) => c.location);
}

/**
 * Resolve a free-form query into a location.
 * Accepts "lat,lon", "City", "City, Region", or nothing (IP geolocation).
 */
export async function resolveLocation(
  http: HttpClient,
  query?: string,
  opts: ResolveOptions = {},
): Promise<Location> {
  if (!query?.trim()) return locateByIp(http);
  const coords = parseCoords(query);
  if (coords) {
    // Name and timezone are both best-effort; neither should block the forecast.
    const [place, timezone] = await Promise.all([
      opts.reverse === false ? undefined : reverseGeocode(http, coords.lat, coords.lon),
      lookupTimezone(http, coords).catch(() => undefined),
    ]);
    return {
      name: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
      ...place,
      timezone: place?.timezone ?? timezone,
      ...coords,
      source: "coords",
    };
  }
  // Open-Meteo's geocoder matches on place name only, so search the first
  // segment and use any remaining segments to rank (e.g. "Paris, TX").
  const [head = query, ...rest] = query.split(",").map((s) => s.trim());
  const results = await geocodeCandidates(http, head, 10);
  if (!results.length) throw new Error(`No place found matching "${query}"`);
  const terms = rest.length ? hintTerms(rest.join(" ")) : [];
  const scored: Ranked[] = results.map((r) => {
    const hay = [r.location.region, r.location.country, r.location.countryCode]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .split(/\s+/);
    // Count matched terms so "Springfield, IL" beats a result matching only "US".
    return { ...r, score: terms.filter((t) => hay.includes(t)).length };
  });
  // Stable sort keeps the geocoder's relevance order within a score.
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.location as Location;
  if (!opts.pick) return best;
  const choices = ambiguousMatches(head, scored);
  if (!choices.length) return best;
  return choices[await opts.pick(query, choices)] ?? best;
}
