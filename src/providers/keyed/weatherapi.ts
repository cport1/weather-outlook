import type { Condition, DailyPoint, Forecast, HourlyPoint } from "../../domain/types.ts";
import type { ForecastProvider } from "../provider.ts";
import { epochIso, kmToM, num } from "./common.ts";

/**
 * WeatherAPI.com forecast endpoint (current + up to 3 days on the free plan).
 * Docs: https://www.weatherapi.com/docs/
 */

const API = "https://api.weatherapi.com/v1/forecast.json";

interface WaCondition {
  text?: string;
  code: number;
}

interface WaHour {
  time_epoch: number;
  temp_c: number;
  feelslike_c?: number;
  is_day?: number;
  condition: WaCondition;
  wind_kph?: number;
  wind_degree?: number;
  gust_kph?: number;
  precip_mm?: number;
  humidity?: number;
  cloud?: number;
  uv?: number;
  chance_of_rain?: number;
  chance_of_snow?: number;
}

export interface WeatherApiResponse {
  location?: { tz_id?: string; localtime_epoch?: number };
  current: {
    last_updated_epoch: number;
    temp_c: number;
    feelslike_c?: number;
    dewpoint_c?: number;
    is_day?: number;
    condition: WaCondition;
    wind_kph?: number;
    wind_degree?: number;
    gust_kph?: number;
    pressure_mb?: number;
    precip_mm?: number;
    humidity?: number;
    cloud?: number;
    vis_km?: number;
    uv?: number;
  };
  forecast?: {
    forecastday: Array<{
      date: string;
      day: {
        maxtemp_c: number;
        mintemp_c: number;
        totalprecip_mm?: number;
        daily_chance_of_rain?: number;
        daily_chance_of_snow?: number;
        maxwind_kph?: number;
        uv?: number;
        condition: WaCondition;
      };
      hour?: WaHour[];
    }>;
  };
}

/** https://www.weatherapi.com/docs/weather_conditions.json */
export function fromWeatherApiCode(code: number): Condition {
  switch (code) {
    case 1000:
      return "clear";
    case 1003:
      return "partly-cloudy";
    case 1006:
    case 1009:
      return "cloudy";
    case 1030:
    case 1135:
    case 1147:
      return "fog";
    case 1063:
    case 1180:
    case 1240:
      return "showers";
    case 1072:
    case 1150:
    case 1153:
      return "drizzle";
    case 1168:
    case 1171:
    case 1198:
    case 1201:
      return "freezing-rain";
    case 1183:
    case 1186:
    case 1189:
      return "rain";
    case 1192:
    case 1195:
    case 1243:
    case 1246:
      return "heavy-rain";
    case 1069:
    case 1204:
    case 1207:
    case 1237:
    case 1249:
    case 1252:
    case 1261:
    case 1264:
      return "sleet";
    case 1066:
    case 1210:
    case 1213:
    case 1216:
    case 1219:
    case 1255:
      return "snow";
    case 1114:
    case 1117:
    case 1222:
    case 1225:
    case 1258:
      return "heavy-snow";
    case 1087:
    case 1273:
    case 1276:
    case 1279:
    case 1282:
      return "thunderstorm";
    default:
      return "unknown";
  }
}

const chance = (rain?: number, snow?: number) =>
  rain === undefined && snow === undefined ? undefined : Math.max(rain ?? 0, snow ?? 0);

export function parseWeatherApi(raw: WeatherApiResponse, now = new Date()): Forecast {
  const days = raw.forecast?.forecastday ?? [];
  const hourly: HourlyPoint[] = days.flatMap((d) =>
    (d.hour ?? []).map((h) => ({
      time: epochIso(h.time_epoch),
      temperature: h.temp_c,
      feelsLike: num(h.feelslike_c),
      precipitationProbability: chance(h.chance_of_rain, h.chance_of_snow),
      precipitation: num(h.precip_mm),
      windSpeed: num(h.wind_kph),
      windGust: num(h.gust_kph),
      windDirection: num(h.wind_degree),
      humidity: num(h.humidity),
      cloudCover: num(h.cloud),
      uvIndex: num(h.uv),
      condition: fromWeatherApiCode(h.condition.code),
      isDay: h.is_day !== 0,
    })),
  );
  const daily: DailyPoint[] = days.map((d) => ({
    date: d.date,
    tempMax: d.day.maxtemp_c,
    tempMin: d.day.mintemp_c,
    precipitationSum: num(d.day.totalprecip_mm),
    precipitationProbability: chance(d.day.daily_chance_of_rain, d.day.daily_chance_of_snow),
    windSpeedMax: num(d.day.maxwind_kph),
    windGustMax: (() => {
      const g = (d.hour ?? []).map((h) => h.gust_kph).filter((v): v is number => v !== undefined);
      return g.length ? Math.max(...g) : undefined;
    })(),
    uvIndexMax: num(d.day.uv),
    condition: fromWeatherApiCode(d.day.condition.code),
  }));
  const c = raw.current;
  return {
    provider: "weatherapi",
    fetchedAt: now.toISOString(),
    current: {
      time: epochIso(c.last_updated_epoch),
      temperature: c.temp_c,
      feelsLike: num(c.feelslike_c),
      humidity: num(c.humidity),
      dewPoint: num(c.dewpoint_c),
      pressure: num(c.pressure_mb),
      windSpeed: num(c.wind_kph),
      windGust: num(c.gust_kph),
      windDirection: num(c.wind_degree),
      cloudCover: num(c.cloud),
      visibility: kmToM(c.vis_km),
      precipitation: num(c.precip_mm),
      uvIndex: num(c.uv),
      condition: fromWeatherApiCode(c.condition.code),
      isDay: c.is_day !== 0,
    },
    hourly,
    daily,
  };
}

export const weatherApi: ForecastProvider = {
  id: "weatherapi",
  label: "WeatherAPI.com",
  aliases: ["weatherapi.com"],
  envVar: "WEATHERAPI_KEY",
  docs: "https://www.weatherapi.com/docs/",
  async fetch(http, loc, { key, refresh }) {
    const params = new URLSearchParams({
      key: key ?? "",
      q: `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,
      days: "3",
      aqi: "no",
      alerts: "no",
    });
    const raw = await http.json<WeatherApiResponse>(`${API}?${params}`, {
      ttlMs: 10 * 60_000,
      refresh,
    });
    return { forecast: parseWeatherApi(raw) };
  },
};
