import { describe, expect, test } from "bun:test";
import type { Hazards } from "../src/domain/types.ts";
import { auroraAt, parseAurora } from "../src/providers/aurora.ts";
import { gridPoints, gridUrl, parseGrid, sampleGrid } from "../src/providers/global-grid.ts";
import { adminLines, decodeLines } from "../src/render/admin.ts";
import { cellToLonLat, lerpCamera, panCamera, zoomCameraAt } from "../src/render/camera.ts";
import { PixelCanvas } from "../src/render/canvas.ts";
import { nightFactor, solarElevation, subsolarPoint } from "../src/render/daynight.ts";
import { DEFAULT_TOGGLES } from "../src/render/hazard-layers.ts";
import { inspectables, nearestAt } from "../src/render/inspect.ts";
import { placeLabels } from "../src/render/labels.ts";
import { PLACES, placeMarkers } from "../src/render/places.ts";
import {
  baseLayerBuilds,
  makeProjection,
  renderWorldMap,
  strokePath,
} from "../src/render/worldmap.ts";

const lit = (c: PixelCanvas, x0: number, x1: number) => {
  let n = 0;
  for (let y = 0; y < c.height; y++) for (let x = x0; x < x1; x++) if (c.get(x, y)) n++;
  return n;
};

describe("antimeridian-safe paths", () => {
  test("a track crossing 180° is cut at the seam, not drawn across the map", () => {
    const canvas = new PixelCanvas(100, 30);
    const proj = makeProjection({ lon: 0, lat: 0, zoom: 1 }, canvas.width, canvas.height);
    strokePath(
      canvas,
      proj,
      [
        [170, 10],
        [-170, 12],
      ],
      [255, 0, 0],
    );
    const w = canvas.width;
    expect(lit(canvas, Math.round(w * 0.1), Math.round(w * 0.9))).toBe(0);
    expect(lit(canvas, Math.round(w * 0.9), w)).toBeGreaterThan(0);
    expect(lit(canvas, 0, Math.round(w * 0.1))).toBeGreaterThan(0);
  });

  test("per-vertex colored tracks are split the same way", () => {
    const canvas = new PixelCanvas(100, 30);
    const proj = makeProjection({ lon: 0, lat: 0, zoom: 1 }, canvas.width, canvas.height);
    strokePath(
      canvas,
      proj,
      [
        [175, 0],
        [-178, 1],
        [-170, 2],
      ],
      [255, 0, 0],
      {
        colors: [
          [1, 1, 1],
          [2, 2, 2],
          [3, 3, 3],
        ],
      },
    );
    expect(lit(canvas, 20, canvas.width - 20)).toBe(0);
  });

  test("the same track draws continuously when the camera faces the Pacific", () => {
    const canvas = new PixelCanvas(100, 30);
    const proj = makeProjection({ lon: 180, lat: 0, zoom: 1 }, canvas.width, canvas.height);
    strokePath(
      canvas,
      proj,
      [
        [170, 10],
        [-170, 12],
      ],
      [255, 0, 0],
    );
    const mid = canvas.width / 2;
    expect(lit(canvas, mid - 4, mid + 4)).toBeGreaterThan(0);
  });
});

describe("base layer cache", () => {
  test("re-rendering the same camera reuses the rasterized base", () => {
    const cam = { lon: 12.3456, lat: 4.5, zoom: 1.5 };
    renderWorldMap(80, 24, cam);
    const before = baseLayerBuilds();
    renderWorldMap(80, 24, cam, { field: () => [255, 0, 0] });
    renderWorldMap(80, 24, cam, { shaders: [(_lon, _lat, c) => c] });
    expect(baseLayerBuilds()).toBe(before);
    renderWorldMap(81, 24, cam);
    expect(baseLayerBuilds()).toBe(before + 1);
  });

  test("transient renders don't evict cached layers", () => {
    const cam = { lon: -40, lat: 10, zoom: 2 };
    renderWorldMap(60, 20, cam);
    for (let i = 0; i < 12; i++)
      renderWorldMap(60, 20, { lon: i, lat: 0, zoom: 1 }, {}, undefined, { transient: true });
    const before = baseLayerBuilds();
    renderWorldMap(60, 20, cam);
    expect(baseLayerBuilds()).toBe(before);
  });

  test("field alpha blends over the fill", () => {
    const cells = renderWorldMap(
      40,
      12,
      { lon: -150, lat: 0, zoom: 1 },
      {
        field: () => [255, 0, 0],
        fieldAlpha: 0.5,
      },
    );
    const colors = cells
      .flat()
      .map((c) => c.fg ?? c.bg)
      .filter(Boolean);
    expect(colors.some((c) => c && c[0] > 100 && c[0] < 200)).toBe(true);
  });
});

