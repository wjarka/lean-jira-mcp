/**
 * jira_create_issue handler, driven end-to-end against the faked JiraClient.
 * Asserts on the shaped MCP response the agent sees and on the write payload
 * sent to the JIRA seam — never on internals.
 *
 * Two design invariants get explicit coverage here (both flagged for review):
 *   - createmeta is fetched ONLY after a create failure, never proactively.
 *   - parent resolution is tested for BOTH company- and team-managed projects.
 */

import { test, expect } from "bun:test";
import {
  createIssueHandler,
  createIssueInputSchema,
  type CreateIssueDeps,
} from "../src/tools/create-issue.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import { FakeJiraClient, makeIssue, makeBoard } from "./helpers/fake-jira-client.ts";
import {
  staticCuratedFieldsProvider,
} from "../src/lib/curated-field-provider.ts";
import { buildCuratedFields, DEFAULT_CURATED_FIELD_IDS } from "../src/lib/custom-fields.ts";

const SPRINT_FIELD = "customfield_10020";
const EPIC_FIELD = "customfield_10014";

const DEPS: CreateIssueDeps = {
  projectDefault: "DEF",
  baseUrl: "https://acme.atlassian.net",
};

/** A scrum board carrying the given active sprint id, paired with a Kanban board. */
function boardsWithActiveSprint(id: number, name = `Sprint ${id}`) {
  return [
    makeBoard({ id: 1, name: "DEF Kanban", type: "kanban" }),
    makeBoard({ id: 2, name: "DEF Scrum", type: "scrum", sprints: [{ id, name, state: "active" }] }),
  ];
}

async function run(jira: FakeJiraClient, raw: Record<string, unknown>, deps: CreateIssueDeps = DEPS) {
  const args = createIssueInputSchema.parse(raw);
  const result = await createIssueHandler(jira, args, deps);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

function readyClient() {
  return new FakeJiraClient().setCreatedIssue({ id: "10001", key: "DEF-1" });
}

// --- happy path -------------------------------------------------------------

test("creating with only a summary defaults project + issuetype and returns {key,url}", async () => {
  const jira = readyClient();
  const { payload } = await run(jira, { summary: "Do the thing" });

  expect(payload.key).toBe("DEF-1");
  expect(payload.url).toBe("https://acme.atlassian.net/browse/DEF-1");
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);

  expect(jira.createIssueCalls).toHaveLength(1);
  const fields = jira.createIssueCalls[0]!.fields!;
  expect(fields.project).toEqual({ key: "DEF" });
  expect(fields.issuetype).toEqual({ name: "Task" });
  expect(fields.summary).toBe("Do the thing");
});

test("createmeta is NOT fetched on a successful create (no proactive round-trip)", async () => {
  const jira = readyClient();
  await run(jira, { summary: "Do the thing" });
  expect(jira.createMetaCalls).toHaveLength(0);
});

test("an explicit project and issuetype override the defaults", async () => {
  const jira = readyClient().setCreatedIssue({ id: "1", key: "ABC-9" });
  await run(jira, { summary: "x", project: "ABC", issuetype: "Bug" });
  const fields = jira.createIssueCalls[0]!.fields!;
  expect(fields.project).toEqual({ key: "ABC" });
  expect(fields.issuetype).toEqual({ name: "Bug" });
});

test("no project arg and no default is rejected before any create call", async () => {
  const jira = readyClient();
  const { result, payload } = await run(jira, { summary: "x" }, { ...DEPS, projectDefault: undefined });
  expect(result.isError).toBe(true);
  expect(payload.hints.join(" ")).toMatch(/project/i);
  expect(jira.createIssueCalls).toHaveLength(0);
});

// --- markdown description → ADF round-trip ----------------------------------

