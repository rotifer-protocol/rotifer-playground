import * as vscode from "vscode";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LocalGeneInfo {
  name: string;
  path: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string;
  hasWasm: boolean;
  hasSource: boolean;
  cloudId?: string;
}

export class LocalGeneItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly gene?: LocalGeneInfo,
    public readonly domain?: string,
  ) {
    super(label, collapsibleState);

    if (gene) {
      this.description = `v${gene.version} · ${gene.fidelity}`;
      this.tooltip = `${gene.description || gene.name}\nPath: ${gene.path}`;
      this.contextValue = gene.cloudId ? "localGenePublished" : "localGene";

      const icon = gene.hasWasm ? "symbol-method"
        : gene.hasSource ? "symbol-field"
        : "symbol-property";
      this.iconPath = new vscode.ThemeIcon(icon);
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = "localDomain";
    }
  }
}

export class LocalGeneTreeProvider implements vscode.TreeDataProvider<LocalGeneItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LocalGeneItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private genes: LocalGeneInfo[] = [];

  refresh(): void {
    this.genes = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LocalGeneItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: LocalGeneItem): Promise<LocalGeneItem[]> {
    if (!element) {
      if (this.genes.length === 0) {
        this.genes = this.scanLocalGenes();
      }

      if (this.genes.length === 0) {
        return [new LocalGeneItem("No local genes found", vscode.TreeItemCollapsibleState.None)];
      }

      const domains = [...new Set(this.genes.map((g) => g.domain))].sort();
      return domains.map((d) =>
        new LocalGeneItem(
          `${d} (${this.genes.filter((g) => g.domain === d).length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          d,
        ),
      );
    }

    if (element.domain) {
      return this.genes
        .filter((g) => g.domain === element.domain)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((g) => new LocalGeneItem(g.name, vscode.TreeItemCollapsibleState.None, g));
    }

    return [];
  }

  private scanLocalGenes(): LocalGeneInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    const root = folders[0].uri.fsPath;
    let genesDir = "genes";

    try {
      const config = JSON.parse(readFileSync(join(root, "rotifer.json"), "utf-8"));
      genesDir = config.genes_dir || "genes";
    } catch { /* use default */ }

    const fullGenesDir = join(root, genesDir);
    if (!existsSync(fullGenesDir)) return [];

    const entries = readdirSync(fullGenesDir).filter((name) => {
      const p = join(fullGenesDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, "phenotype.json"));
    });

    return entries.map((name) => {
      const geneDir = join(fullGenesDir, name);
      let phenotype: any = {};
      let cloud: any = null;

      try { phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8")); } catch {}
      try { cloud = JSON.parse(readFileSync(join(geneDir, ".cloud-manifest.json"), "utf-8")); } catch {}

      return {
        name,
        path: geneDir,
        domain: phenotype.domain || "unknown",
        version: phenotype.version || cloud?.version || "0.0.0",
        fidelity: phenotype.fidelity || "Unknown",
        description: phenotype.description || "",
        hasWasm: existsSync(join(geneDir, "gene.ir.wasm")),
        hasSource: existsSync(join(geneDir, "index.ts")),
        cloudId: cloud?.cloud_id,
      };
    });
  }
}
