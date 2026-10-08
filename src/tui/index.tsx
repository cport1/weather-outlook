import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Location } from "../domain/types.ts";
import { fetchHazards } from "../hazards.ts";
import type { Units } from "../render/units.ts";
import { buildReport } from "../report.ts";
import type { HttpClient } from "../util/http.ts";
import { App } from "./app.tsx";
import { createAlertNotifier } from "./notify.ts";
import { createAppStore } from "./store.ts";

export interface DashboardOptions {
  http: HttpClient;
  location: Location;
  units: Units;
  motion: boolean;
  simulate?: string;
  /** "off" forces text cells and skips Kitty/Sixel probing (VHS/ttyd falsely advertise Sixel). */
  images?: "auto" | "off";
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  // OpenTUI reads this when it probes the terminal, so it must be set before the renderer exists.
  if (opts.images === "off") process.env.OPENTUI_GRAPHICS = "false";
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  });
  const [state, setState] = createAppStore({
    location: opts.location,
    units: opts.units,
    motion: opts.motion,
    simulate: opts.simulate,
  });
  if (opts.images === "off") setState("radarMode", "cells");

  const notifyAlerts = createAlertNotifier();
  let inflight = false;
  const refresh = async (force = false) => {
    if (inflight) return;
    inflight = true;
    setState({ loading: true, error: undefined });
    try {
      // Units only affect rendering, so reports are always fetched the same way.
      const report = await buildReport(opts.http, state.location, state.units, { refresh: force });
      setState({ report, loading: false, lastUpdated: Date.now() });
      notifyAlerts(report.alerts, state.location.name);
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = false;
    }
  };

  const refreshHazards = async () => {
    try {
      const near = { lat: state.location.lat, lon: state.location.lon };
      setState("hazards", await fetchHazards(opts.http, { near, alertZones: 40 }));
    } catch {
      // Individual providers already degrade gracefully; nothing to surface here.
    }
  };

  const quit = () => {
    renderer.destroy();
    process.exit(0);
  };

  await render(
    () => (
      <App
        http={opts.http}
        state={state}
        setState={setState}
        refresh={() => void refresh(true)}
        quit={quit}
      />
    ),
    renderer,
  );
  void refresh();
  void refreshHazards();
  // Stale-while-revalidate: the first paint comes from cache; re-read once fresh data lands.
  let pending: ReturnType<typeof setTimeout> | undefined;
  opts.http.onBackgroundUpdate?.(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      void refresh();
      void refreshHazards();
    }, 250);
  });
  setInterval(() => void refreshHazards(), 15 * 60_000);
}
