/**
 * jira_read_attachment — the 9th tool: read ONE attachment's content by id.
 *
 * Earns a tool on the `get_comments` precedent: a distinct binary access pattern
 * that returns CONTENT BLOCKS (an `image` block, or text), not a structured
 * object, and is never wanted inline by default. Discovery rides `get_issue`
 * (filename/mimeType/size), so a read here is already a deliberate, sized choice.
 *
 * Triple-lock size/token guardrails (a naive "stream whatever JIRA returns" would
 * torch the context window):
 *   1. ONE attachment id per call — no batch form exists, by construction.
 *   2. server-side caps regardless of the agent's choice — images are downscaled
 *      (dimensions, not bytes, drive image token cost), text is byte/token-
 *      budgeted with an `offset` to continue.
 *   3. an optional HARD byte ceiling — a file over it is refused BEFORE download
 *      (metadata is read first, so `size` gates the fetch), returning a note +
 *      the download URL rather than pulling pathological bytes.
 *
 * Per-type policy degrades VISIBLY throughout (PRD content-fidelity contract):
 *   - image → a native MCP `image` content block (NEVER a text block — base64 in
 *     a text block is tokenized; an image block is dimension-costed), downscaled
 *     to ≤ ~1568px longest edge with a visible note when downscaled. A decode
 *     failure degrades to a can't-process note, never a raw multi-MB original.
 *   - text-ish → text, token/byte-budgeted; an oversize file truncates with a
 *     visible marker and an `offset` to continue. Never silent.
 *   - PDF → server-extracted text, page-budgeted with a `pageRange` to continue
 *     (issue 17). A scanned/image-only PDF degrades to a visible "no extractable
 *     text" note; a parse failure to a can't-extract note. Never empty.
 *   - office / unknown → metadata + a visible "can't inline <type> (<size>);
 *     download at <url>" note, no content fetched. Never empty.
 *
 * Read-only: no upload/write path here. The handler is exported separately from
 * registration so tests drive it end-to-end against a faked JiraClient.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  type IJiraClient,
  type JiraAttachmentMeta,
} from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { classifyAttachment, formatBytes } from "../lib/attachments.ts";
import { jimpImageProcessor, type ImageProcessor } from "../lib/image-processor.ts";
import { unpdfProcessor, type PdfProcessor } from "../lib/pdf-processor.ts";
import { CHARS_PER_TOKEN, estimateTokens, packUntilBudget } from "../lib/text-budget.ts";

/** Longest-edge cap for downscaled images (dimensions drive image token cost). */
export const DEFAULT_MAX_IMAGE_EDGE = 1568;
/** Per-read token target, matching get_comments' ~3.5k-token page discipline. */
export const TEXT_TOKEN_BUDGET = 3500;
/**
 * Byte window for a single text read — the token target expressed in bytes (via
 * the shared chars/token ratio) so the `offset` arithmetic that continues a
 * large file is exact, and the budget tracks the rest of the server's.
 */
export const TEXT_BYTE_BUDGET = TEXT_TOKEN_BUDGET * CHARS_PER_TOKEN;

export interface ReadAttachmentDeps {
  /** Hard byte ceiling — a file larger than this is refused before download. */
  maxBytes: number;
  /** Longest-edge cap for downscaled images. Defaults to {@link DEFAULT_MAX_IMAGE_EDGE}. */
  maxImageEdge?: number;
  /** The image downscaler seam (injected so handler tests stay offline). */
  imageProcessor: ImageProcessor;
  /** The PDF text-extractor seam (injected so handler tests stay offline). */
  pdfProcessor: PdfProcessor;
}

/** Parsed `pageRange`: 1-based start, optional inclusive end (open = to the last page). */
interface PageRange {
  start: number;
  end?: number;
}

/** Parse a validated `pageRange` string (`"5"`, `"5-12"`, `"5-"`) into 1-based bounds.
 *  The input shape is already enforced by the schema regex (start ≥ 1, digits only). */
