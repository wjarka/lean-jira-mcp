/**
 * jira_get_issue handler, driven end-to-end against the faked JiraClient.
 * Asserts on the shaped MCP response the agent sees — never on internals.
 */

import { test, expect } from "bun:test";
import { getIssueHandler, getIssueInputSchema } from "../src/tools/get-issue.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { DEFAULT_CURATED_FIELD_IDS } from "../src/lib/custom-fields.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import {
  FakeJiraClient,
  adfDoc,
  makeComment,
  makeCommentField,
  makeIssueLink,
  makeSubtask,
  makeAttachment,
  notFoundError,
  authError,
  originProperty,
} from "./helpers/fake-jira-client.ts";

const SP = DEFAULT_CURATED_FIELD_IDS.storyPoints;
const SPRINT = DEFAULT_CURATED_FIELD_IDS.sprint;
const EPIC = DEFAULT_CURATED_FIELD_IDS.epicLink;

async function run(jira: FakeJiraClient, raw: Record<string, unknown>) {
  const args = getIssueInputSchema.parse(raw);
  const result = await getIssueHandler(jira, args);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

/** A fully-populated issue for the detail/full tests. */
function fullIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    key: "ABC-1",
    fields: {
      summary: "Implement the widget",
      status: { name: "In Progress" },
      issuetype: { name: "Story" },
      priority: { name: "High" },
      assignee: { displayName: "Alice Smith", accountId: "acc-1" },
      labels: ["backend"],
      updated: "2026-06-10T09:00:00.000+0000",
      description: adfDoc("First paragraph.", "Second paragraph."),
      [SP]: 5,
      [SPRINT]: [{ id: 9, name: "Sprint 9", state: "active" }],
      [EPIC]: "ABC-100",
      issuelinks: [makeIssueLink({ direction: "inward", key: "ABC-2", summary: "Blocker" })],
      subtasks: [makeSubtask({ key: "ABC-3", summary: "A subtask" })],
      comment: makeCommentField([
        makeComment({ id: "1", body: "oldest" }),
        makeComment({ id: "2", body: "middle" }),
        makeComment({ id: "3", body: "newer" }),
        makeComment({ id: "4", body: "newest" }),
      ]),
      ...overrides,
    },
  };
}

// --- summary --------------------------------------------------------------

test("summary returns the card fields, story points, counts, and a flattened description", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1" });

  expect(payload).toMatchObject({
    key: "ABC-1",
    summary: "Implement the widget",
    status: "In Progress",
    type: "Story",
    priority: "High",
    assignee: "Alice Smith",
    labels: ["backend"],
    storyPoints: 5,
    counts: { comments: 4, links: 1, subtasks: 1 },
  });
  expect(payload.description).toContain("First paragraph.");
  // Summary is lean: no link/subtask bodies, no curated sprint/epic.
  expect(payload.links).toBeUndefined();
  expect(payload.subtasks).toBeUndefined();
  expect(payload.sprint).toBeUndefined();
});

test("summary defaults comments to none — only a count, no comment bodies", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.comments).toBeUndefined();
  expect(payload.counts.comments).toBe(4);
});

test("an over-budget description is truncated at a paragraph boundary with a size-aware hint", async () => {
  const big = "word ".repeat(600); // ~750 tokens, over the ~450 budget
  const jira = new FakeJiraClient().setIssue(
    fullIssue({ description: adfDoc(big.trim(), "second tail paragraph") }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1" });

  expect(payload.descriptionTruncated).toBe(true);
  expect(payload.description).not.toContain("second tail paragraph"); // cut at boundary
  const hint = payload.hints.join(" ");
  expect(hint.toLowerCase()).toContain("truncat");
  expect(hint).toContain("omitted");
  expect(hint).toContain("full");
});

test("a short description is not truncated", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue({ description: adfDoc("tiny") }));
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.descriptionTruncated).toBe(false);
  expect(payload.description).toBe("tiny");
});

// --- attachments (discovery rides get_issue) ------------------------------

const ATTACHMENTS = [
  makeAttachment({ id: "10042", filename: "screenshot.png", mimeType: "image/png", size: 12345 }),
  makeAttachment({ id: "10043", filename: "spec.pdf", mimeType: "application/pdf", size: 99999 }),
  makeAttachment({ id: "10044", filename: "notes.txt", mimeType: "text/plain", size: 256 }),
];

