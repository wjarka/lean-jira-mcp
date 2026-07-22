/**
 * jira_get_comments handler, driven end-to-end against the faked JiraClient.
 * No transport, no network. Asserts on the shaped MCP response the agent sees.
 *
 * Corrected design (rework): comment bodies are returned FULL by default and are
 * never truncated; leanness comes from token-budgeted pagination over WHOLE
 * comments, with `preview:true` the only opt-in truncation and `commentId` the
 * single-comment full-text path. Every hint resolves within this tool.
 */

import { test, expect } from "bun:test";
import {
  getCommentsHandler,
  getCommentsInputSchema,
  type GetCommentsDeps,
} from "../src/tools/get-comments.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import {
  FakeJiraClient,
  makeComment,
  originProperty,
  authError,
  notFoundError,
} from "./helpers/fake-jira-client.ts";
import type { JiraRestCommentFull } from "../src/lib/jira-client.ts";

const DEPS: GetCommentsDeps = { marker: ":claude:" };

async function run(
  jira: FakeJiraClient,
  raw: Record<string, unknown>,
  deps: GetCommentsDeps = DEPS,
) {
  const args = getCommentsInputSchema.parse(raw);
  const result = await getCommentsHandler(jira, args, deps);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

/** A chronological (oldest-first) thread of plain human comments with ids 1..n. */
function humanThread(n: number): JiraRestCommentFull[] {
  return Array.from({ length: n }, (_, i) =>
    makeComment({ id: String(i + 1), author: "Jane Doe", body: `comment ${i + 1}` }),
  ) as unknown as JiraRestCommentFull[];
}

/** A comment whose flattened body is ~`tokens` estimated tokens (~4 chars/token). */
function sizedComment(id: string, tokens: number): JiraRestCommentFull {
  return makeComment({ id, author: "Jane Doe", body: "x".repeat(tokens * 4) }) as unknown as JiraRestCommentFull;
}

// --- pagination contract (mirrors jira_search) -----------------------------

test("returns the whole thread on one page with isLast and a completeness hint", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { payload } = await run(jira, { issueKey: "ABC-1" });

  expect(payload.comments).toHaveLength(3);
  expect(payload.isLast).toBe(true);
  expect(payload.total).toBe(3);
  expect(payload.nextCursor).toBeUndefined();
  expect(payload.hints.join(" ")).toContain("complete thread");
});

test("order:newest returns most-recent first; order:oldest is chronological", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));

  const newest = await run(jira, { issueKey: "ABC-1", order: "newest" });
  expect(newest.payload.comments.map((c: any) => c.id)).toEqual(["3", "2", "1"]);
  expect(jira.getCommentsCalls.at(-1)?.orderBy).toBe("-created");

  const oldest = await run(jira, { issueKey: "ABC-1", order: "oldest" });
  expect(oldest.payload.comments.map((c: any) => c.id)).toEqual(["1", "2", "3"]);
  expect(jira.getCommentsCalls.at(-1)?.orderBy).toBe("created");
});

test("pages by token budget over whole comments, ending on isLast", async () => {
  // ~1500-token comments: two fit the ~3500 budget, the third spills to page 2.
  const jira = new FakeJiraClient().setCommentThread([
    sizedComment("1", 1500),
    sizedComment("2", 1500),
    sizedComment("3", 1500),
  ]);

  const p1 = await run(jira, { issueKey: "ABC-1", order: "oldest" });
  expect(p1.payload.comments.map((c: any) => c.id)).toEqual(["1", "2"]);
  expect(p1.payload.isLast).toBe(false);
  expect(typeof p1.payload.nextCursor).toBe("string");
  expect(p1.payload.hints.join(" ")).toContain("nextCursor");

  const p2 = await run(jira, { issueKey: "ABC-1", order: "oldest", cursor: p1.payload.nextCursor });
  expect(p2.payload.comments.map((c: any) => c.id)).toEqual(["3"]);
  expect(p2.payload.isLast).toBe(true);
  expect(p2.payload.nextCursor).toBeUndefined();
});

