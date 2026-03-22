import * as vscode from "vscode";
import { RotiferCloudClient, CloudGene } from "./cloud-client";

export class GeneTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly gene?: CloudGene,
    public readonly domain?: string,
  ) {
    super(label, collapsibleState);

    if (gene) {
      const repLabel = gene.reputation_score != null ? ` ★${(gene.reputation_score * 100).toFixed(0)}` : "";
      this.description = `v${gene.version} · ${gene.fidelity}${repLabel}`;
      this.tooltip = `${gene.description || gene.name}\nDownloads: ${gene.downloads ?? 0}`;
      this.contextValue = "gene";

      this.iconPath = new vscode.ThemeIcon(
        gene.fidelity === "Native" ? "symbol-method"
        : gene.fidelity === "Hybrid" ? "symbol-interface"
        : "symbol-field"
      );

      this.command = {
        command: "rotifer.geneDetails",
        title: "View Details",
        arguments: [this],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = "domain";
    }
  }
}

export class GeneTreeProvider implements vscode.TreeDataProvider<GeneTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GeneTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private genes: CloudGene[] = [];

  constructor(private client: RotiferCloudClient) {}

  refresh(): void {
    this.genes = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: GeneTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GeneTreeItem): Promise<GeneTreeItem[]> {
    if (!element) {
      if (this.genes.length === 0) {
        try {
          this.genes = await this.client.listGenes();
        } catch (err: any) {
          vscode.window.showWarningMessage(`Failed to load genes: ${err.message}`);
          return [new GeneTreeItem("Failed to load — click refresh", vscode.TreeItemCollapsibleState.None)];
        }
      }

      const domains = [...new Set(this.genes.map((g) => g.domain))].sort();
      if (domains.length === 0) {
        return [new GeneTreeItem("No genes published yet", vscode.TreeItemCollapsibleState.None)];
      }
      return domains.map((d) =>
        new GeneTreeItem(`${d} (${this.genes.filter((g) => g.domain === d).length})`, vscode.TreeItemCollapsibleState.Collapsed, undefined, d)
      );
    }

    if (element.domain) {
      return this.genes
        .filter((g) => g.domain === element.domain)
        .sort((a, b) => (b.reputation_score ?? 0) - (a.reputation_score ?? 0))
        .map((g) => new GeneTreeItem(g.name, vscode.TreeItemCollapsibleState.None, g));
    }

    return [];
  }
}
