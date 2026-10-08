import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCache } from "../src/cache/disk-cache.ts";
import { detectColor } from "../src/capabilities.ts";
import { moonPhaseName } from "../src/domain/astronomy.ts";
import { fromWmo } from "../src/domain/conditions.ts";
import { parseCoords } from "../src/providers/location.ts";
import { withOffset } from "../src/providers/open-meteo.ts";
import { rgbTo256, stripAnsi } from "../src/render/ansi.ts";
import { PixelCanvas } from "../src/render/canvas.ts";
import { sparkline } from "../src/render/charts.ts";
import { compass, temp } from "../src/render/units.ts";
import { pointInLand } from "../src/render/worldmap.ts";
import { createHttpClient } from "../src/util/http.ts";

describe("capabilities", () => {
  test("NO_COLOR wins over everything but FORCE_COLOR", () => {
    expect(detectColor({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(0);
    expect(detectColor({ NO_COLOR: "", COLORTERM: "truecolor" }, true)).toBe(3);
    expect(detectColor({}, false)).toBe(0);
    expect(detectColor({ FORCE_COLOR: "2" }, false)).toBe(2);
    expect(detectColor({ TERM: "xterm-256color" }, true)).toBe(2);
  });
});

describe("domain", () => {
  test("WMO codes", () => {
    expect(fromWmo(0)).toBe("clear");
    expect(fromWmo(95)).toBe("thunderstorm");
    expect(fromWmo(75)).toBe("heavy-snow");
    expect(fromWmo(1234)).toBe("unknown");
  });
  test("moon phase names", () => {
    expect(moonPhaseName(0)).toBe("New Moon");
    expect(moonPhaseName(0.5)).toBe("Full Moon");
    expect(moonPhaseName(0.99)).toBe("New Moon");
  });
});

describe("parsing", () => {
  test("coords", () => {
    expect(parseCoords("39.7, -104.9")).toEqual({ lat: 39.7, lon: -104.9 });
    expect(parseCoords("Denver")).toBeUndefined();
    expect(parseCoords("95, 10")).toBeUndefined();
  });
  test("open-meteo local times get an offset", () => {
    expect(withOffset("2026-10-07T19:15", -21600)).toBe("2026-10-07T19:15:00-06:00");
    expect(withOffset("2026-10-07T19:15", 19800)).toBe("2026-10-07T19:15:00+05:30");
  });
});

describe("render", () => {
  test("units", () => {
    expect(temp(0, "imperial")).toBe("32°F");
    expect(temp(21.6, "metric")).toBe("22°C");
    expect(temp(Number.NaN, "metric")).toBe("--");
    expect(compass(0)).toBe("N");
    expect(compass(225)).toBe("SW");
  });
  test("braille encoding", () => {
    const c = new PixelCanvas(1, 1);
    c.set(0, 0);
    c.set(1, 3);
    expect(c.toBraille()[0]?.[0]?.ch).toBe(String.fromCharCode(0x2800 + 0x01 + 0x80));
  });
  test("sparkline spans min..max", () => {
    expect(sparkline([0, 50, 100], 0, 100)).toEqual(["▁", "▅", "█"]);
  });
  test("ansi helpers", () => {
    expect(stripAnsi("\x1b[38;2;1;2;3mhi\x1b[0m")).toBe("hi");
    expect(rgbTo256([0, 0, 0])).toBe(16);
  });
  test("land mask", () => {
    expect(pointInLand(-104.99, 39.74)).toBe(true); // Denver
    expect(pointInLand(-140, 30)).toBe(false); // Pacific
    expect(pointInLand(2.35, 48.85)).toBe(true); // Paris
  });
});

describe("http + cache", () => {
  test("serves fresh from cache, stale on error, dedupes inflight", async () => {
    let now = 1_000;
    const dir = await mkdtemp(join(tmpdir(), "wo-test-"));
    const cache = new DiskCache(dir, () => now);
    let calls = 0;
    let fail = false;
    const fakeFetch = (async () => {
      calls++;
      if (fail) throw new Error("offline");
      return new Response(JSON.stringify({ n: calls }), { status: 200 });
    }) as unknown as typeof fetch;
    const http = createHttpClient(cache, fakeFetch);
    const [a, b] = await Promise.all([
      http.json<{ n: number }>("https://x/y", { ttlMs: 100 }),
      http.json<{ n: number }>("https://x/y", { ttlMs: 100 }),
    ]);
    expect(a.n).toBe(1);
    expect(b.n).toBe(1);
    expect((await http.json<{ n: number }>("https://x/y", { ttlMs: 100 })).n).toBe(1);
    now += 1_000;
    fail = true;
    expect((await http.json<{ n: number }>("https://x/y", { ttlMs: 100, retries: 0 })).n).toBe(1);
    expect(calls).toBe(2);
  });
});
