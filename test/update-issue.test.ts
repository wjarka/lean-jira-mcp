/**
 * jira_update_issue handler, driven end-to-end against the faked JiraClient.
 * Asserts on the shaped MCP response the agent sees and on the `{fields, update}`
 * write payload sent to the JIRA seam — never on internals.
 *
 * The behaviors that define this slice (and the issue-11 reuse it must NOT
 * regress) get explicit coverage:
 *   - non-destructive add/remove vs explicit set-all on multi-value fields;
 *   - presence-aware partial update (absent = leave, null = clear), incl. unassign;
 *   - parent through the discriminated resolveParent (named in the success hint);
 *   - description through convertMarkdown with degradation folded into hints.
 */

import { test, expect } from "bun:test";
import {
  updateIssueHandler,
  updateIssueInputSchema,
  type UpdateIssueDeps,
} from "../src/tools/update-issue.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";
import { FakeJiraClient, makeIssue, makeBoard } from "./helpers/fake-jira-client.ts";
import { staticCuratedFieldsProvider } from "../src/lib/curated-field-provider.ts";
import { buildCuratedFields, DEFAULT_CURATED_FIELD_IDS } from "../src/lib/custom-fields.ts";

const EPIC_FIELD = "customfield_10014";

const DEPS: UpdateIssueDeps = {
  baseUrl: "https://acme.atlassian.net",
};

/** A scrum board carrying the given active sprint id, paired with a Kanban board. */
function boardsWithActiveSprint(id: number, name = `Sprint ${id}`) {
  return [
    makeBoard({ id: 1, name: "ABC Kanban", type: "kanban" }),
    makeBoard({ id: 2, name: "ABC Scrum", type: "scrum", sprints: [{ id, name, state: "active" }] }),
  ];
}

async function run(jira: FakeJiraClient, raw: Record<string, unknown>, deps: UpdateIssueDeps = DEPS) {
  const args = updateIssueInputSchema.parse(raw);
  const result = await updateIssueHandler(jira, args, deps);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

function lastPayload(jira: FakeJiraClient) {
  expect(jira.updateIssueCalls).toHaveLength(1);
  return jira.updateIssueCalls[0]!;
}

// --- multi-value: non-destructive add/remove vs explicit set ----------------

test("addLabels/removeLabels route to native update ops and never clobber the array", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, {
    issueKey: "ABC-1",
    addLabels: ["alpha", "beta"],
    removeLabels: ["stale"],
  });

  const sent = lastPayload(jira);
  expect(sent.issueKey).toBe("ABC-1");
  expect(sent.update!.labels).toEqual([{ add: "alpha" }, { add: "beta" }, { remove: "stale" }]);
  // add/remove must NOT touch the fields section (that would replace the array).
  expect(sent.fields?.labels).toBeUndefined();
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("setLabels replaces the whole array via the fields section, distinct from add/remove", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", setLabels: ["only", "these"] });

  const sent = lastPayload(jira);
  expect(sent.fields!.labels).toEqual(["only", "these"]);
  expect(sent.update?.labels).toBeUndefined();
});

test("the add/remove vs set distinction works for components", async () => {
  const add = new FakeJiraClient();
  await run(add, { issueKey: "ABC-1", addComponents: ["UI"], removeComponents: ["Legacy"] });
  expect(lastPayload(add).update!.components).toEqual([
    { add: { name: "UI" } },
    { remove: { name: "Legacy" } },
  ]);

  const set = new FakeJiraClient();
  await run(set, { issueKey: "ABC-1", setComponents: ["UI", "API"] });
  expect(lastPayload(set).fields!.components).toEqual([{ name: "UI" }, { name: "API" }]);
});

test("the add/remove vs set distinction works for fixVersions", async () => {
  const add = new FakeJiraClient();
  await run(add, { issueKey: "ABC-1", addFixVersions: ["2.0"] });
  expect(lastPayload(add).update!.fixVersions).toEqual([{ add: { name: "2.0" } }]);

  const set = new FakeJiraClient();
  await run(set, { issueKey: "ABC-1", setFixVersions: ["2.0", "2.1"] });
  expect(lastPayload(set).fields!.fixVersions).toEqual([{ name: "2.0" }, { name: "2.1" }]);
});

