/**
 * jira_transition — move an issue through its workflow.
 *
 * Transitions are treated as SEMANTIC ACTIONS, not status-moves: the agent
 * addresses one through a single `transition` field that accepts either a
 * transition NAME or a target STATUS, and the server never makes a semantic
 * route decision on the agent's behalf. Three behaviors carry the whole design:
 *
 *   1. Resolution order (name-first). An exact transition-name match always
 *      wins — this preserves distinct post-functions for two transitions that
 *      share a target status (e.g. "QA Failed" and "Put on Hold" both reaching
 *      "To Do"). Only if no name matches do we match by target status; and if a
 *      status is reachable by MORE THAN ONE transition we REFUSE and list the
 *      named options rather than firing the wrong action. Requesting the status
 *      the issue is already in is a graceful no-op.
 *
 *   2. Proactive screen-field validation. The single
 *      `GET .../transitions?expand=transitions.fields` read that resolves the
 *      name also yields each transition's required screen fields for free; if a
 *      required field is missing we return the precise list as a hint WITHOUT
 *      attempting a failing transition.
 *
 *   3. No server-side pathfinding. When no transition reaches the target in one
 *      hop, we return the current status's available next steps plus a pointer
 *      to `jira_describe_project` for the full graph — the agent walks multi-hop
 *      itself, one deliberate transition at a time (each hop has irreversible
 *      side-effects worth observing). We never compute a shortest path.
 *
 * Numeric transition ids never leave the server; the agent only ever passes a
 * name or a status. Screen-field keys (a friendly name or a field id) are
 * resolved to JIRA field ids once and reused for both the required-field check
 * and the execute payload.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  type IJiraClient,
  type JiraAvailableTransition,
  type JiraWorkflowTransition,
} from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  shapeUncaughtError,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { nameOf, projectKeyOf } from "../lib/issue-fields.ts";

export const transitionInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe("The issue to transition, e.g. `ABC-123`."),
  transition: z
    .string()
    .min(1)
    .describe(
      "A transition NAME (e.g. `Start Progress`) or a target STATUS name (e.g. `In Progress`). " +
        "Resolved name-first, then by status; matching is case- and whitespace-insensitive. " +
        "If several transitions reach the same status, the call is refused — pass the transition " +
        "name to disambiguate. Requesting the status the issue is already in is a no-op. " +
        "Never pass a numeric transition id.",
    ),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Screen fields some transitions require (e.g. a `Resolution` when closing), keyed by field " +
        "name or id → value. If you omit a required one, it is reported up front (no failed " +
        "attempt) so you can call once to discover the requirement, then again with this payload.",
    ),
};

export const transitionInputSchema = z.object(transitionInputShape);
export type TransitionArgs = z.infer<typeof transitionInputSchema>;

export const TRANSITION_DESCRIPTION =
  "Move an issue through its workflow. Pass a single `transition` — a transition NAME or a target " +
  "STATUS — and the server resolves it: an exact transition name always wins (preserving that " +
  "action's post-functions), otherwise it matches by target status. If a status is reachable by " +
  "more than one transition it refuses and lists the named options rather than guessing. " +
  "Requesting the status the issue is already in is a no-op. A transition needing screen fields " +
  "(e.g. a resolution) returns the required fields up front, before any attempt. No multi-hop " +
  "routing: when the target isn't reachable in one step you get the current status's options plus " +
  "a pointer to jira_describe_project — and, when the target IS defined from here but gated, the " +
  "workflow's definition reconciles the miss (it says the edge is defined and what it requires, " +
  "without claiming which gate blocked it). On success the response also lists the transitions now " +
  "available from the new status, so you can take the next hop of a manual multi-step move. " +
  "Never pass a numeric transition id.";

/** Trim, lowercase, and collapse internal whitespace — case/whitespace-insensitive matching. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Quote a list of names as `'a'`, `'a' or 'b'`, `'a', 'b', or 'c'`. */
function quotedList(names: string[]): string {
  const q = names.map((n) => `'${n}'`);
  if (q.length <= 1) return q.join("");
  if (q.length === 2) return `${q[0]} or ${q[1]}`;
  return `${q.slice(0, -1).join(", ")}, or ${q[q.length - 1]}`;
}

