/**
 * Single source of truth for what the current terminal can do.
 * Every renderer asks this module instead of sniffing env vars itself.
 *
 * Detection here is env-only on purpose: the dashboard gets active Kitty/Sixel
 * probing (DA1 and friends) from OpenTUI's renderer, and one-shot output must
 * never block waiting on a terminal reply that pipes and CI will not send.
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

/**
 * Whether braille, block elements and symbols will render. On Windows the
 * legacy conhost window (no WT_SESSION) uses raster/console fonts without
 * braille, while Windows Terminal, VS Code, ConEmu and mintty are fine.
 * Elsewhere a non-UTF-8 locale or the Linux VT console are the red flags.
 */
export function detectUnicode(env: Env, platform: string = process.platform): boolean {
  if (env.WEATHER_OUTLOOK_ASCII !== undefined && env.WEATHER_OUTLOOK_ASCII !== "0") return false;
  if (platform === "win32") {
    return Boolean(
      env.WT_SESSION ||
        env.TERM_PROGRAM === "vscode" ||
        env.ConEmuANSI === "ON" ||
        env.TERM_PROGRAM === "mintty" ||
        env.TERM?.startsWith("xterm") ||
        env.ALACRITTY_LOG ||
        env.WEZTERM_EXECUTABLE,
    );
  }
  if (env.TERM === "linux") return false;
  const lang = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`.toLowerCase();
  return lang === "" || lang.includes("utf");
}

export function detectCapabilities(
  overrides: CapabilityOverrides = {},
  env: Env = process.env,
  stream: { isTTY?: boolean; columns?: number; rows?: number } = process.stdout,
): Capabilities {
  const isTTY = Boolean(stream.isTTY);
  const color = detectColor(env, isTTY, overrides.color);
  const unicode = detectUnicode(env);
  const motion =
    overrides.motion ?? (isTTY && !env.CI && env.WEATHER_OUTLOOK_REDUCE_MOTION === undefined);
  return {
    isTTY,
    color,
    unicode,
    motion,
    images: detectImages(env),
    // Pipes have no size; fall back to $COLUMNS/$LINES like most CLIs.
    columns: stream.columns ?? (Number(env.COLUMNS) || 100),
    rows: stream.rows ?? (Number(env.LINES) || 30),
  };
}
