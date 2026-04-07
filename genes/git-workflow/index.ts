export function express(input: { prompt: string }): {
  result: string;
} {
  const text = (input && input.prompt) || "";
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  const HIGH_RISK: Record<string, string> = {
    "push --force": "Force push overwrites remote history",
    "push -f": "Force push overwrites remote history",
    "reset --hard": "Destroys uncommitted changes permanently",
    "branch -D": "Force-deletes branch regardless of merge status",
    "clean -fd": "Permanently removes untracked files and directories",
    "rebase -i": "Interactive rebase rewrites commit history",
    "filter-branch": "Rewrites entire repository history",
  };

  const MEDIUM_RISK: Record<string, string> = {
    push: "Publishes commits to remote",
    merge: "Integrates branches — may cause conflicts",
    rebase: "Replays commits — rewrites local history",
    stash: "Temporarily shelves changes",
    "cherry-pick": "Applies specific commits to current branch",
    checkout: "Switches branches — uncommitted changes may be lost",
    switch: "Switches branches",
    tag: "Creates or modifies version tags",
  };

  const LOW_RISK = ["status", "log", "diff", "show", "branch", "remote", "fetch", "ls-files", "blame", "shortlog", "reflog"];

  const protectedBranches = ["main", "master", "production", "release", "develop"];

  interface CommandAnalysis {
    command: string;
    risk: "high" | "medium" | "low" | "unknown";
    reason: string;
    warnings: string[];
  }

  const analyzed: CommandAnalysis[] = [];
  const allWarnings: string[] = [];

  for (const line of lines) {
    const cmd = line.replace(/^git\s+/, "").trim();
    if (!cmd) continue;

    const entry: CommandAnalysis = {
      command: `git ${cmd}`,
      risk: "unknown",
      reason: "",
      warnings: [],
    };

    let matched = false;

    for (const [pattern, reason] of Object.entries(HIGH_RISK)) {
      if (cmd.includes(pattern)) {
        entry.risk = "high";
        entry.reason = reason;
        matched = true;
        break;
      }
    }

    if (!matched) {
      for (const [pattern, reason] of Object.entries(MEDIUM_RISK)) {
        if (cmd.startsWith(pattern) || cmd.includes(` ${pattern}`)) {
          entry.risk = "medium";
          entry.reason = reason;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      for (const low of LOW_RISK) {
        if (cmd.startsWith(low)) {
          entry.risk = "low";
          entry.reason = "Read-only operation";
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      entry.risk = "low";
      entry.reason = "Unrecognized git command — defaulting to low risk";
    }

    for (const branch of protectedBranches) {
      if (cmd.includes(branch)) {
        if (cmd.includes("push") && cmd.includes("--force")) {
          entry.warnings.push(`DANGER: Force pushing to protected branch '${branch}'`);
        } else if (cmd.includes("push")) {
          entry.warnings.push(`WARNING: Pushing directly to '${branch}' — consider using a PR`);
        } else if (cmd.includes("branch -D") || cmd.includes("branch -d")) {
          entry.warnings.push(`WARNING: Deleting protected branch '${branch}'`);
        }
      }
    }

    allWarnings.push(...entry.warnings);
    analyzed.push(entry);
  }

  const highCount = analyzed.filter((a) => a.risk === "high").length;
  const medCount = analyzed.filter((a) => a.risk === "medium").length;
  const overallRisk = highCount > 0 ? "high" : medCount > 0 ? "medium" : "low";

  const output = {
    commands: analyzed,
    summary: {
      total: analyzed.length,
      highRisk: highCount,
      mediumRisk: medCount,
      lowRisk: analyzed.filter((a) => a.risk === "low").length,
      overallRisk,
    },
    warnings: allWarnings,
    recommendation: highCount > 0
      ? "HIGH RISK: Review carefully before executing. Consider safer alternatives."
      : medCount > 0
        ? "MEDIUM RISK: Proceed with caution. Ensure you have backups."
        : "LOW RISK: Safe to execute.",
  };

  return { result: JSON.stringify(output, null, 2) };
}
