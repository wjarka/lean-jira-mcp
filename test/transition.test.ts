/**
 * jira_transition handler, driven end-to-end against the faked JiraClient.
 * Asserts on the shaped MCP response the agent sees and on the transition
 * payload sent to the JIRA seam — never on internals.
 *
 * The subtle behaviors flagged for review get explicit coverage here:
 *   - resolution order: exact transition-name → target-status → refuse if a
 *     status is reachable by >1 transition (listing the named options);
 *   - PROACTIVE screen-field validation off the free `transitions.fields`
 *     metadata — the required-field list is returned with NO failed attempt;
 *   - NO server-side pathfinding — a no-direct-edge target returns the current
 *     status's options + a describe_project pointer, never a computed route.
 */

import { test, expect } from "bun:test";
import {
  transitionHandler,
  transitionInputSchema,
} from "../src/tools/transition.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { JiraApiError, type JiraAvailableTransition } from "../src/lib/jira-client.ts";
import {
  FakeJiraClient,
  makeIssue,
  makeTransition,
  authError,
  notFoundError,
} from "./helpers/fake-jira-client.ts";

async function run(jira: FakeJiraClient, raw: Record<string, unknown>) {
  const args = transitionInputSchema.parse(raw);
  const result = await transitionHandler(jira, args);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

/** A client whose ABC-1 sits in `status` with the given available transitions. */
function client(status: string, transitions: JiraAvailableTransition[]) {
  return new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status }))
    .setTransitions(transitions);
}

const TODO = [
  makeTransition({ id: "11", name: "Start Progress", to: "In Progress" }),
  makeTransition({ id: "21", name: "Close", to: "Done" }),
];

// --- single transition: move by status OR by transition name ----------------

test("a target status with a single transition is moved by passing the STATUS name", async () => {
  const jira = client("To Do", TODO);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "In Progress" });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
  expect(payload.status).toBe("In Progress");
  expect(jira.doTransitionCalls).toHaveLength(1);
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("11");
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("the same move works by passing the TRANSITION name", async () => {
  const jira = client("To Do", TODO);
  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  expect(payload.moved).toBe(true);
  expect(payload.status).toBe("In Progress");
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("11");
});

test("the agent never passes a numeric id — only the resolved id reaches the seam", async () => {
  const jira = client("To Do", TODO);
  await run(jira, { issueKey: "ABC-1", transition: "Close" });
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("21");
});

// --- (amendment) success hints the next steps from the NEW status -----------

test("a successful transition hints the transitions available from the NEW status (fresh read)", async () => {
  // The up-front read returns To Do's transitions; the post-transition read
  // returns In Progress's. Keyed off call count via the recorded calls.
  const fromInProgress = [
    makeTransition({ id: "71", name: "Resolve", to: "Done" }),
    makeTransition({ id: "72", name: "Stop", to: "To Do" }),
  ];
  const jira = new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status: "To Do" }))
    .setTransitionsResponder(() => (jira.getTransitionsCalls.length === 1 ? TODO : fromInProgress));

  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
  expect(payload.status).toBe("In Progress");
  // The success path makes a SECOND getTransitions (status changed → list stale).
  expect(jira.getTransitionsCalls).toHaveLength(2);
  const hintText = payload.hints.join(" ");
  expect(hintText).toMatch(/In Progress/); // the new status named
  expect(hintText).toMatch(/Resolve/); // a next-hop transition from In Progress
  expect(hintText).toMatch(/Stop/);
});

test("a transition into a TERMINAL status reports no further transitions available", async () => {
  const jira = new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status: "In Progress" }))
    .setTransitionsResponder(() =>
      jira.getTransitionsCalls.length === 1
        ? [makeTransition({ id: "81", name: "Close", to: "Done" })]
        : [], // Done is terminal — no outgoing transitions.
    );

  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Close" });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
  expect(payload.status).toBe("Done");
  expect(payload.hints.join(" ")).toMatch(/no further transitions/i);
});

test("if the post-transition read fails, the transition still succeeds (hint omitted, tool does not fail)", async () => {
  let call = 0;
  const jira = new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status: "To Do" }))
    .setTransitionsResponder(() => {
      call += 1;
      if (call === 1) return TODO;
      throw new JiraApiError(503, ["Service unavailable."], {});
    });

  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  // The transition is reported as succeeded despite the follow-up read failing.
  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
  expect(payload.status).toBe("In Progress");
  expect(jira.doTransitionCalls).toHaveLength(1);
  // Only the "Moved …" hint — no next-steps clause appended.
  expect(payload.hints.join(" ")).toMatch(/Moved ABC-1 to "In Progress"/);
  expect(payload.hints.join(" ")).not.toMatch(/available:|no further transitions/i);
});

