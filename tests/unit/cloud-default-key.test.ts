import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLOUD_ANON_KEY,
  isLegacyJwtKey,
  resolveAnonKey,
} from "../../src/cloud/types.js";

/**
 * The CLI has to reach Rotifer Cloud out of the box. The project disabled its
 * legacy JWT API keys on 2026-09-07; the replacement is a publishable key,
 * which is public by design — it ships in the rotifer.ai page source, and the
 * database is protected by RLS, not by the key being secret. Shipping it as
 * the default is therefore a correctness fix, not a credential leak.
 */
describe("cloud default key", () => {
  it("ships a publishable key as the built-in default", () => {
    expect(DEFAULT_CLOUD_ANON_KEY.startsWith("sb_publishable_")).toBe(true);
  });

  it("never ships a legacy JWT key", () => {
    expect(DEFAULT_CLOUD_ANON_KEY.startsWith("eyJ")).toBe(false);
  });

  describe("isLegacyJwtKey", () => {
    it("recognises a legacy JWT key", () => {
      expect(isLegacyJwtKey("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def")).toBe(true);
    });

    it("does not flag a publishable key", () => {
      expect(isLegacyJwtKey("sb_publishable_abc123")).toBe(false);
    });

    it("does not flag empty or undefined", () => {
      expect(isLegacyJwtKey("")).toBe(false);
      expect(isLegacyJwtKey(undefined)).toBe(false);
    });
  });

  describe("resolveAnonKey", () => {
    it("falls back to the built-in default when nothing is configured", () => {
      expect(resolveAnonKey(undefined, undefined)).toBe(DEFAULT_CLOUD_ANON_KEY);
      expect(resolveAnonKey("", "")).toBe(DEFAULT_CLOUD_ANON_KEY);
    });

    it("prefers an explicitly configured key", () => {
      expect(resolveAnonKey("sb_publishable_mine", undefined)).toBe("sb_publishable_mine");
    });

    it("prefers the config file over the environment variable", () => {
      expect(resolveAnonKey("sb_publishable_file", "sb_publishable_env")).toBe(
        "sb_publishable_file",
      );
    });

    it("uses the environment variable when the config file has none", () => {
      expect(resolveAnonKey(undefined, "sb_publishable_env")).toBe("sb_publishable_env");
    });

    // The reason this function exists: a machine that used the CLI before the
    // rotation still has a legacy key in ~/.rotifer/cloud.json. Honouring it
    // would send a key the server now rejects, and the user would see an
    // authentication error on a fresh install with no idea why.
    it("ignores a stale legacy key in the config file", () => {
      expect(resolveAnonKey("eyJhbGciOiJIUzI1NiJ9.stale.sig", undefined)).toBe(
        DEFAULT_CLOUD_ANON_KEY,
      );
    });

    it("ignores a stale legacy key in the environment", () => {
      expect(resolveAnonKey(undefined, "eyJhbGciOiJIUzI1NiJ9.stale.sig")).toBe(
        DEFAULT_CLOUD_ANON_KEY,
      );
    });

    it("falls through a stale config key to a valid environment key", () => {
      expect(resolveAnonKey("eyJhbGciOiJIUzI1NiJ9.stale.sig", "sb_publishable_env")).toBe(
        "sb_publishable_env",
      );
    });
  });
});
