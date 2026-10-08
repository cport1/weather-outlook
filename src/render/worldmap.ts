import { type GeoProjection, geoMercator, geoNaturalEarth1, geoPath } from "d3-geo";
import type { FeatureCollection, MultiLineString } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries50 from "world-atlas/countries-50m.json" with { type: "json" };
import land50 from "world-atlas/land-50m.json" with { type: "json" };
import land110 from "world-atlas/land-110m.json" with { type: "json" };
import { adminLines } from "./admin.ts";
import { type Cell, composite, HalfBlockField, PixelCanvas } from "./canvas.ts";
import { hex, lerp, type RGB } from "./color.ts";
import { type LabelRequest, placeLabels } from "./labels.ts";

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
  /** Label color when it differs from the glyph. */
  labelColor?: RGB;
  /** Low-priority marker: drawn only when its label can be placed without collisions. */
  optional?: boolean;
}

export interface MapPath {
  coords: Array<[lon: number, lat: number]>;
  color: RGB;
  /** Draw every other pixel run, e.g. for forecast cones. */
  dotted?: boolean;
  /** Per-vertex colors (e.g. storm track colored by category); overrides `color`. */
  colors?: RGB[];
}

export interface MapLayers {
  markers?: MapMarker[];
  paths?: MapPath[];
  /** Optional per-pixel color field (e.g. temperature, radar), sampled at half-block resolution. */
  field?: (lon: number, lat: number) => RGB | undefined;
  /** Opacity of `field` over the land/ocean fill (default 1 = opaque). */
  fieldAlpha?: number;
  /** Per-pixel post-processing applied after the fill, in order (night shading, aurora glow…). */
  shaders?: PixelShader[];
}

/** Maps a fill pixel's color at lon/lat to a new color. */
export type PixelShader = (lon: number, lat: number, color: RGB) => RGB;

export interface RenderOptions {
  /** Draw the half-block land/ocean fill (off for colorless terminals). */
  fill?: boolean;
  /** First-order admin boundaries (US states, provinces). Default: only when zoom ≥ 4. */
  admin?: boolean;
  /** Don't keep this camera's base layer in the cache (animation in-between frames). */
  transient?: boolean;
}

export interface MapTheme {
  ocean: RGB;
  land: RGB;
  coast: RGB;
  border: RGB;
  /** State/province lines; defaults to halfway between border and land. */
  admin?: RGB;
}

export const DEFAULT_THEME: MapTheme = {
  ocean: hex("#0b1a2e"),
  land: hex("#1d3b2a"),
  coast: hex("#5fb3a1"),
  border: hex("#3d6b5c"),
  admin: hex("#376452"),
};

const landTopo = land110 as unknown as Topology<{ land: GeometryCollection }>;
const countriesTopo = countries50 as unknown as Topology<{ countries: GeometryCollection }>;
const land50Topo = land50 as unknown as Topology<{ land: GeometryCollection }>;
let landFeature: FeatureCollection | undefined;
let land50Feature: FeatureCollection | undefined;
let borderMesh: MultiLineString | undefined;

function landGeo(): FeatureCollection {
  landFeature ??= feature(landTopo, landTopo.objects.land) as unknown as FeatureCollection;
  return landFeature;
}

/** 50m land outlines for zoomed-in views (coast detail). */
function land50Geo(): FeatureCollection {
  land50Feature ??= feature(land50Topo, land50Topo.objects.land) as unknown as FeatureCollection;
  return land50Feature;
}

