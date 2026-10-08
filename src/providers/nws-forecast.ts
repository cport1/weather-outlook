import type { Nws, NwsGridExtras, NwsObservation, NwsPeriod } from "../domain/details.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * NWS forecast products for a US point: the text forecast periods, the
 * latest observation from the nearest station, a few gridded extras
 * (HeatRisk, lightning, snowfall) and the Area Forecast Discussion.
 * `/points` is resolved once per location and cached for weeks.
 */

const API = "https://api.weather.gov";

interface PointsResponse {
  properties: {
    cwa?: string;
    type?: string;
    gridId?: string;
    gridX?: number;
    gridY?: number;
    forecast?: string | null;
    forecastGridData?: string | null;
    observationStations?: string | null;
  };
}

interface Quantity {
  value: number | null;
  unitCode?: string;
}

interface ForecastResponse {
  properties: {
    periods: Array<{
      name: string;
      startTime: string;
      endTime?: string;
      isDaytime: boolean;
      temperature?: number | null;
      temperatureUnit?: string;
      probabilityOfPrecipitation?: Quantity | null;
      windSpeed?: string;
      windDirection?: string;
      shortForecast: string;
      detailedForecast: string;
    }>;
  };
}

interface GridLayer {
  uom?: string;
  values: Array<{ validTime: string; value: number | null }>;
}

interface GridResponse {
  properties: Partial<Record<"heatRisk" | "lightningActivityLevel" | "snowfallAmount", GridLayer>>;
}

interface StationsResponse {
  features: Array<{ id: string; properties: { stationIdentifier: string; name?: string } }>;
}

interface ObservationResponse {
  properties: {
    station?: string;
    stationId?: string;
    stationName?: string;
    timestamp: string;
    textDescription?: string;
    temperature?: Quantity;
    dewpoint?: Quantity;
    relativeHumidity?: Quantity;
    windSpeed?: Quantity;
    windGust?: Quantity;
    windDirection?: Quantity;
    barometricPressure?: Quantity;
    seaLevelPressure?: Quantity;
    visibility?: Quantity;
  };
}

interface ProductListResponse {
  "@graph"?: Array<{ id: string; issuanceTime: string; issuingOffice?: string }>;
}

interface ProductResponse {
  id: string;
  issuanceTime: string;
  issuingOffice?: string;
  productText: string;
}

const fToC = (f: number) => ((f - 32) * 5) / 9;
const val = (q: Quantity | null | undefined): number | undefined =>
  q && typeof q.value === "number" && Number.isFinite(q.value) ? q.value : undefined;

export function parsePeriods(raw: ForecastResponse): NwsPeriod[] {
  return raw.properties.periods.map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    isDaytime: p.isDaytime,
    temperature:
      typeof p.temperature === "number"
        ? p.temperatureUnit === "C"
          ? p.temperature
          : fToC(p.temperature)
        : undefined,
    precipitationProbability: val(p.probabilityOfPrecipitation),
    wind: [p.windDirection, p.windSpeed].filter(Boolean).join(" ") || undefined,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
  }));
}

