import * as vscode from "vscode";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RotiferCloudClient, CloudGene } from "./cloud-client";

export async function installGeneToWorkspace(
  gene: CloudGene,
  workspaceRoot: string,
  client: RotiferCloudClient,
): Promise<string> {
  const genesDir = join(workspaceRoot, "genes", gene.name);

  if (existsSync(genesDir)) {
    const overwrite = await vscode.window.showWarningMessage(
      `Gene '${gene.name}' already exists. Overwrite?`,
      "Yes", "No",
    );
    if (overwrite !== "Yes") throw new Error("Installation cancelled");
  }

  mkdirSync(genesDir, { recursive: true });

  writeFileSync(
    join(genesDir, "phenotype.json"),
    JSON.stringify(gene.phenotype, null, 2) + "\n",
  );

  writeFileSync(
    join(genesDir, ".cloud-manifest.json"),
    JSON.stringify({
      cloud_id: gene.id,
      owner: gene.owner,
      version: gene.version,
      installed_at: new Date().toISOString(),
    }, null, 2) + "\n",
  );

  if (gene.wasm_path) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${gene.name} WASM...` },
      async () => {
        const wasm = await client.downloadWasm(gene.wasm_path!);
        writeFileSync(join(genesDir, "gene.ir.wasm"), wasm);
      },
    );
  }

  return genesDir;
}
