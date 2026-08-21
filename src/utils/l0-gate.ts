import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NativeBinding } from "./binding.js";

/**
 * L0 门控的判定结果。
 *
 * 关键在于把两件事分开——它们的正确应对完全不同：
 *
 *   - `violation`：门控**跑了**，并且判定这个基因不该执行。这是安全结论，
 *     硬拒绝，没有逃生阀。
 *   - `unavailable`：门控**跑不了**（原生插件缺失、phenotype 读不出来）。
 *     这是环境/数据问题，不是关于这个基因的安全结论——把它当成违规一律拒绝，
 *     代价是整个 CLI 在拿不到预编译二进制的平台上彻底不可用。
 */
export type L0Outcome =
  | { kind: "pass" }
  | { kind: "violation"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * 对一个基因的 phenotype 跑 L0 门控。
 *
 * 三条 unavailable 分支都不抛异常：Rust 侧 `Phenotype` 的 domain / inputSchema /
 * outputSchema / version 没有 serde default，是真必填；而 CLI 侧 `phenotype` 是
 * `any`、解析后从不做结构校验。一个 phenotype 还没写完整的开发中基因会让 napi
 * 反序列化失败并抛出去——调用点若不接，用户看到的是暴露内部路径的 Node 栈跟踪，
 * TryPool 那种本该故障转移的场景还会整个进程崩掉。
 */
export function evaluateL0(
  binding: NativeBinding | null,
  phenotype: Record<string, unknown>,
): L0Outcome {
  if (!binding) {
    return { kind: "unavailable", detail: "native addon failed to load" };
  }
  try {
    const { irHash: _strip, ...phenotypeForL0 } = phenotype;
    const result = binding.l0Check(JSON.stringify(phenotypeForL0));
    return result.passed
      ? { kind: "pass" }
      : { kind: "violation", detail: result.violations.join("; ") };
  } catch (err: any) {
    return { kind: "unavailable", detail: `phenotype unreadable (${err?.message ?? err})` };
  }
}

/**
 * 门控跑不了时，这个基因还能不能放行——取决于它是谁写的。
 *
 * 外部来源的基因（装过来的、带 `.cloud-manifest.json`）一律拒绝：代码不是用户
 * 写的，没有沙箱也没有门控就以宿主全权限跑它，正是这次修复要堵的东西。
 *
 * 本地源码基因放行并警告：代码就在用户自己的项目里、可读可改，而降级路径下的
 * L0 本来也只查元数据、拦不住实际行为，所以这里的安全损失有限；反过来，拒绝它
 * 的代价是 `rotifer run` / `agent run` 在任何拿不到原生插件的环境里彻底不可用
 * （不受支持的平台、optional dependency 装失败、发布分支 CI 的锁文件窗口）。
 */
export function isExternallySourced(geneDir: string): boolean {
  return existsSync(join(geneDir, ".cloud-manifest.json"));
}
