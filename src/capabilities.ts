/**
 * Single source of truth for what the current terminal can do.
 * Every renderer asks this module instead of sniffing env vars itself.
 */

export type ColorLevel = 0 | 1 | 2 | 3; // none | 16 | 256 | truecolor
export type ImageProtocol = "kitty" | "sixel" | "iterm" | "blocks";

export interface Capabilities {
  isTTY: boolean;
  color: ColorLevel;
  unicode: boolean;
  motion: boolean;
  images: ImageProtocol;
  columns: number;
  rows: number;
}

export interface CapabilityOverrides {
  color?: boolean;
  motion?: boolean;
}

type Env = Record<string, string | undefined>;

export function detectColor(env: Env, isTTY: boolean, override?: boolean): ColorLevel {
  if (override === false) return 0;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    const n = Number(force);
    if (n === 1 || n === 2 || n === 3) return n;
    return 3;
  }
  if (override === true) return 3;
  if (!isTTY || env.TERM === "dumb") return 0;
  const ct = env.COLORTERM?.toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  const tp = env.TERM_PROGRAM;
  if (tp === "iTerm.app" || tp === "WezTerm" || tp === "ghostty" || tp === "vscode") return 3;
  if (env.TERM?.includes("kitty") || env.TERM?.includes("ghostty")) return 3;
  if (env.WT_SESSION) return 3;
  if (env.TERM?.includes("256")) return 2;
  return 1;
}

export function detectImages(env: Env): ImageProtocol {
  if (env.KITTY_WINDOW_ID || env.TERM?.includes("kitty") || env.TERM_PROGRAM === "ghostty") {
    return "kitty";
  }
  if (env.TERM_PROGRAM === "WezTerm") return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (env.TERM?.includes("foot") || env.TERM === "mlterm") return "sixel";
  return "blocks";
}

export function detectCapabilities(
  overrides: CapabilityOverrides = {},
  env: Env = process.env,
  stream: { isTTY?: boolean; columns?: number; rows?: number } = process.stdout,
): Capabilities {
  const isTTY = Boolean(stream.isTTY);
  const color = detectColor(env, isTTY, overrides.color);
  const lang = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`.toLowerCase();
  const unicode = process.platform !== "win32" ? lang === "" || lang.includes("utf") : true;
  const motion =
    overrides.motion ?? (isTTY && !env.CI && env.WEATHER_OUTLOOK_REDUCE_MOTION === undefined);
  return {
    isTTY,
    color,
    unicode,
    motion,
    images: detectImages(env),
    columns: stream.columns ?? 100,
    rows: stream.rows ?? 30,
  };
}
