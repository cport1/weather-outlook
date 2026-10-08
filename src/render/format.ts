import { moonGlyph } from "../domain/astronomy.ts";
import { CONDITION_LABEL, conditionGlyph } from "../domain/conditions.ts";
import type { Report } from "../domain/types.ts";
import type { ReportOptions } from "../report.ts";
import { clockTime, speed, temp, windArrow } from "./units.ts";

/**
 * wttr.in-style one-liners for status bars: `--format '%c %t %w'` → `☁ 21°C ↗12km/h`.
 *
 *   %c condition glyph   %C condition text   %t temperature   %f feels like
 *   %h humidity          %w wind             %p precip chance %a US AQI
 *   %m moon phase        %S sunrise          %s sunset        %A alert count
 *   %l location          %% literal percent
 */
export const FORMAT_TOKENS = "cCtfhwpamSsAl";

const FORECAST_TOKENS = new Set(["c", "C", "t", "f", "h", "w", "p"]);

function tokens(fmt: string): string[] {
  return [...fmt.matchAll(/%(.)/g)].map((m) => m[1] ?? "");
}

/** Only fetch what the format string shows, so a tmux status line stays fast. */
export function formatNeeds(fmt: string): NonNullable<ReportOptions["include"]> {
  const t = tokens(fmt);
  return {
    forecast: t.some((k) => FORECAST_TOKENS.has(k)),
    airQuality: t.includes("a"),
    alerts: t.includes("A"),
  };
}

/** Probability of precipitation for the hour containing `now`, else today's max. */
function precipChance(report: Report, now: number): number | undefined {
  const fc = report.forecast;
  if (!fc) return undefined;
  const idx = fc.hourly.findIndex((h) => new Date(h.time).getTime() > now) - 1;
  const hour = fc.hourly[Math.max(0, idx)];
  return hour?.precipitationProbability ?? fc.daily[0]?.precipitationProbability;
}

export function renderFormat(fmt: string, report: Report, now = Date.now()): string {
  const c = report.forecast?.current;
  const u = report.units;
  const tz = report.location.timezone;
  const astro = report.astronomy;
  const tight = (s: string) => s.replace(" ", "");
  return fmt.replace(/%(.)/g, (whole, k: string) => {
    switch (k) {
      case "%":
        return "%";
      case "c":
        return c ? conditionGlyph(c.condition, c.isDay) : "?";
      case "C":
        return c ? CONDITION_LABEL[c.condition] : "--";
      case "t":
        return c ? temp(c.temperature, u) : "--";
      case "f":
        return c ? temp(c.feelsLike ?? c.temperature, u) : "--";
      case "h":
        return c?.humidity !== undefined ? `${Math.round(c.humidity)}%` : "--";
      case "w":
        return c ? `${windArrow(c.windDirection)}${tight(speed(c.windSpeed, u))}` : "--";
      case "p": {
        const p = precipChance(report, now);
        return p !== undefined ? `${Math.round(p)}%` : "--";
      }
      case "a":
        return report.airQuality?.usAqi !== undefined
          ? String(Math.round(report.airQuality.usAqi))
          : "--";
      case "m":
        return astro ? moonGlyph(astro.moonPhase) : "";
      case "S":
        return astro?.sunrise ? clockTime(astro.sunrise, tz) : "--";
      case "s":
        return astro?.sunset ? clockTime(astro.sunset, tz) : "--";
      case "A":
        return String(report.alerts.length);
      case "l":
        return report.location.name;
      default:
        return whole;
    }
  });
}
