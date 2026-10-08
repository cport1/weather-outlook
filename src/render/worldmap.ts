import { type GeoProjection, geoMercator, geoNaturalEarth1, geoPath } from "d3-geo";
import type { FeatureCollection, MultiLineString } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries50 from "world-atlas/countries-50m.json" with { type: "json" };
import land110 from "world-atlas/land-110m.json" with { type: "json" };
import { type Cell, composite, HalfBlockField, PixelCanvas } from "./canvas.ts";
import { hex, type RGB } from "./color.ts";

export interface Camera {
  /** Center longitude/latitude. */
  lon: number;
  lat: number;
  /** 1 = whole world fits the viewport. */
  zoom: number;
}

export interface MapMarker {
  lon: number;
  lat: number;
  glyph: string;
  color: RGB;
  label?: string;
}

export interface MapPath {
  coords: Array<[lon: number, lat: number]>;
  color: RGB;
}

export interface MapLayers {
  markers?: MapMarker[];
  paths?: MapPath[];
  /** Optional per-pixel color field (e.g. temperature, radar), sampled at half-block resolution. */
  field?: (lon: number, lat: number) => RGB | undefined;
}

export interface MapTheme {
  ocean: RGB;
  land: RGB;
  coast: RGB;
  border: RGB;
}

export const DEFAULT_THEME: MapTheme = {
  ocean: hex("#0b1a2e"),
  land: hex("#1d3b2a"),
  coast: hex("#5fb3a1"),
  border: hex("#3d6b5c"),
};

const landTopo = land110 as unknown as Topology<{ land: GeometryCollection }>;
const countriesTopo = countries50 as unknown as Topology<{ countries: GeometryCollection }>;
let landFeature: FeatureCollection | undefined;
let borderMesh: MultiLineString | undefined;

function landGeo(): FeatureCollection {
  landFeature ??= feature(landTopo, landTopo.objects.land) as unknown as FeatureCollection;
  return landFeature;
}

function borders(): MultiLineString {
  borderMesh ??= mesh(
    countriesTopo,
    countriesTopo.objects.countries,
    (a, b) => a !== b,
  ) as MultiLineString;
  return borderMesh;
}

/** Build a projection that maps the camera onto a pixel space of the given size. */
export function makeProjection(cam: Camera, pxWidth: number, pxHeight: number): GeoProjection {
  // Terminal cells are ~2:1 tall; braille pixels are 2×4 per cell so they are ~square already.
  const base = cam.zoom >= 4 ? geoMercator() : geoNaturalEarth1();
  const proj = base.precision(0.5);
  proj.fitExtent(
    [
      [0, 0],
      [pxWidth, pxHeight],
    ],
    { type: "Sphere" },
  );
  proj.scale(proj.scale() * cam.zoom).rotate([-cam.lon, 0]);
  const center = proj([cam.lon, cam.lat]);
  const t = proj.translate();
  if (center) proj.translate([t[0] + pxWidth / 2 - center[0], t[1] + pxHeight / 2 - center[1]]);
  return proj;
}

/** Minimal path context that rasterizes d3-geo output into a PixelCanvas. */
function canvasContext(canvas: PixelCanvas, color: RGB) {
  let x0 = 0;
  let y0 = 0;
  let sx = 0;
  let sy = 0;
  return {
    beginPath() {},
    moveTo(x: number, y: number) {
      x0 = sx = x;
      y0 = sy = y;
    },
    lineTo(x: number, y: number) {
      canvas.line(x0, y0, x, y, color);
      x0 = x;
      y0 = y;
    },
    closePath() {
      canvas.line(x0, y0, sx, sy, color);
      x0 = sx;
      y0 = sy;
    },
    arc() {},
  };
}

/** Even-odd scanline fill of the projected land into a half-block field. */
function fillLand(
  field: HalfBlockField,
  proj: GeoProjection,
  theme: MapTheme,
  overlay?: MapLayers["field"],
): void {
  const scaleX = 2; // braille px per half-block px horizontally
  const scaleY = 2; // braille px per half-block px vertically (4 per cell vs 2 per cell)
  // Use invert() at each half-block pixel for the field so fills are exact even across antimeridian.
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.cols; x++) {
      const ll = proj.invert?.([x * scaleX + 1, y * scaleY + 1]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90) {
        continue;
      }
      // Reject points that don't round-trip (outside the projection's sphere).
      const back = proj(ll);
      if (
        !back ||
        Math.abs(back[0] - (x * scaleX + 1)) > 2 ||
        Math.abs(back[1] - (y * scaleY + 1)) > 2
      ) {
        continue;
      }
      const isLand = pointInLand(ll[0], ll[1]);
      const over = overlay?.(ll[0], ll[1]);
      field.set(x, y, over ?? (isLand ? theme.land : theme.ocean));
    }
  }
}

