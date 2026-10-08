import { z } from "zod";

/**
 * Domain model. These schemas are the public `--json` contract, so
 * changes here are breaking changes; bump SCHEMA_VERSION accordingly.
 * All units are metric/SI internally; conversion happens at render time.
 */
export const SCHEMA_VERSION = 1;

export const Location = z.object({
  name: z.string(),
  region: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  timezone: z.string().optional(),
  elevation: z.number().optional(),
  source: z.enum(["geocode", "ip", "coords", "config"]),
});
export type Location = z.infer<typeof Location>;

/** WMO weather interpretation code, normalized across providers. */
export const Condition = z.enum([
  "clear",
  "mostly-clear",
  "partly-cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "rain",
  "heavy-rain",
  "freezing-rain",
  "snow",
  "heavy-snow",
  "sleet",
  "showers",
  "thunderstorm",
  "hail",
  "unknown",
]);
export type Condition = z.infer<typeof Condition>;

export const Current = z.object({
  time: z.string(),
  temperature: z.number(),
  feelsLike: z.number().optional(),
  humidity: z.number().optional(),
  dewPoint: z.number().optional(),
  pressure: z.number().optional(),
  windSpeed: z.number().optional(),
  windGust: z.number().optional(),
  windDirection: z.number().optional(),
  cloudCover: z.number().optional(),
  visibility: z.number().optional(),
  precipitation: z.number().optional(),
  uvIndex: z.number().optional(),
  condition: Condition,
  isDay: z.boolean(),
});
export type Current = z.infer<typeof Current>;

export const HourlyPoint = z.object({
  time: z.string(),
  temperature: z.number(),
  feelsLike: z.number().optional(),
  precipitationProbability: z.number().optional(),
  precipitation: z.number().optional(),
  windSpeed: z.number().optional(),
  windGust: z.number().optional(),
  windDirection: z.number().optional(),
  humidity: z.number().optional(),
  cloudCover: z.number().optional(),
  uvIndex: z.number().optional(),
  condition: Condition,
  isDay: z.boolean(),
});
export type HourlyPoint = z.infer<typeof HourlyPoint>;

export const DailyPoint = z.object({
  date: z.string(),
  tempMax: z.number(),
  tempMin: z.number(),
  precipitationSum: z.number().optional(),
  precipitationProbability: z.number().optional(),
  windSpeedMax: z.number().optional(),
  windGustMax: z.number().optional(),
  uvIndexMax: z.number().optional(),
  sunrise: z.string().optional(),
  sunset: z.string().optional(),
  condition: Condition,
});
export type DailyPoint = z.infer<typeof DailyPoint>;

export const Forecast = z.object({
  provider: z.string(),
  fetchedAt: z.string(),
  current: Current,
  hourly: z.array(HourlyPoint),
  daily: z.array(DailyPoint),
});
export type Forecast = z.infer<typeof Forecast>;

export const AirQuality = z.object({
  provider: z.string(),
  usAqi: z.number().optional(),
  europeanAqi: z.number().optional(),
  pm2_5: z.number().optional(),
  pm10: z.number().optional(),
  ozone: z.number().optional(),
  no2: z.number().optional(),
  pollen: z.record(z.string(), z.number()).optional(),
});
export type AirQuality = z.infer<typeof AirQuality>;

export const Severity = z.enum(["extreme", "severe", "moderate", "minor", "unknown"]);
export type Severity = z.infer<typeof Severity>;

export const Alert = z.object({
  id: z.string(),
  provider: z.string(),
  event: z.string(),
  headline: z.string().optional(),
  description: z.string().optional(),
  instruction: z.string().optional(),
  severity: Severity,
  urgency: z.string().optional(),
  areas: z.string().optional(),
  onset: z.string().optional(),
  expires: z.string().optional(),
  /** Outer ring(s) of the affected polygon, as [lon, lat]. */
  polygon: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
});
export type Alert = z.infer<typeof Alert>;

export const TrackPoint = z.object({
  time: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  windKt: z.number().optional(),
  pressureMb: z.number().optional(),
  category: z.number().optional(),
  forecast: z.boolean(),
});
export type TrackPoint = z.infer<typeof TrackPoint>;

export const Storm = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  basin: z.string().optional(),
  classification: z.string(),
  /** Saffir-Simpson: -1 TD, 0 TS, 1-5 hurricane. */
  category: z.number(),
  lat: z.number(),
  lon: z.number(),
  windKt: z.number().optional(),
  pressureMb: z.number().optional(),
  movement: z.string().optional(),
  updated: z.string().optional(),
  track: z.array(TrackPoint),
  cone: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
});
export type Storm = z.infer<typeof Storm>;

export const Fire = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  acres: z.number().optional(),
  containment: z.number().optional(),
  /** Fire radiative power (MW) for satellite detections. */
  frp: z.number().optional(),
  confidence: z.string().optional(),
  discovered: z.string().optional(),
  kind: z.enum(["incident", "hotspot"]),
});
export type Fire = z.infer<typeof Fire>;

export const Quake = z.object({
  id: z.string(),
  provider: z.string(),
  magnitude: z.number(),
  place: z.string(),
  time: z.string(),
  lat: z.number(),
  lon: z.number(),
  depthKm: z.number(),
  tsunami: z.boolean(),
  alert: z.string().optional(),
  url: z.string().optional(),
});
export type Quake = z.infer<typeof Quake>;

export const SpaceWeather = z.object({
  provider: z.string(),
  kp: z.number().optional(),
  kpTime: z.string().optional(),
  solarWindSpeed: z.number().optional(),
  bz: z.number().optional(),
  scales: z
    .object({ R: z.number().optional(), S: z.number().optional(), G: z.number().optional() })
    .optional(),
});
export type SpaceWeather = z.infer<typeof SpaceWeather>;

export const Astronomy = z.object({
  sunrise: z.string().optional(),
  sunset: z.string().optional(),
  solarNoon: z.string().optional(),
  dayLengthMin: z.number().optional(),
  moonPhase: z.number(),
  moonPhaseName: z.string(),
  moonIllumination: z.number(),
  moonrise: z.string().optional(),
  moonset: z.string().optional(),
});
export type Astronomy = z.infer<typeof Astronomy>;

/** Errors from individual providers are captured, never fatal to the whole report. */
export const ProviderError = z.object({ provider: z.string(), message: z.string() });
export type ProviderError = z.infer<typeof ProviderError>;

export const Report = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  units: z.enum(["metric", "imperial"]),
  location: Location,
  forecast: Forecast.optional(),
  airQuality: AirQuality.optional(),
  astronomy: Astronomy.optional(),
  alerts: z.array(Alert),
  errors: z.array(ProviderError),
});
export type Report = z.infer<typeof Report>;
