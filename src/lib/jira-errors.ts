/**
 * Shared JIRA-error → shaped-response mapping.
 *
 * The cross-cutting failures every tool can hit — rejected credentials, an
 * opaque HTTP error, an unexpected throw — are shaped identically so the
 * recovery-hint contract stays consistent across the tool surface (and so the
 * auth guidance from ADR 0002 isn't re-typed in every handler). Tool-specific
 * cases (a JQL parse error, an unknown issue key) stay in their own handler,
 * which falls through to {@link genericJiraErrorResult} for everything else.
 */

import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { JiraApiError } from "./jira-client.ts";
import { shapeError, type ShapedErrorInput } from "./response-shaper.ts";

/**
 * The message/code + recovery hints of a shaped cross-cutting error, BEFORE it
 * is wrapped into a transport-specific envelope. Splitting this out lets both
 * surfaces be built from one classification: a tool's `CallToolResult` (via
 * {@link shapeError}) and a resource read's `McpError` (via
 * {@link shapeUncaughtResourceError}), so the auth/generic/unexpected mapping
 * and the ADR-0002 hint text are defined exactly once, not re-typed per surface.
 */
interface ShapedParts {
  input: ShapedErrorInput;
  hints: string[];
}

/** Rejected credentials (401/403). See ADR 0002. */
function authErrorParts(err: JiraApiError): ShapedParts {
  return {
    input: { message: err.message, code: "authentication_failed" },
    hints: [
      "JIRA rejected the credentials — requests are being treated as unauthenticated. Verify JIRA_EMAIL and JIRA_API_TOKEN in the server environment.",
      "The token must be a CLASSIC, unscoped Atlassian API token; scoped tokens (e.g. read:jira-work) do NOT work with basic auth. Create one at https://id.atlassian.com/manage-profile/security/api-tokens.",
    ],
  };
}

/** Rejected credentials (401/403), shaped for a tool response. See ADR 0002. */
export function authErrorResult(err: JiraApiError): CallToolResult {
  const { input, hints } = authErrorParts(err);
  return shapeError(input, hints);
}

/**
 * A JIRA HTTP error with no more specific handling. Status-aware: a 429/503 is
 * transient and worth retrying with backoff (the client's retry layer should
 * have absorbed most of these already), whereas a non-auth 4xx is a hard
 * rejection that won't change on a blind retry. Auth (401/403) never reaches
 * here — it is routed through {@link authErrorResult}.
 */
function genericJiraErrorParts(err: JiraApiError): ShapedParts {
  return {
    input: { message: err.message, code: `jira_http_${err.status}` },
    hints: [genericRecoveryHint(err.status)],
  };
}

export function genericJiraErrorResult(err: JiraApiError): CallToolResult {
  const { input, hints } = genericJiraErrorParts(err);
  return shapeError(input, hints);
}

function genericRecoveryHint(status: number): string {
  if (status === 429 || status === 503) {
    return (
      "JIRA is rate-limiting or temporarily unavailable — this is transient. The client retries " +
      "429/503 with backoff automatically; if it still reached you, wait a moment and retry the same request."
    );
  }
  if (status >= 400 && status < 500) {
    return (
      "JIRA rejected the request as invalid — this is not transient. Re-check the arguments before " +
      "retrying; the same request will fail again unchanged."
    );
  }
  return "The JIRA request failed. Retry shortly; if it persists, verify the base URL and JIRA's status.";
}

/**
 * A 400 validation rejection carrying NO field-level detail — JIRA's bare
 * `INVALID_INPUT`, where the `errors` map is empty so nothing names *what* it
 * refused. For a plain field write a generic "re-check the arguments" hint is
 * the best we can do, but on a markdown→ADF write path it is a dead end: the
 * converted rich text is the overwhelmingly likely culprit and deserves to be
 * named (see {@link richTextValidationResult}).
 */
export function isDetaillessValidation(err: JiraApiError): boolean {
  return err.status === 400 && Object.keys(err.errors ?? {}).length === 0;
}

/**
 * Recovery result for a markdown→ADF write (create/update `description`, or
 * `jira_comment` `body`) that JIRA rejected with a detailless validation error.
 * JIRA names no field, so instead of surfacing a dead-end raw `INVALID_INPUT` /
 * generic "re-check the arguments", the hint names the rich-text field as the
 * probable cause, says the conversion may have produced content JIRA won't
 * accept, and points at retrying with simpler formatting. Restores the
 * recovery-hint contract on every rich-text write path (issue 20, bug B).
 */
