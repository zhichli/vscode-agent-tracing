import * as vscode from "vscode";
import { LangfuseManager } from "./stacks/langfuseManager";
import { HookManager, AgentTarget } from "./hooks/hookManager";
import { TracingSolutionsTreeProvider } from "./views/tracingSolutionsTreeProvider";

export function activate(context: vscode.ExtensionContext) {
  // Ensure the VS Code Integrated Browser is used instead of Simple Browser
  // so Langfuse loads correctly (avoids X-Frame-Options iframe blocking).
  const browserCfg = vscode.workspace.getConfiguration("simpleBrowser");
  if (!browserCfg.get<boolean>("useIntegratedBrowser")) {
    browserCfg.update("useIntegratedBrowser", true, vscode.ConfigurationTarget.Global);
  }

  const output = vscode.window.createOutputChannel("Agent Tracing");
  const langfuse = new LangfuseManager(context, output);
  const hookManager = new HookManager(context, langfuse, output);

  const provider = new TracingSolutionsTreeProvider(langfuse, hookManager);

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
    // Full Setup: hooks → pip → docker → start → health → open dashboard
    vscode.commands.registerCommand("agentTracing.setup", async () => {
      // If Langfuse is already running, offer to connect instead
      if (await langfuse.isRunning()) {
        const action = await vscode.window.showInformationMessage(
          `Langfuse is already running at ${langfuse.dashboardUrl}. Would you like to connect to this existing instance instead?`,
          "Connect to Existing",
          "Cancel",
        );
        if (action === "Connect to Existing") {
          await vscode.commands.executeCommand("agentTracing.connectExternal");
        }
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Agent Tracing: Setting up…",
          cancellable: false,
        },
        async (progress) => {
          const report = (message: string) => progress.report({ message });
          try {
            await langfuse.setup(report);

            report("Installing hooks…");
            await hookManager.installAll();

            provider.refresh();

            report("Opening dashboard…");
            await langfuse.openDashboard();

            flashStatus("Setup complete");
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Agent Tracing setup failed: ${e.message}`,
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
            title: "Agent Tracing: Starting Langfuse…",
            cancellable: false,
          },
          async (progress) => {
            await langfuse.start((msg) => progress.report({ message: msg }));
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
            title: "Agent Tracing",
            cancellable: false,
          },
          async (progress) => {
            await langfuse.stop((msg) => progress.report({ message: msg }));
            provider.refresh();
          },
        );
        flashStatus("Langfuse stopped");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Langfuse: ${e.message}`);
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

    // Enable hook (per-agent, called from inline icon with tree item arg)
    vscode.commands.registerCommand("agentTracing.enableHook", async (item?: { target?: string; contextValue?: string }) => {
      const target = resolveAgentTarget(item);
      if (!target) {
        // Fallback: prompt user
        const pick = await vscode.window.showQuickPick(
          [
            { label: "GitHub Copilot Chat", value: "vscode" as AgentTarget },
            { label: "Claude", value: "claude" as AgentTarget },
          ],
          { placeHolder: "Select agent to enable tracing for" },
        );
        if (!pick) return;
        hookManager.enableAgent(pick.value);
      } else {
        hookManager.enableAgent(target);
      }
      provider.refresh();
      flashStatus("Hook enabled");
    }),

    // Disable hook (per-agent)
    vscode.commands.registerCommand("agentTracing.disableHook", async (item?: { target?: string; contextValue?: string }) => {
      const target = resolveAgentTarget(item);
      if (!target) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "GitHub Copilot Chat", value: "vscode" as AgentTarget },
            { label: "Claude", value: "claude" as AgentTarget },
          ],
          { placeHolder: "Select agent to disable tracing for" },
        );
        if (!pick) return;
        hookManager.disableAgent(pick.value);
      } else {
        hookManager.disableAgent(target);
      }
      provider.refresh();
      flashStatus("Hook disabled");
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
    langfuse.start().then(() => provider.refresh()).catch(() => {});
  } else {
    checkAndNudge(langfuse, hookManager, provider);
  }

  // Initial refresh
  provider.refresh();
}

/** Extract agent target from tree item contextValue or direct property. */
function resolveAgentTarget(item?: { target?: string; contextValue?: string }): AgentTarget | undefined {
  if (!item) return undefined;

  // Direct target property (if tree item exposes it)
  if (item.target === "vscode" || item.target === "claude") {
    return item.target;
  }

  // Parse from contextValue: agent-tracing-vscode / agent-not-tracing-claude etc.
  const cv = item.contextValue ?? "";
  if (cv.endsWith("-vscode")) return "vscode";
  if (cv.endsWith("-claude")) return "claude";
  return undefined;
}

/** Silently check if hooks are installed but Langfuse isn't running, prompt once. */
async function checkAndNudge(
  langfuse: LangfuseManager,
  hookManager: HookManager,
  provider: TracingSolutionsTreeProvider,
): Promise<void> {
  try {
    const statuses = await hookManager.getStatuses();
    const anyInstalled = statuses.some((s) => s.installed);
    if (!anyInstalled) return;

    const running = await langfuse.isRunning();
    if (running) return;

    const dockerOk = await langfuse.isDockerInstalled();
    if (!dockerOk) return;

    const action = await vscode.window.showInformationMessage(
      "Agent Tracing hooks are active but Langfuse is not running. Traces won't be recorded.",
      "Start Langfuse",
      "Dismiss",
    );
    if (action === "Start Langfuse") {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Agent Tracing: Starting Langfuse…",
          cancellable: false,
        },
        async (progress) => {
          await langfuse.start((msg) => progress.report({ message: msg }));
          provider.refresh();
        },
      );
    }
  } catch {
    // best-effort nudge
  }
}

export function deactivate() {}
