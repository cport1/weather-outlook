import { existsSync } from "node:fs";
import type { DiskCache } from "./cache/disk-cache.ts";
import type { Capabilities, ColorLevel } from "./capabilities.ts";
import { padEnd, paint } from "./render/ansi.ts";
import { hex, type RGB, temperatureScale } from "./render/color.ts";
import { USER_AGENT } from "./util/http.ts";

/**
 * `weather-outlook doctor`: what the terminal can do, where files live, and
 * whether every upstream service answers. Probes bypass the cache on purpose.
 */

export interface Probe {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

const LAT = 39.74;
const LON = -104.99;

export const PROBES: Probe[] = [
  {
    name: "Open-Meteo forecast",
    url: `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m`,
  },
  {
    name: "Open-Meteo air quality",
    url: `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&current=us_aqi`,
  },
  {
    name: "Open-Meteo geocoding",
    url: "https://geocoding-api.open-meteo.com/v1/search?name=Denver&count=1",
  },
  { name: "NWS alerts", url: `https://api.weather.gov/alerts/active?point=${LAT},${LON}` },
  { name: "ipapi.co", url: "https://ipapi.co/json/" },
  { name: "ipwho.is", url: "https://ipwho.is/" },
  { name: "GeoJS", url: "https://get.geojs.io/v1/ip/geo.json" },
  { name: "ipinfo.io", url: "https://ipinfo.io/json" },
  {
    name: "Nominatim",
    url: `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${LAT}&lon=${LON}&zoom=10`,
  },
  { name: "Photon", url: `https://photon.komoot.io/reverse?lat=${LAT}&lon=${LON}&limit=1` },
  {
    name: "BigDataCloud",
    url: `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${LAT}&longitude=${LON}&localityLanguage=en`,
  },
  { name: "RainViewer", url: "https://api.rainviewer.com/public/weather-maps.json" },
  {
    name: "IEM NEXRAD",
    url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?SERVICE=WMS&REQUEST=GetCapabilities",
  },
  { name: "NHC storms", url: "https://www.nhc.noaa.gov/CurrentStorms.json" },
  {
    name: "GDACS",
    url: "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC",
  },
  {
    name: "USGS quakes",
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
  },
  {
    name: "NIFC fires",
    url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=1%3D0&f=json",
  },
  {
    name: "NASA FIRMS",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv",
  },
  {
    name: "NOAA SWPC",
    url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  },
];

export interface ProbeResult {
  name: string;
  host: string;
  status?: number;
  ms: number;
  error?: string;
}

/** Time to response headers; the body is cancelled so big feeds don't download. */
export async function probe(
  p: Probe,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<ProbeResult> {
  const host = new URL(p.url).host;
  const t0 = performance.now();
  try {
    const res = await fetchImpl(p.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, */*", ...p.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.round(performance.now() - t0);
    await res.body?.cancel().catch(() => {});
    return { name: p.name, host, status: res.status, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const e = err as Error;
    return { name: p.name, host, ms, error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

export const COLOR_NAMES: Record<ColorLevel, string> = {
  0: "none",
  1: "16 colors",
  2: "256 colors",
  3: "truecolor",
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Glyph families the renderers rely on, so users can see what their font draws. */
export function testPattern(caps: Capabilities): string[] {
  const lvl = caps.color;
  const gradient = Array.from({ length: 24 }, (_, i) =>
    paint("█", temperatureScale(-20 + (i / 23) * 60), lvl),
  ).join("");
  const halfBlocks = Array.from({ length: 12 }, (_, i) =>
    paint("▀", hex("#7dd3fc"), lvl, temperatureScale(-10 + i * 4)),
  ).join("");
  return [
    `braille     ⠁⠃⠇⡇⣇⣧⣷⣿ ⣀⣤⣶⣿ ⠉⠛⠿⣿`,
    `blocks      ▁▂▃▄▅▆▇█ ▀▄▌▐ ░▒▓ ${halfBlocks}`,
    `box         ┌─┬─┐ │ ├─┼─┤ ╭─╮ ━ ┃`,
    `symbols     ☀ ☾ ☁ ⛅ ☂ ❄ ⚡ ≋ ● ◐ ◑ ○ ▲ ◆ ↑ ↗ → ↘ ↓ ↙ ← ↖`,
    `emoji       ☀️ 🌤 🌧 ⛈ 🌨 🌪 🌀 🔥 🌋 🌙`,
    `color       ${gradient}`,
  ];
}

export interface DoctorInput {
  caps: Capabilities;
  env: Record<string, string | undefined>;
  cache: DiskCache;
  configPath: string;
  version: string;
  probes?: Probe[];
  fetchImpl?: typeof fetch;
}

export async function runDoctor(input: DoctorInput): Promise<string> {
  const { caps, env } = input;
  const lvl = caps.color;
  const ok = (s: string) => paint(s, hex("#69f0ae"), lvl);
  const warn = (s: string) => paint(s, hex("#ffb74d"), lvl);
  const bad = (s: string) => paint(s, hex("#ff5252"), lvl);
  const dim = (s: string) => paint(s, hex("#7a8794"), lvl);
  const head = (s: string) => paint(s, hex("#7dd3fc"), lvl);
  const row = (k: string, v: string) => `  ${dim(k.padEnd(14))}${v}`;

  const [size, results] = await Promise.all([
    input.cache.size(),
    Promise.all((input.probes ?? PROBES).map((p) => probe(p, input.fetchImpl))),
  ]);

  const out: string[] = [];
  out.push("", head(`weather-outlook ${input.version} doctor`), "");
  out.push(head("Terminal"));
  out.push(
    row(
      "terminal",
      [env.TERM_PROGRAM, env.TERM, env.WT_SESSION ? "Windows Terminal" : undefined]
        .filter(Boolean)
        .join(" · ") || "unknown",
    ),
  );
  out.push(row("colors", `${COLOR_NAMES[caps.color]}${env.NO_COLOR ? dim(" (NO_COLOR)") : ""}`));
  out.push(row("unicode", caps.unicode ? ok("yes") : warn("no (ASCII fallbacks)")));
  out.push(row("images", `${caps.images} ${dim("(guessed from env; the dashboard probes)")}`));
  out.push(row("size", `${caps.columns}×${caps.rows}${caps.isTTY ? "" : dim(" (not a TTY)")}`));
  out.push(row("motion", caps.motion ? "on" : "reduced"));
  out.push("");
  out.push(head("Files"));
  out.push(
    row(
      "config",
      `${input.configPath}${existsSync(input.configPath) ? "" : dim(" (not created)")}`,
    ),
  );
  out.push(row("cache", input.cache.dir));
  out.push(
    row(
      "cache size",
      `${fmtBytes(size.bytes)} in ${size.entries} entries ${dim(`(cap ${fmtBytes(input.cache.maxBytes)})`)}`,
    ),
  );
  out.push("");
  out.push(head("Providers"));
  const nameW = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    const latency = `${r.ms} ms`.padStart(8);
    let status: string;
    if (r.error) status = bad(`✗ ${r.error}`);
    else if (r.status !== undefined && r.status < 400) status = ok(`✓ ${r.status}`);
    else status = bad(`✗ ${r.status}`);
    const lat: RGB = r.ms < 500 ? hex("#69f0ae") : r.ms < 1500 ? hex("#ffb74d") : hex("#ff5252");
    out.push(
      `  ${r.name.padEnd(nameW)}${padEnd(status, 10)}  ${paint(latency, lat, lvl)}  ${dim(r.host)}`,
    );
  }
  const failed = results.filter((r) => r.error || (r.status ?? 0) >= 400).length;
  out.push(
    "",
    failed
      ? warn(`  ${failed} of ${results.length} providers unreachable.`)
      : ok(`  All ${results.length} providers reachable.`),
  );
  out.push("");
  out.push(head("Glyphs"), dim("  Anything drawn as boxes or ? is missing from your font."));
  for (const line of testPattern(caps)) out.push(`  ${line}`);
  out.push("");
  return out.join("\n");
}
