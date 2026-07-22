/**
 * jira_describe_project — the project catalog + a project's identity and
 * workflow MAP, so an agent can ground itself (which projects exist? what is
 * this project actually called?) and plan actions before taking them rather than
 * discovering the workflow by trial and error. Read-only.
 *
 * Tiered, like get_issue's detail:
 *   - `describe_project()` → `{ projects: {key, name, lead}[] }` — the project
 *     catalog (tier-0). The reliable *tool* path to the same data as the
 *     `projects` resource, fetchable mid-task; an agent uses it to find a key.
 *   - `describe_project(projectKey)` → `{ key, name, description, lead,
 *     projectType, issueTypes[], boards[] }` — the project's IDENTITY plus a
 *     cheap glance at what it contains. The identity echo is why the tool named
 *     "describe_project" returns the project's actual name (no guessing).
 *     `boards[]` lists each board with its open (active+future) sprints, so the
 *     agent has a proactive source for the sprint ids `create`/`update` accept
 *     (issue 15) — no separate discovery tool.
 *   - `describe_project(projectKey, issueType)` → `{ statuses[], transitions[],
 *     ruleFidelity }` — the named transition graph for that one issue type. Global
 *     transitions (firable from any status) are rendered with `from:"*"`; a
 *     transition reachable from several statuses expands to one `{name, from, to}`
 *     edge per source, so the result is a plain directed graph the agent can route
 *     over. Each edge also carries its GATES when readable (issue 19): `requires`
 *     (terse condition/validator phrases) and `hasScreen`. This graph is the
 *     design-time DEFINITION — `ruleFidelity` (`"full"|"topology"`) says whether a
 *     missing `requires` means ungated (full) or unknown (topology); a gated edge
 *     can still be unfirable for a given issue/user (only `jira_transition` knows).
 *
 * Workflow-only by design at tier-2: it does NOT fold in createmeta /
 * required-field data (that stays lazy in create_issue) and never surfaces
 * numeric transition ids. The whole point is a UNIFORM shape across
 * company-managed and team-managed projects — the company/team divergence is
 * abstracted at the JiraClient seam (see `getProjectWorkflow`), so this handler
 * treats both identically. This is the map `jira_transition` (slice 06) points
 * agents at when no direct edge exists between two statuses.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  boardSupportsSprints,
  isTeamManaged,
  type IJiraClient,
  type JiraProject,
  type JiraProjectBoard,
  type JiraWorkflowTransition,
} from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  shapeUncaughtError,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { log } from "../utils/logging.ts";

export const describeProjectInputShape = {
  projectKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The project key to describe, e.g. `ENG`. OMIT it for tier-0: the project catalog " +
        "(`{key, name, lead}[]`) — use that to find a key. Pass it for tier-1: the project's " +
        "identity (`key, name, description, lead`) plus its issue types.",
    ),
  issueType: z
    .string()
    .optional()
    .describe(
      "Issue type name (e.g. `Task`, `Bug`). Requires `projectKey`. Omit for the tier-1 glance " +
        "(identity + the list of issue types). Pass one to get that type's workflow: " +
        "its statuses and the named transition graph.",
    ),
};

export const describeProjectInputSchema = z.object(describeProjectInputShape);
export type DescribeProjectArgs = z.infer<typeof describeProjectInputSchema>;

export const DESCRIBE_PROJECT_DESCRIPTION =
  "Ground yourself in a project and map its workflow. Three tiers: omit everything for the " +
  "project catalog (`{key, name, lead}[]`); pass `projectKey` for that project's identity " +
  "(`key, name, description, lead`), its issue types, and its `boards[]` with each board's open " +
  "sprints (`{id, name, state}`) — the source for sprint ids `create`/`update` accept; add " +
  "`issueType` for that type's statuses and named transition graph (`{name, from, to}`, global " +
  "edges as `from:\"*\"`). Each edge also carries its GATES when readable: `requires` (terse " +
  "phrases for the conditions/validators it defines) and `hasScreen` (a transition screen exists — " +
  "it may carry only optional fields, so it doesn't always require input); a top-level `ruleFidelity` " +
  "says how to read a missing `requires` — `\"full\"` means ungated, `\"topology\"` means UNKNOWN " +
  "(rules weren't readable). A defined+gated edge may still not be firable for a given issue/user — " +
  "confirm with `jira_transition`. Uniform across company- and team-managed projects; no numeric ids.";

/**
 * A single agent-facing workflow edge. `from:"*"` marks a global transition.
 * `requires`/`hasScreen` carry the edge's GATES when readable (issue 19):
 * `requires` is omitted on an ungated edge (clean common case) and `hasScreen`
 * only appears when true (a transition screen is configured — which may carry
 * only optional fields, so it does not always require input). Under topology
 * fidelity these are absent and mean UNKNOWN, not none — the top-level
 * `ruleFidelity` flag is what disambiguates.
 */
