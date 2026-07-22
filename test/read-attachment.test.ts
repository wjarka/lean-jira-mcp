/**
 * jira_read_attachment handler, driven end-to-end against the faked JiraClient
 * with an injected fake image processor (so the suite stays offline and
 * deterministic). Asserts on the content blocks + envelope the agent sees.
 *
 * Covers every acceptance criterion: image → image block (+ downscale note),
 * text → token-budgeted with offset continuation, oversize-text truncation,
 * unknown-type can't-inline note, the hard byte ceiling, image-bytes-never-in-a-
 * text-block, and the not-found recovery hint.
 */

import { test, expect } from "bun:test";
import {
  readAttachmentHandler,
  readAttachmentInputSchema,
  TEXT_BYTE_BUDGET,
  TEXT_TOKEN_BUDGET,
  type ReadAttachmentDeps,
} from "../src/tools/read-attachment.ts";
import type { ImageProcessor } from "../src/lib/image-processor.ts";
import type { PdfProcessor } from "../src/lib/pdf-processor.ts";
import { FakeJiraClient, makeAttachmentMeta } from "./helpers/fake-jira-client.ts";
import { JiraApiError } from "../src/lib/jira-client.ts";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * A fake image processor: no real decode. It reports the dims it's told, and
 * "downscales" by emitting a fixed small marker buffer when over `maxEdge`. Lets
 * the handler's content-block + note logic be tested without jimp.
 */
function fakeProcessor(opts: {
  width: number;
  height: number;
  /** Throw to simulate an undecodable image. */
  fail?: boolean;
  /** The bytes the "downscaled" result carries (default a tiny marker). */
  outBytes?: Buffer;
}): ImageProcessor {
  return {
    async downscale(input, maxEdge) {
      if (opts.fail) throw new Error("not an image");
      const longest = Math.max(opts.width, opts.height);
      if (longest <= maxEdge) {
        return {
          data: input.data,
          mimeType: input.mimeType,
          originalWidth: opts.width,
          originalHeight: opts.height,
          width: opts.width,
          height: opts.height,
          downscaled: false,
        };
      }
      const scale = maxEdge / longest;
      return {
        data: opts.outBytes ?? Buffer.from("DOWNSCALED"),
        mimeType: "image/jpeg",
        originalWidth: opts.width,
        originalHeight: opts.height,
        width: Math.round(opts.width * scale),
        height: Math.round(opts.height * scale),
        downscaled: true,
      };
    },
  };
}

/**
 * A fake PDF processor: no real parse. It returns the per-page text it's told,
 * so the handler's page-budget + pageRange + scanned-degrade logic is tested
 * without unpdf. Pass `fail` to simulate an undecodable PDF.
 */
function fakePdfProcessor(opts: { pages: string[]; fail?: boolean }): PdfProcessor {
  return {
    async extractText() {
      if (opts.fail) throw new Error("not a pdf");
      return { pageCount: opts.pages.length, pages: opts.pages };
    },
  };
}

function deps(over: Partial<ReadAttachmentDeps> = {}): ReadAttachmentDeps {
  return {
    maxBytes: MAX_BYTES,
    imageProcessor: fakeProcessor({ width: 800, height: 600 }),
    pdfProcessor: fakePdfProcessor({ pages: ["only page text"] }),
    ...over,
  };
}

async function run(jira: FakeJiraClient, raw: Record<string, unknown>, d: ReadAttachmentDeps) {
  const args = readAttachmentInputSchema.parse(raw);
  const result = await readAttachmentHandler(jira, args, d);
  return result;
}

/** The envelope is always content[0], parsed as JSON. */
function envelopeOf(result: { content: any[] }): any {
  const first = result.content[0];
  expect(first.type).toBe("text");
  return JSON.parse(first.text);
}

/** The deliverable blocks, typed loosely so tests can read image `data`/`mimeType`. */
function blocks(result: { content: any[] }): any[] {
  return result.content as any[];
}

/** The last (deliverable) text block's text — the file content, not the envelope. */
function deliverableText(result: { content: any[] }): string {
  return blocks(result).filter((c: any) => c.type === "text").pop().text;
}

