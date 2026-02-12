import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { LangfuseManager } from "../stacks/langfuseManager";

export type AgentTarget = "vscode" | "claude";

export interface HookStatus {
  id: string;
  label: string;
  target: AgentTarget;
  installed: boolean;
}

/**
 * Manages the shared hook script and per-agent config files.
 *
 * File layout (per spec):
 *   ~/.claude/hooks/langfuse_hook.py          — shared script (installed once)
 *   ~/.claude/hooks/.langfuse_config.json     — keys + log_dir
 *   {workspace}/.github/hooks/agent-tracing.json — VS Code hook config
 *   ~/.claude/settings.json                   — Claude hook entry + root env
 */
export class HookManager {
  constructor(
    private context: vscode.ExtensionContext,
    private langfuse: LangfuseManager,
    private output: vscode.OutputChannel,
  ) {}

  // ---- public API ----

  /** Install shared script + config + enable both agents. */
  async installAll(): Promise<void> {
    this.installSharedScript();
    this.writeLangfuseConfig();
    this.enableAgent("vscode");
    this.enableAgent("claude");
  }

  /** Get per-agent hook statuses. */
  async getStatuses(): Promise<HookStatus[]> {
    return [this.vsCodeStatus(), this.claudeStatus()];
  }

  /** Enable a single agent's hook config (script must already exist). */
  enableAgent(target: AgentTarget): void {
    this.installSharedScript();
    this.writeLangfuseConfig();

    if (target === "vscode") {
      this.writeVSCodeConfig();
    } else {
      this.writeClaudeConfig();
    }
  }

  /** Disable a single agent's hook config. Script + .langfuse_config.json stay on disk. */
  disableAgent(target: AgentTarget): void {
    if (target === "vscode") {
      this.removeVSCodeConfig();
    } else {
      this.removeClaudeConfig();
    }
  }

  /** Remove everything (script + config + both agent configs). */
  async removeAll(): Promise<void> {
    this.removeVSCodeConfig();
    this.removeClaudeConfig();
    this.safeUnlink(this.sharedScriptPath);
    this.safeUnlink(this.langfuseConfigPath);
  }

  // ---- shared script ----

  private get sharedScriptPath(): string {
    return path.join(os.homedir(), ".claude", "hooks", "langfuse_hook.py");
  }

  private get langfuseConfigPath(): string {
    return path.join(os.homedir(), ".claude", "hooks", ".langfuse_config.json");
  }

  private installSharedScript(): void {
    const destDir = path.dirname(this.sharedScriptPath);
    fs.mkdirSync(destDir, { recursive: true });

    const src = this.resourcePath("hooks", "langfuse_hook.py");
    fs.copyFileSync(src, this.sharedScriptPath);
    fs.chmodSync(this.sharedScriptPath, 0o755);
    this.log(`Installed shared hook script → ${this.sharedScriptPath}`);
  }

