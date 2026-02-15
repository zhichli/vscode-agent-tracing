import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { LangfuseManager } from "./stacks/langfuseManager";
import { HookManager } from "./hooks/hookManager";
import { TracingSolutionsTreeProvider } from "./views/tracingSolutionsTreeProvider";

export function activate(context: vscode.ExtensionContext) {
  // Ensure the VS Code Integrated Browser is used instead of Simple Browser
  // so Langfuse loads correctly (avoids X-Frame-Options iframe blocking).
  const browserCfg = vscode.workspace.getConfiguration("simpleBrowser");
  if (!browserCfg.get<boolean>("useIntegratedBrowser")) {
    browserCfg.update("useIntegratedBrowser", true, vscode.ConfigurationTarget.Global);
  }

  const output = vscode.window.createOutputChannel("Agent Tracing", { log: true });
  const langfuse = new LangfuseManager(context, output);
  const hookManager = new HookManager(context, langfuse, output);

  const provider = new TracingSolutionsTreeProvider(
    langfuse,
    hookManager,
    context.extensionUri,
  );

  // Status bar item for transient feedback
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusItem.name = "Agent Tracing";
  context.subscriptions.push(statusItem);

  function flashStatus(message: string, durationMs = 4000) {
    statusItem.text = `$(pulse) ${message}`;
    statusItem.show();
    setTimeout(() => statusItem.hide(), durationMs);
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentTracing.solutions", provider),
    output,
  );

  // --- Commands ---

  context.subscriptions.push(
    // Setup: hooks → pip → docker → start → health → open dashboard
    vscode.commands.registerCommand("agentTracing.setup", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: false,
        },
        async (progress) => {
          const report = (message: string) => progress.report({ message });
          try {
            // Check if something is already running on the Langfuse port
            if (await langfuse.isRunning()) {
              const isOurStack = await langfuse.isOurManagedStack();
              if (isOurStack) {
                const action = await vscode.window.showInformationMessage(
                  `A Langfuse stack managed by this extension is already running at ${langfuse.dashboardUrl}.`,
                  { modal: true, detail: "You can connect to it and start tracing, or recreate it from scratch (trace data will be preserved)." },
                  "Connect",
                  "Recreate",
                );
                if (action === "Connect") {
                  report("Connecting to existing stack…");
                  await langfuse.switchToManaged();
                  langfuse.ensureComposeFile();
                  await hookManager.installAll();
                  provider.refresh();
                  await langfuse.openDashboard();
                  flashStatus("Connected to existing stack");
                  return;
                } else if (action === "Recreate") {
                  report("Recreating stack…");
                  await langfuse.recreate(report);
                  await hookManager.installAll();
                  provider.refresh();
                  await langfuse.openDashboard();
                  flashStatus("Stack recreated");
                  return;
                }
                return;
              }
            }

            await langfuse.setup(report);

            report("Installing hooks…");
            await hookManager.installAll();

            provider.refresh();

            report("Opening dashboard…");
            await langfuse.openDashboard();

            flashStatus("Setup complete");
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Setup failed: ${e.message}`,
            );
          }
        },
      );
    }),

    // Start stack (docker compose up only, no full setup)
    vscode.commands.registerCommand("agentTracing.startStack", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            await langfuse.start((msg) => progress.report({ message: msg }));
            progress.report({ message: "Enabling hooks…" });
            await hookManager.installAll();
            progress.report({ message: "Waiting for health check…" });
            // Poll until healthy so the tree refreshes to running state
            const start = Date.now();
            while (Date.now() - start < 30_000) {
              if (await langfuse.isRunning()) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            provider.refresh();
          },
        );
        flashStatus("Langfuse started");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to start Langfuse: ${e.message}`);
      }
    }),

    // Stop stack
    vscode.commands.registerCommand("agentTracing.stopStack", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            await langfuse.stop((msg) => progress.report({ message: msg }));
            progress.report({ message: "Disabling hooks…" });
            hookManager.disableHooks();
            provider.refresh();
          },
        );
        flashStatus("Langfuse stopped");
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Langfuse: ${e.message}`);
      }
    }),

    // Recreate stack (rebuild containers, keep trace data in volumes)
    vscode.commands.registerCommand("agentTracing.recreateStack", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "This will stop and rebuild all Langfuse containers. Your trace data will be preserved.",
        { modal: true, detail: "Containers will be destroyed and recreated from the latest compose config. Database volumes (Postgres, ClickHouse) are kept — all existing traces, sessions, and projects remain intact." },
        "Recreate",
      );
      if (confirm !== "Recreate") return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            await langfuse.recreate((msg) => progress.report({ message: msg }));
            await hookManager.installAll();
            provider.refresh();
          },
        );
        flashStatus("Stack recreated — trace data preserved");
        provider.refresh();
        await langfuse.openDashboard();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to recreate stack: ${e.message}`);
      }
    }),

    // Purge stack (destroy containers + volumes — wipes all data)
    vscode.commands.registerCommand("agentTracing.purgeStack", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "This will permanently delete all Langfuse containers, volumes, and trace data. This cannot be undone.",
        { modal: true, detail: "All Docker containers, database volumes (Postgres, ClickHouse), and stored traces will be removed. You will need to run Full Setup again to start tracing." },
        "Delete Everything",
      );
      if (confirm !== "Delete Everything") return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            await langfuse.purge((msg) => progress.report({ message: msg }));
            progress.report({ message: "Disabling hooks…" });
            hookManager.disableHooks();
            provider.refresh();
          },
        );
        flashStatus("Stack deleted");
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to purge stack: ${e.message}`);
      }
    }),

    // Open dashboard in VS Code integrated browser
    vscode.commands.registerCommand("agentTracing.openDashboard", async () => {
      await langfuse.openDashboard();
    }),

    // Open dashboard in external system browser
    vscode.commands.registerCommand("agentTracing.openDashboardExternal", async () => {
      await langfuse.openDashboardExternal();
    }),

    // Show login info (modal with Copy buttons)
    vscode.commands.registerCommand("agentTracing.showLoginInfo", async () => {
      await langfuse.showLoginInfo();
    }),

    // Show stack version info
    vscode.commands.registerCommand("agentTracing.showStackVersion", async () => {
      await langfuse.showStackVersion();
    }),

    // Refresh tree
    vscode.commands.registerCommand("agentTracing.refresh", () => {
      provider.refresh();
    }),

    // Enable hooks
    vscode.commands.registerCommand("agentTracing.enableHook", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Installing hook script…" });
            hookManager.enableHooks();
            progress.report({ message: "Hook config written to ~/.claude/settings.json" });
            provider.refresh();
          },
        );
        const action = await vscode.window.showInformationMessage(
          "Hooks enabled — tracing active",
          "Open settings.json",
          "Open Hook Script",
        );
        if (action === "Open settings.json") {
          const settingsUri = vscode.Uri.file(path.join(os.homedir(), ".claude", "settings.json"));
          await vscode.window.showTextDocument(settingsUri);
        } else if (action === "Open Hook Script") {
          const scriptUri = vscode.Uri.file(path.join(os.homedir(), ".claude", "hooks", "langfuse_hook.py"));
          await vscode.window.showTextDocument(scriptUri);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to enable hooks: ${e.message}`);
      }
    }),

    // Disable hooks
    vscode.commands.registerCommand("agentTracing.disableHook", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Removing hook entry from ~/.claude/settings.json" });
            hookManager.disableHooks();
            provider.refresh();
          },
        );
        void vscode.window.showWarningMessage(
          "Hooks are disabled — traces will not flow until you enable hooks again.",
        );
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to disable hooks: ${e.message}`);
      }
    }),

    // Connect to existing Langfuse instance (external mode)
    vscode.commands.registerCommand("agentTracing.connectExternal", async () => {
      // 1. Ask for host URL
      const host = await vscode.window.showInputBox({
        title: "Langfuse Host URL",
        prompt: "Enter the URL of your running Langfuse instance",
        value: `http://localhost:${langfuse.port}`,
        placeHolder: "http://localhost:3000",
        validateInput: (v) => {
          try {
            new URL(v);
            return undefined;
          } catch {
            return "Please enter a valid URL";
          }
        },
      });
      if (!host) return;

      // 2. Check if reachable
      const reachable = await (async () => {
        try {
          const res = await fetch(`${host}/api/public/health`);
          return res.ok;
        } catch {
          return false;
        }
      })();

      if (!reachable) {
        const proceed = await vscode.window.showWarningMessage(
          `Could not reach Langfuse at ${host}. Connect anyway?`,
          "Connect Anyway",
          "Cancel",
        );
        if (proceed !== "Connect Anyway") return;
      }

      // 3. Ask for API keys
      const publicKey = await vscode.window.showInputBox({
        title: "Langfuse Public Key",
        prompt: "Enter the project public key (starts with pk-lf-...)",
        placeHolder: "pk-lf-...",
        validateInput: (v) => v.trim() ? undefined : "Public key is required",
      });
      if (!publicKey) return;

      const secretKey = await vscode.window.showInputBox({
        title: "Langfuse Secret Key",
        prompt: "Enter the project secret key (starts with sk-lf-...)",
        placeHolder: "sk-lf-...",
        password: true,
        validateInput: (v) => v.trim() ? undefined : "Secret key is required",
      });
      if (!secretKey) return;

      // 4. Store and connect
      await langfuse.connectExternal(publicKey.trim(), secretKey.trim(), host.trim());

      // 5. Install hooks pointing to the external instance
      await hookManager.installAll();
      provider.refresh();
      flashStatus("Connected to external Langfuse");

      // 6. Open dashboard
      await langfuse.openDashboard();
    }),

    // Disconnect from external Langfuse
    vscode.commands.registerCommand("agentTracing.disconnect", async () => {
      try {
        hookManager.disableHooks();
      } catch {
        // best-effort hook cleanup
      }
      await langfuse.disconnect();
      provider.refresh();
      flashStatus("Disconnected from Langfuse");
    }),
  );

  // Auto-start if configured
  const autoStart = vscode.workspace
    .getConfiguration("agentTracing.langfuse")
    .get<boolean>("autoStart", false);
  if (autoStart) {
    langfuse
      .start()
      .then(async () => {
        await hookManager.installAll();
        provider.refresh();
      })
      .catch(() => {});
  } else {
    checkAndNudge(context, langfuse, hookManager, provider);
  }

  // Initial refresh
  provider.refresh();
}

