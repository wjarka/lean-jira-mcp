/**
 * jira_describe_project handler, driven end-to-end against the faked JiraClient.
 * No transport, no network. Asserts on the shaped MCP response the agent sees.
 *
 * The central guarantee under test is UNIFORMITY: a company-managed and a
 * team-managed project must yield the identical response shape (the company/team
 * divergence is exactly where issue 04's parent-resolution bug hid), so both
 * project types are exercised against the fake throughout.
 */

import { test, expect } from "bun:test";
import {
  describeProjectHandler,
  describeProjectInputSchema,
} from "../src/tools/describe-project.ts";
import { parseShaped } from "../src/lib/response-shaper.ts";
import { FakeJiraClient, notFoundError, authError, makeBoard } from "./helpers/fake-jira-client.ts";
import type {
  JiraProject,
  JiraProjectSummary,
  JiraProjectWorkflow,
  JiraWorkflowTransition,
} from "../src/lib/jira-client.ts";

/** Parse raw input through the real zod schema (applying defaults), then run the handler. */
async function run(jira: FakeJiraClient, raw: Record<string, unknown>) {
  const args = describeProjectInputSchema.parse(raw);
  const result = await describeProjectHandler(jira, args);
  return { result, payload: parseShaped(result) as Record<string, any> };
}

function companyProject(overrides: Partial<JiraProject> = {}): JiraProject {
  return {
    id: "10000",
    key: "ENG",
    name: "Engineering",
    style: "classic",
    simplified: false,
    issueTypes: [
      { id: "1", name: "Task" },
      { id: "2", name: "Bug" },
      { id: "3", name: "Story" },
    ],
    ...overrides,
  };
}

function teamProject(overrides: Partial<JiraProject> = {}): JiraProject {
  return {
    id: "20000",
    key: "TEAM",
    name: "Team Project",
    style: "next-gen",
    simplified: true,
    issueTypes: [
      { id: "11", name: "Task" },
      { id: "12", name: "Bug" },
    ],
    ...overrides,
  };
}

/** A canonical workflow with a directed edge, a multi-from edge, and a global edge. */
function sampleWorkflow(): JiraProjectWorkflow {
  const transitions: JiraWorkflowTransition[] = [
    { name: "Start Progress", toStatus: "In Progress", fromStatuses: ["To Do"], isGlobal: false },
    {
      name: "Resolve",
      toStatus: "Done",
      fromStatuses: ["In Progress", "In Review"],
      isGlobal: false,
    },
    { name: "Close", toStatus: "Closed", fromStatuses: [], isGlobal: true },
  ];
  return {
    statuses: ["To Do", "In Progress", "In Review", "Done", "Closed"],
    transitions,
    ruleFidelity: "full",
  };
}

/**
 * The PROJ-104 reproduction (issue 19): a full-fidelity workflow where the
 * `In Review → Release Pending` edge is GATED (restricted) — defined in the map,
 * but not firable at runtime. A second route to Release Pending (the staging
 * pipeline) is ungated, and one edge shows a screen.
 */
function gatedWorkflow(fidelity: "full" | "topology" = "full"): JiraProjectWorkflow {
  const transitions: JiraWorkflowTransition[] = [
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
    {
      name: "QA Fail",
      toStatus: "In Progress",
      fromStatuses: ["In Review"],
      isGlobal: false,
      requires: fidelity === "full" ? ["a field value must satisfy a rule"] : [],
      hasScreen: true,
    },
  ];
  return {
    statuses: ["In Review", "Release Pending", "Staging", "In Progress"],
    transitions,
    ruleFidelity: fidelity,
  };
}

// --- Tier 0: no projectKey → the project catalog ---------------------------

function catalog(): JiraProjectSummary[] {
  return [
    { key: "ENG", name: "Engineering", id: "10000", projectTypeKey: "software", lead: "Ada Lovelace" },
    { key: "OPS", name: "Operations", id: "20000", projectTypeKey: "business" },
  ];
}

