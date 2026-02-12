import { exec as cpExec } from "child_process";

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
