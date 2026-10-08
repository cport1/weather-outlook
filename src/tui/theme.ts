import { createSignal } from "solid-js";
import { hex, type RGB } from "../render/color.ts";

/**
 * Theme tokens. `theme` (RGB tuples, for canvases) and `T` (hex strings, for
 * JSX props) keep their original shape, but every property is a getter that
 * reads the active palette. The active palette lives in a Solid signal, so JSX
 * that reads `T.x` re-renders when the theme changes and canvases pick it up
 * on their next frame.
 */
export const THEME_NAMES = ["midnight", "daylight", "solarized", "mono"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

const TOKENS = [
  "bg",
  "panel",
  "border",
  "text",
  "dim",
  "faint",
  "accent",
  "accent2",
  "warn",
  "danger",
  "ok",
] as const;
type Token = (typeof TOKENS)[number];
type Palette = Record<Token, string>;

const PALETTES: Record<ThemeName, Palette> = {
  midnight: {
    bg: "#0a0f16",
    panel: "#101822",
    border: "#223041",
    text: "#e6edf3",
    dim: "#7a8794",
    faint: "#3a4756",
    accent: "#7dd3fc",
    accent2: "#c4b5fd",
    warn: "#ffb74d",
    danger: "#ff5252",
    ok: "#69f0ae",
  },
  daylight: {
    bg: "#f6f8fa",
    panel: "#e4e9ef",
    border: "#b8c4d0",
    text: "#1b2733",
    dim: "#5a6876",
    faint: "#a3b0bd",
    accent: "#0969da",
    accent2: "#8250df",
    warn: "#bc4c00",
    danger: "#cf222e",
    ok: "#1a7f37",
  },
  solarized: {
    bg: "#002b36",
    panel: "#073642",
    border: "#30525c",
    text: "#eee8d5",
    dim: "#93a1a1",
    faint: "#4f6b73",
    accent: "#2aa198",
    accent2: "#6c71c4",
    warn: "#b58900",
    danger: "#dc322f",
    ok: "#859900",
  },
  mono: {
    bg: "#000000",
    panel: "#1c1c1c",
    border: "#5a5a5a",
    text: "#ffffff",
    dim: "#a8a8a8",
    faint: "#4a4a4a",
    accent: "#ffffff",
    accent2: "#d0d0d0",
    warn: "#ffffff",
    danger: "#ffffff",
    ok: "#d0d0d0",
  },
};

const parsed = Object.fromEntries(
  THEME_NAMES.map((n) => [
    n,
    Object.fromEntries(TOKENS.map((k) => [k, hex(PALETTES[n][k])])) as Record<Token, RGB>,
  ]),
) as Record<ThemeName, Record<Token, RGB>>;

const [active, setActive] = createSignal<ThemeName>("midnight");

export function isThemeName(s: string | undefined): s is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(s ?? "");
}

/** NO_COLOR (https://no-color.org) forces the mono theme whatever was asked for. */
export function noColor(env: Record<string, string | undefined> = process.env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

/** Pick the theme from an explicit option, then WEATHER_OUTLOOK_THEME, then the default. */
export function resolveThemeName(
  requested?: string,
  env: Record<string, string | undefined> = process.env,
): ThemeName {
  if (noColor(env)) return "mono";
  if (isThemeName(requested)) return requested;
  const fromEnv = env.WEATHER_OUTLOOK_THEME?.toLowerCase();
  return isThemeName(fromEnv) ? fromEnv : "midnight";
}

export function setTheme(name: ThemeName): void {
  setActive(name);
}

export const themeName = active;

/** True when the palette should be rendered without hue (mono theme / NO_COLOR). */
export const isMono = () => active() === "mono";

export function cycleTheme(): ThemeName {
  if (isMono() && noColor()) return "mono";
  const next = THEME_NAMES[(THEME_NAMES.indexOf(active()) + 1) % THEME_NAMES.length] ?? "midnight";
  setActive(next);
  return next;
}

/** Luma-preserving grayscale, used to drain hue from data colors in mono mode. */
export function gray(c: RGB): RGB {
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return [l, l, l];
}

/** Data colors (temperature scale, severity…) pass through here so mono can strip hue. */
export function paint(c: RGB): RGB {
  return isMono() ? gray(c) : c;
}

export const toHexStr = (c: readonly [number, number, number]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export const theme = {} as { readonly [K in Token]: RGB };
export const T = {} as { readonly [K in Token]: string };
for (const k of TOKENS) {
  Object.defineProperty(theme, k, { enumerable: true, get: () => parsed[active()][k] });
  Object.defineProperty(T, k, { enumerable: true, get: () => PALETTES[active()][k] });
}

/** Light themes need darker data colors and sky tones; views can ask. */
export const isLight = () => active() === "daylight";
