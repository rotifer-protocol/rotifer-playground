/**
 * Gene: weather-source-c-v1
 * Domain: data.weather.source-c
 * Parses Source C's original CSV: city,temperature,unit
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const lines = input.rawData.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(`[weather-source-c-v1] Expected CSV with header + data row`);
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const values = lines[1].split(",").map((v) => v.trim());

  const tempIdx = headers.indexOf("temperature");
  const cityIdx = headers.indexOf("city");

  if (tempIdx === -1 || cityIdx === -1) {
    throw new Error(
      `[weather-source-c-v1] Expected columns "temperature" and "city", got: ${headers.join(", ")}`
    );
  }

  const unitIdx = headers.indexOf("unit");

  return {
    temperature: Number(values[tempIdx]),
    unit: unitIdx !== -1 ? values[unitIdx] : "celsius",
    city: values[cityIdx],
  };
}
