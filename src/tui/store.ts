import { createStore } from "solid-js/store";
import type { Location, Report } from "../domain/types.ts";
import type { Units } from "../render/units.ts";
import type { Camera } from "../render/worldmap.ts";

export const VIEWS = ["now", "hourly", "daily", "map", "alerts"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  now: "Now",
  hourly: "Hourly",
  daily: "10-Day",
  map: "World Map",
  alerts: "Alerts",
};

export interface AppState {
  view: View;
  location: Location;
  units: Units;
  report?: Report;
  loading: boolean;
  error?: string;
  lastUpdated?: number;
  camera: Camera;
  showHelp: boolean;
  motion: boolean;
  /** Overrides the live condition for demos (`--simulate rain`). */
  simulate?: string;
  alertIndex: number;
}

export function createAppStore(init: Pick<AppState, "location" | "units" | "motion" | "simulate">) {
  return createStore<AppState>({
    view: "now",
    loading: true,
    camera: { lon: init.location.lon, lat: 0, zoom: 1 },
    showHelp: false,
    alertIndex: 0,
    ...init,
  });
}
