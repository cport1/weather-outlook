import type { Cell } from "./canvas.ts";
import { PixelCanvas } from "./canvas.ts";
import { hex, lerp, type RGB } from "./color.ts";

/**
 * Sky colors driven by the sun's real elevation: night → twilight → golden
 * hour → day. Renderer-agnostic so the TUI scene and tests share it.
 */

export type SkyPhase = "night" | "twilight" | "golden" | "day";

// [sun altitude°, zenith color, horizon color]
const KEYS: ReadonlyArray<readonly [number, RGB, RGB]> = [
  [-18, hex("#04060c"), hex("#0b1120")],
  [-12, hex("#080d26"), hex("#161d45")],
  [-6, hex("#141a45"), hex("#4a2f66")],
  [-2, hex("#22326a"), hex("#b0563a")],
  [2, hex("#2f5a92"), hex("#f08a4b")],
  [6, hex("#2d6aa8"), hex("#f2b36b")],
  [12, hex("#1f63a8"), hex("#7fb4dc")],
  [35, hex("#1565c0"), hex("#64b5f6")],
];

export function skyPhase(sunAltitude: number): SkyPhase {
  if (sunAltitude < -12) return "night";
  if (sunAltitude < 0) return "twilight";
  if (sunAltitude < 8) return "golden";
  return "day";
}

/** Zenith and horizon colors for a sun altitude, muted by cloud cover (0..100). */
export function skyColors(
  sunAltitude: number,
  cloudCover = 0,
  stormy = false,
): { top: RGB; horizon: RGB } {
  let top = KEYS[0]?.[1] ?? hex("#000000");
  let horizon = KEYS[0]?.[2] ?? hex("#000000");
  const last = KEYS[KEYS.length - 1];
  if (last && sunAltitude >= last[0]) {
    top = last[1];
    horizon = last[2];
  } else {
    for (let i = 1; i < KEYS.length; i++) {
      const a = KEYS[i - 1];
      const b = KEYS[i];
      if (!a || !b || sunAltitude > b[0]) continue;
      const t = (sunAltitude - a[0]) / (b[0] - a[0]);
      top = lerp(a[1], b[1], sunAltitude < a[0] ? 0 : t);
      horizon = lerp(a[2], b[2], sunAltitude < a[0] ? 0 : t);
      break;
    }
  }
  // Clouds wash colors toward grey of a similar brightness; storms darken further.
  const k = Math.max(0, Math.min(1, cloudCover / 100)) * 0.75;
  const greyOf = (c: RGB): RGB => {
    const l = (c[0] + c[1] + c[2]) / 3;
    return [l * 0.95, l, l * 1.05];
  };
  top = lerp(top, greyOf(top), k);
  horizon = lerp(horizon, greyOf(horizon), k);
  if (stormy) {
    top = lerp(top, hex("#0e1116"), 0.55);
    horizon = lerp(horizon, hex("#1c222b"), 0.5);
  }
  return { top, horizon };
}

/** Strength (0..1) of the warm sunrise/sunset glow along the horizon. */
export function horizonGlow(sunAltitude: number): number {
  if (sunAltitude < -10 || sunAltitude > 10) return 0;
  return Math.max(0, 1 - Math.abs(sunAltitude + 1) / 9);
}

/**
 * Place a body on the sky panel. The panel looks south (north in the southern
 * hemisphere): east on the left, west on the right, horizon on the bottom row.
 * Returns undefined when the body is below the horizon.
 */
export function skyPoint(
  azimuth: number,
  altitude: number,
  width: number,
  height: number,
  southernHemisphere = false,
): { x: number; y: number } | undefined {
  if (altitude < -1) return undefined;
  // Azimuth is from south, west positive. Facing north flips it.
  let az = southernHemisphere ? (azimuth > 0 ? 180 - azimuth : -180 - azimuth) : azimuth;
  az = Math.max(-120, Math.min(120, az));
  const x = Math.round(width / 2 + (az / 120) * (width / 2 - 2));
  const horizon = height - 2;
  const y = Math.round(horizon - (Math.max(0, altitude) / 90) * (horizon - 1));
  return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, y) };
}

/**
 * The moon as a braille disk with its real phase lit. Phase follows suncalc:
 * 0 new, 0.25 first quarter (right side lit in the north), 0.5 full.
 */
export function moonDisk(
  phase: number,
  cols = 3,
  rows = 2,
  lit: RGB = hex("#f1f3e0"),
  southernHemisphere = false,
): Cell[][] {
  const c = new PixelCanvas(cols, rows);
  const rx = c.width / 2;
  const ry = c.height / 2;
  const k = Math.cos(2 * Math.PI * phase);
  for (let py = 0; py < c.height; py++) {
    for (let px = 0; px < c.width; px++) {
      const x = (px + 0.5 - rx) / rx;
      const y = (py + 0.5 - ry) / ry;
      if (x * x + y * y > 1) continue;
      const edge = Math.sqrt(1 - y * y);
      const xs = southernHemisphere ? -x : x;
      const on = phase <= 0.5 ? xs > edge * k : xs < -edge * k;
      if (on) c.set(px, py, lit);
    }
  }
  return c.toBraille();
}