test("summary shows an attachment count, not the list", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue({ attachment: ATTACHMENTS }));
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.counts.attachments).toBe(3);
  expect(payload.attachments).toBeUndefined();
  // And the agent is told how to see the list + read one.
  expect(payload.hints.join(" ")).toContain('detail:"full"');
});

test("summary attachment count is 0 when the issue has none", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.counts.attachments).toBe(0);
});

test("full returns the attachment list with id, filename, mimeType, size, created, author", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue({ attachment: ATTACHMENTS }));
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });

  expect(payload.attachments).toEqual([
    {
      id: "10042",
      filename: "screenshot.png",
      mimeType: "image/png",
      size: 12345,
      created: "2026-06-20T08:00:00.000+0000",
      author: "Jane Doe",
    },
    {
      id: "10043",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      size: 99999,
      created: "2026-06-20T08:00:00.000+0000",
      author: "Jane Doe",
    },
    {
      id: "10044",
      filename: "notes.txt",
      mimeType: "text/plain",
      size: 256,
      created: "2026-06-20T08:00:00.000+0000",
      author: "Jane Doe",
    },
  ]);
  expect(payload.hints.join(" ")).toContain("jira_read_attachment");
});

test("get_issue requests the attachment field from JIRA", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue({ attachment: ATTACHMENTS }));
  await run(jira, { issueKey: "ABC-1", detail: "full" });
  expect(jira.getIssueCalls[0]!.fields).toContain("attachment");
});

// --- full -----------------------------------------------------------------

test("full returns untruncated description, links, subtasks, last 3 comments, and curated agile fields", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });

  expect(payload.description).toContain("First paragraph.");
  expect(payload.description).toContain("Second paragraph.");
  expect(payload.storyPoints).toBe(5);
  expect(payload.sprint).toBe("Sprint 9");
  expect(payload.epicLink).toBe("ABC-100");

  expect(payload.links).toEqual([
    { relationship: "is blocked by", key: "ABC-2", summary: "Blocker", status: "To Do" },
  ]);
  expect(payload.subtasks).toEqual([{ key: "ABC-3", summary: "A subtask", status: "To Do" }]);

  // auto-recent on full: last 3 of 4 comments, oldest dropped.
  expect(payload.comments.map((c: any) => c.id)).toEqual(["2", "3", "4"]);
  expect(payload.commentCount).toBe(4);
});

test("full auto-upgrades comments to recent and hints that older ones exist", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });
  expect(payload.comments).toHaveLength(3);
  expect(payload.hints.join(" ")).toContain("jira_get_comments");
});

test("full view that already contains the whole thread does NOT point at jira_get_comments", async () => {
  // 2 comments, all shown in full — re-fetching via jira_get_comments would
  // return the identical thread, so don't suggest it.
  const jira = new FakeJiraClient().setIssue(
    fullIssue({
      comment: makeCommentField([
        makeComment({ id: "1", body: "first" }),
        makeComment({ id: "2", body: "second" }),
      ]),
    }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });
  expect(payload.comments).toHaveLength(2);
  expect(payload.commentCount).toBe(2);
  expect(payload.hints.join(" ")).not.toContain("jira_get_comments");
});

// --- comments knob --------------------------------------------------------

test("comments:recent on a summary returns the last 3 as a preview", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["2", "3", "4"]);
});

test("comments:recent on a COMPLETE inline thread slices inline — no extra comment fetch", async () => {
  // total (4) is covered by the inline page (4), so its tail already is the
  // newest 3: the fix must NOT spend a dedicated-endpoint call here.
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["2", "3", "4"]);
  expect(jira.getCommentsCalls).toHaveLength(0);
});

