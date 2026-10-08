import type {
  Alert,
  GeoEvent,
  Hazards,
  Quake,
  RiskArea,
  Severity,
  Storm,
} from "../domain/types.ts";
import { type Bbox, pointInRing, ringBbox } from "../util/geo.ts";
import { hex, lerp, type RGB, stormCategoryColor } from "./color.ts";
import type { MapLayers, MapMarker, MapPath, PixelShader } from "./worldmap.ts";

export interface LayerToggles {
  storms: boolean;
  fires: boolean;
  hotspots: boolean;
  quakes: boolean;
  alerts: boolean;
  /** Volcanoes, floods, droughts… (GeoEvent markers). */
  events: boolean;
  /** SPC/WPC risk outlooks (filled polygons). */
  outlooks: boolean;
}

export const DEFAULT_TOGGLES: LayerToggles = {
  storms: true,
  fires: true,
  hotspots: true,
  quakes: true,
  alerts: true,
  events: true,
  outlooks: true,
};

/** SPC categorical palette (matches the official outlook maps). */
export const RISK_COLOR: Record<string, RGB> = {
  TSTM: hex("#c1e9c1"),
  MRGL: hex("#66a366"),
  SLGT: hex("#ffe066"),
  ENH: hex("#ffa366"),
  MDT: hex("#e06666"),
  HIGH: hex("#ee99ee"),
};

export function riskColor(a: Pick<RiskArea, "label" | "fill" | "product">): RGB {
  if (a.product === "categorical" && RISK_COLOR[a.label]) return RISK_COLOR[a.label] as RGB;
  return a.fill ? hex(a.fill) : hex("#b0bec5");
}

const EVENT_GLYPH: Record<GeoEvent["kind"], string> = {
  volcano: "∆",
  flood: "≈",
  drought: "◇",
  landslide: "⌂",
  dust: "░",
  snow: "*",
  heat: "∴",
  other: "◆",
};
const EVENT_COLOR: Record<GeoEvent["kind"], RGB> = {
  volcano: hex("#ff7043"),
  flood: hex("#4fc3f7"),
  drought: hex("#d7a86e"),
  landslide: hex("#a1887f"),
  dust: hex("#bcaaa4"),
  snow: hex("#e1f5fe"),
  heat: hex("#ff8a65"),
  other: hex("#b0bec5"),
};
const LEVEL_COLOR: Record<NonNullable<GeoEvent["level"]>, RGB> = {
  red: hex("#ff1744"),
  orange: hex("#ff9100"),
  yellow: hex("#ffd600"),
  green: hex("#66bb6a"),
};

export function eventGlyph(e: GeoEvent): string {
  return EVENT_GLYPH[e.kind];
}

export function eventColor(e: GeoEvent): RGB {
  // Green GDACS levels mean "low impact", so keep the kind color for those.
  return e.level && e.level !== "green" ? LEVEL_COLOR[e.level] : EVENT_COLOR[e.kind];
}

/**
 * Pixel shader that tints whatever is underneath (land/ocean or a weather
 * field) with the Day 1 SPC categorical outlook, so it composes with the
 * field layers and runs before night shading. Bboxes keep the per-pixel test cheap.
 */
export function outlookShader(areas: RiskArea[]): PixelShader | undefined {
  const day1 = areas
    .filter((a) => a.product === "categorical" && a.day === 1)
    .sort((a, b) => b.level - a.level)
    .flatMap((a) => a.rings.map((r) => ({ ring: r, box: ringBbox(r), color: riskColor(a) })));
  if (!day1.length) return undefined;
  const inBox = (b: Bbox, lon: number, lat: number) =>
    lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
  return (lon, lat, c) => {
    const hit = day1.find((d) => inBox(d.box, lon, lat) && pointInRing(lon, lat, d.ring));
    return hit ? lerp(c, hit.color, 0.55) : c;
  };
}

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

export interface HotspotCluster {
  lon: number;
  lat: number;
  count: number;
  /** Summed fire radiative power (MW). */
  frp: number;
}

/**
 * Bin satellite hotspots so the world view shows fire clusters instead of a
 * carpet of single detections: 2° bins below zoom 2, 1° below zoom 4, and
 * every detection once zoomed in. Lone detections are dropped when binned.
 */
export function hotspotClusters(hotspots: Hazards["hotspots"], zoom: number): HotspotCluster[] {
  if (zoom >= 4) {
    return hotspots.map((h) => ({ lon: h.lon, lat: h.lat, count: 1, frp: h.frp ?? 0 }));
  }
  const deg = zoom >= 2 ? 1 : 2;
  const minCount = zoom >= 2 ? 2 : 3;
  const bins = new Map<string, HotspotCluster>();
  for (const h of hotspots) {
    const key = `${Math.floor(h.lon / deg)},${Math.floor(h.lat / deg)}`;
    const b = bins.get(key);
    if (b) {
      // Running mean keeps the marker on the cluster, not the bin corner.
      b.lon += (h.lon - b.lon) / (b.count + 1);
      b.lat += (h.lat - b.lat) / (b.count + 1);
      b.count++;
      b.frp += h.frp ?? 0;
    } else bins.set(key, { lon: h.lon, lat: h.lat, count: 1, frp: h.frp ?? 0 });
  }
  return [...bins.values()].filter((b) => b.count >= minCount);
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
  const shaders: PixelShader[] = [];

  if (toggles.outlooks && hazards?.outlooks?.length) {
    const risk = outlookShader(hazards.outlooks);
    if (risk) shaders.push(risk);
    // Excessive rainfall and fire weather as dotted outlines so they don't fight the fill.
    for (const a of hazards.outlooks) {
      if (a.day !== 1 || (a.product !== "rainfall" && a.product !== "fire")) continue;
      const color = a.product === "fire" ? hex("#ff8a65") : riskColor(a);
      for (const ring of a.rings) paths.push({ coords: ring, color, dotted: true });
    }
  }
  if (toggles.alerts) {
    // Local (report) alerts first, then regional map alerts not already drawn.
    const seen = new Set<string>();
    for (const a of [...alerts, ...(hazards?.alerts ?? [])]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      for (const ring of a.polygon ?? [])
        paths.push({ coords: ring, color: SEVERITY_COLOR[a.severity] });
    }
  }
  if (!hazards) return { markers, paths, shaders };

  if (toggles.fires && zoom >= 4) {
    for (const p of hazards.perimeters ?? []) {
      for (const ring of p.rings) paths.push({ coords: ring, color: FIRE });
    }
  }
  if (toggles.events) {
    for (const e of hazards.events ?? []) {
      markers.push({ lon: e.lon, lat: e.lat, glyph: eventGlyph(e), color: eventColor(e) });
    }
  }

  if (toggles.hotspots) {
    for (const c of hotspotClusters(hazards.hotspots, zoom)) {
      markers.push({
        lon: c.lon,
        lat: c.lat,
        glyph: c.count >= 40 ? "●" : c.count >= 8 ? "•" : "·",
        color: lerp(HOTSPOT, FIRE, Math.min(1, c.frp / 400)),
      });
    }
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
  return { markers, paths, shaders };
}

// Quarter arcs read as a spinning circulation and can't be mistaken for digits.
const SPIRAL = ["◜", "◝", "◞", "◟"];
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
