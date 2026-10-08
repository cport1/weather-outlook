import { hex, lerp, type RGB } from "./color.ts";

/**
 * Renderer-agnostic weather particle effects. Each effect advances with
 * `step(dtMs)` and paints into a sparse cell list, so the same engine drives
 * the TUI and recorded demos/tests.
 */

export interface FxCell {
  x: number;
  y: number;
  ch: string;
  fg: RGB;
}

export type FxKind =
  | "rain"
  | "drizzle"
  | "sleet"
  | "hail"
  | "snow"
  | "storm"
  | "fog"
  | "clear-night"
  | "clear-day"
  | "none";

/** Kinds whose particles fall and splash on the ground line. */
const SPLASHING = new Set<FxKind>(["rain", "drizzle", "sleet", "hail", "storm"]);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ch: string;
  color: RGB;
  life?: number;
  /** Hail stones bounce once before melting away. */
  bounced?: boolean;
  /** Ice pellets / hail stones, as opposed to rain drops (for mixed kinds). */
  ice?: boolean;
}

interface Splash {
  x: number;
  y: number;
  age: number;
  ice: boolean;
}

const SPLASH_RAIN = ["‿", "◦", "·"];
const SPLASH_ICE = ["*", "·", "."];
const SPLASH_LIFE = 0.24;

