#!/usr/bin/env bun
import { type CommandDef, defineCommand, runCommand, showUsage } from "citty";
import envPaths from "env-paths";
import pkg from "../package.json" with { type: "json" };
import { DiskCache } from "./cache/disk-cache.ts";
import { detectCapabilities } from "./capabilities.ts";
import {
  addLocation,
  type Config,
  configPath,
  configUnits,
  findLocation,
  getSetting,
  loadConfig,
  normalizeSetting,
  SETTINGS,
  saveConfig,
  setSetting,
  withEnv,
} from "./config.ts";
import type { Location } from "./domain/types.ts";
import { fetchHazards } from "./hazards.ts";
import { describePlace, type ResolveOptions, resolveLocation } from "./providers/location.ts";
import { stripAnsi } from "./render/ansi.ts";
import { formatNeeds, renderFormat } from "./render/format.ts";
import { renderHazardsOneShot } from "./render/hazards-oneshot.ts";
import { renderCompact, renderOneShot } from "./render/oneshot.ts";
import { defaultUnits, setUnitOverrides, type UnitOverrides } from "./render/units.ts";
import { buildReport, fieldsNeeds, parseFields, projectReport } from "./report.ts";
import { createHttpClient, type HttpClientOptions } from "./util/http.ts";

// Exit quietly when piped into something like `head` that closes early.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const paths = envPaths("weather-outlook", { suffix: "" });
const makeHttp = (opts: HttpClientOptions = {}) =>
  createHttpClient(new DiskCache(paths.cache), fetch, opts);

const colorArg = {
  type: "boolean",
  default: true,
  description: "colored output",
  negativeDescription: "disable colors (also respects NO_COLOR)",
} as const;

/** Config file + WEATHER_OUTLOOK_* env overrides. */
const effectiveConfig = async () => withEnv(await loadConfig());

/** The numbered picker only makes sense when a human is at the keyboard. */
function interactivePicker(enabled: boolean): ResolveOptions["pick"] {
  if (!enabled || !process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return async (q, choices) => (await import("./util/prompt.ts")).pickLocation(q, choices);
}

/** "@home" → saved location; anything else → geocode / coords / IP. */
async function locate(
  http: ReturnType<typeof makeHttp>,
  cfg: Config,
  query: string,
  opts: ResolveOptions,
): Promise<Location> {
  if (query.startsWith("@")) {
    const saved = findLocation(cfg, query);
    if (!saved) {
      const names = cfg.locations.map((l) => `@${l.name}`).join(", ");
      throw new Error(
        `No saved location "${query}".${names ? ` Saved: ${names}.` : ""} Add one with: weather-outlook add ${query.slice(1) || "home"} <place>`,
      );
    }
    if (saved.location) return { ...saved.location, source: "config" };
    return { ...(await resolveLocation(http, saved.query, opts)), source: "config" };
  }
  return resolveLocation(http, query, opts);
}

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
    action: { type: "positional", description: "clear | path | prune", required: true },
  },
  async run({ args }) {
    const store = new DiskCache(paths.cache);
    if (args.action === "clear") {
      await store.clear();
      console.log("Cache cleared.");
    } else if (args.action === "path") {
      console.log(paths.cache);
    } else if (args.action === "prune") {
      const removed = await store.prune();
      console.log(`Removed ${removed} least-recently-used entries.`);
    } else {
      throw new Error(`Unknown cache action "${args.action}"`);
    }
  },
});

/** Hide all but the last 4 characters of API keys when printing config. */
function redactKeys(value: unknown, path: string): unknown {
  const mask = (s: string) => (s.length > 4 ? `${"*".repeat(s.length - 4)}${s.slice(-4)}` : "****");
  if (path.startsWith("keys.") && typeof value === "string") return mask(value);
  if (path === "keys" || path === "") {
    const src = (path === "" ? (value as Config).keys : value) as Record<string, string>;
    const keys = Object.fromEntries(Object.entries(src ?? {}).map(([k, v]) => [k, mask(v)]));
    return path === "" ? { ...(value as Config), keys } : keys;
  }
  return value;
}

