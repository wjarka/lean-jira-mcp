/**
 * Direct unit tests for the markdown→ADF converter (write direction).
 *
 * Two kinds of assertion:
 *   1. Structural — a markdown construct produces the expected ADF node shape
 *      (the agent authors markdown; JIRA only accepts ADF, so the node tree
 *      must be right).
 *   2. Round-trip — markdown → ADF → markdown (via the read-direction
 *      converter) yields equivalent markdown. This is the acceptance criterion:
 *      a description authored as markdown round-trips back to markdown on read.
 *
 * Pure-function tests: markdown in, ADF/markdown out — no JIRA, no handler.
 */

import { test, expect } from "bun:test";
import {
  markdownToAdf,
  convertMarkdown,
  enforceMarkValidity,
} from "../src/lib/markdown-to-adf.ts";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";

/** markdown → ADF → markdown; the round-trip the read side will perform. */
function roundTrip(md: string): string {
  return adfToMarkdown(markdownToAdf(md));
}

function blocks(md: string) {
  return (markdownToAdf(md) as { content: any[] }).content;
}

/** Every `text` node anywhere in an ADF tree (depth-first). */
function allTextNodes(node: any, acc: any[] = []): any[] {
  if (node?.type === "text") acc.push(node);
  if (Array.isArray(node?.content)) for (const c of node.content) allTextNodes(c, acc);
  return acc;
}

/** A text node whose marks combine `code` with any other mark — invalid ADF. */
function hasCodePlusOtherMark(node: any): boolean {
  const marks = node.marks ?? [];
  return marks.some((m: any) => m.type === "code") && marks.length > 1;
}

test("the document is a versioned ADF doc", () => {
  const doc = markdownToAdf("hello") as any;
  expect(doc.type).toBe("doc");
  expect(doc.version).toBe(1);
  expect(Array.isArray(doc.content)).toBe(true);
});

test("an empty / whitespace string produces an empty doc", () => {
  expect(blocks("")).toEqual([]);
  expect(blocks("   \n  ")).toEqual([]);
});

// --- paragraphs -------------------------------------------------------------

test("a plain paragraph", () => {
  const [p] = blocks("Hello world");
  expect(p).toEqual({ type: "paragraph", content: [{ type: "text", text: "Hello world" }] });
  expect(roundTrip("Hello world")).toBe("Hello world");
});

test("blank-line-separated paragraphs become separate nodes", () => {
  expect(blocks("First\n\nSecond")).toHaveLength(2);
  expect(roundTrip("First\n\nSecond")).toBe("First\n\nSecond");
});

test("soft line breaks within a paragraph become hard breaks and round-trip", () => {
  const [p] = blocks("a\nb") as any[];
  expect(p.content).toEqual([
    { type: "text", text: "a" },
    { type: "hardBreak" },
    { type: "text", text: "b" },
  ]);
  expect(roundTrip("a\nb")).toBe("a\nb");
});

// --- inline marks -----------------------------------------------------------

test("bold, italic, strike", () => {
  const [p] = blocks("a **bold** and *em* and ~~gone~~") as any[];
  expect(p.content).toEqual([
    { type: "text", text: "a " },
    { type: "text", text: "bold", marks: [{ type: "strong" }] },
    { type: "text", text: " and " },
    { type: "text", text: "em", marks: [{ type: "em" }] },
    { type: "text", text: " and " },
    { type: "text", text: "gone", marks: [{ type: "strike" }] },
  ]);
  expect(roundTrip("a **bold** and *em* and ~~gone~~")).toBe("a **bold** and *em* and ~~gone~~");
});

test("inline code is literal (no nested formatting)", () => {
  const [p] = blocks("call `foo(**x**)`") as any[];
  expect(p.content[1]).toEqual({ type: "text", text: "foo(**x**)", marks: [{ type: "code" }] });
  expect(roundTrip("call `foo(**x**)`")).toBe("call `foo(**x**)`");
});

// --- code-mark exclusivity (issue 20) ---------------------------------------
//
// ADF's `code` mark is EXCLUSIVE — a code-marked text node must carry no other
// formatting mark. Nesting inline code inside bold/italic (or the reverse) used
// to emit a single `code`+`strong`/`em` node, which JIRA's ADF validator
// rejects with a bare top-level INVALID_INPUT. The code span must come out
// code-only; the surrounding text keeps its own mark.

test("inline code inside bold emits a code-only node (`**error `<p>`**`)", () => {
  const [p] = blocks("logs **error `<p>`** here") as any[];
  // "error " keeps strong; "<p>" is code ONLY — never strong+code.
  expect(p.content).toEqual([
    { type: "text", text: "logs " },
    { type: "text", text: "error ", marks: [{ type: "strong" }] },
    { type: "text", text: "<p>", marks: [{ type: "code" }] },
    { type: "text", text: " here" },
  ]);
  expect(allTextNodes(p).some(hasCodePlusOtherMark)).toBe(false);
});

