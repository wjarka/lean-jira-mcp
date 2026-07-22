/**
 * jira_comment (write) — post or edit a comment, with the server natively
 * owning authorship so agents never hand-parse ADF to tell their own comments
 * from a human's.
 *
 * The agent passes only the markdown body. The server, with NO opt-out, stamps
 * two authorship signals on every comment it writes (see comment-authorship.ts):
 *   - the out-of-band `mcp.origin` property — the machine truth, and
 *   - the configured visible marker (`JIRA_MCP_COMMENT_MARKER`, default
 *     `:claude:`) prepended to the body for humans.
 * There is deliberately a single write path: both the post and the edit branch
 * funnel through {@link buildStampedWrite}, so neither can emit an unstamped
 * comment.
 *
 * Edit (`commentId`) is guarded: the server fetches the target comment with its
 * properties and only edits one it authored (resolved by the shared
 * authorship derivation). A human's comment is refused with a "post a new
 * comment instead" hint. Because a PUT replaces the body, the marker and the
 * property are re-stamped on every edit.
 *
 * `visibility` restricts the comment to a role/group (default public). An
 * invalid role/group comes back as a hint — mirroring create's createmeta path,
 * project roles are fetched ONLY on that failure, never proactively. The guard
 * is symmetric: `type` without `value` is rejected (a role/group needs a name),
 * and — just as important — `value` without an explicit `type` is ALSO rejected
 * rather than silently posted public (the schema does not default `type`, so
 * the handler can tell "omitted" apart from "explicitly public").
 *
 * Reuses slice 04's markdown→ADF converter and the JiraClient seam; rich-text
 * is authored as markdown and converted server-side.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  type IJiraClient,
  type JiraCommentProperty,
  type JiraCommentVisibility,
  type JiraRestCommentFull,
} from "../lib/jira-client.ts";
import { browseUrl, shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  isDetaillessValidation,
  richTextValidationResult,
  shapeUncaughtError,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import {
  convertMarkdown,
  degradationHint,
  type AdfDoc,
  type Degradation,
} from "../lib/markdown-to-adf.ts";
import { adfToMarkdown } from "../lib/adf-to-markdown.ts";
import { projectKeyOf } from "../lib/issue-fields.ts";
import {
  ORIGIN_PROPERTY_KEY,
  ORIGIN_PROPERTY_VALUE,
  deriveAuthoredBy,
  stampMarkerAdf,
} from "../lib/comment-authorship.ts";

export const commentInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe("The issue to comment on, e.g. `ABC-123`."),
  body: z
    .string()
    .min(1)
    .describe(
      "Comment body authored as markdown (headings, bold/italic, lists, code blocks, links, " +
        "tables), converted to ADF on write. Pass ONLY the content — the server stamps " +
        "authorship (a visible marker + an out-of-band property) automatically; do not add a " +
        "marker yourself.",
    ),
  commentId: z
    .string()
    .optional()
    .describe(
      "To EDIT an existing comment, pass its id; the body replaces the old one. Only comments " +
        "this server authored can be edited — a human-authored comment is refused (post a new " +
        "comment instead). Omit to post a new comment.",
    ),
  visibility: z
    .object({
      type: z
        .enum(["public", "role", "group"])
        .optional()
        .describe(
          "`public` (the default, unrestricted) or restrict the comment to a project `role` or a `group`. " +
            "Omitting `type` also means public — but only when `value` is ALSO omitted; a `value` with no " +
            "`type` is rejected rather than silently posted public.",
        ),
      value: z
        .string()
        .optional()
        .describe(
          "The role or group name (e.g. `Administrators`, `Developers`). Required when `type` is " +
            "`role` or `group`; omit for `public`.",
        ),
    })
    .optional()
    .describe(
      "Who can see the comment. OMIT this entirely (or set `type:\"public\"`) for a public comment " +
        "— the default, visible to everyone who can see the issue (and notifies watchers). To " +
        "restrict, set `type` to `role`/`group` and put the name in `value`. An invalid role/group " +
        "is reported with a hint.",
    ),
};

export const commentInputSchema = z.object(commentInputShape);
export type CommentArgs = z.infer<typeof commentInputSchema>;

export const COMMENT_DESCRIPTION =
  "Post (or edit) a comment on a JIRA issue. Author `body` as markdown (converted to ADF). The " +
  "server stamps every comment as agent-authored automatically — a visible marker plus an " +
  "out-of-band property — with no opt-out, so authorship is always recorded. Pass `commentId` to " +
  "edit a comment you previously posted (a human's comment is refused). `visibility` restricts to " +
  "a role/group (default public). Returns `{commentId, url, authoredBy, created, ...}`.";

export interface CommentDeps {
  /** JIRA base URL, for the returned deep-link `url`. */
  baseUrl: string;
  /** Visible authorship marker (`JIRA_MCP_COMMENT_MARKER`, default `:claude:`). */
  marker: string;
}

