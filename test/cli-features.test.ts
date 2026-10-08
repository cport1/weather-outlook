import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCache } from "../src/cache/disk-cache.ts";
import { type Capabilities, detectUnicode } from "../src/capabilities.ts";
import {
  addLocation,
  Config,
  configPath,
  configUnits,
  findLocation,
  getKey,
  getSetting,
  loadConfig,
  saveConfig,
  setSetting,
  withEnv,
} from "../src/config.ts";
import { probe, runDoctor } from "../src/doctor.ts";
import type { Report } from "../src/domain/types.ts";
import { resolveLocation } from "../src/providers/location.ts";
import { stripAnsi, truncateAnsi, visibleWidth } from "../src/render/ansi.ts";
import { formatNeeds, renderFormat } from "../src/render/format.ts";
import { renderCompact, renderOneShot } from "../src/render/oneshot.ts";
import {
  beaufort,
  clockTime,
  localeHour12,
  precip,
  setUnitOverrides,
  speed,
  temp,
} from "../src/render/units.ts";
import { buildReport, fieldsNeeds, parseFields, projectReport } from "../src/report.ts";
import { createHttpClient, createRateLimiter, expiresTtl } from "../src/util/http.ts";
import { fixtureHttp } from "./fixtures/http.ts";

afterEach(() => setUnitOverrides({}));

const caps = (columns: number, color: 0 | 3 = 0): Capabilities => ({
  isTTY: false,
  color,
  unicode: true,
  motion: false,
  images: "blocks",
  columns,
  rows: 30,
});

async function fixtureReport(units: "metric" | "imperial" = "imperial"): Promise<Report> {
  const { http } = fixtureHttp();
  const loc = await resolveLocation(http, "39.7392,-104.9903");
  return buildReport(http, loc, units);
}

