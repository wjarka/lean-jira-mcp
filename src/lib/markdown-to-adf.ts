/**
 * markdown → ADF converter (write direction).
 *
 * The agent authors rich text as markdown; JIRA Cloud only accepts Atlassian
 * Document Format. This is the inverse of {@link adfToMarkdown}: it parses the
 * documented safe subset (per the PRD) into an ADF node tree the REST API
 * accepts. Shared `lib/` primitive — `jira_create_issue` (this slice) uses it
 * now; `jira_update_issue` and `jira_comment` reuse it.
 *
 * Supported constructs: headings, bold/italic/strike, bullet/ordered lists
 * (flat), code blocks with a language fence, inline code, links, blockquote,
 * horizontal rule, and flat GFM tables. Round-trip with {@link adfToMarkdown}
 * is lossy by design; anything outside the subset degrades gracefully (its
 * text survives) and the converter never throws.
 */

import type { AdfMark, AdfNode } from "./adf-to-markdown.ts";

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/**
 * A coarse, per-category record of how the stored ADF differs from the input
 * markdown. The write tools fold these into the success `hints` so a lossy
 * conversion is *visible* (DESIGN.md: degrade gracefully = degrade visibly),
 * never silent. One entry per category at most — this is a category list, not a
 * per-node diff.
 */
export interface Degradation {
  kind:
    | "image"
    | "task-list"
    | "nested-list"
    | "table-alignment"
    | "unterminated-code-fence";
  detail: string;
}

export interface MarkdownConversion {
  doc: AdfDoc;
  degradations: Degradation[];
}

/** Accumulates degradations, collapsing repeats of the same category to one. */
interface DegradationSink {
  add(kind: Degradation["kind"], detail: string): void;
}

function makeSink(): { sink: DegradationSink; list: () => Degradation[] } {
  const seen = new Map<Degradation["kind"], string>();
  return {
    sink: { add: (kind, detail) => { if (!seen.has(kind)) seen.set(kind, detail); } },
    list: () => [...seen].map(([kind, detail]) => ({ kind, detail })),
  };
}

/**
 * Convert markdown to ADF AND report how the result degrades from the input.
 * Empty input → empty doc with no degradations.
 */
export function convertMarkdown(markdown: string): MarkdownConversion {
  const normalized = (markdown ?? "").replace(/\r\n?/g, "\n");
  const { sink, list } = makeSink();
  // Defense-in-depth: whatever the block/inline parsers produced, run a final
  // pass that guarantees schema-valid marks (code-exclusivity) before it leaves
  // the converter — so no path, present or future, can emit ADF JIRA rejects.
  const content = enforceMarkValidity(parseBlocks(normalized.split("\n"), sink));
  return { doc: { type: "doc", version: 1, content }, degradations: list() };
}

/** Convert a markdown string into an ADF document. Empty input → empty doc. */
export function markdownToAdf(markdown: string): AdfDoc {
  return convertMarkdown(markdown).doc;
}

/**
 * Render a degradation list into a single `hints` sentence a writing tool can
 * fold into its success response, or `undefined` when nothing degraded. Coarse
 * by design — it names the categories, not a per-node diff.
 */
export function degradationHint(degradations: Degradation[]): string | undefined {
  if (degradations.length === 0) return undefined;
  return `Stored body differs from your input: ${degradations.map((d) => d.detail).join("; ")}.`;
}

// --- block level ------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(.*)$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+\.\s+(.*)$/;

function parseBlocks(lines: string[], sink: DegradationSink): AdfNode[] {
  const blocks: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      // A fence with no closing ``` must NOT swallow the remainder of the body
      // as code. When unterminated, emit the fence line as literal text (so it
      // stays visible) and let the rest parse normally; report the degradation.
      if (!hasFenceClose(lines, i + 1)) {
        sink.add("unterminated-code-fence", "an unterminated code fence was treated as text, not code");
        blocks.push({ type: "paragraph", content: parseInline(line, [], sink) });
        i++;
        continue;
      }
      const result = parseCodeBlock(lines, i);
      blocks.push(result.node);
      i = result.next;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        attrs: { level: heading[1]!.length },
        content: parseInline(heading[2] ?? "", [], sink),
      });
      i++;
      continue;
    }

    // Horizontal rule must beat the bullet rule (`---` vs `- item`).
    if (HR_RE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const result = parseBlockquote(lines, i, sink);
      blocks.push(result.node);
      i = result.next;
      continue;
    }

    if (isTableHeader(lines, i)) {
      const result = parseTable(lines, i, sink);
      blocks.push(result.node);
      i = result.next;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const result = parseList(lines, i, "bullet", sink);
      blocks.push(result.node);
      i = result.next;
      continue;
    }

    if (ORDERED_RE.test(line)) {
      const result = parseList(lines, i, "ordered", sink);
      blocks.push(result.node);
      i = result.next;
      continue;
    }

    const result = parseParagraph(lines, i, sink);
    blocks.push(result.node);
    i = result.next;
  }

  return blocks;
}

