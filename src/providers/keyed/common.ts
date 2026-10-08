import * as SunCalc from "suncalc";
import type { Condition, DailyPoint, HourlyPoint } from "../../domain/types.ts";

/** Shared helpers for the optional API-keyed forecast providers. */

export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** m/s → km/h (the domain model's wind unit). */
export const msToKmh = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 3.6 * 10) / 10;
};

/** 0–1 fraction → percent. */
export const pct = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 100);
};

/** km → m. */
export const kmToM = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : n * 1000;
};

export const epochIso = (sec: number): string => new Date(sec * 1000).toISOString();

/** Whether the sun is up at `iso` for a location; used where providers omit a day/night flag. */
export function sunUp(iso: string, lat: number, lon: number): boolean {
  return SunCalc.getPosition(new Date(iso), lat, lon).altitude > 0;
}

/** Local calendar date (YYYY-MM-DD) of a UTC epoch at a fixed UTC offset. */
export function localDate(sec: number, offsetSec: number): string {
  return new Date((sec + offsetSec) * 1000).toISOString().slice(0, 10);
}

const SEVERITY: Condition[] = [
  "unknown",
  "clear",
  "mostly-clear",
  "partly-cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "showers",
  "rain",
  "sleet",
  "snow",
  "freezing-rain",
  "heavy-rain",
  "heavy-snow",
  "thunderstorm",
  "hail",
];

/** The most significant of several conditions (for rolling hours up into a day). */
export function worstCondition(cs: Condition[]): Condition {
  let best: Condition = "unknown";
  for (const c of cs) if (SEVERITY.indexOf(c) > SEVERITY.indexOf(best)) best = c;
  return best;
}

/** Roll an hourly series up into daily points when a provider has no daily product. */
export function dailyFromHourly(
  hours: HourlyPoint[],
  dateOf: (h: HourlyPoint) => string,
): DailyPoint[] {
  const groups = new Map<string, HourlyPoint[]>();
  for (const h of hours) {
    const d = dateOf(h);
    const g = groups.get(d) ?? [];
    g.push(h);
    groups.set(d, g);
  }
  return [...groups].map(([date, hs]) => {
    const temps = hs.map((h) => h.temperature).filter(Number.isFinite);
    const precip = hs.map((h) => h.precipitation).filter((v): v is number => v !== undefined);
    const pops = hs
      .map((h) => h.precipitationProbability)
      .filter((v): v is number => v !== undefined);
    const winds = hs.map((h) => h.windSpeed).filter((v): v is number => v !== undefined);
    const gusts = hs.map((h) => h.windGust).filter((v): v is number => v !== undefined);
    return {
      date,
      tempMax: temps.length ? Math.max(...temps) : Number.NaN,
      tempMin: temps.length ? Math.min(...temps) : Number.NaN,
      precipitationSum: precip.length ? precip.reduce((a, b) => a + b, 0) : undefined,
      precipitationProbability: pops.length ? Math.max(...pops) : undefined,
      windSpeedMax: winds.length ? Math.max(...winds) : undefined,
      windGustMax: gusts.length ? Math.max(...gusts) : undefined,
      condition: worstCondition(hs.filter((h) => h.isDay).map((h) => h.condition)),
    };
  });
}

/** Dark Sky–style icon names (Pirate Weather, Visual Crossing) → Condition. */
export function fromIcon(icon: string | undefined): Condition {
  const i = (icon ?? "").toLowerCase();
  if (!i) return "unknown";
  if (i.includes("thunder")) return "thunderstorm";
  if (i.includes("hail")) return "hail";
  if (i.includes("sleet")) return "sleet";
  if (i.includes("snow")) return "snow";
  if (i.includes("showers")) return "showers";
  if (i.includes("rain") || i.includes("drizzle")) return "rain";
  if (i.includes("fog") || i.includes("haze") || i.includes("mist")) return "fog";
  if (i.includes("partly-cloudy")) return "partly-cloudy";
  if (i.includes("cloudy")) return "cloudy";
  if (i.includes("clear") || i.includes("wind")) return "clear";
  return "unknown";
}