test("a markdown description is converted to ADF and round-trips back to markdown", async () => {
  const jira = readyClient();
  const md = "A paragraph with **bold** and `code`.";
  await run(jira, { summary: "x", description: md });

  const description = jira.createIssueCalls[0]!.fields!.description as { type: string };
  expect(description.type).toBe("doc");
  expect(adfToMarkdown(description)).toBe(md);
});

test("a description that degrades on write notes the difference in the success hints", async () => {
  const jira = readyClient();
  const { result, payload } = await run(jira, {
    summary: "x",
    description: "See ![diagram](http://img/d.png).",
  });
  expect(result.isError).toBeUndefined();
  expect(payload.key).toBe("DEF-1");
  expect(payload.hints.join(" ")).toMatch(/differs/i);
});

test("a fully-supported description produces no stored-body-differs note", async () => {
  const jira = readyClient();
  const { payload } = await run(jira, { summary: "x", description: "Just **bold** text." });
  expect(payload.hints.join(" ")).not.toMatch(/differs/i);
});

// --- parent: company- vs team-managed (both paths) --------------------------

test("parent in a TEAM-managed project is sent via the `parent` field", async () => {
  const jira = readyClient()
    .setProject({ id: "1", key: "DEF", style: "next-gen", simplified: true })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { payload } = await run(jira, { summary: "x", parent: "DEF-100" });

  const fields = jira.createIssueCalls[0]!.fields!;
  expect(fields.parent).toEqual({ key: "DEF-100" });
  expect(fields[EPIC_FIELD]).toBeUndefined();
  // The success hint NAMES the parent, so a silent team-managed drop is detectable.
  expect(payload.hints.join(" ")).toMatch(/under DEF-100/);
});

test("parent in a COMPANY-managed project is sent via the Epic Link custom field", async () => {
  const jira = readyClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { payload } = await run(jira, { summary: "x", parent: "DEF-100" });

  const fields = jira.createIssueCalls[0]!.fields!;
  expect(fields[EPIC_FIELD]).toBe("DEF-100");
  expect(fields.parent).toBeUndefined();
  expect(payload.hints.join(" ")).toMatch(/under DEF-100/);
});