/** Is there a closing ``` somewhere at or after `from`? */
function hasFenceClose(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (FENCE_CLOSE_RE.test(lines[i] ?? "")) return true;
  }
  return false;
}

function parseCodeBlock(lines: string[], start: number): { node: AdfNode; next: number } {
  const fence = FENCE_RE.exec(lines[start] ?? "");
  const language = (fence?.[1] ?? "").trim();
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i] ?? "")) {
    body.push(lines[i] ?? "");
    i++;
  }
  // Skip the closing fence if present.
  if (i < lines.length) i++;

  const text = body.join("\n");
  return {
    node: {
      type: "codeBlock",
      attrs: language ? { language } : {},
      content: text.length > 0 ? [{ type: "text", text }] : [],
    },
    next: i,
  };
}

function parseBlockquote(
  lines: string[],
  start: number,
  sink: DegradationSink,
): { node: AdfNode; next: number } {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length) {
    const match = QUOTE_RE.exec(lines[i] ?? "");
    if (!match) break;
    inner.push(match[1] ?? "");
    i++;
  }
  return { node: { type: "blockquote", content: parseBlocks(inner, sink) }, next: i };
}

const TASK_ITEM_RE = /^\[([ xX])\]\s+/;

function parseList(
  lines: string[],
  start: number,
  kind: "bullet" | "ordered",
  sink: DegradationSink,
): { node: AdfNode; next: number } {
  const re = kind === "bullet" ? BULLET_RE : ORDERED_RE;
  const items: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const match = re.exec(rawLine);
    if (!match) break;
    // Leading indentation means a nested list the flat parser is flattening.
    if (/^\s+/.test(rawLine)) {
      sink.add("nested-list", "nested list items were flattened to a single level");
    }
    const itemText = match[1] ?? "";
    // GFM task-list syntax (`- [ ] x`) has no ADF list equivalent here; it is
    // stored as a plain item with literal `[ ]`/`[x]` text — report the loss.
    if (kind === "bullet" && TASK_ITEM_RE.test(itemText)) {
      sink.add("task-list", "task-list checkboxes were flattened to plain list items");
    }
    items.push({
      type: "listItem",
      content: [{ type: "paragraph", content: parseInline(itemText, [], sink) }],
    });
    i++;
  }
  return { node: { type: kind === "bullet" ? "bulletList" : "orderedList", content: items }, next: i };
}

function parseParagraph(
  lines: string[],
  start: number,
  sink: DegradationSink,
): { node: AdfNode; next: number } {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length && !isBlockBoundary(lines, i)) {
    collected.push(lines[i] ?? "");
    i++;
  }

  const content: AdfNode[] = [];
  collected.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...parseInline(line, [], sink));
  });

  return { node: { type: "paragraph", content }, next: i };
}

/** A paragraph ends at a blank line or the start of any other block. */
function isBlockBoundary(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  if (i === 0) return false;
  if (line.trim() === "") return true;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    isTableHeader(lines, i)
  );
}

// --- tables -----------------------------------------------------------------

const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** A table starts with a row containing a pipe followed by a `---` separator row. */
function isTableHeader(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  const next = lines[i + 1] ?? "";
  return line.includes("|") && TABLE_SEPARATOR_RE.test(next) && next.includes("-");
}

function parseTable(
  lines: string[],
  start: number,
  sink: DegradationSink,
): { node: AdfNode; next: number } {
  // A `:` in the separator row encodes column alignment, which the ADF table
  // (cells are plain paragraphs) cannot carry — report the dropped alignment.
  if ((lines[start + 1] ?? "").includes(":")) {
    sink.add("table-alignment", "table column alignment was dropped");
  }
  const header = splitRow(lines[start] ?? "");
  const rows: AdfNode[] = [tableRow(header, "tableHeader", sink)];

  // Body rows: everything after the separator that still looks like a row.
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || !line.includes("|")) break;
    rows.push(tableRow(splitRow(line), "tableCell", sink));
    i++;
  }

  return { node: { type: "table", content: rows }, next: i };
}

function tableRow(
  cells: string[],
  cellType: "tableHeader" | "tableCell",
  sink: DegradationSink,
): AdfNode {
  return {
    type: "tableRow",
    content: cells.map((cell) => ({
      type: cellType,
      content: [{ type: "paragraph", content: parseInline(cell, [], sink) }],
    })),
  };
}

