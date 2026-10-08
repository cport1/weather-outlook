import type { ColorLevel } from "../capabilities.ts";
import type { Cell } from "./canvas.ts";
import type { RGB } from "./color.ts";

/** Map RGB to the nearest xterm-256 color index. */
export function rgbTo256([r, g, b]: RGB): number {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Map RGB to one of the 16 basic ANSI colors (returns SGR fg code). */
export function rgbTo16([r, g, b]: RGB): number {
  const bright = Math.max(r, g, b) > 170 ? 60 : 0;
  const bit = (v: number) => (v > 100 ? 1 : 0);
  return 30 + bright + (bit(b) << 2) + (bit(g) << 1) + bit(r);
}

export function fgCode(c: RGB, level: ColorLevel): string {
  if (level === 3) return `38;2;${c.map(Math.round).join(";")}`;
  if (level === 2) return `38;5;${rgbTo256(c)}`;
  if (level === 1) return `${rgbTo16(c)}`;
  return "";
}

export function bgCode(c: RGB, level: ColorLevel): string {
  if (level === 3) return `48;2;${c.map(Math.round).join(";")}`;
  if (level === 2) return `48;5;${rgbTo256(c)}`;
  if (level === 1) return `${rgbTo16(c) + 10}`;
  return "";
}

export function paint(text: string, fg: RGB | undefined, level: ColorLevel, bg?: RGB): string {
  if (level === 0 || (!fg && !bg)) return text;
  const codes = [fg && fgCode(fg, level), bg && bgCode(bg, level)].filter(Boolean).join(";");
  return `\x1b[${codes}m${text}\x1b[0m`;
}

/** Serialize a cell grid to ANSI lines, emitting escape codes only when style changes. */
export function cellsToAnsi(cells: Cell[][], level: ColorLevel): string[] {
  return cells.map((line) => {
    let out = "";
    let cur = "";
    for (const cell of line) {
      const style =
        level === 0
          ? ""
          : [cell.fg && fgCode(cell.fg, level), cell.bg && bgCode(cell.bg, level)]
              .filter(Boolean)
              .join(";");
      if (style !== cur) {
        out += cur ? "\x1b[0m" : "";
        if (style) out += `\x1b[${style}m`;
        cur = style;
      }
      out += cell.ch;
    }
    if (cur) out += "\x1b[0m";
    return out;
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width, treating each code point as one column (good enough for our glyph set). */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}

/** Cut a styled string to `width` visible columns, keeping escapes balanced. */
export function truncateAnsi(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let cols = 0;
  let styled = false;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      styled = part !== "\x1b[0m";
      continue;
    }
    for (const ch of part) {
      if (cols >= width) break;
      out += ch;
      cols++;
    }
  }
  return styled ? `${out}\x1b[0m` : out;
}

export function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}
