import * as vscode from "vscode";
import { RotiferCloudClient, ArenaEntry } from "./cloud-client";

export class ArenaItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly entry?: ArenaEntry,
    public readonly domain?: string,
  ) {
    super(label, collapsibleState);

    if (entry) {
      this.description = `F(g)=${entry.fitness.toFixed(4)} · ${entry.fidelity}`;
      this.tooltip = `${entry.gene_name} by ${entry.owner}\nFitness: ${entry.fitness}\nSafety: ${entry.safety}\nReputation: ${entry.reputation_score ?? "N/A"}`;
      this.contextValue = "arenaEntry";

      const medal = entry.rank <= 3
        ? entry.rank === 1 ? "star-full" : entry.rank === 2 ? "star-half" : "star-empty"
        : "symbol-event";
      this.iconPath = new vscode.ThemeIcon(medal);
    } else {
      this.iconPath = new vscode.ThemeIcon("trophy");
      this.contextValue = "arenaDomain";
    }
  }
}

export class ArenaTreeProvider implements vscode.TreeDataProvider<ArenaItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ArenaItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private entries: ArenaEntry[] = [];

  constructor(private client: RotiferCloudClient) {}

  refresh(): void {
    this.entries = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ArenaItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ArenaItem): Promise<ArenaItem[]> {
    if (!element) {
      if (this.entries.length === 0) {
        try {
          this.entries = await this.client.getArenaRankings();
        } catch (err: any) {
          vscode.window.showWarningMessage(`Failed to load arena: ${err.message}`);
          return [new ArenaItem("Failed to load — click refresh", vscode.TreeItemCollapsibleState.None)];
        }
      }

      if (this.entries.length === 0) {
        return [new ArenaItem("No arena entries yet", vscode.TreeItemCollapsibleState.None)];
      }

      const domains = [...new Set(this.entries.map((e) => e.domain))].sort();
      return domains.map((d) =>
        new ArenaItem(
          `${d} (${this.entries.filter((e) => e.domain === d).length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          d,
        ),
      );
    }

    if (element.domain) {
      return this.entries
        .filter((e) => e.domain === element.domain)
        .sort((a, b) => a.rank - b.rank)
        .map((e) => new ArenaItem(`#${e.rank} ${e.gene_name}`, vscode.TreeItemCollapsibleState.None, e));
    }

    return [];
  }
}
