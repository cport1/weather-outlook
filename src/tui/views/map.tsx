import type { Cell } from "../../render/canvas.ts";
import { stormCategoryColor } from "../../render/color.ts";
import {
  buildHazardLayers,
  quakeColor,
  quakePulse,
  stormLabel,
  stormSprite,
} from "../../render/hazard-layers.ts";
import { cellProjector, renderWorldMap } from "../../render/worldmap.ts";
import type { DrawApi } from "../cell-canvas.ts";
import type { AppState } from "../store.ts";
import { T, theme } from "../theme.ts";

const LEGEND: Array<[keyof AppState["layers"], string, string, string]> = [
  ["storms", "S", "@", "storms"],
  ["fires", "F", "▲", "fires"],
  ["hotspots", "H", "·", "hotspots"],
  ["quakes", "Q", "●", "quakes"],
  ["alerts", "A", "▢", "alerts"],
];

export function MapView(props: { state: AppState }) {
  let baseKey = "";
  let base: Cell[][] = [];
  let clock = 0;

  const draw = (api: DrawApi, w: number, h: number, dt: number) => {
    const { camera: cam, location: loc, hazards, layers } = props.state;
    const alerts = props.state.report?.alerts ?? [];
    clock += dt;
    const key = [
      w,
      h,
      cam.lon.toFixed(2),
      cam.lat.toFixed(2),
      cam.zoom,
      hazards?.generatedAt,
      alerts.length,
      Object.values(layers).join(""),
    ].join(":");
    if (key !== baseKey) {
      base = renderWorldMap(w, h, cam, buildHazardLayers(hazards, alerts, layers, cam.zoom));
      baseKey = key;
    }
    api.grid(base);

    // Animated sprites on top of the cached base.
    const project = cellProjector(cam, w, h);
    if (hazards && layers.quakes) {
      for (const q of hazards.quakes) {
        const g = props.state.motion ? quakePulse(q, clock) : undefined;
        const at = g && project(q.lon, q.lat);
        if (at && g) api.cell(at[0], at[1], g, quakeColor(q));
      }
    }
    if (hazards && layers.storms) {
      for (const s of hazards.storms) {
        const at = project(s.lon, s.lat);
        if (!at) continue;
        const color = stormCategoryColor(s.category);
        api.cell(at[0], at[1], props.state.motion ? stormSprite(s, clock) : "@", color);
        api.text(at[0] + 2, at[1], stormLabel(s), color);
      }
    }
    const here = project(loc.lon, loc.lat);
    if (here) {
      const blink = !props.state.motion || Math.floor(clock / 500) % 2 === 0;
      api.cell(here[0], here[1], blink ? "◉" : "○", theme.accent);
      api.text(here[0] + 2, here[1], loc.name, theme.accent);
    }

    // Status + legend line.
    let x = 1;
    const put = (s: string, fg = theme.dim) => {
      api.text(x, h - 1, s, fg, theme.panel);
      x += [...s].length;
    };
    put(` ${cam.lat.toFixed(1)}°, ${cam.lon.toFixed(1)}° ×${cam.zoom} `);
    for (const [k, shortcut, glyph, label] of LEGEND) {
      const on = layers[k];
      put(" ");
      put(shortcut, on ? theme.accent : theme.faint);
      put(` ${glyph} ${label} `, on ? theme.text : theme.faint);
    }
    if (hazards) {
      put(
        ` │ ${hazards.storms.length} storms · ${hazards.fires.length} fires · ${hazards.quakes.length} quakes `,
      );
    }
  };

  return (
    <box flexGrow={1} border borderStyle="rounded" borderColor={T.border} title=" world ">
      <cell_canvas live={props.state.motion} flexGrow={1} height="100%" draw={draw} />
    </box>
  );
}
