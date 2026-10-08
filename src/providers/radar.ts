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

/** IEM WMS renders any bbox at any size, so we request exactly what we'll sample. */
export async function fetchIemRaster(
  http: HttpClient,
  bbox: Bbox,
  width: number,
  height: number,
): Promise<RadarRaster> {
  const w = Math.max(16, Math.min(1024, Math.round(width)));
  const h = Math.max(16, Math.min(1024, Math.round(height)));
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    LAYERS: "nexrad-n0q-900913",
    WIDTH: String(w),
    HEIGHT: String(h),
    SRS: "EPSG:4326",
    BBOX: [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(3)).join(","),
    VERSION: "1.1.1",
    STYLES: "",
  });
  const bytes = await http.bytes(
    `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?${params}`,
    { ttlMs: 4 * 60_000, timeoutMs: 15_000 },
  );
  const img = decodePng(bytes);
  return {
    time: Math.floor(Date.now() / 1000),
    source: "iem",
    sample(lon, lat) {
      const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * img.width;
      const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * img.height;
      return pixel(img, x, y);
    },
  };
}