/**
 * The ONE place a comment write is assembled. Stamps both authorship signals so
 * no caller can emit an unstamped comment. Marker stamping is idempotent.
 */
function buildStampedWrite(
  doc: AdfDoc,
  marker: string,
  visibility?: JiraCommentVisibility,
): { body: unknown; properties: JiraCommentProperty[]; visibility?: JiraCommentVisibility } {
  return {
    body: stampMarkerAdf(doc, marker),
    properties: [{ key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE }],
    ...(visibility ? { visibility } : {}),
  };
}

export async function commentHandler(
  jira: IJiraClient,
  args: CommentArgs,
  deps: CommentDeps,
): Promise<CallToolResult> {
  // Resolve visibility: omitted or `public` → unrestricted; a role/group needs
  // a name. (There is no opt-out for authorship — only for the audience.)
  //
  // The guard is symmetric and neither half is allowed to default toward
  // "public" silently:
  //   - `type` set to `role`/`group` with no `value` → rejected below.
  //   - `value` set with `type` omitted → rejected here too. The schema does
  //     NOT default `type` to "public", specifically so this branch can tell
  //     "omitted" apart from "explicitly public" and refuse to let a value
  //     ride along unrestricted (that was issue: a bare `{value:"Developers"}`
  //     used to parse as `{type:"public", value:"Developers"}` and post with
  //     NO restriction at all).
  let visibility: JiraCommentVisibility | undefined;
  const v = args.visibility;
  if (v && v.type !== "public") {
    const hasValue = Boolean(v.value && v.value.trim() !== "");
    if (v.type === undefined) {
      if (hasValue) {
        return shapeError(
          {
            message: "A visibility `value` was given without a `type`; it would otherwise post publicly.",
            code: "visibility_type_required",
          },
          [
            `A visibility restriction needs \`type\` set to "role" or "group" alongside \`value\` ` +
              `"${v.value}". Pass e.g. \`visibility: {type: "role", value: "${v.value}"}\` (or ` +
              '`type: "group"`). For a public comment, omit `visibility` entirely. Nothing was posted.',
          ],
        );
      }
      // type and value both omitted → public (unrestricted), same as omitting `visibility` entirely.
    } else {
      if (!hasValue) {
        return shapeError(
          {
            message: `A ${v.type} visibility restriction requires the ${v.type} name in \`value\`.`,
            code: "visibility_value_required",
          },
          [
            `To restrict the comment to a ${v.type}, pass the ${v.type} name in \`visibility.value\`. ` +
              'For a public comment, omit `visibility` or set `type:"public"`. Nothing was posted.',
          ],
        );
      }
      visibility = { type: v.type, value: v.value! };
    }
  }

  // Convert the body once. An inline image in a comment is rejected outright —
  // its best-effort output (a bare link) would misrepresent what the human sees
  // in the thread; the other degradations are reported in the success hints.
  const converted = convertMarkdown(args.body);
  if (converted.degradations.some((d) => d.kind === "image")) {
    return shapeError(
      {
        message: "Inline images are not supported in a comment body.",
        code: "inline_image_unsupported",
      },
      [
        "A comment body can't carry an inline image. Pass the image URL as a plain markdown link " +
          "(`[label](url)`) instead, then retry. Nothing was posted.",
      ],
    );
  }
  const write = buildStampedWrite(converted.doc, deps.marker, visibility);

  if (args.commentId !== undefined) {
    return editComment(jira, args, deps, write, visibility, converted.degradations);
  }

  let created: JiraRestCommentFull;
  try {
    created = await jira.addComment({
      issueKey: args.issueKey,
      body: write.body,
      properties: write.properties,
      visibility: write.visibility,
      expand: ["properties"],
    });
  } catch (err) {
    return handleWriteError(jira, args, visibility, err);
  }

  const hints = [
    `Posted comment ${created.id} on ${args.issueKey} (stamped agent-authored). ` +
      `Edit it later by passing commentId "${created.id}".`,
  ];
  const degraded = degradationHint(converted.degradations);
  if (degraded) hints.push(degraded);
  return shapeSuccess(buildResponse(created, args.issueKey, deps.baseUrl), hints);
}

