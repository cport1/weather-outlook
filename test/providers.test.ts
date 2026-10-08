import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchemas, serializeSchema } from "../src/domain/schema.ts";
import { AirQuality, Alert, Forecast, Location, Report } from "../src/domain/types.ts";
import {
  locateByIp,
  parseBigDataCloud,
  parseGeoJs,
  parseIpApiCo,
  parseIpInfo,
  parseIpWho,
  parseNominatim,
  parsePhoton,
  resolveLocation,
  reverseGeocode,
} from "../src/providers/location.ts";
import { fetchNwsAlertsForPoint } from "../src/providers/nws.ts";
import {
  fetchAirQuality,
  fetchForecast,
  geocode,
  parseForecast,
} from "../src/providers/open-meteo.ts";
import { buildReport } from "../src/report.ts";
import { parseChoice } from "../src/util/prompt.ts";
import { fixtureHttp, loadFixture } from "./fixtures/http.ts";

const DENVER = { lat: 39.7392, lon: -104.9903 };

describe("Open-Meteo fixtures", () => {
  test("forecast parses and satisfies the Forecast schema", async () => {
    const { http } = fixtureHttp();
    const fc = Forecast.parse(await fetchForecast(http, DENVER));
    expect(fc.hourly).toHaveLength(240);
    expect(fc.daily).toHaveLength(10);
    expect(fc.current.time).toMatch(/[+-]\d\d:\d\d$/);
    expect(Number.isFinite(fc.current.temperature)).toBe(true);
    expect(fc.daily[0]?.sunrise).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00[+-]\d\d:\d\d$/);
  });
  test("forecast parser tolerates nulls in series", () => {
    const raw = loadFixture<Parameters<typeof parseForecast>[0]>("open-meteo-forecast");
    const temps = raw.hourly.temperature_2m as Array<number | null>;
    temps[0] = null;
    const fc = parseForecast(raw);
    expect(Number.isNaN(fc.hourly[0]?.temperature)).toBe(true);
    expect(fc.hourly[0]?.condition).toBeDefined();
  });
  test("air quality satisfies the AirQuality schema", async () => {
    const { http } = fixtureHttp();
    const aq = AirQuality.parse(await fetchAirQuality(http, DENVER));
    expect(aq.usAqi).toBeGreaterThanOrEqual(0);
  });
  test("geocode results are Locations", async () => {
    const { http } = fixtureHttp();
    const results = await geocode(http, "Springfield", 10);
    expect(results.length).toBeGreaterThan(3);
    for (const r of results) Location.parse(r);
    // Population is used for ranking only and must not leak into the public type.
    expect("population" in (results[0] as object)).toBe(false);
  });
});

