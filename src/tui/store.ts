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
}

export interface MapOverlays {
  /** Day/night terminator shading. */
  night: boolean;
  /** SWPC OVATION aurora probability glow. */
  aurora: boolean;
  /** City names (density by zoom). */
  places: boolean;
}

export function createAppStore(init: Pick<AppState, "location" | "units" | "motion" | "simulate">) {
  return createStore<AppState>({
    view: "now",
    loading: true,
    camera: { lon: init.location.lon, lat: 0, zoom: 1 },
    radarZoom: 24,
    radarMode: "auto",
    showHelp: false,
    alertIndex: 0,
    layers: { ...DEFAULT_TOGGLES },
    mapOverlays: { night: true, aurora: false, places: true },
    ...init,
  });
}