export function richTextValidationResult(
  err: JiraApiError,
  field: "description" | "comment body",
): CallToolResult {
  const jiraMessage = err.errorMessages.join(" ").trim();
  return shapeError(
    { message: err.message, code: "rich_text_validation_failed" },
    [
      `JIRA rejected this write as invalid but named no field` +
        `${jiraMessage ? ` (${jiraMessage})` : ""}. The likely cause is the ${field}: the ` +
        `markdown→ADF conversion may have produced content JIRA won't accept. Retry with simpler ` +
        `formatting in the ${field} — drop unusual inline markup, or move a tricky fragment into a ` +
        `fenced code block.`,
    ],
  );
}

/** A non-JIRA, unexpected throw. */
function unexpectedErrorParts(err: unknown): ShapedParts {
  return {
    input: { message: err instanceof Error ? err.message : String(err) },
    hints: ["An unexpected error occurred. Retry, and if it persists check the server logs."],
  };
}

export function unexpectedErrorResult(err: unknown): CallToolResult {
  const { input, hints } = unexpectedErrorParts(err);
  return shapeError(input, hints);
}

/** The one classifier both surfaces share: map any thrown error to its parts. */
function uncaughtErrorParts(err: unknown): ShapedParts {
  if (err instanceof JiraApiError) {
    return err.isAuthError ? authErrorParts(err) : genericJiraErrorParts(err);
  }
  return unexpectedErrorParts(err);
}

/** Route any thrown error through the shaped-response contract (tool surface). */
export function shapeUncaughtError(err: unknown): CallToolResult {
  const { input, hints } = uncaughtErrorParts(err);
  return shapeError(input, hints);
}

/**
 * Resource variant of {@link shapeUncaughtError}: fold a thrown error into an
 * `McpError` instead of a `CallToolResult`.
 *
 * WHY an error and not error-shaped contents (the boundary's one design choice):
 * a resource read returns contents or it FAILS — unlike a tool, it has no result
 * envelope to carry `hints`. Returning success-shaped contents that merely
 * *contain* an error document would masquerade a failed read as a good one, and
 * an agent could consume the error JSON as if it were reference data. Throwing
 * an `McpError` is the honest shape (the read did not happen) and rides the MCP
 * protocol's own failure channel to the client.
 *
 * The classic-unscoped-token guidance (ADR 0002) is the crown jewel here, so the
 * recovery hints go into `message` — the field a client actually shows — not
 * only into structured data it might ignore. `data` additionally carries the
 * machine-readable shaped payload (semantic `code` + `hints`), mirroring the
 * tool `ErrorPayload`. Same classifier and hint text as the tool path
 * ({@link uncaughtErrorParts}), so a failed read has identical recovery fidelity
 * to a failed tool call.
 */
export function shapeUncaughtResourceError(err: unknown): McpError {
  const { input, hints } = uncaughtErrorParts(err);
  const message = [input.message, ...hints].join("\n\n");
  return new McpError(ErrorCode.InternalError, message, { error: input, hints });
}

/**
 * Resource analog of {@link withErrorBoundary}. A resource's read handler calls
 * the JiraClient with no try/catch of its own, so an auth/network throw would
 * otherwise escape as a bare, contextless JSON-RPC error. This catches it and
 * re-throws the shaped {@link shapeUncaughtResourceError}, giving every resource
 * read the SAME recovery fidelity a tool call gets for the identical failure.
 */
export function withResourceErrorBoundary<Args extends unknown[]>(
  handler: (...args: Args) => ReadResourceResult | Promise<ReadResourceResult>,
): (...args: Args) => Promise<ReadResourceResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      throw shapeUncaughtResourceError(err);
    }
  };
}

/**
 * Wrap a tool handler so NO error can leak unshaped. Reference resolvers and
 * other pre-flight work run before a tool's own try/catch, so an auth/network
 * failure there would otherwise throw a raw, contextless error at the MCP
 * boundary. This top-level boundary catches anything a handler misses and maps
 * it through the same recovery-hint contract every shaped error uses.
 */
export function withErrorBoundary<Args extends unknown[]>(
  handler: (...args: Args) => CallToolResult | Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return shapeUncaughtError(err);
    }
  };
}