describe("day/night", () => {
  test("subsolar latitude follows the seasons", () => {
    expect(subsolarPoint(new Date("2026-06-21T12:00:00Z")).lat).toBeCloseTo(23.44, 0);
    expect(subsolarPoint(new Date("2026-12-21T12:00:00Z")).lat).toBeCloseTo(-23.44, 0);
    expect(Math.abs(subsolarPoint(new Date("2026-03-20T12:00:00Z")).lat)).toBeLessThan(1);
  });

  test("subsolar longitude is near 0° at 12:00 UTC and 180° at midnight", () => {
    expect(Math.abs(subsolarPoint(new Date("2026-04-15T12:00:00Z")).lon)).toBeLessThan(5);
    expect(Math.abs(subsolarPoint(new Date("2026-04-15T00:00:00Z")).lon)).toBeGreaterThan(175);
  });

  test("noon is day, the antipode is night, twilight is partial", () => {
    const sub = { lat: 0, lon: 0 };
    expect(solarElevation(0, 0, sub)).toBeCloseTo(90);
    expect(nightFactor(solarElevation(180, 0, sub))).toBe(1);
    expect(nightFactor(-6)).toBeCloseTo(0.5);
    expect(nightFactor(10)).toBe(0);
  });
});

describe("camera", () => {
  const cols = 100;
  const rows = 30;

  test("dragging keeps the grabbed point under the pointer", () => {
    const cam = { lon: -80, lat: 20, zoom: 4 };
    const grabbed = cellToLonLat(cam, cols, rows, 30, 10);
    const moved = panCamera(cam, cols, rows, 10, 3);
    const after = cellToLonLat(moved, cols, rows, 40, 13);
    expect(after?.[0]).toBeCloseTo(grabbed?.[0] ?? 0, 0);
    expect(after?.[1]).toBeCloseTo(grabbed?.[1] ?? 0, 0);
  });

  test("wheel zoom keeps the point under the cursor fixed", () => {
    const cam = { lon: 0, lat: 30, zoom: 5 };
    const before = cellToLonLat(cam, cols, rows, 70, 8);
    const zoomed = zoomCameraAt(cam, cols, rows, 70, 8, 1.25);
    expect(zoomed.zoom).toBeCloseTo(6.25);
    const after = cellToLonLat(zoomed, cols, rows, 70, 8);
    expect(after?.[0]).toBeCloseTo(before?.[0] ?? 0, 0);
    expect(after?.[1]).toBeCloseTo(before?.[1] ?? 0, 0);
  });

  test("transitions take the short way around and ease zoom geometrically", () => {
    const mid = lerpCamera({ lon: 170, lat: 0, zoom: 1 }, { lon: -170, lat: 10, zoom: 4 }, 0.5);
    expect(Math.abs(mid.lon)).toBeCloseTo(180);
    expect(mid.lat).toBeCloseTo(5);
    expect(mid.zoom).toBeCloseTo(2);
  });
});

