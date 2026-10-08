import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { providerForUrl } from "../src/attribution.ts";
import { Climate, Marine, ModelComparison, Nowcast, Nws } from "../src/domain/details.ts";
import { AirQuality } from "../src/domain/types.ts";
import { buildClimate, funFact, percentileRank } from "../src/providers/climate.ts";
import {
  nearestBuoy,
  nearestTideStation,
  parseNdbc,
  parseTideCurve,
  parseTideEvents,
  parseWaves,
} from "../src/providers/marine.ts";
import { alignMetNo, confidence, parseEnsemble, parseModels } from "../src/providers/models.ts";
import {
  inNordicArea,
  nowcastHeadline,
  parseMetNowcast,
  parseMinutely15,
} from "../src/providers/nowcast.ts";
import {
  cleanDiscussion,
  isoDurationMs,
  parseObservation,
  parsePeriods,
  reflow,
  summarizeGrid,
} from "../src/providers/nws-forecast.ts";
import { parseAirQuality } from "../src/providers/open-meteo.ts";
import { parseOpenAq } from "../src/providers/openaq.ts";

const DATA = join(import.meta.dir, "fixtures", "data");
const fx = async (name: string): Promise<any> =>
  JSON.parse(await Bun.file(join(DATA, name)).text());
const text = (name: string) => Bun.file(join(DATA, name)).text();

