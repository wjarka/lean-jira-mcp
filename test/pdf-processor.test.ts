/**
 * The real, unpdf-backed PDF text extractor — driven against PDFs synthesized
 * with pdf-lib so the extract path is proven without a live JIRA. This is the
 * offline suite's stand-in for the live-instance PDF smoke test (which only a
 * real fetch + extract can fully prove end-to-end).
 *
 * unpdf bundles a serverless build of Mozilla's pdf.js (pure JS, no native
 * binary) — the same npx/.mcpb-friendly constraint that put us on jimp over
 * sharp for images.
 */

import { test, expect } from "bun:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { unpdfProcessor } from "../src/lib/pdf-processor.ts";

/** A PDF with `pageCount` pages, each carrying identifiable text. */
async function textPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pageCount; p++) {
    const page = doc.addPage([320, 400]);
    page.drawText(`Heading for page ${p}`, { x: 40, y: 350, size: 16, font });
    page.drawText(`Body content on page ${p}.`, { x: 40, y: 320, size: 11, font });
  }
  return Buffer.from(await doc.save());
}

/** A PDF whose only content is a drawn shape — no text operators at all. */
async function imageOnlyPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.drawRectangle({ x: 10, y: 10, width: 180, height: 180, color: rgb(0.2, 0.4, 0.8) });
  return Buffer.from(await doc.save());
}

test("extracts per-page text with an accurate page count", async () => {
  const bytes = await textPdf(3);
  const out = await unpdfProcessor.extractText(bytes);

  expect(out.pageCount).toBe(3);
  expect(out.pages).toHaveLength(3);
  expect(out.pages[0]).toContain("Heading for page 1");
  expect(out.pages[0]).toContain("Body content on page 1.");
  expect(out.pages[1]).toContain("page 2");
  expect(out.pages[2]).toContain("page 3");
  // Per-page split is real — page 1's text doesn't bleed into page 2.
  expect(out.pages[0]).not.toContain("page 2");
});

test("a scanned/image-only PDF yields a page with no extractable text", async () => {
  const bytes = await imageOnlyPdf();
  const out = await unpdfProcessor.extractText(bytes);

  expect(out.pageCount).toBe(1);
  expect(out.pages).toHaveLength(1);
  expect((out.pages[0] ?? "").trim()).toBe("");
});

test("throws on bytes that aren't a decodable PDF (→ handler degrades visibly)", async () => {
  const notAPdf = Buffer.from("this is plainly not a pdf", "utf8");
  await expect(unpdfProcessor.extractText(notAPdf)).rejects.toBeDefined();
});