test("comments:recent on a thread longer than the inline page surfaces the NEWEST comments, not the oldest-page tail", async () => {
  // The bug: the inline comment field is a bounded FIRST page (oldest-first), so
  // slicing its tail surfaces the oldest comments mislabeled as newest. With a
  // 250-comment thread whose inline page holds only the first 5, the newest 3
  // are 248–250 — never 3–5 (the tail of the oldest inline page). One agent
  // comment among the newest carries an origin property so authorship resolves
  // property-first through the dedicated fetch (the inline page has none).
  const thread = Array.from({ length: 250 }, (_, i) => {
    const id = String(i + 1);
    return id === "249"
      ? makeComment({ id, author: "Current User", body: "agent update", properties: [originProperty()] })
      : makeComment({ id, body: `comment ${id}` });
  });
  const jira = new FakeJiraClient()
    .setIssue(fullIssue({ comment: makeCommentField(thread.slice(0, 5) as any, 250) }))
    .setCommentThread(thread as any);

  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });

  expect(payload.comments.map((c: any) => c.id)).toEqual(["248", "249", "250"]);
  const byId = Object.fromEntries(payload.comments.map((c: any) => [c.id, c.authoredBy]));
  expect(byId["249"]).toBe("agent"); // property-first authorship via the newest-page fetch
  expect(payload.commentCount).toBe(250);
  expect(payload.hints.join(" ")).toContain("Showing 3 of 250");

  // Exactly ONE dedicated-endpoint call, aimed at the last page (newest N).
  expect(jira.getCommentsCalls).toHaveLength(1);
  const call = jira.getCommentsCalls[0]!;
  expect(call.startAt).toBe(247); // max(0, 250 - 3)
  expect(call.maxResults).toBe(3);
  expect(call.orderBy).toBe("created");
  expect(call.expand).toContain("properties");
});

test("detail:full auto-recent on a long thread also surfaces the newest comments", async () => {
  // The auto-upgrade under detail:"full" rides the same path, so it must fetch
  // the real newest N rather than slice the bounded inline page.
  const thread = Array.from({ length: 120 }, (_, i) => makeComment({ id: String(i + 1), body: `c${i + 1}` }));
  const jira = new FakeJiraClient()
    .setIssue(fullIssue({ comment: makeCommentField(thread.slice(0, 10) as any, 120) }))
    .setCommentThread(thread as any);

  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });

  expect(payload.comments.map((c: any) => c.id)).toEqual(["118", "119", "120"]);
  expect(payload.commentCount).toBe(120);
  expect(payload.hints.join(" ")).toContain("Showing 3 of 120");
});

test("comments:recent degrades to the inline tail when the newest-page fetch fails", async () => {
  // A partial inline page with a follow-up that errors must not fail get_issue:
  // fall back to the inline tail (best-effort) rather than crash or show nothing.
  const inline = [
    makeComment({ id: "1", body: "first" }),
    makeComment({ id: "2", body: "second" }),
    makeComment({ id: "3", body: "third" }),
    makeComment({ id: "4", body: "fourth" }),
  ];
  const jira = new FakeJiraClient()
    .setIssue(fullIssue({ comment: makeCommentField(inline as any, 90) }))
    .setGetCommentsError(new JiraApiError(503, ["Service Unavailable"], {}));

  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });

  expect(payload.comments.map((c: any) => c.id)).toEqual(["2", "3", "4"]); // inline tail
  expect(payload.commentCount).toBe(90);
  expect(payload.hints.join(" ")).toContain("Showing 3 of 90");
});

test("preview comments are markdown and carry authoredBy via the shared serializer", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });
  const comment = payload.comments[0];
  expect(comment.body).toBe("middle");
  // The retrofit: every preview comment now carries the resolved enum.
  expect(comment.authoredBy).toBe("human");
  expect(JSON.stringify(payload.comments)).not.toContain('"type"'); // no raw ADF
});

test("a clipped preview comment hints at jira_get_comments(commentId=…) for the full text — not detail:full", async () => {
  // The preview is a glance, so long comment bodies are snipped. Recovery must
  // land in the tool that can actually return full comments, by id.
  const longBody = "first line\n" + "lots of detail ".repeat(200);
  const jira = new FakeJiraClient().setIssue(
    fullIssue({
      comment: makeCommentField([
        makeComment({ id: "55", author: "Jane Doe", body: longBody }),
      ]),
    }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });

  const preview = payload.comments.find((c: any) => c.id === "55");
  expect(preview.body.length).toBeLessThan(longBody.length); // clipped snippet
  expect(preview.bodyClipped).toBe(true);

  const hint = payload.hints.join(" ");
  expect(hint).toContain("bodyClipped"); // points the model at the per-comment flag
  expect(hint).toContain("jira_get_comments(commentId=");
  expect(hint).toContain("55"); // the clipped comment's id offered as the example
  expect(hint).not.toContain("detail:full"); // the dead-end the rework removes
});