describe("units", () => {
  test("per-measure overrides beat the system", () => {
    setUnitOverrides({ temp: "C", wind: "kn", precip: "mm" });
    expect(temp(0, "imperial")).toBe("0°C");
    expect(speed(18.52, "imperial")).toBe("10 kn");
    expect(precip(25.4, "imperial")).toBe("25.4 mm");
  });
  test("wind units", () => {
    setUnitOverrides({ wind: "ms" });
    expect(speed(36, "metric")).toBe("10 m/s");
    expect(speed(18, "metric")).toBe("5.0 m/s");
    setUnitOverrides({ wind: "bft" });
    expect(speed(30, "metric")).toBe("5 Bft");
  });
  test("Beaufort scale boundaries", () => {
    expect(beaufort(0)).toBe(0);
    expect(beaufort(5)).toBe(1);
    expect(beaufort(40)).toBe(6);
    expect(beaufort(117)).toBe(11);
    expect(beaufort(118)).toBe(12);
    expect(beaufort(250)).toBe(12);
  });
  test("clock follows locale unless overridden", () => {
    expect(localeHour12({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(localeHour12({ LANG: "de_DE.UTF-8" })).toBe(false);
    expect(localeHour12({ LC_ALL: "en_GB.UTF-8", LANG: "en_US.UTF-8" })).toBe(false);
    const t = "2026-10-07T18:05:00Z";
    setUnitOverrides({ hour12: false });
    expect(clockTime(t, "UTC")).toBe("18:05");
    expect(clockTime(t, "UTC", false)).toBe("18:05");
    setUnitOverrides({ hour12: true });
    expect(clockTime(t, "UTC")).toBe("6:05 PM");
    expect(clockTime(t, "UTC", false)).toBe("6 PM");
  });
});

describe("--format", () => {
  test("tokens render from a report", async () => {
    const report = await fixtureReport();
    const now = new Date(report.forecast?.current.time ?? 0).getTime();
    const out = renderFormat("%l|%t|%f|%h|%w|%p|%a|%A|%C|%c|%%|%z", report, now);
    const [l, t, f, h, w, p, a, A, C, c, pct, unknown] = out.split("|");
    expect(l).toBe("Denver");
    expect(t).toMatch(/^-?\d+°F$/);
    expect(f).toMatch(/^-?\d+°F$/);
    expect(h).toMatch(/^\d+%$/);
    expect(w).toMatch(/^[↓↙←↖↑↗→↘·]\d+mph$/);
    expect(p).toMatch(/^\d+%$/);
    expect(a).toMatch(/^\d+$/);
    expect(A).toBe(String(report.alerts.length));
    expect(C?.length).toBeGreaterThan(2);
    expect(c?.length).toBe(1);
    expect(pct).toBe("%");
    expect(unknown).toBe("%z");
  });
  test("only fetch what the format needs", () => {
    expect(formatNeeds("%l %m %S")).toEqual({ forecast: false, airQuality: false, alerts: false });
    expect(formatNeeds("%t")).toEqual({ forecast: true, airQuality: false, alerts: false });
    expect(formatNeeds("%a %A")).toEqual({ forecast: false, airQuality: true, alerts: true });
  });
  test("location-only formats make no forecast requests", async () => {
    const { http, requests } = fixtureHttp();
    const loc = { name: "Denver", lat: 39.74, lon: -104.99, source: "coords" as const };
    const report = await buildReport(http, loc, "metric", { include: formatNeeds("%l %m %S") });
    expect(requests).toEqual([]);
    expect(renderFormat("%l", report)).toBe("Denver");
  });
});

describe("--fields", () => {
  test("parses names, aliases and rejects unknowns", () => {
    expect(parseFields("current, alerts,aq,current")).toEqual(["current", "alerts", "airQuality"]);
    expect(() => parseFields("current,bogus")).toThrow(/Unknown field "bogus"/);
  });
  test("projects the report and fetches only what is needed", async () => {
    const report = await fixtureReport();
    const out = projectReport(report, parseFields("current,alerts"));
    expect(Object.keys(out)).toEqual([
      "schemaVersion",
      "generatedAt",
      "units",
      "current",
      "alerts",
    ]);
    expect(out.current).toEqual(report.forecast?.current);
    expect(fieldsNeeds(["location"])).toEqual({
      forecast: false,
      airQuality: false,
      alerts: false,
      nowcast: false,
      nws: false,
      models: false,
      marine: false,
      climate: false,
    });
  });
  test("detail sections can be selected and fetch only their sources", async () => {
    expect(parseFields("nws,tides,normals,minutely,models")).toEqual([
      "nws",
      "marine",
      "climate",
      "nowcast",
      "models",
    ]);
    const { http, requests } = fixtureHttp();
    const loc = await resolveLocation(http, "39.7392,-104.9903");
    requests.length = 0;
    const fields = parseFields("nws,climate");
    const report = await buildReport(http, loc, "metric", { include: fieldsNeeds(fields) });
    const hosts = new Set(requests.map((u) => new URL(u).host));
    // Climate needs the forecast to compare against, but nothing else.
    expect([...hosts].sort()).toEqual([
      "api.open-meteo.com",
      "api.weather.gov",
      "archive-api.open-meteo.com",
    ]);
    expect(report.errors).toEqual([]);
    const out = projectReport(report, fields);
    expect(Object.keys(out)).toEqual(["schemaVersion", "generatedAt", "units", "nws", "climate"]);
    expect((out.nws as { periods: unknown[] }).periods.length).toBeGreaterThan(0);
    expect((out.climate as { days: unknown[] }).days.length).toBeGreaterThan(0);
  });
});

describe("one-shot layout", () => {
  test("never exceeds the terminal width", async () => {
    const report = await fixtureReport();
    for (const cols of [40, 50, 60, 69, 80, 120]) {
      for (const line of renderOneShot(report, caps(cols, 3)).split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });
  test("narrow terminals drop the art but keep the essentials", async () => {
    const report = await fixtureReport();
    const narrow = stripAnsi(renderOneShot(report, caps(50)));
    expect(narrow).toContain("Next 24 hours");
    expect(narrow).toContain("10-day outlook");
    expect(narrow).not.toContain("39.74, -104.99");
  });
  test("--compact is a five-line card", async () => {
    const report = await fixtureReport();
    const card = renderCompact(report, caps(80, 3)).split("\n");
    expect(card).toHaveLength(5);
    expect(stripAnsi(card[0] ?? "")).toContain("Denver");
    expect(stripAnsi(card[1] ?? "")).toMatch(/\d+°F/);
    const tiny = renderCompact(report, caps(30)).split("\n");
    for (const line of tiny) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });
  test("truncateAnsi keeps escapes balanced", () => {
    const s = "\x1b[31mhello\x1b[0m world";
    expect(stripAnsi(truncateAnsi(s, 3))).toBe("hel");
    expect(truncateAnsi(s, 3).endsWith("\x1b[0m")).toBe(true);
    expect(truncateAnsi(s, 50)).toBe(s);
  });
});

describe("config", () => {
  test("defaults, round-trip and unknown keys preserved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wo-cfg-"));
    const file = join(dir, "nested", "config.json");
    const empty = await loadConfig(file);
    expect(empty.locations).toEqual([]);
    const cfg = setSetting(Config.parse({ future: { x: 1 } }), "units", "metric") as Config & {
      future?: unknown;
    };
    await saveConfig(cfg, file);
    const back = (await loadConfig(file)) as Config & { future?: unknown };
    expect(back.units).toBe("metric");
    expect(back.future).toEqual({ x: 1 });
  });
  test("invalid files explain themselves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wo-cfg-"));
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ units: "kelvin" }));
    await expect(loadConfig(file)).rejects.toThrow(/units/);
    await writeFile(file, "{nope");
    await expect(loadConfig(file)).rejects.toThrow(/not valid JSON/);
  });
  test("set validates and normalizes friendly spellings", () => {
    let cfg = Config.parse({});
    cfg = setSetting(cfg, "wind", "knots");
    cfg = setSetting(cfg, "temp", "c");
    cfg = setSetting(cfg, "keys.OWM_API_KEY", "abc");
    expect(cfg).toMatchObject({ wind: "kn", temp: "C", keys: { OWM_API_KEY: "abc" } });
    expect(() => setSetting(cfg, "wind", "furlongs")).toThrow(/Invalid value for wind/);
    expect(() => setSetting(cfg, "colour", "x")).toThrow(/Unknown setting/);
    expect(setSetting(cfg, "wind", "").wind).toBeUndefined();
    expect(getSetting(cfg, "keys.OWM_API_KEY")).toBe("abc");
  });
  test("env vars override the file", () => {
    const cfg = Config.parse({ units: "metric", keys: { OWM_API_KEY: "file" } });
    const eff = withEnv(cfg, { WEATHER_OUTLOOK_UNITS: "imperial", WEATHER_OUTLOOK_WIND: "bft" });
    expect(eff.units).toBe("imperial");
    expect(eff.wind).toBe("bft");
    expect(getKey(cfg, "OWM_API_KEY", {})).toBe("file");
    expect(getKey(cfg, "OWM_API_KEY", { OWM_API_KEY: "env" })).toBe("env");
    expect(() => withEnv(cfg, { WEATHER_OUTLOOK_UNITS: "nautical" })).toThrow(
      /WEATHER_OUTLOOK_UNITS/,
    );
  });
  test("saved locations", () => {
    const loc = { name: "Denver", lat: 39.7, lon: -105, source: "geocode" as const };
    let cfg = addLocation(Config.parse({}), { name: "@Home", query: "Denver", location: loc });
    cfg = addLocation(cfg, { name: "home", query: "Boulder" });
    expect(cfg.locations).toHaveLength(1);
    expect(findLocation(cfg, "@HOME")?.query).toBe("Boulder");
    expect(findLocation(cfg, "@work")).toBeUndefined();
  });
  test("units from config", () => {
    const cfg = Config.parse({ units: "imperial", wind: "kn", clock: "24h" });
    expect(configUnits(cfg)).toEqual({
      units: "imperial",
      overrides: { temp: undefined, wind: "kn", precip: undefined, hour12: false },
    });
  });
  test("config path honours overrides and XDG", () => {
    expect(configPath({ WEATHER_OUTLOOK_CONFIG: "/x/c.json" })).toBe("/x/c.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
      join("/xdg", "weather-outlook", "config.json"),
    );
    expect(configPath({}, "darwin")).toContain(join(".config", "weather-outlook"));
  });
});