/** Render the available transitions as `"Name" → Status` for a recovery hint. */
function describeTransitions(transitions: JiraAvailableTransition[]): string {
  return transitions.map((t) => `"${t.name}" → ${t.toStatus}`).join(", ");
}

/**
 * The one clause every "here's what you can do from <status>" hint renders —
 * shared by the success next-steps hint, the no-op, the no-direct-edge recovery,
 * and the reactive-rejection recovery so the wording can't drift. A status with
 * no outgoing transitions is terminal.
 */
function availableTransitionsHint(status: string, transitions: JiraAvailableTransition[]): string {
  return transitions.length > 0
    ? `From "${status}", available (transition → status): ${describeTransitions(transitions)}.`
    : `No further transitions are available from "${status}".`;
}

/** The structured recovery `options` for a transition error — name + target. */
function transitionOptions(transitions: JiraAvailableTransition[]) {
  return transitions.map((t) => ({ transition: t.name, to: t.toStatus }));
}

/**
 * A terse summary of ONE defined edge's gates, for the reconciled-miss recovery.
 * Stays within verb discipline: it states what the edge *requires* (definition),
 * never which gate is unmet. Under topology fidelity the rules aren't readable, so
 * it says exactly that rather than implying "ungated".
 */
function gateBrief(edge: JiraWorkflowTransition, fidelity: "full" | "topology"): string {
  if (fidelity === "topology") return "gating rules not readable";
  if (edge.requires && edge.requires.length > 0) {
    return `requires ${quotedList(edge.requires)}${edge.hasScreen ? " + screen" : ""}`;
  }
  return "no gating rules";
}