test("tier 0: no projectKey returns the project catalog as {key, name, lead}", async () => {
  const jira = new FakeJiraClient().setProjectCatalog(catalog());
  const { payload } = await run(jira, {});

  expect(payload.projects).toEqual([
    { key: "ENG", name: "Engineering", lead: "Ada Lovelace" },
    { key: "OPS", name: "Operations" },
  ]);
  expect(jira.listProjectsCalls).toBe(1);
  // Tier 0 doesn't touch a single project.
  expect(jira.getProjectCalls).toHaveLength(0);
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("tier 0: an empty catalog still returns a projects array and a hint", async () => {
  const jira = new FakeJiraClient().setProjectCatalog([]);
  const { payload } = await run(jira, {});
  expect(payload.projects).toEqual([]);
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("tier 0: an authentication failure returns an auth error", async () => {
  const jira = new FakeJiraClient();
  jira.listProjects = async () => {
    throw authError();
  };
  const { result, payload } = await run(jira, {});
  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
});

// --- Tier 1: projectKey only -----------------------------------------------

test("tier 1: projectKey alone returns identity + projectType + issue types, no workflow graph", async () => {
  const jira = new FakeJiraClient().setProject(
    companyProject({ description: "The engineering org", lead: "Ada Lovelace" }),
  );
  const { payload } = await run(jira, { projectKey: "ENG" });

  // Identity echo — the fix for project-name hallucination.
  expect(payload.key).toBe("ENG");
  expect(payload.name).toBe("Engineering");
  expect(payload.description).toBe("The engineering org");
  expect(payload.lead).toBe("Ada Lovelace");

  expect(payload.projectType).toBe("company");
  expect(payload.issueTypes).toEqual(["Task", "Bug", "Story"]);
  // Tier 1 is lean: no workflow dumped.
  expect(payload.statuses).toBeUndefined();
  expect(payload.transitions).toBeUndefined();
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("tier 1: missing description/lead surface as null, not absent keys", async () => {
  const jira = new FakeJiraClient().setProject(
    companyProject({ description: undefined, lead: undefined }),
  );
  const { payload } = await run(jira, { projectKey: "ENG" });
  expect(payload.name).toBe("Engineering");
  expect(payload.description).toBeNull();
  expect(payload.lead).toBeNull();
});

test("tier 1 does not fetch the workflow (no per-type graph pulled)", async () => {
  const jira = new FakeJiraClient().setProject(companyProject());
  await run(jira, { projectKey: "ENG" });
  expect(jira.getProjectWorkflowCalls).toHaveLength(0);
});

test("tier 1: company-managed (style classic) → projectType company", async () => {
  const jira = new FakeJiraClient().setProject(companyProject());
  const { payload } = await run(jira, { projectKey: "ENG" });
  expect(payload.projectType).toBe("company");
});

test("tier 1: team-managed (simplified:true) → projectType team", async () => {
  const jira = new FakeJiraClient().setProject(teamProject({ style: undefined, simplified: true }));
  const { payload } = await run(jira, { projectKey: "TEAM" });
  expect(payload.projectType).toBe("team");
});

test("tier 1: team-managed (style next-gen) → projectType team", async () => {
  const jira = new FakeJiraClient().setProject(teamProject({ style: "next-gen", simplified: false }));
  const { payload } = await run(jira, { projectKey: "TEAM" });
  expect(payload.projectType).toBe("team");
});

test("tier 1: company and team projects return the identical response shape", async () => {
  const company = await run(new FakeJiraClient().setProject(companyProject()), { projectKey: "ENG" });
  const team = await run(new FakeJiraClient().setProject(teamProject()), { projectKey: "TEAM" });

  expect(Object.keys(company.payload).sort()).toEqual(Object.keys(team.payload).sort());
  // Only the VALUE of projectType differs, never the shape.
  expect(company.payload.projectType).toBe("company");
  expect(team.payload.projectType).toBe("team");
});

// --- Tier 1: boards[] (issue 15 discovery) ---------------------------------

test("tier 1: boards[] lists each board with type and its open sprints", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectBoards([
      makeBoard({ id: 1, name: "ENG Kanban", type: "kanban" }),
      makeBoard({
        id: 2,
        name: "ENG Scrum",
        type: "scrum",
        sprints: [
          { id: 9, name: "Sprint 9", state: "active" },
          { id: 11, name: "Sprint 10", state: "future" },
        ],
      }),
    ]);

  const { payload } = await run(jira, { projectKey: "ENG" });

  expect(payload.boards).toEqual([
    { id: 1, name: "ENG Kanban", type: "kanban", sprints: [] },
    {
      id: 2,
      name: "ENG Scrum",
      type: "scrum",
      sprints: [
        { id: 9, name: "Sprint 9", state: "active" },
        { id: 11, name: "Sprint 10", state: "future" },
      ],
    },
  ]);
  expect(jira.listProjectBoardsCalls).toEqual(["ENG"]);
  // The hint surfaces the assignable sprint ids inline.
  expect(payload.hints.join(" ")).toMatch(/id 9/);
});

test("tier 1: a Kanban-only project notes that sprint assignment isn't available", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectBoards([makeBoard({ id: 1, name: "ENG Kanban", type: "kanban" })]);
  const { payload } = await run(jira, { projectKey: "ENG" });
  expect(payload.boards).toHaveLength(1);
  expect(payload.hints.join(" ")).toMatch(/no sprint-supporting/i);
});

test("tier 1: a boards lookup failure degrades to boards:[] rather than failing the identity echo", async () => {
  const jira = new FakeJiraClient().setProject(companyProject());
  jira.listProjectBoards = async () => {
    throw notFoundError("Board search unavailable for this project.");
  };
  const { result, payload } = await run(jira, { projectKey: "ENG" });
  expect(result.isError).toBeFalsy();
  expect(payload.name).toBe("Engineering");
  expect(payload.boards).toEqual([]);
  // The hint must NOT claim the project is Kanban-only / sprint-less — boards
  // were merely unreadable. Distinguish "couldn't read" from "none exist".
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/could not read/i);
  expect(hint).not.toMatch(/no sprint-supporting board/i);
});

test("tier 1: a team-managed 'simple' board's sprints are surfaced as assignable", async () => {
  const jira = new FakeJiraClient()
    .setProject(teamProject())
    .setProjectBoards([
      { id: 5, name: "TEAM Board", type: "simple", sprints: [{ id: 77, name: "Sprint A", state: "active" }] },
    ]);
  const { payload } = await run(jira, { projectKey: "TEAM" });
  expect(payload.hints.join(" ")).toMatch(/id 77/);
  expect(payload.hints.join(" ")).not.toMatch(/no sprint-supporting/i);
});

// --- Tier 2: projectKey + issueType ----------------------------------------

test("tier 2: returns statuses and the named transition graph with from/to", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });

  expect(payload.statuses).toEqual(["To Do", "In Progress", "In Review", "Done", "Closed"]);
  expect(payload.transitions).toContainEqual({ name: "Start Progress", from: "To Do", to: "In Progress" });
  expect(Array.isArray(payload.hints)).toBe(true);
  expect(payload.hints.length).toBeGreaterThan(0);
  // Tier 2 is workflow-only — no projectType/issueTypes folded in.
  expect(payload.projectType).toBeUndefined();
  expect(payload.issueTypes).toBeUndefined();
});