describe("http: Expires, If-Modified-Since, SWR, rate limits", () => {
  test("Expires header sets the TTL, measured against Date", () => {
    const h = new Headers({
      date: "Thu, 08 Oct 2026 04:04:45 GMT",
      expires: "Thu, 08 Oct 2026 04:35:47 GMT",
    });
    expect(expiresTtl(h)).toBe((31 * 60 + 2) * 1000);
    expect(expiresTtl(new Headers())).toBeUndefined();
    expect(expiresTtl(new Headers({ expires: "not a date" }))).toBeUndefined();
  });
  test("honours Expires and revalidates with If-Modified-Since (MET Norway style)", async () => {
    let now = 1_000_000;
    const dir = await mkdtemp(join(tmpdir(), "wo-http-"));
    const cache = new DiskCache(dir, () => now);
    const seen: Array<Record<string, string>> = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push(headers);
      const meta = {
        date: new Date(now).toUTCString(),
        expires: new Date(now + 30 * 60_000).toUTCString(),
        "last-modified": "Thu, 08 Oct 2026 04:04:45 GMT",
      };
      if (headers["If-Modified-Since"]) return new Response(null, { status: 304, headers: meta });
      return new Response('{"v":1}', { status: 200, headers: meta });
    }) as unknown as typeof fetch;
    const http = createHttpClient(cache, fakeFetch);
    const url = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=1&lon=2";
    const opts = { ttlMs: 60_000, honorExpires: true };
    expect(await http.json<{ v: number }>(url, opts)).toEqual({ v: 1 });
    now += 10 * 60_000; // past ttlMs, but before Expires
    await http.json(url, opts);
    expect(seen).toHaveLength(1);
    now += 25 * 60_000; // past Expires
    expect(await http.json<{ v: number }>(url, opts)).toEqual({ v: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.["If-Modified-Since"]).toBe("Thu, 08 Oct 2026 04:04:45 GMT");
    // The 304 carried a new Expires, so the entry is fresh again.
    now += 5 * 60_000;
    await http.json(url, opts);
    expect(seen).toHaveLength(2);
  });
  test("stale-while-revalidate answers from cache and refreshes behind", async () => {
    let now = 1_000;
    const dir = await mkdtemp(join(tmpdir(), "wo-http-"));
    const cache = new DiskCache(dir, () => now);
    let n = 0;
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ n: ++n }), { status: 200 })) as unknown as typeof fetch;
    const http = createHttpClient(cache, fakeFetch, { swr: true });
    const updates: string[] = [];
    http.onBackgroundUpdate?.((u) => updates.push(u));
    expect(await http.json<{ n: number }>("https://x/a", { ttlMs: 100 })).toEqual({ n: 1 });
    now += 1_000;
    // Stale: served instantly while the refresh runs in the background.
    expect(await http.json<{ n: number }>("https://x/a", { ttlMs: 100 })).toEqual({ n: 1 });
    await http.settled?.();
    expect(updates).toEqual(["https://x/a"]);
    expect(await http.json<{ n: number }>("https://x/a", { ttlMs: 100 })).toEqual({ n: 2 });
    // Per-request opt-out.
    now += 1_000;
    expect(await http.json<{ n: number }>("https://x/a", { ttlMs: 100, swr: false })).toEqual({
      n: 3,
    });
  });
  test("SWR won't serve entries older than maxStaleMs", async () => {
    let now = 1_000;
    const dir = await mkdtemp(join(tmpdir(), "wo-http-"));
    const cache = new DiskCache(dir, () => now);
    let n = 0;
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ n: ++n }), { status: 200 })) as unknown as typeof fetch;
    const http = createHttpClient(cache, fakeFetch, { swr: true, maxStaleMs: 500 });
    await http.json("https://x/b", { ttlMs: 100 });
    now += 10_000;
    expect(await http.json<{ n: number }>("https://x/b", { ttlMs: 100 })).toEqual({ n: 2 });
  });
  test("per-host rate limiter spaces requests", async () => {
    let t = 0;
    const waits: number[] = [];
    const slot = createRateLimiter(
      { "nominatim.openstreetmap.org": 1000 },
      () => t,
      async (ms) => {
        waits.push(ms);
      },
    );
    await slot("https://nominatim.openstreetmap.org/reverse?a");
    await slot("https://nominatim.openstreetmap.org/reverse?b");
    await slot("https://nominatim.openstreetmap.org/reverse?c");
    await slot("https://photon.komoot.io/reverse");
    expect(waits).toEqual([1000, 2000]);
    t = 10_000;
    await slot("https://nominatim.openstreetmap.org/reverse?d");
    expect(waits).toEqual([1000, 2000]);
  });
});

