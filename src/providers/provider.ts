import type { Nowcast } from "../domain/details.ts";
import type { Forecast, Location } from "../domain/types.ts";
import type { HttpClient } from "../util/http.ts";

/**
 * A source of the primary forecast (current + hourly + daily). Open-Meteo is
 * the keyless default; the others need an API key from the environment and
 * replace it when selected with `--provider` (or WEATHER_OUTLOOK_PROVIDER).
 */
export interface ProviderResult {
  forecast: Forecast;
  /** Minute-scale precipitation, for providers that have it. */
  nowcast?: Nowcast;
}

export interface ForecastProvider {
  id: string;
  label: string;
  aliases?: readonly string[];
  /** Environment variable holding the API key; undefined for keyless providers. */
  envVar?: string;
  docs: string;
  fetch(
    http: HttpClient,
    loc: Pick<Location, "lat" | "lon">,
    opts: { key?: string; refresh?: boolean },
  ): Promise<ProviderResult>;
}
