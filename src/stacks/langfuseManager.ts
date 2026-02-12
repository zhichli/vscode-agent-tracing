import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { exec } from "../exec";

/** Default credentials seeded via LANGFUSE_INIT_* on first launch. */
export const LANGFUSE_DEFAULT_USER = {
  email: "local@agent-tracing.dev",
  password: "agenttracing",
  name: "Agent Tracing",
} as const;

/** Manages the Langfuse Docker stack lifecycle. */
export class LangfuseManager {
  private composePath: string;

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
  ) {
    this.composePath = path.join(
      context.globalStorageUri.fsPath,
      "docker-compose.langfuse.yml",
    );
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
    return `http://localhost:${this.port}`;
  }

  // ---- lifecycle ----

  /** Full first-time setup: docker check → compose write → start → wait. */
  async setup(): Promise<void> {
    await this.requireDocker();
    await this.ensurePythonLangfuse();
    this.writeComposeFile();
    await this.start();
    await this.waitForReady();
  }

  async start(): Promise<void> {
    this.writeComposeFile(); // ensure file exists
    this.log("Starting Langfuse v3 stack (web, worker, postgres, clickhouse, redis, minio)…");
    await exec(
      `docker compose -p agent-tracing -f "${this.composePath}" up -d --wait`,
      { timeout: 180_000 },
    );
    this.log("Langfuse stack started.");
  }

  async stop(): Promise<void> {
    this.log("Stopping Langfuse stack…");
    await exec(
      `docker compose -p agent-tracing -f "${this.composePath}" down`,
      { timeout: 60_000 },
    );
    this.log("Langfuse stack stopped.");
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.dashboardUrl}/api/public/health`);
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

  async openDashboard(): Promise<void> {
    await vscode.commands.executeCommand(
      "simpleBrowser.api.open",
      vscode.Uri.parse(this.dashboardUrl),
      {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      },
    );
  }

  /** Show a notification with the auto-seeded login credentials. */
  async showLoginInfo(): Promise<void> {
    const msg = `Langfuse login — email: ${LANGFUSE_DEFAULT_USER.email}  password: ${LANGFUSE_DEFAULT_USER.password}`;
    const action = await vscode.window.showInformationMessage(msg, "Copy Email", "Copy Password");
    if (action === "Copy Email") {
      await vscode.env.clipboard.writeText(LANGFUSE_DEFAULT_USER.email);
    } else if (action === "Copy Password") {
      await vscode.env.clipboard.writeText(LANGFUSE_DEFAULT_USER.password);
    }
  }

  // ---- private helpers ----

  private async requireDocker(): Promise<void> {
    if (!(await this.isDockerInstalled())) {
      throw new Error(
        "Docker is not installed or not running. Please install Docker and try again.",
      );
    }
  }

  private async ensurePythonLangfuse(): Promise<void> {
    try {
      await exec("python3 -c \"import langfuse\"", { timeout: 10_000 });
      this.log("Python langfuse package already installed.");
    } catch {
      this.log("Installing langfuse Python package…");
      try {
        await exec("pip3 install --user langfuse", { timeout: 120_000 });
        this.log("langfuse Python package installed.");
      } catch (e: any) {
        this.log(`Warning: Could not install langfuse Python package: ${e.message}`);
        vscode.window.showWarningMessage(
          "Could not auto-install the `langfuse` Python package. Please run: pip3 install langfuse",
        );
      }
    }
  }

  private async waitForReady(timeoutMs = 90_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) {
        this.log("Langfuse is ready.");
        return;
      }
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
    this.log(`Wrote compose file: ${this.composePath}`);
  }

  private renderCompose(): string {
    const pk = this.publicKey;
    const sk = this.secretKey;
    const port = this.port;
    const secret = this.getOrCreateSecret("nextauth.secret");
    const salt = this.getOrCreateSecret("salt");
    const encryptionKey = this.getOrCreateSecret("encryption.key");

    return `# Auto-generated by Agent Tracing — do not edit
# Langfuse v3 stack (web + worker + postgres + clickhouse + redis + minio)
services:
  langfuse-worker:
    image: langfuse/langfuse-worker:3
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
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:9090
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
    image: langfuse/langfuse:3
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
      LANGFUSE_INIT_ORG_ID: agent-tracing-org
      LANGFUSE_INIT_ORG_NAME: Agent Tracing
      LANGFUSE_INIT_PROJECT_ID: agent-tracing-project
      LANGFUSE_INIT_PROJECT_NAME: Local
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: "${pk}"
      LANGFUSE_INIT_PROJECT_SECRET_KEY: "${sk}"
      LANGFUSE_INIT_USER_EMAIL: local@agent-tracing.dev
      LANGFUSE_INIT_USER_NAME: Agent Tracing
      LANGFUSE_INIT_USER_PASSWORD: agenttracing
    labels:
      com.agent-tracing.managed: "true"
      com.agent-tracing.stack: langfuse

  agent-tracing-clickhouse:
    image: clickhouse/clickhouse-server
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
    image: cgr.dev/chainguard/minio
    container_name: agent-tracing-minio
    restart: unless-stopped
    entrypoint: sh
    command: -c 'mkdir -p /data/langfuse && minio server --address ":9000" --console-address ":9001" /data'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: miniosecret
    ports:
      - "9090:9000"
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
    image: redis:7
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
    image: postgres:17-alpine
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

  private log(msg: string) {
    this.output.appendLine(`[Langfuse] ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