test("preview authoredBy reads `agent` from a marker-led comment body (no property fetched inline)", async () => {
  // The inline issue GET doesn't expand comment properties, so the preview
  // resolves authorship from the visible marker the server stamps into the body.
  const jira = new FakeJiraClient().setIssue(
    fullIssue({
      comment: makeCommentField([
        makeComment({ id: "10", author: "Jane Doe", body: "human reply" }),
        makeComment({ id: "11", author: "Current User", body: ":claude: agent note" }),
      ]),
    }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "recent" });
  const byId = Object.fromEntries(payload.comments.map((c: any) => [c.id, c.authoredBy]));
  expect(byId["10"]).toBe("human");
  expect(byId["11"]).toBe("agent");
});

test('comments:"all" walks the dedicated endpoint for the complete thread, with authoredBy', async () => {
  // The inline issue page is bounded (here, only 2 of 5); `all` pages the
  // comment endpoint to return every comment, property-first for authorship.
  const fullThread = [
    makeComment({ id: "1", author: "Jane Doe", body: "first" }),
    makeComment({ id: "2", author: "Current User", body: "agent one", properties: [originProperty()] }),
    makeComment({ id: "3", author: "Jane Doe", body: "human reply" }),
    makeComment({ id: "4", author: "Current User", body: "agent two", properties: [originProperty()] }),
    makeComment({ id: "5", author: "Jane Doe", body: "last" }),
  ];
  const jira = new FakeJiraClient()
    .setIssue(
      fullIssue({
        comment: makeCommentField([fullThread[0], fullThread[1]] as any, 5),
      }),
    )
    .setCommentThread(fullThread as any);

  const { payload } = await run(jira, { issueKey: "ABC-1", comments: "all" });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["1", "2", "3", "4", "5"]);
  expect(payload.comments.map((c: any) => c.authoredBy)).toEqual([
    "human",
    "agent",
    "human",
    "agent",
    "human",
  ]);
  expect(payload.commentCount).toBe(5);
  // Properties were requested so authorship resolves property-first.
  expect(jira.getCommentsCalls[0]?.expand).toContain("properties");
});

// --- additive fields[] ----------------------------------------------------

test("fields[] adds a named extra and surfaces it under extraFields", async () => {
  const jira = new FakeJiraClient().setIssue(
    fullIssue({ duedate: "2026-07-01" }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", fields: ["duedate"] });

  expect(jira.getIssueCalls[0]?.fields).toContain("duedate");
  expect(payload.extraFields).toEqual({ duedate: "2026-07-01" });
});

test("fields[] genuine extra is flattened to its meaningful value, never a raw field object", async () => {
  const jira = new FakeJiraClient().setIssue(
    fullIssue({
      reporter: {
        self: "https://example.atlassian.net/rest/api/2/user?accountId=acc-9",
        accountId: "acc-9",
        displayName: "Bob Jones",
        avatarUrls: { "48x48": "https://example.atlassian.net/avatar.png" },
      },
    }),
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", fields: ["reporter"] });

  expect(payload.extraFields).toEqual({ reporter: "Bob Jones" });
  const json = JSON.stringify(payload);
  expect(json).not.toContain("avatarUrls");
  expect(json).not.toContain("accountId");
});

test("fields[] re-specifying a detail-controlled field is ignored cleanly with a hint", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue({ duedate: "2026-07-01" }));
  const { payload } = await run(jira, {
    issueKey: "ABC-1",
    fields: ["description", "status", "duedate"],
  });

  // The detail-controlled names are dropped; only the genuine extra is surfaced.
  expect(payload.extraFields).toEqual({ duedate: "2026-07-01" });
  const hint = payload.hints.join(" ");
  expect(hint).toContain("description");
  expect(hint).toContain("status");
});

test("a raw customfield id passed via fields[] is rejected, never surfaced", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", fields: ["customfield_10099"] });

  expect(payload.extraFields).toBeUndefined();
  // The id must not leak as DATA; echoing it in a recovery hint is fine (lets the agent self-correct).
  const { hints, ...data } = payload;
  expect(JSON.stringify(data)).not.toContain("customfield_");
  expect(hints.join(" ")).toContain("customfield_10099");
});

// --- no customfield ids ever leak ----------------------------------------