async function editComment(
  jira: IJiraClient,
  args: CommentArgs,
  deps: CommentDeps,
  write: ReturnType<typeof buildStampedWrite>,
  visibility: JiraCommentVisibility | undefined,
  degradations: Degradation[],
): Promise<CallToolResult> {
  const commentId = args.commentId!;

  // --- guard: only an agent-authored comment may be edited --------------------
  let existing: JiraRestCommentFull;
  try {
    existing = await jira.getComment({ issueKey: args.issueKey, commentId, expand: ["properties"] });
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) {
      return shapeError(
        { message: `Comment ${commentId} not found on ${args.issueKey}.`, code: "comment_not_found" },
        [
          `No comment ${commentId} exists on ${args.issueKey} (or the token can't see it). ` +
            "Check the id with jira_get_comments, or omit commentId to post a new comment.",
        ],
      );
    }
    return shapeUncaughtError(err);
  }

  const authoredBy = deriveAuthoredBy(
    {
      properties: existing.properties,
      bodyText: adfToMarkdown(existing.body),
      hasAuthor: Boolean(existing.author),
    },
    { marker: deps.marker },
  );

  if (authoredBy !== "agent") {
    const who = existing.author?.displayName;
    return shapeError(
      {
        message: `Comment ${commentId} was not authored by the agent and cannot be edited.`,
        code: "comment_not_agent_authored",
      },
      [
        (who ? `Comment ${commentId} was written by ${who}. ` : `Comment ${commentId} is human-authored. `) +
          "You can only edit comments you posted. Post a new comment instead (omit commentId).",
      ],
    );
  }

  // --- replace the body (PUT) — marker + property re-stamped by buildStampedWrite
  let updated: JiraRestCommentFull;
  try {
    updated = await jira.updateComment({
      issueKey: args.issueKey,
      commentId,
      body: write.body,
      properties: write.properties,
      visibility: write.visibility,
      expand: ["properties"],
    });
  } catch (err) {
    return handleWriteError(jira, args, visibility, err);
  }

  const hints = [
    `Edited comment ${commentId} on ${args.issueKey}; the authorship marker was re-stamped.`,
  ];
  const degraded = degradationHint(degradations);
  if (degraded) hints.push(degraded);
  return shapeSuccess(buildResponse(updated, args.issueKey, deps.baseUrl), hints);
}

