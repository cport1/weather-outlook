import {
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  RGBA,
} from "@opentui/core";
import { extend } from "@opentui/solid";
import type { Cell } from "../render/canvas.ts";
import type { RGB } from "../render/color.ts";
import { gray, isMono } from "./theme.ts";

/**
 * A renderable that delegates drawing to a callback each frame. Used for
 * the world map, charts and particle effects, which draw cell-by-cell.
 */
export interface CellCanvasOptions extends RenderableOptions<CellCanvas> {
  draw?: (api: DrawApi, width: number, height: number, dtMs: number) => void;
}

export interface DrawApi {
  cell(x: number, y: number, ch: string, fg?: RGB, bg?: RGB): void;
  blend(x: number, y: number, ch: string, fg: RGB, alpha?: number): void;
  text(x: number, y: number, s: string, fg?: RGB, bg?: RGB): void;
  grid(cells: Cell[][], x?: number, y?: number): void;
  fill(bg: RGB): void;
  /** Ask for another frame soon (for short animations on a non-live canvas). */
  requestFrame(): void;
}

const cache = new Map<string, RGBA>();
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

export function rgba(c: RGB | undefined, alpha = 1): RGBA {
  if (!c) return TRANSPARENT;
  if (isMono()) c = gray(c);
  const key = `${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha}`;
  let v = cache.get(key);
  if (!v) {
    v = RGBA.fromInts(c[0] | 0, c[1] | 0, c[2] | 0, Math.round(alpha * 255));
    if (cache.size > 4096) cache.clear();
    cache.set(key, v);
  }
  return v;
}

// Every canvas that asked to animate, so they can all be paused together
// (terminal lost focus) without each view having to know about it.
const animated = new Set<CellCanvas>();
let paused = false;

/** Stop (or resume) every live canvas. With nothing live the renderer idles at 0 fps. */
export function setAnimationsPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  for (const c of animated) c.syncLive();
}

export const animationsPaused = () => paused;

export class CellCanvas extends Renderable {
  private _draw: CellCanvasOptions["draw"];
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  declare private _wantLive: boolean | undefined;

  constructor(ctx: RenderContext, options: CellCanvasOptions) {
    super(ctx, options);
    this._draw = options.draw;
  }

  override get live(): boolean {
    return super.live;
  }

  /** `live` is what the view asked for; the renderable only goes live when not paused. */
  override set live(value: boolean) {
    this._wantLive = value;
    if (value) animated.add(this);
    else animated.delete(this);
    super.live = value && !paused;
  }

  syncLive(): void {
    super.live = Boolean(this._wantLive) && !paused;
  }

  protected override destroySelf(): void {
    animated.delete(this);
    super.destroySelf();
  }

  set draw(fn: CellCanvasOptions["draw"]) {
    this._draw = fn;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const draw = this._draw;
    if (!draw) return;
    const ox = this.x;
    const oy = this.y;
    const w = this.width;
    const h = this.height;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
    const api: DrawApi = {
      cell(x, y, ch, fg, bg) {
        if (!inside(x, y)) return;
        if (bg) buffer.setCell(ox + x, oy + y, ch, rgba(fg ?? [255, 255, 255]), rgba(bg));
        else
          buffer.setCellWithAlphaBlending(
            ox + x,
            oy + y,
            ch,
            rgba(fg ?? [255, 255, 255]),
            TRANSPARENT,
          );
      },
      blend(x, y, ch, fg, alpha = 1) {
        if (!inside(x, y)) return;
        buffer.setCellWithAlphaBlending(ox + x, oy + y, ch, rgba(fg, alpha), TRANSPARENT);
      },
      text(x, y, s, fg, bg) {
        let i = 0;
        for (const ch of s) api.cell(x + i++, y, ch, fg, bg);
      },
      grid(cells, x = 0, y = 0) {
        for (let r = 0; r < cells.length; r++) {
          const row = cells[r];
          if (!row) continue;
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (cell) api.cell(x + c, y + r, cell.ch, cell.fg, cell.bg);
          }
        }
      },
      fill(bg) {
        buffer.fillRect(ox, oy, w, h, rgba(bg));
      },
      requestFrame: () => {
        if (this.frameTimer) return;
        this.frameTimer = setTimeout(() => {
          this.frameTimer = undefined;
          this.requestRender();
        }, 16);
      },
    };
    draw(api, w, h, deltaTime);
  }
}

// Register the JSX intrinsic here so any view importing this module can use it.
extend({ cell_canvas: CellCanvas });

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    cell_canvas: typeof CellCanvas;
  }
}
