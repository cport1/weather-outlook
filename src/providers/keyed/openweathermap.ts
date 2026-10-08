import type { Condition, Forecast, HourlyPoint } from "../../domain/types.ts";
import type { ForecastProvider } from "../provider.ts";
import { dailyFromHourly, epochIso, localDate, msToKmh, num } from "./common.ts";

/**
 * OpenWeatherMap free tier (API 2.5): /weather for current conditions and
 * /forecast for 5 days in 3-hour steps. One Call 3.0 needs a separate
 * subscription, so it's deliberately not used.
 * Docs: https://openweathermap.org/current, https://openweathermap.org/forecast5
 */

const API = "https://api.openweathermap.org/data/2.5";

interface OwmWeather {
  id: number;
  main?: string;
  description?: string;
  icon?: string;
}

export interface OwmCurrent {
  dt: number;
  timezone?: number;
  weather: OwmWeather[];
  main: {
    temp: number;
    feels_like?: number;
    pressure?: number;
    humidity?: number;
    sea_level?: number;
  };
  visibility?: number;
  wind?: { speed?: number; deg?: number; gust?: number };
  clouds?: { all?: number };
  rain?: { "1h"?: number };
  snow?: { "1h"?: number };
  sys?: { sunrise?: number; sunset?: number };
}

export interface OwmForecast {
  list: Array<{
    dt: number;
    main: { temp: number; feels_like?: number; humidity?: number };
    weather: OwmWeather[];
    clouds?: { all?: number };
    wind?: { speed?: number; deg?: number; gust?: number };
    pop?: number;
    rain?: { "3h"?: number };
    snow?: { "3h"?: number };
    sys?: { pod?: "d" | "n" };
  }>;
  city?: { timezone?: number; sunrise?: number; sunset?: number };
}

/** https://openweathermap.org/weather-conditions */
export function fromOwmCode(id: number): Condition {
  if (id >= 200 && id < 300) return "thunderstorm";
  if (id >= 300 && id < 400) return "drizzle";
  if (id === 511) return "freezing-rain";
  if (id >= 502 && id <= 504) return "heavy-rain";
  if (id >= 500 && id < 520) return "rain";
  if (id >= 520 && id < 600) return "showers";
  if (id === 602 || id === 622) return "heavy-snow";
  if (id >= 611 && id <= 616) return "sleet";
  if (id >= 600 && id < 700) return "snow";
  if (id >= 700 && id < 800) return "fog";
  if (id === 800) return "clear";
  if (id === 801) return "mostly-clear";
  if (id === 802) return "partly-cloudy";
  if (id === 803 || id === 804) return "cloudy";
  return "unknown";
}

export function parseOwm(current: OwmCurrent, fc: OwmForecast, now = new Date()): Forecast {
  const offset = fc.city?.timezone ?? current.timezone ?? 0;
  const hourly: HourlyPoint[] = fc.list.map((e) => ({
    time: epochIso(e.dt),
    temperature: e.main.temp,
    feelsLike: num(e.main.feels_like),
    precipitationProbability: e.pop !== undefined ? Math.round(e.pop * 100) : undefined,
    precipitation: (e.rain?.["3h"] ?? 0) + (e.snow?.["3h"] ?? 0),
    windSpeed: msToKmh(e.wind?.speed),
    windGust: msToKmh(e.wind?.gust),
    windDirection: num(e.wind?.deg),
    humidity: num(e.main.humidity),
    cloudCover: num(e.clouds?.all),
    condition: fromOwmCode(e.weather[0]?.id ?? -1),
    isDay: e.sys?.pod !== "n",
  }));
  const daily = dailyFromHourly(hourly, (h) => localDate(Date.parse(h.time) / 1000, offset));
  const sunrise = current.sys?.sunrise;
  const sunset = current.sys?.sunset;
  const c = current;
  return {
    provider: "openweathermap",
    fetchedAt: now.toISOString(),
    current: {
      time: epochIso(c.dt),
      temperature: c.main.temp,
      feelsLike: num(c.main.feels_like),
      humidity: num(c.main.humidity),
      pressure: num(c.main.sea_level) ?? num(c.main.pressure),
      windSpeed: msToKmh(c.wind?.speed),
      windGust: msToKmh(c.wind?.gust),
      windDirection: num(c.wind?.deg),
      cloudCover: num(c.clouds?.all),
      visibility: num(c.visibility),
      precipitation: (c.rain?.["1h"] ?? 0) + (c.snow?.["1h"] ?? 0),
      condition: fromOwmCode(c.weather[0]?.id ?? -1),
      isDay: sunrise && sunset ? c.dt >= sunrise && c.dt < sunset : true,
    },
    hourly,
    daily,
  };
}

export const openWeatherMap: ForecastProvider = {
  id: "openweathermap",
  label: "OpenWeatherMap",
  aliases: ["owm"],
  envVar: "OWM_API_KEY",
  docs: "https://openweathermap.org/api",
  async fetch(http, loc, { key, refresh }) {
    const q = `lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}&units=metric&appid=${encodeURIComponent(key ?? "")}`;
    const [current, forecast] = await Promise.all([
      http.json<OwmCurrent>(`${API}/weather?${q}`, { ttlMs: 10 * 60_000, refresh }),
      http.json<OwmForecast>(`${API}/forecast?${q}`, { ttlMs: 30 * 60_000, refresh }),
    ]);
    return { forecast: parseOwm(current, forecast) };
  },
};
