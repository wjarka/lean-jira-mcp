/**
 * jira_update_issue — edit an existing issue's fields.
 *
 * The thin sibling of `jira_create_issue`: it reuses the same shared primitives
 * (the {@link IssueFieldsBuilder}, the reference resolver, and the markdown→ADF
 * converter) so the two write tools emit an identical `{ fields, update }`
 * envelope and resolve human references the same way. Two behaviors define the
 * update path specifically:
 *
 *   - **Non-destructive multi-value edits.** `addLabels`/`removeLabels` (and the
 *     same for components and fix-versions) route to JIRA's native `update` ops
 *     so the rest of the array is never clobbered. An explicit, clearly-named
 *     `setLabels` replaces the whole array via the `fields` section — destructive
 *     replacement is opt-in, never accidental.
 *   - **Presence-aware partial update.** A field absent from the input is left
 *     untouched; a field passed as `null` is cleared (e.g. `assignee: null`
 *     unassigns). The builder's {@link IssueFieldsBuilder.setIfPresent} encodes
 *     exactly this leave-vs-clear distinction.
 *
 * Issue-11 hardening is REUSED here, not re-implemented: `parent` goes through
 * the discriminated {@link resolveParent} (validates the key exists, picks the
 * company-/team-managed mechanism) and is named in the success hint, so the
 * silent team-managed parent-drop cannot return; `description` goes through
 * {@link convertMarkdown} and folds its coarse degradation list into the success
 * hints. The global handler error boundary and status-aware error mapping are
 * inherited — this handler never catch-and-swallows around them.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { JiraApiError, type IJiraClient } from "../lib/jira-client.ts";
import { browseUrl, shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  isDetaillessValidation,
  richTextValidationResult,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { IssueFieldsBuilder } from "../lib/issue-field-builder.ts";
import { projectKeyOf } from "../lib/issue-fields.ts";
import { convertMarkdown, degradationHint, type Degradation } from "../lib/markdown-to-adf.ts";
import {
  describeUser,
  resolveAssignee,
  resolveParent,
  resolveSprint,
  safeGatherSprintCandidates,
  type AssigneeResolution,
} from "../lib/reference-resolver.ts";
import {
  availableSprintsClause,
  sprintCandidateOptions,
  sprintResolutionFailure,
} from "../lib/sprint-hints.ts";
import { epicLinkUnavailableResult } from "../lib/parent-hints.ts";
import {
  resolveEpicLinkFieldId,
  type CuratedFieldsProvider,
} from "../lib/curated-field-provider.ts";

export const updateIssueInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe("Key of the issue to update (e.g. `ABC-123`). The only required field."),
  summary: z
    .string()
    .optional()
    .describe("New one-line summary (title). Absent leaves it unchanged."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New description as markdown (converted to ADF). Pass `null` to clear it; omit to leave it " +
        "unchanged. @mentions and images are out of scope in v1.",
    ),
  assignee: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Assignee as an email, display name, or `me`/`currentUser`, resolved server-side — never " +
        "pass an accountId. Pass `null` to unassign; omit to leave the assignee unchanged.",
    ),
  reporter: z
    .string()
    .optional()
    .describe(
      "Reporter as an email, display name, or `me`/`currentUser`, resolved server-side. Changing " +
        "the reporter requires the project's Modify Reporter permission; if it's forbidden a clear " +
        "hint is returned rather than a raw error.",
    ),
  priority: z
    .string()
    .nullable()
    .optional()
    .describe("Priority name (e.g. `High`). Pass `null` to clear it; omit to leave it unchanged."),
  duedate: z
    .string()
    .nullable()
    .optional()
    .describe("Due date as `YYYY-MM-DD`. Pass `null` to clear it; omit to leave it unchanged."),
  parent: z
    .string()
    .optional()
    .describe(
      "Parent issue key (e.g. an epic `ABC-100`, or a story for a subtask). The server validates " +
        "the key and resolves the company- vs team-managed mechanism (Epic Link field vs `parent`).",
    ),
  sprint: z
    .union([z.number().int(), z.string()])
    .nullable()
    .optional()
    .describe(
      "Sprint to move the issue to: a numeric sprint id, `current` for the active sprint, or a " +
        "sprint name (resolved against the project's scrum boards). Pass `null` to move the issue " +
        "to the backlog (clear its sprint); omit to leave the sprint unchanged. An ambiguous or " +
        "unknown reference returns candidate ids rather than guessing.",
    ),
  addLabels: z
    .array(z.string())
    .optional()
    .describe("Labels to ADD without touching the rest of the array. Labels cannot contain spaces."),
  removeLabels: z
    .array(z.string())
    .optional()
    .describe("Labels to REMOVE without touching the rest of the array."),
  setLabels: z
    .array(z.string())
    .optional()
    .describe(
      "Replace the ENTIRE label array with exactly these (destructive). Mutually exclusive with " +
        "`addLabels`/`removeLabels`.",
    ),
  addComponents: z
    .array(z.string())
    .optional()
    .describe("Component names to ADD without replacing the existing components."),
  removeComponents: z
    .array(z.string())
    .optional()
    .describe("Component names to REMOVE without replacing the existing components."),
  setComponents: z
    .array(z.string())
    .optional()
    .describe("Replace the ENTIRE component list with exactly these (destructive)."),
  addFixVersions: z
    .array(z.string())
    .optional()
    .describe("Fix-version names to ADD without replacing the existing fix-versions."),
  removeFixVersions: z
    .array(z.string())
    .optional()
    .describe("Fix-version names to REMOVE without replacing the existing fix-versions."),
  setFixVersions: z
    .array(z.string())
    .optional()
    .describe("Replace the ENTIRE fix-version list with exactly these (destructive)."),
};

export const updateIssueInputSchema = z.object(updateIssueInputShape);
export type UpdateIssueArgs = z.infer<typeof updateIssueInputSchema>;

export const UPDATE_ISSUE_DESCRIPTION =
  "Update an existing JIRA issue's fields. Partial and presence-aware: a field you omit is left " +
  "unchanged, and a field passed as `null` is cleared (e.g. `assignee: null` unassigns). Multi-value " +
  "fields are non-destructive — `addLabels`/`removeLabels` (and the same for components, fixVersions) " +
  "touch only the named values, while `setLabels` replaces the whole array. `assignee`, `reporter`, " +
  "`parent`, and `sprint` are resolved server-side; `description` is authored as markdown.";

export interface UpdateIssueDeps {
  /** JIRA base URL, for building the returned `url`. */
  baseUrl: string;
  /**
   * Resolves the curated agile-field ids per instance (memoized). Used here only
   * for the company-managed parent (Epic Link) WRITE — sprint rides the Agile
   * endpoint and needs no field id. Defaults to the cloud-default ids when omitted.
   */
  curatedFieldsProvider?: CuratedFieldsProvider;
}

