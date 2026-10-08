import type { RGB } from "./color.ts";

/**
 * A sub-cell pixel canvas. Pixels are addressed at braille resolution
 * (2×4 per terminal cell) and can be encoded to braille (lines/outlines)
 * or half-blocks (filled color fields, 1×2 per cell).
 */

export interface Cell {
  ch: string;
  fg?: RGB;
  bg?: RGB;
}

const BRAILLE_BASE = 0x2800;
// Bit for (x, y) within a 2×4 braille cell.
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  private readonly on: Uint8Array;
  private readonly color: (RGB | undefined)[];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.width = cols * 2;
    this.height = rows * 4;
    this.on = new Uint8Array(this.width * this.height);
    this.color = new Array(this.width * this.height);
  }

  set(x: number, y: number, c?: RGB): void {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = yi * this.width + xi;
    this.on[i] = 1;
    if (c) this.color[i] = c;
  }

  /** Independent copy, so cached line work can be drawn over without mutating the cache. */
  clone(): PixelCanvas {
    const c = new PixelCanvas(this.cols, this.rows);
    c.on.set(this.on);
    for (let i = 0; i < this.color.length; i++) c.color[i] = this.color[i];
    return c;
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.on[y * this.width + x] === 1;
  }

  colorAt(x: number, y: number): RGB | undefined {
    return this.color[y * this.width + x];
  }

  /** Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, c?: RGB): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    // Guard against absurd lines from projection blowups.
    for (let guard = 0; guard < 100_000; guard++) {
      this.set(ax, ay, c);
      if (ax === bx && ay === by) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  circle(cx: number, cy: number, r: number, c?: RGB, fill = false): void {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (fill ? d <= r * r : Math.abs(Math.sqrt(d) - r) < 0.6) this.set(cx + x, cy + y, c);
      }
    }
  }

  /** Encode to a grid of braille cells; cell color is the most common lit pixel color. */
  toBraille(): Cell[][] {
    const out: Cell[][] = [];
    for (let row = 0; row < this.rows; row++) {
      const line: Cell[] = [];
      for (let col = 0; col < this.cols; col++) {
        let bits = 0;
        let fg: RGB | undefined;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const x = col * 2 + dx;
            const y = row * 4 + dy;
            const i = y * this.width + x;
            if (this.on[i]) {
              bits |= BRAILLE_BITS[dy]?.[dx] ?? 0;
              fg ??= this.color[i];
            }
          }
        }
        line.push({ ch: bits ? String.fromCharCode(BRAILLE_BASE + bits) : " ", fg });
      }
      out.push(line);
    }
    return out;
  }
}

/**
 * A color field at half-block resolution (1×2 per cell), encoded with ▀
 * using fg for the top pixel and bg for the bottom pixel.
 */
export class HalfBlockField {
  private readonly px: (RGB | undefined)[];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.px = new Array(cols * rows * 2);
  }

  get height(): number {
    return this.rows * 2;
  }

  set(x: number, y: number, c: RGB | undefined): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.height) return;
    this.px[y * this.cols + x] = c;
  }

  get(x: number, y: number): RGB | undefined {
    return this.px[y * this.cols + x];
  }

  toCells(): Cell[][] {
    const out: Cell[][] = [];
    for (let row = 0; row < this.rows; row++) {
      const line: Cell[] = [];
      for (let col = 0; col < this.cols; col++) {
        const top = this.get(col, row * 2);
        const bottom = this.get(col, row * 2 + 1);
        if (!top && !bottom) line.push({ ch: " " });
        else if (top && !bottom) line.push({ ch: "▀", fg: top });
        else if (!top && bottom) line.push({ ch: "▄", fg: bottom });
        else line.push({ ch: "▀", fg: top, bg: bottom });
      }
      out.push(line);
    }
    return out;
  }
}

/** Overlay cells onto a base grid. Background of the base is preserved when the top has none. */
export function composite(base: Cell[][], top: Cell[][]): Cell[][] {
  return base.map((line, r) =>
    line.map((cell, c) => {
      const t = top[r]?.[c];
      if (!t || t.ch === " ") return cell;
      return { ch: t.ch, fg: t.fg ?? cell.fg, bg: t.bg ?? cell.bg };
    }),
  );
}
