/**
 * jira_get_comments (read) — a dedicated, paginated comment-reading tool so
 * re-reading a thread doesn't re-send the whole issue payload each loop.
 *
 * Comment content is this tool's entire deliverable, so it returns FULL comment
 * bodies by default — bodies are NEVER truncated, and no hint ever points the
 * agent to another tool for full comment text. Leanness comes from PAGE SIZE,
 * not from clipping a body:
 *   - pages are token-budgeted (~3–4k tokens) over WHOLE comments, with a
 *     ~25-comment count backstop so a thread of many tiny comments stays bounded;
 *   - a single comment larger than the page budget is returned WHOLE as its own
 *     page — comments are never split, so there is no routine "capped" state.
 *
 * `preview:true` is the ONLY truncation that exists: explicit, opt-in 1–2 line
 * snippets for cheaply scanning a thread's shape (still carrying `id` +
 * `authoredBy`). `commentId` and `sinceLastAgentComment` always return full
 * bodies, regardless of `preview`.
 *
 * Authorship is resolved server-side and exposed as a clean `authoredBy` enum
 * (the `mcp.origin` property is primary, the configured + legacy marker a
 * fallback for pre-property history) — the agent never parses ADF to tell its
 * own comments from a human's. Bodies are flattened to markdown with the marker
 * preserved.
 *
 * Two delta filters turn the dominant "did the human reply since I last posted?"
 * question into a cheap incremental fetch:
 *   - `sinceLastAgentComment` returns only the comments after the server's most
 *     recent stamped (agent) comment;
 *   - `since` (a comment id or a timestamp) returns only comments after that
 *     point.
 * Both walk the thread newest-first and stop at the boundary, so the common case
 * costs one or two comments instead of re-reading the whole thread.
 *
 * Plain (non-delta) reads use the same opaque-cursor pagination contract as
 * `jira_search`: an opaque `nextCursor` passed back verbatim, plus `isLast`.
 * Every hint resolves WITHIN this tool. The handler is exported separately from
 * registration so tests drive it end-to-end against a faked JiraClient.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  type IJiraClient,
  type JiraRestCommentFull,
} from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { serializeComment, type SerializedComment } from "../lib/comment-serializer.ts";
import { deriveAuthoredBy } from "../lib/comment-authorship.ts";
import { adfToMarkdown } from "../lib/adf-to-markdown.ts";
import { decodeCommentCursor, encodeCommentCursor } from "../lib/comment-thread.ts";
import { estimateTokens, packUntilBudget } from "../lib/text-budget.ts";

/** Per-page token target. A page packs whole comments until adding the next
 *  would exceed this — except a single over-budget comment, which is its own
 *  page (comments are never split). */
const PAGE_TOKEN_BUDGET = 3500;
/** Count backstop so a thread of many tiny comments still pages (≤ this per page). */
const PAGE_COMMENT_BACKSTOP = 25;
/** Page size for the newest-first delta walk (sinceLastAgentComment / since). */
const DELTA_PAGE_SIZE = 100;

export interface GetCommentsDeps {
  /** Visible authorship marker (`JIRA_MCP_COMMENT_MARKER`, default `:claude:`). */
  marker: string;
}

export const getCommentsInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe("The issue whose comments to read, e.g. `PROJ-123`."),
  order: z
    .enum(["newest", "oldest"])
    .default("newest")
    .describe(
      "Thread order. `newest` (default) returns the most recent comments first; `oldest` returns " +
        "them in chronological order.",
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor from a previous response's `nextCursor`. Pass it back VERBATIM to " +
        "fetch the next page — do not parse, modify, or construct it. Ignored with a delta filter " +
        "or `commentId`.",
    ),
  commentId: z
    .string()
    .optional()
    .describe(
      "Return just this one comment, in full. Use it to pull the complete text of a comment whose " +
        "body was clipped in a `jira_get_issue` preview. Overrides paging and the delta filters.",
    ),
  preview: z
    .boolean()
    .optional()
    .describe(
      "When true, return short 1–2 line snippets instead of full bodies — for cheaply scanning a " +
        "thread's shape. Snippets still carry `id` and `authoredBy`. This is the ONLY truncation in " +
        "this tool; omit it (the default) for full bodies. Ignored by `commentId` and " +
        "`sinceLastAgentComment`, which always return full text.",
    ),
  sinceLastAgentComment: z
    .boolean()
    .optional()
    .describe(
      "When true, return ONLY the comments posted after your (the server's) most recent comment — " +
        'the cheap "did the human reply since I last posted?" check. Returns the complete delta in ' +
        "full, unpaginated. If you've never commented, the whole thread is returned.",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Return only comments after this point — either a comment `id` (all-digits) or an ISO " +
        "timestamp (e.g. `2026-06-01T10:00:00.000+0000`). Returns the complete delta in full, unpaginated.",
    ),
};

