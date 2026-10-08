export type Units = "metric" | "imperial";
export type TempUnit = "C" | "F";
export type WindUnit = "kmh" | "mph" | "ms" | "kn" | "bft";
export type PrecipUnit = "mm" | "in";

export const TEMP_UNITS: readonly TempUnit[] = ["C", "F"];
export const WIND_UNITS: readonly WindUnit[] = ["kmh", "mph", "ms", "kn", "bft"];
export const PRECIP_UNITS: readonly PrecipUnit[] = ["mm", "in"];

/**
 * Per-measure overrides on top of the metric/imperial system
 * (`--temp C --wind kn --precip mm`, `--hour24`). Set once at startup;
 * every formatter below consults them so renderers only pass the system.
 */
export interface UnitOverrides {
  temp?: TempUnit;
  wind?: WindUnit;
  precip?: PrecipUnit;
  hour12?: boolean;
}

let overrides: UnitOverrides = {};

export function setUnitOverrides(o: UnitOverrides): void {
  overrides = { ...o };
}

export function getUnitOverrides(): UnitOverrides {
  return overrides;
}

export function tempUnit(units: Units): TempUnit {
  return overrides.temp ?? (units === "imperial" ? "F" : "C");
}

export function windUnit(units: Units): WindUnit {
  return overrides.wind ?? (units === "imperial" ? "mph" : "kmh");
}

export function precipUnit(units: Units): PrecipUnit {
  return overrides.precip ?? (units === "imperial" ? "in" : "mm");
}

export function temp(c: number, units: Units, withUnit = true): string {
  if (!Number.isFinite(c)) return "--";
  const u = tempUnit(units);
  const v = u === "F" ? (c * 9) / 5 + 32 : c;
  return `${Math.round(v)}°${withUnit ? u : ""}`;
}

/** Beaufort force (0-12) for a wind speed in km/h. */
export function beaufort(kmh: number): number {
  const limits = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const i = limits.findIndex((l) => kmh < l);
  return i === -1 ? 12 : i;
}

export function speed(kmh: number | undefined, units: Units): string {
  if (kmh === undefined) return "--";
  switch (windUnit(units)) {
    case "mph":
      return `${Math.round(kmh * 0.621371)} mph`;
    case "ms": {
      const ms = kmh / 3.6;
      return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} m/s`;
    }
    case "kn":
      return `${Math.round(kmh / 1.852)} kn`;
    case "bft":
      return `${beaufort(kmh)} Bft`;
    default:
      return `${Math.round(kmh)} km/h`;
  }
}

export function precip(mm: number | undefined, units: Units): string {
  if (mm === undefined) return "--";
  return precipUnit(units) === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}

export function distance(m: number | undefined, units: Units): string {
  if (m === undefined) return "--";
  return units === "imperial"
    ? `${(m / 1609.344).toFixed(m < 16_000 ? 1 : 0)} mi`
    : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function pressure(hpa: number | undefined, units: Units): string {
  if (hpa === undefined) return "--";
  return units === "imperial" ? `${(hpa * 0.02953).toFixed(2)} inHg` : `${Math.round(hpa)} hPa`;
}

type Env = Record<string, string | undefined>;

/** BCP 47 locale from POSIX env (`de_DE.UTF-8` → `de-DE`); Bun's Intl ignores LANG. */
export function envLocale(env: Env = process.env): string | undefined {
  const raw = env.LC_ALL || env.LC_TIME || env.LANG;
  if (!raw || raw === "C" || raw === "POSIX") return undefined;
  const tag = raw.split(".")[0]?.split("@")[0]?.replace("_", "-");
  try {
    return tag ? Intl.getCanonicalLocales(tag)[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the user's locale writes times on a 12-hour clock. */
export function localeHour12(env: Env = process.env): boolean {
  const locale = envLocale(env) ?? "en-US";
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? true;
  } catch {
    return true;
  }
}

/** 12h vs 24h clock: `--hour12/--hour24` override, else the locale's convention. */
export function hour12(): boolean {
  return overrides.hour12 ?? localeHour12();
}

/** Clock time like "6:42 PM" or "18:42" in the location's timezone. */
export function clockTime(iso: string | Date, tz?: string, withMinutes = true): string {
  const h12 = hour12();
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: h12 ? "numeric" : "2-digit",
    // A bare "18" reads as a number, so the 24h clock always shows minutes.
    minute: withMinutes || !h12 ? "2-digit" : undefined,
    hourCycle: h12 ? "h12" : "h23",
    timeZone: tz,
  });
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
const ARROWS = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];

export function compass(deg: number | undefined): string {
  if (deg === undefined) return "";
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] ?? "";
}

/** Arrow pointing where the wind is blowing *to* (meteorological direction is where it's from). */
export function windArrow(deg: number | undefined): string {
  if (deg === undefined) return "·";
  return ARROWS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] ?? "·";
}

/** Default units by country: imperial for the US and a few others. */
export function defaultUnits(countryCode?: string): Units {
  return ["US", "LR", "MM", "PR", "GU", "VI", "AS", "MP"].includes(countryCode?.toUpperCase() ?? "")
    ? "imperial"
    : "metric";
}
