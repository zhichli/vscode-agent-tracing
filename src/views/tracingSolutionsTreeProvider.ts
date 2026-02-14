import * as vscode from "vscode";
import { LangfuseManager } from "../stacks/langfuseManager";
import { HookManager } from "../hooks/hookManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LangfuseState =
  | "not-configured"
  | "running"           // managed, running
  | "running-external"  // external instance detected
  | "stopped"
  | "docker-not-found";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TracingSolutionsTreeProvider
  implements vscode.TreeDataProvider<LangfuseNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private langfuseState: LangfuseState = "not-configured";
  private hooksInstalled = false;

  constructor(
    private langfuse: LangfuseManager,
    private hookManager: HookManager,
  ) {}

  refresh(): void {
    this.resolveStates().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: LangfuseNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: LangfuseNode): Promise<LangfuseNode[]> {
    if (!element) {
      return [new LangfuseNode(this.langfuseState, this.hooksInstalled, this.langfuse.dashboardUrl)];
    }
    return [];
  }

  private async resolveStates(): Promise<void> {
    this.hooksInstalled = this.hookManager.isHookInstalled();

    const running = await this.langfuse.isRunning();

    if (running) {
      this.langfuseState = this.langfuse.isExternal ? "running-external" : "running";
      return;
    }

    const dockerOk = await this.langfuse.isDockerInstalled();
    if (!dockerOk) {
      this.langfuseState = "docker-not-found";
      return;
    }

    if (this.hooksInstalled || this.langfuse.isManaged) {
      this.langfuseState = "stopped";
    } else {
      this.langfuseState = "not-configured";
    }
  }
}

// ---------------------------------------------------------------------------
// Langfuse node (leaf — no children)
// ---------------------------------------------------------------------------

class LangfuseNode extends vscode.TreeItem {
  constructor(state: LangfuseState, hooksOn: boolean, dashboardUrl: string) {
    super("Langfuse", vscode.TreeItemCollapsibleState.None);

    switch (state) {
      case "running":
        this.description = hooksOn
          ? `Tracing — ${dashboardUrl}`
          : `Running — ${dashboardUrl}`;
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        this.contextValue = hooksOn ? "langfuse-running-hooks-on" : "langfuse-running-hooks-off";
        this.command = {
          command: "agentTracing.openDashboard",
          title: "Open Dashboard",
        };
        break;

      case "running-external":
        this.description = hooksOn
          ? `Tracing — ${dashboardUrl}`
          : `External — ${dashboardUrl}`;
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        this.contextValue = hooksOn ? "langfuse-running-external-hooks-on" : "langfuse-running-external-hooks-off";
        this.command = {
          command: "agentTracing.openDashboard",
          title: "Open Dashboard",
        };
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

    this.tooltip = `Langfuse (${state})${hooksOn ? " — hooks enabled" : ""}\n${dashboardUrl}`;
    this.id = "langfuse-root";
  }
}