test("a comment larger than the page budget is returned WHOLE as its own page, never split", async () => {
  // The subtle case: an over-budget comment occupies a page alone, uncut, and
  // the next comment moves to the following page. Body is never truncated.
  const huge = sizedComment("1", 5000); // ~5000 tokens, well over the ~3500 budget
  const hugeBodyLen = (huge.body as any).content[0].content[0].text.length;
  const jira = new FakeJiraClient().setCommentThread([
    huge,
    makeComment({ id: "2", author: "Jane Doe", body: "short and fine" }) as unknown as JiraRestCommentFull,
  ]);

  const p1 = await run(jira, { issueKey: "ABC-1", order: "oldest" });
  expect(p1.payload.comments.map((c: any) => c.id)).toEqual(["1"]); // its own whole page
  expect(p1.payload.comments[0].body.length).toBe(hugeBodyLen); // returned WHOLE, not clipped
  expect(p1.payload.comments[0].bodyClipped).toBeUndefined(); // no truncation flag anywhere
  expect(p1.payload.isLast).toBe(false);
  expect(typeof p1.payload.nextCursor).toBe("string");

  const p2 = await run(jira, { issueKey: "ABC-1", order: "oldest", cursor: p1.payload.nextCursor });
  expect(p2.payload.comments.map((c: any) => c.id)).toEqual(["2"]);
  expect(p2.payload.isLast).toBe(true);
});

test("a ~25-comment count backstop bounds pages of many tiny comments", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(30));

  const p1 = await run(jira, { issueKey: "ABC-1", order: "oldest" });
  expect(p1.payload.comments).toHaveLength(25); // count backstop, well under the token budget
  expect(p1.payload.isLast).toBe(false);

  const p2 = await run(jira, { issueKey: "ABC-1", order: "oldest", cursor: p1.payload.nextCursor });
  expect(p2.payload.comments).toHaveLength(5);
  expect(p2.payload.isLast).toBe(true);
});

test("the cursor is opaque — never a bare offset the agent could have computed", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(30));
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.nextCursor).not.toBe("25");
  expect(Number.isNaN(Number(payload.nextCursor))).toBe(true);
});

test("a malformed cursor is rejected with a recovery hint, not a crash", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", cursor: "not-a-real-cursor" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("invalid_cursor");
  expect(payload.hints.length).toBeGreaterThan(0);
});

// --- full bodies by default -------------------------------------------------

test("long bodies are returned in FULL by default — no truncation, no point-elsewhere hint", async () => {
  const big = ":claude: " + "word ".repeat(2000); // ~10k chars
  const jira = new FakeJiraClient().setCommentThread([
    makeComment({ id: "1", author: "Current User", body: big }) as unknown as JiraRestCommentFull,
  ]);

  const { payload } = await run(jira, { issueKey: "ABC-1" });
  const c = payload.comments[0];
  expect(c.body.startsWith(":claude:")).toBe(true);
  expect(c.body.length).toBeGreaterThan(9000); // full, not clipped
  expect(c.bodyClipped).toBeUndefined();
  // No hint ever sends the agent elsewhere for full comment text.
  const hints = payload.hints.join(" ").toLowerCase();
  expect(hints).not.toContain("open the issue");
  expect(hints).not.toContain("in jira");
});

// --- preview ---------------------------------------------------------------