export async function transitionHandler(
  jira: IJiraClient,
  args: TransitionArgs,
): Promise<CallToolResult> {
  const issueKey = args.issueKey;
  const target = args.transition;

  // One read of the current status, one read of the available transitions (the
  // latter carries screen fields for free via expand=transitions.fields). The
  // transitions endpoint lists only what's firable from the current status and
  // does NOT report the current status itself, so we read it explicitly — it
  // backs both the no-op check and the "from <status> you can go to…" hints.
  let currentStatus: string;
  let issueType: string;
  let transitions: JiraAvailableTransition[];
  try {
    const [issue, available] = await Promise.all([
      // `issuetype` rides this read for free; it's needed ONLY on the on-miss
      // reconciliation path (issue 19), which reads the workflow definition for
      // this type — no extra call on the common success path.
      jira.getIssue({ issueKey, fields: ["status", "issuetype"] }),
      jira.getTransitions({ issueKey }),
    ]);
    currentStatus = nameOf(issue.fields?.status) ?? "";
    issueType = nameOf(issue.fields?.issuetype) ?? "";
    transitions = available;
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) {
      return shapeError(
        { message: `Issue ${issueKey} was not found.`, code: "issue_not_found" },
        [
          `No issue matched \`${issueKey}\`. Check the key and that the token's account can see it. ` +
            "Nothing was transitioned.",
        ],
      );
    }
    return shapeUncaughtError(err);
  }

  const normTarget = norm(target);
  if (normTarget === "") {
    return shapeError(
      { message: "The `transition` argument is blank.", code: "invalid_transition_argument" },
      ["Pass a transition name or a target status name — a non-blank value is required."],
    );
  }

  // 1. Transition-NAME match wins (preserves distinct post-functions). JIRA
  //    allows duplicate transition names; if the name matches more than one we
  //    can't tell them apart for the agent, so we refuse rather than fire one at
  //    random — the same "never silently fire the wrong action" rule as below.
  const nameMatches = transitions.filter((t) => norm(t.name) === normTarget);
  if (nameMatches.length === 1) {
    return executeTransition(jira, issueKey, currentStatus, nameMatches[0]!, args.fields, transitions);
  }
  if (nameMatches.length > 1) {
    return shapeError(
      {
        message: `More than one transition out of "${currentStatus}" is named "${target}"; refusing to guess.`,
        code: "ambiguous_transition",
        options: transitionOptions(nameMatches),
      },
      [
        `"${target}" names ${nameMatches.length} distinct transitions (transition → status: ${describeTransitions(nameMatches)}) — ` +
          "they can't be told apart by name. This is a workflow ambiguity to resolve in JIRA itself.",
      ],
    );
  }

  // 2. Asking for the status the issue is already in is a graceful no-op. Guarded
  //    on a known current status so a blank/unreadable status can't false-no-op.
  if (currentStatus !== "" && normTarget === norm(currentStatus)) {
    // Reuses the up-front transitions (status is unchanged) — no second fetch.
    return shapeSuccess(
      { issueKey, status: currentStatus, moved: false },
      [
        `${issueKey} is already in "${currentStatus}" — nothing to do.`,
        availableTransitionsHint(currentStatus, transitions),
      ],
    );
  }

  // 3. Target-STATUS match. Zero → no direct edge; one → fire it; >1 → refuse.
  const statusMatches = transitions.filter((t) => norm(t.toStatus) === normTarget);
  if (statusMatches.length === 1) {
    return executeTransition(jira, issueKey, currentStatus, statusMatches[0]!, args.fields, transitions);
  }
  if (statusMatches.length > 1) {
    const names = statusMatches.map((t) => t.name);
    return shapeError(
      {
        message: `Status "${target}" is reachable from "${currentStatus}" by more than one transition; refusing to guess.`,
        code: "ambiguous_transition",
        options: names,
      },
      [
        `"${target}" is reachable via ${quotedList(names)} — pass the transition name as \`transition\` ` +
          "instead of the status, so the intended action (and its post-functions) fires.",
      ],
    );
  }

  // 4. No transition reaches the target in one hop. Reconcile against the
  //    workflow DEFINITION so a "no direct transition" never just contradicts
  //    the map describe_project showed (issue 19). This is the ONE extra call,
  //    failure-only. The server still computes NO route.
  const projectKey = projectKeyOf(issueKey);
  return reconciledMiss(jira, issueKey, projectKey, issueType, currentStatus, target, transitions);
}

/**
 * Build the on-miss recovery, reconciled against the workflow definition.
 *
 * We cross-reference the defined edges firable FROM the current status (read via
 * `getProjectWorkflow`, failure-only) so the agent learns whether its target is
 * defined-but-gated, defined-but-rules-unreadable, or genuinely undefined —
 * instead of a bare "no direct transition" that contradicts describe_project's
 * map. The verb discipline is load-bearing (issue 19, section D):
 *   - ALLOWED: "the workflow DEFINES X", "X REQUIRES [Y,Z]", "X is NOT AVAILABLE".
 *   - FORBIDDEN: "X failed BECAUSE Z" — `getTransitions` never told us WHY, and we
 *     never evaluate conditions. The block is attributed to "one or more of these
 *     (we don't evaluate which)".
 * `getTransitions` stays the SOLE firability authority — we never compute a
 * per-issue verdict from the rules.
 */
