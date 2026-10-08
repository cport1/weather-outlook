import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Forecast } from "../src/domain/types.ts";
import { fromIcon } from "../src/providers/keyed/common.ts";
import { fromOwmCode, parseOwm } from "../src/providers/keyed/openweathermap.ts";
import { parsePirate } from "../src/providers/keyed/pirateweather.ts";
import { fromTomorrowCode, parseTomorrow } from "../src/providers/keyed/tomorrow.ts";
import { parseVisualCrossing } from "../src/providers/keyed/visualcrossing.ts";
import { fromWeatherApiCode, parseWeatherApi } from "../src/providers/keyed/weatherapi.ts";
import { findProvider, resolveProvider } from "../src/providers/registry.ts";

// Fixtures for keyed providers are built from the documented example responses
// (no live keys were available), trimmed to a few steps.
const DATA = join(import.meta.dir, "fixtures", "data");
const fx = async (name: string): Promise<any> =>
  JSON.parse(await Bun.file(join(DATA, name)).text());
const now = new Date("2026-10-07T00:00:00Z");

function valid(f: unknown) {
  const r = Forecast.safeParse(f);
  if (!r.success) throw new Error(r.error.message);
}

describe("registry", () => {
  test("aliases and env keys", () => {
    expect(findProvider("owm")?.id).toBe("openweathermap");
    expect(findProvider("Pirate")?.id).toBe("pirateweather");
    expect(resolveProvider(undefined, {}).provider.id).toBe("open-meteo");
    expect(
      resolveProvider(undefined, { WEATHER_OUTLOOK_PROVIDER: "vc", VISUALCROSSING_API_KEY: "k" }),
    ).toMatchObject({ key: "k" });
    expect(() => resolveProvider("tomorrow", {})).toThrow("TOMORROW_API_KEY");
    expect(() => resolveProvider("accuweather", {})).toThrow("Unknown provider");
  });
});

describe("OpenWeatherMap 2.5", () => {
  test("current + 3-hourly rolled into days", async () => {
    const f = parseOwm(await fx("owm-weather.json"), await fx("owm-forecast.json"), now);
    valid(f);
    expect(f.current.temperature).toBe(21.37);
    expect(f.current.condition).toBe("rain");
    expect(f.current.windSpeed).toBeCloseTo(2.2, 1);
    expect(f.current.isDay).toBe(true);
    expect(f.hourly[0]?.precipitationProbability).toBe(32);
    expect(f.hourly[1]?.isDay).toBe(false);
    expect(f.daily.map((d) => d.date)).toEqual(["2022-08-30", "2022-08-31"]);
    expect(f.daily[0]?.tempMax).toBe(23.2);
    expect(f.daily[0]?.tempMin).toBe(19);
    expect(fromOwmCode(211)).toBe("thunderstorm");
    expect(fromOwmCode(741)).toBe("fog");
    expect(fromOwmCode(804)).toBe("cloudy");
  });
});

describe("Tomorrow.io", () => {
  test("timelines + minutely nowcast", async () => {
    const loc = { lat: 42.3478, lon: -71.0466 };
    const r = parseTomorrow(
      await fx("tomorrow-forecast.json"),
      loc,
      new Date("2023-01-19T12:00:00Z"),
    );
    valid(r.forecast);
    expect(r.forecast.current.temperature).toBe(4.2);
    expect(r.forecast.current.visibility).toBe(16000);
    expect(r.forecast.hourly[1]?.condition).toBe("showers");
    expect(r.forecast.daily[0]?.precipitationSum).toBe(3.2);
    expect(r.forecast.daily[1]?.condition).toBe("clear");
    expect(r.nowcast?.headline).toBe("Light rain starting in ~30 min");
    expect(fromTomorrowCode(8000)).toBe("thunderstorm");
    expect(fromTomorrowCode(51010)).toBe("heavy-snow");
  });
});

describe("Pirate Weather", () => {
  test("SI units, fractions → percent, minutely", async () => {
    const loc = { lat: 45.42, lon: -75.69 };
    const r = parsePirate(await fx("pirateweather.json"), loc, new Date(1674318840 * 1000));
    valid(r.forecast);
    expect(r.forecast.current.condition).toBe("snow");
    expect(r.forecast.current.humidity).toBe(88);
    expect(r.forecast.current.visibility).toBe(2320);
    expect(r.forecast.daily[0]?.date).toBe("2023-01-21");
    expect(r.forecast.daily[0]?.precipitationSum).toBeCloseTo(9.5, 5);
    expect(r.nowcast?.points.length).toBe(3);
    expect(r.nowcast?.points[0]?.snow).toBe(true);
  });
});

describe("WeatherAPI.com", () => {
  test("forecast days and hours", async () => {
    const f = parseWeatherApi(await fx("weatherapi-forecast.json"), now);
    valid(f);
    expect(f.current.condition).toBe("showers");
    expect(f.current.isDay).toBe(false);
    expect(f.hourly.length).toBe(2);
    expect(f.daily[0]?.precipitationProbability).toBe(89);
    expect(f.daily[0]?.windGustMax).toBe(19.4);
    expect(fromWeatherApiCode(1195)).toBe("heavy-rain");
    expect(fromWeatherApiCode(1282)).toBe("thunderstorm");
  });
});

describe("Visual Crossing", () => {
  test("timeline days/hours/current", async () => {
    const f = parseVisualCrossing(await fx("visualcrossing-timeline.json"), now);
    valid(f);
    expect(f.current.temperature).toBe(14.2);
    expect(f.current.isDay).toBe(true);
    expect(f.hourly[0]?.isDay).toBe(false);
    expect(f.daily[0]?.condition).toBe("rain");
    expect(f.daily[0]?.sunrise).toBe(new Date(1674131086 * 1000).toISOString());
    expect(fromIcon("partly-cloudy-night")).toBe("partly-cloudy");
    expect(fromIcon("thunder-rain")).toBe("thunderstorm");
    expect(fromIcon(undefined)).toBe("unknown");
  });
});
