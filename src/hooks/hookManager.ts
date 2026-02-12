import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { LangfuseManager } from "../stacks/langfuseManager";
import { exec } from "../exec";

export interface HookStatus {
  id: string;
  label: string;
  target: "vscode" | "claude-code";
  installed: boolean;
  scriptPath: string;
  configPath: string;
}

/**
 * Manages installation and removal of observability hook scripts
 * for both VS Code Copilot and Claude Code.
 */
export class HookManager {
  constructor(
    private context: vscode.ExtensionContext,
    private langfuse: LangfuseManager,
    private output: vscode.OutputChannel,
  ) {}

  // ---- public API ----

  async installAll(): Promise<void> {
    await this.installVSCodeHook();
    await this.installClaudeCodeHook();
  }

  async removeAll(): Promise<void> {
    this.removeVSCodeHook();
    this.removeClaudeCodeHook();
  }

  async getStatuses(): Promise<HookStatus[]> {
    return [this.vsCodeHookStatus(), this.claudeCodeHookStatus()];
  }

  // ---- VS Code hook ----

  private async installVSCodeHook(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      throw new Error("No workspace folder open.");
    }

    // 1. Copy the hook Python script
    const destDir = path.join(ws, ".github", "hooks");
    fs.mkdirSync(destDir, { recursive: true });

    const scriptSrc = this.resourcePath("hooks", "langfuse_vscode_hook.py");
    const scriptDest = path.join(destDir, "langfuse_vscode_hook.py");
    fs.copyFileSync(scriptSrc, scriptDest);
    fs.chmodSync(scriptDest, 0o755);
    this.log(`Installed VS Code hook script → ${scriptDest}`);

    // 2. Write / merge hook JSON config with env vars embedded for zero-config
    const configPath = path.join(destDir, "agent-tracing.json");
    const hookConfig = {
      hooks: {
        Stop: [
          {
            type: "command",
            command: "python3 .github/hooks/langfuse_vscode_hook.py",
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

    // 3. Write env vars to .claude/settings.local.json (shared format)
    this.writeEnvSettings(ws);
  }

  private removeVSCodeHook(): void {
    const ws = this.workspaceRoot();
    if (!ws) return;

    const scriptPath = path.join(ws, ".github", "hooks", "langfuse_vscode_hook.py");
    const configPath = path.join(ws, ".github", "hooks", "agent-tracing.json");

    this.safeUnlink(scriptPath);
    this.safeUnlink(configPath);
    this.log("Removed VS Code hook.");
  }

  private vsCodeHookStatus(): HookStatus {
    const ws = this.workspaceRoot() ?? "";
    const scriptPath = path.join(ws, ".github", "hooks", "langfuse_vscode_hook.py");
    const configPath = path.join(ws, ".github", "hooks", "agent-tracing.json");
    return {
      id: "vscode-stop",
      label: "VS Code Stop Hook",
      target: "vscode",
      installed: fs.existsSync(scriptPath) && fs.existsSync(configPath),
      scriptPath,
      configPath,
    };
  }

  // ---- Claude Code hook ----

  private async installClaudeCodeHook(): Promise<void> {
    const claudeDir = path.join(os.homedir(), ".claude");
    if (!fs.existsSync(claudeDir)) {
      this.log("~/.claude directory not found — skipping Claude Code hook.");
      return;
    }

    // 1. Copy the hook Python script
    const hooksDir = path.join(claudeDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });

    const scriptSrc = this.resourcePath("hooks", "langfuse_claude_hook.py");
    const scriptDest = path.join(hooksDir, "langfuse_hook.py");
    fs.copyFileSync(scriptSrc, scriptDest);
    fs.chmodSync(scriptDest, 0o755);
    this.log(`Installed Claude Code hook script → ${scriptDest}`);

    // 2. Merge hook into ~/.claude/settings.json
    const settingsPath = path.join(claudeDir, "settings.json");
    const settings = this.readJsonSafe(settingsPath);

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

    const cmd = "python3 ~/.claude/hooks/langfuse_hook.py";
    const alreadyRegistered = settings.hooks.Stop.some(
      (h: any) =>
        (h.hooks ?? [h]).some((inner: any) => inner.command === cmd),
    );

    if (!alreadyRegistered) {
      // Claude Code hook format: Stop is an array of { hooks: [...] } wrappers
      // or flat { type, command } entries — VS Code accepts both.
      settings.hooks.Stop.push({
        type: "command",
        command: cmd,
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      this.log(`Registered hook in ${settingsPath}`);
    } else {
      this.log("Claude Code hook already registered.");
    }

    // 3. Write env vars to workspace .claude/settings.local.json
    const ws = this.workspaceRoot();
    if (ws) {
      this.writeEnvSettings(ws);
    }
  }

  private removeClaudeCodeHook(): void {
    const claudeDir = path.join(os.homedir(), ".claude");
    const scriptPath = path.join(claudeDir, "hooks", "langfuse_hook.py");
    this.safeUnlink(scriptPath);

    // Remove from settings.json
    const settingsPath = path.join(claudeDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (settings.hooks?.Stop) {
          settings.hooks.Stop = settings.hooks.Stop.filter(
            (h: any) => {
              const entries = h.hooks ?? [h];
              return !entries.some(
                (inner: any) =>
                  inner.command?.includes("langfuse_hook.py"),
              );
            },
          );
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        }
      } catch {
        // ignore
      }
    }
    this.log("Removed Claude Code hook.");
  }

  private claudeCodeHookStatus(): HookStatus {
    const claudeDir = path.join(os.homedir(), ".claude");
    const scriptPath = path.join(claudeDir, "hooks", "langfuse_hook.py");
    const configPath = path.join(claudeDir, "settings.json");

    let installed = false;
    if (fs.existsSync(scriptPath) && fs.existsSync(configPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        installed = (settings.hooks?.Stop ?? []).some(
          (h: any) => {
            const entries = h.hooks ?? [h];
            return entries.some(
              (inner: any) =>
                inner.command?.includes("langfuse_hook.py"),
            );
          },
        );
      } catch {
        // corrupt settings — treat as not installed
      }
    }

    return {
      id: "claude-code-stop",
      label: "Claude Code Stop Hook",
      target: "claude-code",
      installed,
      scriptPath,
      configPath,
    };
  }

  // ---- env settings ----

  private writeEnvSettings(wsRoot: string): void {
    const settingsDir = path.join(wsRoot, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });

    const settingsPath = path.join(settingsDir, "settings.local.json");
    const settings = this.readJsonSafe(settingsPath);

    if (!settings.env) settings.env = {};
    settings.env.TRACE_TO_LANGFUSE = "true";
    settings.env.LANGFUSE_PUBLIC_KEY = this.langfuse.publicKey;
    settings.env.LANGFUSE_SECRET_KEY = this.langfuse.secretKey;
    settings.env.LANGFUSE_HOST = this.langfuse.dashboardUrl;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    this.log(`Wrote env settings → ${settingsPath}`);
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
