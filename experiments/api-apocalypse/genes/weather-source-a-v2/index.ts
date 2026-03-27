/**
 * Gene: weather-source-a-v2
 * Domain: data.weather.source-a
 * Parses Source A's restructured JSON format: { weather: { temp_celsius, location } }
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const data = JSON.parse(input.rawData);

  if (!data.weather?.temp_celsius) {
    throw new Error(
      `[weather-source-a-v2] Expected { weather: { temp_celsius } } but got keys: ${Object.keys(data).join(", ")}`
    );
  }

  return {
    temperature: Number(data.weather.temp_celsius),
    unit: "celsius",
    city: String(data.weather.location ?? "unknown"),
  };
}
