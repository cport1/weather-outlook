import { NativeImage, resolveImageRenderProtocol } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import {
  type Bbox,
  fetchRainViewerFrames,
  fetchRainViewerRaster,
  type RadarRaster,
} from "../../providers/radar.ts";
import type { Cell } from "../../render/canvas.ts";
import { hex } from "../../render/color.ts";
import { createMapRaster, type MapRaster } from "../../render/raster.ts";
import { cellProjector, renderWorldMap, viewportBbox } from "../../render/worldmap.ts";
import type { HttpClient } from "../../util/http.ts";
import type { DrawApi } from "../cell-canvas.ts";
import type { AppState } from "../store.ts";
import { T, theme } from "../theme.ts";

const OCEAN_THEME = {
  ocean: hex("#0b1622"),
  land: hex("#1a2a20"),
  coast: hex("#7fb8a6"),
  border: hex("#33504a"),
};

export interface RadarControls {
  playing: () => boolean;
  toggle: () => void;
  step: (d: number) => void;
}

// Chrome around the radar image: header + footer + panel border + timeline row.
const CHROME_ROWS = 5;
const CHROME_COLS = 4;
const MAX_IMAGE_PX = 1600;

export function RadarView(props: {
  state: AppState;
  http: HttpClient;
  controls: (c: RadarControls) => void;
}) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const [frames, setFrames] = createSignal<RadarRaster[]>([]);
  const [index, setIndex] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);
  const [status, setStatus] = createSignal("loading radar…");

  props.controls({
    playing,
    toggle: () => setPlaying((p) => !p),
    step: (d) => {
      setPlaying(false);
      const n = frames().length || 1;
      setIndex((i) => (i + d + n) % n);
    },
  });

  /** Real pixels (Kitty/Sixel) when the terminal supports them and the user hasn't opted out. */
  const protocol = createMemo(() => {
    void dims();
    if (props.state.radarMode === "cells") return "blocks";
    return resolveImageRenderProtocol("auto", renderer.capabilities, renderer.resolution !== null);
  });
  const imageMode = () => protocol() !== "blocks";

  // Frame clock, independent of rendering mode. Hold the latest frame so the loop "lands" on now.
  let elapsed = 0;
  const tick = setInterval(() => {
    const n = frames().length;
    if (!playing() || n < 2 || !props.state.motion) return;
    elapsed += 50;
    if (elapsed >= (index() === n - 1 ? 1500 : 350)) {
      elapsed = 0;
      setIndex((i) => (i + 1) % n);
    }
  }, 50);
  onCleanup(() => clearInterval(tick));

  // Visible area aspect in pixels: terminal cells are ~1:2, so pixels ≈ cols : rows*2.
  const aspect = createMemo(() => {
    const d = dims();
    return Math.max(10, d.width - CHROME_COLS) / (Math.max(5, d.height - CHROME_ROWS) * 2);
  });

  // (Re)load all frames whenever the location, radar zoom or viewport shape changes.
  createEffect(
    on(
      () =>
        [
          props.state.location.lat,
          props.state.location.lon,
          props.state.radarZoom,
          Math.round(aspect() * 10) / 10,
        ] as const,
      async ([lat, lon, zoom, a]) => {
        const bbox: Bbox = viewportBbox({ lon, lat, zoom }, a);
        setStatus("loading radar…");
        try {
          const { host, frames: list } = await fetchRainViewerFrames(props.http);
          const rasters = await Promise.all(
            list.map((f) => fetchRainViewerRaster(props.http, host, f, bbox, 800)),
          );
          setFrames(rasters);
          setIndex(rasters.length - 1);
          setStatus("");
        } catch (err) {
          setStatus(`radar unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    ),
  );

  const camera = () => ({
    lon: props.state.location.lon,
    lat: props.state.location.lat,
    zoom: props.state.radarZoom,
  });

  // ── Image mode: render real pixels and hand NativeImages to <image> ──
  const imageSize = createMemo(() => {
    const d = dims();
    const res = renderer.resolution;
    const cols = Math.max(10, d.width - CHROME_COLS);
    const rows = Math.max(5, d.height - CHROME_ROWS);
    const cellW = res ? res.width / d.width : 8;
    const cellH = res ? res.height / d.height : 16;
    const scale = Math.min(1, MAX_IMAGE_PX / (cols * cellW));
    return { w: Math.round(cols * cellW * scale), h: Math.round(rows * cellH * scale) };
  });
  const base = createMemo<MapRaster | undefined>(() => {
    if (!imageMode()) return undefined;
    const { w, h } = imageSize();
    return createMapRaster(w, h, camera(), OCEAN_THEME);
  });
  const images = new Map<number, NativeImage>();
  const clearImages = () => {
    for (const img of images.values()) img.dispose();
    images.clear();
  };
  createEffect(on([base, frames], clearImages));
  onCleanup(clearImages);
  const currentImage = createMemo(() => {
    const b = base();
    const raster = frames()[index()];
    if (!b) return undefined;
    const i = index();
    let img = images.get(i);
    if (!img) {
      const loc = props.state.location;
      const px = b.frame(raster ? (lon, lat) => raster.sample(lon, lat) : undefined, {
        lon: loc.lon,
        lat: loc.lat,
        color: theme.accent,
      });
      img = NativeImage.fromRgba(px, b.width, b.height);
      images.set(i, img);
    }
    return img;
  });

  // ── Cell mode: half-block field + braille coast ──
  let cellKey = "";
  const cellCache = new Map<number, Cell[][]>();
  const drawCells = (api: DrawApi, w: number, h: number) => {
    const cam = camera();
    const list = frames();
    const key = `${w}x${h}:${cam.lon},${cam.lat},${cam.zoom}:${list.length}`;
    if (key !== cellKey) {
      cellCache.clear();
      cellKey = key;
    }
    const i = Math.min(index(), Math.max(0, list.length - 1));
    const raster = list[i];
    let cells = cellCache.get(i);
    if (!cells) {
      const field = raster ? (lon: number, lat: number) => raster.sample(lon, lat) : undefined;
      cells = renderWorldMap(w, h, cam, { field }, OCEAN_THEME);
      cellCache.set(i, cells);
    }
    api.grid(cells);
    const at = cellProjector(cam, w, h)(props.state.location.lon, props.state.location.lat);
    if (at) {
      api.cell(at[0], at[1], "◉", theme.accent);
      api.text(at[0] + 2, at[1], props.state.location.name, theme.text);
    }
    if (status()) api.text(2, 1, ` ${status()} `, theme.warn, theme.panel);
  };

  // ── Timeline row (both modes) ──
  const drawTimeline = (api: DrawApi, w: number) => {
    api.fill(theme.panel);
    const list = frames();
    const i = Math.min(index(), Math.max(0, list.length - 1));
    const raster = list[i];
    let x = 0;
    const put = (s: string, fg = theme.dim) => {
      api.text(x, 0, s, fg, theme.panel);
      x += [...s].length;
    };
    put(playing() ? " ▶ " : " ❚❚ ", theme.accent);
    for (let k = 0; k < list.length; k++)
      put(k === i ? "●" : "·", k === i ? theme.accent : theme.faint);
    if (raster) {
      const t = new Date(raster.time * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: props.state.location.timezone,
      });
      const ago = Math.round((Date.now() / 1000 - raster.time) / 60);
      put(`  ${t} (${ago <= 0 ? "now" : `${ago} min ago`})  `, theme.text);
    } else if (status()) {
      put(`  ${status()}  `, theme.warn);
    }
    put(imageMode() ? `[${protocol()} image] ` : "[cells] ", theme.ok);
    if (x < w - 40) put("i image/cells  · radar © RainViewer ", theme.dim);
  };

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={T.border}
      title=" radar · last 2 hours "
    >
      <Show when={imageMode()} fallback={<cell_canvas flexGrow={1} draw={drawCells} />}>
        <image flexGrow={1} source={currentImage()} fit="fill" protocol={protocol()} />
      </Show>
      <cell_canvas live height={1} draw={drawTimeline} />
    </box>
  );
}
