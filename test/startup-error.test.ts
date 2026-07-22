/**
 * Missing/invalid credentials produce a clear startup error, not a silent
 * failure or a hang (issue 10, AC4).
 *
 * Drives the real entry point as a process with no JIRA_* env vars and an empty
 * cwd (so Bun auto-loads no `.env`), then asserts it exits non-zero and names
 * the missing variable on stderr — the same fail-fast path both install channels
 * launch through.
 */

import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("launching without credentials exits non-zero and names the missing var", async () => {
  const entry = new URL("../src/index.ts", import.meta.url).pathname;
  const cwd = await mkdtemp(join(tmpdir(), "lean-jira-mcp-startup-"));

  const proc = Bun.spawn(["bun", entry], {
    cwd, // empty dir → no .env auto-load
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, // no JIRA_*
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("JIRA_BASE_URL");
});