function parsePageRange(raw: string | undefined): PageRange {
  if (!raw) return { start: 1 };
  const [startStr, endStr] = raw.split("-");
  const start = Number(startStr);
  // Bare "5" and open "5-" both read from page 5 onward (budget-capped), like
  // text `offset`. Only an explicit "5-12" bounds the upper page (clamped ≥ start).
  if (!endStr) return { start };
  return { start, end: Math.max(start, Number(endStr)) };
}

export const readAttachmentInputShape = {
  attachmentId: z
    .string()
    .min(1)
    .describe(
      "The id of the ONE attachment to read (from a `jira_get_issue` `detail:\"full\"` attachment " +
        "list). Exactly one id per call — there is no batch form.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset to continue reading a TEXT attachment from. Use the `nextOffset` a previous, " +
        "truncated read returned to fetch the next chunk. Ignored for images and non-inlinable files.",
    ),
  pageRange: z
    .string()
    .regex(
      /^[1-9]\d*(-([1-9]\d*)?)?$/,
      'pageRange must look like "5", "5-12", or "5-" — 1-based pages, starting at 1.',
    )
    .optional()
    .describe(
      "Which pages of a PDF to extract text from (1-based): `\"5\"` or `\"5-\"` reads from page 5 " +
        "onward, `\"5-12\"` a bounded slice. Use the `nextPageRange` a previous, truncated PDF read " +
        "returned to continue. The per-read token budget still caps the output. PDF-only.",
    ),
};

export const readAttachmentInputSchema = z.object(readAttachmentInputShape);
export type ReadAttachmentArgs = z.infer<typeof readAttachmentInputSchema>;

export const READ_ATTACHMENT_DESCRIPTION =
  "Read ONE attachment by id (find ids via `jira_get_issue` `detail:\"full\"`). Returns content " +
  "blocks, not a structured object: an image comes back as a viewable (server-downscaled) image " +
  "block, a text/log/json/csv file as token-budgeted text (use `offset` to continue a large one), " +
  "a PDF as server-extracted text, page-budgeted (use `pageRange` to continue a long one), and an " +
  "office/unknown file as metadata + a visible can't-inline note with its download URL. " +
  "One id per call; read-only.";

/** A compact, base64-free metadata echo for the response envelope. */
function metaEcho(meta: JiraAttachmentMeta) {
  return {
    id: meta.id,
    filename: meta.filename,
    mimeType: meta.mimeType,
    size: meta.size,
    ...(meta.created ? { created: meta.created } : {}),
    ...(meta.author ? { author: meta.author } : {}),
  };
}

/** The download phrase for a can't-inline note — names the URL when JIRA gave one. */
function downloadClause(meta: JiraAttachmentMeta): string {
  return meta.contentUrl ? `download at ${meta.contentUrl}` : "download it from JIRA";
}

/**
 * Build the tool result: content[0] is ALWAYS a JSON envelope text block
 * (`{attachment, …, hints}`) — never carrying image bytes — and an optional
 * deliverable block (image, or the file's text) follows it. Keeping the envelope
 * first and base64-free is what guarantees image bytes only ever live in an
 * `image` block.
 */
function attachmentResult(
  meta: JiraAttachmentMeta,
  envelope: Record<string, unknown>,
  hints: string[],
  deliverable?: CallToolResult["content"][number],
): CallToolResult {
  // Reuse the canonical success envelope (so hints + JSON shaping stay in one
  // place), then append the deliverable block after it.
  const base = shapeSuccess({ attachment: metaEcho(meta), ...envelope }, hints);
  if (deliverable) base.content.push(deliverable);
  return base;
}

