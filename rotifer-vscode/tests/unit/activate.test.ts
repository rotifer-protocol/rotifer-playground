import { describe, it, expect, vi, beforeEach } from "vitest";
import pkg from "../../package.json";

vi.mock("vscode", () => import("../__mocks__/vscode"));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
}));

vi.mock("node:http", () => ({
  createServer: vi.fn(),
}));

import * as vscode from "vscode";
import { activate, deactivate, webviews } from "../../src/extension";

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file("/ext"),
    extensionPath: "/ext",
    globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn().mockReturnValue([]), setKeysForSync: vi.fn() },
    workspaceState: { get: vi.fn(), update: vi.fn(), keys: vi.fn().mockReturnValue([]) },
    secrets: { get: vi.fn().mockResolvedValue(undefined), store: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined), onDidChange: vi.fn() },
    storagePath: "/tmp/storage",
    globalStoragePath: "/tmp/global-storage",
    logPath: "/tmp/log",
    storageUri: vscode.Uri.file("/tmp/storage"),
    globalStorageUri: vscode.Uri.file("/tmp/global-storage"),
    logUri: vscode.Uri.file("/tmp/log"),
    extensionMode: 3,
    environmentVariableCollection: {} as any,
    extension: {} as any,
    asAbsolutePath: (p: string) => `/ext/${p}`,
    languageModelAccessInformation: {} as any,
  } as any;
}

describe("activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers tree views", () => {
    const ctx = makeContext();
    activate(ctx);
    expect(vscode.window.createTreeView).toHaveBeenCalledWith("rotiferGenes", expect.any(Object));
    expect(vscode.window.createTreeView).toHaveBeenCalledWith("rotiferLocalGenes", expect.any(Object));
    expect(vscode.window.createTreeView).toHaveBeenCalledWith("rotiferArena", expect.any(Object));
  });

  it("registers all expected commands", () => {
    const ctx = makeContext();
    activate(ctx);
    const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.map(([name]) => name);

    const expectedCommands = [
      "rotifer.login",
      "rotifer.logout",
      "rotifer.authMenu",
      "rotifer.refreshGenes",
      "rotifer.installGene",
      "rotifer.geneDetails",
      "rotifer.showReputation",
      "rotifer.searchGenes",
      "rotifer.geneStats",
      "rotifer.geneVersions",
      "rotifer.compareGenes",
      "rotifer.publishSkill",
      "rotifer.refreshLocalGenes",
      "rotifer.testGene",
      "rotifer.compileGene",
      "rotifer.runGene",
      "rotifer.wrapGene",
      "rotifer.scanGenes",
      "rotifer.initProject",
      "rotifer.refreshArena",
      "rotifer.arenaSubmit",
      "rotifer.createAgent",
      "rotifer.listAgents",
      "rotifer.runAgent",
      "rotifer.showLeaderboard",
      "rotifer.myReputation",
      "rotifer.vgScan",
      "rotifer.doctor",
    ];

    for (const cmd of expectedCommands) {
      expect(registered).toContain(cmd);
    }
  });

  it("adds all disposables to context.subscriptions", () => {
    const ctx = makeContext();
    activate(ctx);
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("registers exactly the commands package.json contributes", () => {
    const ctx = makeContext();
    activate(ctx);
    // Derive the expectation from the manifest instead of hard-coding a count:
    // the point of this test is that code and manifest agree, and a literal
    // here just fails every time a command is legitimately added.
    const declared: string[] = pkg.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    const registered = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map((call) => call[0] as string);

    expect(registered.length).toBe(declared.length);
    expect([...registered].sort()).toEqual([...declared].sort());
  });
});

describe("deactivate", () => {
  it("is a callable function that does not throw", () => {
    expect(() => deactivate()).not.toThrow();
  });

  it("returns undefined", () => {
    expect(deactivate()).toBeUndefined();
  });
});

describe("webviews export", () => {
  it("exports all render functions", () => {
    expect(webviews.renderGeneDetails).toBeTypeOf("function");
    expect(webviews.renderReputationPanel).toBeTypeOf("function");
    expect(webviews.renderGeneStats).toBeTypeOf("function");
    expect(webviews.renderVersionHistory).toBeTypeOf("function");
    expect(webviews.renderLeaderboard).toBeTypeOf("function");
    expect(webviews.renderMyReputation).toBeTypeOf("function");
    expect(webviews.renderCompare).toBeTypeOf("function");
  });
});