  private writeLangfuseConfig(): void {
    const logDir = path.join(this.context.globalStorageUri.fsPath, "logs");
    const config = {
      public_key: this.langfuse.publicKey,
      secret_key: this.langfuse.secretKey,
      host: this.langfuse.dashboardUrl,
      log_dir: logDir,
    };
    fs.mkdirSync(path.dirname(this.langfuseConfigPath), { recursive: true });
    fs.writeFileSync(this.langfuseConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    this.log(`Wrote .langfuse_config.json → ${this.langfuseConfigPath}`);
  }

  // ---- VS Code Copilot Chat hook ----

  private vsCodeConfigPath(): string | undefined {
    const ws = this.workspaceRoot();
    if (!ws) return undefined;
    return path.join(ws, ".github", "hooks", "agent-tracing.json");
  }

  private writeVSCodeConfig(): void {
    const configPath = this.vsCodeConfigPath();
    if (!configPath) {
      this.log("No workspace open — skipping VS Code hook config.");
      return;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const hookConfig = {
      hooks: {
        Stop: [
          {
            type: "command",
            command: "python3 ~/.claude/hooks/langfuse_hook.py",
            timeout: 60,
            env: {
              TRACE_TO_LANGFUSE: "true",
              LANGFUSE_PUBLIC_KEY: this.langfuse.publicKey,
              LANGFUSE_SECRET_KEY: this.langfuse.secretKey,
              LANGFUSE_HOST: this.langfuse.dashboardUrl,
            },
          },
        ],
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(hookConfig, null, 2) + "\n", "utf-8");
    this.log(`Wrote VS Code hook config → ${configPath}`);
  }

  private removeVSCodeConfig(): void {
    const configPath = this.vsCodeConfigPath();
    if (configPath) {
      this.safeUnlink(configPath);
      this.log("Removed VS Code hook config (agent-tracing.json).");
    }
  }

  private vsCodeStatus(): HookStatus {
    const configPath = this.vsCodeConfigPath();
    return {
      id: "agent-vscode",
      label: "GitHub Copilot Chat",
      target: "vscode",
      installed: configPath ? fs.existsSync(configPath) : false,
    };
  }

  // ---- Claude Code hook ----

  private get claudeSettingsPath(): string {
    return path.join(os.homedir(), ".claude", "settings.json");
  }

  private writeClaudeConfig(): void {
    const settingsPath = this.claudeSettingsPath;
    const settings = this.readJsonSafe(settingsPath);

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

    const cmd = "python3 ~/.claude/hooks/langfuse_hook.py";
    const alreadyRegistered = settings.hooks.Stop.some(
      (h: any) => {
        const entries = h.hooks ?? [h];
        return entries.some((inner: any) => inner.command === cmd);
      },
    );

    if (!alreadyRegistered) {
      settings.hooks.Stop.push({
        type: "command",
        command: cmd,
      });
    }

    // Merge env vars into root env (per spec)
    if (!settings.env) settings.env = {};
    settings.env.TRACE_TO_LANGFUSE = "true";
    settings.env.LANGFUSE_PUBLIC_KEY = this.langfuse.publicKey;
    settings.env.LANGFUSE_SECRET_KEY = this.langfuse.secretKey;
    settings.env.LANGFUSE_HOST = this.langfuse.dashboardUrl;

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    this.log(`Wrote Claude hook config → ${settingsPath}`);
  }

  private removeClaudeConfig(): void {
    const settingsPath = this.claudeSettingsPath;
    if (!fs.existsSync(settingsPath)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.hooks?.Stop) {
        settings.hooks.Stop = settings.hooks.Stop.filter(
          (h: any) => {
            const entries = h.hooks ?? [h];
            return !entries.some(
              (inner: any) => inner.command?.includes("langfuse_hook.py"),
            );
          },
        );
      }
      if (settings.env) {
        delete settings.env.TRACE_TO_LANGFUSE;
        delete settings.env.LANGFUSE_PUBLIC_KEY;
        delete settings.env.LANGFUSE_SECRET_KEY;
        delete settings.env.LANGFUSE_HOST;
        if (Object.keys(settings.env).length === 0) {
          delete settings.env;
        }
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      this.log("Removed Claude hook entry from settings.json.");
    } catch {
      // ignore corrupt file
    }
  }

  private claudeStatus(): HookStatus {
    const settingsPath = this.claudeSettingsPath;
    let installed = false;
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        installed = (settings.hooks?.Stop ?? []).some(
          (h: any) => {
            const entries = h.hooks ?? [h];
            return entries.some(
              (inner: any) => inner.command?.includes("langfuse_hook.py"),
            );
          },
        );
      } catch {
        // corrupt settings
      }
    }

    return {
      id: "agent-claude",
      label: "Claude",
      target: "claude",
      installed,
    };
  }

  // ---- helpers ----

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private resourcePath(...segments: string[]): string {
    return path.join(this.context.extensionPath, "resources", ...segments);
  }

  private readJsonSafe(filePath: string): any {
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private safeUnlink(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  private log(msg: string) {
    this.output.appendLine(`[Hooks] ${msg}`);
  }
}
