/**
 * jira_create_issue — create an issue from minimal input.
 *
 * The common case is one cheap call: pass only a `summary` and the project
 * (env default) and issue type ("Task") are filled in. Everything else is
 * optional. Rich text is authored as markdown and converted to ADF server-side;
 * human references (assignee, parent, sprint) are resolved to JIRA internals by
 * the shared reference resolver so the agent never handles an accountId, a
 * sprint id, or the company-/team-managed parent mechanism.
 *
 * This slice establishes two reused primitives — the {@link IssueFieldsBuilder}
 * and the reference resolver — that `jira_update_issue` (05), `jira_transition`
 * (06), and `jira_comment` (07) build on; create only uses their set side here.
 *
 * Design invariant worth guarding: createmeta is the round-trip tax we
 * deliberately avoid, so it is fetched ONLY after a create fails (to turn a bare
 * rejection into a required-field / valid-type recovery hint), never proactively
 * to "pre-validate". References, by contrast, are resolved up front and any
 * unresolvable/ambiguous one fails fast with candidate options — the issue is
 * never created with a guessed value.
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
import { convertMarkdown, degradationHint, type Degradation } from "../lib/markdown-to-adf.ts";
import {
  describeUser,
  resolveAssignee,
  resolveParent,
  resolveSprint,
  safeGatherSprintCandidates,
} from "../lib/reference-resolver.ts";
import { availableSprintsClause, sprintResolutionFailure } from "../lib/sprint-hints.ts";
import { epicLinkUnavailableResult } from "../lib/parent-hints.ts";
import {
  resolveEpicLinkFieldId,
  type CuratedFieldsProvider,
} from "../lib/curated-field-provider.ts";

const DEFAULT_ISSUE_TYPE = "Task";

export const createIssueInputShape = {
  summary: z
    .string()
    .min(1)
    .describe("The issue's one-line summary (title). The only required field."),
  project: z
    .string()
    .optional()
    .describe(
      "Project key to create the issue in (e.g. `ABC`). Defaults to the server's " +
        "configured project, so the common case can omit it.",
    ),
  issuetype: z
    .string()
    .default(DEFAULT_ISSUE_TYPE)
    .describe(
      'Issue type name (e.g. `Task`, `Bug`, `Story`). Defaults to `Task`. If it is not a ' +
        "valid type for the project, the create is rejected with the valid types listed.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Description authored as markdown (headings, bold/italic, lists, code blocks, links, " +
        "tables). Converted to ADF on write; @mentions and images are out of scope in v1.",
    ),
  assignee: z
    .string()
    .optional()
    .describe(
      "Assignee as an email, display name, or `me`/`currentUser`. Resolved to an account " +
        "server-side — never pass an accountId. An ambiguous or unknown value is rejected " +
        "with candidates rather than guessed.",
    ),
  priority: z
    .string()
    .optional()
    .describe("Priority name (e.g. `High`, `Medium`). Must exist in the project's scheme."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels to set on the new issue."),
  parent: z
    .string()
    .optional()
    .describe(
      "Parent issue key (e.g. an epic `ABC-100`, or a story for a subtask). The server " +
        "resolves the company- vs team-managed mechanism (Epic Link field vs `parent`).",
    ),
  sprint: z
    .union([z.number().int(), z.string()])
    .nullable()
    .optional()
    .describe(
      "Sprint to add the issue to: a numeric sprint id, `current` for the active sprint, or a " +
        "sprint name. Resolved against the project's scrum boards server-side; an ambiguous or " +
        "unknown reference is returned with candidate ids rather than guessed. Omit to leave the " +
        "new issue in the backlog (do not pass `null`).",
    ),
};

export const createIssueInputSchema = z.object(createIssueInputShape);
export type CreateIssueArgs = z.infer<typeof createIssueInputSchema>;

export const CREATE_ISSUE_DESCRIPTION =
  "Create a JIRA issue. Minimal case: pass only `summary` (project and issue type default). " +
  "Author `description` as markdown (converted to ADF). Set `assignee` by email/name/`me`, " +
  "`parent` by key, and `sprint` by id or `current` — all resolved server-side. Returns " +
  "`{key, url}`. On a required-field or invalid-type failure, the recovery options are returned.";

export interface CreateIssueDeps {
  /** Default project key when the caller omits `project`. */
  projectDefault?: string;
  /** JIRA base URL, for building the returned `url`. */
  baseUrl: string;
  /**
   * Resolves the curated agile-field ids per instance (memoized). Used here only
   * for the company-managed parent (Epic Link) WRITE — sprint rides the Agile
   * endpoint and needs no field id. Defaults to the cloud-default ids when omitted.
   */
  curatedFieldsProvider?: CuratedFieldsProvider;
}