test("an unresolvable parent is rejected before any create call (nothing created)", async () => {
  // No setIssue → the fake's getIssue throws 404, modelling a missing parent.
  const jira = readyClient().setProject({ id: "1", key: "DEF", style: "next-gen", simplified: true });
  const { result, payload } = await run(jira, { summary: "x", parent: "DEF-999" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("parent_not_found");
  expect(payload.hints.join(" ")).toMatch(/DEF-999/);
  expect(jira.createIssueCalls).toHaveLength(0);
});

// --- epic-link write targets the DETECTED id (issue 15 A2) ------------------

test("company-managed epic-link write targets the per-instance DETECTED id, not the static default", async () => {
  // Provider detected a non-default epic-link id; the write must use IT.
  const detected = "customfield_19999";
  const provider = staticCuratedFieldsProvider(
    buildCuratedFields({ ...DEFAULT_CURATED_FIELD_IDS, epicLink: detected }),
  );
  const jira = readyClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { payload } = await run(jira, { summary: "x", parent: "DEF-100" }, { ...DEPS, curatedFieldsProvider: provider });

  const fields = jira.createIssueCalls[0]!.fields!;
  expect(fields[detected]).toBe("DEF-100");
  expect(fields[EPIC_FIELD]).toBeUndefined();
  expect(payload.hints.join(" ")).toMatch(/under DEF-100/);
});

test("an undetectable epic-link id degrades visibly (company-managed) — no guessed write", async () => {
  // Provider omits epicLink entirely (detection ran, didn't find it, no override).
  const provider = staticCuratedFieldsProvider(
    buildCuratedFields(DEFAULT_CURATED_FIELD_IDS).filter((f) => f.friendlyName !== "epicLink"),
  );
  const jira = readyClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { result, payload } = await run(jira, { summary: "x", parent: "DEF-100" }, { ...DEPS, curatedFieldsProvider: provider });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("epic_link_unavailable");
  expect(payload.hints.join(" ")).toMatch(/JIRA_FIELD_EPIC_LINK/);
  expect(jira.createIssueCalls).toHaveLength(0);
});

test("a TEAM-managed parent never hits the epic-link degradation (uses `parent`)", async () => {
  // Even with epicLink omitted, a team-managed project resolves via `parent`.
  const provider = staticCuratedFieldsProvider(
    buildCuratedFields(DEFAULT_CURATED_FIELD_IDS).filter((f) => f.friendlyName !== "epicLink"),
  );
  const jira = readyClient()
    .setProject({ id: "1", key: "DEF", style: "next-gen", simplified: true })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { result } = await run(jira, { summary: "x", parent: "DEF-100" }, { ...DEPS, curatedFieldsProvider: provider });

  expect(result.isError).toBeUndefined();
  expect(jira.createIssueCalls[0]!.fields!.parent).toEqual({ key: "DEF-100" });
});

// --- sprint: assigned via the Agile MOVE endpoint, never a field write ------

test("a sprint id is assigned via the Agile endpoint after create, not as a create field", async () => {
  const jira = readyClient();
  await run(jira, { summary: "x", sprint: 7 });
  // Sprint is NOT a field on the create payload — it rides the Agile move.
  expect(jira.createIssueCalls[0]!.fields![SPRINT_FIELD]).toBeUndefined();
  expect(jira.addIssueToSprintCalls).toEqual([{ sprintId: 7, issueKey: "DEF-1" }]);
  // A numeric id needs no board lookup.
  expect(jira.listProjectBoardsCalls).toHaveLength(0);
});

test("sprint `current` resolves to the single active scrum sprint, then moves the issue", async () => {
  const jira = readyClient().setProjectBoards(boardsWithActiveSprint(9));
  await run(jira, { summary: "x", sprint: "current" });
  expect(jira.createIssueCalls[0]!.fields![SPRINT_FIELD]).toBeUndefined();
  expect(jira.addIssueToSprintCalls).toEqual([{ sprintId: 9, issueKey: "DEF-1" }]);
});

test("an ambiguous `current` sprint returns candidates as a hint and does not create", async () => {
  const jira = readyClient().setProjectBoards([
    makeBoard({ id: 2, name: "Scrum A", type: "scrum", sprints: [{ id: 9, name: "Sprint 9", state: "active" }] }),
    makeBoard({ id: 3, name: "Scrum B", type: "scrum", sprints: [{ id: 10, name: "Hotfix", state: "active" }] }),
  ]);
  const { result, payload } = await run(jira, { summary: "x", sprint: "current" });

  expect(result.isError).toBe(true);
  expect(jira.createIssueCalls).toHaveLength(0);
  expect(jira.addIssueToSprintCalls).toHaveLength(0);
  expect(payload.error.code).toBe("sprint_ambiguous");
  expect(payload.hints.join(" ")).toMatch(/Sprint 9.*Hotfix|Hotfix.*Sprint 9/);
});

test("a Kanban-only project returns 'no sprint-supporting board', not a 400 passthrough", async () => {
  const jira = readyClient().setProjectBoards([makeBoard({ id: 1, name: "DEF Kanban", type: "kanban" })]);
  const { result, payload } = await run(jira, { summary: "x", sprint: "current" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_no_board");
  expect(payload.hints.join(" ")).toMatch(/no sprint-supporting/i);
  expect(jira.createIssueCalls).toHaveLength(0);
});

test("create-then-move is non-atomic: a move failure after create reports the issue is in the backlog", async () => {
  const jira = readyClient().setAddIssueToSprintError(new JiraApiError(400, ["Sprint is closed."], {}));
  const { result, payload } = await run(jira, { summary: "x", sprint: 7 });

  // The create SUCCEEDED — we don't pretend atomicity or roll back.
  expect(result.isError).toBeUndefined();
  expect(payload.key).toBe("DEF-1");
  expect(jira.createIssueCalls).toHaveLength(1);
  expect(jira.addIssueToSprintCalls).toHaveLength(1);
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/sprint 7 assignment failed/i);
  expect(hint).toMatch(/backlog/i);
});

test("a numeric sprint id that matches no sprint lists the available sprints in the move-failure note", async () => {
  // Issue is created, then the move to a non-existent id 999 fails; the note must
  // teach the project's real open sprints + ids so the agent can retry.
  const jira = readyClient()
    .setProjectBoards([
      makeBoard({
        id: 2,
        name: "DEF Scrum",
        type: "scrum",
        sprints: [{ id: 9, name: "Sprint 9", state: "active" }],
      }),
    ])
    .setAddIssueToSprintError(new JiraApiError(404, ["Sprint does not exist."], {}));

  const { result, payload } = await run(jira, { summary: "x", sprint: 999 });

  expect(result.isError).toBeUndefined();
  expect(payload.key).toBe("DEF-1");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/backlog/i);
  expect(hint).toMatch(/Available sprints/i);
  expect(hint).toMatch(/Sprint 9.*id 9/);
});

test("sprint `null` on create is rejected with a teaching hint, not a raw type error", async () => {
  const jira = readyClient();
  const { result, payload } = await run(jira, { summary: "x", sprint: null });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_null_on_create");
  expect(payload.hints.join(" ")).toMatch(/backlog|omit/i);
  expect(jira.createIssueCalls).toHaveLength(0);
});

// --- assignee ---------------------------------------------------------------

test("assignee by display name resolves to an accountId (agent never passes one)", async () => {
  const jira = readyClient().setUsers([{ accountId: "acc-7", displayName: "Alice", emailAddress: "a@x.com" }]);
  await run(jira, { summary: "x", assignee: "Alice" });
  expect(jira.createIssueCalls[0]!.fields!.assignee).toEqual({ accountId: "acc-7" });
});

test("assignee `me` resolves via the current user", async () => {
  const jira = readyClient().setCurrentUser({ accountId: "acc-me", displayName: "Me" });
  await run(jira, { summary: "x", assignee: "me" });
  expect(jira.createIssueCalls[0]!.fields!.assignee).toEqual({ accountId: "acc-me" });
});

test("an unresolvable assignee is rejected before any create call", async () => {
  const jira = readyClient().setUsers([]);
  const { result, payload } = await run(jira, { summary: "x", assignee: "ghost@x.com" });
  expect(result.isError).toBe(true);
  expect(jira.createIssueCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/ghost@x\.com|no.*user/i);
});

test("an ambiguous assignee returns the candidates rather than guessing", async () => {
  const jira = readyClient().setUsers([
    { accountId: "a1", displayName: "Alex", emailAddress: "a1@x.com" },
    { accountId: "a2", displayName: "Alex", emailAddress: "a2@x.com" },
  ]);
  const { result, payload } = await run(jira, { summary: "x", assignee: "Alex" });
  expect(result.isError).toBe(true);
  expect(jira.createIssueCalls).toHaveLength(0);
  expect(payload.error.options).toBeDefined();
});

// --- failure recovery: createmeta only on failure ---------------------------

test("a create that fails for missing required fields returns the required-field list, fetching createmeta only then", async () => {
  const jira = readyClient()
    .setCreateError(
      new JiraApiError(400, [], { customfield_10050: "Team is required." }),
    )
    .setCreateMeta({
      issueTypes: [{ id: "1", name: "Task" }],
      requiredFields: [
        { fieldId: "summary", name: "Summary" },
        { fieldId: "customfield_10050", name: "Team" },
      ],
    });

  const { result, payload } = await run(jira, { summary: "x", project: "ABC", issuetype: "Task" });

  expect(result.isError).toBe(true);
  // createmeta fetched exactly once, AFTER the create attempt.
  expect(jira.createIssueCalls).toHaveLength(1);
  expect(jira.createMetaCalls).toEqual([{ projectKey: "ABC", issuetypeName: "Task" }]);
  expect(payload.hints.join(" ")).toMatch(/Team/);
  expect(payload.error.options).toContain("Team");
});

test("an invalid issuetype is rejected with a hint listing the valid types", async () => {
  const jira = readyClient()
    .setCreateError(new JiraApiError(400, [], { issuetype: "The issue type selected is invalid." }))
    .setCreateMeta({
      issueTypes: [
        { id: "1", name: "Task" },
        { id: "2", name: "Bug" },
        { id: "3", name: "Story" },
      ],
      requiredFields: [],
    });

  const { result, payload } = await run(jira, { summary: "x", project: "ABC", issuetype: "Epic" });

  expect(result.isError).toBe(true);
  expect(jira.createMetaCalls).toHaveLength(1);
  expect(payload.error.code).toBe("invalid_issuetype");
  expect(payload.hints.join(" ")).toMatch(/Task.*Bug.*Story/);
  expect(payload.error.options).toEqual(["Task", "Bug", "Story"]);
});

test("a field JIRA rejects (not a missing required field) is surfaced verbatim, not mislabeled", async () => {
  // A bad priority: JIRA names the field it refused; createmeta lists no
  // required fields. The hint must report JIRA's actual message, not pretend a
  // required field is missing. (Parent is now validated up front, so this uses
  // a field JIRA only rejects at create time.)
  const jira = readyClient()
    .setProject({ id: "1", key: "ABC", style: "classic" })
    .setCreateError(new JiraApiError(400, [], { priority: "Specify a valid priority." }))
    .setCreateMeta({ issueTypes: [{ id: "1", name: "Task" }], requiredFields: [] });

  const { result, payload } = await run(jira, { summary: "x", project: "ABC", priority: "Frobnicate" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("field_validation_failed");
  expect(payload.hints.join(" ")).toMatch(/valid priority/);
  expect(jira.createMetaCalls).toHaveLength(1);
});

test("a bare INVALID_INPUT with a description names the rich-text field, not a dead-end raw error (issue 20)", async () => {
  // JIRA rejects with a top-level INVALID_INPUT and NO field-level detail, and
  // createmeta surfaces no missing required field. With a markdown description
  // in the payload, the conversion is the likely culprit — the hint must say so.
  const jira = readyClient()
    .setCreateError(new JiraApiError(400, ["INVALID_INPUT"], {}))
    .setCreateMeta({ issueTypes: [{ id: "1", name: "Task" }], requiredFields: [] });

  const { result, payload } = await run(jira, {
    summary: "x",
    project: "ABC",
    description: "some **rich** text",
  });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("rich_text_validation_failed");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/description/i);
  expect(hint).toMatch(/markdown.*ADF|conversion/i);
  // Not the useless bare hint the reporter got.
  expect(payload.hints).not.toEqual(["INVALID_INPUT"]);
});

test("a bare INVALID_INPUT with NO description falls through to the generic field-validation path", async () => {
  // No rich text was sent, so the rich-text hint must NOT fire.
  const jira = readyClient()
    .setCreateError(new JiraApiError(400, ["INVALID_INPUT"], {}))
    .setCreateMeta({ issueTypes: [{ id: "1", name: "Task" }], requiredFields: [] });

  const { result, payload } = await run(jira, { summary: "x", project: "ABC" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).not.toBe("rich_text_validation_failed");
});

// --- auth -------------------------------------------------------------------

test("an auth failure is shaped with the credential-recovery guidance", async () => {
  const jira = readyClient().setCreateError(new JiraApiError(401, ["unauthenticated"], {}));
  const { result, payload } = await run(jira, { summary: "x" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  // No metadata round-trip on an auth failure.
  expect(jira.createMetaCalls).toHaveLength(0);
});