describe("NWS fixtures", () => {
  test("alerts parse, satisfy the Alert schema and sort by severity", async () => {
    const { http } = fixtureHttp();
    const alerts = await fetchNwsAlertsForPoint(http, DENVER.lat, DENVER.lon);
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) Alert.parse(a);
    const rank = ["extreme", "severe", "moderate", "minor", "unknown"];
    const ranks = alerts.map((a) => rank.indexOf(a.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("IP geolocation", () => {
  test("every provider's recorded response parses to the same place", () => {
    const fixes = [
      parseIpApiCo(loadFixture("ipapi")),
      parseIpWho(loadFixture("ipwho")),
      parseGeoJs(loadFixture("geojs")),
      parseIpInfo(loadFixture("ipinfo")),
    ];
    for (const f of fixes) {
      expect(f?.name).toBe("Denver");
      expect(f?.countryCode).toBe("US");
      expect(f?.lat).toBeCloseTo(39.74, 1);
      expect(f?.lon).toBeCloseTo(-104.99, 1);
      expect(f?.timezone).toBe("America/Denver");
    }
  });
  test("rate-limited / failed answers are rejected", () => {
    expect(parseIpApiCo({ error: true, reason: "RateLimited" })).toBeUndefined();
    expect(parseIpWho({ success: false })).toBeUndefined();
    expect(parseIpInfo({ city: "X" })).toBeUndefined();
  });
  test("falls back down the chain", async () => {
    const { http, requests } = fixtureHttp({ fail: ["ipapi", "ipwho"] });
    const loc = await locateByIp(http);
    expect(loc.source).toBe("ip");
    expect(loc.name).toBe("Denver");
    expect(requests.map((u) => new URL(u).host)).toEqual(["ipapi.co", "ipwho.is", "get.geojs.io"]);
  });
  test("reports every failure when the whole chain is down", async () => {
    const { http } = fixtureHttp({ fail: ["ipapi", "ipwho", "geojs", "ipinfo"] });
    await expect(locateByIp(http)).rejects.toThrow(/ipapi\.co.*ipinfo\.io/);
  });
});

describe("reverse geocoding", () => {
  test("each service's recorded answer names Denver", () => {
    expect(parseNominatim(loadFixture("nominatim-reverse"))).toMatchObject({
      name: "Denver",
      region: "Colorado",
      countryCode: "US",
    });
    expect(parsePhoton(loadFixture("photon-reverse"))).toMatchObject({
      name: "Denver",
      countryCode: "US",
    });
    expect(parseBigDataCloud(loadFixture("bigdatacloud-reverse"))).toMatchObject({
      name: "Denver",
      countryCode: "US",
    });
  });
  test("open ocean yields nothing from Nominatim/Photon", () => {
    expect(parseNominatim({ error: "Unable to geocode" })).toBeUndefined();
    expect(parsePhoton({ features: [] })).toBeUndefined();
    expect(parseBigDataCloud({ city: "", locality: "Pacific Ocean" })?.name).toBe("Pacific Ocean");
  });
  test("falls through to the next service", async () => {
    const { http, requests } = fixtureHttp({ fail: ["nominatim-reverse"] });
    const place = await reverseGeocode(http, DENVER.lat, DENVER.lon);
    expect(place?.name).toBe("Denver");
    expect(requests.map((u) => new URL(u).host)).toEqual([
      "nominatim.openstreetmap.org",
      "photon.komoot.io",
    ]);
  });
  test("coordinates resolve to a named place with a timezone", async () => {
    const { http } = fixtureHttp();
    const loc = Location.parse(await resolveLocation(http, "39.7392,-104.9903"));
    expect(loc).toMatchObject({ name: "Denver", source: "coords", countryCode: "US" });
    expect(loc.timezone).toBe("America/Denver");
    expect(loc.lat).toBe(39.7392);
  });
  test("coordinates still work with every reverse geocoder down", async () => {
    const { http } = fixtureHttp({
      fail: ["nominatim-reverse", "photon-reverse", "bigdatacloud-reverse"],
    });
    const loc = await resolveLocation(http, "39.7392,-104.9903");
    expect(loc.name).toBe("39.74, -104.99");
  });
});

describe("ambiguous place names", () => {
  test("no picker: best match, no prompt", async () => {
    const { http } = fixtureHttp();
    const loc = await resolveLocation(http, "Springfield");
    expect(loc.region).toBe("Missouri");
  });
  test("picker is offered the same-named peers and its choice wins", async () => {
    const { http } = fixtureHttp();
    let offered: string[] = [];
    const loc = await resolveLocation(http, "Springfield", {
      pick: async (_q, choices) => {
        offered = choices.map((c) => c.region ?? "");
        return 1;
      },
    });
    expect(offered.slice(0, 3)).toEqual(["Missouri", "Illinois", "Massachusetts"]);
    expect(offered).not.toContain("Minnesota"); // "Jackson" isn't a Springfield
    expect(loc.region).toBe("Illinois");
  });
  test("a decisive hint skips the picker", async () => {
    const { http } = fixtureHttp();
    let asked = false;
    const loc = await resolveLocation(http, "Springfield, IL", {
      pick: async () => {
        asked = true;
        return 0;
      },
    });
    expect(asked).toBe(false);
    expect(loc.region).toBe("Illinois");
  });
  test("a dominant city skips the picker", async () => {
    const raw = loadFixture<{ results: Array<{ name: string; population?: number }> }>(
      "open-meteo-geocode",
    );
    const results = raw.results.map((r, i) => (i === 0 ? { ...r, population: 5_000_000 } : r));
    const { http } = fixtureHttp({ override: { "open-meteo-geocode": { results } } });
    let asked = false;
    await resolveLocation(http, "Springfield", {
      pick: async () => {
        asked = true;
        return 0;
      },
    });
    expect(asked).toBe(false);
  });
  test("menu answers", () => {
    expect(parseChoice("2", 3)).toBe(1);
    expect(parseChoice("", 3)).toBe(0);
    expect(parseChoice("9", 3)).toBe(0);
    expect(parseChoice("x", 3)).toBe(0);
  });
});

describe("report", () => {
  test("a report built from fixtures satisfies the Report schema", async () => {
    const { http } = fixtureHttp();
    const loc = await resolveLocation(http, "Springfield");
    const report = await buildReport(http, loc, "imperial");
    expect(report.errors).toEqual([]);
    Report.parse(report);
  });
  test("include flags skip providers entirely", async () => {
    const { http, requests } = fixtureHttp();
    const loc = { name: "Denver", lat: DENVER.lat, lon: DENVER.lon, source: "coords" as const };
    const report = await buildReport(http, loc, "metric", {
      include: { forecast: true, airQuality: false, alerts: false },
    });
    expect(requests.map((u) => new URL(u).host)).toEqual(["api.open-meteo.com"]);
    expect(report.airQuality).toBeUndefined();
    Report.parse(report);
  });
});

describe("published JSON Schema", () => {
  test("schema/*.json is up to date (run `bun run schema`)", () => {
    for (const [name, doc] of Object.entries(jsonSchemas())) {
      const file = join(import.meta.dir, "..", "schema", name);
      const committed = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      expect(committed).toBe(serializeSchema(doc));
    }
  });
});
