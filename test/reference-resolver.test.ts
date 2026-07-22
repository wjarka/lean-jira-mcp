/**
 * Reference-resolver tests, driven against the one external seam (the faked
 * JiraClient). These exercise the resolver's branching directly — assignee
 * email/name/me/ambiguity, parent company- vs team-managed mechanism, and
 * sprint id/current/ambiguity — since later write tools reuse this primitive.
 */

import { test, expect } from "bun:test";
import {
  resolveAssignee,
  resolveParent,
  resolveSprint,
} from "../src/lib/reference-resolver.ts";
import { FakeJiraClient, makeIssue, makeBoard } from "./helpers/fake-jira-client.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";

// --- assignee ---------------------------------------------------------------

test("assignee `me` resolves via the current user", async () => {
  const jira = new FakeJiraClient().setCurrentUser({ accountId: "acc-me", displayName: "Me" });
  const result = await resolveAssignee(jira, "me");
  expect(result).toEqual({ kind: "resolved", accountId: "acc-me" });
  expect(jira.getCurrentUserCalls).toBe(1);
  expect(jira.searchUsersCalls).toHaveLength(0);
});

test("assignee `currentUser` is an alias for the current user", async () => {
  const jira = new FakeJiraClient().setCurrentUser({ accountId: "acc-me", displayName: "Me" });
  expect(await resolveAssignee(jira, "currentUser")).toEqual({ kind: "resolved", accountId: "acc-me" });
});

test("assignee by email resolves to the single matching account", async () => {
  const jira = new FakeJiraClient().setUsers([
    { accountId: "acc-1", displayName: "Alice", emailAddress: "alice@x.com" },
  ]);
  expect(await resolveAssignee(jira, "alice@x.com")).toEqual({ kind: "resolved", accountId: "acc-1" });
  expect(jira.searchUsersCalls).toEqual(["alice@x.com"]);
});

test("assignee with no match returns `none`", async () => {
  const jira = new FakeJiraClient().setUsers([]);
  expect(await resolveAssignee(jira, "ghost@x.com")).toEqual({ kind: "none", query: "ghost@x.com" });
});

test("an exact email disambiguates an otherwise ambiguous search", async () => {
  const jira = new FakeJiraClient().setUsers([
    { accountId: "acc-1", displayName: "Alex A", emailAddress: "alex@x.com" },
    { accountId: "acc-2", displayName: "Alex B", emailAddress: "other@x.com" },
  ]);
  expect(await resolveAssignee(jira, "alex@x.com")).toEqual({ kind: "resolved", accountId: "acc-1" });
});

test("a genuinely ambiguous display name returns candidates rather than guessing", async () => {
  const jira = new FakeJiraClient().setUsers([
    { accountId: "acc-1", displayName: "Alex", emailAddress: "a1@x.com" },
    { accountId: "acc-2", displayName: "Alex", emailAddress: "a2@x.com" },
  ]);
  const result = await resolveAssignee(jira, "Alex");
  expect(result.kind).toBe("ambiguous");
  if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
});

// --- parent (company- vs team-managed) --------------------------------------

test("parent in a TEAM-managed (next-gen) project uses the `parent` field", async () => {
  const jira = new FakeJiraClient()
    .setProject({ id: "1", key: "TM", style: "next-gen", simplified: true })
    .setIssue(makeIssue({ key: "TM-100" }));
  const result = await resolveParent(jira, "TM", "TM-100", "customfield_10014");
  expect(result).toEqual({
    kind: "resolved",
    contribution: { fieldId: "parent", value: { key: "TM-100" }, mechanism: "parent" },
  });
});

test("parent in a COMPANY-managed (classic) project uses the Epic Link custom field", async () => {
  const jira = new FakeJiraClient()
    .setProject({ id: "2", key: "CM", style: "classic", simplified: false })
    .setIssue(makeIssue({ key: "CM-100" }));
  const result = await resolveParent(jira, "CM", "CM-100", "customfield_10014");
  expect(result).toEqual({
    kind: "resolved",
    contribution: { fieldId: "customfield_10014", value: "CM-100", mechanism: "epic-link" },
  });
});

test("a nonexistent parent key resolves to `not_found` rather than being set silently", async () => {
  // The fake's default getIssue throws a 404 — exactly a missing parent.
  const jira = new FakeJiraClient().setProject({ id: "1", key: "TM", style: "next-gen", simplified: true });
  const result = await resolveParent(jira, "TM", "TM-999", "customfield_10014");
  expect(result).toEqual({ kind: "not_found", parentKey: "TM-999" });
});

test("an auth/network error during parent validation bubbles up (handled by the boundary)", async () => {
  const jira = new FakeJiraClient().setGetIssueError(new JiraApiError(401, ["unauthenticated"], {}));
  await expect(resolveParent(jira, "TM", "TM-100", "customfield_10014")).rejects.toThrow();
});

