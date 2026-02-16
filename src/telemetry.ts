import { TelemetryReporter } from "@vscode/extension-telemetry";
import * as vscode from "vscode";

/**
 * Thin wrapper around @vscode/extension-telemetry.
 *
 * The connection string is read from package.json
 * `telemetryConnectionString`. If missing or empty,
 * all send calls are silently no-ops (the SDK handles this gracefully).
 *
 * Automatically respects the user's `telemetry.telemetryLevel` setting.
 */

let reporter: TelemetryReporter | undefined;

/** Initialize telemetry. Call once in activate(). */
export function initTelemetry(context: vscode.ExtensionContext): void {
  try {
    // Read connection string from package.json (set at build time)
    const extId = context.extension.id;
    const ext = vscode.extensions.getExtension(extId);
    const connectionString: string = ext?.packageJSON?.telemetryConnectionString ?? "";
    if (!connectionString) {
      // No connection string configured — telemetry silently disabled.
      return;
    }
    reporter = new TelemetryReporter(connectionString);
    context.subscriptions.push(reporter);
  } catch {
    // Telemetry init failed — silently degrade.
    reporter = undefined;
  }
}

/** Send a telemetry event with optional string properties and numeric measurements. */
export function sendEvent(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(name, properties, measurements);
}

/** Send a telemetry error event. */
export function sendError(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryErrorEvent(name, properties, measurements);
}
