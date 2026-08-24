import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 复核（2026-08-20）挖出的两类问题的回归锁：
 *
 *   ① `l0Check` 抛异常时调用点没接 —— phenotype 不完整的开发中基因会让 napi
 *      反序列化失败并裸抛，用户看到暴露内部路径的 Node 栈跟踪；TryPool 那条
 *      本该故障转移的路径会整个进程崩掉，比没有门控时更糟。
 *   ② 全仓 6 个动态 import 基因源码的点里，`test.ts` 与 `hello.ts` 三处从未接入
 *      门控。`rotifer test` 尤其讽刺——它是 L2 校准的对外工具，自己的降级分支
 *      却零门控，而唯一提到 L0Gate 的 C3 挂在 opt-in 的 --compliance 下、且排在
 *      执行之后，判定失败也只是给报告计一笔。
 */
describe("evaluateL0 separates a safety verdict from an inability to judge", () => {
  it("A. binding 不可用 → unavailable，不是 violation", async () => {
    const { evaluateL0 } = await import("../../src/utils/l0-gate.js");
    const r = evaluateL0(null, { domain: "x" });
    expect(r.kind).toBe("unavailable");
  });

  it("B. l0Check 抛异常 → unavailable，且不得把异常抛给调用方", async () => {
    const { evaluateL0 } = await import("../../src/utils/l0-gate.js");
    const throwing = {
      l0Check: () => {
        throw new Error("invalid phenotype JSON: missing field `inputSchema`");
      },
    } as never;
    let r: { kind: string; detail?: string } | null = null;
    expect(() => { r = evaluateL0(throwing, { domain: "x" }); }).not.toThrow();
    expect(r!.kind).toBe("unavailable");
    expect(r!.detail).toContain("inputSchema");
  });

  it("C. 门控判定不通过 → violation（安全结论，与 unavailable 不同）", async () => {
    const { evaluateL0 } = await import("../../src/utils/l0-gate.js");
    const blocking = {
      l0Check: () => ({ passed: false, violations: ["domain 'evil.hack' is not in the allowed list"], checksPerformed: 4 }),
    } as never;
    const r = evaluateL0(blocking, { domain: "x" });
    expect(r.kind).toBe("violation");
    expect(r.kind === "violation" && r.detail).toContain("evil.hack");
  });

  it("D. 控制项：通过时 pass，不得误拦", async () => {
    const { evaluateL0 } = await import("../../src/utils/l0-gate.js");
    const ok = { l0Check: () => ({ passed: true, violations: [], checksPerformed: 4 }) } as never;
    expect(evaluateL0(ok, { domain: "x" }).kind).toBe("pass");
  });
});

describe("L0 gate must cover `test` and `hello` fallbacks", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const writeGene = (name: string) => {
    const dir = join(projectDir, "genes", name);
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
    writeFileSync(join(dir, "index.ts"), "export function express(i) { return i; }\n");
  };

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-l0-rest-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    writeGene("solo");
    // chdir 在 worker 线程里会抛（Stryker 的 vitest runner 就跑在里面，
    // 初始测试一挂整轮变异测试就中止）；命令全经 process.cwd() 找项目根，
    // spy 等效且线程安全。
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
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

  const blockingBinding = () => {
    const l0Check = vi.fn(() => ({
      passed: false,
      violations: ["domain 'evil.hack' is not in the allowed list"],
      checksPerformed: 4,
    }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    return l0Check;
  };

  it("E. `rotifer test` 的 Node.js 降级分支必须过门控", async () => {
    const l0Check = blockingBinding();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { testCommand } = await import("../../src/commands/test.js");
    await testCommand.parseAsync(["solo"], { from: "user" }).catch(() => {});

    expect(l0Check).toHaveBeenCalled();
    expect(output()).toContain("L0 gate blocked");
    // 门控必须在执行之前——拦下后不得再进 express()
    expect(output()).not.toContain("express() returned successfully");
  });

  it("F. `rotifer hello` 的基因流水线必须过门控", async () => {
    const l0Check = blockingBinding();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const mod = await import("../../src/commands/hello.js");
    const pipeline = (mod as Record<string, unknown>).executeGenomePipeline as
      | ((g: string[], d: string, i: unknown) => Promise<{ error?: string }>)
      | undefined;
    expect(pipeline, "executeGenomePipeline 需要导出才能被回归测试锁住").toBeTypeOf("function");

    const result = await pipeline!(["solo"], join(projectDir, "genes"), { name: "world" });
    expect(l0Check).toHaveBeenCalled();
    expect(String(result?.error ?? "")).toContain("L0 gate blocked");
  });
});

describe("when the gate cannot run, provenance decides", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const writeGene = (name: string, opts: { installed: boolean }) => {
    const dir = join(projectDir, "genes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({
        domain: "test.unit", version: "0.1.0", fidelity: "Native",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
      }),
    );
    writeFileSync(join(dir, "index.ts"), "export function express(i) { return i; }\n");
    if (opts.installed) {
      writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ cloud_id: "x", owner: "someone-else", installed_at: "2026-08-20T00:00:00.000Z" }));
    }
  };

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-l0-prov-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    // 原生插件缺失——正是发布分支锁文件窗口、以及无预编译二进制平台的处境
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => null }));
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
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

  it("G. 本地源码基因必须仍能跑 —— 否则拿不到原生插件的平台上 CLI 整个不可用", async () => {
    writeGene("local-gene", { installed: false });
    const mod = await import("../../src/commands/hello.js");
    const pipeline = (mod as Record<string, unknown>).executeGenomePipeline as
      (g: string[], d: string, i: unknown) => Promise<{ error?: string; output?: unknown }>;

    const result = await pipeline(["local-gene"], join(projectDir, "genes"), { hello: "world" });
    expect(String(result?.error ?? ""), "本地基因不该因门控跑不了而被拦").not.toContain("blocked");
    expect(output()).toContain("could not run");
  });

  it("H. 装来的基因必须被拒 —— 别人的代码 + 无沙箱无门控 = 不能跑", async () => {
    writeGene("installed-gene", { installed: true });
    const mod = await import("../../src/commands/hello.js");
    const pipeline = (mod as Record<string, unknown>).executeGenomePipeline as
      (g: string[], d: string, i: unknown) => Promise<{ error?: string }>;

    const result = await pipeline(["installed-gene"], join(projectDir, "genes"), { hello: "world" });
    expect(String(result?.error ?? "")).toContain("L0 gate blocked");
    expect(String(result?.error ?? "")).toContain("installed gene");
  });
});
