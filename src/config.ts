import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import envPaths from "env-paths";
import { z } from "zod";
import { Location } from "./domain/types.ts";
import {
  PRECIP_UNITS,
  type PrecipUnit,
  TEMP_UNITS,
  type TempUnit,
  type UnitOverrides,
  type Units,
  WIND_UNITS,
  type WindUnit,
} from "./render/units.ts";

/**
 * User config at ~/.config/weather-outlook/config.json (XDG on every Unix,
 * env-paths' AppData location on Windows). Unknown keys are preserved so a
 * newer version's settings survive a round-trip through an older one.
 */

export const SavedLocation = z.object({
  name: z.string().min(1),
  query: z.string(),
  /** Resolved once at `add` time so `@name` never needs a geocode round-trip. */
  location: Location.optional(),
});
export type SavedLocation = z.infer<typeof SavedLocation>;

export const Config = z.looseObject({
  units: z.enum(["metric", "imperial"]).optional(),
  temp: z.enum(TEMP_UNITS as [TempUnit, ...TempUnit[]]).optional(),
  wind: z.enum(WIND_UNITS as [WindUnit, ...WindUnit[]]).optional(),
  precip: z.enum(PRECIP_UNITS as [PrecipUnit, ...PrecipUnit[]]).optional(),
  clock: z.enum(["12h", "24h"]).optional(),
  /** Dashboard theme name; the dashboard decides which names exist. */
  theme: z.string().optional(),
  /** Primary forecast provider id (open-meteo, openweathermap, tomorrow, …). */
  provider: z.string().optional(),
  locations: z.array(SavedLocation).default([]),
  /** Provider API keys, e.g. { "OWM_API_KEY": "..." }. Env vars of the same name win. */
  keys: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof Config>;

/** Scalar settings that `config get/set` and WEATHER_OUTLOOK_* env vars understand. */
export const SETTINGS = ["units", "temp", "wind", "precip", "clock", "theme", "provider"] as const;
export type Setting = (typeof SETTINGS)[number];

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env, platform = process.platform): string {
  if (env.WEATHER_OUTLOOK_CONFIG) return env.WEATHER_OUTLOOK_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "weather-outlook", "config.json");
  if (platform === "win32") {
    return join(envPaths("weather-outlook", { suffix: "" }).config, "config.json");
  }
  return join(homedir(), ".config", "weather-outlook", "config.json");
}

export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return Config.parse({});
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: ${issue?.path.join(".") || "config"}: ${issue?.message}`);
  }
  return parsed.data;
}

export async function saveConfig(cfg: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(Config.parse(cfg), null, 2)}\n`);
  await rename(tmp, path);
}

/** Apply WEATHER_OUTLOOK_UNITS, _TEMP, _WIND, _PRECIP, _CLOCK, _THEME, _PROVIDER on top of the file. */
export function withEnv(cfg: Config, env: Env = process.env): Config {
  const out: Record<string, unknown> = { ...cfg };
  for (const key of SETTINGS) {
    const v = env[`WEATHER_OUTLOOK_${key.toUpperCase()}`];
    if (v) out[key] = normalizeSetting(key, v);
  }
  const parsed = Config.safeParse(out);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `WEATHER_OUTLOOK_${String(issue?.path[0] ?? "").toUpperCase()}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

/** A provider key: the environment variable wins over the config file. */
export function getKey(cfg: Config, name: string, env: Env = process.env): string | undefined {
  return env[name] || cfg.keys[name] || undefined;
}

/** Read a dotted path (`units`, `keys.OWM_API_KEY`, `locations`). */
export function getSetting(cfg: Config, path: string): unknown {
  let cur: unknown = cfg;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const ALIASES: Partial<Record<Setting, Record<string, string>>> = {
  units: { si: "metric", us: "imperial" },
  temp: { c: "C", f: "F", celsius: "C", fahrenheit: "F" },
  wind: {
    kph: "kmh",
    "km/h": "kmh",
    "m/s": "ms",
    knots: "kn",
    knot: "kn",
    kt: "kn",
    kts: "kn",
    beaufort: "bft",
  },
  precip: { inch: "in", inches: "in", millimeters: "mm" },
  clock: { "12": "12h", "24": "24h" },
};

/** Accept friendly spellings: `--temp c`, `--wind knots`, `--precip inches`. */
export function normalizeSetting(key: Setting, value: string): string {
  const v = value.trim();
  return ALIASES[key]?.[v.toLowerCase()] ?? (key === "temp" ? v.toUpperCase() : v);
}

/** Set a scalar setting or `keys.NAME`, validating against the schema. Empty value unsets. */
export function setSetting(cfg: Config, path: string, rawValue: string): Config {
  const value = (SETTINGS as readonly string[]).includes(path)
    ? normalizeSetting(path as Setting, rawValue)
    : rawValue;
  const next: Record<string, unknown> = { ...cfg, keys: { ...cfg.keys } };
  const [head, sub, ...extra] = path.split(".");
  if (head === "keys" && sub && !extra.length) {
    const keys = next.keys as Record<string, string>;
    if (value) keys[sub] = value;
    else delete keys[sub];
  } else if ((SETTINGS as readonly string[]).includes(path)) {
    if (value) next[path] = value;
    else delete next[path];
  } else {
    throw new Error(`Unknown setting "${path}". Settable: ${SETTINGS.join(", ")}, keys.<NAME>`);
  }
  const parsed = Config.safeParse(next);
  if (!parsed.success) {
    throw new Error(`Invalid value for ${path}: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

/** Add or replace a saved location (names are case-insensitive). */
export function addLocation(cfg: Config, saved: SavedLocation): Config {
  const name = saved.name.replace(/^@/, "");
  const rest = cfg.locations.filter((l) => l.name.toLowerCase() !== name.toLowerCase());
  return { ...cfg, locations: [...rest, { ...saved, name }] };
}

export function findLocation(cfg: Config, name: string): SavedLocation | undefined {
  const n = name.replace(/^@/, "").toLowerCase();
  return cfg.locations.find((l) => l.name.toLowerCase() === n);
}

/** The unit system and per-measure overrides the config asks for. */
export function configUnits(cfg: Config): { units?: Units; overrides: UnitOverrides } {
  return {
    units: cfg.units,
    overrides: {
      temp: cfg.temp,
      wind: cfg.wind,
      precip: cfg.precip,
      hour12: cfg.clock === undefined ? undefined : cfg.clock === "12h",
    },
  };
}
