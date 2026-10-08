import { hex } from "../render/color.ts";

export const theme = {
  bg: hex("#0a0f16"),
  panel: hex("#101822"),
  border: hex("#223041"),
  text: hex("#e6edf3"),
  dim: hex("#7a8794"),
  faint: hex("#3a4756"),
  accent: hex("#7dd3fc"),
  accent2: hex("#c4b5fd"),
  warn: hex("#ffb74d"),
  danger: hex("#ff5252"),
  ok: hex("#69f0ae"),
} as const;

export const toHexStr = (c: readonly [number, number, number]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export const T = Object.fromEntries(
  Object.entries(theme).map(([k, v]) => [k, toHexStr(v)]),
) as Record<keyof typeof theme, string>;
