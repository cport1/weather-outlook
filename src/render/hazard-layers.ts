import type { Alert, Hazards, Quake, Severity, Storm } from "../domain/types.ts";
import { hex, lerp, type RGB, stormCategoryColor } from "./color.ts";
import type { MapLayers, MapMarker, MapPath } from "./worldmap.ts";

export interface LayerToggles {
  storms: boolean;
  fires: boolean;
  hotspots: boolean;
  quakes: boolean;
  alerts: boolean;
}

export const DEFAULT_TOGGLES: LayerToggles = {
  storms: true,
  fires: true,
  hotspots: true,
  quakes: true,
  alerts: true,
};

export const SEVERITY_COLOR: Record<Severity, RGB> = {
  extreme: hex("#ff1744"),
  severe: hex("#ff6d00"),
  moderate: hex("#ffd600"),
  minor: hex("#64b5f6"),
  unknown: hex("#b0bec5"),
};

const FIRE = hex("#ff7043");
const FIRE_HOT = hex("#ffeb3b");
const HOTSPOT = hex("#bf360c");
const CONE = hex("#90a4ae");

export function quakeColor(q: Quake): RGB {
  // Shallow quakes are more damaging → hotter colors.
  if (q.depthKm < 35) return hex("#ff5252");
  if (q.depthKm < 70) return hex("#ffab40");
  if (q.depthKm < 300) return hex("#ffd740");
  return hex("#69f0ae");
}

export function quakeGlyph(mag: number): string {
  if (mag >= 6) return "◉";
  if (mag >= 5) return "●";
  if (mag >= 4) return "•";
  return "·";
}

export function stormLabel(s: Storm): string {
  const cat = s.category >= 1 ? `C${s.category}` : s.category === 0 ? "TS" : "TD";
  return `${s.name} ${cat}`;
}

/** Static (non-animated) map layers. Animated sprites are drawn by the host on top. */
export function buildHazardLayers(
  hazards: Hazards | undefined,
  alerts: Alert[],
  toggles: LayerToggles,
  zoom: number,
): MapLayers {
  const markers: MapMarker[] = [];
  const paths: MapPath[] = [];

  if (toggles.alerts) {
    for (const a of alerts) {
      for (const ring of a.polygon ?? [])
        paths.push({ coords: ring, color: SEVERITY_COLOR[a.severity] });
    }
  }
  if (!hazards) return { markers, paths };

  if (toggles.hotspots) {
    // Satellite hotspots: tiny dim dots, thinned at world zoom so they read as a heat haze.
    const stride = zoom >= 4 ? 1 : 3;
    hazards.hotspots.forEach((h, i) => {
      if (i % stride !== 0) return;
      markers.push({
        lon: h.lon,
        lat: h.lat,
        glyph: "·",
        color: lerp(HOTSPOT, FIRE, Math.min(1, (h.frp ?? 0) / 100)),
      });
    });
  }
  if (toggles.fires) {
    const minAcres = zoom >= 4 ? 100 : zoom >= 2 ? 1_000 : 10_000;
    for (const f of hazards.fires) {
      if ((f.acres ?? 0) < minAcres) continue;
      const active = (f.containment ?? 0) < 100;
      markers.push({
        lon: f.lon,
        lat: f.lat,
        glyph: "▲",
        color: active
          ? lerp(FIRE, FIRE_HOT, Math.min(1, (f.acres ?? 0) / 200_000))
          : hex("#6d4c41"),
      });
    }
  }
  if (toggles.quakes) {
    for (const q of hazards.quakes) {
      markers.push({
        lon: q.lon,
        lat: q.lat,
        glyph: quakeGlyph(q.magnitude),
        color: quakeColor(q),
      });
    }
  }
  if (toggles.storms) {
    for (const s of hazards.storms) {
      for (const ring of s.cone ?? []) paths.push({ coords: ring, color: CONE, dotted: true });
      if (s.track.length > 1) {
        paths.push({
          coords: s.track.map((p) => [p.lon, p.lat] as [number, number]),
          color: stormCategoryColor(s.category),
          colors: s.track.map((p) => stormCategoryColor(p.category ?? s.category)),
        });
      }
    }
  }
  return { markers, paths };
}

const SPIRAL = ["@", "@", "6", "9"];
const SPIN = ["◐", "◓", "◑", "◒"];

/** Animated sprite glyph for a storm at time t (ms). Spins faster for stronger storms. */
export function stormSprite(s: Storm, t: number): string {
  const speed = 140 - Math.max(0, s.category) * 15;
  const frame = Math.floor(t / speed) % 4;
  // Southern-hemisphere storms rotate clockwise.
  const f = s.lat < 0 ? 3 - frame : frame;
  return (s.category >= 1 ? SPIN : SPIRAL)[f] ?? "@";
}

/** Recent quakes (<6h) pulse; returns ring glyph or undefined if not pulsing this frame. */
export function quakePulse(q: Quake, t: number, now = Date.now()): string | undefined {
  const age = now - new Date(q.time).getTime();
  if (age > 6 * 3600_000 || q.magnitude < 4) return undefined;
  const phase = Math.floor(t / 250) % 4;
  return ["◉", "◎", "○", "◌"][phase];
}
