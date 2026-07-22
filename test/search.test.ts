/**
 * jira_search handler, driven end-to-end against the faked JiraClient.
 * No transport, no network. Asserts on the shaped MCP response the agent sees.
 */

import { test, expect } from "bun:test";
import {
  buildSearchDescription,
  searchHandler,
  searchInputSchema,
  type SearchDeps,
} from "../src/tools/search.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import { FakeJiraClient, makeIssue, jqlParseError, authError } from "./helpers/fake-jira-client.ts";

/** Parse raw input through the real zod schema (applying defaults), then run the handler. */
async function run(jira: FakeJiraClient, raw: Record<string, unknown>, deps: SearchDeps = {}) {
  const args = searchInputSchema.parse(raw);
  const result = await searchHandler(jira, args, deps);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

test("returns compact cards with exactly the agreed field set; assignee is a display name", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [
      makeIssue({
        key: "ABC-1",
        summary: "Fix the thing",
        status: "In Progress",
        type: "Bug",
        priority: "High",
        assignee: "Alice Smith",
        labels: ["backend", "urgent"],
        updated: "2026-06-10T09:00:00.000+0000",
      }),
    ],
    isLast: true,
  });

  const { payload } = await run(jira, { jql: "project = ABC" });
  const card = payload.issues[0];

  expect(Object.keys(card).sort()).toEqual(
    ["assignee", "key", "labels", "priority", "status", "summary", "type", "updated"].sort(),
  );
  expect(card).toMatchObject({
    key: "ABC-1",
    summary: "Fix the thing",
    status: "In Progress",
    type: "Bug",
    priority: "High",
    assignee: "Alice Smith", // display name, not accountId
    labels: ["backend", "urgent"],
    updated: "2026-06-10T09:00:00.000+0000",
  });
});

test("never emits rank even when present in the raw payload", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1", extraFields: { customfield_10019: "0|i0001:" } })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "project = ABC ORDER BY rank" });
  const card = payload.issues[0];
  expect(card.customfield_10019).toBeUndefined();
  expect(card.rank).toBeUndefined();
  expect(card.extraFields).toBeUndefined();
});

test("unassigned issues yield assignee: null", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-2", assignee: null })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "assignee is empty" });
  expect(payload.issues[0].assignee).toBeNull();
});

test("first page with isLast:true conveys the exact total and makes no count call", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1" }), makeIssue({ key: "ABC-2" })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "project = ABC" });

  expect(payload.isLast).toBe(true);
  expect(payload.count).toBe(2);
  expect(payload.nextCursor).toBeUndefined();
  expect(payload.hints.join(" ")).toContain("all 2");
  expect(jira.approximateCountCalls).toHaveLength(0);
});

test("isLast:false conveys 'N+ available' without a count call, and returns the cursor", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1" })],
    nextPageToken: "PAGE2",
    isLast: false,
  });
  const { payload } = await run(jira, { jql: "project = ABC", limit: 1 });

  expect(payload.isLast).toBe(false);
  expect(payload.nextCursor).toBe("PAGE2");
  expect(payload.hints.join(" ")).toContain("1+");
  expect(jira.approximateCountCalls).toHaveLength(0);
});

test("passing the cursor back verbatim returns the next page", async () => {
  const jira = new FakeJiraClient().setSearchResponder((params) => {
    if (!params.nextPageToken) {
      return { issues: [makeIssue({ key: "ABC-1" })], nextPageToken: "TOK2", isLast: false };
    }
    expect(params.nextPageToken).toBe("TOK2");
    return { issues: [makeIssue({ key: "ABC-2" })], isLast: true };
  });

  const page1 = await run(jira, { jql: "project = ABC", limit: 1 });
  expect(page1.payload.nextCursor).toBe("TOK2");

  const page2 = await run(jira, { jql: "project = ABC", limit: 1, cursor: page1.payload.nextCursor });
  expect(page2.payload.issues[0].key).toBe("ABC-2");
  expect(page2.payload.isLast).toBe(true);
  expect(page2.payload.nextCursor).toBeUndefined();
});