test("inline code inside italic emits a code-only node (`*foo `bar`*`)", () => {
  const [p] = blocks("*foo `bar`*") as any[];
  expect(p.content).toEqual([
    { type: "text", text: "foo ", marks: [{ type: "em" }] },
    { type: "text", text: "bar", marks: [{ type: "code" }] },
  ]);
  expect(allTextNodes(p).some(hasCodePlusOtherMark)).toBe(false);
});

test("bold wrapping only an inline code span yields code-only (`**`error`**`)", () => {
  const [p] = blocks("throws **`error`** now") as any[];
  expect(p.content).toEqual([
    { type: "text", text: "throws " },
    { type: "text", text: "error", marks: [{ type: "code" }] },
    { type: "text", text: " now" },
  ]);
});

test("the reverse — markup inside inline code — stays literal and code-only", () => {
  // Code is literal: `**bar**` inside a code span is not re-parsed as bold, and
  // the node carries `code` alone.
  const [p] = blocks("run `**bar**`") as any[];
  expect(p.content[1]).toEqual({ type: "text", text: "**bar**", marks: [{ type: "code" }] });
  expect(allTextNodes(p).some(hasCodePlusOtherMark)).toBe(false);
});

test("inline code inside a link comes out code-only (code beats the inherited link)", () => {
  const [p] = blocks("[`code`](https://example.com)") as any[];
  expect(allTextNodes(p).some(hasCodePlusOtherMark)).toBe(false);
  expect(p.content[0]).toEqual({ type: "text", text: "code", marks: [{ type: "code" }] });
});

// --- final ADF-validity pass (defense-in-depth) -----------------------------

test("enforceMarkValidity strips a hand-built code+strong combo to code-only", () => {
  const invalid = [
    {
      type: "text",
      text: "x",
      marks: [{ type: "strong" }, { type: "code" }, { type: "em" }],
    },
  ] as any;
  expect(enforceMarkValidity(invalid)).toEqual([
    { type: "text", text: "x", marks: [{ type: "code" }] },
  ]);
});

test("enforceMarkValidity recurses into nested content and leaves valid marks alone", () => {
  const tree = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "ok", marks: [{ type: "strong" }] },
        { type: "text", text: "bad", marks: [{ type: "code" }, { type: "link", attrs: { href: "u" } }] },
      ],
    },
  ] as any;
  expect(enforceMarkValidity(tree)).toEqual([
    {
      type: "paragraph",
      content: [
        { type: "text", text: "ok", marks: [{ type: "strong" }] },
        { type: "text", text: "bad", marks: [{ type: "code" }] },
      ],
    },
  ]);
});

test("links", () => {
  const [p] = blocks("see [the docs](https://example.com)") as any[];
  expect(p.content[1]).toEqual({
    type: "text",
    text: "the docs",
    marks: [{ type: "link", attrs: { href: "https://example.com" } }],
  });
  expect(roundTrip("see [the docs](https://example.com)")).toBe("see [the docs](https://example.com)");
});

// --- headings ---------------------------------------------------------------

test("headings at levels 1 and 3", () => {
  const md = "# Title\n\n### Sub";
  expect(blocks(md)).toEqual([
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Sub" }] },
  ]);
  expect(roundTrip(md)).toBe(md);
});

// --- lists ------------------------------------------------------------------

test("bullet list", () => {
  const md = "- one\n- two";
  const [list] = blocks(md) as any[];
  expect(list.type).toBe("bulletList");
  expect(list.content).toHaveLength(2);
  expect(list.content[0]).toEqual({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
  });
  expect(roundTrip(md)).toBe(md);
});

test("ordered list", () => {
  const md = "1. one\n2. two";
  const [list] = blocks(md) as any[];
  expect(list.type).toBe("orderedList");
  expect(list.content).toHaveLength(2);
  expect(roundTrip(md)).toBe(md);
});

test("list items carry inline marks", () => {
  const [list] = blocks("- a **bold** item") as any[];
  expect(list.content[0].content[0].content).toEqual([
    { type: "text", text: "a " },
    { type: "text", text: "bold", marks: [{ type: "strong" }] },
    { type: "text", text: " item" },
  ]);
});

// --- code blocks ------------------------------------------------------------

test("fenced code block with a language", () => {
  const md = "```ts\nconst x = 1;\n```";
  const [code] = blocks(md) as any[];
  expect(code).toEqual({
    type: "codeBlock",
    attrs: { language: "ts" },
    content: [{ type: "text", text: "const x = 1;" }],
  });
  expect(roundTrip(md)).toBe(md);
});

