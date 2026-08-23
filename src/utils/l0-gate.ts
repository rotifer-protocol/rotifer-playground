import { existsSync, readFileSync } from "node:fs";
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
 * 门控跑不了时，这个基因还能不能放行——取决于它是怎么来的。
 *
 * 外部来源的基因一律拒绝：代码不是用户写的，没有沙箱也没有门控就以宿主全权限
 * 跑它，正是 #251 要堵的东西。本地源码基因放行并警告：代码就在用户自己的项目里、
 * 可读可改，而降级路径下的 L0 本来也只查元数据、拦不住实际行为；反过来，拒绝它
 * 的代价是 CLI 在任何拿不到原生插件的环境里彻底不可用（不受支持的平台、optional
 * dependency 装失败、发布分支 CI 的锁文件窗口）。
 *
 * 「外来」怎么判，#251 最初用的是「有没有 `.cloud-manifest.json`」。这张纸条有两个
 * 写入者：`install` 写（装过来的，别人的代码），`publish` 也写（你自己发出去之后
 * 留下的记录）。随包发的基因全是后者——它们是从本仓库发布出去的，`init` 把其中五个
 * 连纸条一起拷进每个新项目。于是在没有预编译插件的平台上，CLI 自己拷进去的起步基因
 * 被 CLI 自己当成别人的代码拒绝：`hello` / `agent run` 全报「on an installed gene」。
 * 对着真实发布的 0.20.0 包复现过。
 *
 * 两个写入者留的时间戳不同：`publish` 写 `published_at`，三个安装器（CLI / MCP /
 * VS Code）写的都是 `installed_at`。所以外来 = 纸条是 install 写的。其余一律 fail
 * closed——没有时间戳、读不出来、两个都有——都按外来处理：宁可在怪环境里多拦一个，
 * 不在任何环境里放过一个。
 */
export function isExternallySourced(geneDir: string): boolean {
  const manifestPath = join(geneDir, ".cloud-manifest.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const hasPublishStamp = typeof m.published_at === "string";
    const hasInstallStamp = "installed_at" in m;
    return !(hasPublishStamp && !hasInstallStamp);
  } catch {
    return true;
  }
}
