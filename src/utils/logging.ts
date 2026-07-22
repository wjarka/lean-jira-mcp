/**
 * Logging for a stdio MCP server.
 *
 * The stdio transport reserves stdout for the JSON-RPC stream — writing anything
 * else there corrupts the protocol. Every log line therefore goes to stderr.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, message: string, meta?: unknown): void {
  const line =
    meta === undefined
      ? `[lean-jira-mcp] ${level}: ${message}`
      : `[lean-jira-mcp] ${level}: ${message} ${safeJson(meta)}`;
  process.stderr.write(line + "\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
