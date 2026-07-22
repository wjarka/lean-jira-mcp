/**
 * Unit tests for the shared comment serializer.
 *
 * `jira_get_issue` renders preview comments through this; `jira_get_comments`
 * renders full threads through the same serializer. Slice 08 brings it to its
 * final shape: every serialized comment now carries `authoredBy`, derived
 * server-side from the `mcp.origin` property (primary) with a marker fallback.
 */

import { test, expect } from "bun:test";
import { serializeComment } from "../src/lib/comment-serializer.ts";

const MARKER = ":claude:";

function adfBody(textValue: string) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: textValue }] }] };
}

test("serializes id, author display name, authoredBy, created, and markdown body", () => {
  const out = serializeComment(
    {
      id: "10001",
      author: { displayName: "Jane Doe", accountId: "acc-1" },
      body: adfBody("Looks good **to me**"),
      created: "2026-06-10T09:00:00.000+0000",
    },
    { marker: MARKER },
  );
  expect(out).toEqual({
    id: "10001",
    author: "Jane Doe",
    authoredBy: "human",
    created: "2026-06-10T09:00:00.000+0000",
    body: "Looks good **to me**",
  });
});

test("includes updated only when it differs from created", () => {
  const edited = serializeComment(
    {
      id: "1",
      author: { displayName: "A" },
      body: adfBody("x"),
      created: "2026-06-10T09:00:00.000+0000",
      updated: "2026-06-11T09:00:00.000+0000",
    },
    { marker: MARKER },
  );
  expect(edited.updated).toBe("2026-06-11T09:00:00.000+0000");

  const unedited = serializeComment(
    {
      id: "2",
      author: { displayName: "A" },
      body: adfBody("x"),
      created: "2026-06-10T09:00:00.000+0000",
      updated: "2026-06-10T09:00:00.000+0000",
    },
    { marker: MARKER },
  );
  expect(unedited.updated).toBeUndefined();
});

test("authoredBy is `agent` when the mcp.origin property is present", () => {
  const out = serializeComment(
    {
      id: "1",
      author: { displayName: "A" },
      body: adfBody("no marker in the body"),
      created: "2026-06-10T09:00:00.000+0000",
      properties: [{ key: "mcp.origin", value: { authoredBy: "agent" } }],
    },
    { marker: MARKER },
  );
  expect(out.authoredBy).toBe("agent");
});

test("authoredBy falls back to the configured marker, then legacy :claude:, for pre-property comments", () => {
  const configured = serializeComment(
    { id: "1", author: { displayName: "A" }, body: adfBody(":robot: shipped it"), created: "c" },
    { marker: ":robot:" },
  );
  expect(configured.authoredBy).toBe("agent");

  // Operator reconfigured the marker, but legacy history still reads as agent.
  const legacy = serializeComment(
    { id: "2", author: { displayName: "A" }, body: adfBody(":claude: old note"), created: "c" },
    { marker: ":robot:" },
  );
  expect(legacy.authoredBy).toBe("agent");
});

test("authoredBy is `unknown` when JIRA returned no author and no agent signal", () => {
  const out = serializeComment(
    { id: "1", author: null, body: adfBody("orphaned"), created: "c" },
    { marker: MARKER },
  );
  expect(out.authoredBy).toBe("unknown");
});

test("body is markdown, never raw ADF", () => {
  const out = serializeComment(
    { id: "1", author: { displayName: "A" }, body: adfBody("hello"), created: "c" },
    { marker: MARKER },
  );
  expect(out.body).toBe("hello");
  expect(JSON.stringify(out)).not.toContain('"type"');
});

test("missing author degrades to null without throwing", () => {
  const out = serializeComment(
    { id: "1", body: adfBody("x"), created: "c" },
    { marker: MARKER },
  );
  expect(out.author).toBeNull();
});

// --- preview snippets (opt-in; the only truncation in the comment surfaces) ---

test("preview snips a long body to a snippet and flags bodyClipped; full mode never does", () => {
  const long = "first line " + "tail ".repeat(200);

  const preview = serializeComment(
    { id: "1", author: { displayName: "A" }, body: adfBody(long), created: "c" },
    { marker: MARKER, preview: true },
  );
  expect(preview.body.length).toBeLessThan(long.length);
  expect(preview.bodyClipped).toBe(true);

  const full = serializeComment(
    { id: "1", author: { displayName: "A" }, body: adfBody(long), created: "c" },
    { marker: MARKER },
  );
  expect(full.body).toBe(long.trimEnd());
  expect(full.bodyClipped).toBeUndefined();
});

test("preview leaves a short body intact and unflagged, preserving the marker", () => {
  const out = serializeComment(
    { id: "1", author: { displayName: "A" }, body: adfBody(":claude: shipped it"), created: "c" },
    { marker: MARKER, preview: true },
  );
  expect(out.body).toBe(":claude: shipped it");
  expect(out.bodyClipped).toBeUndefined();
});

test("preview still resolves authoredBy for a clipped comment (property-stamped)", () => {
  // A clipped snippet must not lose authorship: the property is read off the raw
  // comment, independent of how much of the body is emitted.
  const long = "agent wrote a very long note " + "detail ".repeat(200);
  const out = serializeComment(
    {
      id: "1",
      author: { displayName: "Current User" },
      body: adfBody(long),
      created: "c",
      properties: [{ key: "mcp.origin", value: { authoredBy: "agent" } }],
    },
    { marker: MARKER, preview: true },
  );
  expect(out.bodyClipped).toBe(true);
  expect(out.authoredBy).toBe("agent");
});
