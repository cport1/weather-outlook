import type { HttpClient } from "./util/http.ts";

/**
 * Data providers, their licenses and the attribution they ask for. Several (Open-Meteo,
 * MET Norway, Nominatim/OSM, RainViewer, MeteoAlarm) require visible credit, which the
 * `about` command and the in-app credits overlay provide.
 */
export interface Provider {
  id: string;
  name: string;
  use: string;
  license: string;
  attribution: string;
  url: string;
  /** Hostnames (or suffixes) whose requests count as using this provider. */
  hosts: string[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "open-meteo",
    name: "Open-Meteo",
    use: "forecast, air quality, geocoding, global map fields",
    license: "CC BY 4.0",
    attribution: "Weather data by Open-Meteo.com",
    url: "https://open-meteo.com",
    hosts: ["open-meteo.com"],
  },
  {
    id: "met-norway",
    name: "MET Norway",
    use: "forecast",
    license: "CC BY 4.0 / NLOD 2.0",
    attribution: "Data from The Norwegian Meteorological Institute (MET Norway)",
    url: "https://api.met.no",
    hosts: ["api.met.no"],
  },
  {
    id: "nws",
    name: "NOAA / National Weather Service",
    use: "US forecasts and alerts",
    license: "Public domain (US Government)",
    attribution: "NOAA National Weather Service",
    url: "https://www.weather.gov",
    hosts: ["api.weather.gov"],
  },
  {
    id: "nhc",
    name: "NOAA / National Hurricane Center",
    use: "tropical cyclones",
    license: "Public domain (US Government)",
    attribution: "NOAA National Hurricane Center",
    url: "https://www.nhc.noaa.gov",
    hosts: ["nhc.noaa.gov", "mapservices.weather.noaa.gov"],
  },
  {
    id: "swpc",
    name: "NOAA / Space Weather Prediction Center",
    use: "space weather, aurora oval",
    license: "Public domain (US Government)",
    attribution: "NOAA Space Weather Prediction Center",
    url: "https://www.swpc.noaa.gov",
    hosts: ["swpc.noaa.gov"],
  },
  {
    id: "rainviewer",
    name: "RainViewer",
    use: "global radar",
    license: "Free API, attribution required",
    attribution: "Radar data © RainViewer",
    url: "https://www.rainviewer.com",
    hosts: ["rainviewer.com"],
  },
  {
    id: "iem",
    name: "Iowa Environmental Mesonet",
    use: "US NEXRAD radar composite",
    license: "Free to use, credit requested",
    attribution:
      "NEXRAD composite courtesy of the Iowa Environmental Mesonet, Iowa State University",
    url: "https://mesonet.agron.iastate.edu",
    hosts: ["mesonet.agron.iastate.edu"],
  },
  {
    id: "gibs",
    name: "NASA GIBS",
    use: "satellite imagery (GOES, Himawari, VIIRS)",
    license: "Open data, no restrictions",
    attribution: "Imagery from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS",
    url: "https://earthdata.nasa.gov/gibs",
    hosts: ["gibs.earthdata.nasa.gov"],
  },
  {
    id: "firms",
    name: "NASA FIRMS",
    use: "satellite fire hotspots",
    license: "Open data, no restrictions",
    attribution: "NASA Fire Information for Resource Management System (FIRMS)",
    url: "https://firms.modaps.eosdis.nasa.gov",
    hosts: ["firms.modaps.eosdis.nasa.gov", "firms2.modaps.eosdis.nasa.gov"],
  },
  {
    id: "eonet",
    name: "NASA EONET",
    use: "natural events",
    license: "Open data, no restrictions",
    attribution: "NASA Earth Observatory Natural Event Tracker (EONET)",
    url: "https://eonet.gsfc.nasa.gov",
    hosts: ["eonet.gsfc.nasa.gov"],
  },
  {
    id: "nifc",
    name: "NIFC / WFIGS",
    use: "US wildfire incidents",
    license: "Public domain (US Government)",
    attribution: "National Interagency Fire Center, WFIGS",
    url: "https://data-nifc.opendata.arcgis.com",
    hosts: ["services3.arcgis.com"],
  },
  {
    id: "usgs",
    name: "USGS",
    use: "earthquakes",
    license: "Public domain (US Government)",
    attribution: "U.S. Geological Survey Earthquake Hazards Program",
    url: "https://earthquake.usgs.gov",
    hosts: ["earthquake.usgs.gov"],
  },
  {
    id: "gdacs",
    name: "GDACS",
    use: "global disaster alerts",
    license: "Free use with attribution",
    attribution:
      "Global Disaster Alert and Coordination System (European Commission JRC / UN OCHA)",
    url: "https://www.gdacs.org",
    hosts: ["gdacs.org"],
  },
  {
    id: "meteoalarm",
    name: "MeteoAlarm",
    use: "European weather warnings",
    license: "Attribution required (EUMETNET)",
    attribution: "Warnings from MeteoAlarm, EUMETNET",
    url: "https://meteoalarm.org",
    hosts: ["meteoalarm.org"],
  },
  {
    id: "nominatim",
    name: "Nominatim / OpenStreetMap",
    use: "place search",
    license: "ODbL 1.0",
    attribution: "Geocoding © OpenStreetMap contributors, ODbL",
    url: "https://www.openstreetmap.org/copyright",
    hosts: ["nominatim.openstreetmap.org"],
  },
  {
    id: "ipwho",
    name: "ipwho.is",
    use: "approximate location from IP",
    license: "Free API",
    attribution: "IP geolocation by ipwho.is",
    url: "https://ipwho.is",
    hosts: ["ipwho.is"],
  },
  {
    id: "natural-earth",
    name: "Natural Earth",
    use: "coastlines, borders, provinces and cities (bundled)",
    license: "Public domain",
    attribution: "Made with Natural Earth (via world-atlas)",
    url: "https://www.naturalearthdata.com",
    hosts: [],
  },
  {
    id: "us-atlas",
    name: "US Census Bureau (via us-atlas)",
    use: "US state boundaries (bundled)",
    license: "Public domain (US Government)",
    attribution: "US state boundaries from the US Census Bureau cartographic files",
    url: "https://github.com/topojson/us-atlas",
    hosts: [],
  },
];

