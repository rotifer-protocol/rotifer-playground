import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture display output.
vi.mock("../../src/utils/display.js", () => ({
  header: vi.fn(),
  kv: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
  table: vi.fn(),
  renderResult: vi.fn((d: unknown, f: (d: unknown) => void) => f(d)),
}));

// Mock only the native node factory; keep the rest of the binding module real.
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode: vi.fn(),
}));

import { networkCommand } from "../../src/commands/network.js";
import { loadP2pNode } from "../../src/utils/binding.js";
import * as display from "../../src/utils/display.js";

const WORK = join(tmpdir(), `rotifer-net-unit-${Date.now()}`);
let origCwd: string;

function fakeNode() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    peerId: vi.fn(() => "12D3KooTEST"),
    listenAddrs: vi.fn(() => ["/ip4/127.0.0.1/tcp/1"]),
    discoveredPeers: vi.fn(() => []),
    announceGene: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  origCwd = process.cwd();
  mkdirSync(join(WORK, "genes", "test-gene"), { recursive: true });
  writeFileSync(
    join(WORK, "genes", "test-gene", "phenotype.json"),
    JSON.stringify({ name: "test-gene", domain: "test", version: "1.2.3", fidelity: "Native" })
  );
  process.chdir(WORK);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(WORK, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("network announce (P2P wiring)", () => {
  it("starts a node, announces the gene's phenotype fields, then stops", async () => {
    const node = fakeNode();
    vi.mocked(loadP2pNode).mockReturnValue(node);

    await networkCommand.parseAsync(["announce", "test-gene"], { from: "user" });

    expect(node.start).toHaveBeenCalledOnce();
    expect(node.announceGene).toHaveBeenCalledWith(
      "test-gene",
      "test-gene",
      "test",
      "1.2.3",
      "Native"
    );
    expect(node.stop).toHaveBeenCalledOnce();
    expect(display.success).toHaveBeenCalled();
  });

  it("errors (and never loads a node) when the gene is missing", async () => {
    await networkCommand.parseAsync(["announce", "no-such-gene"], { from: "user" });

    expect(loadP2pNode).not.toHaveBeenCalled();
    expect(display.error).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      expect.anything()
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("network start (P2P wiring)", () => {
  it("reports unavailable (without blocking) when the native addon is missing", async () => {
    vi.mocked(loadP2pNode).mockReturnValue(null);

    await networkCommand.parseAsync(["start"], { from: "user" });

    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});
