import { beforeEach, describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { buildOpenCommand, openBrowser } from "../../src/utils/open-browser.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(() => ({ on: vi.fn() })) }));

describe("buildOpenCommand", () => {
  const url = "https://example.com/auth?provider=gitlab&redirect_to=http://localhost:9876/callback";

  it("does not go through cmd or a shell on win32", () => {
    const { bin, args } = buildOpenCommand(url, "win32", { SystemRoot: "D:\\WinNT" });
    expect(bin).toBe("D:\\WinNT\\System32\\rundll32.exe");
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(`${bin} ${args.join(" ")}`).not.toMatch(/\bcmd\b|powershell/i);
  });

  it("uses an absolute path on win32 even when SystemRoot is not set", () => {
    const { bin } = buildOpenCommand(url, "win32", {});
    expect(bin).toBe("C:\\Windows\\System32\\rundll32.exe");
  });

  it("keeps a URL with shell metacharacters as one argument", () => {
    const risky = "https://example.com/a?b=1&calc.exe|whoami";
    const { args } = buildOpenCommand(risky, "win32", {});
    expect(args).toHaveLength(2);
    expect(args[1]).toBe(risky);
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

  describe.each(["win32", "darwin", "linux"])("refuses what is not a plain http(s) URL on %s", (platform) => {
    it.each([
      ["an injected command", 'https://example.com" & calc.exe'],
      ["a space", "https://example.com/a b"],
      ["a newline", "https://example.com/\ncalc.exe"],
      ["a tab", "https://exa\tmple.com"],
      ["a backslash", "https://example.com\\@evil.test"],
      ["a file URL", "file:///etc/passwd"],
      ["a javascript URL", "javascript:alert(1)"],
      ["a custom scheme", "ms-settings:privacy"],
      ["a missing //", "https:example.com"],
      ["a command-line flag", "-a Calculator"],
      ["credentials", "https://user:secret@example.com"],
      ["something that is not a URL", "http://"],
      ["an empty string", ""],
    ])("%s", (_label, bad) => {
      expect(() => buildOpenCommand(bad, platform)).toThrow(/http/i);
    });

    it("does not repeat the rejected value, which may hold a password", () => {
      let message = "";
      try {
        buildOpenCommand("https://user:hunter2@example.com", platform);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("hunter2");
    });
  });
});

describe("openBrowser", () => {
  beforeEach(() => vi.mocked(execFile).mockClear());

  it("launches nothing for a refused URL and reports failure", () => {
    expect(openBrowser('https://example.com" & calc.exe')).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("starts the program directly, without a shell option", () => {
    expect(openBrowser("https://example.com/")).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]).toHaveLength(2);
  });
});
