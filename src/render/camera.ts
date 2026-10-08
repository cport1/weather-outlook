import { type Camera, makeProjection } from "./worldmap.ts";

/** Camera math shared by keyboard, mouse and animated transitions. All in terminal cells. */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;
export const MAX_LAT = 80;

export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

export function clampCamera(cam: Camera): Camera {
  return {
    lon: wrapLon(cam.lon),
    lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, cam.lat)),
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom)),
  };
}

/** Lon/lat under a cell (center of the cell), or undefined off the globe. */
export function cellToLonLat(
  cam: Camera,
  cols: number,
  rows: number,
  col: number,
  row: number,
): [number, number] | undefined {
  const proj = makeProjection(cam, cols * 2, rows * 4);
  const ll = proj.invert?.([col * 2 + 1, row * 4 + 2]);
  if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90) return;
  return [ll[0], ll[1]];
}

/**
 * Move the camera so the map follows a drag of (dx, dy) cells: whatever was
 * under the pointer at the start stays under it.
 */
export function panCamera(cam: Camera, cols: number, rows: number, dx: number, dy: number): Camera {
  const proj = makeProjection(cam, cols * 2, rows * 4);
  const ll = proj.invert?.([cols - dx * 2, rows * 2 - dy * 4]);
  if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return cam;
  return clampCamera({ lon: ll[0], lat: ll[1], zoom: cam.zoom });
}

/** Zoom by `factor` keeping the lon/lat under (col,row) fixed on screen. */
export function zoomCameraAt(
  cam: Camera,
  cols: number,
  rows: number,
  col: number,
  row: number,
  factor: number,
): Camera {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));
  if (zoom === cam.zoom) return cam;
  const anchor = cellToLonLat(cam, cols, rows, col, row);
  if (!anchor) return { ...cam, zoom };
  // Center on the anchor at the new zoom, then pan so the anchor sits back under the pointer.
  const centered = clampCamera({ lon: anchor[0], lat: anchor[1], zoom });
  return panCamera(centered, cols, rows, col + 0.5 - cols / 2, row + 0.5 - rows / 2);
}

export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Interpolate cameras: shortest way around in longitude, geometric in zoom. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return {
    lon: wrapLon(a.lon + dLon * t),
    lat: a.lat + (b.lat - a.lat) * t,
    zoom: a.zoom * (b.zoom / a.zoom) ** t,
  };
}

export const sameCamera = (a: Camera, b: Camera) =>
  Math.abs(wrapLon(a.lon - b.lon)) < 1e-6 &&
  Math.abs(a.lat - b.lat) < 1e-6 &&
  Math.abs(a.zoom - b.zoom) < 1e-6;
