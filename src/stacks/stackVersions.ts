/**
 * Pinned container image versions for the Langfuse Docker stack.
 *
 * When upgrading, update the tags here and bump LANGFUSE_STACK_VERSION.
 * Compose source reference:
 *   https://raw.githubusercontent.com/langfuse/langfuse/cec6febb289ec26a8c135246793219e6a6a1451b/docker-compose.yml
 */

/** A single container image with its pinned tag. */
export interface ImageVersion {
  /** Short name shown in UI (e.g. "Langfuse Web"). */
  label: string;
  /** Full image reference without the tag (e.g. "docker.io/langfuse/langfuse"). */
  image: string;
  /** Pinned tag (e.g. "3.153.0"). */
  tag: string;
}

/** Version descriptor for the Langfuse Docker stack. */
export interface LangfuseStackVersion {
  /** Semver-ish version for the stack bundle (our own versioning). */
  version: string;
  /** ISO date when this stack version was pinned. */
  pinnedAt: string;
  /** Upstream compose commit used as reference. */
  composeRef: string;
  /** Individual container image versions. */
  images: {
    langfuseWeb: ImageVersion;
    langfuseWorker: ImageVersion;
    clickhouse: ImageVersion;
    minio: ImageVersion;
    redis: ImageVersion;
    postgres: ImageVersion;
  };
}

/**
 * Current pinned stack version shipped with the extension.
 *
 * Bump `version` whenever any image tag is changed.
 */
export const LANGFUSE_STACK_VERSION: LangfuseStackVersion = {
  version: "1.1.0",
  pinnedAt: "2026-02-15",
  composeRef:
    "https://raw.githubusercontent.com/langfuse/langfuse/cec6febb289ec26a8c135246793219e6a6a1451b/docker-compose.yml",
  images: {
    langfuseWeb: {
      label: "Langfuse Web",
      image: "docker.io/langfuse/langfuse",
      tag: "3.153.0",
    },
    langfuseWorker: {
      label: "Langfuse Worker",
      image: "docker.io/langfuse/langfuse-worker",
      tag: "3.153.0",
    },
    clickhouse: {
      label: "ClickHouse",
      image: "docker.io/clickhouse/clickhouse-server",
      tag: "25.12.5.44",
    },
    minio: {
      label: "MinIO",
      image: "docker.io/minio/minio",
      tag: "RELEASE.2025-09-07T16-13-09Z",
    },
    redis: {
      label: "Redis",
      image: "docker.io/redis",
      tag: "7.4.7",
    },
    postgres: {
      label: "PostgreSQL",
      image: "docker.io/postgres",
      tag: "17.8-alpine",
    },
  },
};

/** Format a human-readable summary of the stack version. */
export function formatLangfuseStackSummary(sv: LangfuseStackVersion): string {
  const imgs = Object.values(sv.images) as ImageVersion[];
  const lines = [
    `Stack Version: ${sv.version}  (pinned ${sv.pinnedAt})`,
    "",
    ...imgs.map((i) => `  ${i.label.padEnd(18)} ${i.image}:${i.tag}`),
  ];
  return lines.join("\n");
}