test("tier 2: a global transition is represented as from:'*'", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });
  expect(payload.transitions).toContainEqual({ name: "Close", from: "*", to: "Closed" });
});

test("tier 2: a transition reachable from several statuses expands to one edge per source", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });
  const resolveEdges = payload.transitions.filter((t: any) => t.name === "Resolve");
  expect(resolveEdges).toHaveLength(2);
  expect(resolveEdges).toContainEqual({ name: "Resolve", from: "In Progress", to: "Done" });
  expect(resolveEdges).toContainEqual({ name: "Resolve", from: "In Review", to: "Done" });
});

test("tier 2: passes the requested issue type through to the workflow fetch", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  await run(jira, { projectKey: "ENG", issueType: "Bug" });
  // The handler hands its already-fetched project id through so the client need
  // not re-fetch the project just to read the workflow.
  expect(jira.getProjectWorkflowCalls).toEqual([
    { projectKey: "ENG", issueType: "Bug", projectId: "10000" },
  ]);
});

test("a directed transition with no resolvable source is dropped, never coerced to global", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow({
      statuses: ["To Do", "Done"],
      transitions: [
        // Directed but with empty sources (e.g. unresolvable refs upstream).
        { name: "Mystery", toStatus: "Done", fromStatuses: [], isGlobal: false },
        { name: "Abandon", toStatus: "Done", fromStatuses: [], isGlobal: true },
      ],
      ruleFidelity: "full",
    });

  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });
  // The global one still becomes from:"*"; the directed-but-sourceless one is not
  // misrepresented as global — it simply produces no edge.
  expect(payload.transitions).toEqual([{ name: "Abandon", from: "*", to: "Done" }]);
});

