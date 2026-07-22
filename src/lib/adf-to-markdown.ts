/**
 * ADF → markdown converter (read direction).
 *
 * Flattens an Atlassian Document Format node tree into a markdown string for
 * the agent to read, so rich text never leaks to the model as a raw ADF blob.
 * This is a shared `lib/` primitive: `jira_get_issue` (this slice) and the
 * comment serializer use it now; every later read-side tool reuses it.
 *
 * Supported constructs (the documented safe subset, per the PRD): headings,
 * bold/italic/strike, bullet/ordered lists (nested), code blocks with a
 * language fence, inline code, links, blockquote, horizontal rule, and flat
 * GFM tables. The write direction (markdown → ADF) lives elsewhere.
 *
 * Round-trip is lossy by design. Anything outside the subset degrades
 * gracefully: an unknown *block* recurses into its children so their text
 * survives; an unknown *inline* node falls back to whatever text it carries.
 * The converter never throws on malformed input and never emits raw ADF.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type?: string;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}

/** Convert an ADF document (or any node with `content`) to markdown. */
export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const node = doc as AdfNode;
  return renderBlocks(node.content ?? []).trim();
}

/** Render a list of block-level nodes, separated by a blank line. */
function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map((n) => renderBlock(n))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? []);

    case "heading": {
      const level = clampLevel(node.attrs?.level);
      return `${"#".repeat(level)} ${renderInline(node.content ?? [])}`;
    }

    case "bulletList":
      return renderList(node, "bullet");

    case "orderedList":
      return renderList(node, "ordered");

    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const body = (node.content ?? []).map((n) => n.text ?? "").join("");
      return `\`\`\`${language}\n${body}\n\`\`\``;
    }

    case "blockquote":
      return prefixLines(renderBlocks(node.content ?? []), "> ");

    case "rule":
      return "---";

    case "table":
      return renderTable(node);

    // Embedded media has no markdown body, but its *existence* (and filename)
    // is information the reader would act on — surface a visible marker rather
    // than the empty string. Containers carry the real `media` leaf inside.
    case "media":
      return mediaMarker(node.attrs);
    case "mediaSingle":
    case "mediaGroup":
      return renderBlocks(node.content ?? []) || "[image]";

    case "taskList":
      return renderTaskList(node);

    // A panel's body must survive AND its type is information (a warning panel
    // reads differently from an info one) — keep both.
    case "panel": {
      const type = typeof node.attrs?.panelType === "string" ? node.attrs.panelType : "info";
      const body = renderBlocks(node.content ?? []);
      return body ? `[panel: ${type}] ${body}` : `[panel: ${type}]`;
    }

    default:
      // Unknown block: preserve any text by recursing into its children.
      return node.content ? renderBlocks(node.content) : "";
  }
}

/** A taskList → real GFM checkboxes, preserving each item's checked state. */
function renderTaskList(node: AdfNode): string {
  return (node.content ?? [])
    .filter((item) => item.type === "taskItem")
    .map((item) => {
      const box = item.attrs?.state === "DONE" ? "- [x]" : "- [ ]";
      const text = renderInline(item.content ?? []);
      return text ? `${box} ${text}` : box;
    })
    .join("\n");
}

/** A media node → `[image: <filename/alt>]`, or a bare `[image]` when unnamed. */
function mediaMarker(attrs: Record<string, unknown> | undefined): string {
  const name = attrs?.alt ?? attrs?.filename ?? attrs?.title;
  return typeof name === "string" && name.length > 0 ? `[image: ${name}]` : "[image]";
}

function renderList(node: AdfNode, kind: "bullet" | "ordered"): string {
  const items = node.content ?? [];
  const lines: string[] = [];

  items.forEach((item, index) => {
    const marker = kind === "ordered" ? `${index + 1}. ` : "- ";
    const indent = " ".repeat(marker.length);
    const itemMarkdown = renderBlocks(item.content ?? []);
    const itemLines = itemMarkdown.split("\n");

    itemLines.forEach((line, lineIndex) => {
      if (line.length === 0) return;
      lines.push(lineIndex === 0 ? `${marker}${line}` : `${indent}${line}`);
    });
  });

  return lines.join("\n");
}

