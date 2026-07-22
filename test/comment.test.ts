/**
 * jira_comment (write) handler, driven end-to-end against the faked JiraClient.
 * Asserts on the shaped MCP response the agent sees and on the write payload
 * sent to the JIRA seam — never on internals.
 *
 * Review-flagged invariants with explicit coverage:
 *   - auto-stamp has NO opt-out: every write path stamps both the mcp.origin
 *     property and the configured visible marker (post AND edit).
 *   - edit guard: a human-authored comment is refused; an agent comment is
 *     re-stamped (PUT replaces the body).
 */

import { test, expect } from "bun:test";
import {
  commentHandler,
  commentInputSchema,
  type CommentDeps,
} from "../src/tools/comment.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";
import { JiraApiError, type JiraRestCommentFull } from "../src/lib/jira-client.ts";
import {
  ORIGIN_PROPERTY_KEY,
  ORIGIN_PROPERTY_VALUE,
} from "../src/lib/comment-authorship.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";

const DEPS: CommentDeps = { baseUrl: "https://acme.atlassian.net", marker: ":claude:" };

async function run(jira: FakeJiraClient, raw: Record<string, unknown>, deps: CommentDeps = DEPS) {
  const args = commentInputSchema.parse(raw);
  const result = await commentHandler(jira, args, deps);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

/** The ADF body sent on the most recent addComment call, flattened to markdown. */
function postedMarkdown(jira: FakeJiraClient): string {
  return adfToMarkdown(jira.addCommentCalls.at(-1)!.body);
}

function updatedMarkdown(jira: FakeJiraClient): string {
  return adfToMarkdown(jira.updateCommentCalls.at(-1)!.body);
}

/** A comment as JIRA returns it; agent-authored unless told otherwise. */
function existing(opts: Partial<JiraRestCommentFull> & { agent?: boolean }): JiraRestCommentFull {
  const base: JiraRestCommentFull = {
    id: opts.id ?? "c-1",
    author: opts.author ?? { displayName: "Jane Human", accountId: "acc-h" },
    body: opts.body ?? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
    created: opts.created ?? "2026-06-20T10:00:00.000+0000",
  };
  if (opts.agent) base.properties = [{ key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE }];
  if (opts.properties) base.properties = opts.properties;
  if (opts.updated) base.updated = opts.updated;
  return base;
}

// --- post: auto-stamp (no opt-out) ------------------------------------------

test("posting writes the body as ADF and stamps BOTH the mcp.origin property and the marker", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", body: "Looks good to me." });

  expect(jira.addCommentCalls).toHaveLength(1);
  const call = jira.addCommentCalls[0]!;

  // property stamped
  expect(call.properties).toEqual([{ key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE }]);
  // marker stamped into the body, then ADF
  expect(postedMarkdown(jira)).toBe(":claude: Looks good to me.");
  // body is real ADF
  expect((call.body as { type: string }).type).toBe("doc");

  expect(payload.authoredBy).toBe("agent");
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("the marker is posted as a real ADF emoji node (so JIRA renders it, not literal text)", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", body: "Looks good." });

  const body = jira.addCommentCalls[0]!.body as { content: { type: string; content: any[] }[] };
  const firstPara = body.content[0]!;
  expect(firstPara.type).toBe("paragraph");
  expect(firstPara.content[0]).toEqual({ type: "emoji", attrs: { shortName: ":claude:" } });
});

test("there is no input flag that disables stamping (no opt-out in the schema)", () => {
  const keys = Object.keys(commentInputSchema.shape);
  expect(keys.sort()).toEqual(["body", "commentId", "issueKey", "visibility"]);
});

test("a markdown body is converted to ADF and round-trips back to equivalent markdown", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", body: "A line with **bold** and `code`." });
  expect(postedMarkdown(jira)).toBe(":claude: A line with **bold** and `code`.");
});

// --- marker is configurable, not hardcoded ----------------------------------

test("the visible marker reflects JIRA_MCP_COMMENT_MARKER and is not hardcoded", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", body: "ping" }, { ...DEPS, marker: ":robot:" });
  expect(postedMarkdown(jira)).toBe(":robot: ping");
  // the property is still stamped regardless of the marker
  expect(jira.addCommentCalls[0]!.properties).toEqual([
    { key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE },
  ]);
});

