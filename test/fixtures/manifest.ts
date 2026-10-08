import { fetchNwsAlertsForPoint } from "../../src/providers/nws.ts";
import { fetchAirQuality, fetchForecast, geocode } from "../../src/providers/open-meteo.ts";
import type { HttpClient } from "../../src/util/http.ts";

/**
 * Recorded upstream responses. `match` is host + path; tests serve the fixture
 * for any request to it. `record` drives the real provider code against a
 * recording client so the stored response matches the exact request we make.
 */
export interface Fixture {
  name: string;
  match: string;
  kind?: "ip";
  /** Serve this fixture for any path starting with `match` (ids and coordinates vary). */
  prefix?: boolean;
  record: (http: HttpClient) => Promise<unknown>;
  /** Trim the recorded response before it's stored (keeps big payloads small). */
  transform?: (raw: unknown) => unknown;
}

const trimArchive = (raw: unknown): unknown => {
  // Keep a month either side of today so the forecast dates find their normals.
  const r = raw as { daily: Record<string, unknown[]> & { time: string[] } };
  const doy = (md: string) => Date.UTC(2000, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5)));
  const today = doy(new Date().toISOString().slice(5, 10));
  const keep = r.daily.time
    .map((t, i) => [t, i] as const)
    .filter(([t]) => {
      const d = Math.abs(doy(t.slice(5, 10)) - today) / 86_400_000;
      return Math.min(d, 366 - d) <= 20;
    })
    .map(([, i]) => i);
  return {
    ...r,
    daily: Object.fromEntries(Object.entries(r.daily).map(([k, v]) => [k, keep.map((i) => v[i])])),
  };
};

const GRID = "api.weather.gov/gridpoints/BOU/63,62";

const DENVER = { lat: 39.7392, lon: -104.9903 };
const get = (url: string) => (http: HttpClient) => http.json(url, { ttlMs: 0 });

