import * as vscode from "vscode";
import { LangfuseManager } from "./stacks/langfuseManager";
import { HookManager } from "./hooks/hookManager";
import { HooksTreeProvider } from "./views/hooksTreeProvider";
import { StacksTreeProvider } from "./views/stacksTreeProvider";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Agent Tracing");
  const langfuse = new LangfuseManager(context, output);
  const hookManager = new HookManager(context, langfuse, output);

  const hooksProvider = new HooksTreeProvider(hookManager);
  const stacksProvider = new StacksTreeProvider(langfuse);

  // Status bar item for transient feedback (less noisy than toasts)
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
    vscode.window.registerTreeDataProvider("agentTracing.hooks", hooksProvider),
    vscode.window.registerTreeDataProvider("agentTracing.stacks", stacksProvider),
    output,
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTracing.setup", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Agent Tracing: Setting up…",
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: "Starting Langfuse stack…" });
            await langfuse.setup();

            progress.report({ message: "Installing hooks…" });
            await hookManager.installAll();

            stacksProvider.refresh();
            hooksProvider.refresh();
            updateNeedsSetup(langfuse);

            progress.report({ message: "Done!" });
            const open = await vscode.window.showInformationMessage(
              "Agent Tracing setup complete! Langfuse v3 is running and hooks are installed. " +
              "Login: local@agent-tracing.dev / agenttracing",
              "Open Dashboard",
              "Show Login Info",
            );
            if (open === "Open Dashboard") {
              await langfuse.openDashboard();
            } else if (open === "Show Login Info") {
              await langfuse.showLoginInfo();
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Agent Tracing setup failed: ${e.message}`,
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand("agentTracing.startStack", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Agent Tracing: Starting Langfuse…",
            cancellable: false,
          },
          async () => {
            await langfuse.start();
            stacksProvider.refresh();
            updateNeedsSetup(langfuse);
          },
        );
        flashStatus("Langfuse started");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to start Langfuse: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("agentTracing.stopStack", async () => {
      try {
        await langfuse.stop();
        stacksProvider.refresh();
        updateNeedsSetup(langfuse);
        flashStatus("Langfuse stopped");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Langfuse: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("agentTracing.openDashboard", async () => {
      await langfuse.openDashboard();
    }),

    vscode.commands.registerCommand("agentTracing.installHooks", async () => {
      try {
        await hookManager.installAll();
        hooksProvider.refresh();
        flashStatus("Hooks installed");
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Failed to install hooks: ${e.message}`,
        );
      }
    }),

    vscode.commands.registerCommand("agentTracing.removeHooks", async () => {
      try {
        await hookManager.removeAll();
        hooksProvider.refresh();
        flashStatus("Hooks removed");
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Failed to remove hooks: ${e.message}`,
        );
      }
    }),

    vscode.commands.registerCommand("agentTracing.refresh", () => {
      stacksProvider.refresh();
      hooksProvider.refresh();
    }),

    vscode.commands.registerCommand("agentTracing.showLoginInfo", async () => {
      await langfuse.showLoginInfo();
    }),
  );

  // Auto-start if configured
  const autoStart = vscode.workspace
    .getConfiguration("agentTracing.langfuse")
    .get<boolean>("autoStart", false);
  if (autoStart) {
    langfuse.start().then(() => stacksProvider.refresh()).catch(() => {});
  } else {
    // Silent health check: if hooks are installed but stack is down, nudge user once
    checkAndNudge(langfuse, hookManager, stacksProvider);
  }

  // Initial refresh + set welcome view context
  stacksProvider.refresh();
  hooksProvider.refresh();
  updateNeedsSetup(langfuse);
}

/** Set context key so the welcome view shows when stack has never been set up. */
async function updateNeedsSetup(langfuse: LangfuseManager): Promise<void> {
  const running = await langfuse.isRunning();
  vscode.commands.executeCommand(
    "setContext",
    "agentTracing.needsSetup",
    !running,
  );
}

/** Silently check if hooks are installed but Langfuse isn't running, prompt once. */
async function checkAndNudge(
  langfuse: LangfuseManager,
  hookManager: HookManager,
  stacksProvider: StacksTreeProvider,
): Promise<void> {
  try {
    const statuses = await hookManager.getStatuses();
    const anyInstalled = statuses.some((s) => s.installed);
    if (!anyInstalled) return; // no hooks → no reason to nudge

    const running = await langfuse.isRunning();
    if (running) return; // all good

    const dockerOk = await langfuse.isDockerInstalled();
    if (!dockerOk) return; // can't help without Docker, don't nag

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
        async () => {
          await langfuse.start();
          stacksProvider.refresh();
        },
      );
    }
  } catch {
    // Silently ignore — this is a best-effort nudge
  }
}

export function deactivate() {}
