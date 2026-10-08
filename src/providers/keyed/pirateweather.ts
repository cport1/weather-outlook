import type { DailyPoint, Forecast, HourlyPoint, Location } from "../../domain/types.ts";
import { nowcastHeadline } from "../nowcast.ts";
import type { ForecastProvider, ProviderResult } from "../provider.ts";
import { epochIso, fromIcon, kmToM, msToKmh, num, pct, sunUp } from "./common.ts";

/**
 * Pirate Weather (Dark Sky–compatible schema), requested with `units=si`.
 * Docs: https://docs.pirateweather.net/en/latest/API/
 */

const API = "https://api.pirateweather.net/forecast";

type DataPoint = Record<string, number | string | null | undefined> & { time: number };
export interface PirateResponse {
  latitude: number;
  longitude: number;
  timezone?: string;
  offset?: number;
  currently?: DataPoint;
  minutely?: { data: DataPoint[] };
  hourly?: { data: DataPoint[] };
  daily?: { data: DataPoint[] };
}

const icon = (p: DataPoint) => (typeof p.icon === "string" ? p.icon : undefined);

export function parsePirate(
  raw: PirateResponse,
  loc: Pick<Location, "lat" | "lon">,
  now = new Date(),
): ProviderResult {
  const offsetSec = (raw.offset ?? 0) * 3600;
  const hourly: HourlyPoint[] = (raw.hourly?.data ?? []).map((h) => {
    const time = epochIso(h.time);
    return {
      time,
      temperature: num(h.temperature) ?? Number.NaN,
      feelsLike: num(h.apparentTemperature),
      precipitationProbability: pct(h.precipProbability),
      // precipIntensity is mm/h, so it equals the hourly amount.
      precipitation: num(h.precipIntensity),
      windSpeed: msToKmh(h.windSpeed),
      windGust: msToKmh(h.windGust),
      windDirection: num(h.windBearing),
      humidity: pct(h.humidity),
      cloudCover: pct(h.cloudCover),
      uvIndex: num(h.uvIndex),
      condition: fromIcon(icon(h)),
      isDay: sunUp(time, loc.lat, loc.lon),
    };
  });
  const daily: DailyPoint[] = (raw.daily?.data ?? []).map((d) => {
    const acc = num(d.precipAccumulation);
    const rate = num(d.precipIntensity);
    return {
      date: new Date((d.time + offsetSec) * 1000).toISOString().slice(0, 10),
      tempMax: num(d.temperatureMax) ?? num(d.temperatureHigh) ?? Number.NaN,
      tempMin: num(d.temperatureMin) ?? num(d.temperatureLow) ?? Number.NaN,
      // SI precipAccumulation is in centimetres.
      precipitationSum: acc !== undefined ? acc * 10 : rate !== undefined ? rate * 24 : undefined,
      precipitationProbability: pct(d.precipProbability),
      windSpeedMax: msToKmh(d.windSpeed),
      windGustMax: msToKmh(d.windGust),
      uvIndexMax: num(d.uvIndex),
      sunrise: typeof d.sunriseTime === "number" ? epochIso(d.sunriseTime) : undefined,
      sunset: typeof d.sunsetTime === "number" ? epochIso(d.sunsetTime) : undefined,
      condition: fromIcon(icon(d)),
    };
  });
  const c = raw.currently ?? raw.hourly?.data[0];
  const ctime = c ? epochIso(c.time) : now.toISOString();
  const forecast: Forecast = {
    provider: "pirateweather",
    fetchedAt: now.toISOString(),
    current: {
      time: ctime,
      temperature: num(c?.temperature) ?? Number.NaN,
      feelsLike: num(c?.apparentTemperature),
      humidity: pct(c?.humidity),
      dewPoint: num(c?.dewPoint),
      pressure: num(c?.pressure),
      windSpeed: msToKmh(c?.windSpeed),
      windGust: msToKmh(c?.windGust),
      windDirection: num(c?.windBearing),
      cloudCover: pct(c?.cloudCover),
      visibility: kmToM(c?.visibility),
      precipitation: num(c?.precipIntensity),
      uvIndex: num(c?.uvIndex),
      condition: c ? fromIcon(icon(c)) : "unknown",
      isDay: c ? !String(icon(c) ?? "").endsWith("night") && sunUp(ctime, loc.lat, loc.lon) : true,
    },
    hourly,
    daily,
  };
  const points = (raw.minutely?.data ?? []).map((m) => ({
    time: epochIso(m.time),
    rate: num(m.precipIntensity) ?? 0,
    snow: m.precipType === "snow" || undefined,
  }));
  return {
    forecast,
    nowcast: points.length
      ? {
          provider: "pirateweather",
          interval: 1,
          points,
          headline: nowcastHeadline(points, now.getTime()),
        }
      : undefined,
  };
}

export const pirateWeather: ForecastProvider = {
  id: "pirateweather",
  label: "Pirate Weather",
  aliases: ["pirate"],
  envVar: "PIRATEWEATHER_API_KEY",
  docs: "https://docs.pirateweather.net/",
  async fetch(http, loc, { key, refresh }) {
    const url = `${API}/${encodeURIComponent(key ?? "")}/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}?units=si&exclude=alerts`;
    const raw = await http.json<PirateResponse>(url, { ttlMs: 10 * 60_000, refresh });
    return parsePirate(raw, loc);
  },
};
