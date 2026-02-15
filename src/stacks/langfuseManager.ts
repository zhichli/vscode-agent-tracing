import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { exec, execStreaming } from "../exec";
import {
  LANGFUSE_STACK_VERSION,
  formatLangfuseStackSummary,
} from "./stackVersions";

/** Default credentials seeded via LANGFUSE_INIT_* on first launch. */
export const LANGFUSE_DEFAULT_USER = {
  email: "local@agent-tracing.dev",
  password: "agenttracing",
  name: "Agent Tracing",
} as const;

/** Whether the extension manages Docker or connects to an external instance. */
export type LangfuseMode = "managed" | "external";

/** Callback for reporting progress steps to UI (e.g. notification toast). */
export type StepReporter = (message: string) => void;

/** Manages the Langfuse Docker stack lifecycle. */
export class LangfuseManager {
  private composePath: string;

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.LogOutputChannel,
  ) {
    this.composePath = path.join(
      context.globalStorageUri.fsPath,
      "docker-compose.langfuse.yml",
    );
  }

  // ---- mode ----

  get mode(): LangfuseMode {
    return this.context.globalState.get<LangfuseMode>("langfuse.mode") ?? "managed";
  }

  get isManaged(): boolean {
    return this.mode === "managed" && fs.existsSync(this.composePath);
  }

  get isExternal(): boolean {
    return this.mode === "external";
  }

  /** Switch to external mode and store user-provided keys + host. */
  async connectExternal(publicKey: string, secretKey: string, host: string): Promise<void> {
    await this.context.globalState.update("langfuse.mode", "external");
    await this.context.globalState.update("langfuse.publicKey", publicKey);
    await this.context.globalState.update("langfuse.secretKey", secretKey);
    await this.context.globalState.update("langfuse.externalHost", host);
    this.output.info(`Connected to external Langfuse at ${host}`);
  }

  /** Switch back to managed mode (clears external host). */
  async switchToManaged(): Promise<void> {
    await this.context.globalState.update("langfuse.mode", "managed");
    await this.context.globalState.update("langfuse.externalHost", undefined);
    // Keys stay — they'll be regenerated on next managed setup if needed
    this.output.info("Switched to managed mode.");
  }

  /** Disconnect from external instance (clear mode + keys). */
  async disconnect(): Promise<void> {
    await this.context.globalState.update("langfuse.mode", undefined);
    await this.context.globalState.update("langfuse.externalHost", undefined);
    // Don't clear keys — they may still be valid if user reconnects
    this.output.info("Disconnected from external Langfuse.");
  }

  // ---- public getters ----

  get port(): number {
    return vscode.workspace
      .getConfiguration("agentTracing.langfuse")
      .get<number>("port", 3000);
  }

  get publicKey(): string {
    return (
      this.context.globalState.get<string>("langfuse.publicKey") ??
      this.generateAndStoreKeys().publicKey
    );
  }

  get secretKey(): string {
    return (
      this.context.globalState.get<string>("langfuse.secretKey") ??
      this.generateAndStoreKeys().secretKey
    );
  }

  get dashboardUrl(): string {
    if (this.isExternal) {
      return this.context.globalState.get<string>("langfuse.externalHost") ?? `http://localhost:${this.port}`;
    }
    return `http://localhost:${this.port}`;
  }

  // ---- lifecycle ----

  /** Full first-time setup: docker check → compose write → start → wait. */
  async setup(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    step("Switching to managed mode…");
    await this.switchToManaged();

    step("Verifying Docker is installed and running…");
    await this.requireDocker();

    step("Ensuring Python langfuse package is installed…");
    await this.ensurePythonLangfuse();

    step("Writing docker-compose file…");
    this.writeComposeFile();

    await this.start(report);
    await this.waitForReady(90_000, report);

    step("Setup complete — Langfuse is ready.");
  }

  async start(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    if (this.isExternal) {
      throw new Error("Cannot start an external Langfuse instance from this extension.");
    }
    step("Ensuring compose file is up to date…");
    this.writeComposeFile(); // ensure file exists

    step("docker compose up -d --wait");
    try {
      await execStreaming(
        `docker compose -p agent-tracing -f "${this.composePath}" up -d --wait`,
        {
          timeout: 180_000,
          onLine: (line) => {
            this.output.info(`  ${line}`);
            report?.(line);
          },
        },
      );
    } catch (e: any) {
      const msg = e.message ?? "";
      this.output.error(`Docker compose failed: ${msg}`);
      if (msg.includes("address pools have been fully subnetted") || msg.includes("Pool overlaps")) {
        throw new Error(
          "Docker ran out of network address space. Run 'docker network prune' in a terminal to free unused networks, then try again.",
        );
      }
      throw e;
    }
    step("All containers started.");
  }

  async stop(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    if (this.isExternal) {
      throw new Error("Cannot stop an external Langfuse instance from this extension.");
    }
    if (!fs.existsSync(this.composePath)) {
      throw new Error(
        "No managed Langfuse stack found. The running instance may be external — use 'Connect to Existing' instead.",
      );
    }
    step("docker compose down");
    await execStreaming(
      `docker compose -p agent-tracing -f "${this.composePath}" down`,
      {
        timeout: 60_000,
        onLine: (line) => {
          this.output.info(`  ${line}`);
          report?.(line);
        },
      },
    );
    step("All containers stopped.");
  }

  /** Destroy stack + volumes and recreate from scratch. Wipes all data. */
  async recreate(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    if (this.isExternal) {
      throw new Error("Cannot recreate an external Langfuse instance.");
    }

    // Tear down WITHOUT volumes — keeps trace data in Postgres/ClickHouse
    if (fs.existsSync(this.composePath)) {
      step("docker compose down (keeping data volumes)…");
      await execStreaming(
        `docker compose -p agent-tracing -f "${this.composePath}" down`,
        {
          timeout: 60_000,
          onLine: (line) => {
            this.output.info(`  ${line}`);
            report?.(line);
          },
        },
      );
    }

    // Rebuild from fresh compose file
    step("Recreating containers…");
    this.writeComposeFile();
    await this.start(report);
    await this.waitForReady(90_000, report);
    step("Stack recreated — trace data preserved.");
  }

  /** Destroy stack + volumes completely. Wipes all data. */
  async purge(report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };

    if (this.isExternal) {
      throw new Error("Cannot purge an external Langfuse instance.");
    }

    if (fs.existsSync(this.composePath)) {
      step("docker compose down -v (removing containers + volumes)…");
      await execStreaming(
        `docker compose -p agent-tracing -f "${this.composePath}" down -v`,
        {
          timeout: 60_000,
          onLine: (line) => {
            this.output.info(`  ${line}`);
            report?.(line);
          },
        },
      );
      // Remove compose file
      fs.unlinkSync(this.composePath);
    }

    await this.context.globalState.update("langfuse.mode", undefined);
    step("Stack purged — all data removed.");
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.dashboardUrl}/api/public/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Check if the running Langfuse is our managed stack (by container labels). */
  async isOurManagedStack(): Promise<boolean> {
    try {
      const output = await exec(
        'docker ps --filter "label=com.agent-tracing.managed=true" --format "{{.Names}}"',
        { timeout: 10_000 },
      );
      return output.includes("agent-tracing-langfuse-web");
    } catch {
      return false;
    }
  }

  /** Ensure the compose file exists on disk (write if missing). */
  ensureComposeFile(): void {
    if (!fs.existsSync(this.composePath)) {
      this.writeComposeFile();
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

  async openDashboard(): Promise<void> {
    // simpleBrowser.api.open reuses an existing Simple Browser tab when
    // the same base URL is already open — no duplicate tabs.
    // We always navigate to the root URL to avoid stacking sub-paths.
    await vscode.commands.executeCommand(
      "simpleBrowser.api.open",
      vscode.Uri.parse(this.dashboardUrl),
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
    );
  }

  async openDashboardExternal(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl));
  }

  /** Show a modal dialog with login credentials (managed mode only). */
  async showLoginInfo(): Promise<void> {
    if (this.isExternal) {
      await vscode.window.showInformationMessage(
        "This is an external Langfuse instance — login credentials are managed by you.",
        { modal: true },
      );
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `Langfuse Login\n\nEmail: ${LANGFUSE_DEFAULT_USER.email}\nPassword: ${LANGFUSE_DEFAULT_USER.password}`,
      { modal: true },
      "Copy Password",
      "Copy Email",
    );
    if (action === "Copy Email") {
      await vscode.env.clipboard.writeText(LANGFUSE_DEFAULT_USER.email);
    } else if (action === "Copy Password") {
      await vscode.env.clipboard.writeText(LANGFUSE_DEFAULT_USER.password);
    }
  }

  /** Show a modal dialog with pinned stack + image versions. */
  async showStackVersion(): Promise<void> {
    const sv = LANGFUSE_STACK_VERSION;
    const imgs = Object.values(sv.images);
    const detail = imgs
      .map((i) => `${i.label}: ${i.image}:${i.tag}`)
      .join("\n");

    const action = await vscode.window.showInformationMessage(
      `Langfuse Stack v${sv.version}  (pinned ${sv.pinnedAt})`,
      { modal: true, detail },
      "Copy to Clipboard",
      "Show in Output",
    );

    if (action === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(formatLangfuseStackSummary(sv));
    } else if (action === "Show in Output") {
      this.output.info(formatLangfuseStackSummary(sv));
      this.output.show(true);
    }
  }

  /** Validate that stored keys work against the running instance. */
  async validateKeys(): Promise<boolean> {
    try {
      const res = await fetch(`${this.dashboardUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Basic " + Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64"),
        },
        body: JSON.stringify({ batch: [] }),
      });
      // 207 = multi-status (expected for empty batch), 200 = ok
      return res.status === 207 || res.ok;
    } catch {
      return false;
    }
  }

  // ---- private helpers ----

  private async requireDocker(): Promise<void> {
    if (!(await this.isDockerInstalled())) {
      this.output.error("Docker check FAILED — docker info returned an error.");
      throw new Error(
        "Docker is not installed or not running. Please install Docker and try again.",
      );
    }
    this.output.info("Docker check passed.");
  }

  private async ensurePythonLangfuse(): Promise<void> {
    try {
      await exec("python3 -c \"import langfuse\"", { timeout: 10_000 });
      this.output.info("Python langfuse package already installed — skipping install.");
    } catch {
      this.output.info("Python langfuse package not found — installing via pip3…");
      try {
        await exec("pip3 install --user langfuse", { timeout: 120_000 });
        this.output.info("Python langfuse package installed successfully.");
      } catch (e: any) {
        this.output.warn(`Could not install langfuse Python package: ${e.message}`);
        vscode.window.showWarningMessage(
          "Could not auto-install the `langfuse` Python package. Please run: pip3 install langfuse",
        );
      }
    }
  }

  private async waitForReady(timeoutMs = 90_000, report?: StepReporter): Promise<void> {
    const step = (msg: string) => { this.output.info(msg); report?.(msg); };
    step("Waiting for Langfuse to become healthy…");
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      if (await this.isRunning()) {
        step("Langfuse health check passed — server is ready.");
        return;
      }
      this.output.debug(`Health check attempt ${attempts} failed, retrying in 2s…`);
      await sleep(2000);
    }
    throw new Error(
      `Langfuse did not become healthy within ${timeoutMs / 1000}s`,
    );
  }

  private writeComposeFile(): void {
    const dir = path.dirname(this.composePath);
    fs.mkdirSync(dir, { recursive: true });

    const yaml = this.renderCompose();
    fs.writeFileSync(this.composePath, yaml, "utf-8");
    this.output.debug(`Wrote compose file: ${this.composePath}`);
  }

  private renderCompose(): string {
    const pk = this.publicKey;
    const sk = this.secretKey;
    const port = this.port;
    const minioPort = port + 6090; // e.g. 3000 → 9090, 3001 → 9091
    const secret = this.getOrCreateSecret("nextauth.secret");
    const salt = this.getOrCreateSecret("salt");
    const encryptionKey = this.getOrCreateSecret("encryption.key");
    const v = LANGFUSE_STACK_VERSION.images;

    return `# Auto-generated by Agent Tracing — do not edit
# Stack version: ${LANGFUSE_STACK_VERSION.version} (pinned ${LANGFUSE_STACK_VERSION.pinnedAt})
# Langfuse v3 stack (web + worker + postgres + clickhouse + redis + minio)
services:
  langfuse-worker:
    image: ${v.langfuseWorker.image}:${v.langfuseWorker.tag}
    container_name: agent-tracing-langfuse-worker
    restart: unless-stopped
    depends_on:
      agent-tracing-langfuse-db:
        condition: service_healthy
      agent-tracing-minio:
        condition: service_healthy
      agent-tracing-redis:
        condition: service_healthy
      agent-tracing-clickhouse:
        condition: service_healthy
    environment: &langfuse-worker-env
      DATABASE_URL: postgresql://langfuse:langfuse@agent-tracing-langfuse-db:5432/langfuse
      NEXTAUTH_URL: http://localhost:${port}
      SALT: "${salt}"
      ENCRYPTION_KEY: "${encryptionKey}"
      TELEMETRY_ENABLED: "false"
      LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES: "true"
      CLICKHOUSE_MIGRATION_URL: clickhouse://agent-tracing-clickhouse:9000
      CLICKHOUSE_URL: http://agent-tracing-clickhouse:8123
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
      CLICKHOUSE_CLUSTER_ENABLED: "false"
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_EVENT_UPLOAD_REGION: auto
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: http://agent-tracing-minio:9000
      LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_EVENT_UPLOAD_PREFIX: events/
      LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_MEDIA_UPLOAD_REGION: auto
      LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:${minioPort}
      LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_MEDIA_UPLOAD_PREFIX: media/
      LANGFUSE_S3_BATCH_EXPORT_ENABLED: "false"
      REDIS_HOST: agent-tracing-redis
      REDIS_PORT: "6379"
      REDIS_AUTH: agenttraceredis
      REDIS_TLS_ENABLED: "false"
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  langfuse-web:
    image: ${v.langfuseWeb.image}:${v.langfuseWeb.tag}
    container_name: agent-tracing-langfuse-web
    restart: unless-stopped
    depends_on:
      agent-tracing-langfuse-db:
        condition: service_healthy
      agent-tracing-minio:
        condition: service_healthy
      agent-tracing-redis:
        condition: service_healthy
      agent-tracing-clickhouse:
        condition: service_healthy
    ports:
      - "${port}:3000"
    environment:
      <<: *langfuse-worker-env
      NEXTAUTH_SECRET: "${secret}"
      # Auto-seed org, project, and user so hooks work with zero manual setup
      LANGFUSE_INIT_ORG_ID: agent-tracing-vscode
      LANGFUSE_INIT_ORG_NAME: VS Code
      LANGFUSE_INIT_PROJECT_ID: agent-tracing-default
      LANGFUSE_INIT_PROJECT_NAME: Agent Tracing
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: "${pk}"
      LANGFUSE_INIT_PROJECT_SECRET_KEY: "${sk}"
      LANGFUSE_INIT_USER_EMAIL: local@agent-tracing.dev
      LANGFUSE_INIT_USER_NAME: Agent Tracing
      LANGFUSE_INIT_USER_PASSWORD: agenttracing
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  agent-tracing-clickhouse:
    image: ${v.clickhouse.image}:${v.clickhouse.tag}
    container_name: agent-tracing-clickhouse
    restart: unless-stopped
    user: "101:101"
    environment:
      CLICKHOUSE_DB: default
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
    volumes:
      - agent-tracing-clickhouse-data:/var/lib/clickhouse
      - agent-tracing-clickhouse-logs:/var/log/clickhouse-server
    healthcheck:
      test: wget --no-verbose --tries=1 --spider http://localhost:8123/ping || exit 1
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 1s
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  agent-tracing-minio:
    image: ${v.minio.image}:${v.minio.tag}
    container_name: agent-tracing-minio
    restart: unless-stopped
    entrypoint: sh
    command: -c 'mkdir -p /data/langfuse && minio server --address ":9000" --console-address ":9001" /data'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: miniosecret
    ports:
      - "${minioPort}:9000"
    volumes:
      - agent-tracing-minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 1s
      timeout: 5s
      retries: 5
      start_period: 1s
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  agent-tracing-redis:
    image: ${v.redis.image}:${v.redis.tag}
    container_name: agent-tracing-redis
    restart: unless-stopped
    command: >
      --requirepass agenttraceredis
      --maxmemory-policy noeviction
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 10s
      retries: 10
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  agent-tracing-langfuse-db:
    image: ${v.postgres.image}:${v.postgres.tag}
    container_name: agent-tracing-langfuse-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: langfuse
      POSTGRES_PASSWORD: langfuse
      POSTGRES_DB: langfuse
    volumes:
      - agent-tracing-langfuse-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U langfuse"]
      interval: 3s
      timeout: 3s
      retries: 10
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

volumes:
  agent-tracing-langfuse-data:
  agent-tracing-clickhouse-data:
  agent-tracing-clickhouse-logs:
  agent-tracing-minio-data:

networks:
  default:
    name: agent-tracing
    ipam:
      config:
        - subnet: 172.177.0.0/16
`;
  }

  private generateAndStoreKeys() {
    const pk = `pk-lf-${crypto.randomUUID()}`;
    const sk = `sk-lf-${crypto.randomUUID()}`;
    void this.context.globalState.update("langfuse.publicKey", pk);
    void this.context.globalState.update("langfuse.secretKey", sk);
    return { publicKey: pk, secretKey: sk };
  }

  private getOrCreateSecret(key: string): string {
    const existing = this.context.globalState.get<string>(key);
    if (existing) return existing;
    const secret = crypto.randomBytes(32).toString("hex");
    void this.context.globalState.update(key, secret);
    return secret;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
