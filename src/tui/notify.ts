import type { Alert } from "../domain/types.ts";

/**
 * Desktop notifications from inside the terminal via escape sequences:
 * OSC 777 (rxvt/foot/VTE/Ghostty) or OSC 9 (iTerm2, WezTerm, kitty, Windows
 * Terminal…), followed by a bell. Terminals that support neither ignore them.
 */

const ESC = "\x1b";
const BEL = "\x07";

/** Strip control characters and the OSC separator so text can't break out of the sequence. */
function clean(s: string): string {
  return s.replace(/[\x00-\x1f\x7f;]/g, " ").slice(0, 200);
}

export function prefersOsc777(env: Record<string, string | undefined> = process.env): boolean {
  const term = env.TERM ?? "";
  return /rxvt|foot/.test(term) || env.TERM_PROGRAM === "ghostty" || env.VTE_VERSION !== undefined;
}

export function notificationSequence(
  title: string,
  body: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const t = clean(title);
  const b = clean(body);
  const osc = prefersOsc777(env)
    ? `${ESC}]777;notify;${t};${b}${BEL}`
    : `${ESC}]9;${t}: ${b}${BEL}`;
  // tmux swallows OSC sequences unless wrapped in a DCS passthrough.
  const wrapped = env.TMUX ? `${ESC}Ptmux;${osc.replaceAll(ESC, ESC + ESC)}${ESC}\\` : osc;
  return `${wrapped}${BEL}`;
}

/**
 * Tracks which severe/extreme alerts were already seen and returns the new ones.
 * The first call only seeds the set so launching the dashboard doesn't notify
 * about alerts that are already on screen.
 */
export function createAlertNotifier(
  write: (s: string) => void = (s) => process.stdout.write(s),
  env: Record<string, string | undefined> = process.env,
) {
  const seen = new Set<string>();
  let seeded = false;
  return (alerts: Alert[], place: string): Alert[] => {
    const important = alerts.filter((a) => a.severity === "extreme" || a.severity === "severe");
    const fresh = important.filter((a) => !seen.has(a.id));
    for (const a of important) seen.add(a.id);
    if (!seeded) {
      seeded = true;
      return [];
    }
    for (const a of fresh) {
      write(notificationSequence(`${a.event} · ${place}`, a.headline ?? a.areas ?? a.event, env));
    }
    return fresh;
  };
}
