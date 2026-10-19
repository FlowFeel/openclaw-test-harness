/**
 * Logger Utilities — Centralized console and print statements.
 *
 * @dft principle: Print statements and console calls live in utils only.
 * This ensures all output formatting, log routing, and debug printing
 * are auditable, suppressible in tests, and cleanly separated from logic.
 */

export function safeLog(...args: unknown[]): void {
  console.log(...args);
}

export function safeWarn(...args: unknown[]): void {
  console.warn(...args);
}

export function safeError(...args: unknown[]): void {
  console.error(...args);
}

export function formatLogMessage(prefix: string, message: string): string {
  return `[${prefix}] ${message}`;
}

export function sidecarLog(port: number): void {
  safeLog(`[oc-sidecar] Server listening on 127.0.0.1:${port}`);
}

export function openrouterMockLog(port: number): void {
  safeLog(`[openrouter-mock] listening on ${port}`);
}