export const getCommentsInputSchema = z.object(getCommentsInputShape);
export type GetCommentsArgs = z.infer<typeof getCommentsInputSchema>;

export const GET_COMMENTS_DESCRIPTION =
  "Read a JIRA issue's comments as their own paginated thread (so re-reading doesn't re-send the " +
  "whole issue). Returns FULL comment bodies by default — bodies are never truncated; leanness comes " +
  "from page size. Each comment carries `authoredBy` (agent/human/unknown), resolved server-side, " +
  "and a markdown body. Order with `order`; page with the opaque `nextCursor`/`isLast` contract. " +
  "Use `preview:true` for short snippets when scanning, `commentId` to pull one full comment, " +
  "`sinceLastAgentComment:true` to fetch only what was posted after your last comment, or `since` " +
  "(comment id or timestamp) for an explicit boundary. " +
  "Emoji reactions are not exposed by the Jira REST API and are not included.";

/** Map the agent-facing order to JIRA's `orderBy`. */
function orderByFor(order: "newest" | "oldest"): "created" | "-created" {
  return order === "newest" ? "-created" : "created";
}

/** True when a raw comment resolves to agent authorship (property-first, marker fallback). */
function isAgentComment(raw: JiraRestCommentFull, marker: string): boolean {
  return (
    deriveAuthoredBy(
      { properties: raw.properties, bodyText: adfToMarkdown(raw.body), hasAuthor: Boolean(raw.author) },
      { marker },
    ) === "agent"
  );
}

export async function getCommentsHandler(
  jira: IJiraClient,
  args: GetCommentsArgs,
  deps: GetCommentsDeps,
): Promise<CallToolResult> {
  try {
    // A single-comment fetch dominates everything else — it's the recovery path
    // for get_issue's clipped preview, and always returns full text.
    if (args.commentId !== undefined && args.commentId.trim() !== "") {
      return await singleCommentRead(jira, args, deps);
    }

    const sinceProvided = args.since !== undefined && args.since.trim() !== "";
    if (args.sinceLastAgentComment && sinceProvided) {
      return shapeError(
        {
          message: "Pass either `sinceLastAgentComment` or `since`, not both.",
          code: "ambiguous_delta_filter",
        },
        [
          "`sinceLastAgentComment` and `since` define two different boundaries. Pick one: " +
            '`sinceLastAgentComment:true` for "since my last comment", or `since` for an explicit id/timestamp.',
        ],
      );
    }

    if (args.sinceLastAgentComment || sinceProvided) {
      return await deltaRead(jira, args, deps, sinceProvided);
    }
    return await pageRead(jira, args, deps);
  } catch (err) {
    return commentReadError(args.issueKey, err);
  }
}

/** Fetch one comment by id, in full (never previewed). */
async function singleCommentRead(
  jira: IJiraClient,
  args: GetCommentsArgs,
  deps: GetCommentsDeps,
): Promise<CallToolResult> {
  let raw;
  try {
    raw = await jira.getComment({
      issueKey: args.issueKey,
      commentId: args.commentId!.trim(),
      expand: ["properties"],
    });
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) {
      return shapeError(
        {
          message: `Comment ${args.commentId} was not found on ${args.issueKey}.`,
          code: "comment_not_found",
        },
        [
          `No comment matched id \`${args.commentId}\` on \`${args.issueKey}\` — it may have been deleted, ` +
            "or the issue itself may not exist or be visible to the token. Drop `commentId` to read the " +
            "thread (and confirm the id from a comment's `id`), or check the issue key with `jira_search`.",
        ],
      );
    }
    throw err; // auth / generic / unexpected → the outer handler shapes it.
  }

  const comment = serializeComment(raw, { marker: deps.marker });
  return shapeSuccess(
    { issueKey: args.issueKey, comments: [comment], count: 1, isLast: true },
    [`Comment ${comment.id} returned in full.`],
  );
}

