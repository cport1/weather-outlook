import type { Condition } from "./types.ts";

/** WMO 4677 weather interpretation codes (as used by Open-Meteo) → Condition. */
export function fromWmo(code: number): Condition {
  if (code === 0) return "clear";
  if (code === 1) return "mostly-clear";
  if (code === 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezing-rain";
  if (code === 61 || code === 63) return "rain";
  if (code === 65) return "heavy-rain";
  if (code === 71 || code === 73 || code === 77) return "snow";
  if (code === 75) return "heavy-snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow";
  if (code === 95) return "thunderstorm";
  if (code === 96 || code === 99) return "hail";
  return "unknown";
}

export const CONDITION_LABEL: Record<Condition, string> = {
  clear: "Clear",
  "mostly-clear": "Mostly clear",
  "partly-cloudy": "Partly cloudy",
  cloudy: "Overcast",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
  "freezing-rain": "Freezing rain",
  snow: "Snow",
  "heavy-snow": "Heavy snow",
  sleet: "Sleet",
  showers: "Showers",
  thunderstorm: "Thunderstorm",
  hail: "Thunderstorm with hail",
  unknown: "Unknown",
};

/** Small single-glyph icon for tables and sparklines. */
export function conditionGlyph(c: Condition, isDay = true): string {
  switch (c) {
    case "clear":
      return isDay ? "☀" : "☾";
    case "mostly-clear":
    case "partly-cloudy":
      return isDay ? "⛅" : "☁";
    case "cloudy":
      return "☁";
    case "fog":
      return "≋";
    case "drizzle":
    case "rain":
    case "heavy-rain":
    case "showers":
      return "☂";
    case "freezing-rain":
    case "sleet":
      return "❄";
    case "snow":
    case "heavy-snow":
      return "❄";
    case "thunderstorm":
    case "hail":
      return "⚡";
    default:
      return "?";
  }
}

/** Precipitation family, used to choose particle animations. */
export function precipKind(c: Condition): "rain" | "snow" | "storm" | "fog" | "none" {
  switch (c) {
    case "drizzle":
    case "rain":
    case "heavy-rain":
    case "showers":
    case "freezing-rain":
      return "rain";
    case "snow":
    case "heavy-snow":
    case "sleet":
      return "snow";
    case "thunderstorm":
    case "hail":
      return "storm";
    case "fog":
      return "fog";
    default:
      return "none";
  }
}