test("fenced code block without a language", () => {
  const md = "```\nplain\n```";
  const [code] = blocks(md) as any[];
  expect(code.type).toBe("codeBlock");
  expect(code.attrs).toEqual({});
  expect(code.content).toEqual([{ type: "text", text: "plain" }]);
});

test("code-block content is not interpreted as markdown", () => {
  const md = "```\n# not a heading\n- not a list\n```";
  const [code] = blocks(md) as any[];
  expect(code.content[0].text).toBe("# not a heading\n- not a list");
});

// --- blockquote -------------------------------------------------------------

test("blockquote", () => {
  const md = "> quoted line";
  const [bq] = blocks(md) as any[];
  expect(bq.type).toBe("blockquote");
  expect(bq.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "quoted line" }] }]);
  expect(roundTrip(md)).toBe(md);
});

// --- horizontal rule --------------------------------------------------------

test("horizontal rule", () => {
  const [rule] = blocks("---") as any[];
  expect(rule).toEqual({ type: "rule" });
  expect(roundTrip("---")).toBe("---");
});

// --- tables -----------------------------------------------------------------

test("flat GFM table: header row uses tableHeader, body uses tableCell", () => {
  const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const [table] = blocks(md) as any[];
  expect(table.type).toBe("table");
  expect(table.content).toHaveLength(2); // header row + one body row

  const [headerRow, bodyRow] = table.content;
  expect(headerRow.content.map((c: any) => c.type)).toEqual(["tableHeader", "tableHeader"]);
  expect(bodyRow.content.map((c: any) => c.type)).toEqual(["tableCell", "tableCell"]);
  expect(headerRow.content[0].content).toEqual([
    { type: "paragraph", content: [{ type: "text", text: "A" }] },
  ]);

  expect(roundTrip(md)).toBe(md);
});

// --- graceful degradation ---------------------------------------------------

test("an unsupported construct degrades to a plain paragraph rather than throwing", () => {
  // image syntax is out of the supported subset; its text survives, no throw.
  const doc = markdownToAdf("![alt](http://img)") as any;
  expect(doc.type).toBe("doc");
  expect(JSON.stringify(doc)).not.toContain("undefined");
});

// --- issue 11 group B: no literal garbage, degrade-and-report ----------------

test("image syntax becomes a clean link, not a link plus a stray `!`", () => {
  const [p] = blocks("![logo](http://img/logo.png)") as any[];
  // exactly one text node, a clean link — no leading "!" text node.
  expect(p.content).toEqual([
    { type: "text", text: "logo", marks: [{ type: "link", attrs: { href: "http://img/logo.png" } }] },
  ]);
  // and it round-trips to a clean markdown link with no stray bang.
  expect(adfToMarkdown(markdownToAdf("![logo](http://img/logo.png)"))).toBe("[logo](http://img/logo.png)");
});

test("an image with no alt text falls back to its url as the link label", () => {
  const [p] = blocks("![](http://img/x.png)") as any[];
  expect(p.content).toEqual([
    { type: "text", text: "http://img/x.png", marks: [{ type: "link", attrs: { href: "http://img/x.png" } }] },
  ]);
});

test("an unterminated code fence does not swallow the rest of the body", () => {
  const md = "```js\nconst x = 1;\n\nA real paragraph after the missing close.";
  const out = adfToMarkdown(markdownToAdf(md));
  expect(out).toContain("A real paragraph after the missing close.");
});

// --- issue 11 group B: convertMarkdown degradation report --------------------

test("a fully-supported body reports no degradations", () => {
  const { degradations } = convertMarkdown("# Title\n\nSome **bold** text.\n\n- a\n- b");
  expect(degradations).toEqual([]);
});

test("an image reports a coarse `image` degradation", () => {
  const { degradations } = convertMarkdown("![logo](http://img/logo.png)");
  expect(degradations.map((d) => d.kind)).toContain("image");
});

test("task-list checkboxes report a degradation (flattened to plain items)", () => {
  const { degradations } = convertMarkdown("- [x] done\n- [ ] todo");
  expect(degradations.map((d) => d.kind)).toContain("task-list");
});

test("a nested (indented) list reports a `nested-list` degradation", () => {
  const { degradations } = convertMarkdown("- parent\n  - child");
  expect(degradations.map((d) => d.kind)).toContain("nested-list");
});

test("a table with column alignment reports an `table-alignment` degradation", () => {
  const { degradations } = convertMarkdown("| A | B |\n| :-- | --: |\n| 1 | 2 |");
  expect(degradations.map((d) => d.kind)).toContain("table-alignment");
});

test("an unterminated code fence reports a degradation", () => {
  const { degradations } = convertMarkdown("```js\nconst x = 1;\nno close here");
  expect(degradations.map((d) => d.kind)).toContain("unterminated-code-fence");
});

