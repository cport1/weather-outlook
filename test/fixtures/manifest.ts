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
  record: (http: HttpClient) => Promise<unknown>;
}

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