/** Split a `| a | b |` row into trimmed cells, honoring escaped `\|`. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

// --- inline -----------------------------------------------------------------

type InlineKind = "image" | "code" | "link" | "strong" | "strike" | "em";

interface InlinePattern {
  kind: InlineKind;
  re: RegExp;
}

// Order matters only as a tie-break when two patterns match at the same index:
// `code` is literal (no nesting), and `strong` (`**`) must beat `em` (`*`).
// `image` (`![…](…)`) precedes `link` so the `!` is consumed as part of the
// image, never left dangling as a stray text node.
const INLINE_PATTERNS: InlinePattern[] = [
  { kind: "image", re: /!\[([^\]]*)\]\(([^)\s]+)\)/ },
  { kind: "code", re: /`([^`]+)`/ },
  { kind: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { kind: "strong", re: /\*\*([^*]+)\*\*/ },
  { kind: "strike", re: /~~([^~]+)~~/ },
  { kind: "em", re: /\*([^*]+)\*/ },
];

/**
 * Parse a single line of inline markdown into ADF text nodes. `marks` carries
 * the formatting inherited from an enclosing construct (e.g. a link wrapping
 * bold text), so nesting composes by recursion. `sink` records any construct
 * (e.g. an inline image) that degrades on the way to ADF.
 *
 * Sibling spans on the line are consumed with a left-to-right loop over the
 * tail (not tail-recursion), so stack depth stays O(nesting depth) rather than
 * O(span count) — a line with tens of thousands of inline spans must not blow
 * the stack. Only genuine nesting (a construct's content) recurses, and that is
 * bounded by how deeply markup is nested.
 */
function parseInline(text: string, marks: AdfMark[], sink: DegradationSink): AdfNode[] {
  const nodes: AdfNode[] = [];
  let rest = text;

  while (rest.length > 0) {
    let earliest: { pattern: InlinePattern; match: RegExpExecArray } | null = null;
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.re.exec(rest);
      if (match && (earliest === null || match.index < earliest.match.index)) {
        earliest = { pattern, match };
      }
    }

    if (!earliest) {
      nodes.push(textNode(rest, marks));
      break;
    }

    const { pattern, match } = earliest;
    const before = rest.slice(0, match.index);

    if (before.length > 0) nodes.push(textNode(before, marks));

    if (pattern.kind === "code") {
      // Inline code is literal — its content is not re-parsed for markup — and
      // ADF's `code` mark is EXCLUSIVE: a code-marked text node must carry no
      // other formatting mark. Emit code-only, dropping any inherited
      // strong/em/link/… so a nesting like `**foo `bar`**` (or the reverse)
      // cannot produce a schema-invalid `code`+`strong` node. The final
      // enforceMarkValidity pass backstops this, but keeping the rule at the
      // emission site makes the exclusivity intent local and explicit.
      nodes.push(textNode(match[1] ?? "", [{ type: "code" }]));
    } else if (pattern.kind === "image") {
      // ADF inline images are out of the supported subset. Rather than emit junk,
      // store a clean link to the source (label = alt text, or the url when alt
      // is empty) and report the degradation so the writing tool can surface it.
      sink.add("image", "images were saved as plain links");
      const alt = match[1] ?? "";
      const href = match[2] ?? "";
      const label = alt.length > 0 ? alt : href;
      nodes.push(...parseInline(label, [...marks, { type: "link", attrs: { href } }], sink));
    } else if (pattern.kind === "link") {
      nodes.push(
        ...parseInline(match[1] ?? "", [...marks, { type: "link", attrs: { href: match[2] ?? "" } }], sink),
      );
    } else {
      nodes.push(...parseInline(match[1] ?? "", [...marks, { type: pattern.kind }], sink));
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return nodes;
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return marks.length > 0 ? { type: "text", text, marks: [...marks] } : { type: "text", text };
}

// --- ADF-validity pass ------------------------------------------------------

/**
 * Final defense-in-depth pass over a produced ADF node tree: normalize away any
 * mark combination the ADF schema forbids, so the converter's contract is
 * "always emits schema-valid ADF", not merely "plausible ADF".
 *
 * The one rule enforced today is **`code`-exclusivity**: ADF's `code` mark must
 * not be combined with `strong`, `em`, `strike`, `underline`, `link`, `subsup`,
 * or `textColor` — JIRA's ADF validator rejects the combination with a bare
 * top-level `INVALID_INPUT`. A text node carrying `code` alongside any other
 * mark is collapsed to `code` alone. The pass is generalized (walks the whole
 * tree, one rule easily joined by more) precisely so a future converter path
 * can't silently reintroduce a schema-invalid combination.
 */
export function enforceMarkValidity(nodes: AdfNode[]): AdfNode[] {
  return nodes.map(normalizeMarks);
}

function normalizeMarks(node: AdfNode): AdfNode {
  let out = node;
  const marks = node.marks;
  if (marks && marks.length > 1 && marks.some((m) => m.type === "code")) {
    // `code` is exclusive — drop every other mark, keeping `code` alone.
    out = { ...out, marks: [{ type: "code" }] };
  }
  if (out.content) {
    out = { ...out, content: enforceMarkValidity(out.content) };
  }
  return out;
}
