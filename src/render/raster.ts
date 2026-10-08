import { geoPath } from "d3-geo";
import type { RGB } from "./color.ts";
import {
  type Camera,
  coastlineGeo,
  type MapTheme,
  makeProjection,
  pointInLand,
  pointInLandFine,
} from "./worldmap.ts";

/**
 * Full-resolution RGBA map rendering for terminals that can show real images
 * (Kitty / Sixel). The expensive part — inverse-projecting every pixel and
 * classifying land/ocean — is done once per camera+size; each radar frame
 * then only samples the overlay field.
 */
export interface MapRaster {
  width: number;
  height: number;
  /** Render one frame with an optional overlay field (e.g. radar) into RGBA. */
  frame(
    field?: (lon: number, lat: number) => RGB | undefined,
    marker?: { lon: number; lat: number; color: RGB },
  ): Uint8Array;
}

export function createMapRaster(
  width: number,
  height: number,
  cam: Camera,
  theme: MapTheme,
): MapRaster {
  const proj = makeProjection(cam, width, height);
  const n = width * height;
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  const valid = new Uint8Array(n);
  const base = new Uint8Array(n * 4);
  const fine = cam.zoom >= 6;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const ll = proj.invert?.([x + 0.5, y + 0.5]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90)
        continue;
      const back = proj(ll);
      if (!back || Math.abs(back[0] - x - 0.5) > 1 || Math.abs(back[1] - y - 0.5) > 1) continue;
      lon[i] = ll[0];
      lat[i] = ll[1];
      valid[i] = 1;
      const c = (fine ? pointInLandFine(ll[0], ll[1]) : pointInLand(ll[0], ll[1]))
        ? theme.land
        : theme.ocean;
      base[i * 4] = c[0];
      base[i * 4 + 1] = c[1];
      base[i * 4 + 2] = c[2];
      base[i * 4 + 3] = 255;
    }
  }

  // Coastlines are drawn into a mask once and stamped on top of every frame.
  const coast = new Uint8Array(n);
  const plot = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && yi >= 0 && xi < width && yi < height) coast[yi * width + xi] = 1;
  };
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  const lineTo = (x: number, y: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py)));
    if (steps > width) {
      px = x;
      py = y;
      return; // antimeridian jump
    }
    for (let k = 0; k <= steps; k++) plot(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps);
    px = x;
    py = y;
  };
  geoPath(proj, {
    beginPath() {},
    moveTo(x: number, y: number) {
      px = sx = x;
      py = sy = y;
    },
    lineTo,
    closePath() {
      lineTo(sx, sy);
    },
    arc() {},
  } as never)(coastlineGeo(fine));

  return {
    width,
    height,
    frame(field, marker) {
      const out = base.slice();
      if (field) {
        for (let i = 0; i < n; i++) {
          if (!valid[i]) continue;
          const c = field(lon[i] ?? 0, lat[i] ?? 0);
          if (!c) continue;
          out[i * 4] = c[0];
          out[i * 4 + 1] = c[1];
          out[i * 4 + 2] = c[2];
        }
      }
      for (let i = 0; i < n; i++) {
        if (!coast[i]) continue;
        out[i * 4] = theme.coast[0];
        out[i * 4 + 1] = theme.coast[1];
        out[i * 4 + 2] = theme.coast[2];
        out[i * 4 + 3] = 255;
      }
      if (marker) {
        const p = proj([marker.lon, marker.lat]);
        if (p) {
          const r = Math.max(3, Math.round(width / 160));
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const d = Math.hypot(dx, dy);
              if (d > r || (d < r - 1.5 && d > 1.2)) continue; // ring + center dot
              const x = Math.round(p[0] + dx);
              const y = Math.round(p[1] + dy);
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              const i = (y * width + x) * 4;
              out[i] = marker.color[0];
              out[i + 1] = marker.color[1];
              out[i + 2] = marker.color[2];
              out[i + 3] = 255;
            }
          }
        }
      }
      return out;
    },
  };
}