/** Read a text attachment to the end, following `nextOffset`, returning each chunk's text. */
async function readAllTextChunks(jira: FakeJiraClient, id: string, d: ReadAttachmentDeps): Promise<string[]> {
  const chunks: string[] = [];
  let offset = 0;
  for (;;) {
    const result = await run(jira, { attachmentId: id, offset }, d);
    const env = envelopeOf(result);
    chunks.push(deliverableText(result));
    if (!env.truncated) break;
    offset = env.nextOffset;
  }
  return chunks;
}

// --- images -----------------------------------------------------------------

test("an oversize image returns an image content block with a visible downscale note", async () => {
  const meta = makeAttachmentMeta({
    id: "10042",
    filename: "screenshot.png",
    mimeType: "image/png",
    size: 12 * 1024 * 1024,
  });
  const jira = new FakeJiraClient()
    .setAttachmentMeta(meta)
    .setAttachmentContent(Buffer.from("RAW-PNG-BYTES"));

  const result = await run(jira, { attachmentId: "10042" }, deps({
    imageProcessor: fakeProcessor({ width: 4000, height: 3000 }),
  }));

  // The deliverable is a real image block — type "image", with data + mimeType.
  const imageBlock = blocks(result).find((c: any) => c.type === "image");
  expect(imageBlock).toBeDefined();
  expect(imageBlock.mimeType).toBe("image/jpeg");
  expect(typeof imageBlock.data).toBe("string");
  expect(imageBlock.data).toBe(Buffer.from("DOWNSCALED").toString("base64"));

  const env = envelopeOf(result);
  expect(env.downscaled).toBe(true);
  expect(env.dimensions).toEqual({ width: 1568, height: 1176 });
  // Visible note states original dimensions + size.
  expect(env.note).toContain("4000×3000");
  expect(env.note).toContain("1568×1176");
  expect(env.note).toContain("12.0 MB");
  expect(env.hints.length).toBeGreaterThan(0);
});

