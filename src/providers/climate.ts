import type { Climate, ClimateDay } from "../domain/details.ts";
import type { DailyPoint, Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * Climate context from the Open-Meteo historical archive (ERA5): ~30 years
 * of daily highs/lows around each calendar day, compared with the forecast.
 */

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const YEARS = 30;
/** Days either side of the calendar date pooled into the "normal" sample. */
const WINDOW = 3;

interface ArchiveResponse {
  daily: {
    time: string[];
    temperature_2m_max: Array<number | null>;
    temperature_2m_min: Array<number | null>;
  };
}

interface Sample {
  year: number;
  /** Day offset from the target calendar date (0 = same day). */
  offset: number;
  hi: number;
  lo: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day-of-year on a fixed leap calendar, so Feb 29 has a slot. */
function doy(md: string): number {
  const d = new Date(`2000-${md}T00:00:00Z`);
  return Math.round((d.getTime() - Date.UTC(2000, 0, 1)) / 86_400_000);
}

function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 366;
  return Math.min(d, 366 - d);
}

/** Percentile rank (0–100) of `v` within `values` (mid-rank for ties). */
export function percentileRank(values: number[], v: number): number {
  if (!values.length) return 50;
  const below = values.filter((x) => x < v).length;
  const equal = values.filter((x) => x === v).length;
  return Math.round(((below + equal / 2) / values.length) * 100);
}

function index(
  raw: ArchiveResponse,
): Map<number, Array<{ year: number; doy: number; hi: number; lo: number }>> {
  const byDoy = new Map<number, Array<{ year: number; doy: number; hi: number; lo: number }>>();
  raw.daily.time.forEach((t, i) => {
    const hi = raw.daily.temperature_2m_max[i];
    const lo = raw.daily.temperature_2m_min[i];
    if (typeof hi !== "number" || typeof lo !== "number") return;
    const d = doy(t.slice(5));
    const list = byDoy.get(d) ?? [];
    list.push({ year: Number(t.slice(0, 4)), doy: d, hi, lo });
    byDoy.set(d, list);
  });
  return byDoy;
}

function samplesFor(byDoy: ReturnType<typeof index>, date: string): Sample[] {
  const target = doy(date.slice(5));
  const out: Sample[] = [];
  for (let k = -WINDOW; k <= WINDOW; k++) {
    const d = (target + k + 366) % 366;
    for (const s of byDoy.get(d) ?? []) {
      out.push({ year: s.year, offset: circularDiff(d, target), hi: s.hi, lo: s.lo });
    }
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function fmtMonthDay(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""} ${Number(date.slice(8, 10))}`;
}

/** "Warmest Oct 7 since 2015" style fact for a forecast high/low against same-date history. */
export function funFact(
  date: string,
  high: number,
  low: number,
  sameDay: Sample[],
  highPct: number,
  lowPct: number,
): string | undefined {
  const label = fmtMonthDay(date);
  const byYearDesc = [...sameDay].sort((a, b) => b.year - a.year);
  if (highPct >= 90) {
    const prev = byYearDesc.find((s) => s.hi >= high);
    if (!prev) return `Warmest ${label} in ${sameDay.length} years of records`;
    return `Warmest ${label} since ${prev.year}`;
  }
  if (lowPct <= 10) {
    const prev = byYearDesc.find((s) => s.lo <= low);
    if (!prev) return `Coldest ${label} night in ${sameDay.length} years of records`;
    return `Coldest ${label} night since ${prev.year}`;
  }
  if (highPct <= 10) {
    const prev = byYearDesc.find((s) => s.hi <= high);
    return prev ? `Coolest ${label} afternoon since ${prev.year}` : `Coolest ${label} on record`;
  }
  return undefined;
}

export function buildClimate(
  raw: ArchiveResponse,
  daily: DailyPoint[],
  span: { startYear: number; endYear: number },
): Climate {
  const byDoy = index(raw);
  const days: ClimateDay[] = [];
  for (const d of daily) {
    const samples = samplesFor(byDoy, d.date);
    if (!samples.length) continue;
    const his = samples.map((s) => s.hi);
    const los = samples.map((s) => s.lo);
    const normalHigh = mean(his);
    const normalLow = mean(los);
    const day: ClimateDay = { date: d.date, normalHigh: r1(normalHigh), normalLow: r1(normalLow) };
    if (Number.isFinite(d.tempMax)) {
      day.highAnomaly = r1(d.tempMax - normalHigh);
      day.highPercentile = percentileRank(his, d.tempMax);
    }
    if (Number.isFinite(d.tempMin)) {
      day.lowAnomaly = r1(d.tempMin - normalLow);
      day.lowPercentile = percentileRank(los, d.tempMin);
    }
    days.push(day);
  }
  const today = daily[0];
  const sameDay = today ? samplesFor(byDoy, today.date).filter((s) => s.offset === 0) : [];
  const recHi = sameDay.reduce<Sample | undefined>(
    (a, s) => (!a || s.hi > a.hi ? s : a),
    undefined,
  );
  const recLo = sameDay.reduce<Sample | undefined>(
    (a, s) => (!a || s.lo < a.lo ? s : a),
    undefined,
  );
  const first = days[0];
  const fact =
    today && first && sameDay.length
      ? funFact(
          today.date,
          today.tempMax,
          today.tempMin,
          sameDay,
          first.highPercentile ?? 50,
          first.lowPercentile ?? 50,
        )
      : undefined;
  return {
    provider: "open-meteo-archive",
    startYear: span.startYear,
    endYear: span.endYear,
    days,
    recordHigh: recHi ? { value: recHi.hi, year: recHi.year } : undefined,
    recordLow: recLo ? { value: recLo.lo, year: recLo.year } : undefined,
    fact,
  };
}

export async function fetchClimate(
  http: HttpClient,
  loc: Pick<Location, "lat" | "lon">,
  daily: DailyPoint[],
  now = new Date(),
): Promise<Climate> {
  const endYear = now.getUTCFullYear() - 1;
  const startYear = endYear - YEARS + 1;
  // ERA5 is a 0.25° grid: round coordinates so nearby lookups share one cached download.
  const params = new URLSearchParams({
    latitude: loc.lat.toFixed(2),
    longitude: loc.lon.toFixed(2),
    start_date: `${startYear}-01-01`,
    end_date: `${endYear}-12-31`,
    daily: "temperature_2m_max,temperature_2m_min",
    timezone: "auto",
  });
  const raw = await http.json<ArchiveResponse>(`${ARCHIVE_URL}?${params}`, {
    ttlMs: 30 * 86_400_000,
    timeoutMs: 30_000,
  });
  return buildClimate(raw, daily, { startYear, endYear });
}