test("non-success outcomes do NOT make a second getTransitions read (reuse the up-front list)", async () => {
  // no-direct-edge: one up-front read, and no extra fetch since nothing moved.
  const jira = client("To Do", TODO);
  await run(jira, { issueKey: "ABC-1", transition: "Released" });
  expect(jira.getTransitionsCalls).toHaveLength(1);
  expect(jira.doTransitionCalls).toHaveLength(0);

  // no-op: same — the up-front list is reused, no second fetch.
  const jira2 = client("In Progress", TODO);
  await run(jira2, { issueKey: "ABC-1", transition: "In Progress" });
  expect(jira2.getTransitionsCalls).toHaveLength(1);
});

// --- resolution order: >1 transition to a status is refused -----------------

const SHARED_TARGET = [
  makeTransition({ id: "41", name: "QA Failed", to: "To Do" }),
  makeTransition({ id: "51", name: "Put on Hold", to: "To Do" }),
];

test("a status reachable by >1 transition is REFUSED, listing the named options", async () => {
  const jira = client("In Review", SHARED_TARGET);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "To Do" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("ambiguous_transition");
  // It must list the NAMED transitions, not silently pick the first.
  expect(payload.error.options).toEqual(["QA Failed", "Put on Hold"]);
  expect(payload.hints.join(" ")).toMatch(/QA Failed/);
  expect(payload.hints.join(" ")).toMatch(/Put on Hold/);
  expect(payload.hints.join(" ")).toMatch(/transition name/i);
  // Nothing was fired — the server refused rather than guessing.
  expect(jira.doTransitionCalls).toHaveLength(0);
});

test("an exact transition name resolves to THAT transition even when its status is shared (distinct post-functions)", async () => {
  const jira = client("In Review", SHARED_TARGET);
  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "QA Failed" });

  expect(payload.moved).toBe(true);
  // QA Failed (41), not Put on Hold (51) — the named action's post-functions are preserved.
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("41");
});

test("a transition NAME that matches more than one transition is refused, not fired at random", async () => {
  // JIRA permits duplicate transition names; two distinct edges share the name.
  const jira = client("Backlog", [
    makeTransition({ id: "61", name: "Reopen", to: "To Do" }),
    makeTransition({ id: "62", name: "Reopen", to: "In Progress" }),
  ]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Reopen" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("ambiguous_transition");
  expect(payload.hints.join(" ")).toMatch(/To Do/);
  expect(payload.hints.join(" ")).toMatch(/In Progress/);
  expect(jira.doTransitionCalls).toHaveLength(0);
});

test("a blank transition argument is rejected before any read-derived branch", async () => {
  const jira = client("To Do", TODO);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "   " });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("invalid_transition_argument");
  expect(jira.doTransitionCalls).toHaveLength(0);
});

// --- current-status no-op ---------------------------------------------------

test("requesting the issue's current status is a graceful no-op, not an error", async () => {
  const jira = client("In Progress", [
    makeTransition({ id: "21", name: "Close", to: "Done" }),
  ]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "In Progress" });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(false);
  expect(payload.status).toBe("In Progress");
  expect(payload.hints.join(" ")).toMatch(/already/i);
  expect(jira.doTransitionCalls).toHaveLength(0);
});

// --- proactive screen-field validation --------------------------------------

const RESOLVE = [
  makeTransition({
    id: "31",
    name: "Resolve",
    to: "Done",
    fields: [{ fieldId: "resolution", name: "Resolution", required: true }],
  }),
];

test("a transition requiring screen fields returns the required-field list up front, with NO failed attempt", async () => {
  const jira = client("In Progress", RESOLVE);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Resolve" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("transition_requires_fields");
  expect(payload.error.options).toEqual(["Resolution"]);
  expect(payload.hints.join(" ")).toMatch(/Resolution/);
  // The headline guarantee: it did NOT try the transition and report the failure.
  expect(jira.doTransitionCalls).toHaveLength(0);
});

test("supplying the required field completes the transition; the field is sent keyed by its id", async () => {
  const jira = client("In Progress", RESOLVE);
  const { result, payload } = await run(jira, {
    issueKey: "ABC-1",
    transition: "Resolve",
    // The agent supplies it by friendly NAME — the server maps name → field id.
    fields: { Resolution: { name: "Done" } },
  });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
  expect(jira.doTransitionCalls).toHaveLength(1);
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("31");
  expect(jira.doTransitionCalls[0]!.fields).toEqual({ resolution: { name: "Done" } });
});

