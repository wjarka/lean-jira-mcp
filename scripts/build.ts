#!/usr/bin/env bun
/**
 * Build the distributable bin.
 *
 * Bundles `src/index.ts` into a single self-contained `dist/index.js` that runs
 * under plain Node — so `npx lean-jira-mcp` and the .mcpb bundle launch the server
 * without Bun on the host. The bundle inlines all dependencies, so the published
 * package / .mcpb needs no runtime `node_modules`.
 *
 * Bun stamps a `#!/usr/bin/env bun` shebang on the entry; we rewrite it to node
 * and mark the file executable so it works as a bin and inside the bundle.
 */

import { chmod, rm } from "node:fs/promises";

const OUT_DIR = "dist";
const OUT_FILE = `${OUT_DIR}/index.js`;

await rm(OUT_DIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: OUT_DIR,
  target: "node",
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

let code = await Bun.file(OUT_FILE).text();
code = `#!/usr/bin/env node\n${code.replace(/^#![^\n]*\n/, "")}`;
await Bun.write(OUT_FILE, code);
await chmod(OUT_FILE, 0o755);

console.error(`built ${OUT_FILE}`);