/**
 * Plain paginated read: opaque cursor over JIRA's offset, search-style hints.
 * The page is packed by token budget over whole comments (count-backstopped), so
 * full bodies stay lean without ever clipping a body.
 */
async function pageRead(
  jira: IJiraClient,
  args: GetCommentsArgs,
  deps: GetCommentsDeps,
): Promise<CallToolResult> {
  const firstPage = args.cursor === undefined;

  let startAt = 0;
  if (args.cursor !== undefined) {
    const decoded = decodeCommentCursor(args.cursor);
    if (decoded === null) {
      return shapeError(
        { message: "The pagination cursor could not be read.", code: "invalid_cursor" },
        [
          "Pass back a `nextCursor` from a previous jira_get_comments response verbatim, " +
            "or omit `cursor` to start from the first page.",
        ],
      );
    }
    startAt = decoded;
  }

  // Over-fetch up to the count backstop, then pack a page by token budget. We
  // never include more than the backstop, so a backstop-sized fetch is enough.
  const page = await jira.getComments({
    issueKey: args.issueKey,
    startAt,
    maxResults: PAGE_COMMENT_BACKSTOP,
    orderBy: orderByFor(args.order),
    expand: ["properties"],
  });

  const raw = page.comments ?? [];
  const serialized = raw.map((c) => serializeComment(c, { marker: deps.marker, preview: args.preview }));
  // Pack the page by token budget over WHOLE comments, count-backstopped: the
  // first comment is always kept (so an over-budget one is its own whole page,
  // uncut), and no page ever exceeds the comment-count backstop.
  const comments = packUntilBudget(
    serialized,
    (c) => estimateTokens(c.body),
    PAGE_TOKEN_BUDGET,
    PAGE_COMMENT_BACKSTOP,
  ).kept;

  const pageStart = typeof page.startAt === "number" ? page.startAt : startAt;
  const consumedEnd = pageStart + comments.length;
  const isLast = consumedEnd >= page.total;
  const nextCursor = isLast ? undefined : encodeCommentCursor(consumedEnd);

  const hints: string[] = [];
  if (comments.length === 0) {
    hints.push("This issue has no comments yet.");
  } else if (isLast && firstPage) {
    hints.push(`Showing all ${comments.length} comment(s) — this is the complete thread.`);
  } else if (!isLast) {
    hints.push(
      `${comments.length} comment(s) on this page; more remain — pass \`nextCursor\` back verbatim as \`cursor\` for the next page.`,
    );
  } else {
    hints.push("Last page reached — no further comments.");
  }
  addPreviewHint(hints, args, comments);

  const data: Record<string, unknown> = {
    issueKey: args.issueKey,
    comments,
    count: comments.length,
    total: page.total,
    isLast,
  };
  if (nextCursor !== undefined) data.nextCursor = nextCursor;

  return shapeSuccess(data, hints);
}

/**
 * Delta read: walk the thread newest-first and collect until a boundary, so the
 * common "did the human reply?" check costs one or two comments. The boundary is
 * the latest agent comment (`sinceLastAgentComment`) or an explicit id/timestamp
 * (`since`). The collected delta is returned whole and in FULL (no cursor, never
 * previewed), in the requested order.
 */
