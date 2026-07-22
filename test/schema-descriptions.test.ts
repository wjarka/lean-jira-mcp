/**
 * Verification of SDK issue #1143: zod `.describe()` field descriptions must
 * render in the emitted tool input schema. This is the automated equivalent of
 * the MCP Inspector check — `client.listTools()` issues the same `tools/list`
 * request the Inspector does, so what it returns here is exactly what the
 * Inspector would display. The whole design leans on description quality, so
 * this guards the pattern before more tools are built on it.
 */

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/core/server.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

async function listTools() {
  const server = createServer({
    jira: new FakeJiraClient(),
    searchDeps: {},
    createIssueDeps: {
      baseUrl: "https://example.atlassian.net",
    },
    updateIssueDeps: {
      baseUrl: "https://example.atlassian.net",
    },
    commentDeps: { baseUrl: "https://example.atlassian.net", marker: ":claude:" },
    readAttachmentDeps: { maxBytes: 25 * 1024 * 1024 },
    addAttachmentDeps: { roots: ["/tmp"], maxBytes: 25 * 1024 * 1024 },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

test("jira_search is registered with a description", async () => {
  const tools = await listTools();
  const search = tools.find((t) => t.name === "jira_search");
  expect(search).toBeDefined();
  expect(search?.description).toBeTruthy();
});

test("zod .describe() field descriptions render in the emitted input schema (#1143)", async () => {
  const tools = await listTools();
  const search = tools.find((t) => t.name === "jira_search");
  const props = (search?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;

  expect(props).toBeDefined();
  // Every documented field must carry its description through to the schema.
  for (const field of ["jql", "fields", "limit", "cursor", "includeCount"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }
  expect(props?.jql?.description).toContain("JQL");
  expect(props?.cursor?.description).toContain("VERBATIM");
});

test("required fields are reflected in the schema", async () => {
  const tools = await listTools();
  const search = tools.find((t) => t.name === "jira_search");
  const required = (search?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).toContain("jql");
});

test("jira_get_issue is registered with field descriptions and a required issueKey (#1143)", async () => {
  const tools = await listTools();
  const getIssue = tools.find((t) => t.name === "jira_get_issue");
  expect(getIssue?.description).toBeTruthy();

  const props = (getIssue?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  for (const field of ["issueKey", "detail", "fields", "comments"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }

  const required = (getIssue?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).toContain("issueKey");
});

test("jira_create_issue is registered with field descriptions and a required summary (#1143)", async () => {
  const tools = await listTools();
  const create = tools.find((t) => t.name === "jira_create_issue");
  expect(create?.description).toBeTruthy();

  const props = (create?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  for (const field of ["summary", "project", "issuetype", "description", "assignee", "parent", "sprint"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }

  const required = (create?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).toContain("summary");
});

test("jira_comment is registered with field descriptions and a required issueKey + body (#1143)", async () => {
  const tools = await listTools();
  const comment = tools.find((t) => t.name === "jira_comment");
  expect(comment?.description).toBeTruthy();

  const props = (comment?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  for (const field of ["issueKey", "body", "commentId", "visibility"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }

  const required = (comment?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).toContain("issueKey");
  expect(required).toContain("body");
});

test("jira_describe_project is registered with field descriptions and no required fields (#1143)", async () => {
  const tools = await listTools();
  const describe = tools.find((t) => t.name === "jira_describe_project");
  expect(describe?.description).toBeTruthy();

  const props = (describe?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  for (const field of ["projectKey", "issueType"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }

  // projectKey is now optional: omitting it is tier-0 (the project catalog).
  const required = (describe?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).not.toContain("projectKey");
  expect(required).not.toContain("issueType");
});

test("jira_transition is registered with field descriptions and a required issueKey + transition (#1143)", async () => {
  const tools = await listTools();
  const transition = tools.find((t) => t.name === "jira_transition");
  expect(transition?.description).toBeTruthy();

  const props = (transition?.inputSchema as { properties?: Record<string, { description?: string }> })
    .properties;
  for (const field of ["issueKey", "transition", "fields"]) {
    expect(props?.[field]?.description, `${field} should have a description`).toBeTruthy();
  }

  const required = (transition?.inputSchema as { required?: string[] }).required ?? [];
  expect(required).toContain("issueKey");
  expect(required).toContain("transition");
  expect(required).not.toContain("fields");
});