// --- response shape ---------------------------------------------------------

test("the response carries a clickable deep-link url, the commentId, and authoredBy:agent", async () => {
  const jira = new FakeJiraClient().setAddCommentResponder((p) => ({
    id: "98765",
    author: { displayName: "Me" },
    body: p.body,
    created: "2026-06-25T12:00:00.000+0000",
  }));
  const { payload } = await run(jira, { issueKey: "ABC-1", body: "hi" });

  expect(payload.commentId).toBe("98765");
  expect(payload.url).toBe("https://acme.atlassian.net/browse/ABC-1?focusedCommentId=98765");
  expect(payload.authoredBy).toBe("agent");
  expect(payload.created).toBe("2026-06-25T12:00:00.000+0000");
  // a fresh post has no edit timestamp
  expect(payload.updated).toBeUndefined();
});

// --- edit guard -------------------------------------------------------------

test("editing an agent-authored comment (by property) succeeds and re-stamps the marker", async () => {
  const jira = new FakeJiraClient().setExistingComment(existing({ id: "c-9", agent: true }));
  const { payload } = await run(jira, { issueKey: "ABC-1", commentId: "c-9", body: "Updated take." });

  // guard fetched the comment with its properties
  expect(jira.getCommentCalls).toEqual([{ issueKey: "ABC-1", commentId: "c-9", expand: ["properties"] }]);
  // a PUT, not a POST
  expect(jira.updateCommentCalls).toHaveLength(1);
  expect(jira.addCommentCalls).toHaveLength(0);

  // marker AND property re-stamped on the replacement body (PUT replaces the body)
  expect(updatedMarkdown(jira)).toBe(":claude: Updated take.");
  expect(jira.updateCommentCalls[0]!.properties).toEqual([
    { key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE },
  ]);
  expect(payload.commentId).toBe("c-9");
  expect(payload.hints.join(" ")).toMatch(/re-stamp/i);
});

test("an agent comment recognised by the marker fallback (no property) is still editable", async () => {
  const markered = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: ":claude: earlier note" }] }],
  };
  const jira = new FakeJiraClient().setExistingComment(existing({ id: "c-3", body: markered }));
  const { result } = await run(jira, { issueKey: "ABC-1", commentId: "c-3", body: "revised" });

  expect(result.isError).toBeUndefined();
  expect(jira.updateCommentCalls).toHaveLength(1);
});

test("editing a human-authored comment is refused with a hint and never PUTs", async () => {
  const jira = new FakeJiraClient().setExistingComment(
    existing({ id: "c-7", author: { displayName: "Jane Human" } }),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", commentId: "c-7", body: "sneaky edit" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("comment_not_agent_authored");
  expect(jira.updateCommentCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/post a new comment/i);
  expect(payload.hints.join(" ")).toMatch(/Jane Human/);
});

test("a human comment that merely mentions the marker mid-text is NOT editable", async () => {
  const mentionsMarker = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "Should we switch the :claude: marker?" }] }],
  };
  const jira = new FakeJiraClient().setExistingComment(
    existing({ id: "c-5", author: { displayName: "Jane Human" }, body: mentionsMarker }),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", commentId: "c-5", body: "edit attempt" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("comment_not_agent_authored");
  expect(jira.updateCommentCalls).toHaveLength(0);
});

test("editing a missing comment returns a not-found hint, not a silent failure", async () => {
  const jira = new FakeJiraClient().setGetCommentError(
    new JiraApiError(404, ["Comment does not exist or no permission."], {}),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", commentId: "nope", body: "x" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("comment_not_found");
  expect(jira.updateCommentCalls).toHaveLength(0);
});

// --- visibility -------------------------------------------------------------

test("visibility restricts the comment to the given role and echoes it back", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "internal note",
    visibility: { type: "role", value: "Administrators" },
  });

  expect(jira.addCommentCalls[0]!.visibility).toEqual({ type: "role", value: "Administrators" });
  expect(payload.visibility).toEqual({ type: "role", value: "Administrators" });
});

test("default is public: no visibility sent when none requested", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", body: "public note" });
  expect(jira.addCommentCalls[0]!.visibility).toBeUndefined();
  expect(payload.visibility).toBeUndefined();
});