async function deltaRead(
  jira: IJiraClient,
  args: GetCommentsArgs,
  deps: GetCommentsDeps,
  sinceProvided: boolean,
): Promise<CallToolResult> {
  const stop = sinceProvided ? makeSinceBoundary(args.since!.trim()) : null;
  if (stop && "error" in stop) {
    return shapeError(stop.error, stop.hints);
  }
  const stops = stop as ((raw: JiraRestCommentFull) => boolean) | null;

  const collected: JiraRestCommentFull[] = [];
  let startAt = 0;
  let hitBoundary = false;

  walk: for (;;) {
    const page = await jira.getComments({
      issueKey: args.issueKey,
      startAt,
      maxResults: DELTA_PAGE_SIZE,
      orderBy: "-created", // newest-first: the first boundary we hit IS the latest.
      expand: ["properties"],
    });
    const batch = page.comments ?? [];
    for (const c of batch) {
      const isBoundary = stops ? stops(c) : isAgentComment(c, deps.marker);
      if (isBoundary) {
        hitBoundary = true;
        break walk;
      }
      collected.push(c);
    }
    startAt += batch.length;
    if (batch.length === 0 || startAt >= page.total) break;
  }

  // `collected` is newest-first; present it in the requested order. Delta always
  // returns full bodies (no preview), even when `preview` was passed.
  const ordered = args.order === "oldest" ? [...collected].reverse() : collected;
  const comments = ordered.map((c) => serializeComment(c, { marker: deps.marker }));

  const hints: string[] = [];
  if (sinceProvided) {
    hints.push(
      comments.length === 0
        ? `No comments after ${args.since!.trim()}.`
        : `${comments.length} comment(s) after ${args.since!.trim()}.`,
    );
  } else if (!hitBoundary) {
    // No agent comment anywhere → the whole thread is "since your last comment".
    hints.push(
      comments.length === 0
        ? "This issue has no comments yet."
        : `You haven't commented on this issue; returning the full thread (${comments.length} comment(s)).`,
    );
  } else {
    hints.push(
      comments.length === 0
        ? "No comments since your last comment — the human hasn't replied."
        : `${comments.length} comment(s) since your last comment.`,
    );
  }

  return shapeSuccess(
    { issueKey: args.issueKey, comments, count: comments.length, isLast: true },
    hints,
  );
}

/**
 * Build the `since` stop predicate. `since` is a comment id (all digits) or an
 * ISO timestamp; walking newest-first, stop at (and exclude) the boundary.
 */
function makeSinceBoundary(
  since: string,
): ((raw: JiraRestCommentFull) => boolean) | { error: { message: string; code: string }; hints: string[] } {
  const isId = /^\d+$/.test(since);
  if (isId) {
    return (raw) => raw.id === since;
  }

  const boundary = Date.parse(since);
  if (Number.isNaN(boundary)) {
    return {
      error: {
        message: `\`since\` value "${since}" is neither a comment id nor a recognizable timestamp.`,
        code: "invalid_since",
      },
      hints: [
        "Pass `since` as a comment id (all digits, e.g. `10042`) or an ISO timestamp " +
          "(e.g. `2026-06-01T10:00:00.000+0000`). Both come from a previous comment's `id`/`created`.",
      ],
    };
  }
  return (raw) => {
    const created = raw.created ? Date.parse(raw.created) : NaN;
    // Stop once we reach a comment at or before the boundary (older).
    return Number.isNaN(created) ? false : created <= boundary;
  };
}

/**
 * In `preview` mode, tell the agent how to get full text — WITHIN this tool.
 * Names a clipped comment's id so the recovery (`commentId=…`) is one step away.
 */
function addPreviewHint(hints: string[], args: GetCommentsArgs, comments: SerializedComment[]): void {
  if (!args.preview) return;
  const clipped = comments.find((c) => c.bodyClipped);
  if (!clipped) return; // nothing was actually snipped — the bodies are already full.
  hints.push(
    `Preview mode: bodies marked \`bodyClipped:true\` are 1–2 line snippets whose full text is NOT ` +
      `shown; bodies without that flag are complete. Call again without \`preview\` for full bodies, ` +
      `or \`jira_get_comments(commentId=<id>)\` for any one clipped comment (e.g. id ${clipped.id}).`,
  );
}

/** Shape a comment-read failure: auth, not-found, or generic/unexpected. */
function commentReadError(issueKey: string, err: unknown): CallToolResult {
  if (err instanceof JiraApiError) {
    if (err.isAuthError) return authErrorResult(err);
    if (err.isNotFound) {
      return shapeError(
        { message: `Issue ${issueKey} was not found.`, code: "issue_not_found" },
        [
          `No issue matched \`${issueKey}\` (or the token can't see it). Check the key (e.g. PROJ-123), ` +
            "or find it with `jira_search`.",
        ],
      );
    }
    return genericJiraErrorResult(err);
  }
  return unexpectedErrorResult(err);
}

export function registerGetCommentsTool(
  server: McpServer,
  jira: IJiraClient,
  deps: GetCommentsDeps,
): void {
  server.registerTool(
    "jira_get_comments",
    {
      title: "Read a JIRA issue's comments",
      description: GET_COMMENTS_DESCRIPTION,
      inputSchema: getCommentsInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => getCommentsHandler(jira, args, deps),
  );
}
