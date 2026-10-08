import { expect, test } from "bun:test";
import { WeatherFx } from "../src/render/fx.ts";

test("rain particles stay in bounds and are deterministic", () => {
  const run = () => {
    const fx = new WeatherFx(40, 12, "rain", 0.8, 3, 7);
    for (let i = 0; i < 60; i++) fx.step(33);
    return fx.cells();
  };
  const a = run();
  expect(a.length).toBeGreaterThan(10);
  for (const c of a) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThan(40);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThan(12);
  }
  expect(run()).toEqual(a);
});

test("storms eventually flash lightning", () => {
  const fx = new WeatherFx(40, 12, "storm", 1, 0, 1);
  let flashed = false;
  for (let i = 0; i < 2000 && !flashed; i++) {
    fx.step(33);
    flashed = fx.flashLevel > 0;
  }
  expect(flashed).toBe(true);
});

test("clear nights twinkle with stars, no particles", () => {
  const fx = new WeatherFx(40, 12, "clear-night");
  fx.step(33);
  expect(fx.cells().length).toBeGreaterThan(0);
});

test("rain splashes on the ground line", () => {
  const fx = new WeatherFx(40, 12, "rain", 1, 0, 3);
  let splashed = false;
  for (let i = 0; i < 120 && !splashed; i++) {
    fx.step(33);
    splashed = fx.cells().some((c) => c.y === 11 && ["‿", "◦", "·"].includes(c.ch));
  }
  expect(splashed).toBe(true);
});

test("hail, sleet and drizzle each produce their own particles", () => {
  const glyphs = (kind: "hail" | "sleet" | "drizzle") => {
    const fx = new WeatherFx(60, 16, kind, 0.8, 0, 5);
    for (let i = 0; i < 40; i++) fx.step(33);
    return new Set(fx.cells().map((c) => c.ch));
  };
  const hail = glyphs("hail");
  expect(hail.has("o") || hail.has("●")).toBe(true);
  const sleet = glyphs("sleet");
  expect(sleet.has("•") || sleet.has("∙")).toBe(true);
  const drizzle = glyphs("drizzle");
  expect(drizzle.has(",") || drizzle.has(".")).toBe(true);
  expect(drizzle.has("|")).toBe(false);
});

test("hosts can tell when a scene has nothing to animate", () => {
  expect(new WeatherFx(10, 5, "none").idle).toBe(true);
  expect(new WeatherFx(10, 5, "rain").idle).toBe(false);
});
