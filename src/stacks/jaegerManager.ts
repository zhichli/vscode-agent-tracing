import * as vscode from "vscode";
import { exec, execStreaming } from "../exec";

/** Jaeger all-in-one default ports. */
const JAEGER_DEFAULTS = {
  /** Jaeger UI port (mapped to host). */
  uiPort: 16686,
  /** OTLP HTTP receiver port (mapped to host). */
  otlpPort: 4318,
  /** Docker image. */
  image: "docker.io/jaegertracing/jaeger",
  /** Pinned image tag — use specific version per https://www.jaegertracing.io/docs/2.15/getting-started/ */
  tag: "latest",
  /** Docker container name managed by this extension. */
  containerName: "agent-tracing-jaeger",
  /** Label used to identify our managed container. */
  label: "com.agent-tracing.managed",
  /** Extension-maintained stack metadata. */
  stackVersion: "1.0.0",
  pinnedAt: "2026-02-18",
} as const;

function formatJaegerStackSummary(params: {
  image: string;
  tag: string;
  uiPort: number;
  otlpPort: number;
  version: string;
  pinnedAt: string;
}): string {
  const lines = [
    `Stack Version: ${params.version}  (pinned ${params.pinnedAt})`,
    "",
    `  Jaeger All-in-One   ${params.image}:${params.tag}`,
    `  UI Port             localhost:${params.uiPort}`,
    `  OTLP HTTP Port      localhost:${params.otlpPort}`,
  ];
  return lines.join("\n");
}

/** Callback for reporting progress steps to the UI. */
export type StepReporter = (message: string) => void;

/**
 * Manages a single Jaeger all-in-one Docker container.
 *
 * Much simpler than LangfuseManager — one container, no auth, no compose.
 */