/** One multi-value field's three op buckets plus how a single value is shaped. */
interface MultiValueSpec {
  field: "labels" | "components" | "fixVersions";
  add: string[] | undefined;
  remove: string[] | undefined;
  set: string[] | undefined;
  /** Labels are bare strings; components/fix-versions are `{ name }`. */
  wrap: (value: string) => unknown;
}

export async function updateIssueHandler(
  jira: IJiraClient,
  args: UpdateIssueArgs,
  deps: UpdateIssueDeps,
): Promise<CallToolResult> {
  const issueKey = args.issueKey;
  const builder = new IssueFieldsBuilder();
  const changed: string[] = [];

  const multi: MultiValueSpec[] = [
    { field: "labels", add: args.addLabels, remove: args.removeLabels, set: args.setLabels, wrap: (v) => v },
    {
      field: "components",
      add: args.addComponents,
      remove: args.removeComponents,
      set: args.setComponents,
      wrap: (v) => ({ name: v }),
    },
    {
      field: "fixVersions",
      add: args.addFixVersions,
      remove: args.removeFixVersions,
      set: args.setFixVersions,
      wrap: (v) => ({ name: v }),
    },
  ];

  // --- multi-value validation (cheap, before any round-trip) ------------------

  // Set-all and add/remove on the same field would land in both `fields` and
  // `update`, which JIRA rejects — refuse it up front with a clear hint.
  for (const m of multi) {
    if (m.set !== undefined && (m.add !== undefined || m.remove !== undefined)) {
      return shapeError(
        {
          message: `\`set${capitalize(m.field)}\` cannot be combined with \`add${capitalize(m.field)}\`/\`remove${capitalize(m.field)}\`.`,
          code: "multi_value_conflict",
        },
        [
          `Pass EITHER \`set${capitalize(m.field)}\` (replace the whole array) OR ` +
            `\`add${capitalize(m.field)}\`/\`remove${capitalize(m.field)}\` (non-destructive deltas), not both. Nothing was changed.`,
        ],
      );
    }
  }

  // JIRA labels cannot contain whitespace; reject with the rule rather than
  // silently mangling the agent's value.
  const allLabels = [...(args.addLabels ?? []), ...(args.removeLabels ?? []), ...(args.setLabels ?? [])];
  const badLabel = allLabels.find((l) => /\s/.test(l));
  if (badLabel !== undefined) {
    return shapeError(
      { message: `Label "${badLabel}" contains a space.`, code: "invalid_label", options: [badLabel] },
      [
        `JIRA labels cannot contain spaces. Replace the space(s) in "${badLabel}" with a hyphen or ` +
          "underscore (e.g. `needs-review`) and retry. Nothing was changed.",
      ],
    );
  }

  // --- scalar, presence-aware sets (absent = leave; null = clear) -------------

  if (args.summary !== undefined) {
    builder.set("summary", args.summary);
    changed.push("summary");
  }

  let descriptionDegradations: Degradation[] = [];
  // Whether a markdown→ADF `description` was sent (a non-null body). Clearing
  // (`null`) sends no converted content, so it can't be the cause of a
  // detailless validation rejection.
  let richTextSent = false;
  if (args.description !== undefined) {
    if (args.description === null) {
      builder.set("description", null);
      changed.push("cleared description");
    } else {
      const converted = convertMarkdown(args.description);
      builder.set("description", converted.doc);
      descriptionDegradations = converted.degradations;
      richTextSent = true;
      changed.push("description");
    }
  }

  if (args.priority !== undefined) {
    builder.set("priority", args.priority === null ? null : { name: args.priority });
    changed.push(args.priority === null ? "cleared priority" : "priority");
  }

  if (args.duedate !== undefined) {
    builder.setIfPresent("duedate", args.duedate);
    changed.push(args.duedate === null ? "cleared due date" : "due date");
  }

  // --- references (fail fast; never write with a guessed value) ---------------

  let reporterChanged = false;

  if (args.assignee !== undefined) {
    if (args.assignee === null) {
      builder.set("assignee", null);
      changed.push("unassigned");
    } else {
      const resolution = await resolveAssignee(jira, args.assignee);
      if (resolution.kind !== "resolved") {
        return userResolutionFailure(resolution, "assignee", args.assignee);
      }
      builder.set("assignee", { accountId: resolution.accountId });
      changed.push("assignee");
    }
  }

  if (args.reporter !== undefined) {
    const resolution = await resolveAssignee(jira, args.reporter);
    if (resolution.kind !== "resolved") {
      return userResolutionFailure(resolution, "reporter", args.reporter);
    }
    builder.set("reporter", { accountId: resolution.accountId });
    reporterChanged = true;
    changed.push("reporter");
  }

  if (args.parent !== undefined) {
    const projectKey = projectKeyOf(issueKey);
    // Company-managed parent rides the DETECTED Epic Link id (issue 15 A2).
    const epicLinkFieldId = await resolveEpicLinkFieldId(deps.curatedFieldsProvider);
    const resolution = await resolveParent(jira, projectKey, args.parent, epicLinkFieldId);
    if (resolution.kind === "not_found") {
      return shapeError(
        { message: `Parent issue ${args.parent} was not found.`, code: "parent_not_found" },
        [
          `Parent ${args.parent} doesn't exist or the token can't see it. Check the key and retry. ` +
            "Nothing was changed.",
        ],
      );
    }
    if (resolution.kind === "epic_link_unavailable") {
      return epicLinkUnavailableResult(args.parent, "changed");
    }
    builder.set(resolution.contribution.fieldId, resolution.contribution.value);
    changed.push(`parent ${args.parent}`);
  }

  // Sprint is resolved up front (fail fast) but applied via the Agile endpoint
  // AFTER the field update — it is no longer a field on the update payload.
  // `null` clears (move to backlog); a reference assigns.
  let sprintAction: { kind: "assign"; sprintId: number } | { kind: "clear" } | undefined;
  if (args.sprint === null) {
    sprintAction = { kind: "clear" };
  } else if (args.sprint !== undefined) {
    const projectKey = projectKeyOf(issueKey);
    const resolution = await resolveSprint(jira, args.sprint, projectKey);
    if (resolution.kind !== "resolved") {
      return sprintResolutionFailure(resolution, projectKey, "changed");
    }
    sprintAction = { kind: "assign", sprintId: resolution.sprintId };
  }

  // --- multi-value ops --------------------------------------------------------

  for (const m of multi) {
    if (m.set !== undefined) {
      builder.set(m.field, m.set.map(m.wrap));
      changed.push(`set ${m.field} [${m.set.join(", ")}]`);
    }
    if (m.add && m.add.length > 0) {
      for (const v of m.add) builder.op(m.field, "add", m.wrap(v));
      changed.push(`added ${m.field} [${m.add.join(", ")}]`);
    }
    if (m.remove && m.remove.length > 0) {
      for (const v of m.remove) builder.op(m.field, "remove", m.wrap(v));
      changed.push(`removed ${m.field} [${m.remove.join(", ")}]`);
    }
  }

  // --- nothing-to-update guard ------------------------------------------------
  // A sprint move/clear counts as a change even though it rides a separate
  // (Agile) call and never lands in the field payload.

  const payload = builder.build();
  if (!payload.fields && !payload.update && sprintAction === undefined) {
    return shapeError(
      { message: "No fields to update were provided.", code: "nothing_to_update" },
      [
        "The update carried no changes. Pass at least one field (e.g. `summary`, `assignee`, " +
          "`addLabels`, `sprint`), or `null` to clear a field.",
      ],
    );
  }

  // --- field update -----------------------------------------------------------

  if (payload.fields || payload.update) {
    try {
      await jira.updateIssue({ issueKey, ...payload });
    } catch (err) {
      if (err instanceof JiraApiError) {
        // Rejected credentials always win — a 401/403 is an auth/permission
        // problem, not something "retry without reporter" can fix, so it must not
        // be captured by the reporter branch below (which matches on 403 too).
        if (err.isAuthError) return authErrorResult(err);
        // A reporter change the project forbids comes back as a non-auth
        // field-level rejection (a 400); surface it as actionable guidance.
        if (reporterChanged && mentionsReporter(err)) {
          return shapeError(
            { message: err.message, code: "reporter_not_permitted" },
            [
              `Could not change the reporter on ${issueKey} — your account lacks the project's ` +
                `Modify Reporter permission (JIRA: ${err.message}). No fields were changed; retry without \`reporter\`.`,
            ],
          );
        }
        if (err.isNotFound) {
          return shapeError(
            { message: `Issue ${issueKey} was not found.`, code: "issue_not_found" },
            [
              `No issue matched ${issueKey} (or the token can't see it). Check the key and retry. ` +
                "Nothing was changed.",
            ],
          );
        }
        // A bare INVALID_INPUT with no field-level detail AND a markdown→ADF
        // `description` in the payload: point at the conversion rather than a
        // dead-end generic hint (issue 20, bug B).
        if (richTextSent && isDetaillessValidation(err)) {
          return richTextValidationResult(err, "description");
        }
        if (err.status >= 400 && err.status < 500) {
          return fieldValidationResult(err);
        }
        return genericJiraErrorResult(err);
      }
      return unexpectedErrorResult(err);
    }
  }

  // --- sprint move/clear (non-atomic with the field update above) -------------
  // The Agile call is separate from the field PUT. If the field update already
  // succeeded, a sprint-op failure is reported as a partial success (the fields
  // DID change) rather than rolling back or pretending atomicity.
  if (sprintAction !== undefined) {
    try {
      if (sprintAction.kind === "assign") {
        await jira.addIssueToSprint(sprintAction.sprintId, issueKey);
        changed.push(`sprint ${sprintAction.sprintId}`);
      } else {
        await jira.moveIssueToBacklog(issueKey);
        changed.push("moved to backlog");
      }
    } catch (err) {
      const reason = err instanceof JiraApiError ? err.message : String((err as Error)?.message ?? err);
      const what =
        sprintAction.kind === "assign"
          ? `sprint assignment to ${sprintAction.sprintId}`
          : "move to the backlog";
      const fieldsChanged = changed.length > 0;
      // A rejected-credentials failure on a sprint-only update isn't something a
      // sprint-specific hint can fix — surface the auth guidance. (When fields
      // already changed we fall through to the partial-success report below,
      // which names the reason verbatim; an auth error would be misleading there
      // since the field PUT plainly succeeded.)
      if (err instanceof JiraApiError && err.isAuthError && !fieldsChanged) {
        return authErrorResult(err);
      }
      // Only an ASSIGN can fail because the id matched no sprint — list the
      // project's open sprints so the retry lands on a valid id (best-effort, so
      // a discovery failure falls back to the bare reason). A CLEAR failure must
      // NOT suggest a sprint id: the agent was trying to remove the sprint.
      const inventory =
        sprintAction.kind === "assign"
          ? await safeGatherSprintCandidates(jira, projectKeyOf(issueKey))
          : undefined;
      const clause = inventory ? availableSprintsClause(inventory) : "";
      const options = inventory ? sprintCandidateOptions(inventory) : undefined;
      if (fieldsChanged) {
        // Partial success: fields changed, sprint did not. Report the truth.
        return shapeSuccess(
          { key: issueKey, url: browseUrl(deps.baseUrl, issueKey) },
          [
            `Updated ${issueKey}: ${changed.join("; ")}. But the ${what} failed (${reason}) — ` +
              `the issue's sprint was NOT changed.${clause} Retry the sprint move separately.`,
          ],
        );
      }
      return shapeError(
        {
          message: `Sprint ${what} failed for ${issueKey}: ${reason}`,
          code: "sprint_move_failed",
          ...(options ? { options } : {}),
        },
        [
          `The ${what} failed (${reason}). Nothing was changed.` +
            (clause ||
              " Check the sprint id is open and the issue belongs to a project with a sprint-supporting board."),
        ],
      );
    }
  }

  const url = browseUrl(deps.baseUrl, issueKey);
  const hints = [
    `Updated ${issueKey}${changed.length > 0 ? `: ${changed.join("; ")}` : ""}. ` +
      "Re-read it with jira_get_issue to confirm.",
  ];
  const degraded = degradationHint(descriptionDegradations);
  if (degraded) hints.push(degraded);
  return shapeSuccess({ key: issueKey, url }, hints);
}