test("an explicit type:public posts a public comment (no restriction sent)", async () => {
  const jira = new FakeJiraClient();
  const { result } = await run(jira, {
    issueKey: "ABC-1",
    body: "public note",
    visibility: { type: "public" },
  });
  expect(result.isError).toBeUndefined();
  expect(jira.addCommentCalls).toHaveLength(1);
  expect(jira.addCommentCalls[0]!.visibility).toBeUndefined();
});

test("a role/group restriction without a value is rejected with a hint, before any write", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "internal",
    visibility: { type: "role" },
  });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("visibility_value_required");
  expect(jira.addCommentCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/public|value/i);
});

test("a value without a type is rejected and NEVER silently posts public (issue: value-only visibility)", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "internal note",
    visibility: { value: "Developers" },
  });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("visibility_type_required");
  expect(jira.addCommentCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/type.*role.*group|role.*group.*type/i);
  expect(payload.hints.join(" ")).toMatch(/Developers/);
});

test("an invalid visibility role returns a hint listing valid roles, fetched only on failure", async () => {
  const jira = new FakeJiraClient()
    .setAddCommentError(new JiraApiError(400, ["The visibility level is not valid."], {}))
    .setProjectRoles(["Administrators", "Developers", "Users"]);

  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "oops",
    visibility: { type: "role", value: "Wizards" },
  });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("invalid_visibility_role");
  // roles fetched only after the failure, for project ABC
  expect(jira.getProjectRolesCalls).toEqual(["ABC"]);
  expect(payload.error.options).toEqual(["Administrators", "Developers", "Users"]);
  expect(payload.hints.join(" ")).toMatch(/Administrators.*Developers.*Users/);
});

test("an invalid visibility group returns a hint without a role lookup", async () => {
  const jira = new FakeJiraClient().setAddCommentError(
    new JiraApiError(400, ["The visibility level is not valid."], {}),
  );
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "oops",
    visibility: { type: "group", value: "ghosts" },
  });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("invalid_visibility_group");
  expect(jira.getProjectRolesCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/ghosts/);
});

// --- error mapping ----------------------------------------------------------

test("an auth failure is shaped with the credential-recovery guidance", async () => {
  const jira = new FakeJiraClient().setAddCommentError(new JiraApiError(401, ["unauthenticated"], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", body: "x" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("commenting on a missing issue returns an issue-not-found hint", async () => {
  const jira = new FakeJiraClient().setAddCommentError(
    new JiraApiError(404, ["Issue does not exist."], {}),
  );
  const { result, payload } = await run(jira, { issueKey: "ZZZ-9", body: "x" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("issue_not_found");
});

test("a bare INVALID_INPUT with no visibility names the comment body as the likely cause (issue 20)", async () => {
  // A comment carries only the markdown→ADF body, so a detailless 400 points at
  // the body — restoring an actionable hint on the comment write path (bug B).
  const jira = new FakeJiraClient().setAddCommentError(new JiraApiError(400, ["INVALID_INPUT"], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", body: "some **rich** text" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("rich_text_validation_failed");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/comment body/i);
  expect(hint).toMatch(/markdown.*ADF|conversion/i);
  // Not the dead-end generic "re-check the arguments" the reporter saw.
  expect(hint).not.toMatch(/re-check the arguments/i);
});

test("every response carries hints", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", body: "hi" });
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

// --- issue 11 group B: degrade-and-report + inline-image rejection ----------

test("an inline image in a comment body is rejected with a use-a-link hint; nothing posted", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "look ![diagram](http://img/d.png)",
  });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("inline_image_unsupported");
  expect(payload.hints.join(" ")).toMatch(/link/i);
  expect(jira.addCommentCalls).toHaveLength(0);
});

test("a degraded (but not rejected) comment body posts and notes the difference in hints", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    body: "- [x] done\n- [ ] todo",
  });
  expect(result.isError).toBeUndefined();
  expect(jira.addCommentCalls).toHaveLength(1);
  expect(payload.hints.join(" ")).toMatch(/differs/i);
  expect(payload.hints.join(" ")).toMatch(/checkbox/i);
});

test("a fully-supported comment body posts with no stored-body-differs note", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", body: "Plain **supported** body." });
  expect(payload.hints.join(" ")).not.toMatch(/differs/i);
});