test("a small image is returned as-is in an image block, no downscale note", async () => {
  const meta = makeAttachmentMeta({ id: "1", filename: "icon.png", mimeType: "image/png", size: 4096 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("PNG"));

  const result = await run(jira, { attachmentId: "1" }, deps({
    imageProcessor: fakeProcessor({ width: 800, height: 600 }),
  }));

  const imageBlock = blocks(result).find((c: any) => c.type === "image");
  expect(imageBlock).toBeDefined();
  expect(imageBlock.data).toBe(Buffer.from("PNG").toString("base64"));
  const env = envelopeOf(result);
  expect(env.downscaled).toBe(false);
  expect(env.dimensions).toEqual({ width: 800, height: 600 });
});

test("image bytes appear ONLY in the image block, never in a text block", async () => {
  const rawBytes = Buffer.from("UNIQUE-IMAGE-PAYLOAD-9f8a7b");
  const meta = makeAttachmentMeta({ id: "1", filename: "p.png", mimeType: "image/png", size: 4096 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(rawBytes);

  const result = await run(jira, { attachmentId: "1" }, deps({
    imageProcessor: fakeProcessor({ width: 800, height: 600 }), // returned as-is
  }));

  const b64 = rawBytes.toString("base64");
  const imageBlock = blocks(result).find((c: any) => c.type === "image");
  expect(imageBlock.data).toBe(b64);
  // No text block may contain the base64 (or raw) image payload.
  for (const block of result.content) {
    if (block.type === "text") {
      expect(block.text).not.toContain(b64);
      expect(block.text).not.toContain("UNIQUE-IMAGE-PAYLOAD");
    }
  }
});

test("an undecodable image degrades visibly (can't-process note), never a raw original", async () => {
  const meta = makeAttachmentMeta({ id: "1", filename: "broken.png", mimeType: "image/png", size: 9999 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("garbage"));

  const result = await run(jira, { attachmentId: "1" }, deps({
    imageProcessor: fakeProcessor({ width: 0, height: 0, fail: true }),
  }));

  // No image block at all — degraded to metadata + note.
  expect(blocks(result).find((c: any) => c.type === "image")).toBeUndefined();
  const env = envelopeOf(result);
  expect(env.inlined).toBe(false);
  expect(env.note.toLowerCase()).toContain("couldn't be decoded");
  expect(env.downloadUrl).toContain("/attachment/content/1");
});

// --- text -------------------------------------------------------------------

test("a small text file returns its full text in a text block", async () => {
  const body = "line one\nline two\nline three\n";
  const meta = makeAttachmentMeta({ id: "5", filename: "notes.txt", mimeType: "text/plain", size: body.length });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from(body));

  const result = await run(jira, { attachmentId: "5" }, deps());

  const env = envelopeOf(result);
  expect(env.truncated).toBe(false);
  expect(env.bytes).toEqual({ offset: 0, end: body.length, total: body.length });
  // The deliverable text block carries the file content verbatim.
  const textBlocks = blocks(result).filter((c: any) => c.type === "text");
  expect(textBlocks[textBlocks.length - 1].text).toBe(body);
});

test("an oversize text file truncates with a visible marker and a continue offset", async () => {
  const total = TEXT_BYTE_BUDGET * 2 + 500;
  const body = "x".repeat(total);
  const meta = makeAttachmentMeta({ id: "6", filename: "big.log", mimeType: "text/plain", size: total });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from(body));

  const first = await run(jira, { attachmentId: "6" }, deps());
  const env1 = envelopeOf(first);
  expect(env1.truncated).toBe(true);
  expect(env1.bytes).toEqual({ offset: 0, end: TEXT_BYTE_BUDGET, total });
  expect(env1.nextOffset).toBe(TEXT_BYTE_BUDGET);
  expect(env1.note).toContain("truncated");
  expect(env1.note).toContain(`offset=${TEXT_BYTE_BUDGET}`);
  const firstText = blocks(first).filter((c: any) => c.type === "text").pop().text;
  expect(firstText.length).toBe(TEXT_BYTE_BUDGET);

  // Continue from the returned offset.
  const second = await run(jira, { attachmentId: "6", offset: TEXT_BYTE_BUDGET }, deps());
  const env2 = envelopeOf(second);
  expect(env2.bytes.offset).toBe(TEXT_BYTE_BUDGET);
  expect(env2.bytes.end).toBe(TEXT_BYTE_BUDGET * 2);
  expect(env2.truncated).toBe(true);
  expect(env2.nextOffset).toBe(TEXT_BYTE_BUDGET * 2);

  // Final chunk: no more truncation.
  const third = await run(jira, { attachmentId: "6", offset: TEXT_BYTE_BUDGET * 2 }, deps());
  const env3 = envelopeOf(third);
  expect(env3.truncated).toBe(false);
  expect(env3.bytes.end).toBe(total);
});

test("a multibyte char split across the byte budget is not corrupted (no U+FFFD; chunks rejoin exactly)", async () => {
  // Each char straddles the budget boundary: some of its bytes fall in chunk 1
  // and the rest in chunk 2. A byte-count slice would decode U+FFFD at BOTH ends
  // and lose the char; the boundary adjustment must move the cut so the NEXT
  // chunk decodes it whole.
  for (const [id, char] of [["20", "😀"], ["21", "世"]] as const) {
    // Place the char so it starts 2 bytes before the boundary — its lead byte(s)
    // land in chunk 1 and its tail in chunk 2, guaranteeing a straddle.
    const body = "a".repeat(TEXT_BYTE_BUDGET - 2) + char + "b".repeat(50);
    const size = Buffer.byteLength(body, "utf-8");
    const meta = makeAttachmentMeta({ id, filename: "utf8.txt", mimeType: "text/plain", size });
    const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from(body, "utf-8"));

    const chunks = await readAllTextChunks(jira, id, deps());
    expect(chunks.length).toBeGreaterThan(1); // it really did split
    for (const c of chunks) expect(c).not.toContain("�"); // no replacement char in EITHER chunk
    expect(chunks.join("")).toBe(body); // concatenating the chunks reproduces the original exactly
  }
});

test("a char ending exactly at the byte budget is kept whole (no needless trim)", async () => {
  // The emoji's last byte is the last byte of chunk 1 — a complete char at the
  // exact edge. The window must NOT be shrunk: the boundary is already valid.
  const body = "a".repeat(TEXT_BYTE_BUDGET - 4) + "😀" + "b".repeat(50);
  const size = Buffer.byteLength(body, "utf-8");
  const meta = makeAttachmentMeta({ id: "22", filename: "edge.txt", mimeType: "text/plain", size });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from(body, "utf-8"));

  const first = await run(jira, { attachmentId: "22" }, deps());
  const env1 = envelopeOf(first);
  // Not trimmed: the cut stays at the full budget, and the emoji is intact here.
  expect(env1.bytes.end).toBe(TEXT_BYTE_BUDGET);
  expect(env1.nextOffset).toBe(TEXT_BYTE_BUDGET);
  const firstText = deliverableText(first);
  expect(firstText).not.toContain("�");
  expect(firstText.endsWith("😀")).toBe(true);
});

