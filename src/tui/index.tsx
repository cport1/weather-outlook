import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Location } from "../domain/types.ts";
import { fetchHazards } from "../hazards.ts";
import type { Units } from "../render/units.ts";
import { buildReport } from "../report.ts";
import type { HttpClient } from "../util/http.ts";
import { App } from "./app.tsx";
import { createAlertNotifier } from "./notify.ts";
import { createAppStore } from "./store.ts";
import { resolveThemeName, setTheme, type ThemeName } from "./theme.ts";

export interface DashboardOptions {
  http: HttpClient;
  location: Location;
  units: Units;
  motion: boolean;
  simulate?: string;
  /** "off" forces text cells and skips Kitty/Sixel probing (VHS/ttyd falsely advertise Sixel). */
  images?: "auto" | "off";
  /** Color theme; falls back to WEATHER_OUTLOOK_THEME, then "midnight". NO_COLOR forces "mono". */
  theme?: ThemeName | string;
  /** Saved places (from config) that `s` cycles through alongside recent ones. */
  savedLocations?: Location[];
}

/**
 * Put the terminal back (alternate screen, raw mode, mouse tracking) no matter
 * how the process ends: signals, uncaught errors, or rejected promises.
 */
export function installTerminalRestore(renderer: CliRenderer): () => void {
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try {
      renderer.destroy();
    } catch {
      // Already torn down.
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    restore();
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  };
  const onFatal = (err: unknown) => {
    restore();
    process.stderr.write(
      `weather-outlook: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  process.on("exit", restore);
  return () => {
    for (const s of signals) process.off(s, onSignal);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    process.off("exit", restore);
  };
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  setTheme(resolveThemeName(opts.theme));
  // OpenTUI reads this when it probes the terminal, so it must be set before the renderer exists.
  if (opts.images === "off") process.env.OPENTUI_GRAPHICS = "false";
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  });
  installTerminalRestore(renderer);
  const [state, setState] = createAppStore({
    location: opts.location,
    units: opts.units,
    motion: opts.motion,
    simulate: opts.simulate,
    saved: opts.savedLocations ?? [],
  });
  if (opts.images === "off") setState("radarMode", "cells");

  const notifyAlerts = createAlertNotifier();
  let inflight = false;
  let again = false;
  const refresh = async (force = false) => {
    // A refresh requested mid-flight (e.g. switching location) runs right after.
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    setState({ loading: true, error: undefined });
    const loc = state.location;
    try {
      // Units only affect rendering, so reports are always fetched the same way.
      const report = await buildReport(opts.http, loc, state.units, { refresh: force });
      if (loc === state.location) {
        setState({ report, loading: false, lastUpdated: Date.now() });
        notifyAlerts(report.alerts, state.location.name);
        // Nearby quakes/alerts in the hazards feed follow the location too.
        if (hazardsAt !== loc) void refreshHazards();
      }
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = false;
      if (again || loc !== state.location) {
        again = false;
        void refresh(force);
      }
    }
  };

  let hazardsAt: Location | undefined;
  const refreshHazards = async () => {
    hazardsAt = state.location;
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
