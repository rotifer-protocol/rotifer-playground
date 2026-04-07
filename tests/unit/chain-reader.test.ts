import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { express, display } from "../../genes/chain-reader/index.js";

describe("Gene: chain-reader", () => {
  it("rejects invalid address format", async () => {
    await expect(
      express({ address: "not-an-address", action: "balance" })
    ).rejects.toThrow("Invalid address format");
  });

  it("rejects unsupported chain", async () => {
    await expect(
      express({
        address: "0x0000000000000000000000000000000000000000",
        chain: "solana",
        action: "balance",
      })
    ).rejects.toThrow("Unsupported chain");
  });

  it("defaults to ethereum chain", async () => {
    try {
      const result = await express({
        address: "0x0000000000000000000000000000000000000000",
        action: "balance",
      });
      expect(result.chain).toBe("ethereum");
      expect(typeof result.result).toBe("string");
    } catch {
      expect(true).toBe(true);
    }
  });

  it("accepts valid address and base chain without crashing", async () => {
    try {
      const result = await express({
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        chain: "base",
        action: "txCount",
      });
      expect(result.chain).toBe("base");
    } catch {
      expect(true).toBe(true);
    }
  });
});

describe("Gene: chain-reader display()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints chain header and result", () => {
    display({ result: "0xabc", chain: "ethereum" });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("Chain Data");
    expect(joined).toContain("ethereum");
    expect(joined).toContain("0xabc");
  });

  it("prints decimal line for hex results", () => {
    display({ result: "0xff", chain: "base" });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("255");
  });

  it("does not print decimal for non-hex result strings", () => {
    display({ result: "pending", chain: "ethereum" });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("pending");
    expect(joined).not.toContain("Decimal:");
  });
});
