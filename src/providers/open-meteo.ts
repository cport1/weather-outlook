import { fromWmo } from "../domain/conditions.ts";
import type { AqHourlyPoint } from "../domain/details.ts";
import type { AirQuality, DailyPoint, Forecast, HourlyPoint, Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

const CURRENT_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "pressure_msl",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "cloud_cover",
  "visibility",
  "precipitation",
  "uv_index",
  "weather_code",
  "is_day",
];
const HOURLY_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "relative_humidity_2m",
  "cloud_cover",
  "uv_index",
  "weather_code",
  "is_day",
  "pressure_msl",
];
const DAILY_VARS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "uv_index_max",
  "sunrise",
  "sunset",
];

type Series = Record<string, Array<number | string | null> | undefined>;

interface ForecastResponse {
  utc_offset_seconds: number;
  timezone: string;
  elevation?: number;
  current: Record<string, number | string>;
  hourly: Series & { time: string[] };
  daily: Series & { time: string[] };
}

/** Open-Meteo returns local wall-clock times without an offset; attach one so they're unambiguous. */
export function withOffset(local: string, offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  return `${withSeconds}${sign}${hh}:${mm}`;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function at(series: Series, key: string, i: number): number | undefined {
  return num(series[key]?.[i]);
}

export function parseForecast(raw: ForecastResponse, now = new Date()): Forecast {
  const off = raw.utc_offset_seconds;
  const c = raw.current;
  const hourly: HourlyPoint[] = raw.hourly.time.map((t, i) => ({
    time: withOffset(t, off),
    temperature: at(raw.hourly, "temperature_2m", i) ?? Number.NaN,
    feelsLike: at(raw.hourly, "apparent_temperature", i),
    precipitationProbability: at(raw.hourly, "precipitation_probability", i),
    precipitation: at(raw.hourly, "precipitation", i),
    windSpeed: at(raw.hourly, "wind_speed_10m", i),
    windGust: at(raw.hourly, "wind_gusts_10m", i),
    windDirection: at(raw.hourly, "wind_direction_10m", i),
    humidity: at(raw.hourly, "relative_humidity_2m", i),
    cloudCover: at(raw.hourly, "cloud_cover", i),
    uvIndex: at(raw.hourly, "uv_index", i),
    pressure: at(raw.hourly, "pressure_msl", i),
    condition: fromWmo(at(raw.hourly, "weather_code", i) ?? -1),
    isDay: at(raw.hourly, "is_day", i) === 1,
  }));
  const daily: DailyPoint[] = raw.daily.time.map((d, i) => ({
    date: d,
    tempMax: at(raw.daily, "temperature_2m_max", i) ?? Number.NaN,
    tempMin: at(raw.daily, "temperature_2m_min", i) ?? Number.NaN,
    precipitationSum: at(raw.daily, "precipitation_sum", i),
    precipitationProbability: at(raw.daily, "precipitation_probability_max", i),
    windSpeedMax: at(raw.daily, "wind_speed_10m_max", i),
    windGustMax: at(raw.daily, "wind_gusts_10m_max", i),
    uvIndexMax: at(raw.daily, "uv_index_max", i),
    sunrise:
      typeof raw.daily.sunrise?.[i] === "string"
        ? withOffset(String(raw.daily.sunrise[i]), off)
        : undefined,
    sunset:
      typeof raw.daily.sunset?.[i] === "string"
        ? withOffset(String(raw.daily.sunset[i]), off)
        : undefined,
    condition: fromWmo(at(raw.daily, "weather_code", i) ?? -1),
  }));
  return {
    provider: "open-meteo",
    fetchedAt: now.toISOString(),
    current: {
      time: withOffset(String(c.time), off),
      temperature: num(c.temperature_2m) ?? Number.NaN,
      feelsLike: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      dewPoint: num(c.dew_point_2m),
      pressure: num(c.pressure_msl),
      windSpeed: num(c.wind_speed_10m),
      windGust: num(c.wind_gusts_10m),
      windDirection: num(c.wind_direction_10m),
      cloudCover: num(c.cloud_cover),
      visibility: num(c.visibility),
      precipitation: num(c.precipitation),
      uvIndex: num(c.uv_index),
      condition: fromWmo(num(c.weather_code) ?? -1),
      isDay: c.is_day === 1,
    },
    hourly,
    daily,
  };
}

export async function fetchForecast(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
  opts: { days?: number; refresh?: boolean } = {},
): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: CURRENT_VARS.join(","),
    hourly: HOURLY_VARS.join(","),
    daily: DAILY_VARS.join(","),
    forecast_days: String(opts.days ?? 10),
    timezone: "auto",
    wind_speed_unit: "kmh",
  });
  const raw = await http.json<ForecastResponse>(`${FORECAST_URL}?${params}`, {
    ttlMs: 10 * 60_000,
    refresh: opts.refresh,
  });
  return parseForecast(raw);
}

