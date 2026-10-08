import type { HttpClient } from "../util/http.ts";

/**
 * Current conditions on a coarse global grid from Open-Meteo, fetched in a
 * single multi-location request (comma-separated latitude/longitude lists).
 *
 * Limits (verified against the live API): at most 1000 locations per request
 * ("Only up to 1000 locations can be requested at once"), and nginx rejects
 * URLs much past ~8 KB with 414. Each location also counts as one call toward
 * the free tier's 600/minute and 10k/day budgets, so the grid is 15° × 10°
 * (24 × 17 = 408 points) and cached for an hour: one request serves all four
 * field layers.
 */
export const GRID_LON_STEP = 15;
export const GRID_LAT_STEP = 10;
export const GRID_LAT_MIN = -80;
export const GRID_LAT_MAX = 80;

export type FieldKind = "temp" | "wind" | "precip" | "clouds";

export interface GlobalGrid {
  fetchedAt: string;
  /** Observation time (UTC, ISO) of the first point. */
  time?: string;
  nx: number;
  ny: number;
  /** Row-major (lat ascending from GRID_LAT_MIN, lon ascending from -180). NaN = missing. */
  values: Record<FieldKind, Float32Array>;
  /** Wind direction (meteorological degrees, "from"). */
  windDir: Float32Array;
}

export function gridPoints(): Array<[lat: number, lon: number]> {
  const pts: Array<[number, number]> = [];
  for (let lat = GRID_LAT_MIN; lat <= GRID_LAT_MAX; lat += GRID_LAT_STEP)
    for (let lon = -180; lon < 180; lon += GRID_LON_STEP) pts.push([lat, lon]);
  return pts;
}

export function gridUrl(): string {
  const pts = gridPoints();
  const q = new URLSearchParams({
    latitude: pts.map((p) => p[0]).join(","),
    longitude: pts.map((p) => p[1]).join(","),
    current: "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover",
    wind_speed_unit: "kmh",
    timezone: "GMT",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString().replace(/%2C/g, ",")}`;
}

interface PointResponse {
  current?: {
    time?: string;
    temperature_2m?: number | null;
    wind_speed_10m?: number | null;
    wind_direction_10m?: number | null;
    precipitation?: number | null;
    cloud_cover?: number | null;
  };
}

export function parseGrid(raw: PointResponse[] | PointResponse, now = new Date()): GlobalGrid {
  const list = Array.isArray(raw) ? raw : [raw];
  const nx = 360 / GRID_LON_STEP;
  const ny = (GRID_LAT_MAX - GRID_LAT_MIN) / GRID_LAT_STEP + 1;
  const make = () => new Float32Array(nx * ny).fill(Number.NaN);
  const values = { temp: make(), wind: make(), precip: make(), clouds: make() };
  const windDir = make();
  const num = (v: number | null | undefined) => (typeof v === "number" ? v : Number.NaN);
  list.forEach((p, i) => {
    if (i >= nx * ny) return;
    const c = p.current;
    values.temp[i] = num(c?.temperature_2m);
    values.wind[i] = num(c?.wind_speed_10m);
    values.precip[i] = num(c?.precipitation);
    values.clouds[i] = num(c?.cloud_cover);
    windDir[i] = num(c?.wind_direction_10m);
  });
  return { fetchedAt: now.toISOString(), time: list[0]?.current?.time, nx, ny, values, windDir };
}

export async function fetchGlobalGrid(http: HttpClient): Promise<GlobalGrid> {
  const raw = await http.json<PointResponse[]>(gridUrl(), {
    ttlMs: 60 * 60_000,
    timeoutMs: 20_000,
  });
  return parseGrid(raw);
}

/** Bilinear sample with longitude wrap; NaN neighbours are ignored. */
export function sampleGrid(g: GlobalGrid, data: Float32Array, lon: number, lat: number): number {
  const fx = (((((lon + 180) % 360) + 360) % 360) / GRID_LON_STEP) % g.nx;
  const fy = Math.max(0, Math.min(g.ny - 1, (lat - GRID_LAT_MIN) / GRID_LAT_STEP));
  const x0 = Math.floor(fx);
  const y0 = Math.min(g.ny - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  let sum = 0;
  let wsum = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ] as const) {
    const v = data[(y0 + dy) * g.nx + ((x0 + dx) % g.nx)];
    if (v === undefined || Number.isNaN(v) || w === 0) continue;
    sum += v * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : Number.NaN;
}
