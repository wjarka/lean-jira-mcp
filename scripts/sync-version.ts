#!/usr/bin/env bun
/**
 * Sync the package.json version into the two other places it lives:
 * manifest.json (the .mcpb bundle manifest) and src/core/server.ts (the
 * version the server advertises over MCP).
 *
 * Wired into `npm version` via the "version" lifecycle script so a bump can't
 * leave them behind; test/packaging.test.ts asserts the three stay equal.
 * Both rewrites are targeted line replacements, not re-serializations, so
 * file formatting is preserved.
 */

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
const version: string = pkg.version;

async function replaceInFile(url: URL, pattern: RegExp, replacement: string): Promise<void> {
  const file = Bun.file(url);
  const text = await file.text();
  if (!pattern.test(text)) {
    console.error(`sync-version: pattern ${pattern} not found in ${url.pathname}`);
    process.exit(1);
  }
  await Bun.write(file, text.replace(pattern, replacement));
}

await replaceInFile(
  new URL("../manifest.json", import.meta.url),
  /^(\s*)"version": "[^"]+",$/m,
  `$1"version": "${version}",`,
);
await replaceInFile(
  new URL("../src/core/server.ts", import.meta.url),
  /version: "[^"]+",/,
  `version: "${version}",`,
);

console.log(`sync-version: ${version} → manifest.json, src/core/server.ts`);
