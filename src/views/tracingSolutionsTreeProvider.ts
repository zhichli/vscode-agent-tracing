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
  private hookSettingsOk = true;

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
          this.hookSettingsOk,
          this.langfuse.dashboardUrl,
          this.extensionUri,
        ),
        new JaegerNode(
          this.jaegerState,
          this.hooksInstalled,
          this.hookSettingsOk,
          this.jaeger.dashboardUrl,
          this.extensionUri,
        ),
      ];
    }
    return [];
  }

  private async resolveStates(): Promise<void> {
    this.hooksInstalled = this.hookManager.isHookInstalled();
    vscode.commands.executeCommand("setContext", "agentTracing.hooksInstalled", this.hooksInstalled);

    // Check VS Code hook settings only when hooks are installed
    if (this.hooksInstalled) {
      const { useHooks, useClaudeHooks } = this.hookManager.checkVSCodeHookSettings();
      this.hookSettingsOk = useHooks && useClaudeHooks;
    } else {
      this.hookSettingsOk = true; // irrelevant when no hooks
    }

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
    hookSettingsOk: boolean,
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

    // If hooks are on but VS Code settings aren't enabled, override display
    const hooksEffective = hooksOn && hookSettingsOk;
    const settingsWarning = hooksOn && !hookSettingsOk
      ? " — enable chat.useHooks in VS Code settings"
      : "";

    switch (state) {
      case "running": {
        this.description = hooksEffective
          ? dashboardUrl
          : `${dashboardUrl} (hooks disabled${settingsWarning})`;
        this.iconPath = hooksEffective
          ? { light: runningIcon, dark: runningIcon }
          : warningIcon;
        const hookSuffix = hooksOn
          ? (hookSettingsOk ? "hooks-on" : "hooks-settings-off")
          : "hooks-off";
        this.contextValue = `langfuse-running-${hookSuffix}`;
        break;
      }

      case "running-external": {
        this.description = hooksEffective
          ? dashboardUrl
          : `${dashboardUrl} (hooks disabled${settingsWarning})`;
        this.iconPath = hooksEffective
          ? { light: runningIcon, dark: runningIcon }
          : warningIcon;
        const hookSuffix = hooksOn
          ? (hookSettingsOk ? "hooks-on" : "hooks-settings-off")
          : "hooks-off";
        this.contextValue = `langfuse-running-external-${hookSuffix}`;
        break;
      }

      case "stopped": {
        this.description = hooksOn
          ? `Stopped — hooks enabled${settingsWarning}`
          : "Stopped";
        this.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("disabledForeground"),
        );
        const hookSuffix = hooksOn
          ? (hookSettingsOk ? "hooks-on" : "hooks-settings-off")
          : "hooks-off";
        this.contextValue = `langfuse-stopped-${hookSuffix}`;
        break;
      }

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
    const hookStatus = hooksOn
      ? hookSettingsOk
        ? " — hooks enabled"
        : " — hooks installed but chat.useHooks / chat.useClaudeHooks disabled in VS Code settings"
      : "";
    this.tooltip = showUrl
      ? `Langfuse (${state})${hookStatus}\n${dashboardUrl}`
      : `Langfuse (${state})${hookStatus}`;
    this.id = "langfuse-root";
  }
}

// ---------------------------------------------------------------------------
// Jaeger node (leaf — no children)
// ---------------------------------------------------------------------------

class JaegerNode extends vscode.TreeItem {
  constructor(
    state: BackendState,
    hooksOn: boolean,
    hookSettingsOk: boolean,
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

    const hooksEffective = hooksOn && hookSettingsOk;
    const settingsWarning = hooksOn && !hookSettingsOk
      ? " — enable chat.useHooks in VS Code settings"
      : "";

    switch (state) {
      case "running":
        this.description = hooksEffective
          ? dashboardUrl
          : `${dashboardUrl} (hooks disabled${settingsWarning})`;
        this.iconPath = hooksEffective
          ? { light: runningIcon, dark: runningIcon }
          : warningIcon;
        this.contextValue = "jaeger-running";
        break;

      case "stopped":
        this.description = hooksOn
          ? `Stopped — hooks enabled${settingsWarning}`
          : "Stopped";
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
    const hookStatus = hooksOn
      ? hookSettingsOk
        ? " — hooks enabled"
        : " — hooks installed but chat.useHooks / chat.useClaudeHooks disabled in VS Code settings"
      : "";
    this.tooltip = showUrl
      ? `Jaeger (${state})${hookStatus}\n${dashboardUrl}`
      : `Jaeger (${state})${hookStatus}`;
    this.id = "jaeger-root";
  }
}
