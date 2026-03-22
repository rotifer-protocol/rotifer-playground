import { describe, it, expect } from "vitest";
import { buildOpenCommand } from "../../src/utils/open-browser.js";

describe("buildOpenCommand", () => {
  const url = "https://example.com/auth?provider=gitlab&redirect_to=http://localhost:9876/callback";

  it("uses start with empty title on win32", () => {
    const cmd = buildOpenCommand(url, "win32");
    expect(cmd).toBe(`start "" "${url}"`);
    expect(cmd).toMatch(/^start ""/);
  });

  it("uses open on darwin", () => {
    const cmd = buildOpenCommand(url, "darwin");
    expect(cmd).toBe(`open "${url}"`);
  });

  it("uses xdg-open on linux", () => {
    const cmd = buildOpenCommand(url, "linux");
    expect(cmd).toBe(`xdg-open "${url}"`);
  });

  it("defaults to xdg-open for unknown platforms", () => {
    const cmd = buildOpenCommand(url, "freebsd");
    expect(cmd).toBe(`xdg-open "${url}"`);
  });
});
