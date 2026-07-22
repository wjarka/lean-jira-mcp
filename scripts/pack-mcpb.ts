#!/usr/bin/env bun
/**
 * Pack the .mcpb MCP Bundle for one-click Claude Desktop install.
 *
 * A .mcpb file is a zip of `manifest.json` + the server payload. Because the bin
 * is a single self-contained bundle, the payload is just `dist/index.js` (no
 * node_modules). Claude Desktop unpacks the bundle and runs
 * `node <bundle>/dist/index.js` with the user_config values injected as env.
 *
 * Run `bun run build` first. For schema validation against the official spec:
 *   npx -y @anthropic-ai/mcpb validate manifest.json
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { $ } from "bun";

const STAGE = "build/mcpb";
const BUNDLE = "dist/lean-jira-mcp.mcpb";

if (!(await Bun.file("dist/index.js").exists())) {
  console.error("dist/index.js missing — run `bun run build` first.");
  process.exit(1);
}

await rm(STAGE, { recursive: true, force: true });
await mkdir(`${STAGE}/dist`, { recursive: true });
await cp("manifest.json", `${STAGE}/manifest.json`);
await cp("dist/index.js", `${STAGE}/dist/index.js`);

await rm(BUNDLE, { force: true });
const out = `${process.cwd()}/${BUNDLE}`;
await $`cd ${STAGE} && zip -qr -X ${out} manifest.json dist`;

console.error(`packed ${BUNDLE}`);
