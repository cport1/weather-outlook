import type { Units } from "./units.ts";

/** Wave/tide heights: metres → "1.2 m" or "3.9 ft". */
export function height(m: number | undefined, units: Units): string {
  if (m === undefined || !Number.isFinite(m)) return "--";
  return units === "imperial" ? `${(m * 3.28084).toFixed(1)} ft` : `${m.toFixed(1)} m`;
}

/** A temperature difference (°C) as a signed delta in display units: "+5°", "-2°". */
export function tempDelta(dc: number | undefined, units: Units): string {
  if (dc === undefined || !Number.isFinite(dc)) return "";
  const v = Math.round(units === "imperial" ? dc * 1.8 : dc);
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}°`;
}

/** Ordinal suffix for percentiles: 1st, 2nd, 93rd. */
export function ordinal(n: number): string {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][r % 10] ?? "th");
  return `${r}${s}`;
}
