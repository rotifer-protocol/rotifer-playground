/**
 * Gene: weather-source-b-v1
 * Domain: data.weather.source-b
 * Parses Source B's original XML: <weather><city>X</city><temperature>N</temperature><unit>celsius</unit></weather>
 */

import type { WeatherParserInput, WeatherParserOutput } from "../types.js";

export async function express(
  input: WeatherParserInput
): Promise<WeatherParserOutput> {
  const raw = input.rawData;

  const tempMatch = raw.match(/<temperature>([\d.]+)<\/temperature>/);
  const cityMatch = raw.match(/<city>([^<]+)<\/city>/);
  const unitMatch = raw.match(/<unit>(\w+)<\/unit>/);

  if (!tempMatch || !cityMatch) {
    throw new Error(
      `[weather-source-b-v1] Expected <temperature>N</temperature><city>X</city> XML structure`
    );
  }

  return {
    temperature: Number(tempMatch[1]),
    unit: unitMatch ? unitMatch[1] : "celsius",
    city: cityMatch[1],
  };
}