test("an optional screen field is never required up front", async () => {
  const jira = client("In Progress", [
    makeTransition({
      id: "31",
      name: "Resolve",
      to: "Done",
      fields: [{ fieldId: "customfield_10001", name: "Sign-off", required: false }],
    }),
  ]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Resolve" });

  expect(result.isError).toBeUndefined();
  expect(payload.moved).toBe(true);
});

// --- invalid target + no-direct-edge (no pathfinding) -----------------------

test("an invalid target returns the issue's currently-available transitions as a hint", async () => {
  const jira = client("To Do", TODO);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Frobnicate" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("no_direct_transition");
  // The available transitions (name → target) are surfaced for recovery.
  expect(payload.hints.join(" ")).toMatch(/Start Progress/);
  expect(payload.hints.join(" ")).toMatch(/In Progress/);
  expect(jira.doTransitionCalls).toHaveLength(0);
});

test("a no-direct-edge target returns current-status next steps + a describe_project pointer, computing NO path", async () => {
  // "Done" is a real downstream status, but not reachable from "To Do" in one hop
  // here (only In Progress is). The server must NOT compute a multi-hop route.
  const jira = client("To Do", [
    makeTransition({ id: "11", name: "Start Progress", to: "In Progress" }),
  ]);
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Released" });

  expect(result.isError).toBe(true);
  const hintText = payload.hints.join(" ");
  // Current status's available next steps...
  expect(hintText).toMatch(/Start Progress/);
  // ...plus a pointer to the workflow map, scoped to the issue's project.
  expect(hintText).toMatch(/jira_describe_project/);
  expect(hintText).toMatch(/\bABC\b/);
  // And an explicit statement that the server does not route multi-hop.
  expect(hintText).toMatch(/multi-hop|does not compute|one (transition|step)/i);
  expect(jira.doTransitionCalls).toHaveLength(0);
});

// --- on-miss reconciliation against the workflow definition (issue 19) ------

import type { JiraProjectWorkflow } from "../src/lib/jira-client.ts";

/** The PROJ-104 workflow: 'In Review → Release Pending' is DEFINED but gated. */
function man104Workflow(fidelity: "full" | "topology" = "full"): JiraProjectWorkflow {
  return {
    statuses: ["In Review", "Release Pending", "Staging", "In Progress"],
    transitions: [
      {
        name: "Release Pending",
        toStatus: "Release Pending",
        fromStatuses: ["In Review"],
        isGlobal: false,
        requires: fidelity === "full" ? ["restricted to specific users/groups/roles"] : [],
        hasScreen: false,
      },
      {
        name: "Staging Check",
        toStatus: "Release Pending",
        fromStatuses: ["Staging"],
        isGlobal: false,
        requires: [],
        hasScreen: false,
      },
    ],
    ruleFidelity: fidelity,
  };
}

/** ABC-1 sits in "In Review"; only the runtime-firable set is available. */
function man104Client(workflow: JiraProjectWorkflow | null) {
  const jira = new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status: "In Review", type: "Story" }))
    .setTransitions([
      makeTransition({ id: "31", name: "QA Fail", to: "In Progress" }),
      makeTransition({ id: "41", name: "Back to Ready for testing", to: "Ready for testing" }),
    ]);
  if (workflow) jira.setProjectWorkflow(workflow);
  else jira.setProjectWorkflowError(new JiraApiError(403, ["No permission to view workflow."], {}));
  return jira;
}

test("PROJ-104 full fidelity: a gated target is reconciled — 'defines' + 'requires' + 'not available', never contradicting the map", async () => {
  const jira = man104Client(man104Workflow("full"));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Release Pending" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("no_direct_transition");
  const hint = payload.hints.join(" ");
  // Cites the DEFINED edge (topology fact) ...
  expect(hint).toMatch(/defines/i);
  expect(hint).toMatch(/Release Pending/);
  // ... and its gate (rule-definition fact) ...
  expect(hint).toMatch(/restricted to specific users/i);
  // ... attributes the block to one-or-more gates/permissions, UNEVALUATED ...
  expect(hint).toMatch(/one or more/i);
  expect(hint).toMatch(/not.*available|isn't.*available|currently available/i);
  // ... and lists what IS firable now.
  expect(hint).toMatch(/QA Fail/);
  // The failure-only reconciliation made exactly one workflow read, for Story.
  expect(jira.getProjectWorkflowCalls).toEqual([
    { projectKey: "ABC", issueType: "Story" },
  ]);
  expect(jira.doTransitionCalls).toHaveLength(0);
});

test("verb discipline: the reconciled miss NEVER claims which gate failed (no 'failed because')", async () => {
  const jira = man104Client(man104Workflow("full"));
  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "Release Pending" });
  const hint = payload.hints.join(" ").toLowerCase();
  expect(hint).not.toContain("failed because");
  expect(hint).not.toContain("because the");
  // "we don't evaluate which" is the honest attribution.
  expect(hint).toMatch(/don't evaluate|do not evaluate|unevaluated/);
});