test("curated agile fields appear by friendly name and no customfield_XXXXX leaks", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });
  expect(JSON.stringify(payload)).not.toContain("customfield_");
  expect(payload).toMatchObject({ storyPoints: 5, sprint: "Sprint 9", epicLink: "ABC-100" });
});

// --- per-instance curated-field detection (issue 13) ----------------------

import {
  createCuratedFieldsProvider,
  type CuratedFieldsProvider,
} from "../src/lib/curated-field-provider.ts";
import type { JiraField } from "../src/lib/jira-client.ts";

/** A field catalog whose curated ids ALL differ from the cloud defaults. */
const NON_DEFAULT_FIELDS: JiraField[] = [
  { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"] },
  {
    id: "customfield_10113",
    name: "Sprint",
    custom: true,
    clauseNames: ["Sprint"],
    schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint",
  },
  {
    id: "customfield_10111",
    name: "Epic Link",
    custom: true,
    clauseNames: ["Epic Link"],
    schemaCustom: "com.pyxis.greenhopper.jira:gh-epic-link",
  },
  { id: "customfield_10105", name: "Story Points", custom: true, clauseNames: ["Story Points"] },
];

async function runWithProvider(
  jira: FakeJiraClient,
  provider: CuratedFieldsProvider,
  raw: Record<string, unknown>,
) {
  // Mirror the tool registration: resolve via the provider, derive the
  // detection-failed flag from sources, and feed both to the handler.
  const { curated, omitted, sources } = await provider.get();
  const curatedFromDefaults = Object.values(sources).some((s) => s === "default");
  const args = getIssueInputSchema.parse(raw);
  const result = await getIssueHandler(jira, args, curated, undefined, omitted, curatedFromDefaults);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

test("get_issue surfaces curated fields by friendly name on an instance with NON-default ids", async () => {
  // The exact bug-reproduction shape: this instance's Sprint is customfield_10113,
  // not the cloud default. With the old hardcoded ids these would silently vanish.
  const jira = new FakeJiraClient().setFieldCatalog(NON_DEFAULT_FIELDS).setIssue({
    id: "1",
    key: "ABC-1",
    fields: {
      summary: "Non-default instance issue",
      status: { name: "In Progress" },
      customfield_10113: [{ id: 7, name: "Sprint 7", state: "active" }],
      customfield_10111: "ABC-100",
      customfield_10105: 8,
    },
  });
  const provider = createCuratedFieldsProvider(jira, {});

  const { payload } = await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });

  expect(payload).toMatchObject({ sprint: "Sprint 7", epicLink: "ABC-100", storyPoints: 8 });
  expect(JSON.stringify(payload)).not.toContain("customfield_");

  // It requested the DETECTED ids, not the hardcoded defaults.
  const requested = jira.getIssueCalls[0]?.fields ?? [];
  expect(requested).toContain("customfield_10113");
  expect(requested).not.toContain(SPRINT); // the cloud default is never requested
});

test("detection reads field metadata exactly once across repeated get_issue calls", async () => {
  const jira = new FakeJiraClient().setFieldCatalog(NON_DEFAULT_FIELDS).setIssue({
    id: "1",
    key: "ABC-1",
    fields: { summary: "x", customfield_10113: [{ id: 7, name: "Sprint 7", state: "active" }] },
  });
  const provider = createCuratedFieldsProvider(jira, {});

  await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });
  await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });

  expect(jira.listFieldsCalls).toBe(1);
});

test("an explicit override beats detection for the curated id that is requested", async () => {
  const jira = new FakeJiraClient().setFieldCatalog(NON_DEFAULT_FIELDS).setIssue({
    id: "1",
    key: "ABC-1",
    fields: { summary: "x", customfield_10500: [{ id: 9, name: "Sprint 9", state: "active" }] },
  });
  // Operator pins Sprint to a different id than the catalog would detect.
  const provider = createCuratedFieldsProvider(jira, { sprint: "customfield_10500" });

  const { payload } = await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });

  expect(payload.sprint).toBe("Sprint 9");
  const requested = jira.getIssueCalls[0]?.fields ?? [];
  expect(requested).toContain("customfield_10500");
  expect(requested).not.toContain("customfield_10113");
});

