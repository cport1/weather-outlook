import type { Capabilities } from "../capabilities.ts";
import type { Hazards } from "../domain/types.ts";
import { cellsToAnsi, paint } from "./ansi.ts";
import { hex, stormCategoryColor } from "./color.ts";
import {
  buildHazardLayers,
  DEFAULT_TOGGLES,
  eventColor,
  eventGlyph,
  quakeColor,
  riskColor,
  SEVERITY_COLOR,
  stormLabel,
} from "./hazard-layers.ts";
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
    ` ${p(`Largest active wildfires, US + Canada (${h.fires.length} total, ${h.hotspots.length.toLocaleString()} satellite hotspots worldwide)`, ACCENT)}`,
  );
  for (const f of h.fires.filter((x) => (x.containment ?? 0) < 100).slice(0, 5)) {
    out.push(
      `   ${p("▲", FIRE)} ${p((f.provider === "cwfif" ? (f.name ?? "") : titleCase(f.name ?? "Unnamed")).padEnd(24))}${p(`${Math.round(f.acres ?? 0).toLocaleString()} ac`.padStart(12), hex("#ffb74d"))}  ${p(f.containment === undefined && f.status ? f.status : `${Math.round(f.containment ?? 0)}% contained`, DIM)}`,
    );
  }
  out.push("", ` ${p(`Strongest earthquakes, last 24h (${h.quakes.length})`, ACCENT)}`);
  for (const q of h.quakes.slice(0, 5)) {
    out.push(
      `   ${p(`M${q.magnitude.toFixed(1)}`, quakeColor(q))} ${p(q.place)}${q.tsunami ? p("  ≋ tsunami", hex("#ff5252")) : ""}`,
    );
  }
  if (h.nearbyQuakes?.length) {
    out.push(
      `   ${p(`${h.nearbyQuakes.length} smaller quakes within 300 km of you this week`, DIM)}`,
    );
  }
  const events = h.events ?? [];
  if (events.length) {
    out.push("", ` ${p(`Volcanoes, floods & other events (${events.length})`, ACCENT)}`);
    for (const e of events.slice(0, 6)) {
      out.push(
        `   ${p(eventGlyph(e), eventColor(e))} ${p(e.title.slice(0, 36).padEnd(37))}${p(e.detail ?? e.level ?? "", DIM)}`,
      );
    }
  }
  const alerts = h.alerts ?? [];
  const worst = alerts.filter((a) => a.severity === "extreme" || a.severity === "severe");
  if (alerts.length) {
    const byProvider = [...new Set(alerts.map((a) => a.provider))].join(", ");
    out.push(
      "",
      ` ${p(`Mapped weather alerts (${alerts.length}, ${byProvider})`, ACCENT)}  ${p(`${worst.length} severe or extreme`, worst.length ? SEVERITY_COLOR.severe : DIM)}`,
    );
    const counts = new Map<string, number>();
    for (const a of worst) counts.set(a.event, (counts.get(a.event) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) out.push(`   ${p(top.map(([e, n]) => `${e} ×${n}`).join(" · "), DIM)}`);
  }
  const cat = (h.outlooks ?? [])
    .filter((o) => o.product === "categorical" && o.day === 1)
    .sort((a, b) => b.level - a.level)[0];
  const rain = (h.outlooks ?? [])
    .filter((o) => o.product === "rainfall" && o.day === 1)
    .sort((a, b) => b.level - a.level)[0];
  if (cat || rain) {
    const parts = [
      cat ? `${p(cat.label, riskColor(cat))} ${p(cat.name, DIM)}` : "",
      rain ? `${p("  excessive rain ", DIM)}${p(rain.label, riskColor(rain))}` : "",
    ];
    out.push("", ` ${p("US outlook today (SPC/WPC)", ACCENT)}  ${parts.join("")}`);
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