test("preview:true returns short snippets with id + authoredBy; clipped ones flagged", async () => {
  const long = "first line\n" + "more body ".repeat(200);
  const jira = new FakeJiraClient().setCommentThread([
    makeComment({ id: "1", author: "Jane Doe", body: long }) as unknown as JiraRestCommentFull,
    makeComment({ id: "2", author: "Current User", body: ":claude: tiny", properties: [originProperty()] }) as unknown as JiraRestCommentFull,
  ]);

  const { payload } = await run(jira, { issueKey: "ABC-1", order: "oldest", preview: true });
  const long1 = payload.comments.find((c: any) => c.id === "1");
  const tiny2 = payload.comments.find((c: any) => c.id === "2");

  expect(long1.body.length).toBeLessThan(long.length); // snipped
  expect(long1.bodyClipped).toBe(true);
  expect(long1.authoredBy).toBe("human"); // still carries id + authoredBy
  expect(tiny2.body).toContain(":claude:");
  expect(tiny2.bodyClipped).toBeUndefined(); // short body not clipped
  expect(tiny2.authoredBy).toBe("agent");

  // Hint resolves WITHIN this tool: drop preview, or pull one full via commentId.
  const hint = payload.hints.join(" ");
  expect(hint).toContain("Preview mode");
  expect(hint).toContain("commentId");
});

test("preview:true on an all-short thread returns full bodies and no 'preview mode' hint", async () => {
  // Nothing is actually snipped, so the agent isn't told to re-fetch for text it has.
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { payload } = await run(jira, { issueKey: "ABC-1", preview: true });
  expect(payload.comments.every((c: any) => c.bodyClipped === undefined)).toBe(true);
  expect(payload.hints.join(" ")).not.toContain("Preview mode");
});

test("an empty thread reads as 'no comments yet', not 'showing all 0'", async () => {
  const jira = new FakeJiraClient().setCommentThread([]);
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.comments).toHaveLength(0);
  expect(payload.isLast).toBe(true);
  expect(payload.hints.join(" ")).toContain("no comments yet");
});

test("omitting preview returns the full body the snippet was hiding", async () => {
  const long = "first line\n" + "more body ".repeat(200);
  const jira = new FakeJiraClient().setCommentThread([
    makeComment({ id: "1", author: "Jane Doe", body: long }) as unknown as JiraRestCommentFull,
  ]);
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.comments[0].body.length).toBeGreaterThanOrEqual(long.length - 5);
  expect(payload.comments[0].bodyClipped).toBeUndefined();
});

// --- commentId -------------------------------------------------------------

test("commentId returns that single comment in full", async () => {
  const jira = new FakeJiraClient().setExistingComment(
    makeComment({
      id: "42",
      author: "Jane Doe",
      body: "the full text of one comment, however long it is",
    }) as unknown as JiraRestCommentFull,
  );

  const { payload } = await run(jira, { issueKey: "ABC-1", commentId: "42" });
  expect(payload.comments).toHaveLength(1);
  expect(payload.comments[0].id).toBe("42");
  expect(payload.comments[0].body).toBe("the full text of one comment, however long it is");
  expect(payload.isLast).toBe(true);
  expect(payload.count).toBe(1);
  // Properties are expanded so authorship resolves property-first.
  expect(jira.getCommentCalls[0]?.expand).toContain("properties");
  expect(jira.getCommentCalls[0]?.commentId).toBe("42");
});

test("commentId always returns full text even with preview:true", async () => {
  const long = "first line\n" + "more body ".repeat(200);
  const jira = new FakeJiraClient().setExistingComment(
    makeComment({ id: "7", author: "Jane Doe", body: long }) as unknown as JiraRestCommentFull,
  );
  const { payload } = await run(jira, { issueKey: "ABC-1", commentId: "7", preview: true });
  expect(payload.comments[0].body.length).toBeGreaterThanOrEqual(long.length - 5);
  expect(payload.comments[0].bodyClipped).toBeUndefined();
});

