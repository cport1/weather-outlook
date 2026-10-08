import type { Capabilities } from "../capabilities.ts";
import type { Hazards } from "../domain/types.ts";
import { cellsToAnsi, paint } from "./ansi.ts";
import { hex, stormCategoryColor } from "./color.ts";
import { buildHazardLayers, DEFAULT_TOGGLES, quakeColor, stormLabel } from "./hazard-layers.ts";
import { placeMarkers } from "./places.ts";
import { renderWorldMap } from "./worldmap.ts";

const DIM = hex("#7a8794");
const TEXT = hex("#e6edf3");
const ACCENT = hex("#7dd3fc");
const FIRE = hex("#ff7043");
const CITY = hex("#8a9aa8");

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\d+\s+/, "")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Static world hazard map + top lists for `weather-outlook hazards`. */
export function renderHazardsOneShot(h: Hazards, caps: Capabilities): string {
  const lvl = caps.color;
  const p = (s: string, c = TEXT) => paint(s, c, lvl);
  const cols = Math.max(60, Math.min(caps.columns - 2, 160));
  // Natural Earth is ~1.95:1 and braille pixels (2×4 per cell) are about square.
  const rows = Math.round(cols / 3.9);
  const layers = buildHazardLayers(h, [], DEFAULT_TOGGLES, 1);
  for (const s of h.storms) {
    layers.markers?.push({
      lon: s.lon,
      lat: s.lat,
      glyph: "@",
      color: stormCategoryColor(s.category),
      label: stormLabel(s),
    });
  }
  // A handful of world cities for orientation; they yield to hazard labels and
  // vanish entirely (dot included) when there is no room for their name.
  layers.markers?.push(...placeMarkers(1, CITY, { maxRank: 0, limit: cols >= 120 ? 14 : 8 }));
  const map = cellsToAnsi(
    renderWorldMap(cols, rows, { lon: 0, lat: 0, zoom: 1 }, layers, undefined, {
      fill: lvl > 0,
      // State lines only once the US is wide enough for them to read as lines, not noise.
      admin: lvl > 0 && cols >= 140,
    }),
    lvl,
  );
  const out = [
    "",
    ` ${p("◆", ACCENT)} ${p("Planet status", TEXT)} ${p(new Date(h.generatedAt).toUTCString(), DIM)}`,
    "",
    ...map.map((l) => ` ${l}`),
    "",
  ];

  out.push(` ${p(`Tropical cyclones (${h.storms.length})`, ACCENT)}`);
  if (!h.storms.length) out.push(`   ${p("none active", DIM)}`);
  for (const s of h.storms) {
    out.push(
      `   ${p("@", stormCategoryColor(s.category))} ${p(s.name.padEnd(12))}${p(s.classification.padEnd(22), stormCategoryColor(s.category))}${p(
        `${s.windKt ?? "--"} kt  ${s.pressureMb ?? "--"} mb  ${s.movement ?? ""}`,
        DIM,
      )}`,
    );
  }
  out.push(
    "",
    ` ${p(`Largest active US wildfires (${h.fires.length} total, ${h.hotspots.length.toLocaleString()} satellite hotspots worldwide)`, ACCENT)}`,
  );
  for (const f of h.fires.filter((x) => (x.containment ?? 0) < 100).slice(0, 5)) {
    out.push(
      `   ${p("▲", FIRE)} ${p(titleCase(f.name ?? "Unnamed").padEnd(24))}${p(`${Math.round(f.acres ?? 0).toLocaleString()} ac`.padStart(12), hex("#ffb74d"))}  ${p(`${Math.round(f.containment ?? 0)}% contained`, DIM)}`,
    );
  }
  out.push("", ` ${p(`Strongest earthquakes, last 24h (${h.quakes.length})`, ACCENT)}`);
  for (const q of h.quakes.slice(0, 5)) {
    out.push(
      `   ${p(`M${q.magnitude.toFixed(1)}`, quakeColor(q))} ${p(q.place)}${q.tsunami ? p("  ≋ tsunami", hex("#ff5252")) : ""}`,
    );
  }
  if (h.space) {
    out.push(
      "",
      ` ${p("Space weather", ACCENT)}  ${p(`Kp ${h.space.kp ?? "--"}`, TEXT)}  ${p(`G${h.space.scales?.G ?? 0} S${h.space.scales?.S ?? 0} R${h.space.scales?.R ?? 0}`, DIM)}  ${p(`solar wind ${h.space.solarWindSpeed ?? "--"} km/s`, DIM)}`,
    );
  }
  for (const e of h.errors) out.push(p(`  ! ${e.provider}: ${e.message}`, DIM));
  out.push("");
  return out.join("\n");
}