describe("command handlers (integration with mocks)", () => {
  it("installGene shows error when no workspace folder is open", async () => {
    const ctx = makeContext();
    activate(ctx);

    const installCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.installGene",
    );
    expect(installCall).toBeDefined();
    const handler = installCall![1];

    const mockItem = { gene: { id: "1", name: "test" } };
    vi.mocked(vscode.workspace as any).workspaceFolders = [];
    await handler(mockItem);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Open a Rotifer Agent workspace folder first.",
    );
  });

  it("installGene early-returns when item has no gene property", async () => {
    const ctx = makeContext();
    activate(ctx);

    const installCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.installGene",
    );
    const handler = installCall![1];
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    await handler({ gene: undefined });
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("searchGenes aborts when user cancels input", async () => {
    const ctx = makeContext();
    activate(ctx);

    const searchCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.searchGenes",
    );
    const handler = searchCall![1];
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
    await handler();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("compareGenes validates minimum 2 IDs", async () => {
    const ctx = makeContext();
    activate(ctx);

    const compareCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.compareGenes",
    );
    const handler = compareCall![1];
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("single-id");
    await handler();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "At least 2 gene IDs required",
    );
  });

  it("compareGenes aborts when user cancels input", async () => {
    const ctx = makeContext();
    activate(ctx);

    const compareCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.compareGenes",
    );
    const handler = compareCall![1];
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    await handler();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("myReputation shows error when not signed in", async () => {
    const ctx = makeContext();
    activate(ctx);

    const repCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.myReputation",
    );
    const handler = repCall![1];
    await handler();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Sign in first"),
    );
  });

  it("publishSkill shows error when no SKILL.md is active", async () => {
    const ctx = makeContext();
    activate(ctx);

    const pubCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.publishSkill",
    );
    const handler = pubCall![1];
    (vscode.window as any).activeTextEditor = undefined;
    await handler(undefined);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("SKILL.md"),
    );
  });

  it("geneVersions validates owner/name format", async () => {
    const ctx = makeContext();
    activate(ctx);

    const versionsCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.geneVersions",
    );
    const handler = versionsCall![1];
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("no-slash");
    await handler();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Format: owner/name");
  });

  it("local gene commands open terminal with correct CLI args", async () => {
    const ctx = makeContext();
    activate(ctx);

    const testCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.testGene",
    );
    const handler = testCall![1];
    await handler({ gene: { name: "my-gene" } });
    const terminal = vi.mocked(vscode.window.createTerminal).mock.results.at(-1)?.value;
    expect(terminal.sendText).toHaveBeenCalledWith("npx rotifer 'test' 'my-gene'");
  });

  it("scanGenes opens terminal with scan command", async () => {
    const ctx = makeContext();
    activate(ctx);

    const scanCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.scanGenes",
    );
    const handler = scanCall![1];
    handler();
    const terminal = vi.mocked(vscode.window.createTerminal).mock.results.at(-1)?.value;
    expect(terminal.sendText).toHaveBeenCalledWith("npx rotifer 'scan'");
  });

  it("initProject validates project name format", async () => {
    const ctx = makeContext();
    activate(ctx);

    const initCall = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
      ([name]) => name === "rotifer.initProject",
    );
    const handler = initCall![1];

    vi.mocked(vscode.window.showInputBox).mockClear();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
    await handler();

    const allCalls = vi.mocked(vscode.window.showInputBox).mock.calls;
    const initInputCall = allCalls.find(
      ([opts]) => opts && typeof opts === "object" && "validateInput" in opts,
    );
    expect(initInputCall).toBeDefined();
    expect(initInputCall![0]?.prompt).toBe("Agent workspace name");
    expect(initInputCall![0]?.value).toBe("my-agent");
    const validateFn = initInputCall![0]?.validateInput;
    expect(validateFn).toBeDefined();
    expect(validateFn!("valid-name")).toBeNull();
    expect(validateFn!("INVALID NAME")).not.toBeNull();
    expect(validateFn!("has spaces")).not.toBeNull();
  });
});