async function reconciledMiss(
  jira: IJiraClient,
  issueKey: string,
  projectKey: string,
  issueType: string,
  currentStatus: string,
  target: string,
  transitions: JiraAvailableTransition[],
): Promise<CallToolResult> {
  const normTarget = norm(target);
  const firableNow = availableTransitionsHint(currentStatus, transitions);
  const describePointer =
    `This server does not compute multi-hop routes. For the full workflow graph call ` +
    `jira_describe_project (projectKey \`${projectKey}\`), then walk it one transition at a time.`;

  // Read the workflow definition — failure-only, best-effort. A failure here must
  // never turn into a worse error than the original "no direct transition", so we
  // fall back to the prior recovery message (no regression).
  let defined: JiraWorkflowTransition[] = [];
  let fidelity: "full" | "topology" | null = null;
  if (issueType !== "") {
    try {
      const workflow = await jira.getProjectWorkflow({ projectKey, issueType });
      fidelity = workflow.ruleFidelity;
      // Edges DEFINED as firable from the current status (global or sourced here)
      // whose name or target status matches what the agent asked for.
      defined = workflow.transitions.filter(
        (t) =>
          (t.isGlobal || t.fromStatuses.some((f) => norm(f) === norm(currentStatus))) &&
          (norm(t.toStatus) === normTarget || norm(t.name) === normTarget),
      );
    } catch {
      // Workflow unreadable — degrade to the original (pre-issue-19) recovery.
    }
  }

  const baseError = {
    message: `No transition from "${currentStatus}" reaches "${target}" for ${issueKey}.`,
    code: "no_direct_transition" as const,
    options: transitionOptions(transitions),
  };

  // Reconciliation unavailable (workflow read failed / no issue type): preserve
  // the exact prior recovery.
  if (fidelity === null) {
    return shapeError(baseError, [
      `${firableNow} "${target}" isn't directly reachable from "${currentStatus}" in one hop.`,
      describePointer,
    ]);
  }

  // Genuinely undefined: no edge to the target is defined from here.
  if (defined.length === 0) {
    return shapeError(baseError, [
      `No transition to "${target}" is defined from "${currentStatus}" in the workflow.`,
      firableNow,
      describePointer,
    ]);
  }

  // Defined but not in the runtime-available set → reconcile, citing the gates
  // (full) or stating they aren't readable (topology). Never assert WHICH gate.
  const edge = defined[0]!;
  const edgeLabel = `"${currentStatus}" → "${edge.toStatus}" via "${edge.name}"`;
  // When MORE THAN ONE transition matches, each may be gated DIFFERENTLY — so we
  // carry each one's OWN gates here, never letting the lead edge's `requires`
  // stand in for the rest (that would misrepresent which gates apply to which).
  const alsoDefined =
    defined.length > 1
      ? ` (also defined here, each gated on its own: ${defined
          .slice(1)
          .map((d) => `"${d.name}" → "${d.toStatus}" [${gateBrief(d, fidelity)}]`)
          .join("; ")})`
      : "";

  let reconciled: string;
  if (fidelity === "topology") {
    reconciled =
      `The workflow defines ${edgeLabel}${alsoDefined}, but it isn't currently available and its ` +
      `gating rules aren't readable at this permission level — so a precondition or permission isn't ` +
      `met for this issue/you, but we can't list which gates (and we don't evaluate which).`;
  } else if (edge.requires && edge.requires.length > 0) {
    const screenClause = edge.hasScreen ? " and shows a screen" : "";
    reconciled =
      `The workflow defines ${edgeLabel}${alsoDefined}. It requires ${quotedList(edge.requires)}${screenClause} ` +
      `and isn't currently available — one or more of those gates or a permission isn't met for this ` +
      `issue/you (we don't evaluate which).`;
  } else {
    // Full fidelity, ungated definition: it's still not in the available set, so
    // a permission/precondition outside the workflow's own gates must be unmet.
    reconciled =
      `The workflow defines ${edgeLabel}${alsoDefined} with no gating rules, but it isn't currently ` +
      `available — a permission or precondition is unmet for this issue/you (we don't evaluate which).`;
  }

  return shapeError(baseError, [reconciled, firableNow]);
}

/**
 * Validate the resolved transition's required screen fields PROACTIVELY off the
 * metadata already in hand, then fire it. A missing required field returns the
 * precise list with no attempt; a transition JIRA still rejects (4xx) comes back
 * with the (unchanged-status) available transitions as a reactive recovery hint.
 *
 * On success, a single FRESH `getTransitions` reads the next legal steps from the
 * NEW status (the up-front list is now stale) and appends them to the hints — the
 * in-tool complement to no-pathfinding. That follow-up read is best-effort: if it
 * fails the transition still succeeded, so the hint is simply omitted.
 */