/** Land outlines for coastline drawing; 50m detail when zoomed in. */
export function coastlineGeo(fine: boolean): FeatureCollection {
  return fine ? land50Geo() : landGeo();
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
function canvasContext(canvas: PixelCanvas, color: RGB, dotted = false) {
  let x0 = 0;
  let y0 = 0;
  let sx = 0;
  let sy = 0;
  // Dotted lines keep their phase across segments so short d3 resampling steps stay dotted.
  let phase = 0;
  const seg = (x: number, y: number) => {
    if (!dotted) {
      canvas.line(x0, y0, x, y, color);
      return;
    }
    const len = Math.hypot(x - x0, y - y0);
    for (let d = (3 - phase) % 3; d <= len; d += 3) {
      const t = len ? d / len : 0;
      canvas.set(x0 + (x - x0) * t, y0 + (y - y0) * t, color);
    }
    phase = (phase + len) % 3;
  };
  return {
    beginPath() {},
    moveTo(x: number, y: number) {
      x0 = sx = x;
      y0 = sy = y;
    },
    lineTo(x: number, y: number) {
      seg(x, y);
      x0 = x;
      y0 = y;
    },
    closePath() {
      seg(sx, sy);
      x0 = sx;
      y0 = sy;
    },
    arc() {},
  };
}

/**
 * Stroke a lon/lat polyline. Goes through d3-geo so segments that cross the
 * projection's antimeridian are cut at the seam and drawn to both map edges
 * instead of streaking across the whole map.
 */
export function strokePath(
  canvas: PixelCanvas,
  proj: GeoProjection,
  coords: ReadonlyArray<readonly [number, number]>,
  color: RGB,
  opts: { dotted?: boolean; colors?: readonly RGB[] } = {},
): void {
  if (coords.length < 2) return;
  if (opts.colors) {
    // Per-vertex colors: one LineString per segment, colored by its end vertex.
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1] as [number, number];
      const b = coords[i] as [number, number];
      const ctx = canvasContext(canvas, opts.colors[i] ?? color, opts.dotted);
      geoPath(proj, ctx as never)({ type: "LineString", coordinates: [a, b] });
    }
    return;
  }
  geoPath(
    proj,
    canvasContext(canvas, color, opts.dotted) as never,
  )({
    type: "LineString",
    coordinates: coords as Array<[number, number]>,
  });
}

// --- point-in-land via a coarse precomputed lookup grid (0.5° resolution) ---
let landGrid: Uint8Array | undefined;
const GRID_RES = 0.5;
const GRID_W = 360 / GRID_RES;
const GRID_H = 180 / GRID_RES;

type Ring = Array<[number, number]>;

/**
 * Make rings safe for scanline filling on a wrapping longitude axis:
 * longitudes are unwrapped so no edge jumps across the antimeridian, and
 * rings that encircle a pole (Antarctica) are closed through that pole.
 */
export function normalizeRings(geo: FeatureCollection): Ring[] {
  const out: Ring[] = [];
  for (const f of geo.features) {
    const g = f.geometry;
    const polys =
      g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      for (const raw of poly) {
        const first = raw[0];
        if (!first) continue;
        const ring: Ring = [[first[0] ?? 0, first[1] ?? 0]];
        let offset = 0;
        let latSum = first[1] ?? 0;
        for (let i = 1; i < raw.length; i++) {
          const prev = raw[i - 1];
          const cur = raw[i];
          if (!prev || !cur) continue;
          const dx = (cur[0] ?? 0) - (prev[0] ?? 0);
          if (dx > 180) offset -= 360;
          else if (dx < -180) offset += 360;
          ring.push([(cur[0] ?? 0) + offset, cur[1] ?? 0]);
          latSum += cur[1] ?? 0;
        }
        if (offset !== 0) {
          const pole = latSum / raw.length < 0 ? -90 : 90;
          const last = ring[ring.length - 1] as [number, number];
          ring.push([last[0], pole], [first[0] ?? 0, pole]);
        }
        out.push(ring);
      }
    }
  }
  return out;
}

/** Even-odd fill one row: crossings grouped per ring, XOR-toggled with longitude wrap. */
function fillRow(row: Uint8Array, crossingsByRing: Iterable<number[]>, res: number): void {
  const w = row.length;
  for (const xs of crossingsByRing) {
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.floor(((xs[k] ?? 0) + 180) / res);
      const to = Math.floor(((xs[k + 1] ?? 0) + 180) / res);
      const span = Math.min(w, to - from + 1);
      for (let i = 0; i < span; i++) {
        const gx = (((from + i) % w) + w) % w;
        row[gx] = (row[gx] ?? 0) ^ 1;
      }
    }
  }
}

