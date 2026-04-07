import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { express, display } from "../../genes/data-formatter/index.js";

describe("Gene: data-formatter", () => {
  it("converts Wei to ETH", () => {
    const result = express({ data: "1000000000000000000" });

    expect(result.type).toBe("wei");
    expect(result.formatted).toContain("1.");
    expect(result.formatted).toContain("ETH");
  });

  it("shortens Ethereum addresses", () => {
    const result = express({ data: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });

    expect(result.type).toBe("address");
    expect(result.formatted).toBe("0xd8dA...6045");
    expect(result.formatted.length).toBeLessThan(42);
  });

  it("converts hex strings to decimal", () => {
    const result = express({ data: "0xff" });

    expect(result.type).toBe("hex");
    expect(result.formatted).toBe("255");
  });

  it("converts large hex values", () => {
    const result = express({ data: "0x10" });

    expect(result.formatted).toBe("16");
  });

  it("passes through unknown data types", () => {
    const result = express({ data: "hello world" });

    expect(result.type).toBe("passthrough");
    expect(result.formatted).toBe("hello world");
  });

  it("formats timestamps as ISO strings", () => {
    const result = express({ data: 1700000000 });

    expect(result.type).toBe("timestamp");
    expect(result.formatted).toContain("2023");
    expect(result.formatted).toContain("T");
  });

  it("handles json format mode", () => {
    const result = express({ data: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", format: "json" });

    const parsed = JSON.parse(result.formatted);
    expect(parsed.type).toBe("address");
    expect(parsed.value).toContain("...");
  });

  it("handles object input recursively", () => {
    const result = express({
      data: {
        balance: "1000000000000000000",
        owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      },
    });

    expect(result.type).toBe("object");
    expect(result.formatted).toContain("ETH");
    expect(result.formatted).toContain("...");
  });
});

describe("Gene: data-formatter display()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("shows type tag and truncates full address in output", () => {
    display({
      formatted: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      type: "address",
    });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("[address]");
    expect(joined).toContain("0xd8dA...6045");
  });

  it("shows wei and ETH lines for wei type", () => {
    display({ formatted: "1.000000 ETH", type: "wei" });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("Wei:");
    expect(joined).toContain("1000000000000000000");
    expect(joined).toContain("ETH:");
  });

  it("shows ISO and human lines for timestamp type", () => {
    display({ formatted: "2023-11-14T22:13:20.000Z", type: "timestamp" });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("ISO:");
    expect(joined).toContain("Human:");
  });
});
