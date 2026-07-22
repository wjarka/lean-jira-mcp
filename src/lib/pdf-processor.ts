/**
 * PDF text extractor — the PDF guardrail's decoder for `jira_read_attachment`
 * (issue 17, fast-follow to 16).
 *
 * MCP tool-result content is text / image / audio / embedded-resource — there is
 * no reliable cross-host PDF "document" block. So a PDF is read by extracting its
 * text server-side and returning it as TEXT, token/page-budgeted exactly like a
 * large text file (the page count + a `pageRange` continuation are the guardrail,
 * so a 200-page PDF comes back as a few-k-token slice, not the whole document).
 *
 * It sits behind an injectable {@link PdfProcessor} seam for the same two reasons
 * the image downscaler does:
 *   1. handler tests stay offline and deterministic with a fake processor (no
 *      real parse), exactly like the `IJiraClient` seam; and
 *   2. the real, unpdf-backed implementation gets its own direct unit test
 *      (extract per-page text from a generated PDF) without a live JIRA.
 *
 * unpdf bundles a SERVERLESS build of Mozilla's pdf.js — PURE JS, no native
 * binary — chosen on the same npx/.mcpb packaging constraint that put images on
 * jimp over sharp (a native, per-platform prebuilt is the classic bundle
 * failure). It is loaded LAZILY (dynamic import) so startup stays light and the
 * dependency is only touched when a PDF is actually read. A parse failure throws
 * and the tool degrades VISIBLY to a can't-extract note; a PDF that simply has no
 * text (scanned/image-only) returns empty page strings, which the handler turns
 * into a visible "no extractable text (likely a scanned PDF)" note. No OCR.
 */

export interface PdfExtractResult {
  /** Total number of pages in the document. */
  pageCount: number;
  /**
   * Per-page extracted text, index 0 = page 1. A page with no extractable text
   * (e.g. a scanned image) is an empty/whitespace string — never dropped, so the
   * page count and the array length always agree.
   */
  pages: string[];
}

export interface PdfProcessor {
  /**
   * Extract per-page text from PDF `data`. Throws when the bytes can't be parsed
   * as a PDF (the handler then degrades visibly to a can't-extract note).
   */
  extractText(data: Buffer): Promise<PdfExtractResult>;
}

/** The real, unpdf-backed processor used in production. */
export const unpdfProcessor: PdfProcessor = {
  async extractText(data) {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const proxy = await getDocumentProxy(new Uint8Array(data));
    // `mergePages:false` returns one string per page — the per-page split that
    // makes `pageRange` slicing (and scanned-page detection) exact.
    const { totalPages, text } = await extractText(proxy, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { pageCount: totalPages, pages };
  },
};
