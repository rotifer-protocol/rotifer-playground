import * as vscode from "vscode";
import { GeneTreeProvider, GeneTreeItem } from "./gene-tree";
import { LocalGeneTreeProvider, LocalGeneItem } from "./local-tree";
import { ArenaTreeProvider, ArenaItem } from "./arena-tree";
import { RotiferCloudClient, CloudGene } from "./cloud-client";
import { AuthManager } from "./auth";
import { installGeneToWorkspace } from "./gene-installer";
import { publishSkillAsGene } from "./skill-publisher";
import * as webviews from "./webviews";

export function activate(context: vscode.ExtensionContext) {
  const ONBOARDED_KEY = "rotifer.onboarded";
  if (!context.globalState.get(ONBOARDED_KEY)) {
    context.globalState.update(ONBOARDED_KEY, true);
    vscode.window
      .showInformationMessage(
        "Rotifer Protocol installed! Browse Genes, install capabilities, and compete in the Arena.",
        "Get Started",
        "Browse Genes",
      )
      .then((action) => {
        if (action === "Get Started")
          vscode.commands.executeCommand("workbench.action.openWalkthrough", "rotifer-foundation.rotifer-vscode#rotifer.getStarted");
        if (action === "Browse Genes")
          vscode.commands.executeCommand("rotiferGenes.focus");
      });
  }

  const client = new RotiferCloudClient();
  const auth = new AuthManager(client);

  const geneTree = new GeneTreeProvider(client);
  const localTree = new LocalGeneTreeProvider();
  const arenaTree = new ArenaTreeProvider(client);

  const geneView = vscode.window.createTreeView("rotiferGenes", {
    treeDataProvider: geneTree,
    showCollapseAll: true,
  });
  const localView = vscode.window.createTreeView("rotiferLocalGenes", {
    treeDataProvider: localTree,
    showCollapseAll: true,
  });
  const arenaView = vscode.window.createTreeView("rotiferArena", {
    treeDataProvider: arenaTree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    geneView, localView, arenaView,
    ...auth.disposables,

    // ── Auth ──
    vscode.commands.registerCommand("rotifer.login", () => auth.login()),
    vscode.commands.registerCommand("rotifer.logout", () => auth.logout()),
    vscode.commands.registerCommand("rotifer.authMenu", async () => {
      if (auth.isLoggedIn) {
        const action = await vscode.window.showQuickPick(
          ["View My Reputation", "Sign Out"],
          { title: `Signed in as @${auth.username}` },
        );
        if (action === "Sign Out") await auth.logout();
        if (action === "View My Reputation") await vscode.commands.executeCommand("rotifer.myReputation");
      } else {
        await auth.login();
      }
    }),

    // ── Gene Registry ──
    vscode.commands.registerCommand("rotifer.refreshGenes", () => geneTree.refresh()),
    vscode.commands.registerCommand("rotifer.installGene", async (item: GeneTreeItem) => {
      if (!item?.gene) return;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("Open a Rotifer project folder first.");
        return;
      }
      try {
        await installGeneToWorkspace(item.gene, folders[0].uri.fsPath, client);
        vscode.window.showInformationMessage(`Gene '${item.gene.name}' installed to genes/${item.gene.name}`);
        localTree.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Install failed: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("rotifer.geneDetails", async (item: GeneTreeItem) => {
      if (!item?.gene) return;
      const panel = vscode.window.createWebviewPanel("rotiferGeneDetails", `Gene: ${item.gene.name}`, vscode.ViewColumn.One, {});
      panel.webview.html = webviews.renderGeneDetails(item.gene);
    }),
    vscode.commands.registerCommand("rotifer.showReputation", async (item: GeneTreeItem) => {
      if (!item?.gene) return;
      const rep = await client.getGeneReputation(item.gene.id);
      if (!rep) {
        vscode.window.showInformationMessage(`No reputation data for '${item.gene.name}' yet.`);
        return;
      }
      const panel = vscode.window.createWebviewPanel("rotiferReputation", `Reputation: ${item.gene.name}`, vscode.ViewColumn.One, {});
      panel.webview.html = webviews.renderReputationPanel(item.gene.name, rep);
    }),

    // ── Search ──
    vscode.commands.registerCommand("rotifer.searchGenes", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Search genes by name or description" });
      if (!query) return;

      try {
        const genes = await client.listGenes({ query });
        if (genes.length === 0) {
          vscode.window.showInformationMessage("No genes found for: " + query);
          return;
        }
        const items = genes.map((g) => ({
          label: g.name,
          description: `${g.domain} · v${g.version} · ${g.fidelity}`,
          detail: g.description,
          gene: g,
        }));
        const picked = await vscode.window.showQuickPick(items, { title: `Search results for "${query}"`, matchOnDescription: true });
        if (picked) {
          const panel = vscode.window.createWebviewPanel("rotiferGeneDetails", `Gene: ${picked.gene.name}`, vscode.ViewColumn.One, {});
          panel.webview.html = webviews.renderGeneDetails(picked.gene);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Search failed: ${err.message}`);
      }
    }),

    // ── Stats ──
    vscode.commands.registerCommand("rotifer.geneStats", async (item?: GeneTreeItem) => {
      const geneId = item?.gene?.id || await vscode.window.showInputBox({ prompt: "Gene ID" });
      if (!geneId) return;
      const geneName = item?.gene?.name || geneId;
      try {
        const stats = await client.getGeneStats(geneId);
        const panel = vscode.window.createWebviewPanel("rotiferStats", `Stats: ${geneName}`, vscode.ViewColumn.One, {});
        panel.webview.html = webviews.renderGeneStats(geneName, stats);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to load stats: ${err.message}`);
      }
    }),

    // ── Version History ──
    vscode.commands.registerCommand("rotifer.geneVersions", async (item?: GeneTreeItem) => {
      let owner = item?.gene?.owner;
      let name = item?.gene?.name;
      if (!owner || !name) {
        const input = await vscode.window.showInputBox({ prompt: "owner/name (e.g., alice/my-gene)" });
        if (!input) return;
        [owner, name] = input.split("/");
        if (!owner || !name) {
          vscode.window.showErrorMessage("Format: owner/name");
          return;
        }
      }
      try {
        const versions = await client.listGeneVersions(owner, name);
        const panel = vscode.window.createWebviewPanel("rotiferVersions", `Versions: ${owner}/${name}`, vscode.ViewColumn.One, {});
        panel.webview.html = webviews.renderVersionHistory(owner, name, versions);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to load versions: ${err.message}`);
      }
    }),

    // ── Compare ──
    vscode.commands.registerCommand("rotifer.compareGenes", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Enter 2-5 gene IDs separated by commas",
        placeHolder: "id1, id2, id3",
      });
      if (!input) return;
      const ids = input.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length < 2) {
        vscode.window.showErrorMessage("At least 2 gene IDs required");
        return;
      }
      try {
        const genes = await Promise.all(ids.map((id) => client.listGenes({ query: id }).then((gs) => gs[0])));
        const valid = genes.filter(Boolean) as CloudGene[];
        if (valid.length < 2) {
          vscode.window.showErrorMessage("Could not find enough genes to compare");
          return;
        }
        const panel = vscode.window.createWebviewPanel("rotiferCompare", "Gene Comparison", vscode.ViewColumn.One, {});
        panel.webview.html = webviews.renderCompare(valid);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Compare failed: ${err.message}`);
      }
    }),

    // ── Publish ──
    vscode.commands.registerCommand("rotifer.publishSkill", async (uri: vscode.Uri) => {
      if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith("SKILL.md")) {
          vscode.window.showErrorMessage("Right-click a SKILL.md file, or open one first.");
          return;
        }
        uri = editor.document.uri;
      }
      try {
        await publishSkillAsGene(uri, client);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Publish failed: ${err.message}`);
      }
    }),

    // ── Local Gene Operations ──
    vscode.commands.registerCommand("rotifer.refreshLocalGenes", () => localTree.refresh()),

    vscode.commands.registerCommand("rotifer.testGene", async (item?: LocalGeneItem) => {
      const name = item?.gene?.name || await vscode.window.showInputBox({ prompt: "Gene name to test" });
      if (!name) return;
      runCliInTerminal(`test ${name}`, "test");
    }),
    vscode.commands.registerCommand("rotifer.compileGene", async (item?: LocalGeneItem) => {
      const name = item?.gene?.name || await vscode.window.showInputBox({ prompt: "Gene name to compile" });
      if (!name) return;
      runCliInTerminal(`compile ${name}`, "compile");
    }),
    vscode.commands.registerCommand("rotifer.runGene", async (item?: LocalGeneItem) => {
      const name = item?.gene?.name || await vscode.window.showInputBox({ prompt: "Gene name to run" });
      if (!name) return;
      const input = await vscode.window.showInputBox({ prompt: "Input JSON (optional)", value: '{"name":"world"}' });
      runCliInTerminal(`run ${name}${input ? ` --input '${input}'` : ""}`, "run");
    }),
    vscode.commands.registerCommand("rotifer.wrapGene", async () => {
      const name = await vscode.window.showInputBox({ prompt: "Gene name to wrap" });
      if (!name) return;
      runCliInTerminal(`wrap ${name}`, "wrap");
    }),
    vscode.commands.registerCommand("rotifer.scanGenes", () => {
      runCliInTerminal("scan", "scan");
    }),
    vscode.commands.registerCommand("rotifer.initProject", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Project name",
        value: "my-rotifer-project",
        validateInput: (v) => /^[a-z0-9-]+$/.test(v) ? null : "lowercase, digits, hyphens only",
      });
      if (!name) return;
      runCliInTerminal(`init ${name}`, "init");
    }),

    // ── Arena ──
    vscode.commands.registerCommand("rotifer.refreshArena", () => arenaTree.refresh()),
    vscode.commands.registerCommand("rotifer.arenaSubmit", async (item?: LocalGeneItem) => {
      const name = item?.gene?.name || await vscode.window.showInputBox({ prompt: "Gene name to submit to Arena" });
      if (!name) return;
      runCliInTerminal(`arena submit ${name}`, "arena");
    }),

    // ── Agent ──
    vscode.commands.registerCommand("rotifer.createAgent", async () => {
      const name = await vscode.window.showInputBox({ prompt: "Agent name" });
      if (!name) return;
      const genesInput = await vscode.window.showInputBox({ prompt: "Gene names (comma-separated)" });
      if (!genesInput) return;
      const genes = genesInput.split(",").map((s) => s.trim()).filter(Boolean);
      runCliInTerminal(`agent create ${name} --genes ${genes.join(" ")}`, "agent");
    }),
    vscode.commands.registerCommand("rotifer.listAgents", () => {
      runCliInTerminal("agent list", "agent");
    }),
    vscode.commands.registerCommand("rotifer.runAgent", async () => {
      const agentId = await vscode.window.showInputBox({ prompt: "Agent ID" });
      if (!agentId) return;
      runCliInTerminal(`agent run ${agentId}`, "agent");
    }),

    // ── Leaderboard & My Reputation ──
    vscode.commands.registerCommand("rotifer.showLeaderboard", async () => {
      try {
        const entries = await client.getLeaderboard();
        const panel = vscode.window.createWebviewPanel("rotiferLeaderboard", "Developer Leaderboard", vscode.ViewColumn.One, {});
        panel.webview.html = webviews.renderLeaderboard(entries);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to load leaderboard: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("rotifer.myReputation", async () => {
      if (!auth.isLoggedIn) {
        vscode.window.showErrorMessage("Sign in first: Rotifer > Sign In");
        return;
      }
      try {
        const rep = await client.getMyReputation();
        if (!rep) {
          vscode.window.showInformationMessage("No reputation data yet.");
          return;
        }
        const panel = vscode.window.createWebviewPanel("rotiferMyRep", "My Reputation", vscode.ViewColumn.One, {});
        panel.webview.html = webviews.renderMyReputation(auth.username || "unknown", rep);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to load reputation: ${err.message}`);
      }
    }),
  );
}

export function deactivate() {}

function runCliInTerminal(args: string, label: string): void {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath;
  const terminal = vscode.window.createTerminal({ name: `Rotifer: ${label}`, cwd });
  terminal.show();
  terminal.sendText(`npx rotifer ${args}`);
}

export { webviews };