/** Shape a recovery hint for an unresolvable/ambiguous user reference (assignee/reporter). */
function userResolutionFailure(
  resolution: Exclude<AssigneeResolution, { kind: "resolved" }>,
  field: "assignee" | "reporter",
  ref: string,
): CallToolResult {
  if (resolution.kind === "none") {
    return shapeError(
      { message: `No JIRA user matched "${ref}".`, code: `${field}_not_found` },
      [
        `No user matched "${ref}". Pass an exact email or display name, or \`me\`. Nothing was changed.`,
      ],
    );
  }
  return shapeError(
    {
      message: `"${ref}" matched more than one user.`,
      code: `${field}_ambiguous`,
      options: resolution.candidates.map(describeUser),
    },
    [
      `"${ref}" is ambiguous (${resolution.candidates.length} matches). ` +
        `Retry with a specific email: ${resolution.candidates.map(describeUser).join(", ")}. Nothing was changed.`,
    ],
  );
}

/** A non-auth 4xx with JIRA's own field errors surfaced verbatim. */
function fieldValidationResult(err: JiraApiError): CallToolResult {
  const entries = Object.entries(err.errors);
  const hints: string[] = [];
  if (entries.length > 0) {
    hints.push(
      "JIRA rejected: " +
        entries.map(([field, message]) => `${field} (${message})`).join("; ") +
        ". Re-check those values; nothing was changed.",
    );
  }
  if (err.errorMessages.length > 0) hints.push(err.errorMessages.join(" "));
  if (hints.length === 0) {
    hints.push("JIRA rejected the update as invalid. Re-check the arguments; nothing was changed.");
  }
  return shapeError(
    {
      message: err.message,
      code: "field_validation_failed",
      ...(entries.length > 0 ? { options: entries.map(([field]) => field) } : {}),
    },
    hints,
  );
}

function mentionsReporter(err: JiraApiError): boolean {
  return "reporter" in (err.errors ?? {}) || err.errorMessages.some((m) => /reporter/i.test(m));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function registerUpdateIssueTool(
  server: McpServer,
  jira: IJiraClient,
  deps: UpdateIssueDeps,
): void {
  server.registerTool(
    "jira_update_issue",
    {
      title: "Update a JIRA issue",
      description: UPDATE_ISSUE_DESCRIPTION,
      inputSchema: updateIssueInputShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => updateIssueHandler(jira, args, deps),
  );
}
