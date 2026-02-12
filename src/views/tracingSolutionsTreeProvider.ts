import * as vscode from "vscode";
import { LangfuseManager } from "../stacks/langfuseManager";
import { HookManager, HookStatus } from "../hooks/hookManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LangfuseState =
  | "not-configured"
  | "running"           // managed, running
  | "running-external"  // external instance detected
  | "stopped"
  | "docker-not-found";

type TreeNode = LangfuseNode | AgentNode;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TracingSolutionsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private langfuseState: LangfuseState = "not-configured";
  private hookStatuses: HookStatus[] = [];

  constructor(
    private langfuse: LangfuseManager,
    private hookManager: HookManager,
  ) {}

  refresh(): void {
    this.resolveStates().then(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // Root level → Langfuse node
    if (!element) {
      return [new LangfuseNode(this.langfuseState, this.langfuse.dashboardUrl)];
    }

    // Children of Langfuse → agent nodes (only when configured)
    if (element instanceof LangfuseNode && this.langfuseState !== "docker-not-found") {
      return this.hookStatuses.map((s) => new AgentNode(s));
    }

    return [];
  }

  private async resolveStates(): Promise<void> {
    this.hookStatuses = await this.hookManager.getStatuses();
    const anyHookInstalled = this.hookStatuses.some((s) => s.installed);

    const running = await this.langfuse.isRunning();

    if (running) {
      // Determine if this is our managed stack or an external instance
      this.langfuseState = this.langfuse.isExternal ? "running-external" : "running";
      return;
    }

    // Not running — check Docker availability
    const dockerOk = await this.langfuse.isDockerInstalled();
    if (!dockerOk) {
      this.langfuseState = "docker-not-found";
      return;
    }

    if (anyHookInstalled || this.langfuse.isManaged) {
      this.langfuseState = "stopped";
    } else {
      this.langfuseState = "not-configured";
    }
  }
}

// ---------------------------------------------------------------------------
// Langfuse root node
// ---------------------------------------------------------------------------

class LangfuseNode extends vscode.TreeItem {
  constructor(state: LangfuseState, dashboardUrl: string) {
    // Expand by default when running or stopped (has agent children)
    const collapsible =
      state === "not-configured" || state === "docker-not-found"
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded;

    super("Langfuse", collapsible);

    switch (state) {
      case "running":
        this.description = `Running — ${dashboardUrl}`;
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        this.contextValue = "langfuse-running";
        this.command = {
          command: "agentTracing.openDashboard",
          title: "Open Dashboard",
        };
        break;

      case "running-external":
        this.description = `External — ${dashboardUrl}`;
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        this.contextValue = "langfuse-running-external";
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
        this.contextValue = "langfuse-stopped";
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

    this.tooltip = `Langfuse (${state})\n${dashboardUrl}`;
    this.id = "langfuse-root";
  }
}

// ---------------------------------------------------------------------------
// Agent child node
// ---------------------------------------------------------------------------

class AgentNode extends vscode.TreeItem {
  public readonly target: string;

  constructor(status: HookStatus) {
    super(status.label, vscode.TreeItemCollapsibleState.None);
    this.target = status.target;

    if (status.installed) {
      this.description = "Tracing";
      this.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed"),
      );
      this.contextValue = `agent-tracing-${status.target}`;
    } else {
      this.description = "Not tracing";
      this.iconPath = new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor("disabledForeground"),
      );
      this.contextValue = `agent-not-tracing-${status.target}`;
    }

    this.tooltip = `${status.label} — ${status.installed ? "Hook enabled" : "Hook disabled"}`;
    this.id = status.id;
  }
}