interface WorkflowEdge {
  name: string;
  from: string;
  to: string;
  requires?: string[];
  hasScreen?: boolean;
}

function projectType(project: JiraProject): "company" | "team" {
  return isTeamManaged(project) ? "team" : "company";
}

/**
 * Expand the normalized transitions into a flat directed-edge list. A global
 * transition (and ONLY a global one) becomes a single `from:"*"` edge; a
 * directed one becomes an edge per source status (so a transition shared by N
 * statuses yields N edges). A directed transition with no resolvable source
 * yields no edge — we never coerce "unknown source" into the global `from:"*"`,
 * which would tell the agent it's firable from anywhere when it isn't.
 *
 * Each edge carries its gates: `requires` (only when non-empty — an ungated edge
 * stays clean) and `hasScreen` (only when true). Edges sharing a transition
 * (one per source) share the same gates, as JIRA defines them per transition.
 */
function toEdges(transitions: JiraWorkflowTransition[]): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  const gatesOf = (t: JiraWorkflowTransition): Pick<WorkflowEdge, "requires" | "hasScreen"> => ({
    ...(t.requires && t.requires.length > 0 ? { requires: t.requires } : {}),
    ...(t.hasScreen ? { hasScreen: true } : {}),
  });
  for (const t of transitions) {
    if (t.isGlobal) {
      edges.push({ name: t.name, from: "*", to: t.toStatus, ...gatesOf(t) });
      continue;
    }
    for (const from of t.fromStatuses) {
      edges.push({ name: t.name, from, to: t.toStatus, ...gatesOf(t) });
    }
  }
  return edges;
}