describe("states and places", () => {
  test("admin lines include US states and other countries' provinces", () => {
    const lines = adminLines().coordinates;
    expect(lines.length).toBeGreaterThan(1000);
    // Something in Colorado/Kansas (US) and something in Ontario/Quebec (Canada).
    const near = (lon: number, lat: number) =>
      lines.some((l) => l.some(([x = 0, y = 0]) => Math.abs(x - lon) < 1 && Math.abs(y - lat) < 1));
    expect(near(-102.05, 39)).toBe(true);
    expect(near(-79.5, 50)).toBe(true);
  });

  test("delta decoding", () => {
    expect(decodeLines({ q: 100, lines: [[100, 200, 50, -50]] })).toEqual([
      [
        [1, 2],
        [1.5, 1.5],
      ],
    ]);
  });

  test("places are sorted by prominence and density grows with zoom", () => {
    expect(PLACES.length).toBeGreaterThan(1000);
    expect(PLACES[0]?.rank).toBe(0);
    expect(placeMarkers(1, [0, 0, 0]).length).toBeLessThan(placeMarkers(8, [0, 0, 0]).length);
  });

  test("optional labels yield to required ones and need a clear anchor", () => {
    const placed = placeLabels(
      [
        { col: 10, row: 5, text: "City", optional: true },
        { col: 11, row: 5, text: "Storm" },
        { col: 40, row: 5, text: "Far", optional: true },
      ],
      80,
      20,
    );
    expect(placed.map((p) => p.text)).toEqual(["Storm", "Far"]);
  });
});

describe("global field grid", () => {
  test("grid fits Open-Meteo's 1000-location limit and URL length", () => {
    expect(gridPoints().length).toBeLessThanOrEqual(1000);
    expect(gridUrl().length).toBeLessThan(8000);
  });

  test("bilinear sampling wraps across the antimeridian", () => {
    const pts = gridPoints();
    const raw = pts.map(([lat, lon]) => ({
      current: { temperature_2m: lon === -180 ? 10 : lon === 165 ? 20 : lat, cloud_cover: null },
    }));
    const g = parseGrid(raw);
    expect(sampleGrid(g, g.values.temp, 172.5, 0)).toBeCloseTo(15);
    expect(sampleGrid(g, g.values.temp, -60, 25)).toBeCloseTo(25);
    expect(Number.isNaN(sampleGrid(g, g.values.clouds, 0, 0))).toBe(true);
  });
});

describe("aurora", () => {
  test("packs OVATION coordinates and samples them", () => {
    const g = parseAurora({
      coordinates: [
        [10, 65, 40],
        [11, 65, 20],
      ],
    });
    expect(g.max).toBe(40);
    expect(auroraAt(g, 10.5, 65)).toBeCloseTo(30);
    expect(auroraAt(g, -349.5, 65)).toBeCloseTo(30);
  });
});

describe("inspect", () => {
  const hazards = {
    schemaVersion: 1,
    generatedAt: "2026-10-01T00:00:00Z",
    storms: [
      {
        id: "al1",
        provider: "nhc",
        name: "Ana",
        classification: "Hurricane",
        category: 3,
        lat: 25,
        lon: -70,
        windKt: 100,
        pressureMb: 960,
        movement: "NW 10 mph",
        track: [],
      },
    ],
    fires: [
      {
        id: "f1",
        provider: "nifc",
        name: "BIG CREEK",
        lat: 40,
        lon: -120,
        acres: 50_000,
        containment: 20,
        kind: "incident",
      },
    ],
    hotspots: [],
    quakes: [
      {
        id: "q1",
        provider: "usgs",
        magnitude: 6.1,
        place: "10 km S of Town, Chile",
        time: "2026-10-01T00:00:00Z",
        lat: -30,
        lon: -71,
        depthKm: 20,
        tsunami: false,
      },
    ],
    errors: [],
  } as unknown as Hazards;

  test("lists storms, quakes and fires with details", () => {
    const items = inspectables(hazards, [], DEFAULT_TOGGLES, Date.parse("2026-10-01T02:00:00Z"));
    expect(items.map((i) => i.kind)).toEqual(["storm", "quake", "fire"]);
    expect(items[0]?.lines.join(" ")).toContain("100 kt");
    expect(items[1]?.place).toBe("Town, Chile");
    expect(items[2]?.title).toBe("Big Creek Fire");
    expect(items[2]?.lines[0]).toBe("50,000 acres");
  });

  test("respects layer toggles and finds the nearest to a click", () => {
    const items = inspectables(hazards, [], { ...DEFAULT_TOGGLES, storms: false });
    expect(items.some((i) => i.kind === "storm")).toBe(false);
    const placed = [
      { key: "a", at: [10, 5] as [number, number] },
      { key: "b", at: [14, 5] as [number, number] },
    ];
    expect(nearestAt(placed, 13, 5)?.key).toBe("b");
    expect(nearestAt(placed, 40, 20)).toBeUndefined();
  });
});
