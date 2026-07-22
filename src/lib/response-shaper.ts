/**
 * Response shaper — the uniform success/error envelope every tool returns.
 *
 * Cross-cutting contract (DESIGN.md): every response, success *and* error,
 * carries a `hints` array telling the agent what to do next. Bad-value errors
 * additionally return the valid `options` for that entity.
 *
 * The payload is serialized as JSON into a single text content block. The agent
 * reads that JSON; tests parse it back with `parseShaped()`.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface SuccessPayload {
  [key: string]: unknown;
  hints: string[];
}

export interface ErrorPayload {
  error: {
    message: string;
    code?: string;
    /** Valid options for the offending entity, when known. */
    options?: unknown;
  };
  hints: string[];
}

export interface ShapedErrorInput {
  message: string;
  code?: string;
  options?: unknown;
}

function toContent(payload: unknown): CallToolResult["content"] {
  return [{ type: "text", text: JSON.stringify(payload, null, 2) }];
}

export function shapeSuccess(
  data: Record<string, unknown>,
  hints: string[],
): CallToolResult {
  const payload: SuccessPayload = { ...data, hints };
  return { content: toContent(payload) };
}

export function shapeError(
  error: ShapedErrorInput,
  hints: string[],
): CallToolResult {
  const payload: ErrorPayload = {
    error: {
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.options !== undefined ? { options: error.options } : {}),
    },
    hints,
  };
  return { content: toContent(payload), isError: true };
}

/**
 * The issue's `/browse/<key>` deep link on this JIRA instance. The key is
 * always URI-encoded — a no-op for a normal key like `ABC-123`, but safe for
 * any key that isn't. Pass `focusedCommentId` to link straight to one comment.
 */
export function browseUrl(
  baseUrl: string,
  issueKey: string,
  opts?: { focusedCommentId?: string },
): string {
  const base = `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issueKey)}`;
  return opts?.focusedCommentId !== undefined
    ? `${base}?focusedCommentId=${encodeURIComponent(opts.focusedCommentId)}`
    : base;
}

/** Test helper: parse the JSON payload back out of a shaped result. */
export function parseShaped<T = SuccessPayload | ErrorPayload>(
  result: CallToolResult,
): T {
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("shaped result has no text content");
  }
  return JSON.parse(first.text) as T;
}
