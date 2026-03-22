import { vi } from "vitest";

export const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue(""),
  }),
  workspaceFolders: [],
};

export const window = {
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  createTerminal: vi.fn().mockReturnValue({
    show: vi.fn(),
    sendText: vi.fn(),
  }),
  createWebviewPanel: vi.fn().mockReturnValue({
    webview: { html: "" },
    dispose: vi.fn(),
  }),
  createTreeView: vi.fn().mockReturnValue({
    dispose: vi.fn(),
  }),
  createStatusBarItem: vi.fn().mockReturnValue({
    text: "",
    tooltip: "",
    command: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  }),
  withProgress: vi.fn().mockImplementation((_opts: any, task: any) => task()),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
  SourceControl = 1,
  Window = 10,
}

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: "file" }),
  parse: (uri: string) => ({ fsPath: uri, scheme: "file" }),
};

export const env = {
  openExternal: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: any;
  command?: any;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

export class ThemeIcon {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class EventEmitter {
  event = vi.fn();
  fire = vi.fn();
  dispose = vi.fn();
}