test("combining setLabels with addLabels is rejected, not silently sent", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    setLabels: ["a"],
    addLabels: ["b"],
  });
  expect(result.isError).toBe(true);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/labels/i);
});

// --- label normalization ----------------------------------------------------

test("a label containing spaces is rejected with the rule, and nothing is updated", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, { issueKey: "ABC-1", addLabels: ["needs review"] });
  expect(result.isError).toBe(true);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/space/i);
});

// --- presence-aware: absent leaves, null clears -----------------------------

test("an absent field is left untouched — only the passed field is in the payload", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", summary: "New title" });

  const sent = lastPayload(jira);
  expect(sent.fields!.summary).toBe("New title");
  expect(sent.fields!).not.toHaveProperty("assignee");
  expect(sent.fields!).not.toHaveProperty("priority");
});

test("assignee:null unassigns (fields.assignee = null) while an absent assignee is untouched", async () => {
  const cleared = new FakeJiraClient();
  await run(cleared, { issueKey: "ABC-1", assignee: null });
  const sent = lastPayload(cleared);
  expect(sent.fields!).toHaveProperty("assignee");
  expect(sent.fields!.assignee).toBeNull();
  // Clearing must not run a user search.
  expect(cleared.searchUsersCalls).toHaveLength(0);

  const untouched = new FakeJiraClient();
  await run(untouched, { issueKey: "ABC-1", summary: "x" });
  expect(untouched.updateIssueCalls[0]!.fields!).not.toHaveProperty("assignee");
});

test("priority:null and description:null clear those fields", async () => {
  const jira = new FakeJiraClient();
  await run(jira, { issueKey: "ABC-1", priority: null, description: null });
  const sent = lastPayload(jira);
  expect(sent.fields!.priority).toBeNull();
  expect(sent.fields!.description).toBeNull();
});

test("an update with no actual fields is rejected before any write", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, { issueKey: "ABC-1" });
  expect(result.isError).toBe(true);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(payload.hints.length).toBeGreaterThan(0);
});

// --- scalar fields through the shared field-builder -------------------------

test("scalar edits go through the field-builder: summary, priority, duedate", async () => {
  const jira = new FakeJiraClient();
  await run(jira, {
    issueKey: "ABC-1",
    summary: "Renamed",
    priority: "High",
    duedate: "2026-07-01",
  });
  const fields = lastPayload(jira).fields!;
  expect(fields.summary).toBe("Renamed");
  expect(fields.priority).toEqual({ name: "High" });
  expect(fields.duedate).toBe("2026-07-01");
});

test("a markdown description is converted to ADF and round-trips back to markdown", async () => {
  const jira = new FakeJiraClient();
  const md = "Updated body with **bold** and `code`.";
  await run(jira, { issueKey: "ABC-1", description: md });

  const description = lastPayload(jira).fields!.description as { type: string };
  expect(description.type).toBe("doc");
  expect(adfToMarkdown(description)).toBe(md);
});

test("a description that degrades on write notes the difference in the success hints", async () => {
  const jira = new FakeJiraClient();
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    description: "See ![diagram](http://img/d.png).",
  });
  expect(result.isError).toBeUndefined();
  expect(payload.hints.join(" ")).toMatch(/differs/i);
});

test("a fully-supported description produces no stored-body-differs note", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", description: "Just **bold** text." });
  expect(payload.hints.join(" ")).not.toMatch(/differs/i);
});

// --- assignee / reporter resolution -----------------------------------------

test("assignee by display name resolves to an accountId (agent never passes one)", async () => {
  const jira = new FakeJiraClient().setUsers([
    { accountId: "acc-7", displayName: "Alice", emailAddress: "a@x.com" },
  ]);
  await run(jira, { issueKey: "ABC-1", assignee: "Alice" });
  expect(lastPayload(jira).fields!.assignee).toEqual({ accountId: "acc-7" });
});

