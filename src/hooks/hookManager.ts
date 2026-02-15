import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { LangfuseManager } from "../stacks/langfuseManager";

/**
 * Manages the shared hook script and a single hook entry in
 * ~/.claude/settings.json that works for both VS Code and Claude agents.
 *
 * File layout:
 *   ~/.claude/hooks/langfuse_hook.py          — shared script (installed once)
 *   ~/.claude/hooks/.langfuse_config.json     — keys + log_dir
 *   ~/.claude/settings.json                   — single hook entry (env embedded) + root env
 *
 * The single entry has env embedded in the hook object (for VS Code agent)
 * AND root-level env (for Claude agent). One execution per Stop event.
 */
export class HookManager {
  constructor(
    private context: vscode.ExtensionContext,
    private langfuse: LangfuseManager,
    private output: vscode.LogOutputChannel,
  ) {}

  // ---- public API ----

  /** Install shared script + config + enable hooks. */
  async installAll(): Promise<void> {
    this.installSharedScript();
    this.writeLangfuseConfig();
    this.writeHookConfig();
  }

  /** Whether the hook entry is currently installed. */
  isHookInstalled(): boolean {
    return this.detectHookInstalled();
  }

  /** Enable hooks (script must already exist). */
  enableHooks(): void {
    this.installSharedScript();
    this.writeLangfuseConfig();
    this.writeHookConfig();
  }

  /** Disable hooks. Removes script + config + settings entry so next enable gets a fresh copy. */
  disableHooks(): void {
    this.removeHookConfig();
    this.safeUnlink(this.sharedScriptPath);
    this.safeUnlink(this.langfuseConfigPath);
  }

  /** Remove everything (script + config + hook entry). */
  async removeAll(): Promise<void> {
    this.removeHookConfig();
    this.safeUnlink(this.sharedScriptPath);
    this.safeUnlink(this.langfuseConfigPath);
  }

  /** Path to the aggregate hook.log file. */
  get hookLogPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "logs", "hook.log");
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
    this.output.info(`Installed shared hook script → ${this.sharedScriptPath}`);
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
    this.output.debug(`Wrote .langfuse_config.json → ${this.langfuseConfigPath}`);
  }

  // ---- single hook entry (serves both VS Code + Claude) ----

  private get settingsPath(): string {
    return path.join(os.homedir(), ".claude", "settings.json");
  }

  private static readonly HOOK_CMD = "python3 ~/.claude/hooks/langfuse_hook.py";

  /** Write / update the single hook entry + root env. */
  private writeHookConfig(): void {
    const settings = this.readJsonSafe(this.settingsPath);

    if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

    const cmd = HookManager.HOOK_CMD;
    const envVars = {
      TRACE_TO_LANGFUSE: "true",
      LANGFUSE_PUBLIC_KEY: this.langfuse.publicKey,
      LANGFUSE_SECRET_KEY: this.langfuse.secretKey,
      LANGFUSE_HOST: this.langfuse.dashboardUrl,
    };

    // Find existing entry
    const existing = settings.hooks.Stop.find(
      (h: any) => {
        const entries = h.hooks ?? [h];
        return entries.some((inner: any) => inner.command === cmd);
      },
    );

    if (existing) {
      // Update env on inner hook object
      const entries = existing.hooks ?? [existing];
      for (const inner of entries) {
        if (inner.command === cmd) {
          inner.env = { ...envVars };
        }
      }
    } else {
      settings.hooks.Stop.push({
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: cmd,
            env: { ...envVars },
          },
        ],
      });
    }

    // Root env for Claude agent
    if (!settings.env) settings.env = {};
    Object.assign(settings.env, envVars);

    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    this.output.info(`Wrote hook config → ${this.settingsPath}`);
  }

  /** Remove hook entry + root env keys. */
  private removeHookConfig(): void {
    if (!fs.existsSync(this.settingsPath)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));

      if (Array.isArray(settings.hooks?.Stop)) {
        settings.hooks.Stop = settings.hooks.Stop.filter(
          (h: any) => {
            const entries = h.hooks ?? [h];
            return !entries.some(
              (inner: any) => inner.command?.includes("langfuse_hook.py"),
            );
          },
        );
        // Clean up empty Stop array
        if (settings.hooks.Stop.length === 0) {
          delete settings.hooks.Stop;
        }
      }

      // Clean up empty hooks object
      if (settings.hooks && typeof settings.hooks === "object" && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (settings.env && typeof settings.env === "object") {
        delete settings.env.TRACE_TO_LANGFUSE;
        delete settings.env.LANGFUSE_PUBLIC_KEY;
        delete settings.env.LANGFUSE_SECRET_KEY;
        delete settings.env.LANGFUSE_HOST;
        if (Object.keys(settings.env).length === 0) {
          delete settings.env;
        }
      }

      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      this.output.info("Removed hook entry from settings.json.");
    } catch {
      // ignore corrupt file
    }
  }

  /** Check if our hook entry exists in settings.json. */
  private detectHookInstalled(): boolean {
    if (!fs.existsSync(this.settingsPath)) return false;
    try {
      const settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
      return (settings.hooks?.Stop ?? []).some(
        (h: any) => {
          const entries = h.hooks ?? [h];
          return entries.some(
            (inner: any) => inner.command?.includes("langfuse_hook.py"),
          );
        },
      );
    } catch {
      return false;
    }
  }

  // ---- helpers ----

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
}
