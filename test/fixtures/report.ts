import { computeAstronomy } from "../../src/domain/astronomy.ts";
import {
  type Alert,
  type Condition,
  type DailyPoint,
  type Hazards,
  type HourlyPoint,
  type Location,
  type Report,
  SCHEMA_VERSION,
} from "../../src/domain/types.ts";
import type { HttpClient } from "../../src/util/http.ts";

/**
 * Deterministic, network-free reports for headless view tests and offline
 * snapshots. Every value is a pure function of the options, so frames are
 * stable across runs (pin the clock to `FIXTURE_NOW` with `setSystemTime`).
 */

/** Mid-afternoon in Denver (20:00Z = 14:00 MDT). */
export const FIXTURE_NOW = new Date("2026-07-15T20:00:00.000Z");

export const DENVER: Location = {
  name: "Denver",
  region: "Colorado",
  country: "United States",
  countryCode: "US",
  lat: 39.7392,
  lon: -104.9903,
  timezone: "America/Denver",
  elevation: 1609,
  source: "coords",
};

export interface FixtureOptions {
  location?: Location;
  now?: Date;
  condition?: Condition;
  /** Current temperature in °C. */
  temperature?: number;
  alerts?: number;
  aqi?: number;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function fixtureReport(opts: FixtureOptions = {}): Report {
  const now = opts.now ?? FIXTURE_NOW;
  const loc = opts.location ?? DENVER;
  const base = opts.temperature ?? 27;
  const condition = opts.condition ?? "partly-cloudy";
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() - 6);
  const localHour = (d: Date) => (d.getUTCHours() - 6 + 24) % 24; // MDT

  const hourly: HourlyPoint[] = Array.from({ length: 240 }, (_, i) => {
    const t = new Date(start.getTime() + i * 3600_000);
    const h = localHour(t);
    const diurnal = Math.sin(((h - 9) / 24) * 2 * Math.PI);
    const temperature = round(base - 6 + diurnal * 8 + Math.sin(i / 17) * 2);
    const pp = Math.max(0, Math.round(50 * Math.sin(i / 7) + (h > 13 && h < 19 ? 25 : -10)));
    const isDay = h >= 6 && h < 20;
    return {
      time: t.toISOString(),
      temperature,
      feelsLike: round(temperature - 1.5 + Math.cos(i / 5)),
      precipitationProbability: Math.min(100, pp),
      precipitation: pp > 40 ? round((pp - 40) / 20, 2) : 0,
      windSpeed: round(12 + 8 * Math.sin(i / 6)),
      windGust: round(22 + 12 * Math.sin(i / 6 + 0.5)),
      windDirection: (200 + i * 7) % 360,
      humidity: Math.round(45 - diurnal * 20),
      cloudCover: Math.round(40 + 40 * Math.sin(i / 9)),
      uvIndex: isDay ? round(Math.max(0, 9 * Math.sin(((h - 6) / 14) * Math.PI))) : 0,
      pressure: round(1014 + 4 * Math.sin(i / 20)),
      condition: pp > 60 ? "thunderstorm" : pp > 35 ? "showers" : isDay ? "partly-cloudy" : "clear",
      isDay,
    };
  });

  const conditions: Condition[] = [
    "partly-cloudy",
    "thunderstorm",
    "clear",
    "showers",
    "cloudy",
    "rain",
    "snow",
    "fog",
    "mostly-clear",
    "drizzle",
  ];
  const daily: DailyPoint[] = conditions.map((c, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    return {
      date,
      tempMax: round(base + 3 - i * 0.8 + Math.sin(i) * 3),
      tempMin: round(base - 12 - i * 0.5 + Math.cos(i) * 2),
      precipitationSum: round(Math.max(0, Math.sin(i * 1.3) * 8), 1),
      precipitationProbability: Math.round(Math.abs(Math.sin(i * 1.3)) * 90),
      windSpeedMax: round(20 + i * 2),
      windGustMax: round(35 + i * 3),
      uvIndexMax: round(8 - i * 0.4),
      sunrise: `${date}T11:45:00.000Z`,
      sunset: `${date}T02:25:00.000Z`,
      condition: c,
    };
  });

