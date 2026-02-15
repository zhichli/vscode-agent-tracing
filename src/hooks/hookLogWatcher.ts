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
  private static readonly MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

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
    // Rotate if the file has grown past the limit (before reading new bytes)
    this.rotateIfNeeded(curr);

    if (curr.size <= this.lastSize) {
      // File was truncated, rotated, or unchanged
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
        // Parse hook.log line: "2026-02-14 23:52:44 [LEVEL] [agent/session] message"
        // Keep the hook timestamp (may differ from relay time) but strip the
        // level tag since the output channel already provides its own.
        const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+\[\w+\]\s*\[([^\]]*)\]\s*(.*)/);
        const display = match
          ? `[Hook ${match[1].split(" ")[1]}] [${match[2]}] ${match[3]}`
          : `[Hook] ${line}`;

        // Route to output channel at the appropriate level
        if (line.includes("[ERROR]")) {
          this.output.error(display);
          this.maybeShowErrorToast(line);
        } else if (line.includes("[DEBUG]")) {
          this.output.debug(display);
        } else {
          this.output.info(display);
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

  /** Rotate hook.log → hook.log.1 when it exceeds MAX_LOG_BYTES. */
  private rotateIfNeeded(curr: fs.Stats): void {
    if (curr.size < HookLogWatcher.MAX_LOG_BYTES) return;
    try {
      const backup = this.logPath + ".1";
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(this.logPath, backup);
      this.lastSize = 0;
    } catch {
      // best-effort rotation
    }
  }
}