// --- point-in-land via a coarse precomputed lookup grid (0.5° resolution) ---
let landGrid: Uint8Array | undefined;
const GRID_RES = 0.5;
const GRID_W = 360 / GRID_RES;
const GRID_H = 180 / GRID_RES;

function buildLandGrid(): Uint8Array {
  const grid = new Uint8Array(GRID_W * GRID_H);
  const rings: Array<Array<[number, number]>> = [];
  for (const f of landGeo().features) {
    const g = f.geometry;
    if (g.type === "Polygon") for (const r of g.coordinates) rings.push(r as [number, number][]);
    if (g.type === "MultiPolygon")
      for (const p of g.coordinates) for (const r of p) rings.push(r as [number, number][]);
  }
  // Scanline even-odd fill per grid row.
  for (let gy = 0; gy < GRID_H; gy++) {
    const lat = 90 - (gy + 0.5) * GRID_RES;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (!a || !b) continue;
        if (a[1] > lat !== b[1] > lat) {
          xs.push(a[0] + ((lat - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.floor(((xs[k] ?? 0) + 180) / GRID_RES));
      const to = Math.min(GRID_W - 1, Math.floor(((xs[k + 1] ?? 0) + 180) / GRID_RES));
      for (let gx = from; gx <= to; gx++) grid[gy * GRID_W + gx] = 1;
    }
  }
  return grid;
}

export function pointInLand(lon: number, lat: number): boolean {
  landGrid ??= buildLandGrid();
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const gx = Math.min(GRID_W - 1, Math.max(0, Math.floor((l + 180) / GRID_RES)));
  const gy = Math.min(GRID_H - 1, Math.max(0, Math.floor((90 - lat) / GRID_RES)));
  return landGrid[gy * GRID_W + gx] === 1;
}

/**
 * Render the world map with overlays into a grid of styled cells.
 * Layering: half-block fill (ocean/land/field) → braille coast+borders → markers.
 */
export function renderWorldMap(
  cols: number,
  rows: number,
  cam: Camera,
  layers: MapLayers = {},
  theme: MapTheme = DEFAULT_THEME,
  opts: { fill?: boolean } = {},
): Cell[][] {
  const lines = new PixelCanvas(cols, rows);
  const proj = makeProjection(cam, lines.width, lines.height);

  const field = new HalfBlockField(cols, rows);
  if (opts.fill !== false) fillLand(field, proj, theme, layers.field);
  const base = field.toCells();

  if (cam.zoom >= 2) geoPath(proj, canvasContext(lines, theme.border) as never)(borders());
  geoPath(proj, canvasContext(lines, theme.coast) as never)(landGeo());
  for (const p of layers.paths ?? []) {
    let prev: [number, number] | null = null;
    for (const c of p.coords) {
      const pt = proj(c);
      if (pt && prev && Math.abs(pt[0] - prev[0]) < lines.width / 2) {
        lines.line(prev[0], prev[1], pt[0], pt[1], p.color);
      }
      prev = pt;
    }
  }
  // Braille glyphs take the base cell's background so lines sit on the fill.
  const braille = lines
    .toBraille()
    .map((line, r) =>
      line.map((cell, c) => ({ ...cell, bg: base[r]?.[c]?.bg ?? base[r]?.[c]?.fg })),
    );
  let out = composite(base, braille);

  if (layers.markers?.length) {
    const top: Cell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: " " }) as Cell),
    );
    for (const m of layers.markers) {
      const pt = proj([m.lon, m.lat]);
      if (!pt) continue;
      const c = Math.floor(pt[0] / 2);
      const r = Math.floor(pt[1] / 4);
      const row = top[r];
      if (!row || c < 0 || c >= cols) continue;
      row[c] = { ch: m.glyph, fg: m.color };
      if (m.label) {
        [...m.label].forEach((ch, i) => {
          if (c + 2 + i < cols) row[c + 2 + i] = { ch, fg: m.color };
        });
      }
    }
    out = composite(out, top);
  }
  return out;
}