export async function readAttachmentHandler(
  jira: IJiraClient,
  args: ReadAttachmentArgs,
  deps: ReadAttachmentDeps,
): Promise<CallToolResult> {
  const maxEdge = deps.maxImageEdge ?? DEFAULT_MAX_IMAGE_EDGE;

  // 1. Metadata FIRST — size/mime drive the read decision and the byte ceiling,
  //    so a pathological file is gated before a single content byte is fetched.
  let meta: JiraAttachmentMeta;
  try {
    meta = await jira.getAttachmentMeta(args.attachmentId);
  } catch (err) {
    return metaError(args.attachmentId, err);
  }

  // 2. Hard byte ceiling — refuse to download an over-ceiling file (guardrail 3).
  if (meta.size > deps.maxBytes) {
    const note =
      `can't inline ${meta.filename} — ${formatBytes(meta.size)} exceeds the ` +
      `${formatBytes(deps.maxBytes)} limit; ${downloadClause(meta)}.`;
    return attachmentResult(
      meta,
      { refused: true, note, downloadUrl: meta.contentUrl ?? null },
      [
        `Not downloaded: ${meta.filename} (${formatBytes(meta.size)}) is over the configured ` +
          `${formatBytes(deps.maxBytes)} ceiling. ${meta.contentUrl ? `Download it directly at ${meta.contentUrl}.` : "Download it from JIRA directly."}`,
      ],
    );
  }

  const kind = classifyAttachment(meta.mimeType, meta.filename);

  // 3. Non-inlinable (office/unknown): metadata + a visible can't-inline note.
  //    No content is fetched — there is nothing to render. (PDF is handled below.)
  if (kind === "other") {
    const note = `can't inline ${meta.mimeType} (${formatBytes(meta.size)}); ${downloadClause(meta)}.`;
    return attachmentResult(
      meta,
      { inlined: false, note, downloadUrl: meta.contentUrl ?? null },
      [
        `\`${meta.mimeType}\` can't be shown inline. ` +
          `${meta.contentUrl ? `Download ${meta.filename} at ${meta.contentUrl}.` : `Download ${meta.filename} from JIRA.`}`,
      ],
    );
  }

  // 4. Fetch the bytes (under the ceiling, an inlinable kind).
  let bytes: Buffer;
  try {
    bytes = await jira.getAttachmentContent(args.attachmentId);
  } catch (err) {
    return metaError(args.attachmentId, err);
  }

  if (kind === "image") {
    return imageResult(meta, bytes, maxEdge, deps.imageProcessor);
  }
  if (kind === "pdf") {
    return pdfResult(meta, bytes, parsePageRange(args.pageRange), deps.pdfProcessor);
  }
  return textResult(meta, bytes, args.offset ?? 0);
}

/**
 * Image path: downscale (the image guardrail), then return a native `image`
 * content block + a base64-free envelope. A decode failure degrades VISIBLY to a
 * can't-process note — never a raw, unbounded-dimension original in an image block.
 */
async function imageResult(
  meta: JiraAttachmentMeta,
  bytes: Buffer,
  maxEdge: number,
  processor: ImageProcessor,
): Promise<CallToolResult> {
  let result;
  try {
    result = await processor.downscale({ data: bytes, mimeType: meta.mimeType }, maxEdge);
  } catch {
    const note =
      `can't inline ${meta.filename} — its bytes couldn't be decoded as an image ` +
      `(${meta.mimeType}, ${formatBytes(meta.size)}); ${downloadClause(meta)}.`;
    return attachmentResult(
      meta,
      { inlined: false, note, downloadUrl: meta.contentUrl ?? null },
      [
        `Couldn't decode ${meta.filename} as an image — it may be corrupt or an unsupported format. ` +
          `${meta.contentUrl ? `Download the original at ${meta.contentUrl}.` : "Download the original from JIRA."}`,
      ],
    );
  }

  const imageBlock: CallToolResult["content"][number] = {
    type: "image",
    data: result.data.toString("base64"),
    mimeType: result.mimeType,
  };

  const envelope: Record<string, unknown> = {
    inlined: true,
    dimensions: { width: result.width, height: result.height },
  };
  const hints: string[] = [];
  if (result.downscaled) {
    const note =
      `image downscaled ${result.originalWidth}×${result.originalHeight} → ` +
      `${result.width}×${result.height} for context efficiency; original ${formatBytes(meta.size)}.`;
    envelope.downscaled = true;
    envelope.note = note;
    hints.push(
      `Returned ${meta.filename} as an image block, ${note} The full-resolution original is at ` +
        `${meta.contentUrl ?? "JIRA"}.`,
    );
  } else {
    envelope.downscaled = false;
    hints.push(
      `Returned ${meta.filename} as an image block (${result.width}×${result.height}, already within the size budget).`,
    );
  }

  return attachmentResult(meta, envelope, hints, imageBlock);
}

