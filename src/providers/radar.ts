import { NativeImage } from "@opentui/core";
import type { RGB } from "../render/color.ts";
import type { HttpClient } from "../util/http.ts";

/** A decoded radar raster that can be sampled by lon/lat. */
export interface RadarRaster {
  time: number;
  source: "rainviewer" | "iem";
  sample(lon: number, lat: number): RGB | undefined;
}

export interface RadarFrame {
  time: number;
  path: string;
}

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface Decoded {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decode PNG → straight RGBA using OpenTUI's native (Zig) image codec. */
function decodePng(bytes: Uint8Array): Decoded {
  const img = NativeImage.decode(bytes);
  try {
    const data = new Uint8Array(img.width * img.height * 4);
    img.copyTo(data, { format: "rgba8" });
    return { width: img.width, height: img.height, data };
  } finally {
    img.dispose();
  }
}

function pixel(img: Decoded, x: number, y: number): RGB | undefined {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return undefined;
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  // Treat faint/transparent pixels as no echo.
  if ((img.data[i + 3] ?? 0) < 96) return undefined;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

// ─── RainViewer (global) ──────────────────────────────────────────────────

const RAINVIEWER_MAX_ZOOM = 7; // free tier: z>=8 returns a "Zoom Level Not Supported" placeholder

interface WeatherMaps {
  host: string;
  radar: { past: RadarFrame[]; nowcast: RadarFrame[] };
}

export async function fetchRainViewerFrames(
  http: HttpClient,
): Promise<{ host: string; frames: RadarFrame[] }> {
  const maps = await http.json<WeatherMaps>("https://api.rainviewer.com/public/weather-maps.json", {
    ttlMs: 5 * 60_000,
  });
  return { host: maps.host, frames: [...maps.radar.past, ...maps.radar.nowcast] };
}

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Choose a tile zoom so the bbox spans roughly `targetPx` tile pixels across. */
export function chooseZoom(bbox: Bbox, targetPx: number): number {
  const span = Math.max(0.1, bbox.east - bbox.west);
  const z = Math.round(Math.log2((targetPx / 256) * (360 / span)));
  return Math.max(1, Math.min(RAINVIEWER_MAX_ZOOM, z));
}

/** Fetch and stitch the RainViewer tiles that cover a bbox for one frame. */
export async function fetchRainViewerRaster(
  http: HttpClient,
  host: string,
  frame: RadarFrame,
  bbox: Bbox,
  targetPx = 400,
): Promise<RadarRaster> {
  const z = chooseZoom(bbox, targetPx);
  const n = 2 ** z;
  const x0 = Math.floor(lon2x(bbox.west, z));
  const x1 = Math.floor(lon2x(bbox.east, z));
  const y0 = Math.max(0, Math.floor(lat2y(bbox.north, z)));
  const y1 = Math.min(n - 1, Math.floor(lat2y(bbox.south, z)));
  const tiles = new Map<string, Decoded>();
  const jobs: Promise<void>[] = [];
  for (let tx = x0; tx <= x1 && tx - x0 < 8; tx++) {
    for (let ty = y0; ty <= y1 && ty - y0 < 8; ty++) {
      const wx = ((tx % n) + n) % n;
      const url = `${host}${frame.path}/256/${z}/${wx}/${ty}/2/1_1.png`;
      jobs.push(
        http
          .bytes(url, { ttlMs: 24 * 3600_000, timeoutMs: 10_000 })
          .then((b) => void tiles.set(`${wx}/${ty}`, decodePng(b)))
          .catch(() => undefined),
      );
    }
  }
  await Promise.all(jobs);
  return {
    time: frame.time,
    source: "rainviewer",
    sample(lon, lat) {
      const fx = lon2x(lon, z);
      const fy = lat2y(lat, z);
      const tx = ((Math.floor(fx) % n) + n) % n;
      const ty = Math.floor(fy);
      const tile = tiles.get(`${tx}/${ty}`);
      if (!tile) return undefined;
      return pixel(tile, (fx - Math.floor(fx)) * tile.width, (fy - ty) * tile.height);
    },
  };
}

// ─── IEM NEXRAD composite (US) ────────────────────────────────────────────

export const CONUS: Bbox = { west: -126, south: 23, east: -65, north: 50 };

export function intersectsConus(b: Bbox): boolean {
  return (
    b.east > CONUS.west && b.west < CONUS.east && b.north > CONUS.south && b.south < CONUS.north
  );
}

/**
 * True when the whole viewport sits over NEXRAD coverage, so the US composite can replace
 * RainViewer without blank edges. The margin covers the radars' range past borders/coasts.
 */
export function insideConus(b: Bbox): boolean {
  return (
    b.west >= CONUS.west - 4 &&
    b.east <= CONUS.east + 4 &&
    b.south >= CONUS.south - 3 &&
    b.north <= CONUS.north + 4
  );
}

const IEM = "https://mesonet.agron.iastate.edu";

/** WMS-T wants full seconds (2026-10-08T03:00:00Z); the minute-only form is rejected. */
export const iemTime = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16)}:00Z`;

/**
 * Times of the most recent US composite scans (5-minute cadence, ~3 minutes behind),
 * thinned to one every `stepMin` so `count` frames cover the last couple of hours.
 */
export async function fetchIemFrameTimes(
  http: HttpClient,
  count = 12,
  stepMin = 10,
  now = Date.now(),
): Promise<number[]> {
  const span = (count * stepMin + 30) * 60_000;
  const fmt = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
  const params = new URLSearchParams({
    operation: "list",
    product: "N0Q",
    radar: "USCOMP",
    start: fmt(now - span),
    end: fmt(now),
  });
  const res = await http.json<{ scans?: Array<{ ts: string }> }>(`${IEM}/json/radar.py?${params}`, {
    ttlMs: 2 * 60_000,
    timeoutMs: 10_000,
  });
  const times = (res.scans ?? []).map((s) => Math.floor(Date.parse(s.ts) / 1000));
  return pickFrameTimes(times.filter(Number.isFinite), count, stepMin);
}

/** Walk back from the newest scan keeping one every `stepMin` minutes; oldest first. */
export function pickFrameTimes(times: number[], count: number, stepMin: number): number[] {
  const sorted = [...new Set(times)].sort((a, b) => b - a);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length >= count) break;
    const last = out[out.length - 1];
    if (last === undefined || last - t >= stepMin * 60 - 30) out.push(t);
  }
  return out.reverse();
}

/**
 * IEM WMS renders any bbox at any size, so we request exactly what we'll sample.
 * With `time` it uses the time-enabled service (archived scans, cacheable for a day);
 * without it, the latest composite.
 */
export async function fetchIemRaster(
  http: HttpClient,
  bbox: Bbox,
  width: number,
  height: number,
  time?: number,
): Promise<RadarRaster> {
  const w = Math.max(16, Math.min(1024, Math.round(width)));
  const h = Math.max(16, Math.min(1024, Math.round(height)));
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    LAYERS: time ? "nexrad-n0q-wmst" : "nexrad-n0q-900913",
    WIDTH: String(w),
    HEIGHT: String(h),
    SRS: "EPSG:4326",
    BBOX: [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(3)).join(","),
    VERSION: "1.1.1",
    STYLES: "",
  });
  if (time) params.set("TIME", iemTime(time));
  const cgi = time ? "n0q-t.cgi" : "n0q.cgi";
  const bytes = await http.bytes(`${IEM}/cgi-bin/wms/nexrad/${cgi}?${params}`, {
    ttlMs: time ? 24 * 3600_000 : 4 * 60_000,
    timeoutMs: 15_000,
  });
  const img = decodePng(bytes);
  return {
    time: time ?? Math.floor(Date.now() / 1000),
    source: "iem",
    sample(lon, lat) {
      const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * img.width;
      const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * img.height;
      const c = pixel(img, x, y);
      return c && !isFaintN0q(c) ? c : undefined;
    },
  };
}

/**
 * The N0Q palette starts with steel blues for ~0-12 dBZ: mostly clear-air returns, bugs and
 * ground clutter that RainViewer filters out. Dropping them keeps the two sources comparable;
 * the cyan (~15 dBZ, light rain) and up stays.
 */
export function isFaintN0q([r, g, b]: RGB): boolean {
  return b > g && g < 200 && r < 110;
}

/** Run `fn` over `items` with at most `limit` in flight (be polite to IEM). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Satellite (NASA GIBS, keyless) ───────────────────────────────────────

export interface SatelliteLayer {
  layer: string;
  label: string;
  /** GIBS TIME value; geostationary layers default to their latest image when omitted. */
  time?: string;
}

export interface SatelliteImage {
  /** Credit for the timeline, e.g. "GOES-East GeoColor · NASA GIBS". */
  label: string;
  sample(lon: number, lat: number): RGB | undefined;
}

/**
 * Pick the geostationary satellite that sees the viewport centre best. GIBS serves GeoColor
 * for GOES-East/West but only infrared for Himawari, and has no Meteosat, so Europe/Africa
 * fall back to yesterday's VIIRS true-colour mosaic (a polar orbiter, one pass a day).
 */
export function chooseSatellite(lon: number, now = Date.now()): SatelliteLayer {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (l >= -110 && l < -20) return { layer: "GOES-East_ABI_GeoColor", label: "GOES-East GeoColor" };
  if (l < -110 || l >= 170) return { layer: "GOES-West_ABI_GeoColor", label: "GOES-West GeoColor" };
  if (l >= 75) return { layer: "Himawari_AHI_Band13_Clean_Infrared", label: "Himawari infrared" };
  const day = new Date(now - 24 * 3600_000).toISOString().slice(0, 10);
  return {
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    label: `VIIRS true colour ${day}`,
    time: day,
  };
}

/** One satellite image for a bbox from NASA GIBS WMS (EPSG:4326 renders any bbox and size). */
export async function fetchSatellite(
  http: HttpClient,
  bbox: Bbox,
  width: number,
  height: number,
  layer: SatelliteLayer = chooseSatellite((bbox.west + bbox.east) / 2),
): Promise<SatelliteImage> {
  const w = Math.max(16, Math.min(1600, Math.round(width)));
  const h = Math.max(16, Math.min(1600, Math.round(height)));
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: layer.layer,
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(3)).join(","),
    WIDTH: String(w),
    HEIGHT: String(h),
    FORMAT: "image/png",
    TRANSPARENT: "true",
  });
  if (layer.time) params.set("TIME", layer.time);
  // Geostationary layers update every 10 minutes (and appear in GIBS ~1-2 h late).
  const bytes = await http.bytes(
    `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`,
    { ttlMs: 10 * 60_000, timeoutMs: 30_000, retries: 1 },
  );
  const img = decodePng(bytes);
  return {
    label: `${layer.label} · NASA GIBS`,
    sample(lon, lat) {
      const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * img.width;
      const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * img.height;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return undefined;
      const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
      if ((img.data[i + 3] ?? 0) < 16) return undefined;
      return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
    },
  };
}
