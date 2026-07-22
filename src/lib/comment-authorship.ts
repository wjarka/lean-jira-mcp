/**
 * Comment authorship — the server natively owns who wrote a comment so agents
 * never hand-parse ADF to tell their own notes from a human's.
 *
 * Two signals, stamped on every comment the server writes (no opt-out):
 *   - the out-of-band `mcp.origin` comment **property** — the machine truth,
 *     invisible in the JIRA UI, read back via `expand=properties`;
 *   - a **visible marker** in the body (configurable, default `:claude:`) so a
 *     human scanning the thread can see at a glance which comments are the
 *     agent's.
 *
 * `deriveAuthoredBy` resolves authorship server-side: the property is primary;
 * the marker is a fallback for comments written before the property existed (or
 * by a different agent that used the same/legacy marker). Both absent → human;
 * no author at all → unknown. This is the derivation `jira_get_comments` (08)
 * reuses; here it backs the edit guard (only agent-authored comments are
 * editable).
 */

import type { AdfNode } from "./adf-to-markdown.ts";
import type { AdfDoc } from "./markdown-to-adf.ts";

/** Out-of-band property key carrying the machine truth of authorship. */
export const ORIGIN_PROPERTY_KEY = "mcp.origin";

/** Stamped as the property value. Presence of the key is what matters; the
 *  value records who/what for forward compatibility. */
export const ORIGIN_PROPERTY_VALUE = { authoredBy: "agent", source: "lean-jira-mcp" } as const;

/**
 * The original hardcoded marker. Always recognised on read even when the
 * operator has reconfigured `JIRA_MCP_COMMENT_MARKER`, so existing agent history
 * doesn't suddenly read as human-authored. New comments use the *configured*
 * marker.
 */
export const LEGACY_MARKER = ":claude:";

export type AuthoredBy = "agent" | "human" | "unknown";

interface RawProperty {
  key?: string;
  value?: unknown;
}

/** True when the comment carries the out-of-band origin property. */
export function hasOriginProperty(properties: RawProperty[] | null | undefined): boolean {
  if (!Array.isArray(properties)) return false;
  return properties.some((p) => p?.key === ORIGIN_PROPERTY_KEY);
}

/** A marker that looks like an emoji shortcode, e.g. `:claude:`, `:+1:`. */
const EMOJI_SHORTCODE_RE = /^:[\w+-]+:$/;

export function isEmojiMarker(marker: string): boolean {
  return EMOJI_SHORTCODE_RE.test(marker);
}

/**
 * The inline node(s) the marker becomes in ADF. An emoji shortcode renders as a
 * real `emoji` node (JIRA only renders an emoji from the node — plain `:claude:`
 * text just shows the literal shortcode) followed by a separating space; any
 * other marker is stamped as plain text.
 */
function markerInlineNodes(marker: string): AdfNode[] {
  if (isEmojiMarker(marker)) {
    return [{ type: "emoji", attrs: { shortName: marker } }, { type: "text", text: " " }];
  }
  return [{ type: "text", text: `${marker} ` }];
}

function paragraphLeadsWithMarker(paragraph: AdfNode, marker: string): boolean {
  const first = paragraph.content?.[0];
  if (!first) return false;
  if (isEmojiMarker(marker)) {
    return first.type === "emoji" && first.attrs?.shortName === marker;
  }
  return first.type === "text" && (first.text ?? "").trimStart().startsWith(marker);
}

/**
 * Stamp the visible marker onto an ADF comment body, without opt-out. The marker
 * leads the body (prepended to the first paragraph, or a new leading paragraph
 * when the body opens with a non-paragraph block) so it's visible at the top in
 * the JIRA UI. Idempotent: a body already leading with the marker is returned
 * unchanged, so an edit re-stamp never doubles it.
 *
 * Crucially the emoji marker becomes a real ADF `emoji` node, not literal text —
 * {@link adfToMarkdown} flattens that node back to its shortName, so authorship
 * detection on read still sees the leading marker.
 */
export function stampMarkerAdf(doc: AdfDoc, marker: string): AdfDoc {
  const content: AdfNode[] = [...(doc.content ?? [])];
  const lead = markerInlineNodes(marker);
  const first = content[0];

  if (first && first.type === "paragraph") {
    if (paragraphLeadsWithMarker(first, marker)) return doc;
    content[0] = { ...first, content: [...lead, ...(first.content ?? [])] };
  } else {
    content.unshift({ type: "paragraph", content: lead });
  }

  return { ...doc, content };
}

/**
 * True when the body text LEADS WITH any recognised marker.
 *
 * Detection mirrors {@link stampMarkerAdf}, which always prepends the marker at
 * the start of the body (and {@link adfToMarkdown} flattens an emoji marker back
 * to its shortName). Matching only at the start (not anywhere via `includes`) is
 * deliberate: a human comment that merely *mentions* `:claude:` mid-text must not
 * be misread as agent-authored — that would let the edit guard wrongly edit a
 * human's comment.
 */
function bodyHasMarker(bodyText: string, markers: string[]): boolean {
  const lead = bodyText.trimStart();
  return markers.some((m) => m.length > 0 && lead.startsWith(m));
}

export interface AuthorshipSignals {
  /** The comment's properties (from `expand=properties`). */
  properties?: RawProperty[] | null;
  /** The comment body flattened to markdown (marker survives flattening). */
  bodyText?: string;
  /** Whether JIRA reported an author at all (for the human/unknown split). */
  hasAuthor?: boolean;
}

/**
 * Resolve authorship server-side. Property primary; configured + legacy marker
 * fallback; both absent → human (or unknown when JIRA gave no author).
 */
export function deriveAuthoredBy(
  signals: AuthorshipSignals,
  opts: { marker: string },
): AuthoredBy {
  if (hasOriginProperty(signals.properties)) return "agent";

  const markers = [opts.marker, LEGACY_MARKER];
  if (signals.bodyText && bodyHasMarker(signals.bodyText, markers)) return "agent";

  return signals.hasAuthor === false ? "unknown" : "human";
}
