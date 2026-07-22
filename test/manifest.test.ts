/**
 * The .mcpb MCP Bundle manifest (issue 10, AC2 + AC1/AC4 alignment).
 *
 * These tests assert the manifest's config surface lines up with what the config
 * module (`src/config/env.ts`) actually reads — so a one-click Claude Desktop
 * install prompts for exactly the env contract the server validates, and no
 * credential is carried in tool arguments. The env-var set is derived from the
 * config module's source, so adding/removing a config key fails this test until
 * the manifest is updated too (no silent drift).
 */

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/core/server.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

const manifest = (await Bun.file(new URL("../manifest.json", import.meta.url)).json()) as any;

/** Every `JIRA_*` env var the config module reads — the single source of truth. */
async function configEnvVars(): Promise<string[]> {
  const src = await Bun.file(new URL("../src/config/env.ts", import.meta.url)).text();
  return [...new Set([...src.matchAll(/env\.(JIRA_[A-Z0-9_]+)/g)].map((m) => m[1]!))];
}

/** The tool names the server actually registers (via a real in-memory client). */
async function registeredToolNames(): Promise<string[]> {
  const server = createServer({
    jira: new FakeJiraClient(),
    searchDeps: { projectDefault: "DEF" },
    createIssueDeps: {
      projectDefault: "DEF",
      baseUrl: "https://x.atlassian.net",
    },
    updateIssueDeps: {
      baseUrl: "https://x.atlassian.net",
    },
    commentDeps: { baseUrl: "https://x.atlassian.net", marker: ":claude:" },
    readAttachmentDeps: { maxBytes: 25 * 1024 * 1024 },
    addAttachmentDeps: { roots: ["/tmp"], maxBytes: 25 * 1024 * 1024 },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name);
}

test("declares a node stdio server launched via the built bin", () => {
  expect(typeof manifest.manifest_version).toBe("string");
  expect(manifest.server.type).toBe("node");
  expect(manifest.server.entry_point).toBe("dist/index.js");
  expect(manifest.server.mcp_config.command).toBe("node");
  expect(manifest.server.mcp_config.args).toContain("${__dirname}/dist/index.js");
});

test("maps every env var the config module reads to a user_config prompt", async () => {
  const env = manifest.server.mcp_config.env as Record<string, string>;
  for (const name of await configEnvVars()) {
    const value = env[name];
    expect(value).toBeDefined();
    const ref = value!.match(/^\$\{user_config\.([a-z0-9_]+)\}$/);
    expect(ref, `${name} must map to a ${"${user_config.KEY}"} template`).not.toBeNull();
    expect(manifest.user_config[ref![1]!], `user_config.${ref![1]} (for ${name}) is missing`).toBeDefined();
  }
});

test("the three credentials are required, and the API token is sensitive", () => {
  const env = manifest.server.mcp_config.env as Record<string, string>;
  const keyFor = (v: string): string => env[v]!.match(/\$\{user_config\.([a-z0-9_]+)\}/)![1]!;
  for (const cred of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) {
    expect(manifest.user_config[keyFor(cred)].required).toBe(true);
  }
  expect(manifest.user_config[keyFor("JIRA_API_TOKEN")].sensitive).toBe(true);
});

test("optional config is not required and the comment marker defaults to :claude:", () => {
  const env = manifest.server.mcp_config.env as Record<string, string>;
  const keyFor = (v: string): string => env[v]!.match(/\$\{user_config\.([a-z0-9_]+)\}/)![1]!;
  expect(manifest.user_config[keyFor("JIRA_PROJECT_DEFAULT")].required).toBe(false);
  const marker = manifest.user_config[keyFor("JIRA_MCP_COMMENT_MARKER")];
  expect(marker.required).toBe(false);
  expect(marker.default).toBe(":claude:");
});

test("advertises exactly the tools the server registers", async () => {
  const advertised = (manifest.tools as Array<{ name: string }>).map((t) => t.name).sort();
  expect(advertised).toEqual((await registeredToolNames()).sort());
});

test("no user_config prompt is a tool argument — credentials come only from env", () => {
  // Every config key is surfaced as host-managed env, never as a tool input.
  const envValues = Object.values(manifest.server.mcp_config.env as Record<string, string>);
  for (const key of Object.keys(manifest.user_config)) {
    expect(envValues).toContain(`\${user_config.${key}}`);
  }
});