/** Shape an add/update failure: auth, a visibility rejection, not-found, or generic. */
async function handleWriteError(
  jira: IJiraClient,
  args: CommentArgs,
  visibility: JiraCommentVisibility | undefined,
  err: unknown,
): Promise<CallToolResult> {
  if (err instanceof JiraApiError) {
    if (err.isAuthError) return authErrorResult(err);
    // A 400 while a visibility restriction is set is, in practice, a bad
    // role/group — surface it as a recoverable hint rather than a silent failure.
    if (visibility && err.status === 400) {
      return recoverFromVisibilityFailure(jira, args.issueKey, visibility, err);
    }
    if (err.isNotFound) {
      return shapeError(
        { message: `Issue ${args.issueKey} not found.`, code: "issue_not_found" },
        [`No issue ${args.issueKey} exists, or the token can't see it. Check the key and retry.`],
      );
    }
    // A comment carries only the (always markdown→ADF converted) body — so a
    // bare INVALID_INPUT with no field-level detail points squarely at the body.
    // Restores an actionable hint on the comment write path (issue 20, bug B).
    if (isDetaillessValidation(err)) {
      return richTextValidationResult(err, "comment body");
    }
    return genericJiraErrorResult(err);
  }
  return unexpectedErrorResult(err);
}

/**
 * Turn a visibility rejection into an actionable hint. Mirrors create's
 * createmeta-on-failure: project roles are fetched HERE and only here. For a
 * `role`, the valid role names are listed as options; for a `group` (not cheaply
 * enumerable) the hint asks the agent to verify the group name.
 */
async function recoverFromVisibilityFailure(
  jira: IJiraClient,
  issueKey: string,
  visibility: JiraCommentVisibility,
  err: JiraApiError,
): Promise<CallToolResult> {
  const jiraMessage = err.errorMessages.join(" ").trim();

  if (visibility.type === "role") {
    const projectKey = projectKeyOf(issueKey);
    let roles: string[] = [];
    try {
      roles = await jira.getProjectRoles(projectKey);
    } catch {
      // If even the role lookup fails, fall back to a message-only hint below.
    }
    return shapeError(
      {
        message: `Comment visibility role "${visibility.value}" was rejected.${jiraMessage ? ` ${jiraMessage}` : ""}`,
        code: "invalid_visibility_role",
        ...(roles.length > 0 ? { options: roles } : {}),
      },
      [
        roles.length > 0
          ? `Role "${visibility.value}" is not a valid project role for ${projectKey}. Valid roles: ${roles.join(", ")}. Retry with one of these, or omit visibility for a public comment. Nothing was posted.`
          : `Role "${visibility.value}" was rejected${jiraMessage ? ` (${jiraMessage})` : ""}. Verify the role exists in the project, or omit visibility for a public comment. Nothing was posted.`,
      ],
    );
  }

  return shapeError(
    {
      message: `Comment visibility group "${visibility.value}" was rejected.${jiraMessage ? ` ${jiraMessage}` : ""}`,
      code: "invalid_visibility_group",
    },
    [
      `Group "${visibility.value}" was rejected${jiraMessage ? ` (${jiraMessage})` : ""}. Verify the group name exists, ` +
        "or omit visibility for a public comment. Nothing was posted.",
    ],
  );
}

function buildResponse(
  comment: JiraRestCommentFull,
  issueKey: string,
  baseUrl: string,
): Record<string, unknown> {
  const url = browseUrl(baseUrl, issueKey, { focusedCommentId: comment.id });
  const out: Record<string, unknown> = {
    commentId: comment.id,
    url,
    authoredBy: "agent",
    created: comment.created ?? null,
  };
  if (comment.updated && comment.updated !== comment.created) out.updated = comment.updated;
  if (comment.visibility) {
    out.visibility = { type: comment.visibility.type, value: comment.visibility.value };
  }
  return out;
}

export function registerCommentTool(
  server: McpServer,
  jira: IJiraClient,
  deps: CommentDeps,
): void {
  server.registerTool(
    "jira_comment",
    {
      title: "Post or edit a JIRA comment",
      description: COMMENT_DESCRIPTION,
      inputSchema: commentInputShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => commentHandler(jira, args, deps),
  );
}
