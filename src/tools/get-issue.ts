/**
 * jira_get_issue — open one ticket and look at it.
 *
 * Lean by default (`detail:"summary"`), verbose on opt-in (`detail:"full"`).
 * Summary is a glance: card fields, story points, a token-budget-truncated
 * description, and counts of comments/links/subtasks. Full adds the untruncated
 * description, links, subtasks, the last 3 comments, and the curated agile
 * fields. `fields[]` is an additive, non-overlapping override for named extras.
 *
 * All rich text is flattened to markdown via the shared ADF converter; curated
 * agile custom fields are surfaced by friendly name and raw `customfield_XXXXX`
 * identifiers never reach the agent. The handler is exported separately from
 * registration so tests drive it end-to-end against a faked JiraClient.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { JiraApiError, type IJiraClient } from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import { shapeUncaughtError } from "../lib/jira-errors.ts";
import {
  CARD_FIELDS,
  leanFieldValue,
  nameOf,
  stringOrNull,
  toCardFields,
} from "../lib/issue-fields.ts";
import { adfToMarkdown } from "../lib/adf-to-markdown.ts";
import { truncateToTokenBudget } from "../lib/text-budget.ts";
import {
  CURATED_FIELD_ENV_VARS,
  DEFAULT_CURATED_FIELD_IDS,
  buildCuratedFields,
  curatedRequestIds,
  extractCuratedFields,
  isCuratedFriendlyName,
  type CuratedFieldDef,
  type CuratedFieldKey,
} from "../lib/custom-fields.ts";
import {
  staticCuratedFieldsProvider,
  type CuratedFieldsProvider,
} from "../lib/curated-field-provider.ts";
import { serializeComment, type JiraRestComment } from "../lib/comment-serializer.ts";
import { serializeAttachments } from "../lib/attachments.ts";
import { fetchAllComments, fetchNewestComments } from "../lib/comment-thread.ts";
import { LEGACY_MARKER } from "../lib/comment-authorship.ts";

/** Summary descriptions are capped at this token budget, cut at a paragraph boundary. */
const SUMMARY_TOKEN_BUDGET = 450;
/** `comments:"recent"` returns this many of the most recent comments as a preview. */
const RECENT_COMMENT_COUNT = 3;

/**
 * Names the `detail` preset already controls; passing them via `fields[]` is a
 * no-op and gets reported back rather than silently honored. Includes both the
 * raw JIRA names and the agent-facing aliases.
 */
const DETAIL_CONTROLLED_FIELDS = new Set([
  "summary",
  "status",
  "issuetype",
  "type",
  "priority",
  "assignee",
  "labels",
  "updated",
  "description",
  "comment",
  "comments",
  "issuelinks",
  "links",
  "subtasks",
  "attachment",
  "attachments",
]);

export const getIssueInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe(
      "The issue key to open, e.g. `PROJ-123`. Resolve an unknown key with `jira_search` first.",
    ),
  detail: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "Verbosity preset. `summary` (default) is lean: card fields, story points, a " +
        "token-truncated description, and counts. `full` adds the untruncated description, " +
        "links, subtasks, the last 3 comments, and curated agile fields (sprint, epic link).",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Additive list of EXTRA named fields to include (e.g. `duedate`, `reporter`). " +
        "It must not re-specify fields the `detail` preset already controls (those are " +
        "ignored and reported), and must not be a raw `customfield_XXXXX` id — curated agile " +
        "fields already appear by friendly name. Extras are returned under `extraFields`.",
    ),
  comments: z
    .enum(["none", "recent", "all"])
    .default("none")
    .describe(
      "How many comments to include. `none` (default) returns only a count; `recent` returns " +
        `the last ${RECENT_COMMENT_COUNT} as a preview; \`all\` returns every comment on the issue. ` +
        "Auto-upgraded to `recent` when `detail:\"full\"`.",
    ),
};

export const getIssueInputSchema = z.object(getIssueInputShape);
export type GetIssueArgs = z.infer<typeof getIssueInputSchema>;

export const GET_ISSUE_DESCRIPTION =
  "Open a single JIRA issue. Lean by default (`detail:\"summary\"`): card fields, story " +
  "points, a truncated description, and counts of comments/links/subtasks. Opt into more with " +
  "`detail:\"full\"`, `comments`, and an additive `fields[]`. Rich text is returned as markdown.";

