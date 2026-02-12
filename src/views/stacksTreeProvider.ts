import * as vscode from "vscode";
import { LangfuseManager } from "../stacks/langfuseManager";

type StackState = "running" | "stopped" | "not-installed";

export class StacksTreeProvider
  implements vscode.TreeDataProvider<StackItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private langfuseState: StackState = "stopped";

  constructor(private langfuse: LangfuseManager) {}

  refresh(): void {
    // Resolve state asynchronously then fire update
    this.resolveStates().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: StackItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<StackItem[]> {
    return [
      new StackItem(
        "Langfuse",
        this.langfuseState,
        this.langfuse.dashboardUrl,
      ),
      // Future: add more stacks here (e.g. Jaeger, Phoenix, etc.)
    ];
  }

  private async resolveStates(): Promise<void> {
    const dockerOk = await this.langfuse.isDockerInstalled();
    if (!dockerOk) {
      this.langfuseState = "not-installed";
      return;
    }
    this.langfuseState = (await this.langfuse.isRunning())
      ? "running"
      : "stopped";
  }
}

class StackItem extends vscode.TreeItem {
  constructor(
    label: string,
    state: StackState,
    dashboardUrl: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    switch (state) {
      case "running":
        this.description = `Running — ${dashboardUrl}`;
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        this.contextValue = "stack-running";
        this.command = {
          command: "agentTracing.openDashboard",
          title: "Open Dashboard",
        };
        break;
      case "stopped":
        this.description = "Stopped";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        this.contextValue = "stack-stopped";
        this.command = {
          command: "agentTracing.startStack",
          title: "Start Stack",
        };
        break;
      case "not-installed":
        this.description = "Docker not found";
        this.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("problemsWarningIcon.foreground"),
        );
        this.contextValue = "stack-not-installed";
        this.command = {
          command: "agentTracing.setup",
          title: "Run Setup",
        };
        break;
    }

    this.tooltip = `${label} (${state})\n${dashboardUrl}`;
    this.id = `stack-${label.toLowerCase()}`;
  }
}
