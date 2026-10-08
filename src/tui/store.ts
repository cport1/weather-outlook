import { createStore } from "solid-js/store";
import type { Hazards, Location, Report } from "../domain/types.ts";
import type { FieldKind } from "../providers/global-grid.ts";
import { DEFAULT_TOGGLES, type LayerToggles } from "../render/hazard-layers.ts";
import type { Units } from "../render/units.ts";
import type { Camera } from "../render/worldmap.ts";

export const VIEWS = ["now", "hourly", "daily", "radar", "map", "hazards", "alerts"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  now: "Now",
  hourly: "Hourly",
  daily: "10-Day",
  radar: "Radar",
  map: "World Map",
  hazards: "Hazards",
  alerts: "Alerts",
};

export interface AppState {
  view: View;
  location: Location;
  units: Units;
  report?: Report;
  hazards?: Hazards;
  layers: LayerToggles;
  loading: boolean;
  error?: string;
  lastUpdated?: number;
  /** Map camera target; the map view eases toward it. */
  camera: Camera;
  /** Global field layer under the coastlines (shift+T/W/P/C), one at a time. */
  mapField?: FieldKind;
  mapOverlays: MapOverlays;
  /** Key of the hazard selected in map inspect mode (see render/inspect.ts). */
  inspect?: string;
  /** Map zoom used by the radar view (360 / zoom = degrees of longitude shown). */
  radarZoom: number;
  /** "auto" uses Kitty/Sixel images when the terminal supports them; "cells" forces half-blocks. */
  radarMode: "auto" | "cells";
  showHelp: boolean;
  motion: boolean;
  /** Overrides the live condition for demos (`--simulate rain`). */
  simulate?: string;
  alertIndex: number;
  /** Hourly view: hour under the chart cursor (index into the 48h window). */
  hourCursor: number;
  /** Hourly view: which chart groups are shown (t/p/w/h/v toggle them). */
  hourSeries: HourSeries;
  /** 10-day view: selected / hovered day. */
  dayIndex: number;
  /** `/` location search overlay. */
  search: { open: boolean; query: string; results: Location[]; index: number; busy: boolean };
  /** Recently viewed locations (most recent first), cycled with `s`. */
  recent: Location[];
  /** Saved locations handed in by the CLI/config, also cycled with `s`. */
  saved: Location[];
  /** False while the terminal window is unfocused; animations pause. */
  focused: boolean;
}

export interface MapOverlays {
  /** Day/night terminator shading. */
  night: boolean;
  /** SWPC OVATION aurora probability glow. */
  aurora: boolean;
  /** City names (density by zoom). */
  places: boolean;
}

export interface HourSeries {
  temp: boolean;
  precip: boolean;
  wind: boolean;
  humidity: boolean;
  uv: boolean;
}

export function createAppStore(
  init: Pick<AppState, "location" | "units" | "motion" | "simulate"> & Partial<AppState>,
) {
  return createStore<AppState>({
    view: "now",
    loading: true,
    camera: { lon: init.location.lon, lat: 0, zoom: 1 },
    radarZoom: 24,
    radarMode: "auto",
    showHelp: false,
    alertIndex: 0,
    hourCursor: 0,
    hourSeries: { temp: true, precip: true, wind: true, humidity: true, uv: true },
    dayIndex: 0,
    search: { open: false, query: "", results: [], index: 0, busy: false },
    recent: [],
    saved: [],
    focused: true,
    layers: { ...DEFAULT_TOGGLES },
    mapOverlays: { night: true, aurora: false, places: true },
    ...init,
  });
}
