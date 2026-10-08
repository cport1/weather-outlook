import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertSourceFor } from "../src/alerts.ts";
import type { Alert, Fire, GeoEvent, Hazards, Location, Storm } from "../src/domain/types.ts";
import { mergeStorms } from "../src/hazards.ts";
import {
  parseEccc,
  parseMeteoAlarm,
  parseMetno,
  parseSwic,
  swicCountry,
} from "../src/providers/alerts-intl.ts";
import {
  type HansVolcano,
  mergeEvents,
  parseEonet,
  parseGdacsEvents,
  parseHans,
} from "../src/providers/events.ts";
import {
  mergeFires,
  parseCalFire,
  parseCwfifCsv,
  parseCwfisHotspots,
  parsePerimeters,
} from "../src/providers/fires.ts";
import {
  bestTrackUrl,
  parseAtcfBestTrack,
  parseJtwcRss,
  parseJtwcWarning,
  resolveDdhhmm,
} from "../src/providers/jtwc.ts";
import { parseNwsAlerts, resolveAlertZones } from "../src/providers/nws.ts";
import { parseEro, parseSpcOutlook, risksAt } from "../src/providers/spc.ts";
import { parseQuakes } from "../src/providers/usgs.ts";
import { buildHazardLayers, DEFAULT_TOGGLES, riskColor } from "../src/render/hazard-layers.ts";
import { createAlertNotifier, notificationSequence } from "../src/tui/notify.ts";
import { riskBadges } from "../src/tui/views/risk-badge.tsx";
import type { HttpClient } from "../src/util/http.ts";

const FIX = join(import.meta.dir, "fixtures", "hazards");
const text = (f: string) => readFileSync(join(FIX, f), "utf8");
const json = (f: string): any => JSON.parse(text(f));

describe("jtwc", () => {
  test("RSS lists every active warning with its product id", () => {
    const refs = parseJtwcRss(text("jtwc.rss"));
    expect(refs.map((r) => r.product)).toEqual(["ep1526", "wp2726", "ep2026", "ep1826"]);
    expect(refs[1]).toMatchObject({
      basin: "WP",
      number: "27",
      year: 2026,
      name: "Koguma",
      classification: "Tropical Storm",
      warning: 13,
    });
    expect(refs[3]?.classification).toBe("Hurricane");
  });

  test("warning bulletin → current fix, pressure, movement and forecast track", () => {
    const w = parseJtwcWarning(text("jtwc-wp2726web.txt"));
    expect(w).toBeDefined();
    expect(w?.lat).toBe(16.9);
    expect(w?.lon).toBe(161.2);
    expect(w?.time).toBe("2026-10-08T00:00:00.000Z");
    expect(w?.windKt).toBe(55);
    expect(w?.pressureMb).toBe(992);
    expect(w?.movement).toBe("NW 9 mph");
    expect(w?.forecast).toHaveLength(8);
    expect(w?.forecast[0]).toMatchObject({ lat: 17.6, lon: 159.2, windKt: 70, forecast: true });
    expect(w?.forecast.at(-1)?.time).toBe("2026-10-13T00:00:00.000Z");
    expect(w?.forecast.every((p) => p.forecast)).toBe(true);
  });

  test("southern/western hemispheres are negative", () => {
    const w = parseJtwcWarning(
      "WARNING POSITION:\n   120600Z --- NEAR 15.2S 120.4W\n   MAX SUSTAINED WINDS - 040 KT\n12JAN27.",
    );
    expect(w?.lat).toBe(-15.2);
    expect(w?.lon).toBe(-120.4);
    expect(w?.time).toBe("2027-01-12T06:00:00.000Z");
  });

  test("DDHHMM stamps roll over month boundaries", () => {
    const ref = new Date(Date.UTC(2026, 9, 31));
    expect(resolveDdhhmm("011200", ref)).toBe("2026-11-01T12:00:00.000Z");
    expect(resolveDdhhmm("301800", new Date(Date.UTC(2027, 0, 2)))).toBe(
      "2026-12-30T18:00:00.000Z",
    );
  });

  test("ATCF best track: one point per synoptic time, tenths of degrees", () => {
    const pts = parseAtcfBestTrack(text("atcf-bwp272026.dat"));
    expect(pts).toHaveLength(13);
    expect(pts[0]).toMatchObject({ lat: 10.5, lon: 168, windKt: 30, pressureMb: 1002 });
    expect(pts[0]?.time).toBe("2026-10-05T00:00:00Z");
    expect(pts.at(-1)?.time).toBe("2026-10-08T00:00:00Z");
  });

  test("best track sources per basin", () => {
    expect(bestTrackUrl("EP", "15", 2026)).toBe("https://ftp.nhc.noaa.gov/atcf/btk/bep152026.dat");
    expect(bestTrackUrl("WP", "27", 2026)).toBe(
      "https://hurricanes.ral.ucar.edu/realtime/plots/northwestpacific/2026/wp272026/bwp272026.dat",
    );
    expect(bestTrackUrl("XX", "01", 2026)).toBeUndefined();
  });

  test("merge priority NHC > JTWC > GDACS, deduped by name or position", () => {
    const s = (name: string, provider: string, lat: number, lon: number): Storm => ({
      id: `${provider}-${name}`,
      provider,
      name,
      classification: "",
      category: 0,
      lat,
      lon,
      track: [],
    });
    const merged = mergeStorms(
      [s("Rachel", "nhc", 15, -120)],
      [s("Rachel", "jtwc", 15.1, -120.2), s("Koguma", "jtwc", 16.9, 161.2)],
      [
        s("Koguma", "gdacs", 17, 161),
        s("Unnamed", "gdacs", 17.5, 161.5),
        s("Other", "gdacs", -12, 60),
      ],
    );
    expect(merged.map((m) => m.id).sort()).toEqual(["gdacs-Other", "jtwc-Koguma", "nhc-Rachel"]);
  });
});

