import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { RotiferCloudClient } from "./cloud-client";

const GENE_NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

function validateGeneNameInput(name: string): boolean {
  if (!name || name.length > 128 || name.includes("..") || name.includes("/") || name.includes("\\")) {
    vscode.window.showErrorMessage(`Invalid gene name: "${name}". Only lowercase letters, digits, dots, hyphens, underscores allowed.`);
    return false;
  }
  if (!GENE_NAME_RE.test(name)) {
    vscode.window.showErrorMessage(`Invalid gene name: "${name}". Must match pattern: ${GENE_NAME_RE.source}`);
    return false;
  }
  return true;
}

export async function publishSkillAsGene(skillUri: vscode.Uri, client?: RotiferCloudClient): Promise<void> {
  const skillPath = skillUri.fsPath;
  const skillDir = dirname(skillPath);
  const content = readFileSync(skillPath, "utf-8");
  const parsed = parseSkillMd(content);

  const name = await vscode.window.showInputBox({
    prompt: "Gene name",
    value: parsed.name || basename(skillDir),
    validateInput: (v) => GENE_NAME_RE.test(v) ? null : "lowercase letters, digits, dots, hyphens, underscores only (must start/end with alphanumeric)",
  });
  if (!name || !validateGeneNameInput(name)) return;

  let domainOptions = ["nlp", "code", "data", "image", "audio", "security", "devops", "web3", "other"];
  if (client) {
    try {
      const cloudDomains = await client.getDomains();
      if (cloudDomains.length > 0) {
        domainOptions = [...new Set([...cloudDomains, ...domainOptions])].sort();
      }
    } catch { /* use defaults */ }
  }

  const domain = await vscode.window.showQuickPick(domainOptions, { title: "Gene domain" });
  if (!domain) return;

  const description = await vscode.window.showInputBox({
    prompt: "Gene description",
    value: parsed.description || "",
  });
  if (!description) return;

  const version = await vscode.window.showInputBox({ prompt: "Version", value: "0.1.0" });
  if (!version) return;

  const changelog = await vscode.window.showInputBox({
    prompt: "Changelog (optional, what changed in this version)",
    placeHolder: "e.g., Initial release",
  });

  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath || skillDir;

  const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  const terminal = vscode.window.createTerminal({ name: `Rotifer: publish ${name}`, cwd });
  terminal.show();
  terminal.sendText(
    ["npx", "rotifer", "wrap", esc(name), "--domain", esc(domain), "--fidelity", "Wrapped", "--from-skill", esc(skillPath)].join(" "),
  );

  const publishArgs = ["npx", "rotifer", "publish", esc(name), "--description", esc(description)];
  if (changelog) {
    publishArgs.push("--changelog", esc(changelog));
  }
  terminal.sendText(publishArgs.join(" "));

  vscode.window.showInformationMessage(`Publishing '${name}' as Gene. Check the terminal for progress.`);
}

export function parseSkillMd(content: string): { name?: string; description?: string } {
  const titleMatch = content.match(/^#\s+(.+)/m);
  const descMatch = content.match(/^>\s*(.+)/m) || content.match(/^[^#\n].{20,}/m);
  return {
    name: titleMatch?.[1]?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    description: descMatch?.[1]?.trim(),
  };
}
