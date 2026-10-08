import type { Alert, Severity } from "../domain/types.ts";
import { simplifyRing } from "../util/geo.ts";
import type { HttpClient } from "../util/http.ts";

interface NwsFeature {
  id: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    id?: string;
    event: string;
    headline?: string | null;
    description?: string | null;
    instruction?: string | null;
    severity?: string;
    urgency?: string;
    areaDesc?: string;
    onset?: string | null;
    effective?: string | null;
    expires?: string | null;
    ends?: string | null;
    affectedZones?: string[];
  };
}

export interface NwsAlertCollection {
  features: NwsFeature[];
}

const SEVERITIES: Record<string, Severity> = {
  Extreme: "extreme",
  Severe: "severe",
  Moderate: "moderate",
  Minor: "minor",
};

const SEVERITY_RANK: Record<Severity, number> = {
  extreme: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
  unknown: 4,
};

export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function outerRings(geometry: NwsFeature["geometry"]): Array<Array<[number, number]>> | undefined {
  if (!geometry) return undefined;
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as Array<Array<[number, number]>>;
    return rings[0] ? [rings[0]] : undefined;
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as Array<Array<Array<[number, number]>>>)
      .map((p) => p[0])
      .filter((r): r is Array<[number, number]> => Boolean(r));
  }
  return undefined;
}

export function parseNwsAlerts(raw: NwsAlertCollection): Alert[] {
  return sortAlerts(
    raw.features.map((f) => ({
      id: f.properties.id ?? f.id,
      provider: "nws",
      event: f.properties.event,
      headline: f.properties.headline ?? undefined,
      description: f.properties.description ?? undefined,
      instruction: f.properties.instruction ?? undefined,
      severity: SEVERITIES[f.properties.severity ?? ""] ?? "unknown",
      urgency: f.properties.urgency,
      areas: f.properties.areaDesc,
      onset: f.properties.onset ?? f.properties.effective ?? undefined,
      expires: f.properties.ends ?? f.properties.expires ?? undefined,
      polygon: outerRings(f.geometry),
    })),
  );
}

/** Active NWS alerts covering a point (US and territories only). */
export async function fetchNwsAlertsForPoint(
  http: HttpClient,
  lat: number,
  lon: number,
): Promise<Alert[]> {
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
  const raw = await http.json<NwsAlertCollection>(url, { ttlMs: 2 * 60_000 });
  return parseNwsAlerts(raw);
}

interface NwsZone {
  geometry: { type: string; coordinates: unknown } | null;
}

/**
 * Most national alerts have no polygon of their own (geometry null) and only
 * list `affectedZones`. Resolve up to `maxZones` forecast zones for the most
 * severe of those so they can be drawn; zone shapes are cached for a week.
 */
export async function resolveAlertZones(
  http: HttpClient,
  raw: NwsAlertCollection,
  alerts: Alert[],
  maxZones: number,
): Promise<void> {
  const zonesById = new Map<string, string[]>();
  for (const f of raw.features) {
    if (!f.geometry) zonesById.set(f.properties.id ?? f.id, f.properties.affectedZones ?? []);
  }
  const wanted = alerts.filter(
    (a) => !a.polygon && (a.severity === "extreme" || a.severity === "severe"),
  );
  const urls = [
    ...new Set(
      wanted.flatMap((a) =>
        (zonesById.get(a.id) ?? []).filter((z) => z.includes("/zones/forecast/")),
      ),
    ),
  ].slice(0, maxZones);
  const shapes = new Map<string, Array<Array<[number, number]>>>();
  // Small batches keep us polite to api.weather.gov.
  for (let i = 0; i < urls.length; i += 8) {
    await Promise.all(
      urls.slice(i, i + 8).map(async (u) => {
        const z = await http
          .json<NwsZone>(u, { ttlMs: 7 * 86_400_000, timeoutMs: 15_000 })
          .catch(() => undefined);
        const rings = outerRings(z?.geometry ?? null);
        if (rings?.length)
          shapes.set(
            u,
            rings.map((r) => simplifyRing(r, 0.02)),
          );
      }),
    );
  }
  for (const a of wanted) {
    const rings = (zonesById.get(a.id) ?? []).flatMap((z) => shapes.get(z) ?? []);
    if (rings.length) a.polygon = rings;
  }
}

/**
 * Active NWS alerts nationwide that have (or were given) a polygon, for the map.
 * Note the endpoint rejects a `limit` parameter.
 */
export async function fetchNwsAlertsNational(
  http: HttpClient,
  opts: { maxZones?: number } = {},
): Promise<Alert[]> {
  const raw = await http.json<NwsAlertCollection>(
    "https://api.weather.gov/alerts/active?status=actual&message_type=alert,update",
    { ttlMs: 3 * 60_000, timeoutMs: 20_000 },
  );
  const alerts = parseNwsAlerts(raw);
  if (opts.maxZones) await resolveAlertZones(http, raw, alerts, opts.maxZones);
  return alerts.filter((a) => a.polygon?.length);
}
