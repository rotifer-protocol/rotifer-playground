import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 「门控跑不了时按来源判定」——来源到底怎么判。
 *
 * #251 用「目录里有没有 `.cloud-manifest.json`」当外来标志。但这张纸条有两个
 * 写入者：`install` 写（别人的代码，装过来的），`publish` 也写（你自己的代码，
 * 发出去之后留下的记录）。随包发的 60 个基因全是后者——它们是从本仓库发布出去
 * 的，`init` 把其中 5 个连纸条一起拷进每个新项目。
 *
 * 于是在拿不到原生插件的平台上，一个刚 init 的项目里，CLI 自己拷进来的起步基因
 * 被 CLI 自己当成「别人的代码」拒绝：`hello`、`agent run` 对它们全部报
 * 「on an installed gene」。这正是 #251 要避免的「CLI 整个不可用」，对捆绑基因
 * 原样回来了。对着真实发布的 0.20.0 包复现过（平台包物理挪走 + 真实 init）。
 *
 * 正确的信号纸条上本来就有：`publish` 写 `published_at`，三个安装器（CLI / MCP /
 * VS Code）写的都是 `installed_at`。外来 = 纸条是 install 写的。其余一律 fail
 * closed：没有时间戳、读不出来、两个都有——都按外来处理，宁可误拦不可误放。
 */

const REAL_SHIPPED_GENE = join(__dirname, "..", "..", "genes", "genesis-file-read");

describe("isExternallySourced judges by channel, not by presence", () => {
  let dir: string;
  const manifest = (doc: unknown) =>
    writeFileSync(join(dir, ".cloud-manifest.json"), typeof doc === "string" ? doc : JSON.stringify(doc));

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rotifer-prov-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("no manifest → local", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    expect(isExternallySourced(dir)).toBe(false);
  });

  it("written by publish (published_at) → local: it is the user's own code, recorded after shipping", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    manifest({ cloud_id: "x", owner: "me", version: "0.1.0", published_at: "2026-08-20T07:12:47.508Z" });
    expect(isExternallySourced(dir)).toBe(false);
  });

  it("written by install (installed_at) → external", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    manifest({ cloud_id: "x", owner: "someone-else", version: "0.1.0", installed_at: "2026-08-20T07:12:47.508Z" });
    expect(isExternallySourced(dir)).toBe(true);
  });

  it("fail closed: no timestamp at all → external", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    manifest({ cloud_id: "x", owner: "someone-else" });
    expect(isExternallySourced(dir)).toBe(true);
  });

  it("fail closed: both timestamps → external", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    manifest({ cloud_id: "x", published_at: "2026-01-01T00:00:00Z", installed_at: "2026-01-02T00:00:00Z" });
    expect(isExternallySourced(dir)).toBe(true);
  });

  it("fail closed: unreadable manifest → external", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    manifest("{ this is not json");
    expect(isExternallySourced(dir)).toBe(true);
  });

  it("the shipped genes init copies are local — checked against the real bundled gene, not a fixture", async () => {
    const { isExternallySourced } = await import("../../src/utils/l0-gate.js");
    const copy = join(dir, "genesis-file-read");
    cpSync(REAL_SHIPPED_GENE, copy, { recursive: true });
    expect(isExternallySourced(copy), "a gene the CLI itself ships must not be treated as someone else's").toBe(false);
  });
});

describe("when the gate cannot run, the genes init ships must still run", () => {
  let projectDir: string;
  let previousCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const writeGene = (name: string, manifest?: Record<string, unknown>) => {
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
    if (manifest) writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify(manifest));
  };

  beforeEach(() => {
    vi.resetModules();
    previousCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-l0-ship-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    // 原生插件缺失——linux-arm64 / alpine / 可选依赖没装上 的处境
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => null }));
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

  const pipeline = async () => {
    const mod = await import("../../src/commands/hello.js");
    return (mod as Record<string, unknown>).executeGenomePipeline as
      (g: string[], d: string, i: unknown) => Promise<{ error?: string }>;
  };

  it("I. a gene exactly as init ships it (real bundled dir, real manifest) runs with a warning", async () => {
    cpSync(REAL_SHIPPED_GENE, join(projectDir, "genes", "genesis-file-read"), { recursive: true });
    const run = await pipeline();
    const result = await run(["genesis-file-read"], join(projectDir, "genes"), { path: "nope" });
    expect(String(result?.error ?? ""), "CLI 自己拷进来的起步基因不能被它自己当外来拒绝").not.toContain("L0 gate blocked");
    expect(output()).toContain("could not run");
  });

  it("J. a gene the user published (publish-written manifest) runs with a warning", async () => {
    writeGene("mine", { cloud_id: "x", owner: "me", version: "0.1.0", published_at: "2026-08-20T07:12:47.508Z" });
    const run = await pipeline();
    const result = await run(["mine"], join(projectDir, "genes"), {});
    expect(String(result?.error ?? "")).not.toContain("L0 gate blocked");
    expect(output()).toContain("could not run");
  });

  it("K. a gene that was installed (install-written manifest) is still refused", async () => {
    writeGene("theirs", { cloud_id: "x", owner: "someone-else", version: "0.1.0", installed_at: "2026-08-20T07:12:47.508Z" });
    const run = await pipeline();
    const result = await run(["theirs"], join(projectDir, "genes"), {});
    expect(String(result?.error ?? "")).toContain("L0 gate blocked");
    expect(String(result?.error ?? "")).toContain("installed gene");
  });

  it("L. `rotifer run`: a published gene takes the Node.js fallback; an installed one is refused", async () => {
    writeGene("mine", { cloud_id: "x", owner: "me", version: "0.1.0", published_at: "2026-08-20T07:12:47.508Z" });
    writeGene("theirs", { cloud_id: "x", owner: "someone-else", version: "0.1.0", installed_at: "2026-08-20T07:12:47.508Z" });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`EXIT:${code}`); }) as never);

    const { runCommand } = await import("../../src/commands/run.js");
    await runCommand.parseAsync(["mine"], { from: "user" }).catch(() => {});
    expect(output()).toContain("Running via Node.js");
    expect(output()).not.toContain("Cloud-installed genes cannot run");

    logSpy.mockClear(); errorSpy.mockClear();
    await expect(runCommand.parseAsync(["theirs"], { from: "user" })).rejects.toThrow("EXIT:1");
    expect(output()).toContain("Cloud-installed genes cannot run");
    expect(output()).not.toContain("Running via Node.js");
  });
});