describe("spc / wpc outlooks", () => {
  const cat = parseSpcOutlook(json("spc-spc1.json"), "categorical", 1);
  test("categorical polygons get ordinal levels and names", () => {
    expect(cat.length).toBeGreaterThan(0);
    expect(cat[0]).toMatchObject({ label: "TSTM", level: 1, name: "General thunderstorms" });
    expect(cat[0]?.rings.length).toBeGreaterThan(1);
  });
  test("empty outlooks (GeometryCollection) yield nothing", () => {
    expect(parseSpcOutlook(json("spc-spc1torn.json"), "tornado", 1)).toEqual([]);
  });
  test("probabilistic labels become percentages", () => {
    const prob = parseSpcOutlook(json("spc-spc2prob.json"), "probabilistic", 2);
    expect(prob.map((p) => p.label)).toEqual(["5%", "15%"]);
    expect(prob[1]?.level).toBe(15);
  });
  test("ERO risk category from the OUTLOOK text", () => {
    const ero = parseEro(json("spc-ero1.json"), 1);
    expect(ero[0]).toMatchObject({ product: "rainfall", label: "MRGL", level: 1 });
    expect(ero[0]?.valid).toBe("2026-10-08T01:00:00Z");
  });
  test("risksAt picks the highest level per product covering the point", () => {
    const sq = (x: number, y: number, s: number): Array<[number, number]> => [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
      [x, y],
    ];
    const base = { product: "categorical" as const, day: 1, name: "" };
    const risks = risksAt(
      [
        { ...base, label: "TSTM", level: 1, rings: [sq(-100, 30, 10)] },
        { ...base, label: "SLGT", level: 3, rings: [sq(-96, 34, 2)] },
        { ...base, label: "HIGH", level: 6, rings: [sq(-80, 30, 1)] },
      ],
      35,
      -95,
    );
    expect(risks).toHaveLength(1);
    expect(risks[0]?.label).toBe("SLGT");
    expect(riskBadges(risks)).toHaveLength(1);
    expect(riskBadges([{ ...base, label: "TSTM", level: 1 }])).toHaveLength(0);
  });
});

