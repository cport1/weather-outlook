#!/usr/bin/env bun
import { type CommandDef, defineCommand, runCommand, showUsage } from "citty";
import envPaths from "env-paths";
import pkg from "../package.json" with { type: "json" };
import { DiskCache } from "./cache/disk-cache.ts";
import { detectCapabilities } from "./capabilities.ts";
import { fetchHazards } from "./hazards.ts";
import { resolveLocation } from "./providers/location.ts";
import { stripAnsi } from "./render/ansi.ts";
import { renderHazardsOneShot } from "./render/hazards-oneshot.ts";
import { renderOneShot } from "./render/oneshot.ts";
import { defaultUnits } from "./render/units.ts";
import { buildReport } from "./report.ts";
import { createHttpClient } from "./util/http.ts";

// Exit quietly when piped into something like `head` that closes early.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const paths = envPaths("weather-outlook", { suffix: "" });
const makeHttp = () => createHttpClient(new DiskCache(paths.cache));

const colorArg = {
  type: "boolean",
  default: true,
  description: "colored output",
  negativeDescription: "disable colors (also respects NO_COLOR)",
} as const;

const hazards = defineCommand({
  meta: {
    name: "hazards",
    alias: "planet",
    description: "world map of hurricanes, wildfires, earthquakes and space weather",
  },
  args: {
    json: { type: "boolean", alias: "j", description: "print hazards as JSON" },
    hotspots: {
      type: "boolean",
      default: true,
      description: "include satellite fire hotspots",
      negativeDescription: "skip the 1.5 MB satellite hotspot download",
    },
    color: colorArg,
  },
  async run({ args }) {
    const result = await fetchHazards(makeHttp(), { hotspots: args.hotspots });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const caps = detectCapabilities({ color: args.color ? undefined : false });
    process.stdout.write(renderHazardsOneShot(result, caps));
  },
});

const cache = defineCommand({
  meta: { name: "cache", description: "manage the response cache" },
  args: {
    action: { type: "positional", description: "clear | path", required: true },
  },
  async run({ args }) {
    const store = new DiskCache(paths.cache);
    if (args.action === "clear") {
      await store.clear();
      console.log("Cache cleared.");
    } else if (args.action === "path") {
      console.log(paths.cache);
    } else {
      throw new Error(`Unknown cache action "${args.action}"`);
    }
  },
});

const subCommands: Record<string, CommandDef<never>> = {
  hazards: hazards as CommandDef<never>,
  planet: hazards as CommandDef<never>,
  cache: cache as CommandDef<never>,
};

const main = defineCommand({
  meta: { name: "weather-outlook", version: pkg.version, description: pkg.description },
  args: {
    location: {
      type: "positional",
      required: false,
      description: 'place name, "lat,lon", or omit to use your IP location',
    },
    units: {
      type: "enum",
      options: ["metric", "imperial"],
      alias: "u",
      description: "units (default: based on location)",
    },
    once: {
      type: "boolean",
      alias: "1",
      description: "print a one-shot summary and exit (default when not a TTY)",
    },
    json: { type: "boolean", alias: "j", description: "print the full report as JSON and exit" },
    motion: {
      type: "boolean",
      default: true,
      description: "animations",
      negativeDescription: "disable animations (also respects WEATHER_OUTLOOK_REDUCE_MOTION)",
    },
    simulate: {
      type: "enum",
      options: ["rain", "snow", "storm", "fog", "clear", "cloudy"],
      description: "force the sky animation",
    },
    color: colorArg,
    refresh: { type: "boolean", alias: "r", description: "bypass the cache" },
  },
  // Listed for --help only; dispatch happens below so place names never collide with commands.
  subCommands: { hazards, cache },
  async run({ args }) {
    const http = makeHttp();
    // citty only keeps the first positional; multi-word places ("New York") arrive in args._.
    const location = await resolveLocation(http, args._.join(" "));
    const units = args.units ?? defaultUnits(location.countryCode);
    if (args.json) {
      const report = await buildReport(http, location, units, { refresh: args.refresh });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const caps = detectCapabilities({
      color: args.color ? undefined : false,
      motion: args.motion ? undefined : false,
    });
    if (!args.once && caps.isTTY && process.stdin.isTTY) {
      // Lazy-load the TUI so one-shot and JSON modes never pay for it.
      const { runDashboard } = await import("./tui/index.tsx");
      await runDashboard({ http, location, units, motion: caps.motion, simulate: args.simulate });
      return;
    }
    const report = await buildReport(http, location, units, { refresh: args.refresh });
    process.stdout.write(`${renderOneShot(report, caps)}\n`);
  },
});

const argv = process.argv.slice(2);
const [first, ...rest] = argv;
const sub = first ? subCommands[first] : undefined;
// The root command has no subCommands at runtime, so citty never treats "Denver" as one.
const { subCommands: _, ...root } = main;
const cmd = sub ?? (root as CommandDef<never>);
const rawArgs = sub ? rest : argv;

try {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    await showUsage(sub ?? (main as CommandDef<never>));
  } else if (!sub && (argv.includes("--version") || argv.includes("-v"))) {
    console.log(pkg.version);
  } else {
    await runCommand(cmd, { rawArgs });
  }
} catch (err) {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = process.stderr.isTTY ? raw : stripAnsi(raw);
  process.stderr.write(`weather-outlook: ${msg}\n`);
  process.exit(1);
}
