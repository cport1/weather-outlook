// Renders the dashboard headlessly and prints each view as plain text.
// Usage: bun scripts/snapshot.tsx [place] [width] [height]
import { testRender } from "@opentui/solid";
import envPaths from "env-paths";
import { DiskCache } from "../src/cache/disk-cache.ts";
import { resolveLocation } from "../src/providers/location.ts";
import { buildReport } from "../src/report.ts";
import { App } from "../src/tui/app.tsx";
import { createAppStore, VIEWS } from "../src/tui/store.ts";
import { createHttpClient } from "../src/util/http.ts";

const [place = "Denver", w = "120", h = "36"] = process.argv.slice(2);
const http = createHttpClient(new DiskCache(envPaths("weather-outlook", { suffix: "" }).cache));
const location = await resolveLocation(http, place);
const report = await buildReport(http, location, "imperial");
const [state, setState] = createAppStore({ location, units: "imperial", motion: false });
setState({ report, loading: false, lastUpdated: Date.now() });
const t = await testRender(() => <App state={state} setState={setState} refresh={() => {}} quit={() => {}} />, {
  width: Number(w),
  height: Number(h),
});
for (const v of VIEWS) {
  setState("view", v);
  await t.renderOnce();
  console.log(`\n===== ${v} =====`);
  console.log(t.captureCharFrame());
}
process.exit(0);
