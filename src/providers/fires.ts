import type { Fire, FirePerimeter } from "../domain/types.ts";
import { distanceKm, outerRings, simplifyRing } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";

const NIFC_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
// Keyless 24h global MODIS hotspots (~1.5 MB). VIIRS global is ~10 MB, so it's opt-in.
const FIRMS_MODIS_GLOBAL =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv";

interface NifcFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    IncidentName: string;
    IncidentSize: number | null;
    PercentContained: number | null;
    FireDiscoveryDateTime: number | null;
    POOState?: string;
    UniqueFireIdentifier: string;
  };
}

export function parseNifc(raw: { features: NifcFeature[] }): Fire[] {
  return raw.features
    .filter((f) => f.geometry)
    .map((f) => ({
      id: f.properties.UniqueFireIdentifier,
      provider: "nifc",
      name: f.properties.IncidentName,
      lon: f.geometry?.coordinates[0] ?? 0,
      lat: f.geometry?.coordinates[1] ?? 0,
      acres: f.properties.IncidentSize ?? undefined,
      containment: f.properties.PercentContained ?? undefined,
      discovered: f.properties.FireDiscoveryDateTime
        ? new Date(f.properties.FireDiscoveryDateTime).toISOString()
        : undefined,
      kind: "incident" as const,
    }))
    .sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
}

/** US wildfire incidents (prescribed burns excluded), largest first. */
export async function fetchNifcIncidents(http: HttpClient, minAcres = 0): Promise<Fire[]> {
  const where = encodeURIComponent(
    `IncidentTypeCategory='WF'${minAcres > 0 ? ` AND IncidentSize>=${minAcres}` : ""}`,
  );
  const fields =
    "IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,POOState,UniqueFireIdentifier";
  const raw = await http.json<{ features: NifcFeature[] }>(
    `${NIFC_INCIDENTS}?where=${where}&outFields=${fields}&f=geojson&resultRecordCount=2000`,
    { ttlMs: 15 * 60_000, timeoutMs: 20_000 },
  );
  return parseNifc(raw);
}

/** Parse FIRMS CSV (MODIS or VIIRS column layouts). */
export function parseFirmsCsv(csv: string, minConfidence = 50): Fire[] {
  const lines = csv.trim().split("\n");
  const header = lines.shift()?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const iLat = col("latitude");
  const iLon = col("longitude");
  const iFrp = col("frp");
  const iConf = col("confidence");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const out: Fire[] = [];
  for (const [n, line] of lines.entries()) {
    const c = line.split(",");
    const conf = c[iConf] ?? "";
    // MODIS confidence is 0-100; VIIRS uses l/n/h, or low/nominal/high in the C2 files.
    const numeric = Number(conf);
    const ok = Number.isFinite(numeric) ? numeric >= minConfidence : !/^l(ow)?$/i.test(conf.trim());
    if (!ok) continue;
    const t = c[iTime] ?? "0000";
    out.push({
      id: `firms-${n}`,
      provider: "firms",
      lat: Number(c[iLat]),
      lon: Number(c[iLon]),
      frp: Number(c[iFrp]) || undefined,
      confidence: conf,
      discovered: `${c[iDate]}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`,
      kind: "hotspot",
    });
  }
  return out;
}

/** FIRMS area API (needs a free MAP_KEY): NOAA-20 VIIRS, 375 m resolution vs MODIS's 1 km. */
export function firmsAreaUrl(mapKey: string, source = "VIIRS_NOAA20_NRT", days = 1): string {
  return `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/world/${days}`;
}

/**
 * Global 24h hotspots. With a FIRMS MAP_KEY this uses VIIRS via the area API;
 * without one (or if the key is rejected) it falls back to the keyless MODIS file.
 */
export async function fetchFirmsHotspots(
  http: HttpClient,
  mapKey?: string,
  onKeyError?: (message: string) => void,
): Promise<Fire[]> {
  if (mapKey) {
    try {
      const csv = await http.text(firmsAreaUrl(mapKey), { ttlMs: 60 * 60_000, timeoutMs: 45_000 });
      // Bad keys and rate limits come back as 200 with a plain-text message, not CSV.
      if (!csv.startsWith("latitude,"))
        throw new Error(csv.trim().split("\n")[0] || "unexpected response");
      return parseFirmsCsv(csv);
    } catch (err) {
      onKeyError?.(
        `FIRMS_MAP_KEY: ${err instanceof Error ? err.message : String(err)} (using keyless MODIS)`,
      );
    }
  }
  const csv = await http.text(FIRMS_MODIS_GLOBAL, { ttlMs: 60 * 60_000, timeoutMs: 30_000 });
  return parseFirmsCsv(csv);
}

