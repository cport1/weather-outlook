import { describe, expect, test } from "bun:test";
import type { Storm } from "../src/domain/types.ts";
import { mergeStorms } from "../src/hazards.ts";
import { parseFirmsCsv, parseNifc } from "../src/providers/fires.ts";
import { categoryFromKt, parseForecastPoints, parsePastPoints } from "../src/providers/nhc.ts";
import { parseNwsAlerts } from "../src/providers/nws.ts";
import { parseQuakes } from "../src/providers/usgs.ts";
import { stormSprite } from "../src/render/hazard-layers.ts";

describe("nhc", () => {
  test("Saffir-Simpson categories", () => {
    expect(categoryFromKt(30)).toBe(-1);
    expect(categoryFromKt(55)).toBe(0);
    expect(categoryFromKt(70)).toBe(1);
    expect(categoryFromKt(100)).toBe(3);
    expect(categoryFromKt(140)).toBe(5);
  });
  test("forecast points sorted by tau, sentinel 9999 dropped", () => {
    const pts = parseForecastPoints(
      {
        features: [
          {
            properties: { tau: 12, maxwind: 70, mslp: 9999, stormtype: "HU" },
            geometry: { type: "Point", coordinates: [-91.8, 23.1] },
          },
          {
            properties: { tau: 0, maxwind: 55, mslp: 994, stormtype: "TS" },
            geometry: { type: "Point", coordinates: [-92.4, 22.8] },
          },
        ],
      },
      "2026-10-08T00:00:00.000Z",
    );
    expect(pts.map((p) => p.lon)).toEqual([-92.4, -91.8]);
    expect(pts[0]?.forecast).toBe(false);
    expect(pts[1]?.forecast).toBe(true);
    expect(pts[1]?.pressureMb).toBeUndefined();
    expect(pts[1]?.category).toBe(1);
    expect(pts[1]?.time).toBe("2026-10-08T12:00:00.000Z");
  });
  test("past points parse ATCF dtg", () => {
    const pts = parsePastPoints({
      features: [
        {
          properties: { intensity: 15, mslp: 0, dtg: 2026100418, stormtype: "DB" },
          geometry: { type: "Point", coordinates: [-96.5, 22] },
        },
      ],
    });
    expect(pts[0]?.time).toBe("2026-10-04T18:00:00Z");
    expect(pts[0]?.pressureMb).toBeUndefined();
  });
});

describe("storm merge", () => {
  const storm = (
    name: string,
    lat: number,
    lon: number,
    provider: string,
    category = 0,
  ): Storm => ({
    id: name,
    provider,
    name,
    classification: "",
    category,
    lat,
    lon,
    track: [],
  });
  test("GDACS duplicates of NHC storms are dropped, others kept", () => {
    const merged = mergeStorms(
      [storm("Simon", 15.5, -101.6, "nhc")],
      [storm("Simon", 15.5, -101.6, "gdacs"), storm("Mawar", 14, 140, "gdacs", 3)],
    );
    expect(merged.map((s) => `${s.provider}:${s.name}`)).toEqual(["gdacs:Mawar", "nhc:Simon"]);
  });
  test("southern-hemisphere storms spin the other way", () => {
    const n = storm("A", 20, 0, "x", 2);
    const s = storm("B", -20, 0, "x", 2);
    expect(stormSprite(n, 0)).not.toBe(stormSprite(s, 0));
  });
});

describe("fires", () => {
  test("FIRMS CSV filters low confidence (MODIS numeric + VIIRS letters)", () => {
    const modis =
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n1,2,300,1,1,2026-10-06,0009,A,60,6.1NRT,286,9.9,N\n3,4,300,1,1,2026-10-06,1230,A,25,6.1NRT,286,6.4,N";
    const out = parseFirmsCsv(modis);
    expect(out).toHaveLength(1);
    expect(out[0]?.discovered).toBe("2026-10-06T00:09:00Z");
    const viirs =
      "latitude,longitude,confidence,frp,acq_date,acq_time\n1,2,l,1,2026-10-06,0000\n1,2,h,1,2026-10-06,0000";
    expect(parseFirmsCsv(viirs)).toHaveLength(1);
  });
  test("NIFC incidents sorted largest first", () => {
    const fires = parseNifc({
      features: [
        {
          geometry: { coordinates: [-1, 1] },
          properties: {
            IncidentName: "Small",
            IncidentSize: 5,
            PercentContained: null,
            FireDiscoveryDateTime: null,
            UniqueFireIdentifier: "a",
          },
        },
        {
          geometry: { coordinates: [-2, 2] },
          properties: {
            IncidentName: "Big",
            IncidentSize: 5000,
            PercentContained: 10,
            FireDiscoveryDateTime: 0,
            UniqueFireIdentifier: "b",
          },
        },
      ],
    });
    expect(fires.map((f) => f.name)).toEqual(["Big", "Small"]);
  });
});

describe("quakes + alerts", () => {
  test("USGS quakes drop null magnitudes, sort by magnitude", () => {
    const q = parseQuakes({
      features: [
        {
          id: "a",
          properties: { mag: 2.5, place: "x", time: 0 },
          geometry: { coordinates: [1, 2, 10] },
        },
        {
          id: "b",
          properties: { mag: null, place: "y", time: 0 },
          geometry: { coordinates: [1, 2, 10] },
        },
        {
          id: "c",
          properties: { mag: 6.1, place: "z", time: 0, tsunami: 1 },
          geometry: { coordinates: [1, 2, 10] },
        },
      ],
    });
    expect(q.map((x) => x.id)).toEqual(["c", "a"]);
    expect(q[0]?.tsunami).toBe(true);
  });
  test("NWS alerts sorted by severity, polygons extracted", () => {
    const a = parseNwsAlerts({
      features: [
        {
          id: "1",
          geometry: null,
          properties: { event: "Coastal Flood Statement", severity: "Minor" },
        },
        {
          id: "2",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: { event: "Tornado Warning", severity: "Extreme" },
        },
      ],
    });
    expect(a.map((x) => x.event)).toEqual(["Tornado Warning", "Coastal Flood Statement"]);
    expect(a[0]?.polygon?.[0]).toHaveLength(4);
  });
});