test("tier 2: company-managed and team-managed projects return the identical shape", async () => {
  const company = await run(
    new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(sampleWorkflow()),
    { projectKey: "ENG", issueType: "Task" },
  );
  const team = await run(
    new FakeJiraClient().setProject(teamProject()).setProjectWorkflow(sampleWorkflow()),
    { projectKey: "TEAM", issueType: "Task" },
  );

  expect(Object.keys(company.payload).sort()).toEqual(Object.keys(team.payload).sort());
  expect(company.payload.transitions).toEqual(team.payload.transitions);
  expect(company.payload.statuses).toEqual(team.payload.statuses);
  // Each transition edge carries exactly {name, from, to} for both project types.
  for (const edge of [...company.payload.transitions, ...team.payload.transitions]) {
    expect(Object.keys(edge).sort()).toEqual(["from", "name", "to"]);
  }
});

// --- No internal ids / no createmeta ---------------------------------------

test("no numeric transition ids and no createmeta data appear in the output", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  const { result, payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });

  // Transition edges expose name + status names only.
  for (const edge of payload.transitions) {
    expect(edge.id).toBeUndefined();
    expect(typeof edge.name).toBe("string");
    expect(typeof edge.to).toBe("string");
  }
  // Tiering means createmeta is never consulted for this tool.
  expect(jira.createMetaCalls).toHaveLength(0);
  // No raw custom-field identifiers leak into the serialized payload.
  const raw = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  expect(raw).not.toContain("customfield_");
});

// --- Hints + recovery ------------------------------------------------------

