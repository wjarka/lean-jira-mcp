/**
 * Packaging & distribution surface (issue 10).
 *
 * - The npx-able bin points at the Bun-built bundle, and a build step exists so
 *   the server launches from a client config without a manual build (AC1/AC2).
 * - No tool exposes a credential-shaped argument — auth is env-only (AC1).
 * - The README documents every env var the config module reads, plus a client
 *   config snippet for both install paths (AC3).
 */

import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/core/server.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as any;
const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();

async function configEnvVars(): Promise<string[]> {
  const src = await Bun.file(new URL("../src/config/env.ts", import.meta.url)).text();
  return [...new Set([...src.matchAll(/env\.(JIRA_[A-Z0-9_]+)/g)].map((m) => m[1]!))];
}

test("the version is one value in three places: package.json, manifest.json, server identity", async () => {
  // `npm version` bumps only package.json; the "version" lifecycle script
  // (scripts/sync-version.ts) rewrites the other two. This pins the sync so a
  // manual edit or a non-npm bump can't ship a bundle that advertises the
  // wrong version.
  const manifest = (await Bun.file(new URL("../manifest.json", import.meta.url)).json()) as any;
  expect(manifest.version).toBe(pkg.version);
  const serverSrc = await Bun.file(new URL("../src/core/server.ts", import.meta.url)).text();
  expect(serverSrc).toContain(`version: "${pkg.version}",`);
});

test("the bin is the Bun-built bundle, with a build step to produce it", () => {
  expect(pkg.bin["lean-jira-mcp"]).toBe("./dist/index.js");
  expect(pkg.scripts.build).toMatch(/scripts\/build\.ts/);
  // The published tarball must ship the built bundle + manifest so npx works.
  expect(pkg.files).toContain("dist");
  expect(pkg.files).toContain("manifest.json");
  expect(pkg.engines?.node).toBeDefined();
});

test("no tool exposes a credential-shaped argument (auth is env-only)", async () => {
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

  const forbidden = /token|password|secret|credential|baseurl|apikey/i;
  for (const tool of tools) {
    const props = Object.keys((tool.inputSchema as any)?.properties ?? {});
    for (const prop of props) {
      expect(forbidden.test(prop), `${tool.name}.${prop} looks credential-shaped`).toBe(false);
    }
  }
});

test("README documents every env var the config module reads", async () => {
  for (const name of await configEnvVars()) {
    expect(readme.includes(name), `README must document ${name}`).toBe(true);
  }
});

test("README shows a client config for both install paths (npx and .mcpb)", () => {
  expect(readme).toMatch(/npx/);
  expect(readme).toMatch(/\.mcpb/);
});
