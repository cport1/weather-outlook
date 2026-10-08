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
  // The two Open-Meteo APIs with upstream credit requirements come before the
  // catch-all open-meteo.com entry so their requests are tracked separately.
  {
    id: "open-meteo-archive",
    name: "Open-Meteo Historical Weather (ERA5)",
    use: "30-year climate normals, percentiles and records",
    license: "CC BY 4.0",
    attribution:
      "Historical data by Open-Meteo.com, based on ERA5 from the Copernicus Climate Change Service (Hersbach et al., 2023)",
    url: "https://open-meteo.com/en/docs/historical-weather-api",
    hosts: ["archive-api.open-meteo.com"],
  },
  {
    id: "open-meteo-marine",
    name: "Open-Meteo Marine",
    use: "wave height, period, direction and sea-surface temperature",
    license: "CC BY 4.0",
    attribution: "Marine data by Open-Meteo.com (DWD, ECMWF, Météo-France, Copernicus Marine)",
    url: "https://open-meteo.com/en/docs/marine-weather-api",
    hosts: ["marine-api.open-meteo.com"],
  },
  {
    id: "open-meteo",
    name: "Open-Meteo",
    use: "forecast, model comparison and ensemble, minutely nowcast, air quality, geocoding, global map fields",
    license: "CC BY 4.0",
    attribution: "Weather data by Open-Meteo.com",
    url: "https://open-meteo.com",
    hosts: ["open-meteo.com"],
  },
  {
    id: "met-norway",
    name: "MET Norway",
    use: "forecast for model comparison, Nordic radar nowcast, MetAlerts weather warnings (Norway)",
    license: "CC BY 4.0 / NLOD 2.0",
    attribution: "Data from The Norwegian Meteorological Institute (MET Norway)",
    url: "https://api.met.no",
    hosts: ["api.met.no"],
  },
  {
    id: "nws",
    name: "NOAA / National Weather Service",
    use: "US forecasts, alerts and alert zone shapes",
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
    id: "jtwc",
    name: "Joint Typhoon Warning Center",
    use: "tropical cyclone warnings outside NHC basins",
    license: "Public domain (US Government)",
    attribution: "U.S. Navy / Air Force Joint Typhoon Warning Center",
    url: "https://www.metoc.navy.mil/jtwc/jtwc.html",
    hosts: ["metoc.navy.mil"],
  },
  {
    id: "ucar-ral",
    name: "NCAR/UCAR RAL tropical cyclone guidance",
    use: "ATCF best tracks (West Pacific, Indian Ocean, Southern Hemisphere)",
    license: "Free to use, credit requested",
    attribution: "ATCF best-track data via the NCAR/UCAR Research Applications Laboratory",
    url: "https://hurricanes.ral.ucar.edu",
    hosts: ["hurricanes.ral.ucar.edu"],
  },
  {
    id: "spc",
    name: "NOAA / Storm Prediction Center",
    use: "convective and fire-weather outlooks",
    license: "Public domain (US Government)",
    attribution: "NOAA Storm Prediction Center",
    url: "https://www.spc.noaa.gov",
    hosts: ["spc.noaa.gov"],
  },
  {
    id: "wpc",
    name: "NOAA / Weather Prediction Center",
    use: "excessive rainfall outlooks",
    license: "Public domain (US Government)",
    attribution: "NOAA Weather Prediction Center",
    url: "https://www.wpc.ncep.noaa.gov",
    hosts: ["wpc.ncep.noaa.gov"],
  },
  {
    id: "eccc",
    name: "Environment and Climate Change Canada",
    use: "Canadian weather alerts",
    license: "Open Government Licence – Canada",
    attribution:
      "Contains information licensed under the Open Government Licence – Canada (Environment and Climate Change Canada, MSC GeoMet)",
    url: "https://api.weather.gc.ca",
    hosts: ["api.weather.gc.ca"],
  },
  {
    id: "wmo-swic",
    name: "WMO Severe Weather Information Centre",
    use: "global warning headlines",
    license: "Free use with attribution; warnings © issuing national services",
    attribution:
      "World Meteorological Organization Severe Weather Information Centre; warnings issued by national meteorological services",
    url: "https://severeweather.wmo.int",
    hosts: ["severeweather.wmo.int"],
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
    id: "calfire",
    name: "CAL FIRE",
    use: "California wildfire incidents",
    license: "Public information (State of California)",
    attribution: "California Department of Forestry and Fire Protection (CAL FIRE)",
    url: "https://www.fire.ca.gov",
    hosts: ["fire.ca.gov"],
  },
  {
    id: "cwfis",
    name: "Natural Resources Canada / CWFIS",
    use: "Canadian fire hotspots and reported fires",
    license: "Open Government Licence – Canada",
    attribution:
      "Contains information licensed under the Open Government Licence – Canada (Canadian Wildland Fire Information System, NRCan)",
    url: "https://cwfis.cfs.nrcan.gc.ca",
    hosts: ["cwfis.cfs.nrcan.gc.ca", "geoserver.cwfif.nrcan.gc.ca"],
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
    id: "usgs-volcanoes",
    name: "USGS Volcano Hazards Program",
    use: "elevated volcano alert levels (HANS)",
    license: "Public domain (US Government)",
    attribution: "U.S. Geological Survey Volcano Hazards Program",
    url: "https://volcanoes.usgs.gov",
    hosts: ["volcanoes.usgs.gov"],
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
    id: "noaa-coops",
    name: "NOAA CO-OPS Tides & Currents",
    use: "tide station list and high/low tide predictions",
    license: "Public domain (US Government)",
    attribution: "NOAA Center for Operational Oceanographic Products and Services",
    url: "https://tidesandcurrents.noaa.gov",
    hosts: ["api.tidesandcurrents.noaa.gov", "tidesandcurrents.noaa.gov"],
  },
  {
    id: "ndbc",
    name: "NOAA National Data Buoy Center",
    use: "latest buoy and coastal station observations",
    license: "Public domain (US Government)",
    attribution: "NOAA National Data Buoy Center",
    url: "https://www.ndbc.noaa.gov",
    hosts: ["ndbc.noaa.gov"],
  },
  {
    id: "openaq",
    name: "OpenAQ",
    use: "ground-station air quality readings (with OPENAQ_API_KEY)",
    license: "CC BY 4.0 (data under each source's terms)",
    attribution: "Air quality data from OpenAQ (openaq.org) and its contributing sources",
    url: "https://openaq.org",
    hosts: ["api.openaq.org"],
  },
  {
    id: "openweathermap",
    name: "OpenWeatherMap",
    use: "optional forecast provider (--provider openweathermap, OWM_API_KEY)",
    license: "CC BY-SA 4.0 (data), ODbL (database)",
    attribution: "Weather data provided by OpenWeather",
    url: "https://openweathermap.org",
    hosts: ["api.openweathermap.org"],
  },
  {
    id: "tomorrow-io",
    name: "Tomorrow.io",
    use: "optional forecast and minutely nowcast (--provider tomorrow, TOMORROW_API_KEY)",
    license: "Tomorrow.io Terms of Service",
    attribution: "Powered by Tomorrow.io",
    url: "https://www.tomorrow.io",
    hosts: ["api.tomorrow.io"],
  },
  {
    id: "pirateweather",
    name: "Pirate Weather",
    use: "optional forecast and minutely nowcast (--provider pirateweather, PIRATEWEATHER_API_KEY)",
    license: "Pirate Weather Terms of Service (NOAA/ECMWF source data)",
    attribution: "Powered by Pirate Weather",
    url: "https://pirateweather.net",
    hosts: ["api.pirateweather.net"],
  },
  {
    id: "weatherapi",
    name: "WeatherAPI.com",
    use: "optional forecast provider (--provider weatherapi, WEATHERAPI_KEY)",
    license: "WeatherAPI.com Terms of Service (attribution required on free plans)",
    attribution: "Powered by WeatherAPI.com",
    url: "https://www.weatherapi.com",
    hosts: ["api.weatherapi.com"],
  },
  {
    id: "visualcrossing",
    name: "Visual Crossing",
    use: "optional forecast provider (--provider visualcrossing, VISUALCROSSING_API_KEY)",
    license: "Visual Crossing Terms of Service (attribution required)",
    attribution: "Weather data provided by Visual Crossing Weather",
    url: "https://www.visualcrossing.com",
    hosts: ["weather.visualcrossing.com"],
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
