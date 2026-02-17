import * as vscode from "vscode";
import { LangfuseManager } from "../stacks/langfuseManager";
import { JaegerManager } from "../stacks/jaegerManager";
import { HookManager } from "../hooks/hookManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BackendState =
  | "not-configured"
  | "running"           // managed, running
  | "running-external"  // external instance detected
  | "stopped"
  | "docker-not-found";

/** Union type for tree items — either Langfuse or Jaeger node. */
type BackendNode = LangfuseNode | JaegerNode;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TracingSolutionsTreeProvider
  implements vscode.TreeDataProvider<BackendNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private langfuseState: BackendState = "not-configured";
  private jaegerState: BackendState = "not-configured";
  private hooksInstalled = false;

  constructor(
    private langfuse: LangfuseManager,
    private jaeger: JaegerManager,
    private hookManager: HookManager,
    private extensionUri: vscode.Uri,
  ) {}

  refresh(): void {
    this.resolveStates().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: BackendNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BackendNode): Promise<BackendNode[]> {
    if (!element) {
      return [
        new LangfuseNode(
          this.langfuseState,
          this.hooksInstalled,
          this.langfuse.dashboardUrl,
          this.extensionUri,
        ),
        new JaegerNode(
          this.jaegerState,
          this.jaeger.dashboardUrl,
          this.extensionUri,
        ),
      ];
    }
    return [];
  }

  private async resolveStates(): Promise<void> {
    this.hooksInstalled = this.hookManager.isHookInstalled();

    // Resolve Langfuse & Jaeger states in parallel
    const [langfuseRunning, jaegerRunning] = await Promise.all([
      this.langfuse.isRunning(),
      this.jaeger.isRunning(),
    ]);

    // Langfuse state
    if (langfuseRunning) {
      this.langfuseState = this.langfuse.isExternal ? "running-external" : "running";
    } else {
      const dockerOk = await this.langfuse.isDockerInstalled();
      if (!dockerOk) {
        this.langfuseState = "docker-not-found";
      } else if (this.hooksInstalled || this.langfuse.isManaged) {
        this.langfuseState = "stopped";
      } else {
        this.langfuseState = "not-configured";
      }
    }

    // Jaeger state
    if (jaegerRunning) {
      this.jaegerState = "running";
    } else {
      const dockerOk = await this.langfuse.isDockerInstalled(); // reuse Docker check
      if (!dockerOk) {
        this.jaegerState = "docker-not-found";
      } else if (this.jaeger.isConfigured) {
        this.jaegerState = "stopped";
      } else {
        this.jaegerState = "not-configured";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Langfuse node (leaf — no children)
// ---------------------------------------------------------------------------

class LangfuseNode extends vscode.TreeItem {
  constructor(
    state: BackendState,
    hooksOn: boolean,
    dashboardUrl: string,
    extensionUri: vscode.Uri,
  ) {
    super("Langfuse", vscode.TreeItemCollapsibleState.None);

    const runningIcon = vscode.Uri.joinPath(
      extensionUri,
      "resources",
      "icons",
      "langfuse-running.svg",
    );
    const warningIcon = new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("problemsWarningIcon.foreground"),
    );

    switch (state) {
      case "running":
        this.description = hooksOn ? dashboardUrl : `${dashboardUrl} (hooks disabled)`;
        this.iconPath = hooksOn
          ? { light: runningIcon, dark: runningIcon }
          : warningIcon;
        this.contextValue = hooksOn ? "langfuse-running-hooks-on" : "langfuse-running-hooks-off";
        break;

      case "running-external":
        this.description = hooksOn ? dashboardUrl : `${dashboardUrl} (hooks disabled)`;
        this.iconPath = hooksOn
          ? { light: runningIcon, dark: runningIcon }
          : warningIcon;
        this.contextValue = hooksOn ? "langfuse-running-external-hooks-on" : "langfuse-running-external-hooks-off";
        break;

      case "stopped":
        this.description = hooksOn ? "Stopped — hooks enabled" : "Stopped";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = hooksOn ? "langfuse-stopped-hooks-on" : "langfuse-stopped-hooks-off";
        break;

      case "not-configured":
        this.description = "Not configured";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = "langfuse-not-configured";
        break;

      case "docker-not-found":
        this.description = "Docker not found";
        this.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("problemsWarningIcon.foreground"),
        );
        this.contextValue = "langfuse-docker-not-found";
        break;
    }

    // Tooltip: show URL only when running
    const showUrl = state === "running" || state === "running-external";
    this.tooltip = showUrl
      ? `Langfuse (${state})${hooksOn ? " — hooks enabled" : ""}\n${dashboardUrl}`
      : `Langfuse (${state})${hooksOn ? " — hooks enabled" : ""}`;
    this.id = "langfuse-root";
  }
}

// ---------------------------------------------------------------------------
// Jaeger node (leaf — no children)
// ---------------------------------------------------------------------------

class JaegerNode extends vscode.TreeItem {
  constructor(
    state: BackendState,
    dashboardUrl: string,
    extensionUri: vscode.Uri,
  ) {
    super("Jaeger", vscode.TreeItemCollapsibleState.None);

    const runningIcon = vscode.Uri.joinPath(
      extensionUri,
      "resources",
      "icons",
      "jaeger-running.svg",
    );
    const warningIcon = new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("problemsWarningIcon.foreground"),
    );

    switch (state) {
      case "running":
        this.description = dashboardUrl;
        this.iconPath = { light: runningIcon, dark: runningIcon };
        this.contextValue = "jaeger-running";
        break;

      case "stopped":
        this.description = "Stopped";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = "jaeger-stopped";
        break;

      case "not-configured":
        this.description = "Not configured";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = "jaeger-not-configured";
        break;

      case "docker-not-found":
        this.description = "Docker not found";
        this.iconPath = warningIcon;
        this.contextValue = "jaeger-docker-not-found";
        break;

      default:
        this.description = "Not configured";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = "jaeger-not-configured";
        break;
    }

    const showUrl = state === "running";
    this.tooltip = showUrl
      ? `Jaeger (${state})\n${dashboardUrl}`
      : `Jaeger (${state})`;
    this.id = "jaeger-root";
  }
}
