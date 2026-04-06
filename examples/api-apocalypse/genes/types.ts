export interface WeatherParserInput {
  rawData: string;
  source: string;
}

export interface WeatherParserOutput {
  temperature: number;
  unit: string;
  city: string;
}