describe("disk cache pruning", () => {
  test("deletes least-recently-used entries past the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wo-prune-"));
    const cache = new DiskCache(dir, Date.now, { maxBytes: 10_000_000 });
    const body = "x".repeat(1000);
    for (const k of ["a", "b", "c", "d"]) await cache.set(k, body, 60_000);
    // Age entries explicitly: a oldest ... d newest, then read "a" so it becomes recent.
    const base = Date.now() / 1000 - 1000;
    for (const [i, k] of ["a", "b", "c", "d"].entries()) {
      const hash = new Bun.CryptoHasher("sha256").update(k).digest("hex");
      const f = join(dir, hash.slice(0, 2), `${hash}.json`);
      await utimes(f, base + i * 10, base + i * 10);
    }
    await cache.get("a");
    await Bun.sleep(20); // let the fire-and-forget utimes land
    const { bytes, entries } = await cache.size();
    expect(entries).toBe(4);
    // Cap at 3/4 of the total: pruning goes to 80% of that, i.e. two entries.
    const removed = await cache.prune(Math.floor(bytes * 0.75));
    expect(removed).toBe(2);
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBeUndefined();
    expect(await cache.get("d")).toBeDefined();
  });
  test("prune is a no-op under the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wo-prune-"));
    const cache = new DiskCache(dir);
    await cache.set("k", "v", 1000);
    expect(await cache.prune()).toBe(0);
    expect((await cache.size()).entries).toBe(1);
  });
});