export async function describeProjectHandler(
  jira: IJiraClient,
  args: DescribeProjectArgs,
): Promise<CallToolResult> {
  // --- Tier 0: the project catalog -------------------------------------------
  // A reliable TOOL path to the same data as the `projects` resource, so the
  // agent can find a project key mid-task without depending on resource
  // activation (which isn't guaranteed across hosts).
  if (args.projectKey === undefined) {
    let projects;
    try {
      projects = await jira.listProjects();
    } catch (err) {
      return shapeUncaughtError(err);
    }
    const catalog = projects.map((p) => ({
      key: p.key,
      name: p.name,
      ...(p.lead !== undefined ? { lead: p.lead } : {}),
    }));
    return shapeSuccess({ projects: catalog }, [
      catalog.length > 0
        ? `${catalog.length} project(s) visible. Pass a \`key\` as \`projectKey\` for that project's identity and issue types.`
        : "No projects are visible to the token's account.",
    ]);
  }

  let project: JiraProject;
  try {
    project = await jira.getProject(args.projectKey);
  } catch (err) {
    if (err instanceof JiraApiError && err.isAuthError) return authErrorResult(err);
    if (err instanceof JiraApiError && err.isNotFound) {
      return shapeError(
        { message: `Project ${args.projectKey} was not found.`, code: "project_not_found" },
        [
          `No project matched the key \`${args.projectKey}\`. Check the key and that the token's ` +
            "account can see it; the `projects` resource lists every visible project.",
        ],
      );
    }
    if (err instanceof JiraApiError) return genericJiraErrorResult(err);
    return unexpectedErrorResult(err);
  }

  const issueTypeNames = (project.issueTypes ?? []).map((t) => t.name);

  // --- Tier 1: project identity + glance -------------------------------------
  // The identity echo (key/name/description/lead) is the fix for the agent
  // hallucinating a project name: the tool now actually states what the project
  // is called, so the agent never has to invent it.
  if (args.issueType === undefined) {
    // Boards + their open sprints are the agent's source for sprint ids (issue
    // 15). Best-effort: a project without JIRA Software (or no agile access)
    // returns no boards rather than failing the identity echo this tier is for.
    // `boards` is exactly the client's normalized shape (id/name/type/sprints),
    // so it is surfaced verbatim — no re-mapping.
    let boards: JiraProjectBoard[] = [];
    let boardsUnavailable = false;
    try {
      boards = await jira.listProjectBoards(args.projectKey);
    } catch (err) {
      boardsUnavailable = true;
      log.warn("project boards unavailable; describe_project returning boards:[]", {
        project: args.projectKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const sprintBoards = boards.filter((b) => boardSupportsSprints(b.type));
    const hints = [
      issueTypeNames.length > 0
        ? `Pass one of these as \`issueType\` for its workflow (statuses + transitions): ${issueTypeNames.join(", ")}.`
        : "This project reported no issue types visible to the token's account.",
    ];
    if (boardsUnavailable) {
      // Don't conflate "couldn't read boards" with "Kanban-only" — that would
      // tell the agent sprints are impossible when they may not be.
      hints.push(
        "Could not read this project's boards (JIRA Software may be unavailable or the token " +
          "lacks agile access); `boards` is empty as a result, not necessarily because there are none.",
      );
    } else if (sprintBoards.length === 0) {
      hints.push(
        "No sprint-supporting board (Kanban-only) — sprint assignment isn't available for this project.",
      );
    } else {
      const openSprints = sprintBoards.flatMap((b) => b.sprints);
      hints.push(
        openSprints.length > 0
          ? `Open sprints (assignable by id): ${openSprints.map((s) => `${s.name} (id ${s.id}, ${s.state})`).join(", ")}.`
          : "Sprint-supporting board(s) present but no open sprints right now.",
      );
    }

    return shapeSuccess(
      {
        key: project.key,
        name: project.name ?? null,
        description: project.description ?? null,
        lead: project.lead ?? null,
        projectType: projectType(project),
        issueTypes: issueTypeNames,
        boards,
      },
      hints,
    );
  }

  // --- Tier 2: the workflow for one issue type -------------------------------
  // Validate against the project's own types so an unknown type fails fast with
  // the valid options, rather than fetching a workflow that comes back empty.
  const matched = (project.issueTypes ?? []).find(
    (t) => t.name.toLowerCase() === args.issueType!.toLowerCase(),
  );
  if (!matched) {
    return shapeError(
      {
        message: `Issue type "${args.issueType}" is not valid for project ${args.projectKey}.`,
        code: "unknown_issue_type",
        options: issueTypeNames,
      },
      [
        issueTypeNames.length > 0
          ? `Valid issue types for ${args.projectKey}: ${issueTypeNames.join(", ")}. Retry with one of these.`
          : `${args.projectKey} reported no issue types visible to the token's account.`,
      ],
    );
  }

  let workflow;
  try {
    workflow = await jira.getProjectWorkflow({
      projectKey: args.projectKey,
      issueType: matched.name,
      // We already fetched the project above; hand over its id so the client
      // doesn't re-fetch it just to call the workflow endpoint.
      projectId: project.id,
    });
  } catch (err) {
    return shapeUncaughtError(err);
  }

  const edges = toEdges(workflow.transitions);
  const fidelity = workflow.ruleFidelity;
  const hints: string[] = [];
  if (edges.length > 0) {
    hints.push(
      `${edges.length} transition edge(s) across ${workflow.statuses.length} status(es). ` +
        "Fire one by name with `jira_transition`; `from:\"*\"` edges are global (firable from any status).",
    );
    if (fidelity === "full") {
      hints.push(
        'ruleFidelity "full": each edge\'s `requires` (terse gate phrases) and `hasScreen` reflect ' +
          "the workflow's actual gates — an edge with no `requires` is ungated. `hasScreen` means a " +
          "transition screen exists, not that input is mandatory (its fields may be optional); " +
          "`jira_transition` reports which fields, if any, are actually required. A gated edge may " +
          "still not be firable for a given issue/user; confirm with `jira_transition`.",
      );
    } else {
      hints.push(
        'ruleFidelity "topology": the workflow\'s gating rules were not readable at this permission ' +
          "level, so edges show what's POSSIBLE, not what's gated — a missing `requires` means UNKNOWN, " +
          "not ungated. Confirm firability with `jira_transition`.",
      );
    }
  } else if (fidelity === "topology") {
    // The transition graph itself couldn't be read (the statuses-only
    // degradation). The statuses above are still accurate; the per-issue
    // fallback (an issue's own available transitions, which any token can see)
    // is the way to discover edges without the global graph.
    hints.push(
      `Returned ${workflow.statuses.length} status(es) but the transition graph for ${matched.name} ` +
        "couldn't be read at this permission level (ruleFidelity \"topology\"). To find valid moves, " +
        "open a specific issue and read its available transitions via `jira_transition`.",
    );
  } else {
    // Read succeeded (full fidelity) but the workflow genuinely defines no edges
    // for this type — rare, but distinct from the unreadable case above.
    hints.push(
      `Returned ${workflow.statuses.length} status(es) and no transition edges for ${matched.name} — ` +
        "the workflow defines none. Open a specific issue and read its available transitions via " +
        "`jira_transition` to confirm.",
    );
  }

  return shapeSuccess(
    { statuses: workflow.statuses, transitions: edges, ruleFidelity: fidelity },
    hints,
  );
}

export function registerDescribeProjectTool(server: McpServer, jira: IJiraClient): void {
  server.registerTool(
    "jira_describe_project",
    {
      title: "Describe a JIRA project's workflow",
      description: DESCRIBE_PROJECT_DESCRIPTION,
      inputSchema: describeProjectInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => describeProjectHandler(jira, args),
  );
}
