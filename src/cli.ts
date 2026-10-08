#!/usr/bin/env bun
import { Command } from "commander";
import envPaths from "env-paths";
import pkg from "../package.json" with { type: "json" };
import { DiskCache } from "./cache/disk-cache.ts";
import { detectCapabilities } from "./capabilities.ts";
import { fetchHazards } from "./hazards.ts";
import { resolveLocation } from "./providers/location.ts";
import { renderHazardsOneShot } from "./render/hazards-oneshot.ts";
import { renderOneShot } from "./render/oneshot.ts";
import { defaultUnits, type Units } from "./render/units.ts";
import { buildReport } from "./report.ts";
import { createHttpClient } from "./util/http.ts";

// Exit quietly when piped into something like `head` that closes early.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const paths = envPaths("weather-outlook", { suffix: "" });

interface GlobalOpts {
  units?: Units;
  json?: boolean;
  once?: boolean;
  color?: boolean;
  motion?: boolean;
  refresh?: boolean;
  simulate?: string;
}

function makeHttp() {
  return createHttpClient(new DiskCache(paths.cache));
}

const program = new Command()
  .name("weather-outlook")
  .description(pkg.description)
  .version(pkg.version)
  .argument("[location...]", 'place name, "lat,lon", or omit to use your IP location')
  .option("-u, --units <units>", "metric or imperial (default: based on location)")
  .option("-1, --once", "print a one-shot summary and exit (default when not a TTY)")
  .option("-j, --json", "print the full report as JSON and exit")
  .option("--no-motion", "disable animations (also respects WEATHER_OUTLOOK_REDUCE_MOTION)")
  .option("--simulate <condition>", "force the sky animation: rain | snow | storm | fog | clear")
  .option("--no-color", "disable colors (also respects NO_COLOR)")
  .option("-r, --refresh", "bypass the cache")
  .action(async (words: string[], opts: GlobalOpts) => {
    const http = makeHttp();
    const location = await resolveLocation(http, words.join(" "));
    const units = opts.units ?? defaultUnits(location.countryCode);
    if (units !== "metric" && units !== "imperial") {
      throw new Error(`--units must be "metric" or "imperial"`);
    }
    if (opts.json) {
      const report = await buildReport(http, location, units, { refresh: opts.refresh });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const caps = detectCapabilities({
      color: opts.color === false ? false : undefined,
      motion: opts.motion === false ? false : undefined,
    });
    if (!opts.once && caps.isTTY && process.stdin.isTTY) {
      // Lazy-load the TUI so one-shot and JSON modes never pay for it.
      const { runDashboard } = await import("./tui/index.tsx");
      await runDashboard({ http, location, units, motion: caps.motion, simulate: opts.simulate });
      return;
    }
    const report = await buildReport(http, location, units, { refresh: opts.refresh });
    process.stdout.write(`${renderOneShot(report, caps)}\n`);
  });

program
  .command("hazards")
  .alias("planet")
  .description("world map of hurricanes, wildfires, earthquakes and space weather")
  .option("-j, --json", "print hazards as JSON")
  .option("--no-hotspots", "skip the 1.5 MB satellite hotspot download")
  .action(async (opts: { json?: boolean; hotspots?: boolean }) => {
    const hazards = await fetchHazards(makeHttp(), { hotspots: opts.hotspots });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(hazards, null, 2)}\n`);
      return;
    }
    const color = program.opts<GlobalOpts>().color;
    process.stdout.write(
      renderHazardsOneShot(
        hazards,
        detectCapabilities({ color: color === false ? false : undefined }),
      ),
    );
  });

program
  .command("cache")
  .description("manage the response cache")
  .argument("<action>", "clear | path")
  .action(async (action: string) => {
    const cache = new DiskCache(paths.cache);
    if (action === "clear") {
      await cache.clear();
      console.log("Cache cleared.");
    } else if (action === "path") {
      console.log(paths.cache);
    } else {
      throw new Error(`Unknown cache action "${action}"`);
    }
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`weather-outlook: ${msg}\n`);
  process.exit(1);
});