test("an undetectable curated field with no override is omitted with a visible note, never guessed", async () => {
  // Catalog has Sprint but NOT story points / epic link. Those two must be omitted
  // (not read against the cloud default) and flagged in a hint.
  const jira = new FakeJiraClient()
    .setFieldCatalog([
      {
        id: "customfield_10113",
        name: "Sprint",
        custom: true,
        clauseNames: ["Sprint"],
        schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint",
      },
    ])
    .setIssue({
      id: "1",
      key: "ABC-1",
      fields: {
        summary: "x",
        customfield_10113: [{ id: 7, name: "Sprint 7", state: "active" }],
        // a value sitting at the cloud-default story-points id must NOT be read
        [SP]: 99,
        [EPIC]: "ABC-100",
      },
    });
  const provider = createCuratedFieldsProvider(jira, {});

  const { payload } = await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });

  expect(payload.sprint).toBe("Sprint 7");
  expect(payload.storyPoints).toBeUndefined();
  expect(payload.epicLink).toBeUndefined();

  // Never requested the guessed default ids.
  const requested = jira.getIssueCalls[0]?.fields ?? [];
  expect(requested).not.toContain(SP);
  expect(requested).not.toContain(EPIC);

  // Visible degradation: a note names the omitted fields and the override knobs.
  const hint = payload.hints.join(" ");
  expect(hint).toContain("storyPoints");
  expect(hint).toContain("epicLink");
  expect(hint).toContain("JIRA_FIELD_STORY_POINTS");
});

test("when detection can't run, curated fields fall back to defaults WITH a visible note", async () => {
  // listFields throws → provider resolves to cloud defaults (last resort). The
  // response must flag that the agile fields were read against guessed ids.
  class FailingFields extends FakeJiraClient {
    override async listFields(): Promise<JiraField[]> {
      this.listFieldsCalls += 1;
      throw new Error("503");
    }
  }
  const jira = new FailingFields().setIssue({
    id: "1",
    key: "ABC-1",
    fields: { summary: "x", [SPRINT]: [{ id: 1, name: "Sprint 1", state: "active" }] },
  });
  const provider = createCuratedFieldsProvider(jira, {});

  const { payload } = await runWithProvider(jira, provider, { issueKey: "ABC-1", detail: "full" });

  // Default ids were used, so the default-keyed sprint value still reads…
  expect(payload.sprint).toBe("Sprint 1");
  // …but the response says it may be wrong.
  const hint = payload.hints.join(" ");
  expect(hint).toContain("DEFAULT");
  expect(hint).toContain("field metadata");
});

// --- hints + errors -------------------------------------------------------

test("every response carries a non-empty hints array", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("an unknown issue key returns a clear recovery hint", async () => {
  const jira = new FakeJiraClient().setGetIssueError(notFoundError());
  const { result, payload } = await run(jira, { issueKey: "NOPE-9" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("issue_not_found");
  expect(payload.error.message).toContain("NOPE-9");
  const hint = payload.hints.join(" ");
  expect(hint).toContain("NOPE-9");
  expect(hint.toLowerCase()).toContain("key");
});

test("an auth failure is shaped as authentication_failed with the recovery hint", async () => {
  const jira = new FakeJiraClient().setGetIssueError(authError());
  const { result, payload } = await run(jira, { issueKey: "ABC-1" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  expect(payload.hints.join(" ").toLowerCase()).toContain("unscoped");
});

// --- request shape --------------------------------------------------------

test("requests card fields, description, comment, links, subtasks, and curated ids", async () => {
  const jira = new FakeJiraClient().setIssue(fullIssue());
  await run(jira, { issueKey: "ABC-1" });
  const requested = jira.getIssueCalls[0]?.fields ?? [];
  for (const f of ["summary", "status", "description", "comment", "issuelinks", "subtasks", SP, SPRINT, EPIC]) {
    expect(requested).toContain(f);
  }
});

test("graceful when description and curated fields are absent", async () => {
  const jira = new FakeJiraClient().setIssue({
    id: "1",
    key: "ABC-1",
    fields: {
      summary: "Bare issue",
      status: { name: "To Do" },
      issuetype: { name: "Task" },
      priority: { name: "Low" },
      assignee: null,
      labels: [],
      updated: "2026-06-10T09:00:00.000+0000",
    },
  });
  const { payload } = await run(jira, { issueKey: "ABC-1", detail: "full" });
  expect(payload.description).toBe("");
  expect(payload.storyPoints).toBeUndefined();
  expect(payload.assignee).toBeNull();
  expect(payload.counts ?? { comments: 0 }).toBeTruthy();
});
