import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Location } from "../domain/types.ts";
import { fetchHazards } from "../hazards.ts";
import type { Units } from "../render/units.ts";
import { buildReport } from "../report.ts";
import type { HttpClient } from "../util/http.ts";
import { App } from "./app.tsx";
import { createAppStore } from "./store.ts";

export interface DashboardOptions {
  http: HttpClient;
  location: Location;
  units: Units;
  motion: boolean;
  simulate?: string;
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
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

  let inflight = false;
  const refresh = async (force = false) => {
    if (inflight) return;
    inflight = true;
    setState({ loading: true, error: undefined });
    try {
      // Units only affect rendering, so reports are always fetched the same way.
      const report = await buildReport(opts.http, state.location, state.units, { refresh: force });
      setState({ report, loading: false, lastUpdated: Date.now() });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = false;
    }
  };

  const refreshHazards = async () => {
    try {
      setState("hazards", await fetchHazards(opts.http));
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
