/**
 * Gene: weather-source-c-v2
 * Domain: data.weather.source-c
 * Parses Source C's reordered CSV: location,unit,value
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const lines = input.rawData.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(`[weather-source-c-v2] Expected CSV with header + data row`);
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const values = lines[1].split(",").map((v) => v.trim());

  const valueIdx = headers.indexOf("value");
  const locationIdx = headers.indexOf("location");

  if (valueIdx === -1 || locationIdx === -1) {
    throw new Error(
      `[weather-source-c-v2] Expected columns "value" and "location", got: ${headers.join(", ")}`
    );
  }

  const unitIdx = headers.indexOf("unit");

  return {
    temperature: Number(values[valueIdx]),
    unit: unitIdx !== -1 ? values[unitIdx] : "celsius",
    city: values[locationIdx],
  };
}
