import * as vscode from "vscode";
import { HookManager, HookStatus } from "../hooks/hookManager";

export class HooksTreeProvider
  implements vscode.TreeDataProvider<HookItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private hookManager: HookManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HookItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<HookItem[]> {
    const statuses = await this.hookManager.getStatuses();
    return statuses.map((s) => new HookItem(s));
  }
}

class HookItem extends vscode.TreeItem {
  constructor(status: HookStatus) {
    super(status.label, vscode.TreeItemCollapsibleState.None);

    if (status.installed) {
      this.description = "Installed";
      this.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed"),
      );
      this.contextValue = "hook-installed";
    } else {
      this.description = "Not installed";
      this.iconPath = new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor("disabledForeground"),
      );
      this.contextValue = "hook-not-installed";
      this.command = {
        command: "agentTracing.installHooks",
        title: "Install Hooks",
      };
    }

    this.tooltip = [
      `Target: ${status.target}`,
      `Script: ${status.scriptPath}`,
      `Config: ${status.configPath}`,
    ].join("\n");

    this.id = status.id;
  }
}