interface RawLinkedIssue {
  key?: string;
  fields?: { summary?: unknown; status?: unknown };
}

interface RawIssueLink {
  type?: { inward?: string; outward?: string };
  inwardIssue?: RawLinkedIssue;
  outwardIssue?: RawLinkedIssue;
}

type SerializedLink = { relationship: string | null } & SerializedLinkedIssue;
type SerializedLinkedIssue = { key: string; summary: string | null; status: string | null };

function isRawCustomField(name: string): boolean {
  return /^customfield_/i.test(name);
}

function isDetailControlled(name: string): boolean {
  return DETAIL_CONTROLLED_FIELDS.has(name.toLowerCase()) || isCuratedFriendlyName(name);
}

/** Flatten a linked-issue reference (shared by links and subtasks). */
function serializeLinkedIssue(linked: RawLinkedIssue | undefined): SerializedLinkedIssue {
  return {
    key: linked?.key ?? "",
    summary: stringOrNull(linked?.fields?.summary),
    status: nameOf(linked?.fields?.status),
  };
}

function serializeLink(link: RawIssueLink): SerializedLink {
  const linked = link.inwardIssue ?? link.outwardIssue;
  const relationship = link.inwardIssue ? link.type?.inward : link.type?.outward;
  return {
    relationship: stringOrNull(relationship),
    ...serializeLinkedIssue(linked),
  };
}

/**
 * The newest {@link RECENT_COMMENT_COUNT} comments to preview. When the inline
 * comment page the issue GET returned is COMPLETE (its length covers the whole
 * thread), its tail already IS the newest N — no extra call. When it's a bounded
 * partial page (a long thread), that tail is the tail of the OLDEST page, so
 * slicing it would surface the oldest comments as the newest; fetch the real
 * newest N from the dedicated endpoint instead. A follow-up failure or a page
 * emptied by a racing deletion degrades to the inline tail rather than failing
 * the whole get_issue or showing nothing.
 */
async function selectRecentComments(
  jira: IJiraClient,
  issueKey: string,
  inline: JiraRestComment[],
  total: number,
): Promise<JiraRestComment[]> {
  const inlineTail = inline.slice(-RECENT_COMMENT_COUNT);
  if (total <= inline.length) return inlineTail;
  try {
    const newest = await fetchNewestComments(jira, issueKey, total, RECENT_COMMENT_COUNT);
    return newest.length > 0 ? newest : inlineTail;
  } catch {
    return inlineTail;
  }
}

