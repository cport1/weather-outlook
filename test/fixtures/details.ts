import type { Climate, Marine, ModelComparison, Nowcast, Nws } from "../../src/domain/details.ts";
import type { AirQuality, DailyPoint, HourlyPoint } from "../../src/domain/types.ts";
import { MODELS } from "../../src/providers/models.ts";
import { nowcastHeadline } from "../../src/providers/nowcast.ts";

/**
 * Deterministic detail sections (nowcast, NWS, models, marine, climate, hourly
 * AQI) derived from a fixture forecast, for headless view snapshots.
 */

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export interface FixtureDetails {
  nowcast: Nowcast;
  nws: Nws;
  models: ModelComparison;
  marine: Marine;
  climate: Climate;
  aqHourly: NonNullable<AirQuality["hourly"]>;
}

export function fixtureDetails(
  now: Date,
  hourly: HourlyPoint[],
  daily: DailyPoint[],
): FixtureDetails {
  // Dry for 30 minutes, then a burst of rain tapering off.
  const points = Array.from({ length: 9 }, (_, i) => ({
    time: new Date(now.getTime() + i * 15 * 60_000).toISOString(),
    rate: [0, 0, 0.6, 2.4, 4.8, 3.2, 1.4, 0.4, 0][i] ?? 0,
  }));
  const nowcast: Nowcast = {
    provider: "fixture",
    interval: 15,
    points,
    headline: nowcastHeadline(points, now.getTime()),
  };

  const times = hourly.slice(0, 168).map((h) => h.time);
  const offsets: Record<string, number> = {
    best_match: 0,
    gfs_seamless: 1.2,
    ecmwf_ifs025: -0.8,
    icon_seamless: 0.5,
  };
  const series = [...MODELS, { id: "met_norway", label: "MET Norway" }].map((m, k) => ({
    id: m.id,
    label: m.label,
    temperature: hourly
      .slice(0, 168)
      .map((h, i) =>
        m.id === "met_norway" && i % 6 !== 0 && i > 60
          ? null
          : round(
              h.temperature + (offsets[m.id] ?? -0.4) * (1 + i / 60) + Math.sin(i / 9 + k) * 0.6,
            ),
      ),
  }));
  const spread = (i: number) => 0.8 + i / 40;
  const models: ModelComparison = {
    times,
    models: series,
    ensemble: {
      model: "ecmwf_ifs025",
      members: 51,
      min: hourly.slice(0, 168).map((h, i) => round(h.temperature - spread(i))),
      max: hourly.slice(0, 168).map((h, i) => round(h.temperature + spread(i))),
      mean: hourly.slice(0, 168).map((h) => h.temperature),
    },
    confidence: { score: 81, label: "high", spread: 1.3, modelSpread: 2.4, hours: 72 },
  };

  const nws: Nws = {
    provider: "nws",
    office: "BOU",
    gridId: "BOU",
    gridX: 63,
    gridY: 62,
    pointType: "land",
    periods: [
      [
        "This Afternoon",
        true,
        30,
        "Showers and Thunderstorms Likely",
        "Showers and thunderstorms likely. Mostly sunny, with a high near 86. Chance of precipitation is 60%.",
      ],
      [
        "Tonight",
        false,
        16,
        "Chance Showers And Thunderstorms",
        "A chance of showers and thunderstorms before midnight. Partly cloudy, with a low around 61.",
      ],
      ["Thursday", true, 31, "Sunny", "Sunny, with a high near 88. North wind 5 to 10 mph."],
      ["Thursday Night", false, 17, "Mostly Clear", "Mostly clear, with a low around 62."],
    ].map(([name, isDaytime, t, short, detailed], i) => ({
      name: String(name),
      startTime: new Date(now.getTime() + i * 12 * 3_600_000).toISOString(),
      isDaytime: Boolean(isDaytime),
      temperature: Number(t),
      precipitationProbability: i === 0 ? 60 : 20,
      wind: "N 5 to 10 mph",
      shortForecast: String(short),
      detailedForecast: String(detailed),
    })),
    observation: {
      station: "KDEN",
      stationName: "Denver International Airport",
      time: new Date(now.getTime() - 20 * 60_000).toISOString(),
      description: "Partly Cloudy",
      temperature: 27.2,
      dewPoint: 9.4,
      humidity: 33,
      windSpeed: 18.5,
      windGust: 31.5,
      windDirection: 220,
      pressure: 1016.1,
      visibility: 16_093,
    },
    extras: {
      heatRiskMax: 2,
      heatRiskDate: now.toISOString(),
      lightningMax: 3,
      snowfall24h: 0,
      snowfallTotal: 0,
    },
    discussion: {
      issued: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
      office: "KBOU",
      text: [
        "Area Forecast Discussion",
        "National Weather Service Denver/Boulder CO",
        "",
        ".KEY MESSAGES...",
        "",
        " - Scattered afternoon storms with gusty outflow winds and small hail.",
        "",
        " - Hotter and drier Thursday and Friday.",
        "",
        ".SHORT TERM /Through Thursday/...",
        "",
        "A weak shortwave crosses the northern Front Range this afternoon.",
        "Surface dewpoints in the 50s east of the foothills support around",
        "1000 J/kg of CAPE, enough for a few strong storms.",
      ].join("\n"),
    },
  };

  const waves = hourly.slice(0, 72).map((h, i) => ({
    time: h.time,
    height: round(1.1 + 0.4 * Math.sin(i / 8), 2),
    period: round(9 + Math.sin(i / 12) * 2),
    direction: 270,
    seaSurfaceTemperature: 16.4,
  }));
  const marine: Marine = {
    waves: { provider: "fixture", current: waves[0] ?? { time: now.toISOString() }, hourly: waves },
    tides: {
      provider: "noaa-coops",
      station: {
        id: "9414290",
        name: "San Francisco, CA",
        lat: 37.806,
        lon: -122.465,
        distanceKm: 4.2,
      },
      events: [3, 9.2, 15.5, 21.7].map((h, i) => ({
        time: new Date(now.getTime() + h * 3_600_000).toISOString(),
        height: i % 2 ? 0.2 : 1.8,
        type: i % 2 ? ("low" as const) : ("high" as const),
      })),
      curve: Array.from({ length: 48 }, (_, i) => ({
        time: new Date(now.getTime() + (i - 3) * 3_600_000).toISOString(),
        height: round(1 + 0.8 * Math.cos(((i - 6) / 12.4) * 2 * Math.PI), 2),
      })),
    },
    buoy: {
      provider: "ndbc",
      id: "46026",
      lat: 37.75,
      lon: -122.838,
      distanceKm: 32,
      time: now.toISOString(),
      windDirection: 300,
      windSpeed: 28.8,
      waveHeight: 1.4,
      dominantPeriod: 11,
      waterTemperature: 15.9,
      airTemperature: 14.2,
      pressure: 1012.4,
    },
  };

  const climate: Climate = {
    provider: "fixture",
    startYear: 1996,
    endYear: 2025,
    days: daily.map((d, i) => {
      const normalHigh = 31 - i * 0.1;
      const normalLow = 15.5 - i * 0.05;
      return {
        date: d.date,
        normalHigh: round(normalHigh),
        normalLow: round(normalLow),
        highAnomaly: round(d.tempMax - normalHigh),
        lowAnomaly: round(d.tempMin - normalLow),
        highPercentile: Math.max(1, Math.min(99, Math.round(50 + (d.tempMax - normalHigh) * 9))),
        lowPercentile: Math.max(1, Math.min(99, Math.round(50 + (d.tempMin - normalLow) * 9))),
      };
    }),
    recordHigh: { value: 38.3, year: 2005 },
    recordLow: { value: 10.6, year: 2012 },
    fact: "Warmest Jul 15 since 2005",
  };

  const aqHourly = hourly.slice(0, 96).map((h, i) => ({
    time: h.time,
    usAqi: Math.round(55 + 25 * Math.sin(i / 7)),
    europeanAqi: Math.round(30 + 12 * Math.sin(i / 7)),
    pm2_5: round(10 + 4 * Math.sin(i / 7)),
  }));

  return { nowcast, nws, models, marine, climate, aqHourly };
}