function crossing(a: [number, number], b: [number, number], lat: number): number | undefined {
  if (a[1] > lat === b[1] > lat) return undefined;
  return a[0] + ((lat - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
}

function buildLandGrid(): Uint8Array {
  const grid = new Uint8Array(GRID_W * GRID_H);
  const rings = normalizeRings(landGeo());
  for (let gy = 0; gy < GRID_H; gy++) {
    const lat = 90 - (gy + 0.5) * GRID_RES;
    const perRing: number[][] = [];
    for (const ring of rings) {
      const xs: number[] = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const x = crossing(ring[i] as [number, number], ring[j] as [number, number], lat);
        if (x !== undefined) xs.push(x);
      }
      if (xs.length) perRing.push(xs);
    }
    fillRow(grid.subarray(gy * GRID_W, (gy + 1) * GRID_W), perRing, GRID_RES);
  }
  return grid;
}

// --- fine point-in-land: 0.05° rows from 50m data, built lazily per row ---
const FINE_RES = 0.05;
const FINE_W = Math.round(360 / FINE_RES);
let fineEdges: Float64Array | undefined; // [ax, ay, bx, by, ring] per edge, sorted by min lat
let fineMinLat: Float64Array | undefined;
const fineRows = new Map<number, Uint8Array>();

function buildFineEdges(): void {
  const edges: number[][] = [];
  normalizeRings(land50Geo()).forEach((ring, id) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a && b && a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1], id]);
    }
  });
  edges.sort((p, q) => Math.min(p[1] ?? 0, p[3] ?? 0) - Math.min(q[1] ?? 0, q[3] ?? 0));
  fineEdges = new Float64Array(edges.flat());
  fineMinLat = new Float64Array(edges.map((e) => Math.min(e[1] ?? 0, e[3] ?? 0)));
}

function fineRow(gy: number): Uint8Array {
  let row = fineRows.get(gy);
  if (row) return row;
  if (!fineEdges || !fineMinLat) buildFineEdges();
  const edges = fineEdges as Float64Array;
  const minLat = fineMinLat as Float64Array;
  const lat = 90 - (gy + 0.5) * FINE_RES;
  const perRing = new Map<number, number[]>();
  for (let k = 0; k < minLat.length && (minLat[k] ?? 0) <= lat; k++) {
    const o = k * 5;
    const x = crossing(
      [edges[o] ?? 0, edges[o + 1] ?? 0],
      [edges[o + 2] ?? 0, edges[o + 3] ?? 0],
      lat,
    );
    if (x === undefined) continue;
    const id = edges[o + 4] ?? 0;
    const list = perRing.get(id);
    if (list) list.push(x);
    else perRing.set(id, [x]);
  }
  row = new Uint8Array(FINE_W);
  fillRow(row, perRing.values(), FINE_RES);
  if (fineRows.size > 4000) fineRows.clear();
  fineRows.set(gy, row);
  return row;
}

export function pointInLandFine(lon: number, lat: number): boolean {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const gy = Math.max(
    0,
    Math.min(Math.round(180 / FINE_RES) - 1, Math.floor((90 - lat) / FINE_RES)),
  );
  const gx = Math.max(0, Math.min(FINE_W - 1, Math.floor((l + 180) / FINE_RES)));
  return fineRow(gy)[gx] === 1;
}

export function pointInLand(lon: number, lat: number): boolean {
  landGrid ??= buildLandGrid();
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const gx = Math.min(GRID_W - 1, Math.max(0, Math.floor((l + 180) / GRID_RES)));
  const gy = Math.min(GRID_H - 1, Math.max(0, Math.floor((90 - lat) / GRID_RES)));
  return landGrid[gy * GRID_W + gx] === 1;
}

