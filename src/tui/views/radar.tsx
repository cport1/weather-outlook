import { createEffect, createSignal, on, onCleanup } from "solid-js";
import {
  type Bbox,
  fetchRainViewerFrames,
  fetchRainViewerRaster,
  type RadarRaster,
} from "../../providers/radar.ts";
import type { Cell } from "../../render/canvas.ts";
import { hex } from "../../render/color.ts";
import { cellProjector, renderWorldMap } from "../../render/worldmap.ts";
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

/** Degrees of longitude visible for a radar zoom level (map zoom 1 = 360°). */
export const radarSpan = (zoom: number) => 360 / zoom;

export function RadarView(props: {
  state: AppState;
  http: HttpClient;
  controls: (c: RadarControls) => void;
}) {
  const [frames, setFrames] = createSignal<RadarRaster[]>([]);
  const [index, setIndex] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);
  const [status, setStatus] = createSignal("loading radar…");
  let elapsed = 0;
  let cacheKey = "";
  const cache = new Map<number, Cell[][]>();

  props.controls({
    playing,
    toggle: () => setPlaying((p) => !p),
    step: (d) => {
      setPlaying(false);
      const n = frames().length || 1;
      setIndex((i) => (i + d + n) % n);
    },
  });

  // (Re)load all frames whenever the location or radar zoom changes.
  createEffect(
    on(
      () => [props.state.location.lat, props.state.location.lon, props.state.radarZoom] as const,
      async ([lat, lon, zoom]) => {
        const half = radarSpan(zoom) / 2;
        const bbox: Bbox = {
          west: lon - half * 1.2,
          east: lon + half * 1.2,
          south: lat - half * 0.8,
          north: lat + half * 0.8,
        };
        setStatus("loading radar…");
        try {
          const { host, frames: list } = await fetchRainViewerFrames(props.http);
          const rasters = await Promise.all(
            list.map((f) => fetchRainViewerRaster(props.http, host, f, bbox)),
          );
          cache.clear();
          setFrames(rasters);
          setIndex(rasters.length - 1);
          setStatus("");
        } catch (err) {
          setStatus(`radar unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    ),
  );

  const draw = (api: DrawApi, w: number, h: number, dt: number) => {
    const loc = props.state.location;
    const cam = { lon: loc.lon, lat: loc.lat, zoom: props.state.radarZoom };
    const list = frames();
    const key = `${w}x${h}:${cam.lon},${cam.lat},${cam.zoom}:${list.length}`;
    if (key !== cacheKey) {
      cache.clear();
      cacheKey = key;
    }
    if (playing() && list.length > 1 && props.state.motion) {
      elapsed += dt;
      // Hold the latest frame a little longer so the loop "lands" on now.
      const hold = index() === list.length - 1 ? 1500 : 350;
      if (elapsed > hold) {
        elapsed = 0;
        setIndex((i) => (i + 1) % list.length);
      }
    }
    const i = Math.min(index(), Math.max(0, list.length - 1));
    const raster = list[i];
    let cells = cache.get(i);
    if (!cells) {
      cells = renderWorldMap(
        w,
        h,
        cam,
        { field: raster ? (lon, lat) => raster.sample(lon, lat) : undefined },
        OCEAN_THEME,
      );
      cache.set(i, cells);
    }
    api.grid(cells);

    const at = cellProjector(cam, w, h)(loc.lon, loc.lat);
    if (at) {
      api.cell(at[0], at[1], "◉", theme.accent);
      api.text(at[0] + 2, at[1], loc.name, theme.text);
    }

    // Timeline: one tick per frame, current frame highlighted.
    if (raster) {
      const t = new Date(raster.time * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: loc.timezone,
      });
      const ago = Math.round((Date.now() / 1000 - raster.time) / 60);
      let x = 1;
      const put = (s: string, fg = theme.dim) => {
        api.text(x, h - 1, s, fg, theme.panel);
        x += [...s].length;
      };
      put(playing() ? " ▶ " : " ❚❚ ", theme.accent);
      for (let k = 0; k < list.length; k++)
        put(k === i ? "●" : "·", k === i ? theme.accent : theme.faint);
      put(`  ${t} (${ago <= 0 ? "now" : `${ago} min ago`})  `, theme.text);
      put("space play/pause  ,/. step  +/- zoom  · radar © RainViewer ", theme.dim);
    }
    if (status()) api.text(2, 1, ` ${status()} `, theme.warn, theme.panel);
  };

  onCleanup(() => cache.clear());

  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={T.border}
      title=" radar · last 2 hours "
    >
      <cell_canvas live flexGrow={1} height="100%" draw={draw} />
    </box>
  );
}
