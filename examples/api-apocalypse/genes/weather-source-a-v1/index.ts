/**
 * Gene: weather-source-a-v1
 * Domain: data.weather.source-a
 * Parses Source A's original JSON format: { temperature, city, unit }
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const data = JSON.parse(input.rawData);

  if (data.temperature === undefined || data.city === undefined) {
    throw new Error(
      `[weather-source-a-v1] Expected { temperature, city } but got keys: ${Object.keys(data).join(", ")}`
    );
  }

  return {
    temperature: Number(data.temperature),
    unit: String(data.unit ?? "celsius"),
    city: String(data.city),
  };
}
