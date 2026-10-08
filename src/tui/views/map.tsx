import type { KeyEvent, MouseEvent, Renderable } from "@opentui/core";
import { createEffect, on, onCleanup } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { Location } from "../../domain/types.ts";
import { type AuroraGrid, fetchAurora } from "../../providers/aurora.ts";
import { type FieldKind, fetchGlobalGrid, type GlobalGrid } from "../../providers/global-grid.ts";
import { resolveLocation } from "../../providers/location.ts";
import {
  clampCamera,
  easeOutCubic,
  lerpCamera,
  panCamera,
  sameCamera,
  wrapLon,
  zoomCameraAt,
} from "../../render/camera.ts";
import type { Cell } from "../../render/canvas.ts";
import { hex, type RGB, stormCategoryColor } from "../../render/color.ts";
import { nightShader } from "../../render/daynight.ts";
import { auroraShader, FIELD_LABEL, fieldLayer, fieldLegend } from "../../render/fields.ts";
import { fireFlicker } from "../../render/flicker.ts";
import {
  buildHazardLayers,
  quakeColor,
  quakePulse,
  stormLabel,
  stormSprite,
} from "../../render/hazard-layers.ts";
import { type Inspectable, inspectables, nearestAt } from "../../render/inspect.ts";
import { type LabelRequest, type PlacedLabel, placeLabels } from "../../render/labels.ts";
import { placeMarkers } from "../../render/places.ts";
import {
  type Camera,
  cellProjector,
  type PixelShader,
  renderWorldMap,
} from "../../render/worldmap.ts";
import type { HttpClient } from "../../util/http.ts";
import type { DrawApi } from "../cell-canvas.ts";
import type { AppState, MapOverlays } from "../store.ts";
import { T, theme } from "../theme.ts";

const LEGEND: Array<[keyof AppState["layers"], string, string, string]> = [
  ["storms", "S", "@", "storms"],
  ["fires", "F", "▲", "fires"],
  ["hotspots", "H", "·", "hotspots"],
  ["quakes", "Q", "●", "quakes"],
  ["alerts", "A", "▢", "alerts"],
  ["events", "E", "∆", "events"],
  ["outlooks", "R", "▓", "risk"],
];
const FIELD_KEYS: Record<string, FieldKind> = { t: "temp", w: "wind", p: "precip", c: "clouds" };
const OVERLAY_KEYS: Record<string, keyof MapOverlays> = { n: "night", o: "aurora", l: "places" };
const LAYER_KEYS = {
  s: "storms",
  f: "fires",
  h: "hotspots",
  q: "quakes",
  a: "alerts",
  e: "events",
  r: "outlooks",
} as const;

const CITY = hex("#9aa8b5");
const PIN = hex("#f0abfc");
const TWEEN_MS = 200;
const FLY_MS = 650;

export interface MapControls {
  /** Handle a key while the map is showing; returns true if consumed. */
  key(k: KeyEvent): boolean;
}

interface Props {
  state: AppState;
  setState: SetStoreFunction<AppState>;
  http: HttpClient;
  /** Re-fetch the forecast for state.location (used when jumping to a hazard). */
  refresh: () => void;
  controls?: (c: MapControls) => void;
}

type Visible = Inspectable & { at: [number, number] };
type Label = LabelRequest & { color: RGB; glyph?: string };