test("isLast derived from absent nextPageToken when the API omits it", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1" })],
    // no isLast field, no nextPageToken
  });
  const { payload } = await run(jira, { jql: "project = ABC" });
  expect(payload.isLast).toBe(true);
});

test("includeCount:true returns an explicitly-labeled approximate count", async () => {
  const jira = new FakeJiraClient()
    .setSearchResult({ issues: [makeIssue({ key: "ABC-1" })], nextPageToken: "P2", isLast: false })
    .setApproximateCount(317);

  const { payload } = await run(jira, { jql: "project = ABC", includeCount: true });

  expect(payload.approximateCount).toBe(317);
  expect(payload.countIsApproximate).toBe(true);
  expect(payload.hints.join(" ").toLowerCase()).toContain("approximate");
  expect(jira.approximateCountCalls).toEqual(["project = ABC"]);
});

test("includeCount:true overlaps the search and count calls instead of running them sequentially", async () => {
  const events: string[] = [];
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1" })],
    isLast: true,
  });
  // Search resolves quickly; count is deliberately slower. If the calls were
  // still sequential (count started only after search resolved), "end:search"
  // would appear before "start:count". Overlapped, both starts happen up
  // front, before either call finishes.
  const originalSearch = jira.searchJql.bind(jira);
  jira.searchJql = async (params) => {
    events.push("start:search");
    const result = await originalSearch(params);
    await new Promise((r) => setTimeout(r, 5));
    events.push("end:search");
    return result;
  };
  jira.approximateCount = async () => {
    events.push("start:count");
    await new Promise((r) => setTimeout(r, 20));
    events.push("end:count");
    return { count: 42 };
  };

  const { payload } = await run(jira, { jql: "project = ABC", includeCount: true });

  expect(payload.approximateCount).toBe(42);
  expect(events).toEqual(["start:count", "start:search", "end:search", "end:count"]);
});

test("a count-call failure fails the whole search, even though search itself succeeded (unchanged from the prior sequential behavior)", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1" })],
    isLast: true,
  });
  jira.approximateCount = async () => {
    throw new JiraApiError(500, ["approximate-count blew up"], {});
  };

  const { result, payload } = await run(jira, { jql: "project = ABC", includeCount: true });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("jira_http_500");
});

test("a search failure still surfaces the search error even when a concurrently-fired count call would have succeeded", async () => {
  const jira = new FakeJiraClient().setSearchError(authError());
  let countCalled = false;
  jira.approximateCount = async () => {
    countCalled = true;
    return { count: 7 };
  };

  const { result, payload } = await run(jira, { jql: "project = ABC", includeCount: true });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  // The count call still fires (it's overlapped, not gated on search), but its
  // outcome never gets a chance to matter — search's failure wins, exactly as
  // it did when count was only ever invoked after a successful search.
  expect(countCalled).toBe(true);
});