test("an unresolvable assignee is rejected before any update call", async () => {
  const jira = new FakeJiraClient().setUsers([]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", assignee: "ghost@x.com" });
  expect(result.isError).toBe(true);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/ghost@x\.com|no.*user/i);
});

test("reporter resolves through the same user resolver", async () => {
  const jira = new FakeJiraClient().setUsers([
    { accountId: "acc-9", displayName: "Bob", emailAddress: "b@x.com" },
  ]);
  await run(jira, { issueKey: "ABC-1", reporter: "Bob" });
  expect(lastPayload(jira).fields!.reporter).toEqual({ accountId: "acc-9" });
});

test("a reporter change the project forbids returns a clear permission hint, not a raw error", async () => {
  const jira = new FakeJiraClient()
    .setUsers([{ accountId: "acc-9", displayName: "Bob", emailAddress: "b@x.com" }])
    .setUpdateIssueError(
      new JiraApiError(400, [], { reporter: "Field 'reporter' cannot be set. You do not have permission." }),
    );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", reporter: "Bob" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("reporter_not_permitted");
  expect(payload.hints.join(" ")).toMatch(/reporter/i);
  expect(payload.hints.join(" ")).toMatch(/permission/i);
});

test("a 403 during a reporter change is shaped as auth guidance, not reporter_not_permitted", async () => {
  // A 403 means a broader permission/credential problem that "retry without
  // reporter" can't fix — the auth boundary must win over the reporter branch.
  const jira = new FakeJiraClient()
    .setUsers([{ accountId: "acc-9", displayName: "Bob", emailAddress: "b@x.com" }])
    .setUpdateIssueError(new JiraApiError(403, ["You do not have permission to edit the reporter."], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", reporter: "Bob" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("a bare INVALID_INPUT with a description names the rich-text field (issue 20)", async () => {
  // A detailless validation rejection (empty `errors` map) on an update that
  // sent a markdown description: point at the conversion, not a generic hint.
  const jira = new FakeJiraClient().setUpdateIssueError(new JiraApiError(400, ["INVALID_INPUT"], {}));
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    description: "some **rich** text",
  });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("rich_text_validation_failed");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/description/i);
  expect(hint).toMatch(/markdown.*ADF|conversion/i);
});