/** Parse an ISO 8601 duration like `P2DT10H` or `PT6H` into milliseconds. */
export function isoDurationMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return 0;
  const [, days, h, min, s] = m;
  return (
    ((Number(days ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * 60_000 +
    Number(s ?? 0) * 1000
  );
}

/** Expand a grid layer into [startMs, endMs, value] intervals. */
function intervals(layer: GridLayer | undefined): Array<[number, number, number]> {
  if (!layer) return [];
  const out: Array<[number, number, number]> = [];
  for (const v of layer.values) {
    if (typeof v.value !== "number") continue;
    const [start, dur] = v.validTime.split("/");
    const t = Date.parse(start ?? "");
    if (!Number.isFinite(t)) continue;
    out.push([t, t + isoDurationMs(dur ?? ""), v.value]);
  }
  return out;
}

export function summarizeGrid(raw: GridResponse, now = Date.now()): NwsGridExtras {
  const out: NwsGridExtras = {};
  const week = now + 7 * 86_400_000;
  for (const [s, e, v] of intervals(raw.properties.heatRisk)) {
    if (e <= now || s >= week) continue;
    if (out.heatRiskMax === undefined || v > out.heatRiskMax) {
      out.heatRiskMax = v;
      out.heatRiskDate = new Date(Math.max(s, now)).toISOString();
    }
  }
  const twoDays = now + 2 * 86_400_000;
  for (const [s, e, v] of intervals(raw.properties.lightningActivityLevel)) {
    if (e <= now || s >= twoDays) continue;
    out.lightningMax = Math.max(out.lightningMax ?? 0, v);
  }
  const snow = intervals(raw.properties.snowfallAmount);
  if (snow.length) {
    const day = now + 86_400_000;
    let next24 = 0;
    let total = 0;
    for (const [s, e, v] of snow) {
      if (e <= now) continue;
      total += v;
      // Pro-rate amounts whose interval straddles the 24 h boundary.
      const overlap = Math.max(0, Math.min(e, day) - Math.max(s, now));
      next24 += e > s ? (v * overlap) / (e - s) : 0;
    }
    out.snowfall24h = Math.round(next24 * 10) / 10;
    out.snowfallTotal = Math.round(total * 10) / 10;
  }
  return out;
}

export function parseObservation(raw: ObservationResponse): NwsObservation {
  const p = raw.properties;
  const pa = val(p.seaLevelPressure) ?? val(p.barometricPressure);
  return {
    station: p.stationId ?? p.station?.split("/").pop() ?? "?",
    stationName: p.stationName,
    time: p.timestamp,
    description: p.textDescription || undefined,
    temperature: val(p.temperature),
    dewPoint: val(p.dewpoint),
    humidity: val(p.relativeHumidity),
    windSpeed: val(p.windSpeed),
    windGust: val(p.windGust),
    windDirection: val(p.windDirection),
    pressure: pa !== undefined ? pa / 100 : undefined,
    visibility: val(p.visibility),
  };
}

/** Strip the WMO header and collapse NWS hard-wrapped paragraphs. */
export function cleanDiscussion(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  // Products start with "000", the WMO header and the AWIPS id; drop up to the title.
  const start = lines.findIndex((l) => /Area Forecast Discussion/i.test(l));
  const body = (start >= 0 ? lines.slice(start) : lines).join("\n");
  return body
    .replace(/\n\$\$[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Undo the ~66-column hard wrap of NWS text products so they re-wrap to the
 * panel width. Section headers (".SHORT TERM..."), bullets and indented or
 * short lines (tables, signatures) keep their line breaks.
 */
export function reflow(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const continues =
      prev !== undefined &&
      prev.length >= 50 &&
      !prev.startsWith(".") &&
      line.trim() !== "" &&
      !/^(\s|-|\.|&&|\$\$)/.test(line);
    if (continues) out[out.length - 1] = `${prev} ${line}`;
    else out.push(line);
  }
  return out.join("\n");
}

async function latestObservation(
  http: HttpClient,
  stationsUrl: string,
): Promise<NwsObservation | undefined> {
  const stations = await http.json<StationsResponse>(`${stationsUrl}?limit=3`, {
    ttlMs: 7 * 86_400_000,
  });
  // The closest station sometimes reports nothing useful; try the next one.
  for (const f of stations.features.slice(0, 2)) {
    try {
      const obs = parseObservation(
        await http.json<ObservationResponse>(`${f.id}/observations/latest`, { ttlMs: 10 * 60_000 }),
      );
      obs.stationName ??= f.properties.name;
      if (obs.temperature !== undefined) return obs;
    } catch {
      // try the next station
    }
  }
  return undefined;
}

async function discussion(http: HttpClient, cwa: string): Promise<Nws["discussion"]> {
  const list = await http.json<ProductListResponse>(
    `${API}/products?type=AFD&location=${encodeURIComponent(cwa)}&limit=1`,
    { ttlMs: 15 * 60_000 },
  );
  const first = list["@graph"]?.[0];
  if (!first) return undefined;
  const product = await http.json<ProductResponse>(`${API}/products/${first.id}`, {
    ttlMs: 7 * 86_400_000,
  });
  return {
    issued: product.issuanceTime,
    office: product.issuingOffice ?? cwa,
    text: cleanDiscussion(product.productText),
  };
}

const settle = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try {
    return await p;
  } catch {
    return undefined;
  }
};

export async function fetchNwsDetails(http: HttpClient, lat: number, lon: number): Promise<Nws> {
  const points = await http.json<PointsResponse>(
    `${API}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { ttlMs: 30 * 86_400_000 },
  );
  const p = points.properties;
  const cwa = p.cwa ?? p.gridId ?? "";
  // Over water /points answers type "marine" with no land forecast (MarineForecastNotSupported).
  const [periods, grid, observation, afd] = await Promise.all([
    p.forecast
      ? http.json<ForecastResponse>(p.forecast, { ttlMs: 30 * 60_000 }).then(parsePeriods)
      : Promise.resolve([]),
    p.forecastGridData
      ? settle(
          http
            .json<GridResponse>(p.forecastGridData, { ttlMs: 60 * 60_000, timeoutMs: 20_000 })
            .then((g) => summarizeGrid(g)),
        )
      : Promise.resolve(undefined),
    p.observationStations
      ? settle(latestObservation(http, p.observationStations))
      : Promise.resolve(undefined),
    cwa ? settle(discussion(http, cwa)) : Promise.resolve(undefined),
  ]);
  return {
    provider: "nws",
    office: cwa,
    gridId: p.gridId,
    gridX: p.gridX,
    gridY: p.gridY,
    pointType: p.type,
    periods,
    observation,
    extras: grid,
    discussion: afd,
  };
}