/** Silently check if hooks are installed but Langfuse isn't running, prompt once. */
async function checkAndNudge(
  context: vscode.ExtensionContext,
  langfuse: LangfuseManager,
  hookManager: HookManager,
  provider: TracingSolutionsTreeProvider,
): Promise<void> {
  try {
    // Debounce: skip if nudged within the last 5 minutes (multi-window protection)
    const lastNudge = context.globalState.get<number>("nudge.lastShown") ?? 0;
    if (Date.now() - lastNudge < 5 * 60 * 1000) return;

    const installed = hookManager.isHookInstalled();
    if (!installed) return;

    const running = await langfuse.isRunning();
    if (running) return;

    const dockerOk = await langfuse.isDockerInstalled();
    if (!dockerOk) return;

    const action = await vscode.window.showInformationMessage(
      "Hooks are active but Langfuse is not running. Traces won't be recorded.",
      "Start Langfuse",
      "Dismiss",
    );
    await context.globalState.update("nudge.lastShown", Date.now());
    if (action === "Start Langfuse") {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: false,
        },
        async (progress) => {
          await langfuse.start((msg) => progress.report({ message: msg }));
          progress.report({ message: "Enabling hooks…" });
          await hookManager.installAll();
          provider.refresh();
        },
      );
    }
  } catch {
    // best-effort nudge
  }
}

export function deactivate() {}