export async function getIssueHandler(
  jira: IJiraClient,
  args: GetIssueArgs,
  curated: CuratedFieldDef[] = buildCuratedFields(DEFAULT_CURATED_FIELD_IDS),
  marker: string = LEGACY_MARKER,
  omittedCurated: CuratedFieldKey[] = [],
  /** True when detection couldn't run and curated ids fell back to cloud defaults. */
  curatedFromDefaults: boolean = false,
): Promise<CallToolResult> {
  // `fields[]` is split three ways: genuine extras to request, detail-controlled
  // names to reject, and raw customfield ids to reject (they'd leak an internal id).
  const requested = args.fields ?? [];
  const rawCustomFieldRequests = requested.filter(isRawCustomField);
  const ignoredControlled = requested.filter(
    (f) => !isRawCustomField(f) && isDetailControlled(f),
  );
  const extraFieldNames = requested.filter(
    (f) => !isRawCustomField(f) && !isDetailControlled(f),
  );

  // Comments default to none, but `detail:"full"` auto-upgrades to recent.
  const commentsMode =
    args.detail === "full" && args.comments === "none" ? "recent" : args.comments;

  const fieldsToRequest = [
    ...CARD_FIELDS,
    "description",
    "comment",
    "issuelinks",
    "subtasks",
    "attachment",
    ...curatedRequestIds(curated),
    ...extraFieldNames,
  ];

  let issue;
  try {
    issue = await jira.getIssue({ issueKey: args.issueKey, fields: fieldsToRequest });
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) {
      return shapeError(
        { message: `Issue ${args.issueKey} was not found.`, code: "issue_not_found" },
        [
          `No issue matched the key \`${args.issueKey}\`. Check the key (e.g. PROJ-123) and that the token's account can see that project.`,
          "If you're unsure of the exact key, find it with `jira_search`.",
        ],
      );
    }
    return shapeUncaughtError(err);
  }

  const f = issue.fields ?? {};
  const card = toCardFields(f);
  const descriptionMd = adfToMarkdown(f.description);
  const curatedValues = extractCuratedFields(f, curated);

  const commentField = f.comment as { comments?: JiraRestComment[]; total?: number } | undefined;
  const allComments = Array.isArray(commentField?.comments) ? commentField.comments : [];
  const commentCount = typeof commentField?.total === "number" ? commentField.total : allComments.length;
  const links = (Array.isArray(f.issuelinks) ? f.issuelinks : []) as RawIssueLink[];
  const subtasks = (Array.isArray(f.subtasks) ? f.subtasks : []) as RawLinkedIssue[];
  const attachments = serializeAttachments(f.attachment);

  const extraFields: Record<string, unknown> = {};
  for (const name of extraFieldNames) {
    if (name in f) extraFields[name] = leanFieldValue(f[name]);
  }

  const hints: string[] = [];
  if (ignoredControlled.length > 0) {
    hints.push(
      `Ignored fields[] entries already controlled by \`detail\`: ${ignoredControlled.join(", ")}. ` +
        'Use detail:"full" to get them.',
    );
  }
  if (rawCustomFieldRequests.length > 0) {
    hints.push(
      `Ignored raw custom-field id(s): ${rawCustomFieldRequests.join(", ")}. ` +
        "Pass a friendly field name instead; curated agile fields (storyPoints, sprint, epicLink) appear automatically.",
    );
  }

  let data: Record<string, unknown>;
  if (args.detail === "full") {
    data = buildFull(issue.key, card, curatedValues, descriptionMd, links, subtasks, attachments);
  } else {
    const truncated = truncateToTokenBudget(descriptionMd, SUMMARY_TOKEN_BUDGET);
    data = {
      key: issue.key,
      ...card,
      ...(curatedValues.storyPoints !== undefined ? { storyPoints: curatedValues.storyPoints } : {}),
      description: truncated.text,
      descriptionTruncated: truncated.truncated,
      counts: {
        comments: commentCount,
        links: links.length,
        subtasks: subtasks.length,
        attachments: attachments.length,
      },
    };
    if (truncated.truncated) {
      hints.push(
        `Description truncated to ~${truncated.tokensShown} tokens ` +
          `(~${truncated.tokensOmitted} more omitted across ${truncated.paragraphsOmitted} paragraph(s)). ` +
          'Call again with detail:"full" for the complete description.',
      );
    }
  }

  // Comment preview (full auto-includes recent; summary only on opt-in).
  if (commentsMode === "recent") {
    const selected = await selectRecentComments(jira, args.issueKey, allComments, commentCount);
    // A preview is a glance: bodies are clipped to short snippets. The full text
    // of any clipped comment lives in jira_get_comments(commentId=…) — never in a
    // deeper get_issue detail level, which previews the same way.
    const preview = selected.map((c) => serializeComment(c, { marker, preview: true }));
    data.comments = preview;
    data.commentCount = commentCount;
    const clipped = preview.find((c) => c.bodyClipped);
    if (clipped) {
      hints.push(
        `Comment bodies marked \`bodyClipped:true\` are short previews — their full text is NOT shown ` +
          `here; bodies without that flag are complete. Call \`jira_get_comments(commentId=<id>)\` for ` +
          `any one clipped comment's full text (e.g. id ${clipped.id}), or \`jira_get_comments\` for the whole thread.`,
      );
    }
    // Honest partial: a preview is at most RECENT_COMMENT_COUNT, so warn
    // whenever we're handing back fewer comments than the issue actually has.
    if (commentCount > selected.length) {
      hints.push(
        `Showing ${selected.length} of ${commentCount} comments. ` +
          "Use `jira_get_comments` for the full thread.",
      );
    }
  } else if (commentsMode === "all") {
    // `all` walks the dedicated comment endpoint (the inline page the issue GET
    // returns is bounded) so it returns the COMPLETE thread, with each comment's
    // authorship resolved property-first. On a fetch failure, degrade to the
    // inline page rather than dropping the whole response.
    try {
      const thread = await fetchAllComments(jira, args.issueKey);
      data.comments = thread.map((c) => serializeComment(c, { marker }));
      data.commentCount = thread.length;
    } catch {
      data.comments = allComments.map((c) => serializeComment(c, { marker }));
      data.commentCount = commentCount;
      hints.push(
        "Couldn't page the full comment thread; showing the inline page only. " +
          "Retry, or use `jira_get_comments` for the complete thread.",
      );
    }
  }

  if (Object.keys(extraFields).length > 0) data.extraFields = extraFields;

  // Attachments are a discovery surface: point at the read path so a found file
  // is one call from being read. Summary only shows a count, so route via full.
  if (attachments.length > 0) {
    hints.push(
      args.detail === "full"
        ? `${attachments.length} attachment(s) listed under \`attachments\` — read one with ` +
            "`jira_read_attachment(attachmentId=<id>)` (images come back viewable, text as text)."
        : `This issue has ${attachments.length} attachment(s). Call again with detail:"full" for the ` +
            "list (id, filename, mimeType, size), then `jira_read_attachment` to read one.",
    );
  }

  // Visible degradation: a curated agile field that couldn't be detected on this
  // instance (and has no JIRA_FIELD_* override) is omitted rather than read
  // against a guessed id — say so, so the agent doesn't read its absence as
  // "this issue has no story points / sprint / epic". Summary only shows story
  // points, so don't mention sprint/epic there.
  const relevantOmitted =
    args.detail === "full"
      ? omittedCurated
      : omittedCurated.filter((k) => k === "storyPoints");
  if (relevantOmitted.length > 0) {
    hints.push(
      `Curated agile field(s) not available on this JIRA instance, so omitted (not "empty"): ` +
        `${relevantOmitted.join(", ")}. They couldn't be auto-detected from field metadata; set ` +
        `${relevantOmitted.map((k) => CURATED_FIELD_ENV_VARS[k]).join(", ")} to surface them.`,
    );
  }

  // Detection couldn't run at all (the field-metadata read failed), so curated
  // ids fell back to cloud defaults — which may be wrong on this instance. Say
  // so rather than presenting a possibly-misread agile field as authoritative.
  if (curatedFromDefaults) {
    hints.push(
      "Couldn't read this instance's field metadata, so curated agile fields (storyPoints, " +
        "sprint, epicLink) were read against DEFAULT cloud field ids and may be wrong or missing " +
        "here. Retry shortly to re-detect, or set the JIRA_FIELD_* env vars to pin the ids.",
    );
  }

  // Guarantee at least one navigational hint on the happy path. In full view we
  // only reach here when nothing was withheld (the comment-shortfall hint above
  // covers the "more comments exist" case), so don't point at jira_get_comments
  // — it would return the identical thread.
  if (hints.length === 0) {
    hints.push(
      args.detail === "full"
        ? "Full view — description, links, subtasks, comments, and curated agile fields are all included."
        : 'Lean summary. Call again with detail:"full" for description, links, subtasks, comments, and agile fields.',
    );
  }

  return shapeSuccess(data, hints);
}

