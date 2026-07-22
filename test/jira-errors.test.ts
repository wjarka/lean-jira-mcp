/**
 * Shared JIRA-error → shaped-response mapping (issue 11 groups D + E).
 *
 * Group E: `genericJiraErrorResult` must branch on HTTP status — a 429/503 is
 * transient (back off), a non-auth 4xx is a hard rejection (don't retry blind).
 * Group D: `withErrorBoundary` catches anything a handler misses and routes it
 * through the same shaped contract. Pure-function tests; no server, no network.
 */

import { test, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  authErrorResult,
  genericJiraErrorResult,
  withErrorBoundary,
} from "../src/lib/jira-errors.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import { parseShaped, type ErrorPayload } from "../src/lib/response-shaper.ts";

function err(result: CallToolResult): ErrorPayload {
  return parseShaped<ErrorPayload>(result);
}

// --- group E: status-aware generic mapping ----------------------------------

test("a 429 maps to a back-off hint, NOT credential guidance", () => {
  const out = genericJiraErrorResult(new JiraApiError(429, ["Too Many Requests"], {}));
  const hint = err(out).hints.join(" ");
  expect(hint).toMatch(/rate|back.?off|transient|retry/i);
  expect(hint).not.toMatch(/credential|JIRA_API_TOKEN/i);
});

test("a 503 maps to a transient/back-off hint", () => {
  const hint = err(genericJiraErrorResult(new JiraApiError(503, ["Service Unavailable"], {}))).hints.join(" ");
  expect(hint).toMatch(/transient|back.?off|temporarily|retry/i);
});

test("a non-auth 4xx (e.g. 400) maps to an invalid/not-transient hint", () => {
  const hint = err(genericJiraErrorResult(new JiraApiError(400, ["Bad Request"], {}))).hints.join(" ");
  expect(hint).toMatch(/invalid|not transient|re-?check|rejected/i);
  expect(hint).not.toMatch(/retry shortly/i);
});

test("every mapped generic error still carries a code and at least one hint", () => {
  for (const status of [400, 429, 500, 503]) {
    const payload = err(genericJiraErrorResult(new JiraApiError(status, ["x"], {})));
    expect(payload.error.code).toBe(`jira_http_${status}`);
    expect(payload.hints.length).toBeGreaterThan(0);
  }
});

// --- group D: withErrorBoundary ---------------------------------------------

test("withErrorBoundary shapes an auth JiraApiError as authentication_failed", async () => {
  const wrapped = withErrorBoundary(async () => {
    throw new JiraApiError(401, ["unauthenticated"], {});
  });
  const payload = err(await wrapped());
  expect(payload.error.code).toBe("authentication_failed");
});

test("withErrorBoundary shapes a generic JiraApiError through the status mapping", async () => {
  const wrapped = withErrorBoundary(async () => {
    throw new JiraApiError(429, ["Too Many Requests"], {});
  });
  const payload = err(await wrapped());
  expect(payload.error.code).toBe("jira_http_429");
  expect(payload.hints.join(" ")).toMatch(/rate|back.?off|retry/i);
});

test("withErrorBoundary shapes a non-JIRA throw as an unexpected error", async () => {
  const wrapped = withErrorBoundary(async () => {
    throw new Error("kaboom");
  });
  const payload = err(await wrapped());
  expect(payload.hints.join(" ")).toMatch(/unexpected/i);
  expect(payload.error.message).toContain("kaboom");
});

test("withErrorBoundary passes a successful result through unchanged", async () => {
  const ok: CallToolResult = { content: [{ type: "text", text: "{}" }] };
  const wrapped = withErrorBoundary(async () => ok);
  expect(await wrapped()).toBe(ok);
});

test("an auth result is unchanged by the new status branch", () => {
  // 401/403 never reach genericJiraErrorResult — they go through authErrorResult.
  const payload = err(authErrorResult(new JiraApiError(403, ["forbidden"], {})));
  expect(payload.error.code).toBe("authentication_failed");
});
