import { z } from "zod";

/**
 * Optional "details" sections of the report: NWS text products, model
 * comparison, marine, climate context and the precipitation nowcast.
 * Every field is optional so older consumers of `--json` keep working.
 * All values are metric/SI, like the rest of the domain model.
 */

export const NwsPeriod = z.object({
  name: z.string(),
  startTime: z.string(),
  endTime: z.string().optional(),
  isDaytime: z.boolean(),
  /** °C (NWS publishes °F for the US; converted on parse). */
  temperature: z.number().optional(),
  precipitationProbability: z.number().optional(),
  wind: z.string().optional(),
  shortForecast: z.string(),
  detailedForecast: z.string(),
});
export type NwsPeriod = z.infer<typeof NwsPeriod>;

export const NwsObservation = z.object({
  station: z.string(),
  stationName: z.string().optional(),
  time: z.string(),
  description: z.string().optional(),
  temperature: z.number().optional(),
  dewPoint: z.number().optional(),
  humidity: z.number().optional(),
  windSpeed: z.number().optional(),
  windGust: z.number().optional(),
  windDirection: z.number().optional(),
  /** hPa */
  pressure: z.number().optional(),
  /** metres */
  visibility: z.number().optional(),
});
export type NwsObservation = z.infer<typeof NwsObservation>;

export const NwsGridExtras = z.object({
  /** NWS HeatRisk 0 (none) – 4 (extreme): the highest level in the next 7 days. */
  heatRiskMax: z.number().optional(),
  heatRiskDate: z.string().optional(),
  /** Lightning activity level 1–6 (highest in the next 48 h). */
  lightningMax: z.number().optional(),
  /** Snowfall in mm over the next 24 h / whole grid period. */
  snowfall24h: z.number().optional(),
  snowfallTotal: z.number().optional(),
});
export type NwsGridExtras = z.infer<typeof NwsGridExtras>;

export const Nws = z.object({
  provider: z.literal("nws"),
  office: z.string(),
  gridId: z.string().optional(),
  gridX: z.number().optional(),
  gridY: z.number().optional(),
  pointType: z.string().optional(),
  periods: z.array(NwsPeriod),
  observation: NwsObservation.optional(),
  extras: NwsGridExtras.optional(),
  discussion: z.object({ issued: z.string(), office: z.string(), text: z.string() }).optional(),
});
export type Nws = z.infer<typeof Nws>;

export const ModelSeries = z.object({
  id: z.string(),
  label: z.string(),
  /** °C, aligned with `ModelComparison.times`; null where the model has no value. */
  temperature: z.array(z.number().nullable()),
});
export type ModelSeries = z.infer<typeof ModelSeries>;

export const ModelComparison = z.object({
  times: z.array(z.string()),
  models: z.array(ModelSeries),
  ensemble: z
    .object({
      model: z.string(),
      members: z.number(),
      min: z.array(z.number().nullable()),
      max: z.array(z.number().nullable()),
      mean: z.array(z.number().nullable()),
    })
    .optional(),
  confidence: z
    .object({
      /** 0–100. */
      score: z.number(),
      label: z.enum(["high", "moderate", "low"]),
      /** Mean ensemble standard deviation (°C) over the scored window. */
      spread: z.number(),
      /** Mean max-minus-min across deterministic models (°C). */
      modelSpread: z.number().optional(),
      hours: z.number(),
    })
    .optional(),
});
export type ModelComparison = z.infer<typeof ModelComparison>;

export const WavePoint = z.object({
  time: z.string(),
  /** metres */
  height: z.number().optional(),
  /** seconds */
  period: z.number().optional(),
  direction: z.number().optional(),
  /** °C */
  seaSurfaceTemperature: z.number().optional(),
});
export type WavePoint = z.infer<typeof WavePoint>;

export const TideEvent = z.object({
  time: z.string(),
  /** metres above MLLW */
  height: z.number(),
  type: z.enum(["high", "low"]),
});
export type TideEvent = z.infer<typeof TideEvent>;

export const Marine = z.object({
  waves: z
    .object({ provider: z.string(), current: WavePoint, hourly: z.array(WavePoint) })
    .optional(),
  tides: z
    .object({
      provider: z.literal("noaa-coops"),
      station: z.object({
        id: z.string(),
        name: z.string(),
        lat: z.number(),
        lon: z.number(),
        distanceKm: z.number(),
      }),
      events: z.array(TideEvent),
      curve: z.array(z.object({ time: z.string(), height: z.number() })),
    })
    .optional(),
  buoy: z
    .object({
      provider: z.literal("ndbc"),
      id: z.string(),
      lat: z.number(),
      lon: z.number(),
      distanceKm: z.number(),
      time: z.string(),
      windDirection: z.number().optional(),
      /** km/h */
      windSpeed: z.number().optional(),
      windGust: z.number().optional(),
      waveHeight: z.number().optional(),
      dominantPeriod: z.number().optional(),
      waveDirection: z.number().optional(),
      pressure: z.number().optional(),
      airTemperature: z.number().optional(),
      waterTemperature: z.number().optional(),
    })
    .optional(),
});
export type Marine = z.infer<typeof Marine>;

export const ClimateDay = z.object({
  date: z.string(),
  normalHigh: z.number(),
  normalLow: z.number(),
  /** Forecast minus normal (°C). */
  highAnomaly: z.number().optional(),
  lowAnomaly: z.number().optional(),
  /** Percentile (0–100) of the forecast value among historical values for this date. */
  highPercentile: z.number().optional(),
  lowPercentile: z.number().optional(),
});
export type ClimateDay = z.infer<typeof ClimateDay>;

export const Climate = z.object({
  provider: z.string(),
  startYear: z.number(),
  endYear: z.number(),
  days: z.array(ClimateDay),
  recordHigh: z.object({ value: z.number(), year: z.number() }).optional(),
  recordLow: z.object({ value: z.number(), year: z.number() }).optional(),
  /** e.g. "Warmest Oct 7 since 2015". */
  fact: z.string().optional(),
});
export type Climate = z.infer<typeof Climate>;

export const NowcastPoint = z.object({
  time: z.string(),
  /** Precipitation rate in mm/h. */
  rate: z.number(),
  snow: z.boolean().optional(),
});
export type NowcastPoint = z.infer<typeof NowcastPoint>;

export const Nowcast = z.object({
  provider: z.string(),
  /** Minutes between points. */
  interval: z.number(),
  points: z.array(NowcastPoint),
  headline: z.string(),
});
export type Nowcast = z.infer<typeof Nowcast>;

export const AqHourlyPoint = z.object({
  time: z.string(),
  usAqi: z.number().optional(),
  europeanAqi: z.number().optional(),
  pm2_5: z.number().optional(),
});
export type AqHourlyPoint = z.infer<typeof AqHourlyPoint>;

export const AqStation = z.object({
  provider: z.literal("openaq"),
  id: z.number(),
  name: z.string(),
  distanceKm: z.number().optional(),
  time: z.string().optional(),
  /** parameter name (pm25, o3, …) → { value, units } */
  readings: z.record(z.string(), z.object({ value: z.number(), units: z.string() })),
});
export type AqStation = z.infer<typeof AqStation>;