test("PROJ-104 topology fidelity: defines the edge but says gating rules aren't readable (no gate phrases invented)", async () => {
  const jira = man104Client(man104Workflow("topology"));
  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "Release Pending" });

  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/defines/i);
  expect(hint).toMatch(/not.*readable|aren't.*readable|not readable at this permission/i);
  // It must NOT invent a specific gate phrase it doesn't have.
  expect(hint).not.toMatch(/restricted to specific users/i);
  expect(hint).toMatch(/QA Fail/);
});

test("two defined edges to the same target → each cited with its OWN gates (the lead edge's requires never stands in for the rest)", async () => {
  // From "In Review", BOTH "Resolve" and "Force Done" reach "Done", gated
  // DIFFERENTLY. Citing only the first's gates would misrepresent the second.
  const jira = new FakeJiraClient()
    .setIssue(makeIssue({ key: "ABC-1", status: "In Review", type: "Story" }))
    .setTransitions([makeTransition({ id: "31", name: "QA Fail", to: "In Progress" })])
    .setProjectWorkflow({
      statuses: ["In Review", "Done", "In Progress"],
      transitions: [
        {
          name: "Resolve",
          toStatus: "Done",
          fromStatuses: ["In Review"],
          isGlobal: false,
          requires: ["requires a specific permission"],
          hasScreen: false,
        },
        {
          name: "Force Done",
          toStatus: "Done",
          fromStatuses: ["In Review"],
          isGlobal: false,
          requires: ["restricted to specific users/groups/roles"],
          hasScreen: true,
        },
      ],
      ruleFidelity: "full",
    });

  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "Done" });
  const hint = payload.hints.join(" ");
  // The lead edge's gate ...
  expect(hint).toMatch(/requires a specific permission/);
  // ... AND the second edge's DISTINCT gate (not collapsed into the lead's).
  expect(hint).toMatch(/Force Done/);
  expect(hint).toMatch(/restricted to specific users/);
});

test("genuinely-undefined target: no defined edge from here → 'not defined' + describe_project pointer (unchanged)", async () => {
  // The workflow defines NO edge to "Released" from "In Review".
  const jira = man104Client(man104Workflow("full"));
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Released" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("no_direct_transition");
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/not defined|no transition/i);
  expect(hint).toMatch(/jira_describe_project/);
  expect(hint).toMatch(/QA Fail/);
});

test("reconciliation is best-effort: a workflow-read failure falls back to the original no-direct message (no regression)", async () => {
  const jira = man104Client(null); // getProjectWorkflow throws 403
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Release Pending" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("no_direct_transition");
  const hint = payload.hints.join(" ");
  // Falls back to the existing recovery: current options + describe_project pointer.
  expect(hint).toMatch(/QA Fail/);
  expect(hint).toMatch(/jira_describe_project/);
});

// --- case / whitespace insensitivity ----------------------------------------

test("matching is case- and whitespace-insensitive", async () => {
  const jira = client("To Do", TODO);
  const { payload } = await run(jira, { issueKey: "ABC-1", transition: "  start   PROGRESS " });
  expect(payload.moved).toBe(true);
  expect(jira.doTransitionCalls[0]!.transitionId).toBe("11");
});

// --- reactive failure hint --------------------------------------------------

test("a transition JIRA still rejects (400) comes back with the available transitions as a recovery hint", async () => {
  const jira = client("To Do", TODO).setDoTransitionError(
    new JiraApiError(400, ["Field 'assignee' is required."], {}),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("transition_rejected");
  expect(payload.hints.join(" ")).toMatch(/assignee/i);
  expect(payload.hints.join(" ")).toMatch(/Start Progress|Close/);
});

test("a 403 firing the transition is a rejection (condition/permission), not an auth failure", async () => {
  // The reads already succeeded with this token, so a 403 on the POST is a
  // transition condition/permission — never 'fix your credentials'.
  const jira = client("To Do", TODO).setDoTransitionError(
    new JiraApiError(403, ["You do not have permission to execute this transition."], {}),
  );
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("transition_rejected");
  expect(payload.error.code).not.toBe("authentication_failed");
});

test("a 404 firing the transition (issue vanished mid-flight) is shaped as not-found", async () => {
  const jira = client("To Do", TODO).setDoTransitionError(notFoundError());
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Start Progress" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("issue_not_found");
});

// --- auth + not-found -------------------------------------------------------

test("an auth failure is shaped with the credential-recovery guidance", async () => {
  const jira = new FakeJiraClient().setGetIssueError(authError());
  const { result, payload } = await run(jira, { issueKey: "ABC-1", transition: "Done" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

test("an unknown issue key is shaped as a not-found with a recovery hint", async () => {
  const jira = new FakeJiraClient().setGetIssueError(notFoundError());
  const { result, payload } = await run(jira, { issueKey: "ABC-999", transition: "Done" });
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("issue_not_found");
  expect(payload.hints.join(" ")).toMatch(/ABC-999/);
  expect(jira.doTransitionCalls).toHaveLength(0);
});