/** Lon/lat bounds visible for a camera over a viewport of the given pixel aspect (width / height). */
export function viewportBbox(cam: Camera, aspect: number) {
  const w = 1000;
  const h = Math.max(1, Math.round(w / aspect));
  const proj = makeProjection(cam, w, h);
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (let i = 0; i <= 8; i++) {
    for (const [x, y] of [
      [(w * i) / 8, 0],
      [(w * i) / 8, h],
      [0, (h * i) / 8],
      [w, (h * i) / 8],
    ] as const) {
      const ll = proj.invert?.([x, y]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
      west = Math.min(west, ll[0]);
      east = Math.max(east, ll[0]);
      south = Math.min(south, ll[1]);
      north = Math.max(north, ll[1]);
    }
  }
  return { west, east, south: Math.max(-85, south), north: Math.min(85, north) };
}

/** Project lon/lat to a terminal cell for the given camera and viewport. */
export function cellProjector(cam: Camera, cols: number, rows: number) {
  const proj = makeProjection(cam, cols * 2, rows * 4);
  return (lon: number, lat: number): [col: number, row: number] | undefined => {
    const pt = proj([lon, lat]);
    if (!pt) return undefined;
    const c = Math.floor(pt[0] / 2);
    const r = Math.floor(pt[1] / 4);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return undefined;
    return [c, r];
  };
}

// --- cached base layer -------------------------------------------------------

/**
 * Everything about a map render that depends only on camera + size + theme:
 * the inverse-projected lon/lat of every half-block pixel, the land mask, and
 * the coast/border/admin line work. Overlays and shaders are applied on top
 * per call, so panning back, switching views or animating radar frames never
 * redoes the expensive projection work.
 */
interface BaseLayer {
  proj: GeoProjection;
  /** Half-block pixel grid (cols × rows*2). */
  lon: Float32Array;
  lat: Float32Array;
  /** 0 = outside the sphere, 1 = ocean, 2 = land. */
  kind: Uint8Array;
  lines: PixelCanvas;
}

const BASE_CACHE_SIZE = 8;
const baseCache = new Map<string, BaseLayer>();
let baseBuilds = 0;

/** Number of base layers built so far (for tests/diagnostics). */
export function baseLayerBuilds(): number {
  return baseBuilds;
}

function themeKey(t: MapTheme): string {
  return [t.ocean, t.land, t.coast, t.border, t.admin ?? ""].join("|");
}

function baseLayer(
  cols: number,
  rows: number,
  cam: Camera,
  theme: MapTheme,
  admin: boolean,
  transient = false,
): BaseLayer {
  const key = `${cols}x${rows}:${cam.lon.toFixed(4)},${cam.lat.toFixed(4)},${cam.zoom.toFixed(4)}:${admin ? 1 : 0}:${themeKey(theme)}`;
  const hit = baseCache.get(key);
  if (hit) {
    // Refresh LRU position.
    baseCache.delete(key);
    baseCache.set(key, hit);
    return hit;
  }
  baseBuilds++;
  const lines = new PixelCanvas(cols, rows);
  const proj = makeProjection(cam, lines.width, lines.height);
  const fine = cam.zoom >= 6;
  const h = rows * 2;
  const n = cols * h;
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  const kind = new Uint8Array(n);
  // Half-block pixels are 2×2 braille pixels; sample at their centers.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * 2 + 1;
      const py = y * 2 + 1;
      const ll = proj.invert?.([px, py]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90)
        continue;
      // Reject points that don't round-trip (outside the projection's sphere).
      const back = proj(ll);
      if (!back || Math.abs(back[0] - px) > 2 || Math.abs(back[1] - py) > 2) continue;
      const i = y * cols + x;
      lon[i] = ll[0];
      lat[i] = ll[1];
      kind[i] = (fine ? pointInLandFine(ll[0], ll[1]) : pointInLand(ll[0], ll[1])) ? 2 : 1;
    }
  }
  if (admin) {
    const color = theme.admin ?? lerp(theme.border, theme.land, 0.5);
    geoPath(proj, canvasContext(lines, color) as never)(adminLines());
  }
  if (cam.zoom >= 2) geoPath(proj, canvasContext(lines, theme.border) as never)(borders());
  geoPath(proj, canvasContext(lines, theme.coast) as never)(fine ? land50Geo() : landGeo());

  const layer: BaseLayer = { proj, lon, lat, kind, lines };
  if (transient) return layer;
  baseCache.set(key, layer);
  if (baseCache.size > BASE_CACHE_SIZE) {
    const oldest = baseCache.keys().next().value;
    if (oldest !== undefined) baseCache.delete(oldest);
  }
  return layer;
}

