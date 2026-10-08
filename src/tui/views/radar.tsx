import { NativeImage, resolveImageRenderProtocol } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import {
  type Bbox,
  fetchIemFrameTimes,
  fetchIemRaster,
  fetchRainViewerFrames,
  fetchRainViewerRaster,
  fetchSatellite,
  insideConus,
  mapLimit,
  type RadarRaster,
  type SatelliteImage,
} from "../../providers/radar.ts";
import type { Cell } from "../../render/canvas.ts";
import { hex, type RGB } from "../../render/color.ts";
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

// Satellite base layer (`v`). Module-level so it survives switching views.
const [satelliteOn, setSatelliteOn] = createSignal(false);
export const toggleSatellite = () => setSatelliteOn((v) => !v);

// Chrome around the radar image: header + footer + panel border + timeline row.
const CHROME_ROWS = 5;
const CHROME_COLS = 4;
const MAX_IMAGE_PX = 1600;
/** Source raster width requested from WMS services (IEM, GIBS). */
const WMS_PX = 1024;
const IEM_FRAMES = 12;
const IEM_STEP_MIN = 10;
const SAT_DIM = 0.6;

type Source = "rainviewer" | "iem";

/** Pixel height that keeps a WMS image of `bbox` at roughly square Mercator pixels. */
function wmsHeight(b: Bbox, w: number): number {
  const mid = ((b.north + b.south) / 2) * (Math.PI / 180);
  return Math.min(
    WMS_PX,
    Math.round((w * (b.north - b.south)) / (b.east - b.west) / Math.cos(mid)),
  );
}

/** NEXRAD via IEM inside CONUS (finer than RainViewer's z7 cap), RainViewer everywhere else. */
async function loadFrames(
  http: HttpClient,
  bbox: Bbox,
): Promise<{ source: Source; rasters: RadarRaster[] }> {
  if (insideConus(bbox)) {
    try {
      const times = await fetchIemFrameTimes(http, IEM_FRAMES, IEM_STEP_MIN);
      if (times.length) {
        const h = wmsHeight(bbox, WMS_PX);
        const rasters = await mapLimit(times, 4, (t) => fetchIemRaster(http, bbox, WMS_PX, h, t));
        return { source: "iem", rasters };
      }
    } catch {
      // IEM down or slow: RainViewer covers the US too, just coarser.
    }
  }
  const { host, frames } = await fetchRainViewerFrames(http);
  const rasters = await Promise.all(
    frames.map((f) => fetchRainViewerRaster(http, host, f, bbox, 800)),
  );
  return { source: "rainviewer", rasters };
}

const SOURCE_CREDIT: Record<Source, string> = {
  rainviewer: "radar © RainViewer",
  iem: "NEXRAD via Iowa Env. Mesonet",
};