function renderTable(node: AdfNode): string {
  const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
  if (rows.length === 0) return "";

  const cellsOf = (row: AdfNode): string[] =>
    (row.content ?? []).map((cell) => flattenCell(cell));

  const headerRow = rows[0];
  if (!headerRow) return "";
  const header = cellsOf(headerRow);
  const columnCount = header.length;

  const separator = Array.from({ length: columnCount }, () => "---");
  const lines = [toTableRow(header), toTableRow(separator)];

  for (const row of rows.slice(1)) {
    lines.push(toTableRow(cellsOf(row)));
  }

  return lines.join("\n");
}

function toTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Flatten a table cell to single-line text (flat tables only). */
function flattenCell(cell: AdfNode): string {
  return renderBlocks(cell.content ?? [])
    .replace(/\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** Render a list of inline nodes into a single line of markdown. */
function renderInline(nodes: AdfNode[]): string {
  return nodes.map((n) => renderInlineNode(n)).join("");
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);

    case "hardBreak":
      return "\n";

    case "mention":
      return mentionText(node.attrs);

    case "emoji":
      return emojiText(node.attrs);

    case "status":
      return statusText(node.attrs);

    case "date":
      return dateText(node.attrs);

    case "inlineCard":
    case "blockCard": {
      const url = node.attrs?.url;
      if (typeof url === "string" && url.length > 0) return url;
      // A url-less smartlink still carries a title/text the reader would act on.
      const label = node.attrs?.title ?? node.attrs?.text;
      return typeof label === "string" ? label : "";
    }

    default:
      // Unknown inline: surface its own text, then any nested inline text.
      if (typeof node.text === "string") return node.text;
      return node.content ? renderInline(node.content) : "";
  }
}

/**
 * Apply ADF text marks. Inline `code` is exclusive — formatting marks inside a
 * code span would emit literal asterisks, so code wins and the rest are
 * dropped. A `link` always wraps the (possibly formatted) text. Marks with no
 * markdown equivalent (underline, textColor, subsup) pass the text through
 * unchanged.
 */
function applyMarks(text: string, marks: AdfMark[]): string {
  const types = new Set(marks.map((m) => m.type));
  let out = text;

  if (types.has("code")) {
    out = `\`${out}\``;
  } else {
    if (types.has("strong")) out = `**${out}**`;
    if (types.has("em")) out = `*${out}*`;
    if (types.has("strike")) out = `~~${out}~~`;
  }

  const link = marks.find((m) => m.type === "link");
  const href = link?.attrs?.href;
  if (typeof href === "string" && href.length > 0) {
    out = `[${out}](${href})`;
  }

  return out;
}

function mentionText(attrs: Record<string, unknown> | undefined): string {
  const raw = attrs?.text ?? attrs?.displayName;
  if (typeof raw !== "string" || raw.length === 0) return "";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function emojiText(attrs: Record<string, unknown> | undefined): string {
  if (typeof attrs?.text === "string" && attrs.text.length > 0) return attrs.text;
  if (typeof attrs?.shortName === "string") return attrs.shortName;
  return "";
}

/** A status lozenge → a visible `[status: DONE]` marker (its text is the info). */
function statusText(attrs: Record<string, unknown> | undefined): string {
  const text = attrs?.text;
  return typeof text === "string" && text.length > 0 ? `[status: ${text}]` : "";
}

/**
 * A date node → its `YYYY-MM-DD` value (an epoch-millis `timestamp` attr). A
 * missing or out-of-range timestamp falls back to a visible `[date]` marker —
 * a date node is information, so it must never silently vanish (DESIGN.md), and
 * the converter must never throw (an out-of-`Date`-range millis would make
 * `toISOString` throw RangeError).
 */
function dateText(attrs: Record<string, unknown> | undefined): string {
  const ts = attrs?.timestamp;
  const millis = typeof ts === "number" ? ts : typeof ts === "string" ? Number(ts) : NaN;
  if (Number.isFinite(millis)) {
    try {
      return new Date(millis).toISOString().slice(0, 10);
    } catch {
      // Finite but outside the representable Date range — fall through.
    }
  }
  return "[date]";
}

function clampLevel(level: unknown): number {
  const n = typeof level === "number" ? level : 1;
  return Math.min(6, Math.max(1, Math.trunc(n)));
}

function prefixLines(text: string, prefix: string): string {
  if (text.length === 0) return "";
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`.trimEnd())
    .join("\n");
}
