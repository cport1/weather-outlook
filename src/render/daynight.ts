import { hex, lerp, type RGB } from "./color.ts";
import type { PixelShader } from "./worldmap.ts";

const RAD = Math.PI / 180;

/**
 * Subsolar point (where the sun is directly overhead) from the NOAA
 * low-precision solar position formulas: declination + equation of time.
 * Accurate to a few hundredths of a degree, which is far below a pixel.
 */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360; // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * RAD; // obliquity
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  // Greenwich mean sidereal time (degrees) → the longitude where the sun's hour angle is 0.
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / RAD - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: decl / RAD, lon };
}

/** Sun elevation in degrees at lon/lat given the subsolar point. */
export function solarElevation(
  lon: number,
  lat: number,
  sub: { lat: number; lon: number },
): number {
  const p = lat * RAD;
  const d = sub.lat * RAD;
  const h = (lon - sub.lon) * RAD;
  return Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h)) / RAD;
}

/** 0 in daylight → 1 in full night, with a soft twilight band down to −12° (nautical dusk). */
export function nightFactor(elevation: number): number {
  if (elevation >= 0) return 0;
  if (elevation <= -12) return 1;
  return -elevation / 12;
}

const NIGHT: RGB = hex("#020509");

/** Shader that darkens the night side of the planet for the given time. */
export function nightShader(date: Date, strength = 0.6): PixelShader {
  const sub = subsolarPoint(date);
  // Precompute per-call trig of the subsolar point; the per-pixel work is one asin.
  const sd = Math.sin(sub.lat * RAD);
  const cd = Math.cos(sub.lat * RAD);
  return (lon, lat, c) => {
    const p = lat * RAD;
    const s = Math.sin(p) * sd + Math.cos(p) * cd * Math.cos((lon - sub.lon) * RAD);
    const k = nightFactor(Math.asin(Math.max(-1, Math.min(1, s))) / RAD);
    return k ? lerp(c, NIGHT, k * strength) : c;
  };
}
