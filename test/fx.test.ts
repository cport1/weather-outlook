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