// --- sprint -----------------------------------------------------------------
//
// A project with BOTH a Kanban board (no sprints) and a Scrum board (the real
// sprints) is the standing fixture: it proves resolution filters to scrum boards
// and never picks up — or 400s against — the Kanban board.

function kanbanPlusScrum(scrumSprints: { id: number; name: string; state: "active" | "future" }[]) {
  return new FakeJiraClient().setProjectBoards([
    makeBoard({ id: 1, name: "ABC Kanban", type: "kanban" }),
    makeBoard({ id: 2, name: "ABC Scrum", type: "scrum", sprints: scrumSprints }),
  ]);
}

test("a numeric sprint id resolves without any board lookup", async () => {
  const jira = new FakeJiraClient();
  expect(await resolveSprint(jira, "42", "ABC")).toEqual({ kind: "resolved", sprintId: 42 });
  expect(await resolveSprint(jira, 42, "ABC")).toEqual({ kind: "resolved", sprintId: 42 });
  expect(jira.listProjectBoardsCalls).toHaveLength(0);
});

test("`current` resolves to the single active sprint on the SCRUM board, ignoring Kanban", async () => {
  const jira = kanbanPlusScrum([{ id: 9, name: "Sprint 9", state: "active" }]);
  expect(await resolveSprint(jira, "current", "ABC")).toEqual({ kind: "resolved", sprintId: 9 });
});

test("a project with only a Kanban board returns no_sprint_board (never a 400 passthrough)", async () => {
  const jira = new FakeJiraClient().setProjectBoards([
    makeBoard({ id: 1, name: "ABC Kanban", type: "kanban" }),
  ]);
  expect(await resolveSprint(jira, "current", "ABC")).toEqual({ kind: "no_sprint_board" });
});

test("a team-managed board (type 'simple') is sprint-supporting, not excluded as non-scrum", async () => {
  // Team-managed (next-gen) software boards report type "simple" and DO carry
  // sprints — the filter must keep them, not allowlist scrum alone.
  const jira = new FakeJiraClient().setProjectBoards([
    { id: 5, name: "TM Board", type: "simple", sprints: [{ id: 77, name: "Sprint A", state: "active" }] },
  ]);
  expect(await resolveSprint(jira, "current", "TM")).toEqual({ kind: "resolved", sprintId: 77 });
});

test("`current` with a scrum board but no active sprint returns no_active", async () => {
  const jira = kanbanPlusScrum([{ id: 9, name: "Sprint 9", state: "future" }]);
  expect(await resolveSprint(jira, "current", "ABC")).toEqual({ kind: "no_active" });
});

test("an ambiguous `current` (two active sprints) returns candidates rather than guessing", async () => {
  const jira = new FakeJiraClient().setProjectBoards([
    makeBoard({ id: 2, name: "ABC Scrum", type: "scrum", sprints: [{ id: 9, name: "Sprint 9", state: "active" }] }),
    makeBoard({ id: 3, name: "ABC Bugs", type: "scrum", sprints: [{ id: 10, name: "Hotfix", state: "active" }] }),
  ]);
  const result = await resolveSprint(jira, "current", "ABC");
  expect(result.kind).toBe("ambiguous");
  if (result.kind === "ambiguous") {
    expect(result.candidates.map((c) => c.id).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(result.candidates.find((c) => c.id === 10)?.boardName).toBe("ABC Bugs");
  }
});

test("by-name matches across active+future sprints (case-insensitive)", async () => {
  const jira = kanbanPlusScrum([
    { id: 9, name: "Sprint 9", state: "active" },
    { id: 11, name: "Next Up", state: "future" },
  ]);
  expect(await resolveSprint(jira, "next up", "ABC")).toEqual({ kind: "resolved", sprintId: 11 });
});

test("by-name with no match returns no_match listing the available sprints", async () => {
  const jira = kanbanPlusScrum([{ id: 9, name: "Sprint 9", state: "active" }]);
  const result = await resolveSprint(jira, "Sprint 99", "ABC");
  expect(result.kind).toBe("no_match");
  if (result.kind === "no_match") {
    expect(result.ref).toBe("Sprint 99");
    expect(result.available.map((s) => s.name)).toEqual(["Sprint 9"]);
  }
});

test("by-name shared across two boards is ambiguous, not silently picked", async () => {
  const jira = new FakeJiraClient().setProjectBoards([
    makeBoard({ id: 2, name: "ABC Scrum", type: "scrum", sprints: [{ id: 9, name: "Sprint 1", state: "active" }] }),
    makeBoard({ id: 3, name: "ABC Bugs", type: "scrum", sprints: [{ id: 12, name: "Sprint 1", state: "future" }] }),
  ]);
  const result = await resolveSprint(jira, "Sprint 1", "ABC");
  expect(result.kind).toBe("ambiguous");
  if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
});