test("an unknown commentId surfaces comment_not_found with an in-tool recovery hint", async () => {
  const jira = new FakeJiraClient().setGetCommentError(notFoundError());
  const { result, payload } = await run(jira, { issueKey: "ABC-1", commentId: "999" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("comment_not_found");
  expect(payload.hints.join(" ")).toContain("commentId");
});

// --- authoredBy derivation -------------------------------------------------

test("authoredBy: property → agent, configured/legacy marker → agent, plain → human, no author → unknown", async () => {
  const thread = [
    makeComment({ id: "1", author: "Jane Doe", body: "plain human" }),
    makeComment({ id: "2", author: "Current User", body: "via property", properties: [originProperty()] }),
    makeComment({ id: "3", author: "Current User", body: ":robot: configured marker" }),
    makeComment({ id: "4", author: "Other Agent", body: ":claude: legacy marker" }),
    makeComment({ id: "5", author: null, body: "orphaned" }),
  ] as unknown as JiraRestCommentFull[];
  const jira = new FakeJiraClient().setCommentThread(thread);

  // Operator reconfigured the marker to :robot:; legacy :claude: must still read as agent.
  const { payload } = await run(jira, { issueKey: "ABC-1", order: "oldest" }, { marker: ":robot:" });
  const byId = Object.fromEntries(payload.comments.map((c: any) => [c.id, c.authoredBy]));
  expect(byId).toEqual({ "1": "human", "2": "agent", "3": "agent", "4": "agent", "5": "unknown" });
  // Properties are expanded so authorship can resolve property-first.
  expect(jira.getCommentsCalls[0]?.expand).toContain("properties");
});

test("bodies are markdown with the marker preserved; never raw ADF", async () => {
  const jira = new FakeJiraClient().setCommentThread([
    makeComment({ id: "1", author: "Current User", body: ":claude: shipped the fix" }),
  ] as unknown as JiraRestCommentFull[]);
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(payload.comments[0].body).toBe(":claude: shipped the fix");
  expect(JSON.stringify(payload.comments)).not.toContain('"type"');
});

// --- sinceLastAgentComment -------------------------------------------------

test("sinceLastAgentComment returns only comments after the agent's LATEST stamped comment", async () => {
  // Mixed thread; the agent commented twice and is NOT the most recent.
  const thread = [
    makeComment({ id: "1", author: "Jane Doe", body: "kickoff" }),
    makeComment({ id: "2", author: "Current User", body: "early agent note", properties: [originProperty()] }),
    makeComment({ id: "3", author: "Jane Doe", body: "human reply" }),
    makeComment({ id: "4", author: "Current User", body: "latest agent note", properties: [originProperty()] }),
    makeComment({ id: "5", author: "Jane Doe", body: "human after agent" }),
    makeComment({ id: "6", author: "Bob", body: "another human" }),
  ] as unknown as JiraRestCommentFull[];
  const jira = new FakeJiraClient().setCommentThread(thread);

  const { payload } = await run(jira, { issueKey: "ABC-1", sinceLastAgentComment: true });
  // Only 5 and 6 (after comment 4, the latest agent comment); never the agent's own or older.
  expect(payload.comments.map((c: any) => c.id).sort()).toEqual(["5", "6"]);
  expect(payload.comments.every((c: any) => c.authoredBy !== "agent")).toBe(true);
  expect(payload.isLast).toBe(true);
  expect(payload.nextCursor).toBeUndefined();
  expect(payload.hints.join(" ")).toContain("since your last comment");
});

test("sinceLastAgentComment returns full bodies even with preview:true", async () => {
  const long = "human reply\n" + "more body ".repeat(200);
  const thread = [
    makeComment({ id: "1", author: "Current User", body: ":claude: my note", properties: [originProperty()] }),
    makeComment({ id: "2", author: "Jane Doe", body: long }),
  ] as unknown as JiraRestCommentFull[];
  const jira = new FakeJiraClient().setCommentThread(thread);

  const { payload } = await run(jira, { issueKey: "ABC-1", sinceLastAgentComment: true, preview: true });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["2"]);
  expect(payload.comments[0].body.length).toBeGreaterThanOrEqual(long.length - 5);
  expect(payload.comments[0].bodyClipped).toBeUndefined();
});

test("sinceLastAgentComment with the agent's comment most recent → empty, 'no reply' hint", async () => {
  const thread = [
    makeComment({ id: "1", author: "Jane Doe", body: "question" }),
    makeComment({ id: "2", author: "Current User", body: "my answer", properties: [originProperty()] }),
  ] as unknown as JiraRestCommentFull[];
  const jira = new FakeJiraClient().setCommentThread(thread);

  const { payload } = await run(jira, { issueKey: "ABC-1", sinceLastAgentComment: true });
  expect(payload.comments).toHaveLength(0);
  expect(payload.hints.join(" ")).toContain("hasn't replied");
});

test("sinceLastAgentComment when the agent never commented → whole thread, distinct hint", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { payload } = await run(jira, { issueKey: "ABC-1", sinceLastAgentComment: true });
  expect(payload.comments).toHaveLength(3);
  expect(payload.hints.join(" ")).toContain("haven't commented");
});

