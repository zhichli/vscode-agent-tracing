import { exec as cpExec, spawn } from "child_process";

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

/** Promise wrapper around child_process.exec with combined stdout/stderr. */
export function exec(
  command: string,
  options: ExecOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    cpExec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 30_000,
        env: { ...process.env, ...options.env },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(msg));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

export interface ExecStreamingOptions extends ExecOptions {
  /** Called for each line of stdout/stderr output. */
  onLine?: (line: string) => void;
}

/**
 * Execute a command and stream stdout/stderr line-by-line via onLine callback.
 * Resolves with the full combined output when the process exits.
 */
export function execStreaming(
  command: string,
  options: ExecStreamingOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output: string[] = [];
    let killed = false;

    const timer = options.timeout
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
          reject(new Error(`Command timed out after ${options.timeout}ms`));
        }, options.timeout)
      : undefined;

    const handleData = (data: Buffer) => {
      const text = data.toString();
      output.push(text);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && options.onLine) {
          options.onLine(trimmed);
        }
      }
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) return; // already rejected via timeout
      const combined = output.join("").trim();
      if (code !== 0) {
        reject(new Error(combined || `Process exited with code ${code}`));
      } else {
        resolve(combined);
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