test("a bare INVALID_INPUT with NO description falls through to generic field validation", async () => {
  const jira = new FakeJiraClient().setUpdateIssueError(new JiraApiError(400, ["INVALID_INPUT"], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", summary: "just a summary" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("field_validation_failed");
});

test("clearing the description (null) is NOT treated as a rich-text write on a bare INVALID_INPUT", async () => {
  // `description: null` sends no converted content, so it can't be the culprit.
  const jira = new FakeJiraClient().setUpdateIssueError(new JiraApiError(400, ["INVALID_INPUT"], {}));
  const { payload } = await run(jira, { issueKey: "ABC-1", description: null });
  expect(payload.error.code).not.toBe("rich_text_validation_failed");
});

// --- parent through the discriminated resolveParent (issue-11 reuse) --------

test("parent in a TEAM-managed project is sent via the `parent` field and named in the hint", async () => {
  const jira = new FakeJiraClient()
    .setProject({ id: "1", key: "DEF", style: "next-gen", simplified: true })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { payload } = await run(jira, { issueKey: "DEF-1", parent: "DEF-100" });

  const fields = lastPayload(jira).fields!;
  expect(fields.parent).toEqual({ key: "DEF-100" });
  expect(fields[EPIC_FIELD]).toBeUndefined();
  expect(payload.hints.join(" ")).toMatch(/DEF-100/);
});

test("parent in a COMPANY-managed project is sent via the Epic Link custom field", async () => {
  const jira = new FakeJiraClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { payload } = await run(jira, { issueKey: "DEF-1", parent: "DEF-100" });

  const fields = lastPayload(jira).fields!;
  expect(fields[EPIC_FIELD]).toBe("DEF-100");
  expect(fields.parent).toBeUndefined();
  expect(payload.hints.join(" ")).toMatch(/DEF-100/);
});

test("an unresolvable parent is rejected before any update (nothing changed)", async () => {
  // No setIssue → the fake's getIssue throws 404, modelling a missing parent.
  const jira = new FakeJiraClient().setProject({
    id: "1",
    key: "DEF",
    style: "next-gen",
    simplified: true,
  });
  const { result, payload } = await run(jira, { issueKey: "DEF-1", parent: "DEF-999" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("parent_not_found");
  expect(payload.hints.join(" ")).toMatch(/DEF-999/);
  expect(payload.hints.join(" ")).toMatch(/nothing|not changed|no.*change/i);
  expect(jira.updateIssueCalls).toHaveLength(0);
});

// --- epic-link write targets the DETECTED id (issue 15 A2) ------------------

test("company-managed epic-link write targets the per-instance DETECTED id, not the static default", async () => {
  const detected = "customfield_19999";
  const provider = staticCuratedFieldsProvider(
    buildCuratedFields({ ...DEFAULT_CURATED_FIELD_IDS, epicLink: detected }),
  );
  const jira = new FakeJiraClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  await run(jira, { issueKey: "DEF-1", parent: "DEF-100" }, { ...DEPS, curatedFieldsProvider: provider });

  const fields = lastPayload(jira).fields!;
  expect(fields[detected]).toBe("DEF-100");
  expect(fields[EPIC_FIELD]).toBeUndefined();
});

test("an undetectable epic-link id degrades visibly (company-managed) — no guessed write", async () => {
  const provider = staticCuratedFieldsProvider(
    buildCuratedFields(DEFAULT_CURATED_FIELD_IDS).filter((f) => f.friendlyName !== "epicLink"),
  );
  const jira = new FakeJiraClient()
    .setProject({ id: "2", key: "DEF", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "DEF-100" }));
  const { result, payload } = await run(jira, { issueKey: "DEF-1", parent: "DEF-100" }, { ...DEPS, curatedFieldsProvider: provider });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("epic_link_unavailable");
  expect(payload.hints.join(" ")).toMatch(/JIRA_FIELD_EPIC_LINK/);
  expect(jira.updateIssueCalls).toHaveLength(0);
});

// --- sprint: assigned via the Agile MOVE endpoint, never a field write ------

test("a sprint id is assigned via the Agile endpoint, not written to the Sprint field", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", sprint: 7 });
  // No field PUT at all — sprint-only change rides the Agile move.
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(jira.addIssueToSprintCalls).toEqual([{ sprintId: 7, issueKey: "ABC-1" }]);
  expect(jira.listProjectBoardsCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/sprint 7/i);
});

test("sprint `current` resolves to the active scrum sprint and moves the issue", async () => {
  const jira = new FakeJiraClient().setProjectBoards(boardsWithActiveSprint(9));
  await run(jira, { issueKey: "ABC-1", sprint: "current" });
  expect(jira.addIssueToSprintCalls).toEqual([{ sprintId: 9, issueKey: "ABC-1" }]);
});

test("sprint `null` moves the issue to the backlog (clear)", async () => {
  const jira = new FakeJiraClient();
  const { payload } = await run(jira, { issueKey: "ABC-1", sprint: null });
  expect(jira.moveIssueToBacklogCalls).toEqual(["ABC-1"]);
  expect(jira.addIssueToSprintCalls).toHaveLength(0);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(payload.hints.join(" ")).toMatch(/backlog/i);
});

test("a numeric sprint id that matches no sprint returns the available sprints (names + ids) as a hint", async () => {
  // numeric = id, fired directly (no board lookup on the happy path); the id
  // doesn't exist, so the Agile move 404s. The recovery hint must list the
  // project's real open sprints + ids — restoring the recovery-hint invariant.
  const jira = new FakeJiraClient()
    .setProjectBoards([
      makeBoard({
        id: 2,
        name: "ABC Scrum",
        type: "scrum",
        sprints: [
          { id: 9, name: "Sprint 9", state: "active" },
          { id: 11, name: "Backlog Polish", state: "future" },
        ],
      }),
    ])
    .setAddIssueToSprintError(new JiraApiError(404, ["Sprint does not exist."], {}));

  const { result, payload } = await run(jira, { issueKey: "ABC-1", sprint: 999 });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_move_failed");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/Available sprints/i);
  expect(hint).toMatch(/Sprint 9.*id 9/);
  expect(hint).toMatch(/Backlog Polish.*id 11/);
  // Structured options carry the candidate ids too.
  expect(payload.error.options.map((o: any) => o.id).sort((a: number, b: number) => a - b)).toEqual([9, 11]);
});

test("a clear (sprint:null) move failure does NOT suggest assigning a sprint", async () => {
  // The agent was REMOVING the sprint; the recovery hint must not list sprints to
  // pass, and the board lookup is skipped entirely.
  const jira = new FakeJiraClient()
    .setProjectBoards([
      makeBoard({ id: 2, name: "ABC Scrum", type: "scrum", sprints: [{ id: 9, name: "Sprint 9", state: "active" }] }),
    ])
    .setMoveIssueToBacklogError(new JiraApiError(400, ["Cannot move issue to backlog."], {}));

  const { result, payload } = await run(jira, { issueKey: "ABC-1", sprint: null });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_move_failed");
  const hint = payload.hints.join(" ");
  expect(hint).not.toMatch(/Available sprints/i);
  expect(hint).not.toMatch(/Pass a valid sprint/i);
  expect(payload.error.options).toBeUndefined();
  expect(jira.listProjectBoardsCalls).toHaveLength(0);
});

test("an ambiguous `current` sprint returns candidates as a hint and does not change anything", async () => {
  const jira = new FakeJiraClient().setProjectBoards([
    makeBoard({ id: 2, name: "Scrum A", type: "scrum", sprints: [{ id: 9, name: "Sprint 9", state: "active" }] }),
    makeBoard({ id: 3, name: "Scrum B", type: "scrum", sprints: [{ id: 10, name: "Hotfix", state: "active" }] }),
  ]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", sprint: "current" });
  expect(result.isError).toBe(true);
  expect(jira.updateIssueCalls).toHaveLength(0);
  expect(jira.addIssueToSprintCalls).toHaveLength(0);
  expect(payload.error.code).toBe("sprint_ambiguous");
});

test("a Kanban-only project returns 'no sprint-supporting board', not a 400 passthrough", async () => {
  const jira = new FakeJiraClient().setProjectBoards([makeBoard({ id: 1, name: "ABC Kanban", type: "kanban" })]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", sprint: "current" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_no_board");
  expect(payload.hints.join(" ")).toMatch(/no sprint-supporting/i);
});

test("a field update that succeeds then a sprint move that fails reports a PARTIAL success", async () => {
  // The summary edit lands; the Agile move 400s. We don't roll back or claim
  // the sprint changed — we report fields changed + sprint move failed.
  const jira = new FakeJiraClient().setAddIssueToSprintError(new JiraApiError(400, ["Sprint is closed."], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", summary: "New title", sprint: 7 });

  expect(result.isError).toBeUndefined();
  expect(jira.updateIssueCalls).toHaveLength(1);
  expect(jira.updateIssueCalls[0]!.fields!.summary).toBe("New title");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/New title|summary/);
  expect(hint).toMatch(/failed/i);
  expect(hint).toMatch(/NOT changed|not changed/i);
});

test("a sprint-only move that fails is a plain error (nothing changed)", async () => {
  const jira = new FakeJiraClient().setAddIssueToSprintError(new JiraApiError(400, ["Sprint is closed."], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", sprint: 7 });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("sprint_move_failed");
  expect(jira.updateIssueCalls).toHaveLength(0);
});

// --- error boundary inheritance ---------------------------------------------

test("an auth failure is shaped with the credential-recovery guidance", async () => {
  const jira = new FakeJiraClient().setUpdateIssueError(new JiraApiError(401, ["unauthenticated"], {}));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", summary: "x" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("a 404 on the target issue is shaped with a not-found hint", async () => {
  const jira = new FakeJiraClient().setUpdateIssueError(
    new JiraApiError(404, ["Issue does not exist or no permission to view it."], {}),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-9", summary: "x" });
  expect(result.isError).toBe(true);
  expect(payload.hints.join(" ")).toMatch(/ABC-9|exist|not found/i);
});
