import type { HourlyPoint } from "../domain/types.ts";
import type { Cell } from "./canvas.ts";
import { PixelCanvas } from "./canvas.ts";
import { type RGB, scale } from "./color.ts";

/** Braille instruments for the Now panel: wind compass, arc gauges, trends. */

export const uvScale = scale([
  [0, "#4caf50"],
  [2.5, "#c0ca33"],
  [5, "#fdd835"],
  [7, "#fb8c00"],
  [9, "#e53935"],
  [11, "#8e24aa"],
]);

export function uvLabel(uv: number): string {
  if (uv < 3) return "low";
  if (uv < 6) return "moderate";
  if (uv < 8) return "high";
  if (uv < 11) return "very high";
  return "extreme";
}

export function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "sensitive";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "very bad";
  return "hazardous";
}

/** How the air feels, from dew point (°C). */
export function dewComfort(dewC: number): string {
  if (dewC < 5) return "dry";
  if (dewC < 10) return "comfortable";
  if (dewC < 13) return "pleasant";
  if (dewC < 16) return "a bit humid";
  if (dewC < 18) return "humid";
  if (dewC < 21) return "sticky";
  if (dewC < 24) return "muggy";
  return "oppressive";
}

export interface PressureTrend {
  /** hPa change over the window (positive = rising). */
  delta: number;
  arrow: string;
  label: string;
}

/**
 * Pressure tendency over the last `hours` (meteorological convention is 3h).
 * Compares the current reading with the hourly series; undefined without data.
 */
export function pressureTrend(
  hourly: HourlyPoint[],
  current: number | undefined,
  now = Date.now(),
  hours = 3,
): PressureTrend | undefined {
  const target = now - hours * 3600_000;
  let past: HourlyPoint | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const h of hourly) {
    if (h.pressure === undefined) continue;
    const d = Math.abs(new Date(h.time).getTime() - target);
    if (d < best) {
      best = d;
      past = h;
    }
  }
  if (!past || past.pressure === undefined || best > 2 * 3600_000) return undefined;
  // Prefer the observed current pressure; fall back to the hourly value nearest now.
  let nowP = current;
  if (nowP === undefined) {
    let nb = Number.POSITIVE_INFINITY;
    for (const h of hourly) {
      const d = Math.abs(new Date(h.time).getTime() - now);
      if (h.pressure !== undefined && d < nb) {
        nb = d;
        nowP = h.pressure;
      }
    }
  }
  if (nowP === undefined) return undefined;
  const delta = nowP - past.pressure;
  const a = Math.abs(delta);
  if (a < 1) return { delta, arrow: "→", label: "steady" };
  const rising = delta > 0;
  if (a >= 3)
    return { delta, arrow: rising ? "⇈" : "⇊", label: rising ? "rising fast" : "falling fast" };
  return { delta, arrow: rising ? "↗" : "↘", label: rising ? "rising" : "falling" };
}

/**
 * Braille compass rose. `toward` is the direction (degrees, 0 = N) the arrow
 * points; for wind that is where the air is going (from-direction + 180).
 */
export function compassRose(
  cols: number,
  rows: number,
  toward: number,
  ring: RGB,
  arrow: RGB,
  tick: RGB = ring,
): Cell[][] {
  const c = new PixelCanvas(cols, rows);
  const cx = (c.width - 1) / 2;
  const cy = (c.height - 1) / 2;
  const r = Math.min(cx, cy);
  // Arrow first so it wins the per-cell color where it crosses the ring.
  const a = (toward * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const tipX = cx + dx * (r - 1.5);
  const tipY = cy + dy * (r - 1.5);
  const tailX = cx - dx * (r - 3);
  const tailY = cy - dy * (r - 3);
  c.line(tailX, tailY, tipX, tipY, arrow);
  // Arrowhead: two short barbs angled back from the tip.
  for (const side of [-1, 1]) {
    const b = a + Math.PI + side * 0.5;
    c.line(tipX, tipY, tipX + Math.sin(b) * 3.5, tipY - Math.cos(b) * 3.5, arrow);
  }
  // Tail feathers.
  c.line(tailX - dy * 1.5, tailY + dx * 1.5, tailX + dy * 1.5, tailY - dx * 1.5, arrow);
  for (let deg = 0; deg < 360; deg += 4) {
    const t = (deg * Math.PI) / 180;
    c.set(cx + Math.sin(t) * r, cy - Math.cos(t) * r, deg % 90 === 0 ? tick : ring);
  }
  return c.toBraille();
}

/**
 * Semicircular arc gauge. The filled part is colored along `colorFor` so the
 * arc reads as a gradient; the rest of the track is drawn in `track`.
 */
export function arcGauge(
  value: number,
  max: number,
  cols: number,
  rows: number,
  colorFor: (v: number) => RGB,
  track: RGB,
): Cell[][] {
  const c = new PixelCanvas(cols, rows);
  const cx = (c.width - 1) / 2;
  const cy = c.height - 1;
  const r = Math.min(cx, cy);
  const frac = Math.max(0, Math.min(1, value / max));
  // Filled first (wins the cell color), then the track.
  for (const pass of ["fill", "track"] as const) {
    for (let i = 0; i <= 90; i++) {
      const f = i / 90;
      const filled = f <= frac && frac > 0;
      if ((pass === "fill") !== filled) continue;
      const t = Math.PI * (1 - f);
      for (const rr of [r, r - 1]) {
        c.set(cx + Math.cos(t) * rr, cy - Math.sin(t) * rr, filled ? colorFor(f * max) : track);
      }
    }
  }
  return c.toBraille();
}