/**
 * PDF path: extract text server-side (there is no reliable cross-host PDF blob
 * block), page-budgeted, and return it as a text block with a visible "(extracted
 * text; layout/images omitted)" note. The page count + `pageRange` are the PDF
 * guardrail — a 200-page PDF comes back as a few-k-token slice with a
 * `nextPageRange` to continue, never the whole document. Degrades VISIBLY:
 *   - a parse failure → a can't-extract note (never silent);
 *   - a PDF with no extractable text (scanned/image-only) → a "no extractable
 *     text (likely a scanned PDF)" note + the download URL (no OCR in scope);
 *   - a `pageRange` past the last page → a "past the end" note, never an empty slice.
 */
async function pdfResult(
  meta: JiraAttachmentMeta,
  bytes: Buffer,
  range: PageRange,
  processor: PdfProcessor,
): Promise<CallToolResult> {
  let extracted;
  try {
    extracted = await processor.extractText(bytes);
  } catch {
    const note =
      `can't extract text from ${meta.filename} — its bytes couldn't be parsed as a PDF ` +
      `(${formatBytes(meta.size)}); ${downloadClause(meta)}.`;
    return attachmentResult(
      meta,
      { inlined: false, kind: "pdf", note, downloadUrl: meta.contentUrl ?? null },
      [
        `Couldn't parse ${meta.filename} as a PDF — it may be corrupt or encrypted. ` +
          `${meta.contentUrl ? `Download the original at ${meta.contentUrl}.` : "Download the original from JIRA."}`,
      ],
    );
  }

  const { pageCount, pages } = extracted;

  // No extractable text anywhere → scanned/image-only. Degrade VISIBLY (no OCR).
  // `?? ""` mirrors the accumulation loop's defensiveness if a processor ever
  // returns a short/sparse `pages` array against its contract.
  if (!pages.some((p) => (p ?? "").trim().length > 0)) {
    const note = `no extractable text (likely a scanned PDF); ${downloadClause(meta)}.`;
    return attachmentResult(
      meta,
      { inlined: false, kind: "pdf", note, downloadUrl: meta.contentUrl ?? null },
      [
        `${meta.filename} has no extractable text — it's likely a scanned/image-only PDF (no OCR here). ` +
          `${meta.contentUrl ? `Download it at ${meta.contentUrl}.` : "Download it from JIRA."}`,
      ],
    );
  }

  // Asked to start past the last page — report it, never an empty slice.
  if (range.start > pageCount) {
    const note = `pageRange start ${range.start} is past the last page of ${meta.filename} (${pageCount} pages); nothing to read.`;
    return attachmentResult(
      meta,
      { inlined: false, kind: "pdf", note, downloadUrl: meta.contentUrl ?? null, pages: { total: pageCount } },
      [`${meta.filename} has ${pageCount} pages — read from a lower pageRange (e.g. "1-").`],
    );
  }

  // Accumulate whole pages from `start` while within the token budget — the same
  // degrade-visibly page discipline 16's text `offset` uses, but per page. Format
  // every page in the requested span first (`?? ""` guards a sparse `pages`), then
  // pack the prefix that fits; the first page is always kept, even if oversized.
  const upper = Math.min(range.end ?? pageCount, pageCount);
  const formattedPages: string[] = [];
  for (let page = range.start; page <= upper; page++) {
    formattedPages.push(`--- page ${page} ---\n${pages[page - 1] ?? ""}`);
  }
  const { kept: chunks, dropped, size: tokens } = packUntilBudget(
    formattedPages,
    estimateTokens,
    TEXT_TOKEN_BUDGET,
  );

  // Pages are contiguous from `start`, so the last kept page follows directly.
  const lastPage = range.start - 1 + chunks.length;
  const truncated = dropped > 0;
  const text = chunks.join("\n\n");
  const tokenLabel =
    tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;

  const envelope: Record<string, unknown> = {
    inlined: true,
    kind: "pdf",
    pages: { shown: { start: range.start, end: lastPage }, total: pageCount },
    truncated,
  };
  const hints: string[] = [];

  let note =
    `(extracted text from PDF; layout/images omitted) — ${tokenLabel} of ` +
    `pages ${range.start}–${lastPage} of ${pageCount}`;
  if (truncated) {
    // Preserve an explicit upper bound across continuation: a "2-8" read that
    // truncated at page 4 continues as "5-8", not an unbounded "5-".
    const next = range.end !== undefined ? `${lastPage + 1}-${range.end}` : `${lastPage + 1}-`;
    envelope.nextPageRange = next;
    note += `; pass pageRange="${next}" for more.`;
    hints.push(
      `Returned pages ${range.start}–${lastPage} of ${meta.filename} (${pageCount} pages total) as ` +
        `extracted text. It's truncated — call jira_read_attachment again with pageRange="${next}" for more.`,
    );
  } else {
    note += ".";
    hints.push(
      `Returned the extracted text of ${meta.filename} (pages ${range.start}–${lastPage} of ${pageCount}). ` +
        "Layout, images, and exact formatting are omitted; download the original for those.",
    );
  }
  envelope.note = note;

  const textBlock: CallToolResult["content"][number] = { type: "text", text };
  return attachmentResult(meta, envelope, hints, textBlock);
}