export function MapView(props: Props) {
  const { setState } = props;
  let canvas: Renderable | undefined;
  let clock = 0;
  let size = { w: 0, h: 0 };

  // ── camera animation: state.camera is the target, `shown` eases toward it ──
  let shown: Camera = { ...props.state.camera };
  let tween: { from: Camera; to: Camera; start: number; ms: number } | undefined;
  let nextTweenMs = TWEEN_MS;
  const setCamera = (cam: Camera, ms = TWEEN_MS) => {
    nextTweenMs = ms;
    setState("camera", clampCamera(cam));
    canvas?.requestRender();
  };

  // ── async layers ──
  let grid: GlobalGrid | undefined;
  let aurora: AuroraGrid | undefined;
  let notice: { text: string; until: number } | undefined;
  const say = (text: string, ms = 2500) => {
    notice = { text, until: Date.now() + ms };
    canvas?.requestRender();
  };
  createEffect(
    on(
      () => props.state.mapField,
      (kind) => {
        if (!kind || (grid && Date.now() - Date.parse(grid.fetchedAt) < 60 * 60_000)) return;
        say(`loading global ${FIELD_LABEL[kind]}…`, 20_000);
        fetchGlobalGrid(props.http)
          .then((g) => {
            grid = g;
            notice = undefined;
          })
          .catch((err) => say(`${FIELD_LABEL[kind]} unavailable: ${(err as Error).message}`, 5000))
          .finally(() => canvas?.requestRender());
      },
    ),
  );
  createEffect(
    on(
      () => props.state.mapOverlays.aurora,
      (on) => {
        if (!on) return;
        say("loading aurora forecast…", 20_000);
        fetchAurora(props.http)
          .then((a) => {
            aurora = a;
            notice = undefined;
          })
          .catch((err) => say(`aurora unavailable: ${(err as Error).message}`, 5000))
          .finally(() => canvas?.requestRender());
      },
    ),
  );
  // Fields and the aurora go stale; re-check every 10 minutes (the HTTP cache decides).
  const timer = setInterval(() => {
    if (props.state.mapField) {
      fetchGlobalGrid(props.http)
        .then((g) => (grid = g))
        .catch(() => {});
    }
    if (props.state.mapOverlays.aurora) {
      fetchAurora(props.http)
        .then((a) => (aurora = a))
        .catch(() => {});
    }
  }, 10 * 60_000);
  onCleanup(() => clearInterval(timer));

  // ── goto prompt ──
  let prompt: string | undefined;
  let pin: { name: string; lon: number; lat: number } | undefined;
  const submitGoto = (query: string) => {
    prompt = undefined;
    if (!query.trim()) return;
    say(`searching “${query}”…`, 10_000);
    resolveLocation(props.http, query)
      .then((loc) => {
        pin = { name: loc.name, lon: loc.lon, lat: loc.lat };
        notice = undefined;
        setCamera(
          { lon: loc.lon, lat: loc.lat, zoom: Math.max(6, props.state.camera.zoom) },
          FLY_MS,
        );
      })
      .catch((err) => say((err as Error).message, 4000));
  };

  // ── per-camera caches ──
  let baseKey = "";
  let base: Cell[][] = [];
  let visible: Visible[] = [];
  let labels: Array<PlacedLabel<Label>> = [];

  const rebuild = (cam: Camera, w: number, h: number, transient: boolean) => {
    const { hazards, layers, mapOverlays: ov, mapField } = props.state;
    const alerts = props.state.report?.alerts ?? [];
    const map = buildHazardLayers(hazards, alerts, layers, cam.zoom);
    // Order: risk-outlook tint over the weather field, then night, then the aurora.
    const shaders: PixelShader[] = [...(map.shaders ?? [])];
    if (ov.night) shaders.push(nightShader(new Date(), mapField ? 0.45 : 0.6));
    if (ov.aurora && aurora) shaders.push(auroraShader(aurora));
    const field = mapField && grid ? fieldLayer(grid, mapField) : {};
    base = renderWorldMap(w, h, cam, { ...map, ...field, shaders }, undefined, { transient });

    const project = cellProjector(cam, w, h);
    visible = [];
    for (const it of inspectables(hazards, alerts, layers)) {
      const at = project(it.lon, it.lat);
      if (at && at[1] < h - 1) visible.push({ ...it, at });
    }
    // Your location gets first pick of label space, then storms by strength, then cities.
    const req: Label[] = [];
    const loc = props.state.location;
    const here = project(loc.lon, loc.lat);
    if (here) req.push({ col: here[0], row: here[1], text: loc.name, color: theme.accent });
    if (pin) {
      const at = project(pin.lon, pin.lat);
      if (at) req.push({ col: at[0], row: at[1], text: pin.name, color: PIN });
    }
    if (hazards && layers.storms) {
      for (const s of hazards.storms) {
        const at = project(s.lon, s.lat);
        if (at)
          req.push({
            col: at[0],
            row: at[1],
            text: stormLabel(s),
            color: stormCategoryColor(s.category),
          });
      }
    }
    if (ov.places) {
      // Density cap per screen area; collision avoidance thins further.
      let budget = Math.round((w * h) / 300);
      // Don't repeat a name already on the map (your location, the goto pin).
      const named = new Set(
        [loc.name, pin?.name].map((s) => s?.split(",")[0]?.trim().toLowerCase()),
      );
      for (const m of placeMarkers(cam.zoom, CITY)) {
        if (named.has(m.label?.toLowerCase())) continue;
        const at = project(m.lon, m.lat);
        if (at && m.label && budget-- > 0)
          req.push({
            col: at[0],
            row: at[1],
            text: m.label,
            color: CITY,
            glyph: m.glyph,
            optional: true,
          });
      }
    }
    labels = placeLabels(req, w, h - 1);
  };

  const selected = () => visible.find((v) => v.key === props.state.inspect);

  const cycle = (dir: 1 | -1) => {
    if (!visible.length) {
      say("no hazards in view");
      return;
    }
    const i = visible.findIndex((v) => v.key === props.state.inspect);
    const next =
      visible[
        i < 0 ? (dir > 0 ? 0 : visible.length - 1) : (i + dir + visible.length) % visible.length
      ];
    setState("inspect", next?.key);
    canvas?.requestRender();
  };

  const jump = (it: Inspectable) => {
    const loc: Location = { name: it.place, lat: it.lat, lon: it.lon, source: "coords" };
    setState({ location: loc, inspect: undefined, view: "now" });
    props.refresh();
  };

  // ── keyboard ──
  props.controls?.({
    key(k) {
      const n = k.name;
      if (prompt !== undefined) {
        if (n === "escape") prompt = undefined;
        else if (n === "return" || n === "enter") submitGoto(prompt);
        else if (n === "backspace") prompt = prompt.slice(0, -1);
        else if (n === "space") prompt += " ";
        else if (!k.ctrl && !k.meta && [...k.sequence].length === 1 && k.sequence >= " ")
          prompt += k.sequence;
        canvas?.requestRender();
        return true;
      }
      if (props.state.inspect) {
        if (n === "tab") return cycle(k.shift ? -1 : 1), true;
        if (n === "escape") return setState("inspect", undefined), true;
        if (n === "return" || n === "enter") {
          const it = selected();
          if (it) jump(it);
          return true;
        }
      }
      if (k.ctrl || k.meta) return false;
      if (k.shift) {
        const layer = LAYER_KEYS[n as keyof typeof LAYER_KEYS];
        if (layer) return setState("layers", layer, (v) => !v), true;
        const field = FIELD_KEYS[n];
        if (field) return setState("mapField", (f) => (f === field ? undefined : field)), true;
        const ov = OVERLAY_KEYS[n];
        if (ov) return setState("mapOverlays", ov, (v) => !v), true;
      }
      if (n === "g") {
        prompt = "";
        canvas?.requestRender();
        return true;
      }
      if (n === "i") {
        if (props.state.inspect) setState("inspect", undefined);
        else cycle(1);
        return true;
      }
      const cam = props.state.camera;
      const step = 30 / cam.zoom;
      switch (n) {
        case "left":
        case "h":
          return setCamera({ ...cam, lon: cam.lon - step }), true;
        case "right":
        case "l":
          return setCamera({ ...cam, lon: cam.lon + step }), true;
        case "up":
        case "k":
          return setCamera({ ...cam, lat: cam.lat + step / 2 }), true;
        case "down":
        case "j":
          return setCamera({ ...cam, lat: cam.lat - step / 2 }), true;
        case "+":
        case "=":
          return setCamera({ ...cam, zoom: cam.zoom * 2 }), true;
        case "-":
        case "_":
          return setCamera({ ...cam, zoom: cam.zoom / 2 }), true;
        case "0":
          return setCamera({ lon: props.state.location.lon, lat: 0, zoom: 1 }, FLY_MS), true;
        case "c": {
          const loc = props.state.location;
          return (
            setCamera({ lon: loc.lon, lat: loc.lat, zoom: Math.max(4, cam.zoom) }, FLY_MS), true
          );
        }
      }
      return false;
    },
  });

  // ── mouse: drag to pan, wheel to zoom around the pointer, click to inspect ──
  let drag: { x: number; y: number; cam: Camera; moved: boolean } | undefined;
  const local = (e: MouseEvent): [number, number] => [
    e.x - (canvas?.x ?? 0),
    e.y - (canvas?.y ?? 0),
  ];
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    drag = { x: e.x, y: e.y, cam: { ...props.state.camera }, moved: false };
  };
  const onMouseDrag = (e: MouseEvent) => {
    if (!drag) return;
    const dx = e.x - drag.x;
    const dy = e.y - drag.y;
    if (!dx && !dy && !drag.moved) return;
    drag.moved = true;
    setCamera(panCamera(drag.cam, size.w, size.h, dx, dy), 0);
  };
  const onMouseUp = (e: MouseEvent) => {
    if (drag && !drag.moved) {
      const [x, y] = local(e);
      const hit = nearestAt(visible, x, y);
      setState("inspect", hit?.key);
      canvas?.requestRender();
    }
    drag = undefined;
  };
  const onMouseScroll = (e: MouseEvent) => {
    const dir = e.scroll?.direction;
    if (dir !== "up" && dir !== "down") return;
    const [x, y] = local(e);
    const factor = dir === "up" ? 1.25 : 0.8;
    setCamera(zoomCameraAt(props.state.camera, size.w, size.h, x, y, factor), 120);
  };

  const draw = (api: DrawApi, w: number, h: number, dt: number) => {
    const { location: loc, hazards, layers } = props.state;
    clock += dt;
    size = { w, h };

    // Ease the shown camera toward the target.
    const target = props.state.camera;
    if (!sameCamera(target, tween?.to ?? shown)) {
      tween = { from: { ...shown }, to: { ...target }, start: performance.now(), ms: nextTweenMs };
      nextTweenMs = TWEEN_MS;
    }
    let moving = false;
    if (tween) {
      const t = tween.ms > 0 ? (performance.now() - tween.start) / tween.ms : 1;
      if (t >= 1) {
        shown = { ...tween.to };
        tween = undefined;
      } else {
        shown = lerpCamera(tween.from, tween.to, easeOutCubic(t));
        moving = true;
        api.requestFrame();
      }
    }
    const cam = shown;

    const key = [
      w,
      h,
      cam.lon,
      cam.lat,
      cam.zoom,
      hazards?.generatedAt,
      props.state.report?.alerts.length,
      Object.values(layers).join(""),
      Object.values(props.state.mapOverlays).join(""),
      props.state.mapField,
      grid?.fetchedAt,
      aurora?.forecast,
      loc.lat,
      loc.lon,
      pin?.name,
      // Night shading creeps ~0.25°/min.
      props.state.mapOverlays.night ? Math.floor(Date.now() / 60_000) : 0,
    ].join(":");
    if (key !== baseKey) {
      rebuild(cam, w, h, moving || drag !== undefined);
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
    if (hazards && layers.fires && props.state.motion) {
      // Same size cut as the static layer, so only fires already on the map flicker.
      const minAcres = cam.zoom >= 4 ? 100 : cam.zoom >= 2 ? 1_000 : 10_000;
      for (const f of hazards.fires) {
        if ((f.acres ?? 0) < minAcres) continue;
        const s = fireFlicker(f, clock);
        const at = s && project(f.lon, f.lat);
        if (at && s) api.cell(at[0], at[1], s.glyph, s.color);
      }
    }
    if (hazards && layers.storms) {
      for (const s of hazards.storms) {
        const at = project(s.lon, s.lat);
        if (!at) continue;
        const color = stormCategoryColor(s.category);
        api.cell(at[0], at[1], props.state.motion ? stormSprite(s, clock) : "@", color);
      }
    }
    const here = project(loc.lon, loc.lat);
    if (here) {
      const blink = !props.state.motion || Math.floor(clock / 500) % 2 === 0;
      api.cell(here[0], here[1], blink ? "◉" : "○", theme.accent);
    }
    if (pin) {
      const at = project(pin.lon, pin.lat);
      if (at) api.cell(at[0], at[1], "✦", PIN);
    }
    for (const l of labels) {
      if (l.glyph) api.cell(l.col, l.row, l.glyph, l.color);
      api.text(l.x, l.y, l.text, l.color);
    }

    // Inspect: bracket the selection and show a details card on the far side.
    const sel = selected();
    if (sel) {
      const pulse = !props.state.motion || Math.floor(clock / 400) % 2 === 0;
      const [sx, sy] = sel.at;
      api.cell(sx - 1, sy, pulse ? "[" : "⟦", sel.color);
      api.cell(sx + 1, sy, pulse ? "]" : "⟧", sel.color);
      drawCard(api, sel, w, sx < w / 2 ? "right" : "left");
    }

    if (props.state.mapField) drawLegend(api, props.state.mapField, props.state.units, w, h);

    if (prompt !== undefined) {
      const text = ` goto › ${prompt}▏ `;
      api.text(1, 0, text.padEnd(Math.max(28, [...text].length)), theme.text, theme.panel);
      api.text(1, 1, " enter fly there · esc cancel ", theme.dim, theme.panel);
    } else if (notice && notice.until > Date.now()) {
      api.text(1, 0, ` ${notice.text} `, theme.warn, theme.panel);
    } else if (props.state.inspect && !sel) {
      api.text(1, 0, " selection is out of view · tab next · esc exit ", theme.dim, theme.panel);
    }

    // Status + legend line; drops to glyph-only toggles when the full one won't fit.
    const z = cam.zoom < 10 ? cam.zoom.toFixed(1) : Math.round(cam.zoom).toString();
    const items: Array<[text: string, fg: RGB]> = [];
    const statusLine = (compact: boolean) => {
      items.length = 0;
      const push = (s: string, fg: RGB = theme.dim) => items.push([s, fg]);
      const toggle = (key: string, label: string, on: boolean) => {
        push(" ");
        push(key, on ? theme.accent : theme.faint);
        if (label) push(label, on ? theme.text : theme.faint);
      };
      push(` ${cam.lat.toFixed(1)}°, ${wrapLon(cam.lon).toFixed(1)}° ×${z} `);
      for (const [k, shortcut, glyph, label] of LEGEND)
        toggle(shortcut, compact ? glyph : ` ${glyph} ${label} `, layers[k]);
      push(" │");
      for (const [shortcut, kind] of Object.entries(FIELD_KEYS))
        toggle(
          shortcut.toUpperCase(),
          compact ? "" : ` ${FIELD_LABEL[kind]}`,
          props.state.mapField === kind,
        );
      push(" │");
      for (const [shortcut, ov] of Object.entries(OVERLAY_KEYS))
        toggle(
          shortcut.toUpperCase(),
          compact ? "" : ` ${ov === "places" ? "cities" : ov}`,
          props.state.mapOverlays[ov],
        );
      return items.reduce((n, [t]) => n + [...t].length, 1);
    };
    if (statusLine(false) > w) statusLine(true);
    let x = 1;
    for (const [text, fg] of items) {
      api.text(x, h - 1, text, fg, theme.panel);
      x += [...text].length;
    }
    if (hazards && x < w - 46) {
      api.text(
        x,
        h - 1,
        ` │ ${hazards.storms.length} storms · ${hazards.fires.length} fires · ${hazards.quakes.length} quakes `,
        theme.dim,
        theme.panel,
      );
    }
  };

  return (
    <box flexGrow={1} border borderStyle="rounded" borderColor={T.border} title=" world ">
      <cell_canvas
        ref={(r: Renderable) => (canvas = r)}
        live={props.state.motion}
        flexGrow={1}
        height="100%"
        draw={draw}
        onMouseDown={onMouseDown}
        onMouseDrag={onMouseDrag}
        onMouseUp={onMouseUp}
        onMouseDragEnd={() => (drag = undefined)}
        onMouseScroll={onMouseScroll}
      />
    </box>
  );
}