export const FIXTURES: Fixture[] = [
  {
    name: "open-meteo-forecast",
    match: "api.open-meteo.com/v1/forecast",
    record: (http) => fetchForecast(http, DENVER),
  },
  {
    name: "open-meteo-air-quality",
    match: "air-quality-api.open-meteo.com/v1/air-quality",
    record: (http) => fetchAirQuality(http, DENVER),
  },
  {
    name: "open-meteo-geocode",
    match: "geocoding-api.open-meteo.com/v1/search",
    // Ambiguous on purpose: exercises ranking and the picker.
    record: (http) => geocode(http, "Springfield", 10),
  },
  {
    name: "nws-alerts",
    match: "api.weather.gov/alerts/active",
    record: (http) => fetchNwsAlertsForPoint(http, DENVER.lat, DENVER.lon),
  },
  // Day 1 outlooks fetched by buildReport for US locations.
  ...(
    [
      ["spc-day1-cat", "www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson"],
      ["spc-day1-fw-windrh", "www.spc.noaa.gov/products/fire_wx/day1fw_windrh.nolyr.geojson"],
      ["spc-day1-fw-dryt", "www.spc.noaa.gov/products/fire_wx/day1fw_dryt.nolyr.geojson"],
      ["wpc-ero-day1", "www.wpc.ncep.noaa.gov/exper/eromap/geojson/Day1_Latest.geojson"],
    ] as const
  ).map(([name, match]) => ({ name, match, record: get(`https://${match}`) })),
  // Detail sections (NWS text products, models, marine, climate) for Denver.
  {
    name: "nws-points",
    match: "api.weather.gov/points/",
    prefix: true,
    record: get(`https://api.weather.gov/points/${DENVER.lat},${DENVER.lon}`),
  },
  {
    name: "nws-forecast",
    match: `${GRID}/forecast`,
    record: get(`https://${GRID}/forecast`),
    transform: (raw) => ({
      properties: {
        periods: (raw as { properties: { periods: unknown[] } }).properties.periods.slice(0, 6),
      },
    }),
  },
  {
    name: "nws-grid",
    match: GRID,
    record: get(`https://${GRID}`),
    transform: (raw) => {
      const p = (raw as { properties: Record<string, unknown> }).properties;
      const keep = ["heatRisk", "lightningActivityLevel", "snowfallAmount"];
      return { properties: Object.fromEntries(keep.map((k) => [k, p[k]])) };
    },
  },
  {
    name: "nws-stations",
    match: `${GRID}/stations`,
    record: get(`https://${GRID}/stations?limit=3`),
    transform: (raw) => ({
      features: (
        raw as { features: Array<{ id: string; properties: Record<string, unknown> }> }
      ).features
        .slice(0, 3)
        .map((f) => ({
          id: f.id,
          properties: {
            stationIdentifier: f.properties.stationIdentifier,
            name: f.properties.name,
          },
        })),
    }),
  },
  {
    name: "nws-observation",
    match: "api.weather.gov/stations/",
    prefix: true,
    record: get("https://api.weather.gov/stations/KDEN/observations/latest"),
  },
  {
    name: "nws-afd-list",
    match: "api.weather.gov/products",
    record: get("https://api.weather.gov/products?type=AFD&location=BOU&limit=1"),
  },
  {
    name: "nws-afd",
    match: "api.weather.gov/products/",
    prefix: true,
    record: async (http) => {
      const list = await http.json<{ "@graph": Array<{ id: string }> }>(
        "https://api.weather.gov/products?type=AFD&location=BOU&limit=1",
        { ttlMs: 0 },
      );
      return http.json(`https://api.weather.gov/products/${list["@graph"][0]?.id}`, { ttlMs: 0 });
    },
  },
  {
    name: "open-meteo-ensemble",
    match: "ensemble-api.open-meteo.com/v1/ensemble",
    record: get(
      `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${DENVER.lat}&longitude=${DENVER.lon}&hourly=temperature_2m&forecast_days=7&timezone=auto&models=ecmwf_ifs025`,
    ),
    // Control + 10 members is plenty for the band.
    transform: (raw) => {
      const r = raw as { hourly: Record<string, unknown> };
      const keep = /^temperature_2m(_member0\d|_member10)?$/;
      return {
        ...r,
        hourly: Object.fromEntries(
          Object.entries(r.hourly).filter(([k]) => k === "time" || keep.test(k)),
        ),
      };
    },
  },
  {
    name: "metno-locationforecast",
    match: "api.met.no/weatherapi/locationforecast/2.0/compact",
    record: get(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${DENVER.lat}&lon=${DENVER.lon}`,
    ),
    transform: (raw) => {
      const r = raw as { properties: { timeseries: unknown[] } };
      return {
        ...r,
        properties: { ...r.properties, timeseries: r.properties.timeseries.slice(0, 36) },
      };
    },
  },
  {
    name: "open-meteo-marine",
    match: "marine-api.open-meteo.com/v1/marine",
    // Denver is inland: the all-null answer that skips tides and buoys.
    record: get(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${DENVER.lat}&longitude=${DENVER.lon}&current=wave_height,wave_direction,wave_period,sea_surface_temperature&hourly=wave_height,wave_direction,wave_period,sea_surface_temperature&forecast_days=3&timezone=auto`,
    ),
  },
  {
    name: "open-meteo-archive",
    match: "archive-api.open-meteo.com/v1/archive",
    record: async (http) => {
      const end = new Date().getUTCFullYear() - 1;
      return http.json(
        `https://archive-api.open-meteo.com/v1/archive?latitude=39.74&longitude=-104.99&start_date=${end - 29}-01-01&end_date=${end}-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=auto`,
        { ttlMs: 0 },
      );
    },
    transform: trimArchive,
  },
  { name: "ipapi", match: "ipapi.co/json/", kind: "ip", record: get("https://ipapi.co/json/") },
  { name: "ipwho", match: "ipwho.is/", kind: "ip", record: get("https://ipwho.is/") },
  {
    name: "geojs",
    match: "get.geojs.io/v1/ip/geo.json",
    kind: "ip",
    record: get("https://get.geojs.io/v1/ip/geo.json"),
  },
  { name: "ipinfo", match: "ipinfo.io/json", kind: "ip", record: get("https://ipinfo.io/json") },
  {
    name: "nominatim-reverse",
    match: "nominatim.openstreetmap.org/reverse",
    record: get(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${DENVER.lat}&lon=${DENVER.lon}&zoom=10&accept-language=en`,
    ),
  },
  {
    name: "photon-reverse",
    match: "photon.komoot.io/reverse",
    record: get(`https://photon.komoot.io/reverse?lat=${DENVER.lat}&lon=${DENVER.lon}&limit=1`),
  },
  {
    name: "bigdatacloud-reverse",
    match: "api.bigdatacloud.net/data/reverse-geocode-client",
    record: get(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${DENVER.lat}&longitude=${DENVER.lon}&localityLanguage=en`,
    ),
  },
];
