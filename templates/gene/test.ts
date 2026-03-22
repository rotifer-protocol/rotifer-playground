import { describe, it, expect } from "vitest";
import { express } from "./index.js";

describe("{{name}}", () => {
  it("should process input and return output", async () => {
    const result = await express({ input: "hello" });
    expect(result).toHaveProperty("output");
    expect(typeof result.output).toBe("string");
  });

  it("should handle empty input", async () => {
    const result = await express({ input: "" });
    expect(result).toHaveProperty("output");
  });
});