test("both search and count failing does not hang or throw an unhandled rejection — the call still fails cleanly", async () => {
  const jira = new FakeJiraClient().setSearchError(authError());
  jira.approximateCount = async () => {
    await new Promise((r) => setTimeout(r, 5));
    throw new JiraApiError(500, ["count also blew up"], {});
  };

  const { result, payload } = await run(jira, { jql: "project = ABC", includeCount: true });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("omitting includeCount makes no count call", async () => {
  const jira = new FakeJiraClient().setSearchResult({ issues: [], isLast: true });
  await run(jira, { jql: "project = ABC" });
  expect(jira.approximateCountCalls).toHaveLength(0);
});

test("malformed JQL returns the parse error plus a recovery hint pointing at the field catalog", async () => {
  const jira = new FakeJiraClient().setSearchError(
    jqlParseError("Error in the JQL Query: Field 'frobnicate' does not exist."),
  );
  const { result, payload } = await run(jira, { jql: "frobnicate = 1" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("jql_parse_error");
  expect(payload.error.message).toContain("frobnicate");
  expect(payload.hints.join(" ")).toContain("jql-fields");
});

test("an authentication failure returns an auth error with a hint to authenticate", async () => {
  const jira = new FakeJiraClient().setSearchError(authError());
  const { result, payload } = await run(jira, { jql: "project = ABC" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  const hintText = payload.hints.join(" ");
  expect(hintText).toContain("JIRA_API_TOKEN");
  expect(hintText.toLowerCase()).toContain("unscoped");
});

test("every response — success and error — carries a hints array", async () => {
  const ok = new FakeJiraClient().setSearchResult({ issues: [], isLast: true });
  const okRun = await run(ok, { jql: "project = ABC" });
  expect(Array.isArray(okRun.payload.hints)).toBe(true);
  expect(okRun.payload.hints.length).toBeGreaterThan(0);

  const bad = new FakeJiraClient().setSearchError(jqlParseError());
  const badRun = await run(bad, { jql: "bad" });
  expect(Array.isArray(badRun.payload.hints)).toBe(true);
  expect(badRun.payload.hints.length).toBeGreaterThan(0);
});

test("limit defaults to 25 and is capped at 100", async () => {
  const jira = new FakeJiraClient().setSearchResult({ issues: [], isLast: true });

  await run(jira, { jql: "project = ABC" });
  expect(jira.searchCalls[0]?.maxResults).toBe(25);

  await run(jira, { jql: "project = ABC", limit: 500 });
  expect(jira.searchCalls[1]?.maxResults).toBe(100);
});

test("requests the standard card fields (and never requests rank)", async () => {
  const jira = new FakeJiraClient().setSearchResult({ issues: [], isLast: true });
  await run(jira, { jql: "project = ABC" });
  const requested = jira.searchCalls[0]?.fields ?? [];
  expect(requested).toEqual([
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "labels",
    "updated",
  ]);
});

test("additive fields are requested and surfaced under extraFields", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "ABC-1", extraFields: { customfield_10030: 8 } })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "project = ABC", fields: ["customfield_10030"] });

  expect(jira.searchCalls[0]?.fields).toContain("customfield_10030");
  expect(payload.issues[0].extraFields).toEqual({ customfield_10030: 8 });
});

function textOf(r: { content?: unknown }): string {
  const first = (r.content as { type: string; text?: string }[] | undefined)?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

test("fields[] naming card fields adds no extraFields block and leaves the payload unchanged", async () => {
  const issues = [makeIssue({ key: "ABC-1" }), makeIssue({ key: "ABC-2" })];
  const plain = await run(
    new FakeJiraClient().setSearchResult({ issues, isLast: true }),
    { jql: "project = ABC" },
  );
  const withCardFields = await run(
    new FakeJiraClient().setSearchResult({ issues, isLast: true }),
    { jql: "project = ABC", fields: ["status", "priority", "summary", "labels"] },
  );

  expect(withCardFields.payload.issues[0].extraFields).toBeUndefined();
  // Card names are already in the card, so the response is byte-for-byte the
  // lean card payload — no duplicate block, no extra hint.
  expect(textOf(withCardFields.result)).toBe(textOf(plain.result));
});

test("a genuine extra field is flattened to its meaningful value, never a raw field object", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [
      makeIssue({
        key: "ABC-1",
        extraFields: {
          // A single-select custom field, as JIRA returns it raw.
          customfield_10050: {
            self: "https://example.atlassian.net/rest/api/2/customFieldOption/1",
            value: "Backend",
            id: "1",
          },
          // A user-shaped field carrying avatar/self noise.
          reporter: {
            self: "https://example.atlassian.net/rest/api/2/user?accountId=acc-9",
            accountId: "acc-9",
            displayName: "Bob Jones",
            avatarUrls: { "48x48": "https://example.atlassian.net/avatar.png" },
          },
        },
      }),
    ],
    isLast: true,
  });
  const { payload } = await run(jira, {
    jql: "project = ABC",
    fields: ["customfield_10050", "reporter"],
  });

  expect(payload.issues[0].extraFields).toEqual({
    customfield_10050: "Backend",
    reporter: "Bob Jones",
  });
  // No raw JIRA plumbing survives in the data.
  const issuesJson = JSON.stringify(payload.issues);
  expect(issuesJson).not.toContain("avatarUrls");
  expect(issuesJson).not.toContain("iconUrl");
  expect(issuesJson).not.toContain("self");
});

