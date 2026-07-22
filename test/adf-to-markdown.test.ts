/**
 * Direct unit tests for the ADF→markdown converter (read direction).
 *
 * One test per supported construct (the issue's acceptance criterion), plus
 * graceful degradation of unsupported nodes. These are pure-function tests:
 * canned ADF in, markdown out — no JIRA, no handler.
 */

import { test, expect } from "bun:test";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";

/** Minimal ADF doc wrapper around a list of block nodes. */
function doc(...content: unknown[]) {
  return { type: "doc", version: 1, content };
}
function para(...content: unknown[]) {
  return { type: "paragraph", content };
}
function text(value: string, marks?: unknown[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

test("plain paragraph", () => {
  expect(adfToMarkdown(doc(para(text("Hello world"))))).toBe("Hello world");
});

test("multiple paragraphs are separated by a blank line", () => {
  const md = adfToMarkdown(doc(para(text("First")), para(text("Second"))));
  expect(md).toBe("First\n\nSecond");
});

test("headings render with the right number of hashes", () => {
  const md = adfToMarkdown(
    doc(
      { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
      { type: "heading", attrs: { level: 3 }, content: [text("Sub")] },
    ),
  );
  expect(md).toBe("# Title\n\n### Sub");
});

test("bold and italic marks", () => {
  const md = adfToMarkdown(
    doc(para(text("a "), text("bold", [{ type: "strong" }]), text(" and "), text("em", [{ type: "em" }]))),
  );
  expect(md).toBe("a **bold** and *em*");
});

test("strikethrough mark", () => {
  const md = adfToMarkdown(doc(para(text("gone", [{ type: "strike" }]))));
  expect(md).toBe("~~gone~~");
});

test("inline code mark", () => {
  const md = adfToMarkdown(doc(para(text("call "), text("foo()", [{ type: "code" }]))));
  expect(md).toBe("call `foo()`");
});

test("inline code wins over formatting marks (no nested asterisks inside backticks)", () => {
  const md = adfToMarkdown(doc(para(text("x", [{ type: "code" }, { type: "strong" }]))));
  expect(md).toBe("`x`");
});

test("link mark wraps the text", () => {
  const md = adfToMarkdown(
    doc(para(text("see ", undefined), text("docs", [{ type: "link", attrs: { href: "https://x.dev" } }]))),
  );
  expect(md).toBe("see [docs](https://x.dev)");
});

test("bullet list", () => {
  const md = adfToMarkdown(
    doc({
      type: "bulletList",
      content: [
        { type: "listItem", content: [para(text("one"))] },
        { type: "listItem", content: [para(text("two"))] },
      ],
    }),
  );
  expect(md).toBe("- one\n- two");
});

test("ordered list", () => {
  const md = adfToMarkdown(
    doc({
      type: "orderedList",
      content: [
        { type: "listItem", content: [para(text("first"))] },
        { type: "listItem", content: [para(text("second"))] },
      ],
    }),
  );
  expect(md).toBe("1. first\n2. second");
});

test("nested list is indented", () => {
  const md = adfToMarkdown(
    doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para(text("parent")),
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [para(text("child"))] }],
            },
          ],
        },
      ],
    }),
  );
  expect(md).toBe("- parent\n  - child");
});

test("code block carries its language fence", () => {
  const md = adfToMarkdown(
    doc({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [text("const a = 1;")],
    }),
  );
  expect(md).toBe("```typescript\nconst a = 1;\n```");
});

test("code block without a language still fences", () => {
  const md = adfToMarkdown(doc({ type: "codeBlock", content: [text("plain")] }));
  expect(md).toBe("```\nplain\n```");
});

test("blockquote prefixes each line", () => {
  const md = adfToMarkdown(
    doc({ type: "blockquote", content: [para(text("quoted line"))] }),
  );
  expect(md).toBe("> quoted line");
});

test("horizontal rule", () => {
  const md = adfToMarkdown(doc({ type: "rule" }));
  expect(md).toBe("---");
});

test("flat table renders as GFM with a header separator", () => {
  const cell = (s: string, type = "tableCell") => ({ type, content: [para(text(s))] });
  const md = adfToMarkdown(
    doc({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("H1", "tableHeader"), cell("H2", "tableHeader")] },
        { type: "tableRow", content: [cell("a"), cell("b")] },
        { type: "tableRow", content: [cell("c"), cell("d")] },
      ],
    }),
  );
  expect(md).toBe("| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |");
});

test("hardBreak becomes a newline within a paragraph", () => {
  const md = adfToMarkdown(doc(para(text("line1"), { type: "hardBreak" }, text("line2"))));
  expect(md).toBe("line1\nline2");
});

