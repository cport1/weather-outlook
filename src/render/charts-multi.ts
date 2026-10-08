import { type Cell, PixelCanvas } from "./canvas.ts";
import type { RGB } from "./color.ts";

export interface ChartSeries {
  values: ReadonlyArray<number | null>;
  color: RGB;
}

export interface ChartBand {
  min: ReadonlyArray<number | null>;
  max: ReadonlyArray<number | null>;
  /** Painted as the cell background behind the lines. */
  color: RGB;
}

const ok = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Shared value range across series (and band) with a little headroom. */
export function seriesRange(
  series: ReadonlyArray<ChartSeries>,
  band?: ChartBand,
): { min: number; max: number } {
  const all = [
    ...series.flatMap((s) => s.values.filter(ok)),
    ...(band ? [...band.min.filter(ok), ...band.max.filter(ok)] : []),
  ];
  if (!all.length) return { min: 0, max: 1 };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.05;
  return { min: lo - pad, max: hi + pad };
}

/**
 * Several braille lines on one canvas (later series draw over earlier ones),
 * with an optional min/max band shaded in the background.
 */
export function multiLineChart(
  series: ReadonlyArray<ChartSeries>,
  cols: number,
  rows: number,
  opts: { range?: { min: number; max: number }; band?: ChartBand } = {},
): Cell[][] {
  const canvas = new PixelCanvas(cols, rows);
  const { min, max } = opts.range ?? seriesRange(series, opts.band);
  const span = max - min || 1;
  const n = Math.max(1, ...series.map((s) => s.values.length), opts.band?.min.length ?? 0);
  const xFor = (i: number) => (i / Math.max(1, n - 1)) * (canvas.width - 1);
  const yFor = (v: number) => (1 - (v - min) / span) * (canvas.height - 1);
  for (const s of series) {
    let prev: [number, number] | undefined;
    s.values.forEach((v, i) => {
      if (!ok(v)) {
        prev = undefined;
        return;
      }
      const p: [number, number] = [xFor(i), yFor(v)];
      if (prev) canvas.line(prev[0], prev[1], p[0], p[1], s.color);
      else canvas.set(p[0], p[1], s.color);
      prev = p;
    });
  }
  const cells = canvas.toBraille();
  const band = opts.band;
  if (band) {
    for (let col = 0; col < cols; col++) {
      const i = Math.round((col / Math.max(1, cols - 1)) * (n - 1));
      const lo = band.min[i];
      const hi = band.max[i];
      if (!ok(lo) || !ok(hi)) continue;
      const top = Math.floor(yFor(hi) / 4);
      const bottom = Math.floor(yFor(lo) / 4);
      for (let r = Math.max(0, top); r <= Math.min(rows - 1, bottom); r++) {
        const cell = cells[r]?.[col];
        if (cell) cell.bg = band.color;
      }
    }
  }
  return cells;
}

/** One block glyph per value, scaled to `max` (for short precipitation bars). */
export function blockBar(values: ReadonlyArray<number>, max: number): string[] {
  const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values.map((v) =>
    v <= 0
      ? (BLOCKS[1] ?? "▁")
      : (BLOCKS[Math.max(1, Math.min(8, Math.ceil((v / (max || 1)) * 8)))] ?? "█"),
  );
}