// --- NIFC perimeters ------------------------------------------------------------

const NIFC_PERIMETERS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";

interface PerimeterFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    poly_IncidentName?: string | null;
    attr_IncidentSize?: number | null;
    poly_GISAcres?: number | null;
    attr_UniqueFireIdentifier?: string | null;
  };
}

export function parsePerimeters(raw: { features: PerimeterFeature[] }): FirePerimeter[] {
  const out: FirePerimeter[] = [];
  raw.features.forEach((f, i) => {
    const rings = outerRings(f.geometry).map((r) => simplifyRing(r, 0.005));
    if (!rings.length) return;
    const p = f.properties;
    out.push({
      id: p.attr_UniqueFireIdentifier ?? `perimeter-${i}`,
      provider: "nifc",
      name: p.poly_IncidentName ?? undefined,
      acres: p.attr_IncidentSize ?? p.poly_GISAcres ?? undefined,
      rings,
    });
  });
  return out.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
}

/** Current US wildfire perimeters (generalized server-side to ~1 km). */
export async function fetchNifcPerimeters(
  http: HttpClient,
  minAcres = 100,
): Promise<FirePerimeter[]> {
  const where = encodeURIComponent(
    `attr_IncidentTypeCategory='WF' AND attr_IncidentSize>=${minAcres}`,
  );
  const fields = "poly_IncidentName,attr_IncidentSize,poly_GISAcres,attr_UniqueFireIdentifier";
  const raw = await http.json<{ features: PerimeterFeature[] }>(
    `${NIFC_PERIMETERS}?where=${where}&outFields=${fields}&f=geojson&geometryPrecision=3&maxAllowableOffset=0.01`,
    { ttlMs: 30 * 60_000, timeoutMs: 30_000 },
  );
  return parsePerimeters(raw);
}

// --- CAL FIRE ---------------------------------------------------------------------

const CALFIRE = "https://www.fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=false";

interface CalFireFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    Name: string;
    UniqueId: string;
    AcresBurned?: number | null;
    PercentContained?: number | null;
    Started?: string | null;
    Url?: string | null;
    Type?: string | null;
    IsActive?: boolean;
  };
}

export function parseCalFire(raw: { features: CalFireFeature[] }): Fire[] {
  return raw.features
    .filter(
      (f) =>
        f.geometry && f.properties.IsActive !== false && f.properties.Type !== "Prescribed Burn",
    )
    .map((f) => ({
      id: `calfire-${f.properties.UniqueId}`,
      provider: "calfire",
      name: f.properties.Name.trim(),
      lon: f.geometry?.coordinates[0] ?? 0,
      lat: f.geometry?.coordinates[1] ?? 0,
      acres: f.properties.AcresBurned ?? undefined,
      containment: f.properties.PercentContained ?? undefined,
      discovered: f.properties.Started ?? undefined,
      url: f.properties.Url ?? undefined,
      kind: "incident" as const,
    }));
}

export async function fetchCalFire(http: HttpClient): Promise<Fire[]> {
  return parseCalFire(await http.json(CALFIRE, { ttlMs: 15 * 60_000, timeoutMs: 20_000 }));
}

// --- Canada (CWFIS / CWFIF) ------------------------------------------------------------

const CA_AGENCIES = [
  "BC",
  "AB",
  "SK",
  "MB",
  "ON",
  "QC",
  "NL",
  "NB",
  "NS",
  "PE",
  "YT",
  "NT",
  "NU",
  "PC",
];
// The hotspot layer covers all of North America; FIRMS already has the US, so keep Canada only.
// srsName is required, otherwise coordinates come back in Lambert conformal metres.
const CWFIS_HOTSPOTS = `https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=public:hotspots_last24hrs&outputFormat=application/json&srsName=EPSG:4326&propertyName=geometry,rep_date,frp,agency&CQL_FILTER=${encodeURIComponent(
  `agency IN (${CA_AGENCIES.map((a) => `'${a}'`).join(",")})`,
)}`;
// Agency-reported active fires; the old downloads/activefires.csv is frozen, this is what it now links to.
const CWFIF_ACTIVE = `https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs?service=WFS&version=2.0.1&request=GetFeature&outputFormat=csv&typeName=public:cwfif_national_activefires&CQL_FILTER=${encodeURIComponent(
  "now()>=record_start AND now()<=record_end",
)}&propertyName=agency_code,national_fire_id,stage_of_control_status,fire_size,situation_report_date,latitude,longitude`;