export async function createIssueHandler(
  jira: IJiraClient,
  args: CreateIssueArgs,
  deps: CreateIssueDeps,
): Promise<CallToolResult> {
  const projectKey = args.project ?? deps.projectDefault;
  if (!projectKey) {
    return shapeError(
      { message: "No project specified and no default project is configured.", code: "project_required" },
      [
        "Pass a `project` key (e.g. `ABC`), or set JIRA_PROJECT_DEFAULT in the server " +
          "environment so it can be omitted.",
      ],
    );
  }

  const issuetype = args.issuetype;
  const builder = new IssueFieldsBuilder();
  builder.set("project", { key: projectKey });
  builder.set("issuetype", { name: issuetype });
  builder.set("summary", args.summary);

  let descriptionDegradations: Degradation[] = [];
  if (args.description !== undefined) {
    const converted = convertMarkdown(args.description);
    builder.set("description", converted.doc);
    descriptionDegradations = converted.degradations;
  }
  if (args.priority !== undefined) {
    builder.set("priority", { name: args.priority });
  }
  if (args.labels !== undefined) {
    builder.set("labels", args.labels);
  }

  // --- reference resolution (fail fast; never create with a guessed value) ---

  if (args.assignee !== undefined) {
    const resolution = await resolveAssignee(jira, args.assignee);
    if (resolution.kind === "none") {
      return shapeError(
        { message: `No JIRA user matched "${args.assignee}".`, code: "assignee_not_found" },
        [
          `No user matched "${args.assignee}". Pass an exact email or display name, or \`me\`. ` +
            "Nothing was created.",
        ],
      );
    }
    if (resolution.kind === "ambiguous") {
      return shapeError(
        {
          message: `"${args.assignee}" matched more than one user.`,
          code: "assignee_ambiguous",
          options: resolution.candidates.map(describeUser),
        },
        [
          `"${args.assignee}" is ambiguous (${resolution.candidates.length} matches). ` +
            `Retry with a specific email: ${resolution.candidates.map(describeUser).join(", ")}. Nothing was created.`,
        ],
      );
    }
    builder.set("assignee", { accountId: resolution.accountId });
  }

  let parentRef: string | undefined;
  if (args.parent !== undefined) {
    // Company-managed parent rides the DETECTED Epic Link id (issue 15 A2): the
    // write must target the same field the read path uses, never a static guess.
    const epicLinkFieldId = await resolveEpicLinkFieldId(deps.curatedFieldsProvider);
    const resolution = await resolveParent(jira, projectKey, args.parent, epicLinkFieldId);
    if (resolution.kind === "not_found") {
      return shapeError(
        { message: `Parent issue ${args.parent} was not found.`, code: "parent_not_found" },
        [
          `Parent ${args.parent} doesn't exist or the token can't see it. Check the key and retry. ` +
            "Nothing was created.",
        ],
      );
    }
    if (resolution.kind === "epic_link_unavailable") {
      return epicLinkUnavailableResult(args.parent, "created");
    }
    builder.set(resolution.contribution.fieldId, resolution.contribution.value);
    parentRef = args.parent;
  }

  // Sprint is resolved up front (fail fast) but assigned via the Agile endpoint
  // AFTER the issue exists — it is no longer a field on the create payload.
  let resolvedSprintId: number | undefined;
  if (args.sprint === null) {
    return shapeError(
      { message: "`sprint` cannot be null on create.", code: "sprint_null_on_create" },
      [
        "A new issue can't have its sprint cleared — there's nothing to clear. Omit `sprint` to " +
          "leave the issue in the backlog, or pass a sprint id/`current`/name to assign one.",
      ],
    );
  }
  if (args.sprint !== undefined) {
    const resolution = await resolveSprint(jira, args.sprint, projectKey);
    if (resolution.kind !== "resolved") {
      return sprintResolutionFailure(resolution, projectKey, "created");
    }
    resolvedSprintId = resolution.sprintId;
  }

  // --- create -----------------------------------------------------------------

  let created;
  try {
    created = await jira.createIssue(builder.build());
  } catch (err) {
    if (err instanceof JiraApiError) {
      if (err.isAuthError) return authErrorResult(err);
      // Recoverable validation failure: NOW (and only now) fetch createmeta to
      // turn the bare rejection into an actionable recovery hint.
      if (err.status === 400) {
        return await recoverFromCreateFailure(
          jira,
          projectKey,
          issuetype,
          err,
          args.description !== undefined,
        );
      }
      return genericJiraErrorResult(err);
    }
    return unexpectedErrorResult(err);
  }

  // --- sprint move (non-atomic with the create above) -------------------------
  // The issue exists now; the move is a separate Agile call. A move failure does
  // NOT roll back the create, so we report the truth: created, but in the backlog.
  let sprintNote: string | undefined;
  if (resolvedSprintId !== undefined) {
    try {
      await jira.addIssueToSprint(resolvedSprintId, created.key);
    } catch (err) {
      const reason = err instanceof JiraApiError ? err.message : String((err as Error)?.message ?? err);
      // The id may simply not exist (a numeric `sprint` matched no sprint) — list
      // the project's open sprints so the retry lands on a valid id. Best-effort:
      // a discovery failure falls back to the bare reason rather than masking it.
      const inventory = await safeGatherSprintCandidates(jira, projectKey);
      const clause = inventory ? availableSprintsClause(inventory) : "";
      sprintNote =
        `Created ${created.key}; sprint ${resolvedSprintId} assignment failed (${reason}) — ` +
        `the issue is in the backlog.${clause} Retry the move with jira_update_issue.`;
    }
  }

  const url = browseUrl(deps.baseUrl, created.key);
  const hints = [
    sprintNote ??
      `Created ${created.key}${parentRef ? ` under ${parentRef}` : ""}` +
        `${resolvedSprintId !== undefined ? ` and added it to sprint ${resolvedSprintId}` : ""}. ` +
        "Open it with jira_get_issue, or add detail with jira_update_issue.",
  ];
  const degraded = degradationHint(descriptionDegradations);
  if (degraded) hints.push(degraded);
  return shapeSuccess({ key: created.key, url }, hints);
}