test("structured-data and octet-stream-with-extension files take the text path", async () => {
  const body = '{"hello":"world"}';
  const meta = makeAttachmentMeta({ id: "7", filename: "data.json", mimeType: "application/json", size: body.length });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from(body));
  const result = await run(jira, { attachmentId: "7" }, deps());
  const last = blocks(result).filter((c: any) => c.type === "text").pop();
  expect(last.text).toBe(body);
});

// --- PDF text extraction (issue 17) -----------------------------------------

/** A page of `chars` identifiable characters (so token-budget math is exact). */
function pageOf(label: string, chars: number): string {
  return `${label} ` + "x".repeat(Math.max(0, chars - label.length - 1));
}

test("a PDF returns server-extracted text with a visible (extracted text) note", async () => {
  const meta = makeAttachmentMeta({ id: "8", filename: "spec.pdf", mimeType: "application/pdf", size: 2 * 1024 * 1024 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF-bytes"));

  const result = await run(jira, { attachmentId: "8" }, deps({
    pdfProcessor: fakePdfProcessor({ pages: ["Intro heading\nFirst page body.", "Second page body."] }),
  }));

  const env = envelopeOf(result);
  expect(env.inlined).toBe(true);
  expect(env.kind).toBe("pdf");
  expect(env.pages).toEqual({ shown: { start: 1, end: 2 }, total: 2 });
  expect(env.truncated).toBe(false);
  expect(env.note).toContain("extracted text from PDF");
  expect(env.note).toContain("layout/images omitted");
  // The deliverable text block carries the extracted text (both pages).
  const text = blocks(result).filter((c: any) => c.type === "text").pop().text;
  expect(text).toContain("First page body.");
  expect(text).toContain("Second page body.");
  // The content WAS fetched this time (unlike office/unknown types).
  expect(jira.getAttachmentContentCalls).toHaveLength(1);
});

test("a large PDF is page-budgeted and pageRange continues where it left off", async () => {
  // 5 pages, each ~1500 tokens — only ~2 fit per read under the token budget.
  const perPage = TEXT_TOKEN_BUDGET * 4 - 200; // chars; ~ (budget-50) tokens each
  const pages = [1, 2, 3, 4, 5].map((p) => pageOf(`PAGE${p}`, Math.floor(perPage / 2.5)));
  const meta = makeAttachmentMeta({ id: "9", filename: "big.pdf", mimeType: "application/pdf", size: 9 * 1024 * 1024 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));
  const d = deps({ pdfProcessor: fakePdfProcessor({ pages }) });

  // First read: starts at page 1, truncates before blowing the budget.
  const first = await run(jira, { attachmentId: "9" }, d);
  const env1 = envelopeOf(first);
  expect(env1.pages.shown.start).toBe(1);
  expect(env1.pages.total).toBe(5);
  expect(env1.truncated).toBe(true);
  const lastShown = env1.pages.shown.end;
  expect(lastShown).toBeLessThan(5);
  expect(env1.nextPageRange).toBe(`${lastShown + 1}-`);
  expect(env1.note).toContain("pageRange");
  const text1 = blocks(first).filter((c: any) => c.type === "text").pop().text;
  expect(text1).toContain("PAGE1");
  expect(text1).not.toContain(`PAGE${lastShown + 1}`); // the next page is NOT included

  // Continue from the returned pageRange.
  const second = await run(jira, { attachmentId: "9", pageRange: env1.nextPageRange }, d);
  const env2 = envelopeOf(second);
  expect(env2.pages.shown.start).toBe(lastShown + 1);
  const text2 = blocks(second).filter((c: any) => c.type === "text").pop().text;
  expect(text2).toContain(`PAGE${lastShown + 1}`);
  expect(text2).not.toContain("PAGE1"); // earlier pages are not re-served
});

test("an explicit pageRange end is honored (a bounded slice of the document)", async () => {
  const pages = ["page one", "page two", "page three", "page four"];
  const meta = makeAttachmentMeta({ id: "11", filename: "doc.pdf", mimeType: "application/pdf", size: 4096 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));

  const result = await run(jira, { attachmentId: "11", pageRange: "2-3" }, deps({
    pdfProcessor: fakePdfProcessor({ pages }),
  }));

  const env = envelopeOf(result);
  expect(env.pages.shown).toEqual({ start: 2, end: 3 });
  const text = blocks(result).filter((c: any) => c.type === "text").pop().text;
  expect(text).toContain("page two");
  expect(text).toContain("page three");
  expect(text).not.toContain("page one");
  expect(text).not.toContain("page four");
});

test("a scanned/image-only PDF degrades visibly — no extractable text + download URL", async () => {
  const meta = makeAttachmentMeta({ id: "12", filename: "scan.pdf", mimeType: "application/pdf", size: 5 * 1024 * 1024 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));

  const result = await run(jira, { attachmentId: "12" }, deps({
    pdfProcessor: fakePdfProcessor({ pages: ["", "   ", "\n"] }),
  }));

  const env = envelopeOf(result);
  expect(env.inlined).toBe(false);
  expect(env.note.toLowerCase()).toContain("no extractable text");
  expect(env.note.toLowerCase()).toContain("scanned");
  expect(env.downloadUrl).toContain("/attachment/content/12");
  // Never silent/empty — just the envelope, no empty text deliverable.
  expect(result.content).toHaveLength(1);
});

test("an undecodable PDF degrades visibly (can't-extract note), never silent", async () => {
  const meta = makeAttachmentMeta({ id: "13", filename: "corrupt.pdf", mimeType: "application/pdf", size: 1024 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("garbage"));

  const result = await run(jira, { attachmentId: "13" }, deps({
    pdfProcessor: fakePdfProcessor({ pages: [], fail: true }),
  }));

  const env = envelopeOf(result);
  expect(env.inlined).toBe(false);
  expect(env.note.toLowerCase()).toContain("couldn't");
  expect(env.downloadUrl).toContain("/attachment/content/13");
});

test("a bounded pageRange preserves its end bound across truncation", async () => {
  // 4 pages, each alone over the token budget → only one page fits per read.
  const huge = pageOf("P", TEXT_TOKEN_BUDGET * 4 + 100);
  const pages = ["p1", huge, huge, huge].map((t, i) => (i === 0 ? t : `PAGE${i + 1} ${t}`));
  const meta = makeAttachmentMeta({ id: "15", filename: "bounded.pdf", mimeType: "application/pdf", size: 9 * 1024 * 1024 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));
  const d = deps({ pdfProcessor: fakePdfProcessor({ pages }) });

  // Request pages 2–4; only page 2 fits. Continuation must stay bounded at 4.
  const first = await run(jira, { attachmentId: "15", pageRange: "2-4" }, d);
  const env1 = envelopeOf(first);
  expect(env1.pages.shown).toEqual({ start: 2, end: 2 });
  expect(env1.truncated).toBe(true);
  expect(env1.nextPageRange).toBe("3-4"); // NOT "3-" — the upper bound survives

  const second = await run(jira, { attachmentId: "15", pageRange: env1.nextPageRange }, d);
  const env2 = envelopeOf(second);
  expect(env2.pages.shown).toEqual({ start: 3, end: 3 });
  expect(env2.nextPageRange).toBe("4-4");
});

test("a PDF over the byte ceiling is refused before download, like any other type", async () => {
  const meta = makeAttachmentMeta({
    id: "16",
    filename: "giant.pdf",
    mimeType: "application/pdf",
    size: 40 * 1024 * 1024,
  });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));

  const result = await run(jira, { attachmentId: "16" }, deps({ maxBytes: 25 * 1024 * 1024 }));

  const env = envelopeOf(result);
  expect(env.refused).toBe(true);
  expect(env.note).toContain("exceeds");
  // The ceiling gates PDFs before any fetch or extraction — same as images.
  expect(jira.getAttachmentContentCalls).toHaveLength(0);
  expect(result.content).toHaveLength(1);
});

test("a pageRange past the last page reports it (never a silent empty slice)", async () => {
  const meta = makeAttachmentMeta({ id: "14", filename: "short.pdf", mimeType: "application/pdf", size: 4096 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("%PDF"));

  const result = await run(jira, { attachmentId: "14", pageRange: "9-" }, deps({
    pdfProcessor: fakePdfProcessor({ pages: ["a", "b"] }),
  }));

  const env = envelopeOf(result);
  expect(env.note.toLowerCase()).toContain("past");
  expect(env.note).toContain("2"); // names the real page count
});

// --- non-inlinable ----------------------------------------------------------

test("an unknown binary degrades the same way (never silent or empty)", async () => {
  const meta = makeAttachmentMeta({ id: "9", filename: "blob.bin", mimeType: "application/octet-stream", size: 1234 });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("..."));
  const result = await run(jira, { attachmentId: "9" }, deps());
  const env = envelopeOf(result);
  expect(env.inlined).toBe(false);
  expect(env.note).toContain("can't inline application/octet-stream");
  expect(jira.getAttachmentContentCalls).toHaveLength(0);
});

// --- byte ceiling -----------------------------------------------------------

test("a file over the hard byte ceiling is refused before download, with a hint + URL", async () => {
  const meta = makeAttachmentMeta({
    id: "10",
    filename: "huge.png",
    mimeType: "image/png",
    size: 40 * 1024 * 1024,
  });
  const jira = new FakeJiraClient().setAttachmentMeta(meta).setAttachmentContent(Buffer.from("X"));

  const result = await run(jira, { attachmentId: "10" }, deps({ maxBytes: 25 * 1024 * 1024 }));

  const env = envelopeOf(result);
  expect(env.refused).toBe(true);
  expect(env.note).toContain("exceeds");
  expect(env.note).toContain("25.0 MB");
  expect(env.downloadUrl).toContain("/attachment/content/10");
  expect(env.hints.join(" ")).toContain("/attachment/content/10");
  // The whole point: NOT fetched.
  expect(jira.getAttachmentContentCalls).toHaveLength(0);
  // No image/text deliverable.
  expect(result.content).toHaveLength(1);
});

// --- errors -----------------------------------------------------------------

test("a missing attachment returns a not-found recovery hint pointing at get_issue", async () => {
  const jira = new FakeJiraClient().setGetAttachmentMetaError(
    new JiraApiError(404, ["The attachment with id does not exist."], {}),
  );
  const result = await run(jira, { attachmentId: "404" }, deps());
  expect(result.isError).toBe(true);
  const env = envelopeOf(result);
  expect(env.error.code).toBe("attachment_not_found");
  expect(env.hints.join(" ")).toContain("jira_get_issue");
});

test("there is no batch form — the schema accepts a single id only", () => {
  // A single string id parses; the schema has no array/multi-id shape.
  expect(readAttachmentInputSchema.parse({ attachmentId: "1" }).attachmentId).toBe("1");
  expect(() => readAttachmentInputSchema.parse({ attachmentId: ["1", "2"] })).toThrow();
});

test("pageRange validation enforces 1-based pages (rejects 0, accepts the documented forms)", () => {
  const ok = (pr: string) =>
    expect(readAttachmentInputSchema.parse({ attachmentId: "1", pageRange: pr }).pageRange).toBe(pr);
  ok("5");
  ok("5-");
  ok("5-12");
  // 0 is not a 1-based page — rejected at validation, never silently clamped to 1.
  for (const bad of ["0", "0-5", "5-0", "00", "-5", "abc", "5-3-2"]) {
    expect(() => readAttachmentInputSchema.parse({ attachmentId: "1", pageRange: bad })).toThrow();
  }
});