export class JaegerManager {
  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.LogOutputChannel,
  ) {}

  // ---- public getters ----

  /** UI port (host-side). */
  get uiPort(): number {
    return vscode.workspace
      .getConfiguration("agentTracing.jaeger")
      .get<number>("uiPort", JAEGER_DEFAULTS.uiPort);
  }

  /** OTLP HTTP port (host-side). */
  get otlpPort(): number {
    return vscode.workspace
      .getConfiguration("agentTracing.jaeger")
      .get<number>("otlpPort", JAEGER_DEFAULTS.otlpPort);
  }

  /** OTLP endpoint URL for the hook exporter config. */
  get otlpEndpoint(): string {
    return `http://localhost:${this.otlpPort}/v1/traces`;
  }

  /** Jaeger UI URL. */
  get dashboardUrl(): string {
    return `http://localhost:${this.uiPort}`;
  }

  /** Whether we have a compose file / container set up. */
  get isConfigured(): boolean {
    return this.context.globalState.get<boolean>("jaeger.configured") === true;
  }

  // ---- lifecycle ----

  /** Full first-time setup: docker check → pull → run → wait. */
  async setup(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    step("Verifying Docker is installed and running…");
    if (!(await this.isDockerInstalled())) {
      throw new Error("Docker is not installed or not running. Please install Docker and try again.");
    }

    await this.start(report);
    await this.waitForReady(30_000, report);
    await this.context.globalState.update("jaeger.configured", true);
    step("Jaeger setup complete.");
  }

  /** Start the Jaeger container. */
  async start(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    const name = JAEGER_DEFAULTS.containerName;

    // Check if our container already exists (stopped or running)
    const existing = await this.containerExists();
    if (existing === "running") {
      step("Jaeger container already running.");
      return;
    }
    if (existing === "stopped") {
      step("Starting existing Jaeger container…");
      await exec(`docker start ${name}`, { timeout: 30_000 });
      step("Jaeger container started.");
      return;
    }

    // Fresh run
    step("Starting Jaeger all-in-one container…");
    const image = `${JAEGER_DEFAULTS.image}:${JAEGER_DEFAULTS.tag}`;
    // Jaeger v2 enables OTLP receiver on 4317 (gRPC) and 4318 (HTTP) by default.
    // No extra flags needed — see https://www.jaegertracing.io/docs/2.15/getting-started/
    const cmd = [
      "docker run -d",
      `--name ${name}`,
      `--label ${JAEGER_DEFAULTS.label}=true`,
      `--label com.agent-tracing.stack=jaeger`,
      `-p ${this.uiPort}:16686`,
      `-p ${this.otlpPort}:4318`,
      image,
    ].join(" ");

    await execStreaming(cmd, {
      timeout: 120_000,
      onLine: (line) => {
        this.output.info(`  ${line}`);
        report?.(line);
      },
    });
    await this.context.globalState.update("jaeger.configured", true);
    step("Jaeger container started.");
  }

  /** Stop the Jaeger container. */
  async stop(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    const name = JAEGER_DEFAULTS.containerName;

    step("Stopping Jaeger container…");
    try {
      await exec(`docker stop ${name}`, { timeout: 30_000 });
    } catch {
      // container may not exist
    }
    step("Jaeger container stopped.");
  }

  /** Remove the Jaeger container + data. */
  async purge(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    const name = JAEGER_DEFAULTS.containerName;

    step("Removing Jaeger container…");
    try {
      await exec(`docker rm -f ${name}`, { timeout: 30_000 });
    } catch {
      // container may not exist
    }
    await this.context.globalState.update("jaeger.configured", false);
    step("Jaeger container removed.");
  }

  /** Recreate the Jaeger container (remove + start fresh). Data is in-memory so it's lost. */
  async recreate(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    const name = JAEGER_DEFAULTS.containerName;

    step("Removing existing Jaeger container…");
    try {
      await exec(`docker rm -f ${name}`, { timeout: 30_000 });
    } catch {
      // container may not exist
    }

    await this.start(report);
    await this.waitForReady(30_000, report);
    step("Jaeger container recreated.");
  }

  /** Check if Jaeger UI is reachable. */
  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.dashboardUrl}/`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async isDockerInstalled(): Promise<boolean> {
    try {
      await exec("docker info", { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Open the Jaeger UI in VS Code's integrated browser. */
  async openDashboard(): Promise<void> {
    // Reuse existing Jaeger tab if found
    for (const group of vscode.window.tabGroups.all) {
      const tabIndex = group.tabs.findIndex(
        (t) => t.input === undefined && (t.label.toLowerCase().includes("jaeger ui") || t.label.toLowerCase().includes("invoke_agent")),
      );
      if (tabIndex >= 0) {
        if (group.viewColumn !== undefined) {
          await vscode.commands.executeCommand(
            `workbench.action.focus${this.ordinalGroup(group.viewColumn)}EditorGroup`,
          );
        }
        await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", tabIndex);
        return;
      }
    }

    await vscode.commands.executeCommand(
      "simpleBrowser.api.open",
      vscode.Uri.parse(this.searchUrl),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    );
  }

  /** Open Jaeger UI in system browser. */
  async openDashboardExternal(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl));
  }

  /** Show a modal dialog with Jaeger stack and image version details. */
  async showStackVersion(): Promise<void> {
    const version = JAEGER_DEFAULTS.stackVersion;
    const pinnedAt = JAEGER_DEFAULTS.pinnedAt;
    const image = JAEGER_DEFAULTS.image;
    const tag = JAEGER_DEFAULTS.tag;

    const detail = [
      `Jaeger All-in-One: ${image}:${tag}`,
      `UI: http://localhost:${this.uiPort}`,
      `OTLP HTTP: http://localhost:${this.otlpPort}/v1/traces`,
    ].join("\n");

    const action = await vscode.window.showInformationMessage(
      `Jaeger Stack v${version}  (pinned ${pinnedAt})`,
      { modal: true, detail },
      { title: "Copy to Clipboard" },
      { title: "Show in Output" },
      { title: "Cancel", isCloseAffordance: true },
    );

    if (action?.title === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(
        formatJaegerStackSummary({
          image,
          tag,
          uiPort: this.uiPort,
          otlpPort: this.otlpPort,
          version,
          pinnedAt,
        }),
      );
    } else if (action?.title === "Show in Output") {
      this.output.info(
        formatJaegerStackSummary({
          image,
          tag,
          uiPort: this.uiPort,
          otlpPort: this.otlpPort,
          version,
          pinnedAt,
        }),
      );
      this.output.show(true);
    }
  }

  /** URL pointing to the search/traces view. */
  get searchUrl(): string {
    return `${this.dashboardUrl}/search?service=agent-tracing`;
  }

  // ---- private helpers ----

  /** Check if our managed container exists. Returns 'running' | 'stopped' | null. */
  private async containerExists(): Promise<"running" | "stopped" | null> {
    const name = JAEGER_DEFAULTS.containerName;
    try {
      const out = await exec(
        `docker inspect --format='{{.State.Running}}' ${name}`,
        { timeout: 10_000 },
      );
      return out.includes("true") ? "running" : "stopped";
    } catch {
      return null;
    }
  }

  private async waitForReady(timeoutMs = 30_000, report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    step("Waiting for Jaeger to become healthy…");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) {
        step("Jaeger is ready.");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Jaeger did not become healthy within ${timeoutMs / 1000}s`);
  }

  private ordinalGroup(viewColumn: vscode.ViewColumn): string {
    const names: Record<number, string> = {
      1: "First", 2: "Second", 3: "Third", 4: "Fourth",
      5: "Fifth", 6: "Sixth", 7: "Seventh", 8: "Eighth",
    };
    return names[viewColumn] ?? "First";
  }
}