const config = defineCommand({
  meta: {
    name: "config",
    description: `read or change settings (${SETTINGS.join(", ")}, keys.<NAME>)`,
  },
  args: {
    action: { type: "positional", description: "get | set | unset | path", required: true },
    key: { type: "positional", required: false, description: "setting name" },
    value: { type: "positional", required: false, description: "new value" },
  },
  async run({ args }) {
    const file = configPath();
    if (args.action === "path") {
      console.log(file);
      return;
    }
    if (args.action === "get") {
      // `get` shows the effective value, env overrides included.
      const cfg = await effectiveConfig();
      const key = args.key ?? "";
      const value = redactKeys(key ? getSetting(cfg, key) : cfg, key);
      if (value === undefined) process.exitCode = 1;
      else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      return;
    }
    if (args.action === "set" || args.action === "unset") {
      if (!args.key) throw new Error(`Usage: weather-outlook config ${args.action} <key>`);
      const value = args.action === "unset" ? "" : [args.value, ...args._.slice(3)].join(" ");
      if (args.action === "set" && !value.trim()) {
        throw new Error("Usage: weather-outlook config set <key> <value>");
      }
      // Write the file's own contents, not env overrides.
      const next = setSetting(await loadConfig(file), args.key, value);
      await saveConfig(next, file);
      const shown = redactKeys(getSetting(next, args.key), args.key);
      console.log(args.action === "set" ? `${args.key} = ${shown}` : `${args.key} unset`);
      return;
    }
    throw new Error(`Unknown config action "${args.action}". Use get, set, unset or path.`);
  },
});

const add = defineCommand({
  meta: { name: "add", description: "save a location: weather-outlook add home Denver" },
  args: {
    name: { type: "positional", required: true, description: "short name, used as @name" },
    query: { type: "positional", required: true, description: 'place name or "lat,lon"' },
  },
  async run({ args }) {
    const query = args._.slice(1).join(" ");
    const name = args.name.replace(/^@/, "");
    if (!/^[\w-]+$/.test(name)) throw new Error("Names may only use letters, digits, - and _");
    const file = configPath();
    const cfg = await loadConfig(file);
    const location = await resolveLocation(makeHttp(), query, { pick: interactivePicker(true) });
    await saveConfig(addLocation(cfg, { name, query, location }), file);
    console.log(`Saved @${name} → ${describePlace(location)}`);
  },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "diagnose terminal support and provider connectivity" },
  args: { color: colorArg },
  async run({ args }) {
    const { runDoctor } = await import("./doctor.ts");
    const caps = detectCapabilities({ color: args.color ? undefined : false });
    process.stdout.write(
      await runDoctor({
        caps,
        env: process.env,
        cache: new DiskCache(paths.cache),
        configPath: configPath(),
        version: pkg.version,
      }),
    );
  },
});

const subCommands: Record<string, CommandDef<never>> = {
  hazards: hazards as CommandDef<never>,
  planet: hazards as CommandDef<never>,
  cache: cache as CommandDef<never>,
  config: config as CommandDef<never>,
  add: add as CommandDef<never>,
  doctor: doctor as CommandDef<never>,
};

/** CLI flags beat config/env for each measure. */
function unitOverrides(
  cfg: Config,
  args: { temp?: string; wind?: string; precip?: string; hour12?: boolean; hour24?: boolean },
): UnitOverrides {
  // Run flags through the config schema so typos get the same error messages.
  let merged = cfg;
  for (const key of ["temp", "wind", "precip"] as const) {
    const v = args[key];
    if (v) merged = setSetting(merged, key, normalizeSetting(key, v));
  }
  const { overrides } = configUnits(merged);
  if (args.hour12) overrides.hour12 = true;
  else if (args.hour24) overrides.hour12 = false;
  return overrides;
}