test("sinceLastAgentComment walks across pages to find a non-first-page agent comment", async () => {
  // 250 comments; the agent's only comment is old (id 5), forcing a multi-page walk.
  const thread = humanThread(250);
  (thread[4] as any) = makeComment({
    id: "5",
    author: "Current User",
    body: "ancient agent note",
    properties: [originProperty()],
  });
  const jira = new FakeJiraClient().setCommentThread(thread);

  const { payload } = await run(jira, { issueKey: "ABC-1", sinceLastAgentComment: true });
  // Everything after id 5 = ids 6..250 → 245 comments.
  expect(payload.comments).toHaveLength(245);
  expect(payload.comments.some((c: any) => c.id === "5")).toBe(false);
  expect(jira.getCommentsCalls.length).toBeGreaterThan(1); // it paged
});

// --- since (id / timestamp) ------------------------------------------------

test("since (comment id) returns only comments after that id", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(5));
  const { payload } = await run(jira, { issueKey: "ABC-1", since: "3" });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["5", "4"]); // newest-first, after id 3
  expect(payload.hints.join(" ")).toContain("after 3");
});

test("since (timestamp) returns only comments created after that instant", async () => {
  const thread = [
    makeComment({ id: "1", author: "A", body: "one", created: "2026-06-01T10:00:00.000+0000" }),
    makeComment({ id: "2", author: "A", body: "two", created: "2026-06-01T11:00:00.000+0000" }),
    makeComment({ id: "3", author: "A", body: "three", created: "2026-06-01T12:00:00.000+0000" }),
    makeComment({ id: "4", author: "A", body: "four", created: "2026-06-01T13:00:00.000+0000" }),
  ] as unknown as JiraRestCommentFull[];
  const jira = new FakeJiraClient().setCommentThread(thread);

  const { payload } = await run(jira, {
    issueKey: "ABC-1",
    order: "oldest",
    since: "2026-06-01T11:30:00.000+0000",
  });
  expect(payload.comments.map((c: any) => c.id)).toEqual(["3", "4"]);
});

test("an unparseable since value is rejected with a recovery hint", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", since: "last-tuesday" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("invalid_since");
});

test("passing both delta filters is refused as ambiguous", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(3));
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    sinceLastAgentComment: true,
    since: "2",
  });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("ambiguous_delta_filter");
});

// --- errors ----------------------------------------------------------------

test("a 404 surfaces issue_not_found with a recovery hint", async () => {
  const jira = new FakeJiraClient().setGetCommentsError(notFoundError());
  const { result, payload } = await run(jira, { issueKey: "NOPE-1" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("issue_not_found");
  expect(payload.hints.join(" ")).toContain("jira_search");
});

test("rejected credentials surface the auth error", async () => {
  const jira = new FakeJiraClient().setGetCommentsError(authError());
  const { result, payload } = await run(jira, { issueKey: "ABC-1" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("every success response carries at least one hint", async () => {
  const jira = new FakeJiraClient().setCommentThread(humanThread(2));
  const { payload } = await run(jira, { issueKey: "ABC-1" });
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});
