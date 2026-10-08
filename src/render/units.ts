export type Units = "metric" | "imperial";

export function temp(c: number, units: Units, withUnit = true): string {
  if (!Number.isFinite(c)) return "--";
  const v = units === "imperial" ? (c * 9) / 5 + 32 : c;
  return `${Math.round(v)}°${withUnit ? (units === "imperial" ? "F" : "C") : ""}`;
}

export function speed(kmh: number | undefined, units: Units): string {
  if (kmh === undefined) return "--";
  return units === "imperial" ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`;
}

export function precip(mm: number | undefined, units: Units): string {
  if (mm === undefined) return "--";
  return units === "imperial" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}

export function distance(m: number | undefined, units: Units): string {
  if (m === undefined) return "--";
  return units === "imperial"
    ? `${(m / 1609.344).toFixed(m < 16_000 ? 1 : 0)} mi`
    : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function pressure(hpa: number | undefined, units: Units): string {
  if (hpa === undefined) return "--";
  return units === "imperial" ? `${(hpa * 0.02953).toFixed(2)} inHg` : `${Math.round(hpa)} hPa`;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
const ARROWS = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];

export function compass(deg: number | undefined): string {
  if (deg === undefined) return "";
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] ?? "";
}

/** Arrow pointing where the wind is blowing *to* (meteorological direction is where it's from). */
export function windArrow(deg: number | undefined): string {
  if (deg === undefined) return "·";
  return ARROWS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] ?? "·";
}

/** Default units by country: imperial for the US and a few others. */
export function defaultUnits(countryCode?: string): Units {
  return ["US", "LR", "MM", "PR", "GU", "VI", "AS", "MP"].includes(countryCode?.toUpperCase() ?? "")
    ? "imperial"
    : "metric";
}
