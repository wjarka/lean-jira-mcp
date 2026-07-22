/**
 * jira_add_attachment handler — driven end-to-end against the faked JiraClient
 * with REAL temp files on disk (the path-scoping/MIME/size logic touches the
 * filesystem, so faking it would test the fake). Asserts on the shaped envelope
 * + hints the agent sees, and on what the seam was actually handed (multipart
 * params: filename, the detected mimeType, the bytes).
 *
 * Covers every acceptance criterion: success + visible hint, multipart params,
 * path-inside-root accepted, outside-root refused, denylist refused, oversize →
 * hint (not 413), MIME from content, dupe-refuse + allowDuplicate opt-in,
 * missing/unreadable path, the JIRA-413 mapping, and the canonical screenshot
 * dir (a host-saved path in the OS temp roots) passing scoping.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addAttachmentHandler,
  type AddAttachmentDeps,
} from "../src/tools/add-attachment.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";
import { JiraApiError, type JiraRestIssue } from "../src/lib/jira-client.ts";
import { parseShaped, type ErrorPayload, type SuccessPayload } from "../src/lib/response-shaper.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let root: string;
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "add-att-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "add-out-")));
  writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
  writeFileSync(path.join(root, "notes.txt"), "hello on disk\n");
  writeFileSync(path.join(root, "lying.txt"), PNG_BYTES); // PNG bytes, .txt name
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "empty.png"), Buffer.alloc(0));
  writeFileSync(path.join(outside, "secret.txt"), "leak");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function deps(over: Partial<AddAttachmentDeps> = {}): AddAttachmentDeps {
  return { roots: [root], maxBytes: 25 * 1024 * 1024, ...over };
}

/** A fake configured with an issue that has the given attachment filenames. */
function clientWithAttachments(filenames: string[]): FakeJiraClient {
  const issue: JiraRestIssue = {
    key: "PROJ-12",
    fields: { attachment: filenames.map((filename, i) => ({ id: String(i + 1), filename, size: 10 })) },
  };
  return new FakeJiraClient().setIssueResponder(() => issue);
}

test("uploads a file via the seam and returns {id, filename, size, mimeType} + a visible hint", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "shot.png") },
    deps(),
  );
  expect(res.isError).toBeUndefined();
  const payload = parseShaped<SuccessPayload>(res);
  expect(payload.id).toBe("att-1");
  expect(payload.filename).toBe("shot.png");
  expect(payload.size).toBe(PNG_BYTES.length);
  expect(payload.mimeType).toBe("image/png");
  expect(payload.issueKey).toBe("PROJ-12");
  // Outward-facing: the hint names file, size, type, destination + visibility.
  expect(payload.hints[0]).toContain("shot.png");
  expect(payload.hints[0]).toContain("PROJ-12");
  expect(payload.hints[0]).toMatch(/visible/i);

  // The seam was handed the multipart params: filename, detected mime, the bytes.
  expect(jira.addAttachmentCalls).toHaveLength(1);
  const call = jira.addAttachmentCalls[0]!;
  expect(call.issueKey).toBe("PROJ-12");
  expect(call.filename).toBe("shot.png");
  expect(call.mimeType).toBe("image/png");
  expect(call.data.equals(PNG_BYTES)).toBe(true);
});

test("MIME is detected from CONTENT, not the extension", async () => {
  const jira = clientWithAttachments([]);
  await addAttachmentHandler(jira, { issueKey: "PROJ-12", path: path.join(root, "lying.txt") }, deps());
  // .txt name, but PNG bytes → image/png sent to JIRA.
  expect(jira.addAttachmentCalls[0]!.mimeType).toBe("image/png");
});

