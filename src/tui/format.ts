import { precipKind } from "../domain/conditions.ts";
import type { Condition, Severity } from "../domain/types.ts";
import { hex, type RGB, scale, temperatureScale } from "../render/color.ts";
import type { FxKind } from "../render/fx.ts";
import { clockTime } from "../render/units.ts";
import { paint, toHexStr } from "./theme.ts";

/** Shared formatting/color helpers for the dashboard views. */

export const SEVERITY_COLOR: Record<Severity, RGB> = {
  extreme: hex("#ff1744"),
  severe: hex("#ff6d00"),
  moderate: hex("#ffd600"),
  minor: hex("#64b5f6"),
  unknown: hex("#b0bec5"),
};

export const precipScale = scale([
  [0, "#2b3640"],
  [20, "#4f7cac"],
  [60, "#29b6f6"],
  [100, "#00e5ff"],
]);

/** Data color → hex string, drained of hue under the mono theme. */
export const hexOf = (c: RGB) => toHexStr(paint(c));
export const tcolor = (c: number) => hexOf(temperatureScale(c));

export function fmtTime(iso: string | undefined, tz?: string, withMinutes = true): string {
  if (!iso) return "--";
  // clockTime honors the 12/24h setting from config.
  return clockTime(iso, tz, withMinutes);
}

/** "3pm" style short hour label. */
export const shortHour = (iso: string, tz?: string) =>
  fmtTime(iso, tz, false).replace(" ", "").toLowerCase();

export function sceneKind(cond: Condition, isDay: boolean): FxKind {
  if (cond === "drizzle") return "drizzle";
  if (cond === "sleet" || cond === "freezing-rain") return "sleet";
  if (cond === "hail") return "hail";
  const k = precipKind(cond);
  if (k === "rain" || k === "snow" || k === "storm" || k === "fog") return k;
  if (cond === "clear" || cond === "mostly-clear") return isDay ? "clear-day" : "clear-night";
  return "none";
}

export const SIMULATE: Record<string, Condition> = {
  rain: "rain",
  drizzle: "drizzle",
  sleet: "sleet",
  hail: "hail",
  snow: "snow",
  storm: "thunderstorm",
  thunder: "thunderstorm",
  fog: "fog",
  clear: "clear",
  cloudy: "cloudy",
  partly: "partly-cloudy",
};

/** Index of the hour containing `now` (or 0). */
export function currentHourIndex(times: Array<{ time: string }>, now = Date.now()): number {
  return Math.max(0, times.findIndex((h) => new Date(h.time).getTime() > now) - 1);
}
