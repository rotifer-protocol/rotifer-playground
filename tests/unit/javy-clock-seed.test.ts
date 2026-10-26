/**
 * javy 3.0.1 bakes the wall clock into every module it builds (T-95).
 *
 * QuickJS seeds Math.random from gettimeofday() during javy's pre-initialisation,
 * and the snapshot keeps that 8-byte microsecond value in the Data section. So
 * two compiles of the same source differ in those bytes, and the v2 gene ID —
 * which digests every standard section, Data included (ADR-340 D1) — changes
 * on every compile. normalizeJavyClockSeed() overwrites that one field.
 */
import { describe, expect, it } from "vitest";
import { normalizeJavyClockSeed } from "../../src/utils/javy-compiler.js";

const T0_US = 1_793_000_000_000_000; // 2026-10-26, in µs
const WINDOW: [number, number] = [T0_US - 5_000_000, T0_US + 5_000_000];
const SEED = Buffer.from("0123456789abcdef", "hex");

const u64le = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** A minimal module: header, a custom section, and a Data section holding `data`. */
function moduleWith(data: Buffer, customPayload = Buffer.alloc(0)): Buffer {
  const section = (id: number, body: Buffer) => Buffer.concat([Buffer.from([id, body.length]), body]);
  const name = Buffer.from("x");
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    section(0, Buffer.concat([Buffer.from([name.length]), name, customPayload])),
    section(11, data),
  ]);
}

describe("normalizeJavyClockSeed", () => {
  it("replaces the one compile-time clock value in the Data section with the seed", () => {
    const data = Buffer.concat([Buffer.from([1, 2, 3]), u64le(T0_US + 1234), Buffer.from([4, 5])]);
    const wasm = moduleWith(data);
    const result = normalizeJavyClockSeed(wasm, WINDOW, SEED);
    expect(result.status).toBe("normalized");
    const at = wasm.length - data.length + 3;
    expect(result.wasm.subarray(at, at + 8)).toEqual(SEED);
    // Nothing else moved.
    expect(Buffer.concat([result.wasm.subarray(0, at), result.wasm.subarray(at + 8)]))
      .toEqual(Buffer.concat([wasm.subarray(0, at), wasm.subarray(at + 8)]));
  });

  it("makes two builds a few seconds apart identical", () => {
    const a = moduleWith(Buffer.concat([Buffer.from([9]), u64le(T0_US - 4_000_000)]));
    const b = moduleWith(Buffer.concat([Buffer.from([9]), u64le(T0_US + 3_000_000)]));
    expect(a.equals(b)).toBe(false);
    expect(normalizeJavyClockSeed(a, WINDOW, SEED).wasm.equals(normalizeJavyClockSeed(b, WINDOW, SEED).wasm)).toBe(true);
  });

  it("leaves the module alone when no value falls in the window", () => {
    const wasm = moduleWith(Buffer.concat([u64le(T0_US - 60_000_000), u64le(42)]));
    const result = normalizeJavyClockSeed(wasm, WINDOW, SEED);
    expect(result.status).toBe("absent");
    expect(result.wasm.equals(wasm)).toBe(true);
  });

  it("refuses to guess when two values fall in the window", () => {
    const wasm = moduleWith(Buffer.concat([u64le(T0_US), Buffer.from([0]), u64le(T0_US + 1)]));
    const result = normalizeJavyClockSeed(wasm, WINDOW, SEED);
    expect(result.status).toBe("ambiguous");
    expect(result.wasm.equals(wasm)).toBe(true);
  });

  it("only looks in the Data section — a clock-shaped value elsewhere is not touched", () => {
    const wasm = moduleWith(Buffer.from([7, 7]), u64le(T0_US));
    const result = normalizeJavyClockSeed(wasm, WINDOW, SEED);
    expect(result.status).toBe("absent");
    expect(result.wasm.equals(wasm)).toBe(true);
  });
});
