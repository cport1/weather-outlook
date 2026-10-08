import type { Condition } from "../domain/types.ts";
import { hex, type RGB } from "./color.ts";

/**
 * Multi-line condition art (wego-style, 5 rows × 13 cols).
 * Each line is a list of [text, color] runs so the renderer can paint them.
 */
export type ArtRun = readonly [string, RGB | undefined];
export type Art = ArtRun[][];

const SUN = hex("#ffd54f");
const MOON = hex("#e0e6f0");
const CLOUD = hex("#cfd8dc");
const DARK = hex("#78909c");
const RAIN = hex("#4fc3f7");
const SNOW = hex("#ffffff");
const BOLT = hex("#ffeb3b");
const FOG = hex("#90a4ae");

const r = (text: string, color?: RGB): ArtRun => [text, color];

function sun(isDay: boolean): Art {
  if (!isDay)
    return [
      [r("     _..._   ", MOON)],
      [r("   .' .::::. ", MOON)],
      [r("  :  ::::::  ", MOON)],
      [r("  :  ::::::  ", MOON)],
      [r("   `. '::::' ", MOON)],
    ];
  return [
    [r("    \\   /    ", SUN)],
    [r("     .-.     ", SUN)],
    [r("  ― (   ) ―  ", SUN)],
    [r("     `-'     ", SUN)],
    [r("    /   \\    ", SUN)],
  ];
}

function partly(isDay: boolean): Art {
  const c = isDay ? SUN : MOON;
  return [
    [r("   \\  /      ", c)],
    [r(' _ /""', c), r(".-.    ", CLOUD)],
    [r("   \\_", c), r("(   ).  ", CLOUD)],
    [r("   /", c), r("(___(__) ", CLOUD)],
    [r("             ")],
  ];
}

const cloudTop = (c: RGB): ArtRun[][] => [
  [r("     .--.    ", c)],
  [r("  .-(    ).  ", c)],
  [r(" (___.__)__) ", c)],
];

function precipLines(kind: "rain" | "heavy" | "snow" | "sleet" | "drizzle"): ArtRun[][] {
  switch (kind) {
    case "drizzle":
      return [[r("   ‘ ‘ ‘ ‘   ", RAIN)], [r("  ‘ ‘ ‘ ‘    ", RAIN)]];
    case "rain":
      return [[r("   ‚‘‚‘‚‘‚‘  ", RAIN)], [r("   ‚’‚’‚’‚’  ", RAIN)]];
    case "heavy":
      return [[r("  ‚‘‚‘‚‘‚‘‚  ", RAIN)], [r("  ‚’‚’‚’‚’‚  ", RAIN)]];
    case "snow":
      return [[r("   *  *  *   ", SNOW)], [r("  *  *  *    ", SNOW)]];
    case "sleet":
      return [[r("   ‘ * ‘ *   ", RAIN)], [r("  * ‘ * ‘    ", SNOW)]];
  }
}

const SUN_ALT: Art = [
  [r("      |      ", SUN)],
  [r("   \\ .-. /   ", SUN)],
  [r("  - (   ) -  ", SUN)],
  [r("   / `-' \\   ", SUN)],
  [r("      |      ", SUN)],
];

const rotate = (s: string, n: number): string => {
  const chars = [...s];
  const k = ((n % chars.length) + chars.length) % chars.length;
  return [...chars.slice(chars.length - k), ...chars.slice(0, chars.length - k)].join("");
};

const isCloud = (c: RGB | undefined) => c === CLOUD || c === DARK;
const isPrecip = (c: RGB | undefined) => c === RAIN || c === SNOW;

/** Nudge cloud runs one column right (only where the run has trailing room). */
function driftClouds(row: ArtRun[]): ArtRun[] {
  return row.map(([text, color]) =>
    isCloud(color) && text.endsWith(" ") ? r(` ${text.slice(0, -1)}`, color) : r(text, color),
  );
}

/**
 * Animated variant of {@link conditionArt}. Frame 0 is the static art; later
 * frames spin sun rays, drift clouds, make rain/snow fall, flicker bolts and
 * roll fog. Hosts advance `frame` a couple of times per second.
 */
export function conditionArtFrame(c: Condition, isDay: boolean, frame: number): Art {
  const base = conditionArt(c, isDay);
  if (frame === 0) return base;
  if (c === "clear" && isDay) return frame % 2 ? SUN_ALT : base;
  if (c === "clear") {
    // A star twinkles beside the moon.
    const star = ["✦", "·", " ", "+"][frame % 4] ?? " ";
    return base.map((row, i) =>
      i === 1 ? [r(` ${star}`, SNOW), r([...(row[0]?.[0] ?? "")].slice(2).join(""), MOON)] : row,
    );
  }
  if (c === "fog") {
    return base.map((row, i) =>
      row.map(([t, col]) => r(rotate(t, i % 2 ? frame % 2 : -(frame % 2)), col)),
    );
  }
  const drift = Math.floor(frame / 2) % 2 === 1;
  const flicker = frame % 4;
  return base.map((row, i) => {
    let out = drift ? driftClouds(row) : row;
    out = out.map(([t, col]) => {
      if (isPrecip(col)) return r(rotate(t, frame % 2 ? 1 : 0), col);
      if (t === "⚡") {
        if (flicker === 3) return r(" ", col);
        return r(t, flicker === 1 ? SNOW : col);
      }
      return r(t, col);
    });
    // Falling precipitation: the two precip rows trade places on odd frames.
    if (
      i >= 3 &&
      frame % 2 &&
      out.some(([, col]) => isPrecip(col)) &&
      !out.some(([t]) => t === "⚡")
    ) {
      const other = base[i === 3 ? 4 : 3];
      if (other) return other.map(([t, col]) => r(rotate(t, 1), col));
    }
    return out;
  });
}

export function conditionArt(c: Condition, isDay = true): Art {
  switch (c) {
    case "clear":
      return sun(isDay);
    case "mostly-clear":
    case "partly-cloudy":
      return partly(isDay);
    case "cloudy":
      return [[r("             ")], ...cloudTop(CLOUD), [r("             ")]];
    case "fog":
      return [
        [r("             ")],
        [r(" _ - _ - _ - ", FOG)],
        [r("  _ - _ - _  ", FOG)],
        [r(" _ - _ - _ - ", FOG)],
        [r("             ")],
      ];
    case "drizzle":
      return [...cloudTop(CLOUD), ...precipLines("drizzle")];
    case "rain":
    case "showers":
      return [...cloudTop(CLOUD), ...precipLines("rain")];
    case "heavy-rain":
      return [...cloudTop(DARK), ...precipLines("heavy")];
    case "freezing-rain":
    case "sleet":
      return [...cloudTop(CLOUD), ...precipLines("sleet")];
    case "snow":
    case "heavy-snow":
      return [...cloudTop(CLOUD), ...precipLines("snow")];
    case "thunderstorm":
    case "hail":
      return [
        ...cloudTop(DARK),
        [r("  ‚‘", RAIN), r("⚡", BOLT), r("‘‚‘", RAIN), r("⚡", BOLT), r("‚‘  ", RAIN)],
        [r("  ‚’‚’", RAIN), r("⚡", BOLT), r("’‚’   ", RAIN)],
      ];
    default:
      return [
        [r("    .-.      ")],
        [r("     __)     ")],
        [r("    (        ")],
        [r("     `-’     ")],
        [r("      •      ")],
      ];
  }
}
