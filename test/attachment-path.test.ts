/**
 * resolveAttachmentPath — the security guardrail for jira_add_attachment.
 *
 * Exercised against the REAL filesystem (temp dirs/files/symlinks) rather than a
 * seam, because the whole point is correct realpath/symlink/`..` resolution and
 * root containment — a faked fs would test the fake, not the guardrail.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAttachmentPath, canonicalizeRoots, defaultAttachmentRoots } from "../src/lib/attachment-path.ts";

let root: string; // an allowed root
let outside: string; // a dir OUTSIDE every root
let roots: string[];

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "att-root-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "att-out-")));
  roots = [root];
  writeFileSync(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "doc.txt"), "hi");
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "id_rsa"), "-----BEGIN-----");
  writeFileSync(path.join(root, "prod.pem"), "-----BEGIN-----");
  writeFileSync(path.join(outside, "secret.txt"), "leak");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("accepts a regular file inside an allowed root, reporting filename + size", () => {
  const r = resolveAttachmentPath(path.join(root, "shot.png"), roots);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.filename).toBe("shot.png");
    expect(r.size).toBe(4);
    expect(r.canonicalPath).toBe(path.join(root, "shot.png"));
  }
});

test("accepts a nested file under a root", () => {
  const r = resolveAttachmentPath(path.join(root, "sub", "doc.txt"), roots);
  expect(r.ok).toBe(true);
});

test("refuses a path outside all roots", () => {
  const r = resolveAttachmentPath(path.join(outside, "secret.txt"), roots);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("outside_root");
});

test("refuses a `..` traversal that escapes the root", () => {
  // root/../<outsideBasename>/secret.txt resolves outside the root.
  const escape = path.join(root, "..", path.basename(outside), "secret.txt");
  const r = resolveAttachmentPath(escape, roots);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("outside_root");
});

test("refuses a symlink (inside a root) whose target is outside the root", () => {
  const link = path.join(root, "innocent.png");
  symlinkSync(path.join(outside, "secret.txt"), link);
  const r = resolveAttachmentPath(link, roots);
  expect(r.ok).toBe(false);
  // realpath points outside the root → outside_root (the symlink can't smuggle).
  if (!r.ok) expect(r.reason).toBe("outside_root");
  rmSync(link, { force: true });
});

test("denylists dotfiles even inside an allowed root", () => {
  const r = resolveAttachmentPath(path.join(root, ".env"), roots);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("denylisted");
});

test("denylists key material (id_rsa, *.pem) inside a root", () => {
  expect(resolveAttachmentPath(path.join(root, "id_rsa"), roots).ok).toBe(false);
  const pem = resolveAttachmentPath(path.join(root, "prod.pem"), roots);
  expect(pem.ok).toBe(false);
  if (!pem.ok) expect(pem.reason).toBe("denylisted");
});

test("the ~/.ssh/id_rsa exfil vector is refused (outside default roots)", () => {
  // Not created on disk — but it must NOT resolve as ok against the defaults.
  const r = resolveAttachmentPath("~/.ssh/id_rsa", defaultAttachmentRoots());
  expect(r.ok).toBe(false);
});

test("reports not_found for a missing path", () => {
  const r = resolveAttachmentPath(path.join(root, "nope.png"), roots);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("not_found");
});

test("refuses a directory (not a regular file)", () => {
  const r = resolveAttachmentPath(path.join(root, "sub"), roots);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("not_file");
});

test("defaultAttachmentRoots includes cwd and a temp dir, but NOT ~/Downloads", () => {
  const defaults = defaultAttachmentRoots();
  expect(defaults).toContain(realpathSync(process.cwd()));
  // At least one temp root present (os.tmpdir or /tmp realpath).
  const tmp = realpathSync(tmpdir());
  expect(defaults.some((r) => r === tmp || r === "/private/tmp" || r === "/tmp")).toBe(true);
  // ~/Downloads must be opt-in via JIRA_ATTACHMENT_ROOT: a default reaching into
  // $HOME turns a prompt-injected path into an exfiltration channel (ADR 0009).
  expect(defaults.some((r) => r.endsWith(`${path.sep}Downloads`))).toBe(false);
});

test("canonicalizeRoots resolves symlinked roots and dedupes", () => {
  // /tmp → /private/tmp on macOS; canonicalization should match realpath.
  const out = canonicalizeRoots([root, root]);
  expect(out).toEqual([root]); // deduped
});

test("a not-yet-existing root is canonicalized through its nearest existing ancestor", () => {
  // A configured root that doesn't exist yet, under a symlinked ancestor: it
  // must canonicalize via the existing parent so a file created there later
  // (which realpaths to the canonical prefix) is accepted, not wrongly refused.
  const missing = path.join(root, "not-created-yet");
  const [canon] = canonicalizeRoots([missing]);
  // `root` is already realpath'd; the missing tail is appended to it verbatim.
  expect(canon).toBe(missing);

  // Now actually create it + a file, and confirm scoping accepts the file.
  mkdirSync(missing, { recursive: true });
  writeFileSync(path.join(missing, "later.png"), Buffer.from([0x89, 0x50]));
  const r = resolveAttachmentPath(path.join(missing, "later.png"), [canon!]);
  expect(r.ok).toBe(true);
  rmSync(missing, { recursive: true, force: true });
});