test("a path outside all roots is refused with a recovery hint (no upload)", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(outside, "secret.txt") },
    deps(),
  );
  expect(res.isError).toBe(true);
  const payload = parseShaped<ErrorPayload>(res);
  expect(payload.error.code).toBe("path_outside_root");
  expect(payload.hints[0]).toMatch(/exfiltrat|outside|root/i);
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("a denylisted sensitive file inside a root is refused (no upload)", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, ".env") },
    deps(),
  );
  expect(res.isError).toBe(true);
  expect(parseShaped<ErrorPayload>(res).error.code).toBe("path_denylisted");
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("a file over the size cap returns a hint, not a raw 413 (no upload)", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "shot.png") },
    deps({ maxBytes: 4 }), // PNG is bigger than 4 bytes
  );
  expect(res.isError).toBe(true);
  const payload = parseShaped<ErrorPayload>(res);
  expect(payload.error.code).toBe("attachment_too_large");
  expect(payload.hints[0]).toMatch(/cap|reduce|limit/i);
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("a same-name collision is refused with the documented hint unless allowDuplicate", async () => {
  const jira = clientWithAttachments(["shot.png"]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "shot.png") },
    deps(),
  );
  expect(res.isError).toBe(true);
  const payload = parseShaped<ErrorPayload>(res);
  expect(payload.error.code).toBe("duplicate_attachment");
  expect(payload.hints[0]).toContain("allowDuplicate:true");
  expect(payload.hints[0]).toContain("shot.png");
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("allowDuplicate:true adds a second copy (skips the dupe check, uploads)", async () => {
  const jira = clientWithAttachments(["shot.png"]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "shot.png"), allowDuplicate: true },
    deps(),
  );
  expect(res.isError).toBeUndefined();
  expect(jira.addAttachmentCalls).toHaveLength(1);
  // No dupe-check getIssue call was made when allowDuplicate is set.
  expect(jira.getIssueCalls).toHaveLength(0);
});

test("an empty (0-byte) file is refused with a hint, never uploaded", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "empty.png") },
    deps(),
  );
  expect(res.isError).toBe(true);
  expect(parseShaped<ErrorPayload>(res).error.code).toBe("attachment_empty");
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("the duplicate check runs BEFORE the file is read (refused dupe does no upload)", async () => {
  // Reorder guard: a dupe refusal should consult getIssue and skip the upload.
  const jira = clientWithAttachments(["shot.png"]);
  await addAttachmentHandler(jira, { issueKey: "PROJ-12", path: path.join(root, "shot.png") }, deps());
  expect(jira.getIssueCalls).toHaveLength(1); // dupe check happened
  expect(jira.addAttachmentCalls).toHaveLength(0); // upload skipped
});

test("a missing path returns a specific recovery hint mentioning on-disk requirement", async () => {
  const jira = clientWithAttachments([]);
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "ghost.png") },
    deps(),
  );
  expect(res.isError).toBe(true);
  const payload = parseShaped<ErrorPayload>(res);
  expect(payload.error.code).toBe("path_not_found");
  expect(payload.hints[0]).toMatch(/on disk|context|save/i);
  expect(jira.addAttachmentCalls).toHaveLength(0);
});

test("a JIRA 413 on upload is mapped to a size hint, not surfaced raw", async () => {
  const jira = clientWithAttachments([]);
  jira.setAddAttachmentError(new JiraApiError(413, ["Attachment too large"], {}));
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: path.join(root, "shot.png") },
    deps(),
  );
  expect(res.isError).toBe(true);
  const payload = parseShaped<ErrorPayload>(res);
  expect(payload.error.code).toBe("attachment_too_large");
  expect(payload.hints[0]).toMatch(/instance|limit|reduce/i);
});

test("a 404 issue on the dupe check is mapped to an issue-not-found hint", async () => {
  // Default getIssueResponder throws 404.
  const jira = new FakeJiraClient();
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "NOPE-1", path: path.join(root, "shot.png") },
    deps(),
  );
  expect(res.isError).toBe(true);
  expect(parseShaped<ErrorPayload>(res).error.code).toBe("issue_not_found");
});

test("a host-saved file in the OS temp root passes scoping under the defaults", async () => {
  // Simulate host tooling saving a file into the OS temp dir, which is a
  // DEFAULT root — agent-produced files landing there must be accepted.
  const shotDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hostsave-")));
  const shot = path.join(shotDir, "capture.png");
  writeFileSync(shot, PNG_BYTES);
  const jira = clientWithAttachments([]);
  const { defaultAttachmentRoots } = await import("../src/lib/attachment-path.ts");
  const res = await addAttachmentHandler(
    jira,
    { issueKey: "PROJ-12", path: shot },
    { roots: defaultAttachmentRoots(), maxBytes: 25 * 1024 * 1024 },
  );
  expect(res.isError).toBeUndefined();
  expect(jira.addAttachmentCalls[0]!.mimeType).toBe("image/png");
  rmSync(shotDir, { recursive: true, force: true });
});
