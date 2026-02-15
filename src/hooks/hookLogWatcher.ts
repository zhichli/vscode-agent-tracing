import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Watches the hook aggregate log file (`hook.log`) for new lines.
 *
 * - Logs every new line to the extension output channel.
 * - On ERROR lines: shows a debounced warning toast (suppresses repeats
 *   for `ERROR_TOAST_COOLDOWN_MS`).
 * - On success (INFO … Done): logs to output channel only.
 *
 * Uses `fs.watchFile` (stat polling) because the log lives outside the
 * workspace and `vscode.workspace.createFileSystemWatcher` only covers
 * workspace files.
 */
export class HookLogWatcher implements vscode.Disposable {
  private static readonly ERROR_TOAST_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
  private static readonly POLL_INTERVAL_MS = 2_000;

  private lastSize = 0;
  private lastErrorToast = 0;
  private watching = false;
  private logPath: string;

  constructor(
    logDir: string,
    private output: vscode.LogOutputChannel,
    private treeRefresh: () => void,
  ) {
    this.logPath = path.join(logDir, "hook.log");
  }

  /** Start watching. Safe to call multiple times. */
  start(): void {
    if (this.watching) return;

    // Seed lastSize so we don't replay old lines on activation
    try {
      const stat = fs.statSync(this.logPath);
      this.lastSize = stat.size;
    } catch {
      this.lastSize = 0;
    }

    fs.watchFile(
      this.logPath,
      { persistent: false, interval: HookLogWatcher.POLL_INTERVAL_MS },
      (curr, _prev) => this.onFileChange(curr),
    );
    this.watching = true;
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (!this.watching) return;
    fs.unwatchFile(this.logPath);
    this.watching = false;
  }

  dispose(): void {
    this.stop();
  }

  // ---- internal ----

  private onFileChange(curr: fs.Stats): void {
    if (curr.size <= this.lastSize) {
      // File was truncated or unchanged
      this.lastSize = curr.size;
      return;
    }

    // Read only the new bytes
    const fd = fs.openSync(this.logPath, "r");
    try {
      const buf = Buffer.alloc(curr.size - this.lastSize);
      fs.readSync(fd, buf, 0, buf.length, this.lastSize);
      this.lastSize = curr.size;

      const newText = buf.toString("utf-8");
      const lines = newText.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        // Route to output channel at the appropriate level
        if (line.includes("[ERROR]")) {
          this.output.error(`[Hook] ${line}`);
          this.maybeShowErrorToast(line);
        } else if (line.includes("[DEBUG]")) {
          this.output.debug(`[Hook] ${line}`);
        } else {
          this.output.info(`[Hook] ${line}`);
        }
      }

      // Refresh tree so it can update status if needed
      this.treeRefresh();
    } finally {
      fs.closeSync(fd);
    }
  }

  private maybeShowErrorToast(line: string): void {
    const now = Date.now();
    if (now - this.lastErrorToast < HookLogWatcher.ERROR_TOAST_COOLDOWN_MS) return;
    this.lastErrorToast = now;

    // Extract the error message after [ERROR] [tag]
    const match = line.match(/\[ERROR\]\s*\[[^\]]*\]\s*(.*)/);
    const detail = match?.[1] ?? "Check the hook log for details.";

    void vscode.window
      .showWarningMessage(
        `Hook error — ${detail}`,
        "Show Log",
      )
      .then((action) => {
        if (action === "Show Log") {
          vscode.commands.executeCommand("agentTracing.showHookLog");
        }
      });
  }
}