describe("capabilities: unicode", () => {
  test("Windows: modern terminals yes, legacy conhost no", () => {
    expect(detectUnicode({ WT_SESSION: "1" }, "win32")).toBe(true);
    expect(detectUnicode({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
    expect(detectUnicode({ TERM: "xterm-256color" }, "win32")).toBe(true);
    expect(detectUnicode({}, "win32")).toBe(false);
  });
  test("Unix: locale and the Linux console", () => {
    expect(detectUnicode({ LANG: "en_US.UTF-8" }, "linux")).toBe(true);
    expect(detectUnicode({ LANG: "C" }, "linux")).toBe(false);
    expect(detectUnicode({ TERM: "linux", LANG: "en_US.UTF-8" }, "linux")).toBe(false);
    expect(detectUnicode({}, "darwin")).toBe(true);
    expect(detectUnicode({ WEATHER_OUTLOOK_ASCII: "1" }, "darwin")).toBe(false);
  });
});

describe("doctor", () => {
  test("reports terminal, files and provider status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wo-doc-"));
    const cache = new DiskCache(dir);
    await cache.set("k", "v".repeat(2048), 1000);
    const fakeFetch = (async (url: string) => {
      if (url.includes("down")) throw Object.assign(new Error("t"), { name: "TimeoutError" });
      return new Response("ok", { status: url.includes("teapot") ? 418 : 200 });
    }) as unknown as typeof fetch;
    const out = stripAnsi(
      await runDoctor({
        caps: caps(100),
        env: { TERM_PROGRAM: "ghostty" },
        cache,
        configPath: join(dir, "missing.json"),
        version: "9.9.9",
        fetchImpl: fakeFetch,
        probes: [
          { name: "Good", url: "https://good.example/" },
          { name: "Teapot", url: "https://teapot.example/" },
          { name: "Down", url: "https://down.example/" },
        ],
      }),
    );
    expect(out).toContain("ghostty");
    expect(out).toContain("(not created)");
    expect(out).toMatch(/2\.\d KB in 1 entries/);
    expect(out).toMatch(/Good\s+✓ 200/);
    expect(out).toMatch(/Teapot\s+✗ 418/);
    expect(out).toMatch(/Down\s+✗ timeout/);
    expect(out).toContain("2 of 3 providers unreachable");
    expect(out).toContain("⣿");
  });
  test("probe measures latency without throwing", async () => {
    const r = await probe({ name: "x", url: "https://x.example/" }, (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch);
    expect(r.error).toBe("boom");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
