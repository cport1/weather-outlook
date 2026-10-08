import type { Condition, DailyPoint, Forecast, HourlyPoint, Location } from "../../domain/types.ts";
import { nowcastHeadline } from "../nowcast.ts";
import type { ForecastProvider, ProviderResult } from "../provider.ts";
import { kmToM, msToKmh, num, sunUp } from "./common.ts";

/**
 * Tomorrow.io Weather Forecast API v4 (minutely, hourly and daily timelines).
 * Docs: https://docs.tomorrow.io/reference/weather-forecast
 */

const API = "https://api.tomorrow.io/v4/weather/forecast";

type Values = Record<string, number | string | null | undefined>;
interface Interval {
  time: string;
  values: Values;
}
export interface TomorrowResponse {
  timelines: { minutely?: Interval[]; hourly?: Interval[]; daily?: Interval[] };
  location?: { lat: number; lon: number };
}

/** https://docs.tomorrow.io/reference/data-layers-weather-codes (5-digit day/night variants included). */
export function fromTomorrowCode(raw: number): Condition {
  const code = raw >= 10000 ? Math.floor(raw / 10) : raw;
  switch (code) {
    case 1000:
      return "clear";
    case 1100:
      return "mostly-clear";
    case 1101:
      return "partly-cloudy";
    case 1102:
    case 1001:
      return "cloudy";
    case 2000:
    case 2100:
      return "fog";
    case 4000:
      return "drizzle";
    case 4200:
      return "showers";
    case 4001:
      return "rain";
    case 4201:
      return "heavy-rain";
    case 5000:
    case 5001:
    case 5100:
      return "snow";
    case 5101:
      return "heavy-snow";
    case 6000:
    case 6001:
    case 6200:
    case 6201:
      return "freezing-rain";
    case 7000:
    case 7101:
    case 7102:
      return "sleet";
    case 8000:
      return "thunderstorm";
    default:
      return "unknown";
  }
}

/** Liquid-equivalent precipitation intensity in mm/h. */
function intensity(v: Values): number {
  const direct = num(v.precipitationIntensity);
  if (direct !== undefined) return direct;
  return ["rainIntensity", "snowIntensity", "sleetIntensity", "freezingRainIntensity"]
    .map((k) => num(v[k]) ?? 0)
    .reduce((a, b) => a + b, 0);
}

export function parseTomorrow(
  raw: TomorrowResponse,
  loc: Pick<Location, "lat" | "lon">,
  now = new Date(),
): ProviderResult {
  const hours = raw.timelines.hourly ?? [];
  const hourly: HourlyPoint[] = hours.map((h) => ({
    time: h.time,
    temperature: num(h.values.temperature) ?? Number.NaN,
    feelsLike: num(h.values.temperatureApparent),
    precipitationProbability: num(h.values.precipitationProbability),
    precipitation: intensity(h.values),
    windSpeed: msToKmh(h.values.windSpeed),
    windGust: msToKmh(h.values.windGust),
    windDirection: num(h.values.windDirection),
    humidity: num(h.values.humidity),
    cloudCover: num(h.values.cloudCover),
    uvIndex: num(h.values.uvIndex),
    condition: fromTomorrowCode(num(h.values.weatherCode) ?? 0),
    isDay: sunUp(h.time, loc.lat, loc.lon),
  }));
  const daily: DailyPoint[] = (raw.timelines.daily ?? []).map((d) => {
    const v = d.values;
    return {
      // Daily intervals start at local midnight expressed in UTC; the date part is close enough
      // for most locations, but prefer the sunrise's date when present.
      date: (typeof v.sunriseTime === "string" ? v.sunriseTime : d.time).slice(0, 10),
      tempMax: num(v.temperatureMax) ?? Number.NaN,
      tempMin: num(v.temperatureMin) ?? Number.NaN,
      precipitationSum:
        (num(v.rainAccumulationSum) ?? 0) + (num(v.snowAccumulationLweSum) ?? 0) || undefined,
      precipitationProbability:
        num(v.precipitationProbabilityMax) ?? num(v.precipitationProbabilityAvg),
      windSpeedMax: msToKmh(v.windSpeedMax),
      windGustMax: msToKmh(v.windGustMax),
      uvIndexMax: num(v.uvIndexMax),
      sunrise: typeof v.sunriseTime === "string" ? v.sunriseTime : undefined,
      sunset: typeof v.sunsetTime === "string" ? v.sunsetTime : undefined,
      condition: fromTomorrowCode(num(v.weatherCodeMax) ?? num(v.weatherCodeMin) ?? 0),
    };
  });
  const minutely = raw.timelines.minutely ?? [];
  const first = minutely[0] ?? hours[0];
  const cv = first?.values ?? {};
  const forecast: Forecast = {
    provider: "tomorrow.io",
    fetchedAt: now.toISOString(),
    current: {
      time: first?.time ?? now.toISOString(),
      temperature: num(cv.temperature) ?? Number.NaN,
      feelsLike: num(cv.temperatureApparent),
      humidity: num(cv.humidity),
      dewPoint: num(cv.dewPoint),
      pressure: num(cv.pressureSeaLevel) ?? num(cv.pressureSurfaceLevel),
      windSpeed: msToKmh(cv.windSpeed),
      windGust: msToKmh(cv.windGust),
      windDirection: num(cv.windDirection),
      cloudCover: num(cv.cloudCover),
      visibility: kmToM(cv.visibility),
      precipitation: intensity(cv),
      uvIndex: num(cv.uvIndex),
      condition: fromTomorrowCode(num(cv.weatherCode) ?? 0),
      isDay: first ? sunUp(first.time, loc.lat, loc.lon) : true,
    },
    hourly,
    daily,
  };
  const points = minutely.map((m) => ({
    time: m.time,
    rate: intensity(m.values),
    snow: (num(m.values.snowIntensity) ?? 0) > 0 || undefined,
  }));
  return {
    forecast,
    nowcast: points.length
      ? {
          provider: "tomorrow.io",
          interval: 1,
          points,
          headline: nowcastHeadline(points, now.getTime()),
        }
      : undefined,
  };
}

export const tomorrowIo: ForecastProvider = {
  id: "tomorrow",
  label: "Tomorrow.io",
  aliases: ["tomorrow.io", "tomorrowio"],
  envVar: "TOMORROW_API_KEY",
  docs: "https://docs.tomorrow.io/reference/weather-forecast",
  async fetch(http, loc, { key, refresh }) {
    const params = new URLSearchParams({
      location: `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,
      units: "metric",
      apikey: key ?? "",
    });
    const raw = await http.json<TomorrowResponse>(`${API}?${params}`, {
      ttlMs: 10 * 60_000,
      refresh,
    });
    return parseTomorrow(raw, loc);
  },
};