/**
 * Shrink a byte-window end back to the nearest UTF-8 codepoint boundary, so a
 * multibyte character split by the fixed byte budget is not lost. Without this,
 * a char straddling the cut decodes as U+FFFD at the END of this chunk AND again
 * at the START of the next (`nextOffset` lands mid-character) — unrecoverable
 * from either. We trim only a DANGLING trailing sequence: a lead byte
 * (0xC0–0xF7) with fewer continuation bytes (0x80–0xBF) than its length needs.
 * A complete final character is kept, so at most 3 bytes are ever trimmed (the
 * tail of a 4-byte sequence). The window never shrinks to empty — if the whole
 * window is one unterminated sequence (pathological; a char is ≤ 4 bytes and the
 * budget is far larger), the raw bytes are returned to guarantee `offset`
 * progress. Callers skip this for the final chunk, where a dangling sequence is
 * genuine file truncation, not our slicing.
 */
function utf8BoundaryEnd(bytes: Buffer, start: number, end: number): number {
  // Walk back over continuation bytes to the lead byte, at most 3 (a 4-byte char
  // has 3 continuations); the `> start` guard keeps ≥ 1 byte in the window.
  for (let back = 1; back <= 3 && end - back > start; back++) {
    const b = bytes[end - back]!;
    if (b >= 0x80 && b <= 0xbf) continue; // continuation byte — keep walking back.
    // `b` is the first byte of the last (possibly partial) sequence. `back` bytes
    // of it sit inside the window; if it needs more, the char is split — cut it off.
    const needed = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return needed > back ? end - back : end;
  }
  return end;
}

/**
 * Text path: decode a byte window from `offset`, token/byte-budgeted, and return
 * it as a text block. An oversize file truncates with a VISIBLE marker and a
 * `nextOffset` to continue (never silent truncation).
 */
