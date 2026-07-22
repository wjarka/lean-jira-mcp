/**
 * Issue 11 group D: the top-level handler error boundary.
 *
 * Reference resolvers run BEFORE a tool's own try/catch, so an auth/network
 * throw during resolution would otherwise escape as a raw, contextless error.
 * These tests drive a real tool call through the MCP server (the same path the
 * client uses) with a faked JiraClient that throws from a resolver, and assert
 * the response is a shaped recovery hint — not an unshaped leak.
 *
 * Resources get the same treatment lower down: a resource read has no result
 * envelope to carry hints, so a caught error is surfaced AS a JSON-RPC error
 * whose message carries the shaped summary + recovery hints (option (a) — see
 * `withResourceErrorBoundary`). Those tests read a resource through the same
 * in-memory client and assert the error, not a raw leak.
 */

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/core/server.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import { PROJECTS_URI } from "../src/resources/projects.ts";
import { LINK_TYPES_URI } from "../src/resources/link-types.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

/** A real in-memory server+client pair over the faked JiraClient. */
async function connect(jira: FakeJiraClient) {
  const server = createServer({
    jira,
    searchDeps: { projectDefault: "DEF" },
    createIssueDeps: {
      projectDefault: "DEF",
      baseUrl: "https://acme.atlassian.net",
    },
    updateIssueDeps: {
      baseUrl: "https://acme.atlassian.net",
    },
    commentDeps: { baseUrl: "https://acme.atlassian.net", marker: ":claude:" },
    readAttachmentDeps: { maxBytes: 25 * 1024 * 1024 },
    addAttachmentDeps: { roots: ["/tmp"], maxBytes: 25 * 1024 * 1024 },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function callTool(jira: FakeJiraClient, name: string, args: Record<string, unknown>) {
  const { server, client } = await connect(jira);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  await client.close();
  await server.close();
  return { result, payload: parseShaped(result) as Record<string, any> };
}

/** Read a resource by URI, capturing either the contents or the thrown error. */
async function readResource(jira: FakeJiraClient, uri: string) {
  const { server, client } = await connect(jira);
  let result: ReadResourceResult | undefined;
  let error: unknown;
  try {
    result = await client.readResource({ uri });
  } catch (err) {
    error = err;
  }
  await client.close();
  await server.close();
  return { result, error };
}

test("an auth throw during assignee resolution is returned as a shaped auth hint, not a raw error", async () => {
  // searchUsers (called by resolveAssignee, BEFORE create's try/catch) throws 401.
  const jira = new FakeJiraClient();
  jira.searchUsers = async () => {
    throw new JiraApiError(401, ["Client must be authenticated to access this resource."], {});
  };

  const { result, payload } = await callTool(jira, "jira_create_issue", {
    summary: "x",
    assignee: "ghost@x.com",
  });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.join(" ")).toMatch(/JIRA_API_TOKEN|credentials/i);
});

test("a non-auth throw during resolution is returned as a shaped recovery hint", async () => {
  // getProject (called by resolveParent) throws a transient 503.
  const jira = new FakeJiraClient().setIssue(
    // parent existence check passes; the project lookup is what fails.
    { id: "DEF-100", key: "DEF-100", fields: { summary: "Epic" } },
  );
  jira.getProject = async () => {
    throw new JiraApiError(503, ["Service Unavailable"], {});
  };

  const { result, payload } = await callTool(jira, "jira_create_issue", {
    summary: "x",
    parent: "DEF-100",
  });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("jira_http_503");
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

// --- resource reads ---------------------------------------------------------

test("reading jira://projects when the client throws an auth error surfaces the classic-token hint, not a raw leak", async () => {
  // listProjects (the whole resource) throws 401 — the same rejected-credentials
  // failure a tool call would hit at the JiraClient seam (ADR 0002).
  const jira = new FakeJiraClient();
  jira.listProjects = async () => {
    throw new JiraApiError(401, ["Client must be authenticated to access this resource."], {});
  };

  const { result, error } = await readResource(jira, PROJECTS_URI);

  // A failed read is an error, not success-shaped contents.
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(McpError);
  const mcp = error as McpError;

  // The crown-jewel recovery guidance survives into the message the client
  // shows — same fidelity a tool call gets for the identical failure.
  expect(mcp.message).toMatch(/CLASSIC, unscoped Atlassian API token/);
  expect(mcp.message).toMatch(/JIRA_EMAIL and JIRA_API_TOKEN/);

  // ...and the structured shaped payload rides along in `data` for a machine reader.
  const data = mcp.data as { error: { code?: string }; hints: string[] };
  expect(data.error.code).toBe("authentication_failed");
  expect(data.hints.join(" ")).toMatch(/api-tokens/);
});

test("a generic JiraApiError during a resource read is shaped, not leaked raw", async () => {
  // A transient 503 from a non-auth path (link-types here).
  const jira = new FakeJiraClient();
  jira.listIssueLinkTypes = async () => {
    throw new JiraApiError(503, ["Service Unavailable"], {});
  };

  const { result, error } = await readResource(jira, LINK_TYPES_URI);

  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(McpError);
  const mcp = error as McpError;

  expect(mcp.message).toMatch(/rate-limiting or temporarily unavailable/);
  const data = mcp.data as { error: { code?: string }; hints: string[] };
  expect(data.error.code).toBe("jira_http_503");
  expect(data.hints.length).toBeGreaterThan(0);
});