/**
 * IANA timezone for a coordinate. A forecast call with no variables is a few
 * hundred bytes and Open-Meteo resolves `timezone=auto` for us.
 */
export async function lookupTimezone(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
): Promise<string | undefined> {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(3),
    longitude: loc.lon.toFixed(3),
    timezone: "auto",
  });
  const raw = await http.json<{ timezone?: string }>(`${FORECAST_URL}?${params}`, {
    ttlMs: 30 * 24 * 3600_000,
    timeoutMs: 5_000,
    retries: 0,
  });
  return raw.timezone && raw.timezone !== "GMT" ? raw.timezone : undefined;
}

interface AqResponse {
  utc_offset_seconds?: number;
  current?: Record<string, number | string | null>;
  hourly?: Series & { time: string[] };
}

const POLLEN = [
  "alder_pollen",
  "birch_pollen",
  "grass_pollen",
  "mugwort_pollen",
  "olive_pollen",
  "ragweed_pollen",
];

export async function fetchAirQuality(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
): Promise<AirQuality> {
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: [
      "us_aqi",
      "european_aqi",
      "pm2_5",
      "pm10",
      "ozone",
      "nitrogen_dioxide",
      ...POLLEN,
    ].join(","),
    hourly: "us_aqi,european_aqi,pm2_5",
    forecast_days: "4",
    timezone: "auto",
  });
  const raw = await http.json<AqResponse>(`${AQ_URL}?${params}`, { ttlMs: 30 * 60_000 });
  return parseAirQuality(raw);
}

export function parseAirQuality(raw: AqResponse): AirQuality {
  const c = raw.current ?? {};
  const pollen: Record<string, number> = {};
  for (const p of POLLEN) {
    const v = num(c[p]);
    if (v !== undefined) pollen[p.replace("_pollen", "")] = v;
  }
  return {
    provider: "open-meteo",
    usAqi: num(c.us_aqi),
    europeanAqi: num(c.european_aqi),
    pm2_5: num(c.pm2_5),
    pm10: num(c.pm10),
    ozone: num(c.ozone),
    no2: num(c.nitrogen_dioxide),
    // Open-Meteo only models pollen over Europe; elsewhere every value is null.
    pollen: Object.keys(pollen).length ? pollen : undefined,
    hourly: parseAqHourly(raw),
  };
}

function parseAqHourly(raw: AqResponse): AqHourlyPoint[] | undefined {
  const h = raw.hourly;
  if (!h?.time.length) return undefined;
  const off = raw.utc_offset_seconds ?? 0;
  const points = h.time.map((t, i) => ({
    time: withOffset(t, off),
    usAqi: at(h, "us_aqi", i),
    europeanAqi: at(h, "european_aqi", i),
    pm2_5: at(h, "pm2_5", i),
  }));
  return points.some((p) => p.usAqi !== undefined || p.europeanAqi !== undefined)
    ? points
    : undefined;
}

interface GeocodeResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    elevation?: number;
    timezone?: string;
    country?: string;
    country_code?: string;
    admin1?: string;
    population?: number;
  }>;
}

export interface GeocodeCandidate {
  location: Location;
  population?: number;
}

export function parseGeocode(raw: GeocodeResponse): GeocodeCandidate[] {
  return (raw.results ?? []).map((r) => ({
    location: {
      name: r.name,
      region: r.admin1,
      country: r.country,
      countryCode: r.country_code,
      lat: r.latitude,
      lon: r.longitude,
      timezone: r.timezone,
      elevation: r.elevation,
      source: "geocode" as const,
    },
    population: r.population,
  }));
}

/** Geocoder matches with population, used to judge whether a name is ambiguous. */
export async function geocodeCandidates(
  http: HttpClient,
  query: string,
  count = 5,
): Promise<GeocodeCandidate[]> {
  const params = new URLSearchParams({ name: query, count: String(count), format: "json" });
  const raw = await http.json<GeocodeResponse>(`${GEOCODE_URL}?${params}`, {
    ttlMs: 30 * 24 * 3600_000,
  });
  return parseGeocode(raw);
}

export async function geocode(http: HttpClient, query: string, count = 5): Promise<Location[]> {
  return (await geocodeCandidates(http, query, count)).map((c) => c.location);
}