function buildFull(
  key: string,
  card: ReturnType<typeof toCardFields>,
  curatedValues: Record<string, unknown>,
  descriptionMd: string,
  links: RawIssueLink[],
  subtasks: RawLinkedIssue[],
  attachments: ReturnType<typeof serializeAttachments>,
): Record<string, unknown> {
  return {
    key,
    ...card,
    ...curatedValues,
    description: descriptionMd,
    links: links.map(serializeLink),
    subtasks: subtasks.map(serializeLinkedIssue),
    attachments,
  };
}

export function registerGetIssueTool(
  server: McpServer,
  jira: IJiraClient,
  curatedFieldsProvider: CuratedFieldsProvider = staticCuratedFieldsProvider(
    buildCuratedFields(DEFAULT_CURATED_FIELD_IDS),
  ),
  marker: string = LEGACY_MARKER,
): void {
  server.registerTool(
    "jira_get_issue",
    {
      title: "Open a JIRA issue",
      description: GET_ISSUE_DESCRIPTION,
      inputSchema: getIssueInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      // Resolved once per process inside the provider (memoized like the auth
      // preflight) — the first get_issue pays the metadata read, the rest don't.
      const { curated, omitted, sources } = await curatedFieldsProvider.get();
      // A "default" source only arises when detection couldn't run (see
      // resolveCuratedFields) — flag it so the handler degrades visibly.
      const curatedFromDefaults = Object.values(sources).some((s) => s === "default");
      return getIssueHandler(jira, args, curated, marker, omitted, curatedFromDefaults);
    },
  );
}
