import type { Alert, Hazards } from "../domain/types.ts";
import { hex, type RGB, stormCategoryColor } from "./color.ts";
import { type LayerToggles, quakeColor, SEVERITY_COLOR, stormLabel } from "./hazard-layers.ts";

/** A hazard the map can select and describe (inspect mode). */
export interface Inspectable {
  /** Stable across refreshes, e.g. "storm:al092026". */
  key: string;
  kind: "storm" | "fire" | "quake" | "alert";
  lon: number;
  lat: number;
  title: string;
  /** Short place name used when jumping to this hazard's forecast. */
  place: string;
  lines: string[];
  color: RGB;
}

const ago = (iso: string | undefined, now: number): string | undefined => {
  if (!iso) return undefined;
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins)) return undefined;
  if (mins < 60) return `${Math.max(0, mins)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

/** Centroid of the largest ring of an alert polygon. */
function alertCenter(a: Alert): [number, number] | undefined {
  const ring = [...(a.polygon ?? [])].sort((p, q) => q.length - p.length)[0];
  if (!ring?.length) return undefined;
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

/**
 * Everything selectable on the map, most important first: storms by
 * category, alerts by severity, quakes by magnitude, then the largest fires.
 */
export function inspectables(
  hazards: Hazards | undefined,
  alerts: Alert[],
  toggles: LayerToggles,
  now = Date.now(),
): Inspectable[] {
  const out: Inspectable[] = [];
  if (hazards && toggles.storms) {
    for (const s of [...hazards.storms].sort((a, b) => b.category - a.category)) {
      out.push({
        key: `storm:${s.id}`,
        kind: "storm",
        lon: s.lon,
        lat: s.lat,
        title: `${s.classification} ${s.name}`,
        place: s.name,
        color: stormCategoryColor(s.category),
        lines: [
          `${stormLabel(s)}${s.basin ? ` · ${s.basin}` : ""}`,
          `wind ${s.windKt ?? "--"} kt · ${s.pressureMb ?? "--"} mb`,
          s.movement ? `moving ${s.movement}` : "",
          ago(s.updated, now) ? `updated ${ago(s.updated, now)}` : "",
        ].filter(Boolean),
      });
    }
  }
  if (toggles.alerts) {
    const rank = { extreme: 0, severe: 1, moderate: 2, minor: 3, unknown: 4 };
    for (const a of [...alerts].sort((p, q) => rank[p.severity] - rank[q.severity])) {
      const c = alertCenter(a);
      if (!c) continue;
      out.push({
        key: `alert:${a.id}`,
        kind: "alert",
        lon: c[0],
        lat: c[1],
        title: a.event,
        place: a.areas?.split(/[;,]/)[0]?.trim() || a.event,
        color: SEVERITY_COLOR[a.severity],
        lines: [
          a.headline ?? "",
          `${a.severity}${a.urgency ? ` · ${a.urgency.toLowerCase()}` : ""}`,
          a.expires ? `until ${new Date(a.expires).toUTCString().slice(5, 22)} UTC` : "",
        ].filter(Boolean),
      });
    }
  }
  if (hazards && toggles.quakes) {
    for (const q of [...hazards.quakes].sort((a, b) => b.magnitude - a.magnitude)) {
      out.push({
        key: `quake:${q.id}`,
        kind: "quake",
        lon: q.lon,
        lat: q.lat,
        title: `M${q.magnitude.toFixed(1)} earthquake`,
        place: q.place.replace(/^\d+\s*km\s+\w+\s+of\s+/i, ""),
        color: quakeColor(q),
        lines: [
          q.place,
          `depth ${Math.round(q.depthKm)} km${q.tsunami ? " · tsunami flag" : ""}`,
          ago(q.time, now) ?? "",
        ].filter(Boolean),
      });
    }
  }
  if (hazards && toggles.fires) {
    const fires = hazards.fires
      .filter((f) => (f.acres ?? 0) >= 1_000)
      .sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
    for (const f of fires) {
      const name = titleCase(f.name ?? "Unnamed fire");
      out.push({
        key: `fire:${f.id}`,
        kind: "fire",
        lon: f.lon,
        lat: f.lat,
        title: `${name} Fire`.replace(/ Fire Fire$/, " Fire"),
        place: name,
        color: hex("#ff7043"),
        lines: [
          `${Math.round(f.acres ?? 0).toLocaleString()} acres`,
          f.containment !== undefined ? `${Math.round(f.containment)}% contained` : "",
          ago(f.discovered, now) ? `discovered ${ago(f.discovered, now)}` : "",
        ].filter(Boolean),
      });
    }
  }
  return out;
}

/** The selectable hazard nearest a cell, within `radius` cells (x distance counts half). */
export function nearestAt<T extends { at: readonly [number, number] }>(
  items: T[],
  col: number,
  row: number,
  radius = 2,
): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot((it.at[0] - col) / 2, it.at[1] - row);
    if (d <= radius && d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}