describe("events", () => {
  test("HANS elevated volcanoes need coordinates from getVolcano", () => {
    const coords = new Map<string, HansVolcano>([["311120", json("hans-volcano-311120.json")]]);
    const v = parseHans(json("hans-elevated.json"), coords);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      title: "Great Sitkin",
      kind: "volcano",
      level: "orange",
      lat: 52.0765,
      detail: "WATCH · AVO",
    });
  });
  test("EONET categories map to kinds; storms are left to storm providers", () => {
    const e = parseEonet(json("eonet.json"));
    expect(e).toHaveLength(3);
    expect(e.every((x) => x.kind === "volcano")).toBe(true);
    expect(e[0]?.title).toBe("Nevados del Chillan Volcano, Chile");
  });
  test("GDACS EVENTS4APP keeps floods/droughts/volcanoes only", () => {
    const g = parseGdacsEvents(json("gdacs-events4app.json"));
    expect(g.map((x) => x.title)).toEqual(["Flood in France", "Flood in Spain"]);
    expect(g[0]?.level).toBe("green");
    expect(g[0]?.detail).toBeUndefined();
  });
  test("merge drops nearby duplicates of the same kind and sorts by alert level", () => {
    const ev = (id: string, lat: number, level?: GeoEvent["level"]): GeoEvent => ({
      id,
      provider: "x",
      kind: "volcano",
      title: id,
      lat,
      lon: 0,
      level,
    });
    const m = mergeEvents([ev("a", 10, "yellow")], [ev("dup", 10.1), ev("b", 40, "red")]);
    expect(m.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("fires", () => {
  test("NIFC perimeters → rings sorted by size", () => {
    const p = parsePerimeters(json("nifc-perimeters.json"));
    expect(p).toHaveLength(2);
    expect(p[0]?.rings[0]?.length).toBeGreaterThan(3);
    expect((p[0]?.acres ?? 0) >= (p[1]?.acres ?? 0)).toBe(true);
  });
  test("CAL FIRE incidents", () => {
    const f = parseCalFire(json("calfire.json"));
    expect(f).toHaveLength(3);
    expect(f[0]).toMatchObject({ name: "Timber Fire", acres: 25351.9, containment: 94 });
  });
  test("CWFIS hotspots (EPSG:4326 lon/lat)", () => {
    const h = parseCwfisHotspots(json("cwfis-hotspots.json"));
    expect(h).toHaveLength(3);
    expect(h[0]).toMatchObject({ kind: "hotspot", lon: -124.12159729, lat: 55.16923141 });
  });
  test("CWFIF reported fires CSV (CRLF, hectares → acres, stage of control)", () => {
    const f = parseCwfifCsv(text("cwfif-activefires.csv"));
    expect(f.length).toBe(4);
    const ab = f.find((x) => x.id === "cwfif-2026_AB_MWF-056-2026");
    expect(ab).toMatchObject({ status: "being held", acres: 2.4, name: "AB MWF-056-2026" });
    const uc = parseCwfifCsv(
      "agency_code,national_fire_id,stage_of_control_status,fire_size,latitude,longitude\r\nBC,2026_BC_X1,UC,10,50,-120\r\nBC,2026_BC_X2,EX,1,51,-121",
    );
    expect(uc).toHaveLength(1);
    expect(uc[0]?.containment).toBe(100);
  });
  test("merge drops CAL FIRE duplicates of NIFC incidents", () => {
    const fire = (id: string, name: string, lat: number): Fire => ({
      id,
      provider: id,
      name,
      lat,
      lon: -120,
      kind: "incident",
    });
    const m = mergeFires(
      [fire("nifc", "TIMBER", 36.2)],
      [fire("calfire", "Timber Fire", 36.25), fire("calfire2", "Other", 40)],
    );
    expect(m.map((x) => x.id)).toEqual(["nifc", "calfire2"]);
  });
});

describe("nearby quakes", () => {
  test("FDSN responses parse like the summary feeds", () => {
    const q = parseQuakes(json("usgs-fdsn.json"));
    expect(q).toHaveLength(3);
    expect(q[0]?.magnitude).toBe(1.31);
  });
});

describe("alerts worldwide", () => {
  const fakeHttp = (routes: Record<string, unknown>): HttpClient => ({
    async json<T>(url: string) {
      if (!(url in routes)) throw new Error(`unexpected ${url}`);
      return routes[url] as T;
    },
    async text(url: string) {
      return JSON.stringify(routes[url]);
    },
    async bytes() {
      return new Uint8Array();
    },
  });

  test("NWS national: polygon-less severe alerts get forecast-zone shapes", async () => {
    const raw = json("nws-national.json");
    const alerts = parseNwsAlerts(raw);
    const heat = alerts.find((a) => a.event === "Extreme Heat Warning") as Alert;
    expect(heat.polygon).toBeUndefined();
    const zone = json("nws-zone.json");
    const http = fakeHttp(
      Object.fromEntries(
        ["CAZ087", "CAZ088"].map((z) => [`https://api.weather.gov/zones/forecast/${z}`, zone]),
      ),
    );
    await resolveAlertZones(http, raw, alerts, 2);
    expect(heat.polygon?.length).toBe(2);
  });

  test("Environment Canada: ended alerts dropped, regions grouped per alert", () => {
    const raw = json("eccc-alerts.json");
    expect(parseEccc(raw)).toEqual([]);
    for (const f of raw.features) f.properties.status_en = "active";
    const a = parseEccc(raw);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ event: "Severe thunderstorm watch", severity: "moderate" });
    expect(a[0]?.polygon).toHaveLength(3);
    expect(a[0]?.areas).toContain("Gouin Reservoir area");
  });

  test("MET Norway", () => {
    const a = parseMetno(json("metno.json"));
    expect(a[0]).toMatchObject({ provider: "met-norway", severity: "moderate" });
    expect(a[0]?.polygon?.length).toBeGreaterThan(0);
    expect(a[0]?.expires).toBe("2026-10-09T10:00:00+00:00");
  });

  test("MeteoAlarm: English info, area-name match, expired dropped", () => {
    const raw = json("meteoalarm-germany.json");
    const before = new Date("2026-10-03T05:00:00+02:00");
    const hit = parseMeteoAlarm(raw, ["Verden"], before);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ event: "Fog", severity: "minor", areas: "Kreis Verden" });
    expect(parseMeteoAlarm(raw, ["Berlin"], before)).toEqual([]);
    expect(parseMeteoAlarm(raw, ["Verden"], new Date("2026-10-08T00:00:00Z"))).toEqual([]);
  });

  test("WMO SWIC: country from CAP path, area-name match", () => {
    const raw = json("wmo-swic.json");
    expect(raw.items.map(swicCountry)).toEqual(["US", "US", "AU", "AU", "CN"]);
    const perth = parseSwic(raw, "AU", ["Perth", "Western Australia"]);
    expect(perth).toHaveLength(1);
    // A city match wins; the region is only a fallback.
    expect(parseSwic(raw, "AU", ["Nowhere", "Western Australia"])).toHaveLength(2);
    expect(perth[0]?.severity).toBe("moderate");
    expect(parseSwic(raw, "CN", ["Foshan"])[0]?.severity).toBe("severe");
  });

  test("regional provider routing", () => {
    const loc = (countryCode?: string): Location => ({
      name: "X",
      lat: 0,
      lon: 0,
      source: "coords",
      countryCode,
    });
    expect(alertSourceFor(loc("US")).provider).toBe("nws-alerts");
    expect(alertSourceFor(loc()).provider).toBe("nws-alerts");
    expect(alertSourceFor(loc("CA")).provider).toBe("eccc");
    expect(alertSourceFor(loc("NO")).provider).toBe("met-norway");
    expect(alertSourceFor(loc("de")).provider).toBe("meteoalarm");
    expect(alertSourceFor(loc("AU")).provider).toBe("wmo-swic");
  });
});