test("unsupported inline node (mention) degrades to its text", () => {
  const md = adfToMarkdown(
    doc(para(text("ping "), { type: "mention", attrs: { text: "@jane", id: "acc-1" } })),
  );
  expect(md).toBe("ping @jane");
});

test("unsupported block node degrades by recursing into its content", () => {
  // A panel is not a first-class construct; its inner text must still survive.
  const md = adfToMarkdown(
    doc({ type: "panel", attrs: { panelType: "info" }, content: [para(text("note body"))] }),
  );
  expect(md).toContain("note body");
});

test("media node degrades without throwing and emits no raw ADF", () => {
  const md = adfToMarkdown(
    doc(
      para(text("before")),
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x", type: "file" } }] },
      para(text("after")),
    ),
  );
  expect(md).toContain("before");
  expect(md).toContain("after");
  expect(md).not.toContain("mediaSingle");
});

test("non-ADF / empty input yields an empty string", () => {
  expect(adfToMarkdown(null)).toBe("");
  expect(adfToMarkdown(undefined)).toBe("");
  expect(adfToMarkdown("just a string")).toBe("");
  expect(adfToMarkdown({ type: "doc", content: [] })).toBe("");
});

test("emoji degrades to its text representation", () => {
  const md = adfToMarkdown(
    doc(para(text("done "), { type: "emoji", attrs: { shortName: ":check:", text: "✅" } })),
  );
  expect(md).toBe("done ✅");
});

// --- issue 11 group A: visible markers instead of silent "" -----------------

test("a media node with a filename surfaces a visible [image: …] marker, not an empty string", () => {
  const md = adfToMarkdown(
    doc({
      type: "mediaSingle",
      content: [{ type: "media", attrs: { id: "x", type: "file", alt: "screenshot.png" } }],
    }),
  );
  expect(md).toBe("[image: screenshot.png]");
  expect(md).not.toBe("");
});

test("a media node with no filename/alt still emits a bare [image] marker", () => {
  const md = adfToMarkdown(
    doc({ type: "mediaGroup", content: [{ type: "media", attrs: { id: "y", type: "file" } }] }),
  );
  expect(md).toBe("[image]");
});

test("a status lozenge surfaces its text", () => {
  const md = adfToMarkdown(doc(para(text("state "), { type: "status", attrs: { text: "DONE", color: "green" } })));
  expect(md).toContain("DONE");
  expect(md).not.toBe("state ");
});

test("a date node surfaces its value rather than vanishing", () => {
  // 2021-01-01T00:00:00Z in epoch millis.
  const md = adfToMarkdown(doc(para(text("due "), { type: "date", attrs: { timestamp: "1609459200000" } })));
  expect(md).toContain("2021-01-01");
});

test("a malformed/out-of-range date timestamp degrades to a [date] marker, never throwing or vanishing", () => {
  // 1e300 ms is finite but far outside the representable Date range → toISOString throws.
  expect(() =>
    adfToMarkdown(doc(para({ type: "date", attrs: { timestamp: 1e300 } }))),
  ).not.toThrow();
  expect(adfToMarkdown(doc(para({ type: "date", attrs: { timestamp: 1e300 } })))).toBe("[date]");
  expect(adfToMarkdown(doc(para({ type: "date", attrs: {} })))).toBe("[date]");
});

test("a taskList renders real markdown checkboxes with state", () => {
  const md = adfToMarkdown(
    doc({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { state: "DONE" }, content: [text("ship it")] },
        { type: "taskItem", attrs: { state: "TODO" }, content: [text("write docs")] },
      ],
    }),
  );
  expect(md).toBe("- [x] ship it\n- [ ] write docs");
});

test("a panel keeps both its text and its type", () => {
  const md = adfToMarkdown(
    doc({ type: "panel", attrs: { panelType: "warning" }, content: [para(text("heads up"))] }),
  );
  expect(md).toContain("heads up");
  expect(md).toContain("[panel: warning]");
});

test("a url-less inline card surfaces its title/text rather than an empty string", () => {
  const md = adfToMarkdown(
    doc(para(text("see "), { type: "inlineCard", attrs: { data: {}, title: "Design doc" } })),
  );
  expect(md).toContain("Design doc");
  expect(md).not.toBe("see ");
});

test("an inline card WITH a url still renders the url", () => {
  const md = adfToMarkdown(
    doc(para({ type: "inlineCard", attrs: { url: "https://x.dev/page" } })),
  );
  expect(md).toBe("https://x.dev/page");
});
