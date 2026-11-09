import { describe, it, expect } from "vitest";
import { normalizeCloudEndpoint } from "../../src/cloud/auth.js";

describe("normalizeCloudEndpoint", () => {
  it.each([
    ["https://cloud.rotifer.dev", "https://cloud.rotifer.dev"],
    ["https://cloud.rotifer.dev/", "https://cloud.rotifer.dev"],
    ["http://localhost:54321", "http://localhost:54321"],
    ["HTTPS://Cloud.Rotifer.dev/", "https://cloud.rotifer.dev"],
    ["https://example.com/base/", "https://example.com/base"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeCloudEndpoint(raw)).toBe(expected);
  });

  it.each([
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["ftp scheme", "ftp://example.com"],
    ["no scheme", "example.com"],
    ["scheme without slashes", "https:example.com"],
    ["empty", ""],
    ["no host", "https://"],
    ["username only", "https://someone@example.com"],
    ["password only", "https://:hunter2@example.com"],
    ["username and password", "https://someone:hunter2@example.com"],
    ["tab", "https://example.com/\t"],
    ["newline", "https://example.com/\n"],
    ["space", "https://example.com/ x"],
    ["DEL", "https://example.com/\u007f"],
    ["C1 control", "https://example.com/\u0085"],
    ["backslash", "https:\\\\example.com"],
    ["backslash in the path", "https://example.com\\path"],
    ["query", "https://example.com?x=1"],
    ["fragment", "https://example.com#x"],
  ])("rejects %s", (_label, raw) => {
    expect(() => normalizeCloudEndpoint(raw)).toThrow(/Cloud endpoint/);
  });

  it("never repeats the input, which may carry a password", () => {
    let message = "";
    try {
      normalizeCloudEndpoint("https://someone:hunter2@example.com");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Cloud endpoint/);
    expect(message).not.toContain("hunter2");
  });
});