describe("notifications", () => {
  const alert = (id: string, severity: Alert["severity"]): Alert => ({
    id,
    provider: "nws",
    event: "Tornado Warning",
    headline: "Take shelter; now",
    severity,
  });
  test("OSC 9 by default, OSC 777 on VTE/foot, tmux passthrough", () => {
    expect(notificationSequence("T", "b;x", {})).toBe("\x1b]9;T: b x\x07\x07");
    expect(notificationSequence("T", "b", { TERM: "foot" })).toBe("\x1b]777;notify;T;b\x07\x07");
    expect(notificationSequence("T", "b", { TMUX: "1" }).startsWith("\x1bPtmux;\x1b\x1b]9;")).toBe(
      true,
    );
  });
  test("first batch only seeds; later severe alerts notify once", () => {
    const out: string[] = [];
    const notify = createAlertNotifier((s) => out.push(s), {});
    expect(notify([alert("a", "extreme")], "Here")).toEqual([]);
    expect(notify([alert("a", "extreme"), alert("b", "minor")], "Here")).toEqual([]);
    expect(notify([alert("a", "extreme"), alert("c", "severe")], "Here").map((a) => a.id)).toEqual([
      "c",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Tornado Warning · Here");
  });
});

describe("map layers", () => {
  const ring: Array<[number, number]> = [
    [-100, 30],
    [-90, 30],
    [-90, 40],
    [-100, 40],
    [-100, 30],
  ];
  const hazards: Hazards = {
    schemaVersion: 1,
    generatedAt: "2026-10-08T00:00:00Z",
    storms: [],
    fires: [],
    hotspots: [],
    quakes: [],
    errors: [],
    perimeters: [{ id: "p", provider: "nifc", rings: [ring] }],
    events: [
      { id: "v", provider: "x", kind: "volcano", title: "V", lat: 1, lon: 2, level: "orange" },
    ],
    outlooks: [
      { product: "categorical", day: 1, label: "SLGT", name: "", level: 3, rings: [ring] },
      {
        product: "rainfall",
        day: 1,
        label: "MRGL",
        name: "",
        level: 1,
        fill: "#66c266",
        rings: [ring],
      },
    ],
  };
  test("outlook fill, event markers, perimeters only when zoomed in", () => {
    const world = buildHazardLayers(hazards, [], DEFAULT_TOGGLES, 1);
    expect(world.field?.(-95, 35)).toBeDefined();
    expect(world.field?.(0, 0)).toBeUndefined();
    expect(world.markers?.some((m) => m.glyph === "∆")).toBe(true);
    // Only the dotted ERO outline at world zoom; the perimeter appears at zoom 4.
    expect(world.paths).toHaveLength(1);
    expect(buildHazardLayers(hazards, [], DEFAULT_TOGGLES, 4).paths).toHaveLength(2);
    const off = buildHazardLayers(
      hazards,
      [],
      { ...DEFAULT_TOGGLES, outlooks: false, events: false },
      1,
    );
    expect(off.field).toBeUndefined();
    expect(off.markers).toHaveLength(0);
  });
  test("SPC categorical colors", () => {
    expect(riskColor({ product: "categorical", label: "SLGT" })).toEqual([255, 224, 102]);
  });
});
