import type { Storm, TrackPoint } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

const CURRENT_STORMS = "https://www.nhc.noaa.gov/CurrentStorms.json";
const MAPSERVER =
  "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";

interface CurrentStormsResponse {
  activeStorms: Array<{
    id: string;
    binNumber: string;
    name: string;
    classification: string;
    intensity: string;
    pressure: string;
    latitudeNumeric: number;
    longitudeNumeric: number;
    movementDir: number;
    movementSpeed: number;
    lastUpdate: string;
  }>;
}

interface LayerIndex {
  layers: Array<{ id: number; name: string }>;
}

type Feature<P> = {
  properties: P;
  geometry: { type: string; coordinates: unknown } | null;
};
interface FC<P> {
  features: Feature<P>[];
}

interface ForecastPointProps {
  tau: number;
  maxwind: number;
  mslp: number;
  stormtype: string;
  fldatelbl?: string;
  validtime?: string;
}

interface PastPointProps {
  intensity: number;
  mslp: number;
  dtg: number;
  stormtype: string;
}

const CLASSIFICATION: Record<string, string> = {
  TD: "Tropical Depression",
  TS: "Tropical Storm",
  HU: "Hurricane",
  MH: "Major Hurricane",
  STD: "Subtropical Depression",
  STS: "Subtropical Storm",
  PTC: "Post-Tropical Cyclone",
  PC: "Potential Tropical Cyclone",
  TY: "Typhoon",
  DB: "Disturbance",
  LO: "Low",
};

export function classificationName(code: string): string {
  return CLASSIFICATION[code.toUpperCase()] ?? code;
}

/** Saffir-Simpson category from max sustained wind in knots. -1 = depression, 0 = tropical storm. */
export function categoryFromKt(kt: number | undefined): number {
  if (kt === undefined || !Number.isFinite(kt)) return -1;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  if (kt >= 64) return 1;
  if (kt >= 34) return 0;
  return -1;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** 16-point compass name for a bearing in degrees. */
export function compassPoint(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16] ?? "N";
}

function pointCoords(f: Feature<unknown>): [number, number] | undefined {
  if (f.geometry?.type !== "Point") return undefined;
  const [lon, lat] = f.geometry.coordinates as [number, number];
  return [lon, lat];
}

/** ATCF dtg like 2026100418 → ISO. */
export function dtgToIso(dtg: number): string {
  const s = String(dtg);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:00:00Z`;
}

export function parseForecastPoints(fc: FC<ForecastPointProps>, issued?: string): TrackPoint[] {
  const base = issued ? new Date(issued).getTime() : undefined;
  return fc.features
    .map((f) => ({ f, c: pointCoords(f) }))
    .filter((x): x is { f: Feature<ForecastPointProps>; c: [number, number] } => Boolean(x.c))
    .sort((a, b) => a.f.properties.tau - b.f.properties.tau)
    .map(({ f, c }) => ({
      time:
        base !== undefined ? new Date(base + f.properties.tau * 3600_000).toISOString() : undefined,
      lon: c[0],
      lat: c[1],
      windKt: f.properties.maxwind < 9000 ? f.properties.maxwind : undefined,
      pressureMb: f.properties.mslp < 9000 ? f.properties.mslp : undefined,
      category: categoryFromKt(f.properties.maxwind < 9000 ? f.properties.maxwind : undefined),
      forecast: f.properties.tau > 0,
    }));
}

export function parsePastPoints(fc: FC<PastPointProps>): TrackPoint[] {
  return fc.features
    .map((f) => ({ f, c: pointCoords(f) }))
    .filter((x): x is { f: Feature<PastPointProps>; c: [number, number] } => Boolean(x.c))
    .sort((a, b) => a.f.properties.dtg - b.f.properties.dtg)
    .map(({ f, c }) => ({
      time: dtgToIso(f.properties.dtg),
      lon: c[0],
      lat: c[1],
      windKt: f.properties.intensity || undefined,
      pressureMb: f.properties.mslp || undefined,
      category: categoryFromKt(f.properties.intensity),
      forecast: false,
    }));
}

export function parseCone(fc: FC<unknown>): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      const r = (g.coordinates as Array<Array<[number, number]>>)[0];
      if (r) rings.push(r);
    } else if (g.type === "MultiPolygon") {
      for (const p of g.coordinates as Array<Array<Array<[number, number]>>>)
        if (p[0]) rings.push(p[0]);
    }
  }
  return rings;
}

async function queryLayer<P>(http: HttpClient, id: number, extra = ""): Promise<FC<P>> {
  return http.json<FC<P>>(`${MAPSERVER}/${id}/query?where=1%3D1&outFields=*&f=geojson${extra}`, {
    ttlMs: 15 * 60_000,
    timeoutMs: 15_000,
  });
}

/** Active Atlantic / East + Central Pacific storms with past track, forecast track and cone. */
export async function fetchNhcStorms(http: HttpClient): Promise<Storm[]> {
  const current = await http.json<CurrentStormsResponse>(CURRENT_STORMS, { ttlMs: 10 * 60_000 });
  if (!current.activeStorms?.length) return [];
  // Layer IDs are not contiguous across bins, so resolve them by name.
  const index = await http.json<LayerIndex>(`${MAPSERVER}?f=json`, { ttlMs: 24 * 3600_000 });
  const layerId = (name: string) => index.layers.find((l) => l.name === name)?.id;

  return Promise.all(
    current.activeStorms.map(async (s): Promise<Storm> => {
      const bin = s.binNumber;
      const fpId = layerId(`${bin} Forecast Points`);
      const coneId = layerId(`${bin} Forecast Cone`);
      const pastId = layerId(`${bin} Past Points`);
      const [fp, cone, past] = await Promise.all([
        fpId !== undefined
          ? queryLayer<ForecastPointProps>(http, fpId).catch(() => undefined)
          : undefined,
        coneId !== undefined
          ? queryLayer(http, coneId, "&geometryPrecision=2&maxAllowableOffset=0.05").catch(
              () => undefined,
            )
          : undefined,
        pastId !== undefined
          ? queryLayer<PastPointProps>(http, pastId).catch(() => undefined)
          : undefined,
      ]);
      const windKt = Number(s.intensity);
      const forecastTrack = fp ? parseForecastPoints(fp, s.lastUpdate) : [];
      const pastTrack = past ? parsePastPoints(past) : [];
      return {
        id: s.id,
        provider: "nhc",
        name: s.name,
        basin: s.id.slice(0, 2).toUpperCase(),
        classification: classificationName(s.classification),
        category: categoryFromKt(windKt),
        lat: s.latitudeNumeric,
        lon: s.longitudeNumeric,
        windKt: Number.isFinite(windKt) ? windKt : undefined,
        pressureMb: Number(s.pressure) || undefined,
        movement: `${COMPASS[Math.round(s.movementDir / 22.5) % 16]} ${s.movementSpeed} mph`,
        updated: s.lastUpdate,
        track: [...pastTrack, ...forecastTrack],
        cone: cone ? parseCone(cone) : undefined,
      };
    }),
  );
}
