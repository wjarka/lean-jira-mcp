/**
 * Server instructions — the session-long ambient channel that grounds the agent
 * in the configured default project (issue 12, group C). Surfaced, never
 * mutating: instructions state the scoping CONVENTION so the agent can decide
 * intent; the server never rewrites a query. With no default configured, the
 * default-project line is absent entirely (nothing is invented).
 *
 * Unit-tested via `buildServerInstructions`, then verified end-to-end: a client
 * connected over the in-memory transport receives them on initialize.
 */

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServerInstructions, createServer, type ServerDeps } from "../src/core/server.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

function deps(projectDefault?: string): ServerDeps {
  return {
    jira: new FakeJiraClient(),
    searchDeps: { projectDefault },
    createIssueDeps: {
      projectDefault,
      baseUrl: "https://acme.atlassian.net",
    },
    updateIssueDeps: {
      baseUrl: "https://acme.atlassian.net",
    },
    commentDeps: { baseUrl: "https://acme.atlassian.net", marker: ":claude:" },
    readAttachmentDeps: { maxBytes: 25 * 1024 * 1024 },
    addAttachmentDeps: { roots: ["/tmp"], maxBytes: 25 * 1024 * 1024 },
  };
}

async function connectedInstructions(serverDeps: ServerDeps): Promise<string | undefined> {
  const server = createServer(serverDeps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const instructions = client.getInstructions();
  await client.close();
  return instructions;
}

test("with a default configured: instructions state the default and the scoping convention", () => {
  const text = buildServerInstructions("PROJ");
  expect(text).toContain("PROJ");
  expect(text.toLowerCase()).toContain("the project");
  // Surfaced, not mutated: it tells the agent to scope, and to ask if ambiguous.
  expect(text).toContain("project = PROJ");
  expect(text.toLowerCase()).toContain("ambiguous");
  // Cross-project intent is explicitly preserved.
  expect(text.toLowerCase()).toContain("cross-project");
});

test("with no default configured: no default-project line is invented", () => {
  const text = buildServerInstructions(undefined);
  expect(text).not.toContain("default project");
  expect(text).not.toMatch(/project = /);
  // The base guidance still ships.
  expect(text.length).toBeGreaterThan(0);
});

test("end-to-end: a connected client receives the default-grounded instructions", async () => {
  const text = await connectedInstructions(deps("PROJ"));
  expect(text).toContain("PROJ");
  expect(text).toContain("project = PROJ");
});

test("end-to-end: with no default, the client's instructions mention no default project", async () => {
  const text = await connectedInstructions(deps(undefined));
  expect(text).toBeTruthy();
  expect(text).not.toContain("default project");
});
