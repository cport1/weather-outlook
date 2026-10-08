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