/** Bundled map data is always in use; everything else is recorded as requests are made. */
const used = new Set<string>(["natural-earth", "us-atlas"]);

export function providerForUrl(url: string): Provider | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return PROVIDERS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

export function recordUse(url: string): void {
  const p = providerForUrl(url);
  if (p) used.add(p.id);
}

/** Providers contacted so far in this process, in catalogue order. */
export function usedProviders(): Provider[] {
  return PROVIDERS.filter((p) => used.has(p.id));
}

/** Wrap an HttpClient so every request records which provider it hit. */
export function trackProviders(http: HttpClient): HttpClient {
  return {
    text: (url, opts) => (recordUse(url), http.text(url, opts)),
    bytes: (url, opts) => (recordUse(url), http.bytes(url, opts)),
    json: (url, opts) => (recordUse(url), http.json(url, opts)),
  };
}

/** Plain-text credits for `weather-outlook about`. */
export function renderAbout(version: string, color = true): string {
  const b = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);
  const d = (s: string) => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const lines = [
    `${b("weather-outlook")} ${version}  ${d("MIT · https://github.com/cport1/weather-outlook")}`,
    "",
    "Data and imagery come from these providers; thank you. Each is credited per its terms.",
    "",
  ];
  for (const p of PROVIDERS) {
    lines.push(`${b(p.name)}  ${d(`${p.license} · ${p.use}`)}`);
    lines.push(`  ${p.attribution}`);
    lines.push(`  ${d(p.url)}`);
  }
  return `${lines.join("\n")}\n`;
}
