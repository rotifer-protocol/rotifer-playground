import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * L0 门控的执行路径覆盖回归测试。
 *
 * 缺口（2026-08-20 审计 P0-3）：`rotifer run` 只在「有 gene.ir.wasm 且未传
 * --no-sandbox」时走 WASM 沙箱（该路径经 execute_gated() → L0Gate::check()）。
 * 未编译 / --no-sandbox / 原生插件加载失败三种情况会落到 Node.js 降级路径，
 * 以完整宿主权限执行 index.ts，既不过沙箱也不过 L0 门控——而 Spec 定义 L0 是
 * 唯一不参与进化、不可绕过的宪法级约束。
 *
 * 这些用例锁定「降级路径也必须过门控」。撤掉修复后 A/B/D 三条必须变红。
 */
describe("L0 gate must cover the Node.js fallback path", () => {
  let projectDir: string;
  let previousCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const writeGene = (opts: { withWasm: boolean }) => {
    const dir = join(projectDir, "genes", "test-gene");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({
        domain: "evil.hack",
        version: "0.1.0",
        fidelity: "Native",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
      }),
    );
    writeFileSync(join(dir, "index.ts"), "export function express(input) { return input; }\n");
    if (opts.withWasm) writeFileSync(join(dir, "gene.ir.wasm"), "not-real-wasm");
  };

  beforeEach(() => {
    vi.resetModules();
    previousCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-l0-bypass-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    process.chdir(projectDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(previousCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const output = () =>
    [
      ...errorSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

  const expectExit = () =>
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

  it("A. 未编译的基因走降级路径时，L0 违规必须拦下执行", async () => {
    writeGene({ withWasm: false });
    const l0Check = vi.fn(() => ({
      passed: false,
      violations: ["domain 'evil.hack' is not in the allowed list"],
      checksPerformed: 4,
    }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    expectExit();

    const { runCommand } = await import("../../src/commands/run.js");
    await expect(runCommand.parseAsync(["test-gene"], { from: "user" })).rejects.toThrow("EXIT:1");

    expect(l0Check).toHaveBeenCalled();
    expect(output()).toContain("evil.hack");
    expect(output()).not.toContain("Running via Node.js");
  });

  it("B. 原生插件不可用时必须 fail closed，而不是无门控执行", async () => {
    writeGene({ withWasm: false });
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => null }));
    expectExit();

    const { runCommand } = await import("../../src/commands/run.js");
    await expect(runCommand.parseAsync(["test-gene"], { from: "user" })).rejects.toThrow("EXIT:1");

    expect(output()).not.toContain("Running via Node.js");
  });

  it("C. 控制项：L0 通过时不得误拦，必须到达执行阶段", async () => {
    writeGene({ withWasm: false });
    const l0Check = vi.fn(() => ({ passed: true, violations: [], checksPerformed: 4 }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { runCommand } = await import("../../src/commands/run.js");
    await runCommand.parseAsync(["test-gene"], { from: "user" }).catch(() => {});

    expect(l0Check).toHaveBeenCalled();
    expect(output()).toContain("Running via Node.js");
    expect(output()).not.toContain("L0 gate blocked");
  });

  it("D. --no-sandbox 只关沙箱，不得连 L0 门控一起关掉", async () => {
    writeGene({ withWasm: true });
    const l0Check = vi.fn(() => ({
      passed: false,
      violations: ["domain 'evil.hack' is not in the allowed list"],
      checksPerformed: 4,
    }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    expectExit();

    const { runCommand } = await import("../../src/commands/run.js");
    await expect(
      runCommand.parseAsync(["test-gene", "--no-sandbox"], { from: "user" }),
    ).rejects.toThrow("EXIT:1");

    expect(l0Check).toHaveBeenCalled();
    expect(output()).not.toContain("Running via Node.js");
  });
});

describe("L0 gate must cover `agent run` fallback too", () => {
  let projectDir: string;
  let previousCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    previousCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-l0-agent-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    const geneDir = join(projectDir, "genes", "solo");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ domain: "evil.hack", version: "0.1.0", fidelity: "Native" }),
    );
    writeFileSync(join(geneDir, "index.ts"), "export function express(i) { return i; }\n");

    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".rotifer", "agents", "a.json"),
      JSON.stringify({ id: "a1", name: "agent-x", state: "Active", genome: ["solo"] }),
    );

    process.chdir(projectDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(previousCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const output = () =>
    [
      ...errorSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

  it("E. agent run 的 Node.js 降级路径必须过门控", async () => {
    const l0Check = vi.fn(() => ({
      passed: false,
      violations: ["domain 'evil.hack' is not in the allowed list"],
      checksPerformed: 4,
    }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync(["agent-x"], { from: "user" }).catch(() => {});

    expect(l0Check).toHaveBeenCalled();
    expect(output()).toContain("L0 gate blocked");
  });

  it("F. --no-sandbox 不得让 agent run 跳过门控", async () => {
    const l0Check = vi.fn(() => ({
      passed: false,
      violations: ["domain 'evil.hack' is not in the allowed list"],
      checksPerformed: 4,
    }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync(["agent-x", "--no-sandbox"], { from: "user" }).catch(() => {});

    // 回归点：--no-sandbox 曾让 binding 直接为 null，门控连同沙箱一起被关掉。
    expect(l0Check).toHaveBeenCalled();
    expect(output()).toContain("L0 gate blocked");
  });
});