/**
 * Render the world map with overlays into a grid of styled cells.
 * Layering: half-block fill (ocean/land → field → shaders) → braille
 * coast/borders/admin + paths → markers.
 */
export function renderWorldMap(
  cols: number,
  rows: number,
  cam: Camera,
  layers: MapLayers = {},
  theme: MapTheme = DEFAULT_THEME,
  opts: RenderOptions = {},
): Cell[][] {
  const base = baseLayer(cols, rows, cam, theme, opts.admin ?? cam.zoom >= 4, opts.transient);
  const { proj } = base;

  const field = new HalfBlockField(cols, rows);
  if (opts.fill !== false) {
    const overlay = layers.field;
    const alpha = layers.fieldAlpha ?? 1;
    const shaders = layers.shaders ?? [];
    for (let i = 0; i < base.kind.length; i++) {
      const k = base.kind[i];
      if (!k) continue;
      const lon = base.lon[i] ?? 0;
      const lat = base.lat[i] ?? 0;
      let c: RGB = k === 2 ? theme.land : theme.ocean;
      const over = overlay?.(lon, lat);
      if (over) c = alpha >= 1 ? over : lerp(c, over, alpha);
      for (const s of shaders) c = s(lon, lat, c);
      field.set(i % cols, Math.floor(i / cols), c);
    }
  }
  const fill = field.toCells();

  let lines = base.lines;
  if (layers.paths?.length) {
    lines = lines.clone();
    for (const p of layers.paths) {
      strokePath(lines, proj, p.coords, p.color, { dotted: p.dotted, colors: p.colors });
    }
  }
  // Braille glyphs take the base cell's background so lines sit on the fill.
  const braille = lines
    .toBraille()
    .map((line, r) =>
      line.map((cell, c) => ({ ...cell, bg: fill[r]?.[c]?.bg ?? fill[r]?.[c]?.fg })),
    );
  let out = composite(fill, braille);

  if (layers.markers?.length) {
    const top: Cell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: " " }) as Cell),
    );
    const labels: Array<LabelRequest & { color: RGB; glyph: string }> = [];
    for (const m of layers.markers) {
      const pt = proj([m.lon, m.lat]);
      if (!pt) continue;
      const c = Math.floor(pt[0] / 2);
      const r = Math.floor(pt[1] / 4);
      const row = top[r];
      if (!row || c < 0 || c >= cols) continue;
      // Optional markers (e.g. city dots) only appear if their label finds room.
      if (!m.optional) row[c] = { ch: m.glyph, fg: m.color };
      if (m.label) {
        labels.push({
          col: c,
          row: r,
          text: m.label,
          color: m.labelColor ?? m.color,
          glyph: m.glyph,
          optional: m.optional,
        });
      }
    }
    for (const l of placeLabels(labels, cols, rows)) {
      const row = top[l.y];
      if (row) [...l.text].forEach((ch, i) => (row[l.x + i] = { ch, fg: l.color }));
      const anchor = top[l.row]?.[l.col];
      if (l.optional && anchor?.ch === " ") {
        (top[l.row] as Cell[])[l.col] = { ch: l.glyph, fg: l.color };
      }
    }
    out = composite(out, top);
  }
  return out;
}
