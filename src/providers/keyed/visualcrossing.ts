import type { DailyPoint, Forecast, HourlyPoint } from "../../domain/types.ts";
import type { ForecastProvider } from "../provider.ts";
import { epochIso, fromIcon, kmToM, num } from "./common.ts";

/**
 * Visual Crossing Timeline API (metric unit group: °C, km/h, mm, km, hPa).
 * Docs: https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/
 */

const API = "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline";

type Obs = Record<string, number | string | null | undefined> & { datetimeEpoch: number };

export interface VisualCrossingResponse {
  timezone?: string;
  tzoffset?: number;
  currentConditions?: Obs;
  days: Array<Obs & { datetime: string; hours?: Obs[] }>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function isDayFor(o: Obs, sunrise?: number, sunset?: number): boolean {
  const ic = str(o.icon) ?? "";
  if (ic.endsWith("-night")) return false;
  if (ic.endsWith("-day")) return true;
  if (sunrise && sunset) return o.datetimeEpoch >= sunrise && o.datetimeEpoch < sunset;
  return true;
}

export function parseVisualCrossing(raw: VisualCrossingResponse, now = new Date()): Forecast {
  const hourly: HourlyPoint[] = [];
  const daily: DailyPoint[] = [];
  for (const d of raw.days) {
    const sr = num(d.sunriseEpoch);
    const ss = num(d.sunsetEpoch);
    for (const h of d.hours ?? []) {
      hourly.push({
        time: epochIso(h.datetimeEpoch),
        temperature: num(h.temp) ?? Number.NaN,
        feelsLike: num(h.feelslike),
        precipitationProbability: num(h.precipprob),
        precipitation: num(h.precip),
        windSpeed: num(h.windspeed),
        windGust: num(h.windgust),
        windDirection: num(h.winddir),
        humidity: num(h.humidity),
        cloudCover: num(h.cloudcover),
        uvIndex: num(h.uvindex),
        condition: fromIcon(str(h.icon)),
        isDay: isDayFor(h, sr, ss),
      });
    }
    daily.push({
      date: d.datetime,
      tempMax: num(d.tempmax) ?? Number.NaN,
      tempMin: num(d.tempmin) ?? Number.NaN,
      precipitationSum: num(d.precip),
      precipitationProbability: num(d.precipprob),
      windSpeedMax: num(d.windspeed),
      windGustMax: num(d.windgust),
      uvIndexMax: num(d.uvindex),
      sunrise: sr ? epochIso(sr) : undefined,
      sunset: ss ? epochIso(ss) : undefined,
      condition: fromIcon(str(d.icon)),
    });
  }
  const c = raw.currentConditions ?? raw.days[0]?.hours?.[0];
  const today = raw.days[0];
  return {
    provider: "visualcrossing",
    fetchedAt: now.toISOString(),
    current: {
      time: c ? epochIso(c.datetimeEpoch) : now.toISOString(),
      temperature: num(c?.temp) ?? Number.NaN,
      feelsLike: num(c?.feelslike),
      humidity: num(c?.humidity),
      dewPoint: num(c?.dew),
      pressure: num(c?.pressure),
      windSpeed: num(c?.windspeed),
      windGust: num(c?.windgust),
      windDirection: num(c?.winddir),
      cloudCover: num(c?.cloudcover),
      visibility: kmToM(c?.visibility),
      precipitation: num(c?.precip),
      uvIndex: num(c?.uvindex),
      condition: fromIcon(str(c?.icon)),
      isDay: c
        ? isDayFor(
            c,
            num(c.sunriseEpoch) ?? num(today?.sunriseEpoch),
            num(c.sunsetEpoch) ?? num(today?.sunsetEpoch),
          )
        : true,
    },
    hourly,
    daily,
  };
}

export const visualCrossing: ForecastProvider = {
  id: "visualcrossing",
  label: "Visual Crossing",
  aliases: ["vc"],
  envVar: "VISUALCROSSING_API_KEY",
  docs: "https://www.visualcrossing.com/weather-api",
  async fetch(http, loc, { key, refresh }) {
    const params = new URLSearchParams({
      unitGroup: "metric",
      include: "current,hours,days",
      contentType: "json",
      key: key ?? "",
    });
    const url = `${API}/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}?${params}`;
    const raw = await http.json<VisualCrossingResponse>(url, { ttlMs: 15 * 60_000, refresh });
    return { forecast: parseVisualCrossing(raw) };
  },
};