test("a 5-issue search with fields:[status, priority] is no larger than the plain card search", async () => {
  const issues = Array.from({ length: 5 }, (_, i) => makeIssue({ key: `ABC-${i + 1}` }));
  const plain = await run(
    new FakeJiraClient().setSearchResult({ issues, isLast: true }),
    { jql: "project = ABC" },
  );
  const withFields = await run(
    new FakeJiraClient().setSearchResult({ issues, isLast: true }),
    { jql: "project = ABC", fields: ["status", "priority"] },
  );

  expect(textOf(withFields.result).length).toBeLessThanOrEqual(textOf(plain.result).length);
});

// --- Default-project grounding (surface, never mutate) ----------------------

test("the configured default reaches the agent via the tool description, not the JQL", () => {
  const desc = buildSearchDescription("PROJ");
  expect(desc).toContain("PROJ");
  expect(desc).toContain("project = PROJ");
  // No default configured → no mention of one.
  expect(buildSearchDescription(undefined)).not.toContain("default project");
});

test("search never rewrites the agent's JQL — the query reaches JIRA verbatim", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "FOO-1" }), makeIssue({ key: "BAR-1" })],
    isLast: true,
  });
  await run(jira, { jql: "status = Done ORDER BY rank" }, { projectDefault: "PROJ" });
  // The exact string the agent sent — no `project = PROJ` injected.
  expect(jira.searchCalls[0]?.jql).toBe("status = Done ORDER BY rank");
  expect(jira.searchCalls[0]?.jql).not.toContain("PROJ");
});

test("breadth hint: default set + no project clause + results span >1 project", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "PROJ-1" }), makeIssue({ key: "FOO-2" }), makeIssue({ key: "BAR-3" })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "assignee = currentUser()" }, { projectDefault: "PROJ" });

  const hintText = payload.hints.join(" ");
  expect(hintText).toContain("PROJ");
  expect(hintText).toContain("FOO");
  expect(hintText).toContain("BAR");
  expect(hintText).toContain("project = PROJ");
});

test("no breadth hint when results stay within a single project", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "PROJ-1" }), makeIssue({ key: "PROJ-2" })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "assignee = currentUser()" }, { projectDefault: "PROJ" });
  expect(payload.hints.join(" ")).not.toContain("span");
});

test("no breadth hint when the JQL already scopes to a project, even if multiple appear", async () => {
  // Pathological multi-project page, but the agent explicitly used a project clause:
  // its intent is clear, so we don't second-guess it.
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "PROJ-1" }), makeIssue({ key: "FOO-2" })],
    isLast: true,
  });
  const { payload } = await run(
    jira,
    { jql: "project in (PROJ, FOO)" },
    { projectDefault: "PROJ" },
  );
  expect(payload.hints.join(" ")).not.toContain("span");
});

test("no breadth hint when no default is configured, even on a multi-project page", async () => {
  const jira = new FakeJiraClient().setSearchResult({
    issues: [makeIssue({ key: "FOO-1" }), makeIssue({ key: "BAR-2" })],
    isLast: true,
  });
  const { payload } = await run(jira, { jql: "assignee = currentUser()" });
  expect(payload.hints.join(" ")).not.toContain("span");
});
