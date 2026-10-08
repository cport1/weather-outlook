import type { SpaceWeather } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

const BASE = "https://services.swpc.noaa.gov";

interface KpRow {
  time_tag: string;
  Kp: number;
}
type Scales = Record<
  string,
  { R?: { Scale: string | null }; S?: { Scale: string | null }; G?: { Scale: string | null } }
>;

const scaleNum = (v: string | null | undefined) =>
  v === null || v === undefined ? undefined : Number(v);

export async function fetchSpaceWeather(http: HttpClient): Promise<SpaceWeather> {
  const opts = { ttlMs: 10 * 60_000 };
  const [kp, scales, wind, mag] = await Promise.all([
    http.json<KpRow[]>(`${BASE}/products/noaa-planetary-k-index.json`, opts),
    http.json<Scales>(`${BASE}/products/noaa-scales.json`, opts),
    http.json<Array<{ proton_speed: number }>>(
      `${BASE}/products/summary/solar-wind-speed.json`,
      opts,
    ),
    http.json<Array<{ bz_gsm: number }>>(
      `${BASE}/products/summary/solar-wind-mag-field.json`,
      opts,
    ),
  ]);
  // Older SWPC files used arrays-of-arrays with a header row; current ones are objects.
  const last = kp.filter((r) => typeof r === "object" && !Array.isArray(r)).at(-1);
  const now = scales["0"];
  return {
    provider: "swpc",
    kp: last?.Kp,
    kpTime: last ? `${last.time_tag}Z` : undefined,
    solarWindSpeed: wind[0]?.proton_speed,
    bz: mag[0]?.bz_gsm,
    scales: now
      ? { R: scaleNum(now.R?.Scale), S: scaleNum(now.S?.Scale), G: scaleNum(now.G?.Scale) }
      : undefined,
  };
}

/** Rough equatorward edge of the auroral oval (geomagnetic latitude) for a given Kp. */
export function auroraLatitude(kp: number): number {
  return 66.5 - 2.0 * kp;
}
