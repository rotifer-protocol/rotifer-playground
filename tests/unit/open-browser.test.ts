import { describe, it, expect } from "vitest";
import { buildOpenCommand } from "../../src/utils/open-browser.js";

describe("buildOpenCommand", () => {
  const url = "https://example.com/auth?provider=gitlab&redirect_to=http://localhost:9876/callback";

  it("uses cmd /c start on win32", () => {
    const { bin, args } = buildOpenCommand(url, "win32");
    expect(bin).toBe("cmd");
    expect(args).toEqual(["/c", "start", "", url]);
  });

  it("uses open on darwin", () => {
    const { bin, args } = buildOpenCommand(url, "darwin");
    expect(bin).toBe("open");
    expect(args).toEqual([url]);
  });

  it("uses xdg-open on linux", () => {
    const { bin, args } = buildOpenCommand(url, "linux");
    expect(bin).toBe("xdg-open");
    expect(args).toEqual([url]);
  });

  it("defaults to xdg-open for unknown platforms", () => {
    const { bin, args } = buildOpenCommand(url, "freebsd");
    expect(bin).toBe("xdg-open");
    expect(args).toEqual([url]);
  });
});