/** Deterministic PRNG so demos and snapshot tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAIN_COLORS = [hex("#4fc3f7"), hex("#81d4fa"), hex("#29b6f6"), hex("#b3e5fc")];
const SNOW_GLYPHS = ["*", "·", "•", "❄", "✻", "."];
const STAR_GLYPHS = ["·", "·", "·", "∙", "+", "✦"];

export class WeatherFx {
  private particles: Particle[] = [];
  private splashes: Splash[] = [];
  private stars: Array<{ x: number; y: number; ch: string; phase: number }> = [];
  private flash = 0;
  private bolt: Array<{ x: number; y: number }> = [];
  private t = 0;
  private readonly rand: () => number;

  constructor(
    private width: number,
    private height: number,
    public kind: FxKind,
    /** 0..1 — scales particle density (e.g. from precipitation rate). */
    public intensity = 0.5,
    /** Horizontal wind drift in cells per second (positive = to the right). */
    public wind = 0,
    seed = 42,
  ) {
    this.rand = mulberry32(seed);
    this.seedStars();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.particles = this.particles.filter((p) => p.x < width && p.y < height);
    this.splashes = this.splashes.filter((p) => p.x < width && p.y < height);
    this.seedStars();
  }

  /** True when stepping would change nothing on screen (hosts can stop animating). */
  get idle(): boolean {
    return this.kind === "none" || this.kind === "clear-day";
  }

  /** Is a lightning flash active? Hosts can use this to brighten backgrounds. */
  get flashLevel(): number {
    return this.flash;
  }

  private seedStars(): void {
    const n = Math.floor((this.width * this.height) / 40);
    this.stars = Array.from({ length: n }, () => ({
      x: Math.floor(this.rand() * this.width),
      y: Math.floor(this.rand() * this.height * 0.7),
      ch: STAR_GLYPHS[Math.floor(this.rand() * STAR_GLYPHS.length)] ?? "·",
      phase: this.rand() * Math.PI * 2,
    }));
  }

  private targetCount(): number {
    const area = this.width * this.height;
    switch (this.kind) {
      case "rain":
        return Math.floor(area * (0.02 + 0.08 * this.intensity));
      case "drizzle":
        return Math.floor(area * (0.03 + 0.04 * this.intensity));
      case "sleet":
        return Math.floor(area * (0.03 + 0.06 * this.intensity));
      case "storm":
      case "hail":
        return Math.floor(area * (0.06 + 0.1 * this.intensity));
      case "snow":
        return Math.floor(area * (0.015 + 0.05 * this.intensity));
      case "fog":
        return Math.floor(area * 0.06);
      default:
        return 0;
    }
  }

  private spawn(anywhere: boolean): Particle {
    const y = anywhere ? this.rand() * this.height : -this.rand() * 2;
    const x = this.rand() * (this.width + Math.abs(this.wind) * 2) - Math.max(0, this.wind);
    switch (this.kind) {
      case "snow":
        return {
          x,
          y,
          vx: this.wind * 0.5 + (this.rand() - 0.5) * 1.5,
          vy: 2 + this.rand() * 3,
          ch: SNOW_GLYPHS[Math.floor(this.rand() * SNOW_GLYPHS.length)] ?? "*",
          color: lerp(hex("#ffffff"), hex("#b0bec5"), this.rand()),
        };
      case "fog":
        return {
          x: anywhere ? this.rand() * this.width : -2,
          y: this.rand() * this.height,
          vx: 1 + this.rand() * 2,
          vy: 0,
          ch: ["░", "▒", "~", "-"][Math.floor(this.rand() * 4)] ?? "░",
          color: lerp(hex("#546e7a"), hex("#90a4ae"), this.rand()),
        };
      case "drizzle":
        return {
          x,
          y,
          vx: this.wind * 0.8,
          vy: 7 + this.rand() * 4,
          ch: this.rand() > 0.5 ? "," : ".",
          color: lerp(hex("#81d4fa"), hex("#b0bec5"), this.rand()),
        };
      case "sleet":
        if (this.rand() < 0.45) {
          return {
            x,
            y,
            vx: this.wind * 0.9,
            vy: 13 + this.rand() * 5,
            ch: this.rand() > 0.5 ? "•" : "∙",
            color: lerp(hex("#e1f5fe"), hex("#b3e5fc"), this.rand()),
            ice: true,
          };
        }
        return this.rainDrop(x, y);
      case "hail":
        if (this.rand() < 0.15) {
          return {
            x,
            y,
            vx: this.wind * 0.6,
            vy: 22 + this.rand() * 8,
            ch: this.rand() > 0.4 ? "o" : "●",
            color: lerp(hex("#ffffff"), hex("#cfd8dc"), this.rand()),
            ice: true,
          };
        }
        return this.rainDrop(x, y);
      default:
        return this.rainDrop(x, y);
    }
  }

  private rainDrop(x: number, y: number): Particle {
    const heavy = this.kind === "storm" || this.kind === "hail" || this.intensity > 0.7;
    const vy = (heavy ? 28 : 18) + this.rand() * 10;
    const vx = this.wind * 1.5;
    const slant = vx / vy;
    return {
      x,
      y,
      vx,
      vy,
      ch: slant > 0.25 ? "/" : slant < -0.25 ? "\\" : heavy ? "|" : this.rand() > 0.5 ? "'" : "|",
      color: RAIN_COLORS[Math.floor(this.rand() * RAIN_COLORS.length)] ?? hex("#4fc3f7"),
    };
  }

  private makeBolt(): void {
    let x = Math.floor(this.width * (0.15 + this.rand() * 0.7));
    this.bolt = [];
    for (let y = 0; y < this.height * (0.5 + this.rand() * 0.5); y++) {
      this.bolt.push({ x, y });
      x += Math.round((this.rand() - 0.5) * 2.4);
    }
  }

  step(dtMs: number): void {
    const dt = Math.min(dtMs, 100) / 1000;
    this.t += dt;
    const target = this.targetCount();
    // Ramp up gradually from empty so the first frame isn't a wall of particles.
    while (this.particles.length < target) this.particles.push(this.spawn(this.t < 0.05));
    if (this.particles.length > target) this.particles.length = target;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (this.kind === "snow") p.vx += Math.sin(this.t * 2 + p.y) * 0.05;
      const ground = this.height - 1;
      if (SPLASHING.has(this.kind) && p.vy > 0 && p.y >= ground && p.y - p.vy * dt < ground) {
        const x = Math.floor(p.x);
        if (x >= 0 && x < this.width && this.splashes.length < this.width) {
          this.splashes.push({ x, y: ground, age: 0, ice: Boolean(p.ice) });
        }
        if (this.kind === "hail" && p.ice && !p.bounced) {
          // Hail stones hop back up once before melting.
          p.bounced = true;
          p.y = ground - 0.01;
          p.vy = -p.vy * 0.3;
          continue;
        }
      }
      if (p.bounced && p.vy < 0) p.vy += 60 * dt;
      const out = p.y >= this.height || p.x >= this.width + 2 || p.x < -4;
      if (out) this.particles[i] = this.spawn(false);
    }
    for (const s of this.splashes) s.age += dt;
    this.splashes = this.splashes.filter((s) => s.age < SPLASH_LIFE);
    if (this.kind === "storm" || this.kind === "hail") {
      this.flash = Math.max(0, this.flash - dt * 3);
      if (this.flash === 0 && this.rand() < dt * (0.15 + this.intensity * 0.3)) {
        this.flash = 1;
        this.makeBolt();
      }
    } else {
      this.flash = 0;
    }
  }

  cells(): FxCell[] {
    const out: FxCell[] = [];
    if (this.kind === "clear-night") {
      for (const s of this.stars) {
        const tw = (Math.sin(this.t * 1.5 + s.phase) + 1) / 2;
        out.push({
          x: s.x,
          y: s.y,
          ch: tw > 0.85 ? "✦" : s.ch,
          fg: lerp(hex("#37474f"), hex("#fffde7"), tw),
        });
      }
    }
    for (const p of this.particles) {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      out.push({ x, y, ch: p.ch, fg: p.color });
    }
    for (const s of this.splashes) {
      const k = Math.min(2, Math.floor((s.age / SPLASH_LIFE) * 3));
      const glyphs = s.ice ? SPLASH_ICE : SPLASH_RAIN;
      const fg = lerp(s.ice ? hex("#ffffff") : hex("#b3e5fc"), hex("#4f6b80"), s.age / SPLASH_LIFE);
      out.push({ x: s.x, y: s.y, ch: glyphs[k] ?? ".", fg });
    }
    if (this.flash > 0.4) {
      const c = lerp(hex("#fff59d"), hex("#ffffff"), this.flash);
      for (let i = 0; i < this.bolt.length; i++) {
        const b = this.bolt[i];
        const n = this.bolt[i + 1];
        if (!b) continue;
        const ch = !n ? "⚡" : n.x > b.x ? "\\" : n.x < b.x ? "/" : "│";
        if (b.x >= 0 && b.x < this.width) out.push({ x: b.x, y: b.y, ch, fg: c });
      }
    }
    return out;
  }
}