test("unknown project returns a clear recovery hint", async () => {
  const jira = new FakeJiraClient();
  // getProject 404s for an unknown key, as the real client surfaces it.
  jira.getProject = async () => {
    throw notFoundError("No project could be found with key 'NOPE'.");
  };

  const { result, payload } = await run(jira, { projectKey: "NOPE" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("project_not_found");
  expect(payload.error.message).toContain("NOPE");
  expect(payload.hints.join(" ")).toContain("NOPE");
  expect(payload.hints.length).toBeGreaterThan(0);
});

test("unknown issue type returns a recovery hint listing the valid types", async () => {
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow(sampleWorkflow());

  const { result, payload } = await run(jira, { projectKey: "ENG", issueType: "Epicc" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("unknown_issue_type");
  expect(payload.error.options).toEqual(["Task", "Bug", "Story"]);
  const hintText = payload.hints.join(" ");
  expect(hintText).toContain("Task");
  expect(hintText).toContain("Bug");
  // Did not waste a workflow fetch on an invalid type.
  expect(jira.getProjectWorkflowCalls).toHaveLength(0);
});

test("an authentication failure returns an auth error with a hint to authenticate", async () => {
  const jira = new FakeJiraClient();
  jira.getProject = async () => {
    throw authError();
  };

  const { result, payload } = await run(jira, { projectKey: "ENG" });

  expect(result.isError).toBe(true);
  expect(payload.error.code).toBe("authentication_failed");
  const hintText = payload.hints.join(" ");
  expect(hintText).toContain("JIRA_API_TOKEN");
});

test("every response — tier 1, tier 2, and error — carries a non-empty hints array", async () => {
  const t1 = await run(new FakeJiraClient().setProject(companyProject()), { projectKey: "ENG" });
  const t2 = await run(
    new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(sampleWorkflow()),
    { projectKey: "ENG", issueType: "Task" },
  );
  const err = await run(
    new FakeJiraClient().setProject(companyProject()),
    { projectKey: "ENG", issueType: "Nope" },
  );

  for (const r of [t1, t2, err]) {
    expect(Array.isArray(r.payload.hints)).toBe(true);
    expect(r.payload.hints.length).toBeGreaterThan(0);
  }
});

test("tier 2 with no transitions returned still yields statuses and a degradation hint", async () => {
  // The real client returns statuses-only when the workflow read fails; the tool
  // must surface a usable partial map rather than an empty/failed response.
  const jira = new FakeJiraClient()
    .setProject(companyProject())
    .setProjectWorkflow({ statuses: ["To Do", "Done"], transitions: [], ruleFidelity: "topology" });

  const { result, payload } = await run(jira, { projectKey: "ENG", issueType: "Task" });

  expect(result.isError).toBeFalsy();
  expect(payload.statuses).toEqual(["To Do", "Done"]);
  expect(payload.transitions).toEqual([]);
  expect(payload.ruleFidelity).toBe("topology");
  expect(payload.hints.join(" ").toLowerCase()).toContain("transition");
});

// --- Tier 2: gates + ruleFidelity (issue 19) -------------------------------

test("tier 2 full fidelity: a gated edge carries terse `requires` phrases; an ungated edge omits `requires`", async () => {
  const jira = new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(gatedWorkflow("full"));
  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Story" });

  expect(payload.ruleFidelity).toBe("full");
  // The bug-case edge is shown WITH its gate — the map now carries gating truth.
  const prodGated = payload.transitions.find((t: any) => t.name === "Release Pending" && t.from === "In Review");
  expect(prodGated.requires).toEqual(["restricted to specific users/groups/roles"]);
  // The genuinely-working staging route is ungated → no `requires` key at all.
  const stagePass = payload.transitions.find((t: any) => t.name === "Staging Check");
  expect(stagePass.requires).toBeUndefined();
  expect(stagePass.hasScreen).toBeUndefined();
});

test("tier 2 full fidelity: hasScreen surfaces only when true", async () => {
  const jira = new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(gatedWorkflow("full"));
  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Story" });
  const qaFail = payload.transitions.find((t: any) => t.name === "QA Fail");
  expect(qaFail.hasScreen).toBe(true);
  expect(qaFail.requires).toEqual(["a field value must satisfy a rule"]);
});

test("tier 2 full fidelity: a hint explains a missing `requires` means UNGATED", async () => {
  const jira = new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(gatedWorkflow("full"));
  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Story" });
  expect(payload.hints.join(" ")).toMatch(/ungated/i);
});

test("tier 2 topology fidelity: edges present but a note states rules weren't readable (missing requires = UNKNOWN)", async () => {
  // The defensive topology-WITH-edges variant: edges carry no requires, and the
  // note must keep the agent from reading that as "ungated".
  const jira = new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(gatedWorkflow("topology"));
  const { payload } = await run(jira, { projectKey: "ENG", issueType: "Story" });

  expect(payload.ruleFidelity).toBe("topology");
  for (const edge of payload.transitions) {
    expect(edge.requires).toBeUndefined();
  }
  const hint = payload.hints.join(" ");
  expect(hint).toMatch(/not readable|wasn't readable|weren't readable|not readable at this permission/i);
  expect(hint.toLowerCase()).toContain("unknown");
});

test("tier 2: ruleFidelity is present on every tier-2 response", async () => {
  const full = await run(
    new FakeJiraClient().setProject(companyProject()).setProjectWorkflow(sampleWorkflow()),
    { projectKey: "ENG", issueType: "Task" },
  );
  expect(full.payload.ruleFidelity).toBe("full");
});