  const alerts: Alert[] = [
    {
      id: "fixture-1",
      provider: "nws",
      event: "Severe Thunderstorm Warning",
      headline: "Severe Thunderstorm Warning issued for Denver County",
      description:
        "At 2:05 PM MDT, a severe thunderstorm was located near Denver, moving east at 25 mph.\nHAZARD...60 mph wind gusts and quarter size hail.",
      instruction:
        "For your protection move to an interior room on the lowest floor of a building.",
      severity: "severe",
      urgency: "Immediate",
      areas: "Denver; Arapahoe; Adams",
      onset: now.toISOString(),
      expires: new Date(now.getTime() + 45 * 60_000).toISOString(),
    },
    {
      id: "fixture-2",
      provider: "nws",
      event: "Heat Advisory",
      headline: "Heat Advisory until 8 PM MDT",
      description: "Heat index values up to 102 expected.",
      severity: "moderate",
      areas: "Denver",
      expires: new Date(now.getTime() + 6 * 3600_000).toISOString(),
    },
  ].slice(0, opts.alerts ?? 2) as Alert[];

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    units: "imperial",
    location: loc,
    forecast: {
      provider: "fixture",
      fetchedAt: now.toISOString(),
      current: {
        time: now.toISOString(),
        temperature: base,
        feelsLike: base - 1,
        humidity: 38,
        dewPoint: 11.4,
        pressure: 1016.2,
        windSpeed: 18,
        windGust: 31,
        windDirection: 225,
        cloudCover: 35,
        visibility: 16_000,
        precipitation: 0,
        uvIndex: 7,
        condition,
        isDay: true,
      },
      hourly,
      daily,
    },
    airQuality: { provider: "fixture", usAqi: opts.aqi ?? 64, pm2_5: 12.1 },
    astronomy: computeAstronomy(loc.lat, loc.lon, now),
    alerts,
    errors: [],
  };
}

export function fixtureHazards(now = FIXTURE_NOW): Hazards {
  const iso = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    storms: [
      {
        id: "al05",
        provider: "nhc",
        name: "Erin",
        basin: "AL",
        classification: "HU",
        category: 3,
        lat: 24.5,
        lon: -71.2,
        windKt: 105,
        pressureMb: 958,
        movement: "WNW at 14 mph",
        updated: iso(30),
        track: [
          { lat: 21.0, lon: -64.0, forecast: false, category: 1 },
          { lat: 24.5, lon: -71.2, forecast: false, category: 3 },
          { lat: 27.5, lon: -75.5, forecast: true, category: 3 },
        ],
      },
    ],
    fires: [
      {
        id: "f1",
        provider: "nifc",
        name: "Cameron Peak",
        lat: 40.6,
        lon: -105.8,
        acres: 12_400,
        containment: 35,
        kind: "incident",
      },
      {
        id: "f2",
        provider: "nifc",
        name: "Rim",
        lat: 37.9,
        lon: -120.1,
        acres: 3_100,
        kind: "incident",
      },
    ],
    hotspots: [
      { id: "h1", provider: "firms", lat: -12.5, lon: 131.2, frp: 40, kind: "hotspot" },
      { id: "h2", provider: "firms", lat: -8.2, lon: -60.1, frp: 22, kind: "hotspot" },
    ],
    quakes: [
      {
        id: "q1",
        provider: "usgs",
        magnitude: 6.1,
        place: "45 km S of Hualien City, Taiwan",
        time: iso(90),
        lat: 23.6,
        lon: 121.5,
        depthKm: 18,
        tsunami: false,
      },
      {
        id: "q2",
        provider: "usgs",
        magnitude: 4.4,
        place: "10 km NE of Ridgecrest, CA",
        time: iso(300),
        lat: 35.7,
        lon: -117.6,
        depthKm: 8,
        tsunami: false,
      },
    ],
    space: { provider: "swpc", kp: 4.3, scales: { R: 0, S: 0, G: 1 } },
    errors: [],
  };
}

/** An HttpClient that never touches the network; every request fails fast. */
export const offlineHttp: HttpClient = {
  text: () => Promise.reject(new Error("offline fixture")),
  bytes: () => Promise.reject(new Error("offline fixture")),
  json: () => Promise.reject(new Error("offline fixture")),
};