interface CwfisHotspot {
  id?: string;
  geometry: { type: string; coordinates: [number, number] } | null;
  properties: { rep_date?: string; frp?: number | null; agency?: string };
}

export function parseCwfisHotspots(raw: { features: CwfisHotspot[] }): Fire[] {
  return raw.features
    .filter((f) => f.geometry?.type === "Point")
    .map((f, i) => ({
      id: `cwfis-${f.id ?? i}`,
      provider: "cwfis",
      lon: f.geometry?.coordinates[0] ?? 0,
      lat: f.geometry?.coordinates[1] ?? 0,
      frp: f.properties.frp ?? undefined,
      discovered: f.properties.rep_date,
      kind: "hotspot" as const,
    }));
}

export async function fetchCwfisHotspots(http: HttpClient): Promise<Fire[]> {
  return parseCwfisHotspots(
    await http.json(CWFIS_HOTSPOTS, { ttlMs: 60 * 60_000, timeoutMs: 30_000 }),
  );
}

const STAGE: Record<string, string> = {
  OC: "out of control",
  BH: "being held",
  UC: "under control",
  EX: "extinguished",
};

/** Parse CWFIF national active fires CSV (sizes are hectares). */
export function parseCwfifCsv(csv: string): Fire[] {
  // GeoServer CSV uses CRLF line endings.
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const [iAg, iId, iStage, iSize, iDate, iLat, iLon] = [
    "agency_code",
    "national_fire_id",
    "stage_of_control_status",
    "fire_size",
    "situation_report_date",
    "latitude",
    "longitude",
  ].map(col);
  const out: Fire[] = [];
  for (const line of lines) {
    const c = line.split(",");
    const lat = Number(c[iLat ?? -1]);
    const lon = Number(c[iLon ?? -1]);
    const stage = c[iStage ?? -1] ?? "";
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || stage === "EX") continue;
    const ha = Number(c[iSize ?? -1]);
    const id = c[iId ?? -1] ?? `${lat},${lon}`;
    out.push({
      id: `cwfif-${id}`,
      provider: "cwfif",
      name: `${c[iAg ?? -1] ?? "CA"} ${id.split("_").at(-1) ?? id}`,
      lat,
      lon,
      acres: Number.isFinite(ha) && ha >= 0 ? Math.round(ha * 2.471 * 10) / 10 : undefined,
      containment: stage === "UC" ? 100 : undefined,
      status: STAGE[stage] ?? stage,
      discovered: c[iDate ?? -1] ? `${c[iDate ?? -1]}Z` : undefined,
      kind: "incident",
    });
  }
  return out.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
}

export async function fetchCanadaFires(http: HttpClient): Promise<Fire[]> {
  return parseCwfifCsv(await http.text(CWFIF_ACTIVE, { ttlMs: 30 * 60_000, timeoutMs: 30_000 }));
}

/** Merge incident lists in priority order, dropping same-name or co-located (<3 km) duplicates. */
export function mergeFires(first: Fire[], ...rest: Fire[][]): Fire[] {
  const out: Fire[] = [...first];
  const norm = (s: string | undefined) =>
    (s ?? "")
      .toLowerCase()
      .replace(/\bfire\b/g, "")
      .replace(/[^a-z0-9]/g, "");
  for (const list of rest) {
    for (const f of list) {
      const dup = out.some(
        (o) =>
          (f.name &&
            norm(o.name) === norm(f.name) &&
            distanceKm(o.lat, o.lon, f.lat, f.lon) < 50) ||
          distanceKm(o.lat, o.lon, f.lat, f.lon) < 3,
      );
      if (!dup) out.push(f);
    }
  }
  return out.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
}
