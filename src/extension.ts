import * as vscode from "vscode";
import * as path from "path";
import { LangfuseManager } from "./stacks/langfuseManager";
import { JaegerManager } from "./stacks/jaegerManager";
import { HookManager } from "./hooks/hookManager";
import { HookLogWatcher } from "./hooks/hookLogWatcher";
import { TracingSolutionsTreeProvider } from "./views/tracingSolutionsTreeProvider";
import { initTelemetry, sendEvent, sendError } from "./telemetry";

export function activate(context: vscode.ExtensionContext) {
  // Ensure the VS Code Integrated Browser is used instead of Simple Browser
  // so Langfuse loads correctly (avoids X-Frame-Options iframe blocking).
  const browserCfg = vscode.workspace.getConfiguration("simpleBrowser");
  if (!browserCfg.get<boolean>("useIntegratedBrowser")) {
    browserCfg.update("useIntegratedBrowser", true, vscode.ConfigurationTarget.Global);
  }

  const output = vscode.window.createOutputChannel("Agent Tracing", { log: true });
  initTelemetry(context);
  const langfuse = new LangfuseManager(context, output);
  const jaeger = new JaegerManager(context, output);
  const hookManager = new HookManager(context, langfuse, jaeger, output);

  const provider = new TracingSolutionsTreeProvider(
    langfuse,
    jaeger,
    hookManager,
    context.extensionUri,
  );

  // Watch hook.log for errors and stream to output channel
  const hookLogWatcher = new HookLogWatcher(
    path.join(context.globalStorageUri.fsPath, "logs"),
    output,
    () => provider.refresh(),
  );
  hookLogWatcher.start();

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
    hookLogWatcher,
    output,
  );

  // Set initial context key for hook settings button visibility
  hookManager.checkVSCodeHookSettings();

  // Update context key when chat.* settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("chat.useHooks") || e.affectsConfiguration("chat.useClaudeHooks")) {
        hookManager.checkVSCodeHookSettings();
        provider.refresh();
      }
    }),
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
            sendEvent("setup/complete", { mode: "managed" });

            // Prompt user to enable VS Code hook settings if needed
            await hookManager.promptEnableHookSettings();
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Setup failed: ${e.message}`,
            );
            sendError("setup/failed", { error: e.message });
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
            // Prompt user to enable VS Code hook settings if needed
            await hookManager.promptEnableHookSettings();
          },
        );
        flashStatus("Langfuse started");
        sendEvent("stack/start", { mode: "managed" });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to start Langfuse: ${e.message}`);
        sendError("stack/start-failed", { error: e.message });
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
        sendEvent("stack/stop");
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Langfuse: ${e.message}`);
        sendError("stack/stop-failed", { error: e.message });
      }
    }),

    // Recreate stack (rebuild containers, keep trace data in volumes)
    vscode.commands.registerCommand("agentTracing.recreateStack", async () => {
      const confirm = await confirmModal(
        "This will stop and rebuild all Langfuse containers",
        "Containers will be destroyed and recreated from the latest compose config. Database volumes are kept — traces preserved.",
        "Recreate",
      );
      if (!confirm) return;

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
        sendEvent("stack/recreate");
        provider.refresh();
        await langfuse.openDashboard();
        await hookManager.promptEnableHookSettings();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to recreate stack: ${e.message}`);
      }
    }),

    // Purge stack (destroy containers + volumes — wipes all data)
    vscode.commands.registerCommand("agentTracing.purgeStack", async () => {
      const confirm = await confirmModal(
        "This will PERMANENTLY delete all Langfuse data",
        "All Docker containers, database volumes, and stored traces will be removed. Cannot be undone.",
        "Delete Everything",
      );
      if (!confirm) return;

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
        sendEvent("stack/purge");
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to purge stack: ${e.message}`);
      }
    }),

    // Open dashboard in VS Code integrated browser
    vscode.commands.registerCommand("agentTracing.openDashboard", async () => {
      sendEvent("dashboard/open", { target: "integrated" });
      await langfuse.openDashboard();
    }),

    // Open dashboard in external system browser
    vscode.commands.registerCommand("agentTracing.openDashboardExternal", async () => {
      sendEvent("dashboard/open", { target: "external" });
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

    // Enable VS Code hook settings (chat.useHooks + chat.useClaudeHooks)
    vscode.commands.registerCommand("agentTracing.enableHookSettings", async () => {
      try {
        await hookManager.promptEnableHookSettings();
        provider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to enable hook settings: ${e.message}`);
      }
    }),

    // Enable hooks
    vscode.commands.registerCommand("agentTracing.enableHook", async () => {
      try {
        hookManager.enableHooks();
        provider.refresh();
        flashStatus("Hooks enabled — tracing active");
        sendEvent("hook/enable");
        // Prompt user to enable VS Code hook settings if needed
        await hookManager.promptEnableHookSettings();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to enable hooks: ${e.message}`);
      }
    }),

    // Disable hooks
    vscode.commands.registerCommand("agentTracing.disableHook", async () => {
      try {
        hookManager.disableHooks();
        provider.refresh();
        flashStatus("Hooks disabled");
        sendEvent("hook/disable");
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

      // 5. Validate keys (non-blocking warning if they fail)
      const keysValid = await langfuse.validateKeys();
      if (!keysValid) {
        vscode.window.showWarningMessage(
          "Connected, but API key validation failed. Traces may not be recorded. Check your keys in Langfuse project settings.",
        );
      }

      // 6. Install hooks pointing to the external instance
      await hookManager.installAll();
      provider.refresh();
      flashStatus("Connected to external Langfuse");
      sendEvent("connect/external");

      // 7. Prompt user to enable VS Code hook settings if needed
      await hookManager.promptEnableHookSettings();

      // 8. Open dashboard
      await langfuse.openDashboard();
    }),

    // Show hook log
    vscode.commands.registerCommand("agentTracing.showHookLog", async () => {
      const logPath = hookManager.hookLogPath;
      const logUri = vscode.Uri.file(logPath);
      try {
        await vscode.workspace.fs.stat(logUri);
        const doc = await vscode.workspace.openTextDocument(logUri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        // Scroll to the end
        const lastLine = doc.lineCount - 1;
        const range = new vscode.Range(lastLine, 0, lastLine, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.Default);
      } catch {
        vscode.window.showWarningMessage(
          "No hook log found yet. Traces are logged after the first hook invocation.",
        );
      }
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
      sendEvent("disconnect");
    }),

    // --- Jaeger commands ---

    // Jaeger: Setup (pull image + run container)
    vscode.commands.registerCommand("agentTracing.jaeger.setup", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: false },
        async (progress) => {
          try {
            await jaeger.setup((msg) => progress.report({ message: msg }));
            // Add Jaeger exporter to hook config and re-enable
            hookManager.enableHooks();
            provider.refresh();
            await jaeger.openDashboard();
            flashStatus("Jaeger started");
            sendEvent("jaeger/setup");
            await hookManager.promptEnableHookSettings();
          } catch (e: any) {
            vscode.window.showErrorMessage(`Jaeger setup failed: ${e.message}`);
            sendError("jaeger/setup-failed", { error: e.message });
          }
        },
      );
    }),

    // Jaeger: Start (existing container)
    vscode.commands.registerCommand("agentTracing.jaeger.start", async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, cancellable: false },
          async (progress) => {
            await jaeger.start((msg) => progress.report({ message: msg }));
            const start = Date.now();
            while (Date.now() - start < 15_000) {
              if (await jaeger.isRunning()) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            provider.refresh();
          },
        );
        flashStatus("Jaeger started");
        sendEvent("jaeger/start");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to start Jaeger: ${e.message}`);
      }
    }),

    // Jaeger: Stop
    vscode.commands.registerCommand("agentTracing.jaeger.stop", async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, cancellable: false },
          async (progress) => {
            await jaeger.stop((msg) => progress.report({ message: msg }));
            provider.refresh();
          },
        );
        flashStatus("Jaeger stopped");
        sendEvent("jaeger/stop");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Jaeger: ${e.message}`);
      }
    }),

    // Jaeger: Recreate (remove + start fresh)
    vscode.commands.registerCommand("agentTracing.jaeger.recreate", async () => {
      const confirm = await confirmModal(
        "This will recreate the Jaeger container",
        "The container will be removed and recreated. Jaeger stores traces in memory, so existing trace data will be lost.",
        "Recreate",
      );
      if (!confirm) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, cancellable: false },
          async (progress) => {
            await jaeger.recreate((msg) => progress.report({ message: msg }));
            provider.refresh();
          },
        );
        flashStatus("Jaeger recreated");
        sendEvent("jaeger/recreate");
        await jaeger.openDashboard();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to recreate Jaeger: ${e.message}`);
      }
    }),

    // Jaeger: Delete (remove container)
    vscode.commands.registerCommand("agentTracing.jaeger.purge", async () => {
      const confirm = await confirmModal(
        "This will remove the Jaeger container and all its data",
        "The Jaeger container and its in-memory trace data will be deleted.",
        "Delete",
      );
      if (!confirm) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, cancellable: false },
          async (progress) => {
            await jaeger.purge((msg) => progress.report({ message: msg }));
            provider.refresh();
          },
        );
        flashStatus("Jaeger removed");
        sendEvent("jaeger/purge");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to remove Jaeger: ${e.message}`);
      }
    }),

    // Jaeger: Open dashboard (integrated)
    vscode.commands.registerCommand("agentTracing.jaeger.openDashboard", async () => {
      sendEvent("jaeger/dashboard", { target: "integrated" });
      await jaeger.openDashboard();
    }),

    // Jaeger: Open dashboard (external)
    vscode.commands.registerCommand("agentTracing.jaeger.openDashboardExternal", async () => {
      sendEvent("jaeger/dashboard", { target: "external" });
      await jaeger.openDashboardExternal();
    }),

    // Jaeger: Show stack version info
    vscode.commands.registerCommand("agentTracing.jaeger.showStackVersion", async () => {
      sendEvent("jaeger/stack-version");
      await jaeger.showStackVersion();
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
        await hookManager.promptEnableHookSettings();
      })
      .catch((e: any) => {
        output.warn(`Auto-start failed: ${e.message}`);
      });
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

    // Check VS Code hook settings — prompt if disabled even while stack is running
    const { useHooks, useClaudeHooks } = hookManager.checkVSCodeHookSettings();
    if (!useHooks || !useClaudeHooks) {
      await hookManager.promptEnableHookSettings();
      await context.globalState.update("nudge.lastShown", Date.now());
    }

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

/** Show a QuickPick-based modal confirmation to ensure non-native/consistent UI. */
async function confirmModal(
  title: string,
  detail: string,
  confirmLabel: string,
): Promise<boolean> {
  const result = await vscode.window.showQuickPick(
    [
      { label: confirmLabel, detail, description: "Proceed" },
      { label: "Cancel", description: "Abort" },
    ],
    {
      title,
      placeHolder: "Select an action to proceed",
      ignoreFocusOut: true,
    },
  );
  return result?.label === confirmLabel;
}

export function deactivate() {}
