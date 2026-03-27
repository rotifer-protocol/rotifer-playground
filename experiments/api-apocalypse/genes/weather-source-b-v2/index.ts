/**
 * Gene: weather-source-b-v2
 * Domain: data.weather.source-b
 * Parses Source B's restructured XML: <data><temp city="X" celsius="N"/></data>
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const raw = input.rawData;

  const celsiusMatch = raw.match(/celsius="([\d.]+)"/);
  const cityMatch = raw.match(/city="([^"]+)"/);

  if (!celsiusMatch) {
    throw new Error(
      `[weather-source-b-v2] Expected <temp celsius="N" .../> attribute format`
    );
  }

  return {
    temperature: Number(celsiusMatch[1]),
    unit: "celsius",
    city: cityMatch ? cityMatch[1] : "unknown",
  };
}
