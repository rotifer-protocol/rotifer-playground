import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("display", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("success outputs checkmark and message", async () => {
    const display = await import("../../src/utils/display.js");
    display.success("done");
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("✓");
    expect(output).toContain("done");
  });

  it("error outputs cross mark and message to stderr", async () => {
    const display = await import("../../src/utils/display.js");
    display.error("failed");
    expect(consoleErrorSpy).toHaveBeenCalled();
    const output = consoleErrorSpy.mock.calls[0][0] as string;
    expect(output).toContain("✗");
    expect(output).toContain("failed");
  });

  it("error outputs detail line", async () => {
    const display = await import("../../src/utils/display.js");
    display.error("failed", "some detail");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    const detail = consoleErrorSpy.mock.calls[1][0] as string;
    expect(detail).toContain("some detail");
  });

  it("info outputs info icon and message", async () => {
    const display = await import("../../src/utils/display.js");
    display.info("hello");
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("ℹ");
    expect(output).toContain("hello");
  });

  it("warn outputs warning icon and message", async () => {
    const display = await import("../../src/utils/display.js");
    display.warn("careful");
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("⚠");
    expect(output).toContain("careful");
  });

  it("hint outputs muted info icon and message", async () => {
    const display = await import("../../src/utils/display.js");
    display.hint("try this");
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("try this");
  });

  it("header outputs title with separator", async () => {
    const display = await import("../../src/utils/display.js");
    display.header("Test Header");
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    const title = consoleSpy.mock.calls[1][0] as string;
    expect(title).toContain("Test Header");
  });

  it("keyValue outputs key-value pair", async () => {
    const display = await import("../../src/utils/display.js");
    display.keyValue("Name", "test-gene");
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("Name:");
    expect(output).toContain("test-gene");
  });

  it("kv is alias for keyValue", async () => {
    const display = await import("../../src/utils/display.js");
    expect(display.kv).toBe(display.keyValue);
  });

  it("geneId truncates and formats ID", async () => {
    const display = await import("../../src/utils/display.js");
    const result = display.geneId("abcdef123456789");
    expect(result).toContain("abcdef123456");
    expect(result).toContain("…");
  });

  it("geneId does not append ellipsis to short IDs", async () => {
    const display = await import("../../src/utils/display.js");
    const result = display.geneId("short-id");
    expect(display.stripAnsi(result)).toBe("short-id");
  });

  it("link falls back to text (url) in non-TTY", async () => {
    const display = await import("../../src/utils/display.js");
    const result = display.link("Click", "https://example.com");
    expect(result).toContain("Click");
    expect(result).toContain("https://example.com");
  });

  it("stripAnsi removes ANSI escape sequences", async () => {
    const display = await import("../../src/utils/display.js");
    const result = display.stripAnsi("\x1b[32mgreen\x1b[0m text");
    expect(result).toBe("green text");
  });

  it("table renders header and rows", async () => {
    const display = await import("../../src/utils/display.js");
    const data = [
      { name: "alpha", score: 10 },
      { name: "beta", score: 20 },
    ];
    display.table(data as unknown as Record<string, unknown>[], [
      { key: "name", label: "Name", width: 10 },
      { key: "score", label: "Score", width: 8, format: (v) => String(v) },
    ]);
    expect(consoleSpy).toHaveBeenCalledTimes(4);
  });

  it("table handles empty data", async () => {
    const display = await import("../../src/utils/display.js");
    display.table([], [
      { key: "name", label: "Name", width: 10 },
    ]);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("barChart renders bars", async () => {
    const display = await import("../../src/utils/display.js");
    display.barChart([
      { label: "A", value: 10 },
      { label: "B", value: 5 },
    ], { barWidth: 10 });
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    const line = consoleSpy.mock.calls[0][0] as string;
    expect(line).toContain("A");
  });

  it("rustStyleError outputs formatted error", async () => {
    const display = await import("../../src/utils/display.js");
    display.rustStyleError({
      code: "E0001",
      message: "test error",
      file: "foo.ts",
      line: 42,
      suggestion: "fix it",
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calls = consoleErrorSpy.mock.calls.map((c) => c[0] as string);
    const joined = calls.join("\n");
    expect(joined).toContain("E0001");
    expect(joined).toContain("test error");
    expect(joined).toContain("foo.ts:42");
    expect(joined).toContain("fix it");
  });

  it("header omits separator when separator: false", async () => {
    const display = await import("../../src/utils/display.js");
    display.header("No Sep", { separator: false });
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    const title = consoleSpy.mock.calls[1][0] as string;
    expect(title).toContain("No Sep");
    const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allOutput).not.toContain("─");
  });

  it("header includes separator by default", async () => {
    const display = await import("../../src/utils/display.js");
    display.header("With Sep");
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    const sep = consoleSpy.mock.calls[2][0] as string;
    expect(sep).toContain("─");
  });

  describe("box", () => {
    it("renders bordered box with content", async () => {
      const display = await import("../../src/utils/display.js");
      display.box(["Hello World", "Line two"]);
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).toContain("┌");
      expect(allOutput).toContain("┘");
      expect(allOutput).toContain("Hello World");
      expect(allOutput).toContain("Line two");
    });

    it("renders box with title", async () => {
      const display = await import("../../src/utils/display.js");
      display.box(["content"], { title: "My Title" });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).toContain("My Title");
      expect(allOutput).toContain("content");
    });
  });

  describe("spinner", () => {
    it("returns object with stop and update methods", async () => {
      const display = await import("../../src/utils/display.js");
      const s = display.spinner("loading...");
      expect(typeof s.stop).toBe("function");
      expect(typeof s.update).toBe("function");
      s.stop();
    });

    it("non-TTY spinner prints message to stderr and stop prints success", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const display = await import("../../src/utils/display.js");
      const s = display.spinner("working");
      expect(stderrSpy).toHaveBeenCalledWith("working\n");
      s.stop("done!");
      expect(consoleSpy).toHaveBeenCalledWith("done!");
      stderrSpy.mockRestore();
    });

    it("spinner in json mode just prints to stderr", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("json");
      const s = display.spinner("loading");
      expect(stderrSpy).toHaveBeenCalledWith("loading\n");
      s.stop();
      display.setOutputMode("human");
      stderrSpy.mockRestore();
    });
  });

  describe("table terminal width", () => {
    it("table shrinks columns when terminal is narrow", async () => {
      const display = await import("../../src/utils/display.js");
      const originalColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 40, writable: true, configurable: true });

      display.table(
        [{ name: "a-very-long-gene-name-here", domain: "media.video.processing" }] as unknown as Record<string, unknown>[],
        [
          { key: "name", label: "Name", width: 30 },
          { key: "domain", label: "Domain", width: 30 },
        ],
      );

      expect(consoleSpy).toHaveBeenCalled();

      Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
    });

    it("table truncates cells that exceed column width with ellipsis", async () => {
      const display = await import("../../src/utils/display.js");
      const originalColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 30, writable: true, configurable: true });

      display.table(
        [{ name: "a-very-long-gene-name-exceeding-width", score: "99" }] as unknown as Record<string, unknown>[],
        [
          { key: "name", label: "Name", width: 10 },
          { key: "score", label: "Score", width: 8 },
        ],
      );

      const dataRow = consoleSpy.mock.calls[2]?.[0] as string;
      if (dataRow) {
        const plain = display.stripAnsi(dataRow);
        expect(plain).toContain("…");
      }

      Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
    });

    it("table rows do not exceed terminal width", async () => {
      const display = await import("../../src/utils/display.js");
      const originalColumns = process.stdout.columns;
      const termWidth = 50;
      Object.defineProperty(process.stdout, "columns", { value: termWidth, writable: true, configurable: true });

      display.table(
        [{ a: "very-long-content-here-abcdefghij", b: "also-very-long-content-xyz" }] as unknown as Record<string, unknown>[],
        [
          { key: "a", label: "ColumnA", width: 30 },
          { key: "b", label: "ColumnB", width: 30 },
        ],
      );

      const dataRow = consoleSpy.mock.calls[2]?.[0] as string;
      if (dataRow) {
        const plainLen = display.stripAnsi(dataRow).length;
        expect(plainLen).toBeLessThanOrEqual(termWidth);
      }

      Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
    });

    it("table still fits when many columns must shrink below preferred minimums", async () => {
      const display = await import("../../src/utils/display.js");
      const originalColumns = process.stdout.columns;
      const termWidth = 24;
      Object.defineProperty(process.stdout, "columns", { value: termWidth, writable: true, configurable: true });

      display.table(
        [{
          a: "alpha-long",
          b: "bravo-long",
          c: "charlie-long",
          d: "delta-long",
          e: "echo-long",
          f: "foxtrot-long",
        }] as unknown as Record<string, unknown>[],
        [
          { key: "a", label: "A", width: 12 },
          { key: "b", label: "B", width: 12 },
          { key: "c", label: "C", width: 12 },
          { key: "d", label: "D", width: 12 },
          { key: "e", label: "E", width: 12 },
          { key: "f", label: "F", width: 12 },
        ],
      );

      for (const call of consoleSpy.mock.calls) {
        const line = call[0] as string;
        expect(display.stripAnsi(line).length).toBeLessThanOrEqual(termWidth);
      }

      Object.defineProperty(process.stdout, "columns", { value: originalColumns, writable: true, configurable: true });
    });
  });

  describe("banner", () => {
    it("returns non-empty string in human mode", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const result = display.banner("1.0.0");
      expect(result).toContain("Rotifer Protocol");
      expect(result).toContain("1.0.0");
    });

    it("returns empty string when --plain is in process.argv", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origArgv = process.argv;
      process.argv = [...origArgv, "--plain"];
      const result = display.banner("1.0.0");
      expect(result).toBe("");
      process.argv = origArgv;
    });

    it("returns empty string when --json is in process.argv", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origArgv = process.argv;
      process.argv = [...origArgv, "--json"];
      const result = display.banner("1.0.0");
      expect(result).toBe("");
      process.argv = origArgv;
    });
  });

  describe("welcomeBanner", () => {
    it("prints ASCII art logo with version", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origCI = process.env.CI;
      delete process.env.CI;
      display.welcomeBanner({ version: "1.2.3" });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).toContain("___|_|");
      expect(allOutput).toContain("1.2.3");
      if (origCI !== undefined) process.env.CI = origCI;
    });

    it("prints message when provided", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origCI = process.env.CI;
      delete process.env.CI;
      display.welcomeBanner({ version: "1.0.0", message: "Agent workspace ready!" });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).toContain("Agent workspace ready!");
      if (origCI !== undefined) process.env.CI = origCI;
    });

    it("prints hints when provided", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origCI = process.env.CI;
      delete process.env.CI;
      display.welcomeBanner({
        version: "1.0.0",
        hints: [["rotifer init", "Create project"]],
      });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).toContain("rotifer init");
      expect(allOutput).toContain("Create project");
      if (origCI !== undefined) process.env.CI = origCI;
    });

    it("is silent in json mode", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("json");
      display.welcomeBanner({ version: "1.0.0", message: "hello" });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).not.toContain("hello");
      display.setOutputMode("human");
    });

    it("is silent when CI env is set", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      const origCI = process.env.CI;
      process.env.CI = "true";
      display.welcomeBanner({ version: "1.0.0", message: "should not appear" });
      const allOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(allOutput).not.toContain("should not appear");
      if (origCI === undefined) delete process.env.CI;
      else process.env.CI = origCI;
    });
  });

  describe("output modes", () => {
    it("setOutputMode sets mode", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("json");
      expect(display.getOutputMode()).toBe("json");
      expect(display.isJsonMode()).toBe(true);
      display.setOutputMode("human");
    });

    it("renderResult outputs JSON in json mode", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("json");
      display.renderResult({ name: "test", value: 42 }, () => {
        throw new Error("Should not render human output in JSON mode");
      });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe("test");
      expect(parsed.value).toBe(42);
      display.setOutputMode("human");
    });

    it("renderResult calls human renderer in human mode", async () => {
      const display = await import("../../src/utils/display.js");
      display.setOutputMode("human");
      let called = false;
      display.renderResult({ x: 1 }, () => { called = true; });
      expect(called).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });
});
