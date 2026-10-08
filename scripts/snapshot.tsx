// Renders the dashboard headlessly and prints each view as plain text.
// Usage: bun scripts/snapshot.tsx [place] [width] [height]
import { testRender } from "@opentui/solid";
import envPaths from "env-paths";
import { trackProviders } from "../src/attribution.ts";
import { DiskCache } from "../src/cache/disk-cache.ts";
import { resolveLocation } from "../src/providers/location.ts";
import { fetchHazards } from "../src/hazards.ts";
import { buildReport } from "../src/report.ts";
import { App } from "../src/tui/app.tsx";
import { createAppStore, VIEWS } from "../src/tui/store.ts";
import { toggleCredits } from "../src/tui/views/credits.tsx";
import { toggleSatellite } from "../src/tui/views/radar.tsx";
import { createHttpClient } from "../src/util/http.ts";

const [place = "Denver", w = "120", h = "36"] = process.argv.slice(2);
const http = trackProviders(createHttpClient(new DiskCache(envPaths("weather-outlook", { suffix: "" }).cache)));
const location = await resolveLocation(http, place);
const report = await buildReport(http, location, "imperial");
const [state, setState] = createAppStore({ location, units: "imperial", motion: Boolean(process.env.MOTION), simulate: process.env.SIMULATE });
setState({ report, hazards: await fetchHazards(http), loading: false, lastUpdated: Date.now() });
const t = await testRender(() => <App http={http} state={state} setState={setState} refresh={() => {}} quit={() => {}} />, {
  width: Number(w),
  height: Number(h),
});
// SATELLITE=1 turns on the radar satellite base; CREDITS=1 opens the credits overlay.
if (process.env.SATELLITE) toggleSatellite();
if (process.env.CREDITS) toggleCredits();
// KEYS drives the view before capture, space-separated: TAB / ENTER / ESCAPE / ARROW_UP…,
// S-x (shift+x), click:x,y  scroll:x,y,up  drag:x1,y1,x2,y2  wait:ms, or literal text.
// e.g. KEYS="S-t + + wait:3000" VIEW=map bun scripts/snapshot.tsx
async function play(script: string) {
  const keys = t.mockInput as unknown as {
    pressKey(k: string, mods?: { shift?: boolean }): void;
    typeText(s: string): Promise<void>;
  };
  for (const tok of script.split(" ").filter(Boolean)) {
    const [cmd, arg = ""] = tok.split(":");
    const n = arg.split(",").map(Number);
    if (cmd === "wait") await Bun.sleep(Number(arg));
    else if (cmd === "click") await t.mockMouse.click(n[0] ?? 0, n[1] ?? 0);
    else if (cmd === "scroll") await t.mockMouse.scroll(n[0] ?? 0, n[1] ?? 0, arg.endsWith("down") ? "down" : "up");
    else if (cmd === "drag") await t.mockMouse.drag(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0);
    else if (/^[A-Z_0-9]{2,}$/.test(tok)) keys.pressKey(tok);
    else if (tok.startsWith("S-")) keys.pressKey(tok.slice(2), { shift: true });
    else await keys.typeText(tok.replaceAll("_", " "));
    for (let i = 0; i < 3; i++) await t.renderOnce();
  }
  // Let camera transitions finish.
  await Bun.sleep(700);
  for (let i = 0; i < 3; i++) await t.renderOnce();
}
const only = process.env.VIEW;
const htmlOut = process.env.HTML;
const pages: string[] = [];
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const css = (c: { toInts(): [number, number, number, number] }) => {
  const [r, g, b, a] = c.toInts();
  return a === 0 ? "transparent" : `rgb(${r},${g},${b})`;
};
for (const v of VIEWS) {
  if (only && only !== v) continue;
  setState("view", v);
  await t.renderOnce();
  await t.renderOnce();
  if (process.env.KEYS) await play(process.env.KEYS);
  if (htmlOut) {
    // Give async views (radar) time to load, then tick animated canvases a few frames.
    await t.renderOnce();
    await Bun.sleep(Number(process.env.WAIT ?? 0));
    for (let i = 0; i < 20; i++) await t.renderOnce();
    const frame = t.captureSpans();
    const rows = frame.lines
      .map((l) => l.spans.map((sp) => `<span style="color:${css(sp.fg)};background:${css(sp.bg)}">${esc(sp.text)}</span>`).join(""))
      .join("\n");
    pages.push(`<h3>${v}</h3><pre>${rows}</pre>`);
  } else {
    console.log(`\n===== ${v} =====`);
    console.log(t.captureCharFrame());
  }
}
if (htmlOut) {
  await Bun.write(
    htmlOut,
    `<!doctype html><meta charset="utf-8"><style>body{background:#0a0f16;color:#ccc;font-family:monospace}pre{font:13px/1.15 "JetBrains Mono",Menlo,monospace;letter-spacing:0;margin:0 0 24px}</style>${pages.join("")}`,
  );
  console.log(`wrote ${htmlOut}`);
}
process.exit(0);