const main = defineCommand({
  meta: { name: "weather-outlook", version: pkg.version, description: pkg.description },
  args: {
    location: {
      type: "positional",
      required: false,
      description: 'place name, "lat,lon", @saved, or omit to use your IP location',
    },
    units: {
      type: "enum",
      options: ["metric", "imperial"],
      alias: "u",
      description: "units (default: config, else based on location)",
    },
    temp: { type: "string", description: "temperature unit: C | F" },
    wind: { type: "string", description: "wind unit: kmh | mph | ms | kn | bft (Beaufort)" },
    precip: { type: "string", description: "precipitation unit: mm | in" },
    hour12: { type: "boolean", description: "12-hour clock (default: from locale)" },
    hour24: { type: "boolean", description: "24-hour clock" },
    once: {
      type: "boolean",
      alias: "1",
      description: "print a one-shot summary and exit (default when not a TTY)",
    },
    compact: { type: "boolean", alias: "c", description: "five-line card for shell rc files" },
    format: {
      type: "string",
      alias: "f",
      description: "one-liner like '%c %t %w' (tokens: %c %C %t %f %h %w %p %a %m %S %s %A %l)",
    },
    json: { type: "boolean", alias: "j", description: "print the full report as JSON and exit" },
    fields: {
      type: "string",
      description: "with --json: only these parts, e.g. current,alerts",
    },
    motion: {
      type: "boolean",
      default: true,
      description: "animations",
      negativeDescription: "disable animations (also respects WEATHER_OUTLOOK_REDUCE_MOTION)",
    },
    simulate: {
      type: "enum",
      options: [
        "rain",
        "drizzle",
        "snow",
        "sleet",
        "storm",
        "hail",
        "fog",
        "clear",
        "partly",
        "cloudy",
      ],
      description: "force the sky animation",
    },
    theme: { type: "string", description: "dashboard theme (default: config)" },
    pick: {
      type: "boolean",
      default: true,
      description: "ask which place you meant when a name is ambiguous",
      negativeDescription: "always take the best match",
    },
    color: colorArg,
    refresh: { type: "boolean", alias: "r", description: "bypass the cache" },
  },
  // Listed for --help only; dispatch happens below so place names never collide with commands.
  subCommands: { hazards, cache, config, add, doctor },
  async run({ args }) {
    const cfg = await effectiveConfig();
    setUnitOverrides(unitOverrides(cfg, args));
    const caps = detectCapabilities({
      color: args.color ? undefined : false,
      motion: args.motion ? undefined : false,
    });
    const scripted = Boolean(args.json || args.format || args.compact || args.once);
    const dashboard = !scripted && caps.isTTY && Boolean(process.stdin.isTTY);
    // The dashboard and status-bar one-liners paint from cache at once and refresh behind it.
    const http = makeHttp({ swr: (dashboard || Boolean(args.format)) && !args.refresh });
    // citty only keeps the first positional; multi-word places ("New York") arrive in args._.
    const location = await locate(http, cfg, args._.join(" "), {
      pick: interactivePicker(args.pick && !args.format),
    });
    const units = args.units ?? cfg.units ?? defaultUnits(location.countryCode);

    if (args.format !== undefined) {
      const report = await buildReport(http, location, units, {
        refresh: args.refresh,
        include: formatNeeds(args.format),
      });
      process.stdout.write(`${renderFormat(args.format, report)}\n`);
      // Let background revalidation finish so the next call is fresh.
      await http.settled?.();
      return;
    }
    if (args.json) {
      const fields = args.fields ? parseFields(args.fields) : undefined;
      const report = await buildReport(http, location, units, {
        refresh: args.refresh,
        include: fields ? fieldsNeeds(fields) : undefined,
      });
      const out = fields ? projectReport(report, fields) : report;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    if (dashboard) {
      // Lazy-load the TUI so one-shot and JSON modes never pay for it.
      const { runDashboard } = await import("./tui/index.tsx");
      const dashOpts = {
        http,
        location,
        units,
        motion: caps.motion,
        simulate: args.simulate,
        theme: args.theme ?? cfg.theme,
        savedLocations: cfg.locations.flatMap((l) =>
          l.location ? [{ ...l.location, source: "config" as const }] : [],
        ),
      };
      await runDashboard(dashOpts as Parameters<typeof runDashboard>[0]);
      return;
    }
    const report = await buildReport(http, location, units, { refresh: args.refresh });
    if (args.compact) process.stdout.write(`${renderCompact(report, caps)}\n`);
    else process.stdout.write(`${renderOneShot(report, caps)}\n`);
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