test("degradations are coarse — the same category fires at most once", () => {
  const { degradations } = convertMarkdown("![a](http://x/1) and ![b](http://x/2)");
  expect(degradations.filter((d) => d.kind === "image")).toHaveLength(1);
});

test("markdownToAdf stays a thin wrapper returning just the doc", () => {
  const doc = markdownToAdf("hello") as any;
  expect(doc.type).toBe("doc");
  expect(doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "hello" }] }]);
});

test("a mixed document round-trips", () => {
  const md = [
    "# Heading",
    "",
    "A paragraph with **bold**, *italic*, and `code`.",
    "",
    "- item one",
    "- item two",
    "",
    "> a quote",
    "",
    "```js",
    "return 42;",
    "```",
  ].join("\n");
  expect(roundTrip(md)).toBe(md);
});

// --- regression fixtures: the two real failing bodies (issue 20) ------------
//
// Both bodies below actually failed against JIRA with INVALID_INPUT. They are
// reconstructed from issue 20's recorded evidence (the originals were the
// reporter's local files, not committed) so they carry the EXACT poison
// constructs the issue documents: `**error `<p>`**` in the create description,
// and `**`error`**` spans in the PROJ-129 comment. Each must now convert to ADF
// with zero `code`+other-mark nodes, and the characters the reporters wrongly
// blamed (`<...>`, `&&`, `⚠️`, `→`, `—`) must survive as valid text.

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

test("regression: the create `description` fixture converts with no code+other-mark node", async () => {
  const md = await fixture("invalid-input-call.md");
  const nodes = allTextNodes(markdownToAdf(md));
  expect(nodes.some(hasCodePlusOtherMark)).toBe(false);
  // The `<p>` that used to carry strong+code is now code-only, and present.
  expect(nodes.some((n) => n.text === "<p>" && n.marks?.length === 1 && n.marks[0].type === "code")).toBe(true);
  // The chars the reporter wrongly blamed survive as plain text.
  const flat = nodes.map((n) => n.text).join("");
  expect(flat).toContain("<div>");
  expect(flat).toContain("&&");
});

// --- regression: sibling-span recursion is now iterative (issue) ------------
//
// parseInline used to recurse once per inline span on the tail of a line, so a
// line with tens of thousands of sibling spans overflowed the stack — breaking
// the module's documented never-throws contract. Sibling spans are now consumed
// with a loop; only genuine nesting recurses. These lines are far larger than
// anything real, sized to have blown the old recursion.

test("a line with 30k sibling inline spans converts without throwing", () => {
  const md = "*a* ".repeat(30000);
  let conv!: ReturnType<typeof convertMarkdown>;
  expect(() => { conv = convertMarkdown(md); }).not.toThrow();
  const [p] = conv.doc.content as any[];
  expect(p.type).toBe("paragraph");
  // First span is em "a", followed by the " " separator text — the exact shape
  // one `*a* ` unit produces, just repeated tens of thousands of times.
  expect(p.content[0]).toEqual({ type: "text", text: "a", marks: [{ type: "em" }] });
  expect(p.content[1]).toEqual({ type: "text", text: " " });
});

test("a link-heavy line with 30k sibling links converts without throwing", () => {
  const md = "[x](http://e) ".repeat(30000);
  let doc!: ReturnType<typeof markdownToAdf>;
  expect(() => { doc = markdownToAdf(md); }).not.toThrow();
  const [p] = (doc as any).content;
  expect(p.type).toBe("paragraph");
  expect(p.content[0]).toEqual({
    type: "text",
    text: "x",
    marks: [{ type: "link", attrs: { href: "http://e" } }],
  });
});

test("regression: the PROJ-129 comment fixture converts with no code+other-mark node", async () => {
  const md = await fixture("proj-129-failed-comment.md");
  const nodes = allTextNodes(markdownToAdf(md));
  expect(nodes.some(hasCodePlusOtherMark)).toBe(false);
  // Every "error" span is now code-only (was code+strong).
  const errors = nodes.filter((n) => n.text === "error");
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(e.marks).toEqual([{ type: "code" }]);
  // The non-ASCII chars were never the problem — they must remain valid text.
  const emoji = nodes.find((n) => n.text.includes("⚠️"));
  expect(emoji).toBeDefined();
  expect(emoji.marks ?? []).toEqual([]); // ⚠️ carries no marks
  const flat = nodes.map((n) => n.text).join("");
  expect(flat).toContain("→");
  expect(flat).toContain("—");
  // `items-end → items-start` stays inside a code span (arrow included).
  expect(nodes.some((n) => n.text.includes("items-end → items-start") && n.marks?.[0]?.type === "code")).toBe(true);
});