describe("nws details", () => {
  test("forecast periods convert °F to °C and keep the text", async () => {
    const periods = parsePeriods(await fx("nws-forecast.json"));
    expect(periods.length).toBe(6);
    const p = periods[0];
    expect(p?.name).toBe("Tonight");
    expect(p?.temperature).toBeCloseTo((58 - 32) / 1.8, 5);
    expect(p?.detailedForecast).toContain("low around 58");
    expect(p?.wind).toBe("WSW 5 mph");
  });
  test("ISO 8601 durations", () => {
    expect(isoDurationMs("PT6H")).toBe(6 * 3_600_000);
    expect(isoDurationMs("P2DT10H")).toBe(58 * 3_600_000);
    expect(isoDurationMs("P1D")).toBe(86_400_000);
    expect(isoDurationMs("bogus")).toBe(0);
  });
  test("grid extras: heat risk, lightning, pro-rated snowfall", async () => {
    const now = Date.parse("2026-10-07T21:00:00Z");
    const g = summarizeGrid(await fx("nws-grid.json"), now);
    expect(g.heatRiskMax).toBe(1);
    expect(g.lightningMax).toBeUndefined();
    expect(g.snowfall24h).toBe(0);
    const synthetic = summarizeGrid(
      {
        properties: {
          lightningActivityLevel: {
            values: [{ validTime: "2026-01-01T00:00:00+00:00/PT12H", value: 3 }],
          },
          snowfallAmount: {
            values: [
              { validTime: "2026-01-01T00:00:00+00:00/PT12H", value: 50 },
              { validTime: "2026-01-01T12:00:00+00:00/PT24H", value: 40 },
            ],
          },
        },
      },
      Date.parse("2026-01-01T00:00:00Z"),
    );
    expect(synthetic.lightningMax).toBe(3);
    // 50 mm in the first 12 h + half of the next 40 mm.
    expect(synthetic.snowfall24h).toBe(70);
    expect(synthetic.snowfallTotal).toBe(90);
  });
  test("latest observation in metric units", async () => {
    const o = parseObservation(await fx("nws-observation.json"));
    expect(o.station).toBe("KSFO");
    expect(o.temperature).toBe(15);
    expect(o.windSpeed).toBeUndefined();
    expect(o.pressure).toBeCloseTo(1011.5, 1);
    expect(o.visibility).toBeCloseTo(16093, 0);
  });
  test("AFD text loses the WMO header", async () => {
    const afd = await fx("nws-afd.json");
    const t = cleanDiscussion(afd.productText);
    expect(t.startsWith("Area Forecast Discussion")).toBe(true);
    expect(t).toContain(".KEY MESSAGES...");
    expect(t).not.toContain("FXUS66");
  });
  test("marine /points has no land forecast", async () => {
    const p = await fx("nws-points-marine.json");
    expect(p.properties.type).toBe("marine");
    expect(p.properties.forecast).toBeNull();
  });
  test("schema", async () => {
    const parsed = Nws.safeParse({
      provider: "nws",
      office: "MTR",
      periods: parsePeriods(await fx("nws-forecast.json")),
      observation: parseObservation(await fx("nws-observation.json")),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("model comparison", () => {
  test("deterministic models, ensemble band, MET Norway alignment, confidence", async () => {
    const { times, models } = parseModels(await fx("om-models.json"));
    expect(times.length).toBe(168);
    expect(times[0]).toBe("2026-10-07T00:00:00-07:00");
    expect(models.map((m) => m.label)).toEqual(["Best match", "GFS", "ECMWF", "ICON"]);
    const e = parseEnsemble(await fx("om-ensemble.json"));
    expect(e.ensemble.members).toBe(11);
    const i = 30;
    const lo = e.ensemble.min[i] ?? Number.NaN;
    const hi = e.ensemble.max[i] ?? Number.NaN;
    expect(lo).toBeLessThanOrEqual(e.ensemble.mean[i] ?? Number.NaN);
    expect(hi).toBeGreaterThanOrEqual(e.ensemble.mean[i] ?? Number.NaN);
    const met = alignMetNo(await fx("metno-compact.json"), times);
    // MET's first step is 04:00Z = 21:00 local on Oct 7 (index 21).
    expect(met[21]).toBe(16.4);
    expect(met[0]).toBeNull();
    const c = confidence(times, e.std, models, Date.parse("2026-10-08T04:00:00Z"));
    expect(c?.score).toBeGreaterThan(0);
    expect(c?.score).toBeLessThanOrEqual(100);
    expect(["high", "moderate", "low"]).toContain(c?.label ?? "");
    expect(
      ModelComparison.safeParse({ times, models, ensemble: e.ensemble, confidence: c }).success,
    ).toBe(true);
  });
  test("confidence falls back to model spread and drops with disagreement", () => {
    const times = Array.from({ length: 10 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    );
    const agree = [
      { id: "a", label: "A", temperature: times.map(() => 10) },
      { id: "b", label: "B", temperature: times.map(() => 10.5) },
    ];
    const disagree = [
      agree[0] ?? agree[1]!,
      { id: "c", label: "C", temperature: times.map(() => 20) },
    ];
    const now = Date.UTC(2026, 0, 1, 0);
    const a = confidence(times, undefined, agree, now);
    const d = confidence(times, undefined, disagree, now);
    expect(a?.label).toBe("high");
    expect(d?.label).toBe("low");
  });
});

describe("marine", () => {
  test("waves for the coast, nothing inland", async () => {
    const w = parseWaves(await fx("om-marine.json"));
    expect(w?.current.height).toBe(0.88);
    expect(w?.current.seaSurfaceTemperature).toBe(16.1);
    expect(w?.hourly.length).toBe(72);
    expect(parseWaves(await fx("om-marine-inland.json"))).toBeUndefined();
  });
  test("nearest tide station + hi/lo + curve", async () => {
    const s = nearestTideStation(await fx("coops-stations.json"), 37.7749, -122.4194);
    expect(s).toBeDefined();
    expect(s?.distanceKm).toBeLessThan(10);
    expect(nearestTideStation(await fx("coops-stations.json"), 39.74, -104.99)).toBeUndefined();
    const events = parseTideEvents(await fx("coops-hilo.json"));
    expect(events[0]).toEqual({ time: "2026-10-07T03:58:00Z", height: 1.702, type: "high" });
    expect(events[1]?.type).toBe("low");
    const curve = parseTideCurve(await fx("coops-curve.json"));
    expect(curve.length).toBeGreaterThan(24);
    expect(curve[1]).toEqual({ time: "2026-10-07T01:00:00Z", height: 1.16 });
    expect(() => parseTideEvents({ error: { message: "No data was found" } })).toThrow("No data");
  });
  test("NDBC fixed-width parsing (MM = missing) and nearest buoy", async () => {
    const latest = parseNdbc(await text("ndbc-latest-obs.txt"));
    const r46026 = latest.find((r) => r.id === "46026");
    expect(r46026?.values.WSPD).toBe(8);
    expect(r46026?.values.WVHT).toBeUndefined();
    expect(r46026?.time).toBe("2026-10-08T03:40:00.000Z");
    const now = Date.parse("2026-10-08T04:00:00Z");
    const buoy = nearestBuoy(latest, 37.7749, -122.4194, now);
    // FTPC1 is closer but reports no waves; 46237 is the nearest wave buoy.
    expect(buoy?.id).toBe("46237");
    expect(buoy?.waveHeight).toBe(1.2);
    expect(buoy?.waterTemperature).toBe(15.6);
    expect(nearestBuoy(latest, 39.74, -104.99, now)).toBeUndefined();
    // Stale data (older than 6 h) is ignored.
    expect(nearestBuoy(latest, 37.7749, -122.4194, now + 12 * 3_600_000)).toBeUndefined();
    const rt = parseNdbc(await text("ndbc-realtime2-46026.txt"));
    expect(rt[0]?.time).toBe("2026-10-08T03:40:00.000Z");
    expect(rt[0]?.values.PRES).toBe(1011.9);
    expect(rt[2]?.values.WVHT).toBe(1.5);
  });
  test("schema", async () => {
    expect(Marine.safeParse({ waves: parseWaves(await fx("om-marine.json")) }).success).toBe(true);
  });
});

describe("climate", () => {
  const daily = [
    { date: "2026-10-07", tempMax: 33.5, tempMin: 12.0, condition: "clear" as const },
    { date: "2026-10-08", tempMax: 21.0, tempMin: 12.5, condition: "clear" as const },
  ];
  test("normals, anomalies and percentiles", async () => {
    const c = buildClimate(await fx("om-archive.json"), daily, { startYear: 1996, endYear: 2025 });
    expect(c.days.length).toBe(2);
    const d0 = c.days[0];
    expect(d0?.normalHigh).toBeGreaterThan(15);
    expect(d0?.normalHigh).toBeLessThan(28);
    expect(d0?.highAnomaly).toBeCloseTo(33.5 - (d0?.normalHigh ?? 0), 0);
    expect(d0?.highPercentile).toBeGreaterThanOrEqual(95);
    expect(c.recordHigh?.year).toBe(1996);
    expect(c.fact).toBe("Warmest Oct 7 in 30 years of records");
    expect(Climate.safeParse(c).success).toBe(true);
  });
  test("percentile rank and fun facts", () => {
    expect(percentileRank([1, 2, 3, 4], 5)).toBe(100);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 2.5)).toBe(50);
    const s = [
      { year: 2020, offset: 0, hi: 30, lo: 10 },
      { year: 2015, offset: 0, hi: 32, lo: 9 },
      { year: 2010, offset: 0, hi: 25, lo: 4 },
    ];
    expect(funFact("2026-10-07", 31, 12, s, 95, 50)).toBe("Warmest Oct 7 since 2015");
    expect(funFact("2026-10-07", 20, 3, s, 40, 5)).toBe(
      "Coldest Oct 7 night in 3 years of records",
    );
    expect(funFact("2026-10-07", 26, 12, s, 50, 50)).toBeUndefined();
  });
});

describe("nowcast", () => {
  const at = (min: number, rate: number, snow?: boolean) => ({
    time: new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString(),
    rate,
    snow,
  });
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const series = (rates: number[], snow?: boolean) => rates.map((r, i) => at(i * 15, r, snow));
  test("headlines", () => {
    expect(nowcastHeadline(series([0, 0, 0.5, 1, 1, 0, 0, 0, 0]), now)).toBe(
      "Light rain starting in ~30 min",
    );
    expect(nowcastHeadline(series([3, 3, 0, 0, 0, 0, 0, 0, 0]), now)).toBe(
      "Rain stopping in ~30 min",
    );
    expect(nowcastHeadline(series([0, 0, 0, 0, 0, 0, 0, 0, 0]), now)).toBe(
      "No precipitation expected for the next 2 hours",
    );
    expect(nowcastHeadline(series([9, 9, 9, 9, 9, 9, 9, 9, 9], true), now)).toBe(
      "Heavy snow for the next 2 hours",
    );
    expect(nowcastHeadline(series([0, 0, 0, 0, 0, 0, 0, 0, 10]), now)).toBe(
      "Heavy rain starting in ~2 h",
    );
    expect(nowcastHeadline([], now)).toBe("No nowcast available");
  });
  test("Open-Meteo minutely_15 → mm/h", async () => {
    const raw = await fx("om-minutely15.json");
    const n = parseMinutely15(raw, Date.parse("2026-10-08T03:50:00Z"));
    expect(n?.interval).toBe(15);
    expect(n?.points[0]?.rate).toBe(2);
    expect(n?.points[0]?.time).toBe("2026-10-08T05:45:00+02:00");
    expect(n?.headline).toBe("Light rain for the next 2 hours");
    expect(Nowcast.safeParse(n).success).toBe(true);
  });
  test("MET Norway nowcast (Nordics only)", async () => {
    const n = parseMetNowcast(await fx("metno-nowcast.json"), Date.parse("2026-10-08T04:10:00Z"));
    expect(n?.provider).toBe("met-norway");
    expect(n?.interval).toBe(5);
    expect(n?.points[0]?.rate).toBe(0.9);
    expect(n?.headline).toMatch(/^Light rain for the next/);
    expect(inNordicArea(59.91, 10.75)).toBe(true);
    expect(inNordicArea(37.77, -122.42)).toBe(false);
  });
});

describe("air quality", () => {
  test("hourly AQI forecast; pollen only where modelled (Europe)", async () => {
    const berlin = parseAirQuality(await fx("om-aq-berlin.json"));
    expect(berlin.hourly?.length).toBe(96);
    expect(berlin.hourly?.[0]?.time).toMatch(/\+02:00$/);
    expect(berlin.pollen).toBeDefined();
    const sf = parseAirQuality(await fx("om-aq-sf.json"));
    expect(sf.pollen).toBeUndefined();
    expect(sf.usAqi).toBe(56);
    expect(AirQuality.safeParse(sf).success).toBe(true);
  });
  test("OpenAQ v3 latest readings, invalid sentinels dropped", async () => {
    const s = parseOpenAq(await fx("openaq-locations.json"), await fx("openaq-latest.json"));
    expect(s?.name).toBe("Del Norte, Albuquerque");
    expect(s?.distanceKm).toBe(4.2);
    expect(s?.readings.pm25).toEqual({ value: 7.2, units: "µg/m³" });
    expect(s?.readings.no2).toBeUndefined();
    expect(s?.time).toBe("2024-04-12T15:00:00Z");
  });
});

describe("NWS text reflow", () => {
  test("joins hard-wrapped prose but keeps headers, bullets and blank lines", () => {
    const text = [
      ".SHORT TERM...",
      "Another hot day. Inland temperatures have already climbed into",
      "the 90s, and the hottest spots will get close to 100 degrees.",
      "",
      " - Hot inland temperatures continue through Thursday",
      "&&",
    ].join("\n");
    expect(reflow(text).split("\n")).toEqual([
      ".SHORT TERM...",
      "Another hot day. Inland temperatures have already climbed into the 90s, and the hottest spots will get close to 100 degrees.",
      "",
      " - Hot inland temperatures continue through Thursday",
      "&&",
    ]);
  });
});

describe("attribution for detail sources", () => {
  test("every new host is credited", () => {
    const cases: Array<[string, string]> = [
      ["https://archive-api.open-meteo.com/v1/archive", "open-meteo-archive"],
      ["https://marine-api.open-meteo.com/v1/marine", "open-meteo-marine"],
      ["https://ensemble-api.open-meteo.com/v1/ensemble", "open-meteo"],
      ["https://api.met.no/weatherapi/nowcast/2.0/complete", "met-norway"],
      ["https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", "noaa-coops"],
      ["https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt", "ndbc"],
      ["https://api.openaq.org/v3/locations", "openaq"],
      ["https://api.openweathermap.org/data/2.5/weather", "openweathermap"],
      ["https://api.tomorrow.io/v4/weather/forecast", "tomorrow-io"],
      ["https://api.pirateweather.net/forecast/k/1,2", "pirateweather"],
      ["https://api.weatherapi.com/v1/forecast.json", "weatherapi"],
      ["https://weather.visualcrossing.com/VisualCrossingWebServices/rest", "visualcrossing"],
    ];
    for (const [url, id] of cases) expect(providerForUrl(url)?.id).toBe(id);
  });
});