/** A failed create's recovery path — createmeta is fetched here and ONLY here. */
async function recoverFromCreateFailure(
  jira: IJiraClient,
  projectKey: string,
  issuetype: string,
  err: JiraApiError,
  richTextSent: boolean,
): Promise<CallToolResult> {
  let meta;
  try {
    meta = await jira.getCreateMeta({ projectKey, issuetypeName: issuetype });
  } catch {
    // If even createmeta fails, fall back to the raw error rather than masking it.
    return genericJiraErrorResult(err);
  }

  const fieldErrors = err.errors ?? {};
  const fieldErrorEntries = Object.entries(fieldErrors);
  const issuetypeRejected =
    "issuetype" in fieldErrors || err.errorMessages.some((m) => /issue\s?type/i.test(m));

  if (issuetypeRejected) {
    const validTypes = meta.issueTypes.map((t) => t.name);
    return shapeError(
      {
        message: `Issue type "${issuetype}" is not valid for project ${projectKey}.`,
        code: "invalid_issuetype",
        options: validTypes,
      },
      [
        validTypes.length > 0
          ? `Valid issue types for ${projectKey}: ${validTypes.join(", ")}. Retry with one of these as \`issuetype\`.`
          : `JIRA reported no creatable issue types for ${projectKey} with this account.`,
      ],
    );
  }

  // Otherwise a field-level rejection. JIRA's own `errors` name exactly what it
  // refused — which may be a field we sent (a bad priority, a nonexistent
  // parent) OR a required field we omitted. Surface JIRA's messages verbatim
  // and use createmeta's required-field list as supplementary context, rather
  // than blanket-labelling every failure "missing required fields".
  const requiredNames = meta.requiredFields.map((f) => f.name);

  // Bare INVALID_INPUT with no field-level detail (JIRA named nothing, and
  // createmeta surfaces no missing required field) AND a markdown→ADF
  // `description` was sent: the conversion is the likely culprit. Name it,
  // instead of a dead-end raw `INVALID_INPUT` (issue 20, bug B). The extra
  // `requiredNames` guard makes create defer to the missing-required-field hint
  // when createmeta names one — that's the better lead than blaming markdown.
  if (isDetaillessValidation(err) && requiredNames.length === 0 && richTextSent) {
    return richTextValidationResult(err, "description");
  }

  const options = requiredNames.length > 0 ? requiredNames : fieldErrorEntries.map(([field]) => field);

  const hints: string[] = [];
  if (fieldErrorEntries.length > 0) {
    hints.push(
      "JIRA rejected: " + fieldErrorEntries.map(([field, message]) => `${field} (${message})`).join("; ") + ".",
    );
  }
  if (requiredNames.length > 0) {
    hints.push(`Project ${projectKey} / type ${issuetype} requires: ${requiredNames.join(", ")}. Add the missing field(s) and retry.`);
  }
  if (err.errorMessages.length > 0) hints.push(err.errorMessages.join(" "));
  if (hints.length === 0) {
    hints.push(`Create failed validation for ${projectKey} / type ${issuetype}. Check the project's required fields and retry.`);
  }

  return shapeError(
    {
      message: `Create failed for project ${projectKey} / type ${issuetype}: JIRA rejected the field values or a required field is missing.`,
      code: requiredNames.length > 0 ? "missing_required_fields" : "field_validation_failed",
      options,
    },
    hints,
  );
}

export function registerCreateIssueTool(
  server: McpServer,
  jira: IJiraClient,
  deps: CreateIssueDeps,
): void {
  server.registerTool(
    "jira_create_issue",
    {
      title: "Create a JIRA issue",
      description: CREATE_ISSUE_DESCRIPTION,
      inputSchema: createIssueInputShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => createIssueHandler(jira, args, deps),
  );
}
