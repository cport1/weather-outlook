import { openWeatherMap } from "./keyed/openweathermap.ts";
import { pirateWeather } from "./keyed/pirateweather.ts";
import { tomorrowIo } from "./keyed/tomorrow.ts";
import { visualCrossing } from "./keyed/visualcrossing.ts";
import { weatherApi } from "./keyed/weatherapi.ts";
import { fetchForecast } from "./open-meteo.ts";
import type { ForecastProvider } from "./provider.ts";

export const openMeteo: ForecastProvider = {
  id: "open-meteo",
  label: "Open-Meteo",
  aliases: ["openmeteo", "default"],
  docs: "https://open-meteo.com/en/docs",
  async fetch(http, loc, { refresh }) {
    return { forecast: await fetchForecast(http, loc, { refresh }) };
  },
};

export const PROVIDERS: readonly ForecastProvider[] = [
  openMeteo,
  openWeatherMap,
  tomorrowIo,
  pirateWeather,
  weatherApi,
  visualCrossing,
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function findProvider(name: string): ForecastProvider | undefined {
  const n = name.trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === n || p.aliases?.includes(n));
}

export interface ResolvedProvider {
  provider: ForecastProvider;
  key?: string;
}

/**
 * Pick the forecast provider from `--provider`, else WEATHER_OUTLOOK_PROVIDER.
 * Throws for unknown names or a missing key, so the user finds out immediately.
 */
export function resolveProvider(
  name: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  const wanted = name || env.WEATHER_OUTLOOK_PROVIDER;
  if (!wanted) return { provider: openMeteo };
  const provider = findProvider(wanted);
  if (!provider) {
    throw new Error(`Unknown provider "${wanted}". Choose one of: ${PROVIDER_IDS.join(", ")}`);
  }
  if (!provider.envVar) return { provider };
  const key = env[provider.envVar]?.trim();
  if (!key) {
    throw new Error(
      `${provider.label} needs an API key: set ${provider.envVar} (get one at ${provider.docs})`,
    );
  }
  return { provider, key };
}
