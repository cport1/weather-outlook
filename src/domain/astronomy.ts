import * as SunCalc from "suncalc";
import type { Astronomy } from "./types.ts";

const PHASES = [
  [0.0625, "New Moon"],
  [0.1875, "Waxing Crescent"],
  [0.3125, "First Quarter"],
  [0.4375, "Waxing Gibbous"],
  [0.5625, "Full Moon"],
  [0.6875, "Waning Gibbous"],
  [0.8125, "Last Quarter"],
  [0.9375, "Waning Crescent"],
  [1.0001, "New Moon"],
] as const;

export function moonPhaseName(phase: number): string {
  return PHASES.find(([limit]) => phase < limit)?.[1] ?? "New Moon";
}

const iso = (d: Date | null | undefined) =>
  d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;

export function computeAstronomy(lat: number, lon: number, date = new Date()): Astronomy {
  const sun = SunCalc.getTimes(date, lat, lon);
  const moon = SunCalc.getMoonIllumination(date);
  const moonTimes = SunCalc.getMoonTimes(date, lat, lon);
  const dayLength =
    sun.sunrise && sun.sunset && !Number.isNaN(sun.sunrise.getTime())
      ? Math.round((sun.sunset.getTime() - sun.sunrise.getTime()) / 60_000)
      : undefined;
  return {
    sunrise: iso(sun.sunrise),
    sunset: iso(sun.sunset),
    solarNoon: iso(sun.solarNoon),
    dayLengthMin: dayLength,
    moonPhase: moon.phase,
    moonPhaseName: moonPhaseName(moon.phase),
    moonIllumination: moon.fraction,
    moonrise: iso(moonTimes.rise),
    moonset: iso(moonTimes.set),
  };
}

/** Moon phase as a single emoji-free glyph sequence for terminals without emoji fonts. */
export function moonGlyph(phase: number): string {
  const glyphs = ["●", "◑", "◑", "◑", "○", "◐", "◐", "◐"]; // waxing = right side lit (N. hemisphere)
  return glyphs[Math.floor(((phase + 1 / 16) % 1) * 8)] ?? "●";
}