function textResult(meta: JiraAttachmentMeta, bytes: Buffer, offset: number): CallToolResult {
  const total = bytes.length;
  const start = Math.min(Math.max(offset, 0), total);
  // Cut the window at a UTF-8 codepoint boundary UNLESS it already reaches the
  // end of the file (a dangling sequence there is genuine truncation, not our
  // slicing). `end`/`nextOffset` then land exactly on a boundary, so a split
  // multibyte char is decoded whole by the NEXT chunk instead of becoming U+FFFD
  // at both the end of this one and the start of that one.
  const budgetEnd = Math.min(start + TEXT_BYTE_BUDGET, total);
  const end = budgetEnd < total ? utf8BoundaryEnd(bytes, start, budgetEnd) : budgetEnd;
  const window = bytes.subarray(start, end);
  // `fatal:false` (the default) tolerates a genuinely-truncated final sequence by
  // emitting U+FFFD rather than throwing — a visible artifact, not a crash.
  const text = new TextDecoder("utf-8").decode(window);
  const truncated = end < total;

  const envelope: Record<string, unknown> = {
    inlined: true,
    encoding: "utf-8",
    bytes: { offset: start, end, total },
  };
  const hints: string[] = [];

  if (start >= total && total > 0) {
    // Asked to continue past the end — nothing left.
    envelope.note = `offset ${start} is at/after the end of ${meta.filename} (${total} bytes); nothing more to read.`;
    hints.push(`Reached the end of ${meta.filename} (${total} bytes). Read from a lower offset for earlier content.`);
  } else if (truncated) {
    const note =
      `truncated — showing bytes ${start}–${end} of ${total} ` +
      `(~${estimateTokens(text)} tokens); pass offset=${end} for more.`;
    envelope.truncated = true;
    envelope.nextOffset = end;
    envelope.note = note;
    hints.push(
      `Returned ${formatBytes(end - start)} of ${meta.filename} (${formatBytes(total)} total). ` +
        `It's truncated — call jira_read_attachment again with offset=${end} for the next chunk.`,
    );
  } else {
    envelope.truncated = false;
    hints.push(
      start > 0
        ? `Returned the rest of ${meta.filename} from byte ${start} (${total} bytes total).`
        : `Returned the full text of ${meta.filename} (${total} bytes).`,
    );
  }

  const textBlock: CallToolResult["content"][number] = { type: "text", text };
  return attachmentResult(meta, envelope, hints, textBlock);
}

/** Shape a metadata/content fetch failure: auth, not-found, or generic/unexpected. */
function metaError(attachmentId: string, err: unknown): CallToolResult {
  if (err instanceof JiraApiError) {
    if (err.isAuthError) return authErrorResult(err);
    if (err.isNotFound) {
      return shapeError(
        { message: `Attachment ${attachmentId} was not found.`, code: "attachment_not_found" },
        [
          `No attachment matched id \`${attachmentId}\` (it may have been deleted, or the token can't ` +
            "see its issue). Find current attachment ids via `jira_get_issue` with `detail:\"full\"`.",
        ],
      );
    }
    return genericJiraErrorResult(err);
  }
  return unexpectedErrorResult(err);
}

/**
 * Registration deps — the image and PDF processors default to the real
 * (jimp/unpdf) implementations, so production wiring supplies only the byte
 * ceiling (handler tests inject fake processors by calling
 * {@link readAttachmentHandler} directly).
 */
export type RegisterReadAttachmentDeps = Omit<
  ReadAttachmentDeps,
  "imageProcessor" | "pdfProcessor"
> & {
  imageProcessor?: ImageProcessor;
  pdfProcessor?: PdfProcessor;
};

export function registerReadAttachmentTool(
  server: McpServer,
  jira: IJiraClient,
  deps: RegisterReadAttachmentDeps,
): void {
  const resolved: ReadAttachmentDeps = {
    ...deps,
    imageProcessor: deps.imageProcessor ?? jimpImageProcessor,
    pdfProcessor: deps.pdfProcessor ?? unpdfProcessor,
  };
  server.registerTool(
    "jira_read_attachment",
    {
      title: "Read a JIRA attachment",
      description: READ_ATTACHMENT_DESCRIPTION,
      inputSchema: readAttachmentInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => readAttachmentHandler(jira, args, resolved),
  );
}
