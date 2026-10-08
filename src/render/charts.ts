import type { Cell } from "./canvas.ts";
import { PixelCanvas } from "./canvas.ts";
import type { RGB } from "./color.ts";

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export function sparkline(values: number[], min?: number, max?: number): string[] {
  const finite = values.filter(Number.isFinite);
  const lo = min ?? Math.min(...finite);
  const hi = max ?? Math.max(...finite);
  const span = hi - lo || 1;
  return values.map((v) =>
    Number.isFinite(v) ? (SPARK[Math.round(((v - lo) / span) * 7)] ?? "▁") : " ",
  );
}

/** Horizontal bar with eighth-block precision. */
export function hbar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(f);
  const rem = Math.round((f - full) * 8);
  return "█".repeat(full) + (EIGHTHS[rem] ?? "");
}

/**
 * Braille line chart. `colorFor` lets each plotted pixel be colored by its value
 * (e.g. a temperature gradient), which is what makes these charts pop.
 */
export function lineChart(
  values: number[],
  cols: number,
  rows: number,
  colorFor: (v: number) => RGB,
  range?: { min: number; max: number },
): Cell[][] {
  const canvas = new PixelCanvas(cols, rows);
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return canvas.toBraille();
  const lo = range?.min ?? Math.min(...finite);
  const hi = range?.max ?? Math.max(...finite);
  const span = hi - lo || 1;
  const xFor = (i: number) => (i / Math.max(1, values.length - 1)) * (canvas.width - 1);
  const yFor = (v: number) => (1 - (v - lo) / span) * (canvas.height - 1);
  let prev: [number, number, number] | undefined;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      prev = undefined;
      return;
    }
    const x = xFor(i);
    const y = yFor(v);
    if (prev) canvas.line(prev[0], prev[1], x, y, colorFor((prev[2] + v) / 2));
    else canvas.set(x, y, colorFor(v));
    prev = [x, y, v];
  });
  return canvas.toBraille();
}