async function executeTransition(
  jira: IJiraClient,
  issueKey: string,
  currentStatus: string,
  transition: JiraAvailableTransition,
  providedFields: Record<string, unknown> | undefined,
  allTransitions: JiraAvailableTransition[],
): Promise<CallToolResult> {
  // Resolve each provided key (friendly name OR field id) to its JIRA field id
  // ONCE, so the required-field check and the execute payload read from the
  // same map and can never diverge (the check passing while the value lands on
  // a different field).
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providedFields ?? {})) {
    resolved[resolveFieldId(key, transition.fields)] = value;
  }

  const missing = transition.fields.filter((f) => f.required && !(f.fieldId in resolved));
  if (missing.length > 0) {
    const names = missing.map((f) => f.name);
    return shapeError(
      {
        message: `Transition "${transition.name}" requires screen field(s) not supplied: ${names.join(", ")}.`,
        code: "transition_requires_fields",
        options: names,
      },
      [
        `"${transition.name}" has a screen requiring ${quotedList(names)}. Re-call with a \`fields\` ` +
          "payload providing them — no transition was attempted, so the issue is unchanged.",
      ],
    );
  }

  const fields = Object.keys(resolved).length > 0 ? resolved : undefined;

  try {
    await jira.doTransition({ issueKey, transitionId: transition.id, fields });
  } catch (err) {
    if (err instanceof JiraApiError) {
      // The status + transitions reads already succeeded with this token, so a
      // failure firing the transition is never a credential problem except a
      // literal 401: a 403 here means a transition condition/permission, and a
      // 404 means the issue vanished mid-flight — neither is "fix your token".
      if (err.status === 401) return authErrorResult(err);
      if (err.isNotFound) {
        return shapeError(
          { message: `Issue ${issueKey} was not found when firing "${transition.name}".`, code: "issue_not_found" },
          [
            `${issueKey} no longer exists or the token lost access between reading and transitioning it. ` +
              "Re-open it to confirm before retrying.",
          ],
        );
      }
      if (err.status >= 400 && err.status < 500) {
        return shapeError(
          {
            message: `JIRA rejected the transition "${transition.name}" for ${issueKey}.`,
            code: "transition_rejected",
            options: transitionOptions(allTransitions),
          },
          [
            err.errorMessages.length > 0 ? err.errorMessages.join(" ") : err.message,
            availableTransitionsHint(currentStatus, allTransitions),
          ],
        );
      }
      return genericJiraErrorResult(err);
    }
    return unexpectedErrorResult(err);
  }

  // Succeeded. Surface the next legal steps from the NEW status so a manual
  // multi-step move can take its next hop without a separate lookup. Best-effort:
  // never let this follow-up read turn a completed transition into a failure.
  const hints = [`Moved ${issueKey} to "${transition.toStatus}" via "${transition.name}".`];
  try {
    const next = await jira.getTransitions({ issueKey });
    hints.push(availableTransitionsHint(transition.toStatus, next));
  } catch {
    // The transition is done; the next-steps read is advisory, so omit it.
  }

  return shapeSuccess(
    { issueKey, status: transition.toStatus, moved: true, transition: transition.name },
    hints,
  );
}

/** Resolve an agent-supplied field key (friendly name or id) to JIRA's field id. */
function resolveFieldId(key: string, fields: JiraAvailableTransition["fields"]): string {
  const match = fields.find((f) => norm(f.fieldId) === norm(key) || norm(f.name) === norm(key));
  return match ? match.fieldId : key;
}

export function registerTransitionTool(server: McpServer, jira: IJiraClient): void {
  server.registerTool(
    "jira_transition",
    {
      title: "Transition a JIRA issue",
      description: TRANSITION_DESCRIPTION,
      inputSchema: transitionInputShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => transitionHandler(jira, args),
  );
}