/** Details card for the selected hazard, on the side of the map away from it. */
function drawCard(api: DrawApi, it: Inspectable, w: number, side: "left" | "right") {
  const hint = "enter forecast · tab next · esc";
  const body = [...it.lines];
  const inner = Math.min(
    Math.max(28, [...it.title].length, ...body.map((l) => [...l].length), hint.length),
    Math.max(20, Math.floor(w / 2) - 4),
  );
  const fit = (s: string) => {
    const chars = [...s];
    return chars.length > inner ? `${chars.slice(0, inner - 1).join("")}…` : s.padEnd(inner);
  };
  const x0 = side === "right" ? w - inner - 4 : 1;
  const y0 = 1;
  const bg = theme.panel;
  const row = (y: number, s: string, fg: RGB) => {
    api.text(x0, y, "│ ", theme.dim, bg);
    api.text(x0 + 2, y, fit(s), fg, bg);
    api.text(x0 + 2 + inner, y, " │", theme.dim, bg);
  };
  api.text(x0, y0, `╭${"─".repeat(inner + 2)}╮`, theme.dim, bg);
  row(y0 + 1, it.title, it.color);
  body.forEach((l, i) => row(y0 + 2 + i, l, theme.text));
  row(y0 + 2 + body.length, hint, theme.dim);
  api.text(x0, y0 + 3 + body.length, `╰${"─".repeat(inner + 2)}╯`, theme.dim, bg);
}

/** One-line color ramp for the active field layer, bottom-right above the status line. */
function drawLegend(api: DrawApi, kind: FieldKind, units: AppState["units"], w: number, h: number) {
  const { title, entries } = fieldLegend(kind, units);
  const parts = entries.map((e) => `${e.label}`);
  const width = [...title].length + 2 + parts.reduce((n, p) => n + [...p].length + 3, 0);
  let x = Math.max(0, w - width - 1);
  const y = h - 2;
  api.text(x, y, ` ${title} `, theme.text, theme.panel);
  x += [...title].length + 2;
  entries.forEach((e, i) => {
    api.text(x, y, "██", e.color, theme.panel);
    api.text(x + 2, y, `${parts[i]} `, theme.dim, theme.panel);
    x += [...(parts[i] ?? "")].length + 3;
  });
}