export function RadarView(props: {
  state: AppState;
  http: HttpClient;
  controls: (c: RadarControls) => void;
}) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const [frames, setFrames] = createSignal<RadarRaster[]>([]);
  const [source, setSource] = createSignal<Source>("rainviewer");
  const [satellite, setSatellite] = createSignal<SatelliteImage | undefined>();
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

  const sameBbox = (a: Bbox, b: Bbox) =>
    a.west === b.west && a.east === b.east && a.south === b.south && a.north === b.north;
  const bbox = createMemo(
    (): Bbox =>
      viewportBbox(
        {
          lon: props.state.location.lon,
          lat: props.state.location.lat,
          zoom: props.state.radarZoom,
        },
        Math.round(aspect() * 10) / 10,
      ),
    { west: 0, east: 0, south: 0, north: 0 },
    { equals: sameBbox },
  );

  // (Re)load all frames whenever the location, radar zoom or viewport shape changes.
  // A generation counter drops results from loads that were superseded mid-flight.
  let generation = 0;
  createEffect(
    on(bbox, async (b) => {
      const gen = ++generation;
      setStatus("loading radar…");
      try {
        const { source: src, rasters } = await loadFrames(props.http, b);
        if (gen !== generation) return;
        setSource(src);
        setFrames(rasters);
        setIndex(rasters.length - 1);
        setStatus("");
      } catch (err) {
        if (gen !== generation) return;
        setStatus(`radar unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  // Satellite base image (one still; geostationary imagery reaches GIBS ~1-2 h late).
  let satGeneration = 0;
  createEffect(
    on([bbox, satelliteOn] as const, async ([b, on]) => {
      const gen = ++satGeneration;
      if (!on) return setSatellite(undefined);
      try {
        const img = await fetchSatellite(props.http, b, WMS_PX, wmsHeight(b, WMS_PX));
        if (gen === satGeneration) setSatellite(img);
      } catch (err) {
        if (gen !== satGeneration) return;
        setSatellite(undefined);
        setStatus(`satellite unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  const camera = () => ({
    lon: props.state.location.lon,
    lat: props.state.location.lat,
    zoom: props.state.radarZoom,
  });

  /** Radar echo on top of the satellite base (when enabled), dimmed so echoes and labels pop. */
  const fieldFor = (raster: RadarRaster | undefined) => {
    const sat = satellite();
    if (!raster && !sat) return undefined;
    return (lon: number, lat: number): RGB | undefined => {
      const echo = raster?.sample(lon, lat);
      if (echo || !sat) return echo;
      const c = sat.sample(lon, lat);
      return c && (c.map((v) => Math.round(v * SAT_DIM)) as unknown as RGB);
    };
  };

  // ── Image mode: render real pixels and hand NativeImages to <image> ──
  const imageSize = createMemo(
    () => {
      const d = dims();
      const res = renderer.resolution;
      const cols = Math.max(10, d.width - CHROME_COLS);
      const rows = Math.max(5, d.height - CHROME_ROWS);
      const cellW = res ? res.width / d.width : 8;
      const cellH = res ? res.height / d.height : 16;
      const scale = Math.min(1, MAX_IMAGE_PX / (cols * cellW));
      return { w: Math.round(cols * cellW * scale), h: Math.round(rows * cellH * scale) };
    },
    undefined,
    { equals: (a, b) => a.w === b.w && a.h === b.h },
  );
  const base = createMemo<MapRaster | undefined>(() => {
    if (!imageMode()) return undefined;
    const { w, h } = imageSize();
    return createMapRaster(w, h, camera(), OCEAN_THEME);
  });
  // One NativeImage per frame, owned by a cache that is replaced (and its images disposed)
  // whenever what they depict changes. Disposal happens in the old cache's cleanup, before
  // currentImage() asks the new cache, so <image> is never handed a disposed image.
  const imageCache = createMemo(() => {
    base();
    frames();
    satellite();
    const cache = new Map<number, NativeImage>();
    onCleanup(() => {
      for (const img of cache.values()) img.dispose();
    });
    return cache;
  });
  const currentImage = createMemo(() => {
    const b = base();
    if (!b) return undefined;
    const cache = imageCache();
    const i = index();
    let img = cache.get(i);
    if (!img) {
      const loc = props.state.location;
      const px = b.frame(fieldFor(frames()[i]), {
        lon: loc.lon,
        lat: loc.lat,
        color: theme.accent,
      });
      img = NativeImage.fromRgba(px, b.width, b.height);
      cache.set(i, img);
    }
    return img;
  });

  // ── Cell mode: half-block field + braille coast ──
  let cellKey = "";
  let cellSat: SatelliteImage | undefined;
  let cellFrames: RadarRaster[] = [];
  const cellCache = new Map<number, Cell[][]>();
  const drawCells = (api: DrawApi, w: number, h: number) => {
    const cam = camera();
    const list = frames();
    const sat = satellite();
    const key = `${w}x${h}:${cam.lon},${cam.lat},${cam.zoom}`;
    if (key !== cellKey || sat !== cellSat || list !== cellFrames) {
      cellCache.clear();
      cellKey = key;
      cellSat = sat;
      cellFrames = list;
    }
    const i = Math.min(index(), Math.max(0, list.length - 1));
    let cells = cellCache.get(i);
    if (!cells) {
      cells = renderWorldMap(w, h, cam, { field: fieldFor(list[i]) }, OCEAN_THEME);
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
    const credit = [SOURCE_CREDIT[source()], satellite()?.label].filter(Boolean).join(" · ");
    const keys = "i image/cells  v satellite  · ";
    if (x + keys.length + credit.length < w) put(keys, theme.dim);
    if (x + credit.length < w) put(`${credit} `, theme.dim);
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
