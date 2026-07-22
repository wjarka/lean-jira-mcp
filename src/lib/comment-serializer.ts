/**
 * Shared comment serializer.
 *
 * Turns a raw JIRA comment into the lean, agent-readable shape both
 * `jira_get_issue` (preview comments) and `jira_get_comments` (full threads)
 * return. Bodies are flattened to markdown so the ADF node tree never reaches
 * the model; the visible authorship marker, being part of the body text,
 * survives the flattening.
 *
 * `authoredBy` (agent/human/unknown) is resolved server-side here — the
 * `mcp.origin` property is primary, with the configured + legacy marker as a
 * fallback for pre-property comments (see {@link deriveAuthoredBy}). Both
 * callers pass the configured marker so the same derivation backs every surface;
 * the agent only ever reads the enum, never the detection mechanism.
 */

import { adfToMarkdown } from "./adf-to-markdown.ts";
import { deriveAuthoredBy, type AuthoredBy } from "./comment-authorship.ts";
import { CHARS_PER_TOKEN } from "./text-budget.ts";

export interface JiraRestComment {
  id: string;
  author?: { displayName?: string; accountId?: string } | null;
  body?: unknown;
  created?: string;
  updated?: string;
  /** Out-of-band properties (from `expand=properties`); carries authorship. */
  properties?: { key?: string; value?: unknown }[] | null;
}

export interface SerializedComment {
  id: string;
  /** Author display name, or null when JIRA omitted it. */
  author: string | null;
  /** Resolved server-side: property-primary, marker fallback. */
  authoredBy: AuthoredBy;
  created: string | null;
  /** Present only when the comment was edited after creation. */
  updated?: string;
  /** Comment body as markdown (marker preserved). Full unless `preview` snipped it. */
  body: string;
  /**
   * Present (and `true`) only in `preview` mode, when the snippet is shorter
   * than the full body — the signal that the full text lives elsewhere
   * (`jira_get_comments(commentId=…)`). NEVER set on a full-body serialization.
   */
  bodyClipped?: true;
}

/** A preview snippet keeps the first 1–2 lines, capped at this token estimate. */
const PREVIEW_MAX_LINES = 2;
const PREVIEW_MAX_TOKENS = 60;

/**
 * Reduce a full markdown body to a short (1–2 line) snippet for cheap thread
 * scanning. The marker leads the body, so keeping the start preserves it.
 * `clipped` is true whenever the snippet differs from the full body at all —
 * dropped lines, a hard char cut, OR collapsed paragraph breaks — so the caller
 * can always point the agent at the full-text path within the same tool.
 */
function previewSnippet(body: string): { text: string; clipped: boolean } {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  let text = lines.slice(0, PREVIEW_MAX_LINES).join(" ");

  const maxChars = PREVIEW_MAX_TOKENS * CHARS_PER_TOKEN;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd() + " …";
  }
  return { text, clipped: text !== body };
}

export function serializeComment(
  raw: JiraRestComment,
  opts: { marker: string; preview?: boolean },
): SerializedComment {
  // Authorship is always derived from the FULL body (the marker may sit anywhere
  // a snippet could drop), even when the emitted body is a preview snippet.
  const fullBody = adfToMarkdown(raw.body);
  const out: SerializedComment = {
    id: raw.id,
    author: raw.author?.displayName ?? null,
    authoredBy: deriveAuthoredBy(
      { properties: raw.properties, bodyText: fullBody, hasAuthor: Boolean(raw.author) },
      { marker: opts.marker },
    ),
    created: raw.created ?? null,
    body: fullBody,
  };

  if (opts.preview) {
    const { text, clipped } = previewSnippet(fullBody);
    out.body = text;
    if (clipped) out.bodyClipped = true;
  }

  // Surface `updated` only when it represents a real edit.
  if (raw.updated && raw.updated !== raw.created) {
    out.updated = raw.updated;
  }

  return out;
}
