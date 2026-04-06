/**
 * Baseline Agent — Fixed Code, No Failover
 *
 * Control group: uses a single hardcoded parser per source.
 * When the API format changes, it fails and stays failed
 * until a human manually fixes the code.
 */

import type { WeatherParserInput, WeatherParserOutput } from "./genes/types.js";

type ExpressFn = (input: WeatherParserInput) => Promise<WeatherParserOutput>;

export interface TickResult {
  tick: number;
  timestampMs: number;
  elapsedSec: number;
  sources: Record<
    string,
    {
      status: "success" | "fetch_error" | "parse_error";
      temperature?: number;
      error?: string;
      latencyMs: number;
    }
  >;
  aggregatedTemperature?: number;
  successfulSources: number;
}

interface FixedParser {
  sourceId: string;
  express: ExpressFn;
}

export class BaselineAgent {
  private parsers: FixedParser[] = [];
  private startTime = 0;
  private tickCount = 0;

  registerParser(sourceId: string, expressFn: ExpressFn): void {
    this.parsers.push({ sourceId, express: expressFn });
  }

  start(): void {
    this.startTime = Date.now();
    this.tickCount = 0;
  }

  async tick(
    fetchData: (source: string) => Promise<string>
  ): Promise<TickResult> {
    this.tickCount++;
    const sources: TickResult["sources"] = {};
    const temperatures: number[] = [];

    for (const parser of this.parsers) {
      const callStart = Date.now();

      let rawData: string;
      try {
        rawData = await fetchData(parser.sourceId);
      } catch (err: any) {
        sources[parser.sourceId] = {
          status: "fetch_error",
          error: err.message,
          latencyMs: Date.now() - callStart,
        };
        continue;
      }

      try {
        const result = await parser.express({
          rawData,
          source: parser.sourceId,
        });
        temperatures.push(result.temperature);
        sources[parser.sourceId] = {
          status: "success",
          temperature: result.temperature,
          latencyMs: Date.now() - callStart,
        };
      } catch (err: any) {
        sources[parser.sourceId] = {
          status: "parse_error",
          error: err.message,
          latencyMs: Date.now() - callStart,
        };
      }
    }

    const aggregatedTemperature =
      temperatures.length > 0
        ? Math.round(
            (temperatures.reduce((a, b) => a + b, 0) / temperatures.length) * 10
          ) / 10
        : undefined;

    return {
      tick: this.tickCount,
      timestampMs: Date.now(),
      elapsedSec: Math.round((Date.now() - this.startTime) / 1000),
      sources,
      aggregatedTemperature,
      successfulSources: temperatures.length,
    };
  }
}
