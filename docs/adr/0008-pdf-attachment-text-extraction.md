# ADR 0008 — PDF attachment text extraction via unpdf, behind a seam, page-budgeted

Status: accepted
Date: 2026-06-30

## Context

Issue 16 landed `jira_read_attachment` with PDFs taking the "can't inline — download
at `<url>`" path, deferring PDF text extraction to this fast-follow (issue 17). PDFs
(specs, design docs) are common, high-value attachments, so carving them out of the
default and giving the tool **server-side text extraction** is worth a dedicated slice.

Why extract text rather than pass the blob: MCP tool-result content is text / image /
audio / embedded-resource — there is **no reliable cross-host PDF "document" block** the
way the Anthropic Messages API has one. Blob/embedded-resource handling is host-dependent
(the same unreliability that kept us off resources). So we extract text server-side and
return it as a text block.

The split from 16 was explicit: the extraction **dependency needed a cost-check** before
committing — the same gate the image downscaler (jimp vs sharp) went through. The escape
hatch was real: if the only viable extractor proved heavy or flaky, the documented outcome
was to keep 16's can't-inline note for PDFs rather than ship a fragile dependency.

## Decision

**1. Ship it — `unpdf` passes the cost-check.** The evaluated extractor, **unpdf**, is a
serverless build of Mozilla's **pdf.js** — **pure JS, no native binary** — which is the
exact npx/`.mcpb` packaging constraint that put images on jimp over sharp (a native,
per-platform prebuilt is the classic bundle failure). Empirically under Bun it is small
(~2.3 MB installed, 6 transitive packages), extracts clean per-page text from a generated
multi-page PDF, reports an accurate `totalPages`, and returns an **empty string for an
image-only page** (the signal we need for scanned-PDF detection). It is loaded **lazily**
(dynamic import) so startup stays light and the dep is only touched when a PDF is read.
The escape hatch (keep 16's can't-inline note) was therefore **not** needed — but it was a
real, evaluated decision, not a silent default.

**2. Behind a `PdfProcessor` seam, mirroring `ImageProcessor`.** `extractText(data) →
{ pageCount, pages[] }` (one string per page, index 0 = page 1). The seam keeps handler
tests offline/deterministic with a fake processor, while the real unpdf-backed impl gets
its own direct unit test (extract per-page text from a `pdf-lib`-generated PDF; image-only
PDF → empty page; non-PDF bytes → throws). `pdf-lib` is a **devDependency** for fixture
generation only — never shipped (only `dist` is published).

**3. `pageRange` is the PDF guardrail — the role `offset` plays for text.** Pages are
accumulated **whole** from the range start while within the **same ~3.5k-token budget** as
text reads; the first page of a slice is always included even if oversized (mirroring the
text-budget paragraph rule). A long PDF therefore comes back as a few-k-token slice with
`truncated:true` + a `nextPageRange` (`"N-"`) to continue — **never the whole document**.
`pageRange` accepts `"5"`/`"5-"` (from page 5 onward, budget-capped) or `"5-12"` (a bounded
slice, still budget-capped). A 200-page PDF cannot torch the context window: the budget
caps every read regardless of the range asked for.

**4. Degrade VISIBLY (PRD content-fidelity contract), three ways:**
- Extracted text carries a visible note: `"(extracted text from PDF; layout/images
  omitted) — ~Xk tokens of pages A–B of N; pass pageRange=\"…\" for more."`
- A PDF with **no extractable text** (scanned/image-only) → `"no extractable text (likely a
  scanned PDF); download at <url>"` — never a silent/empty result. **No OCR in scope.**
- A **parse failure** (corrupt/encrypted) → `"can't extract text … couldn't be parsed as a
  PDF; download at <url>"` — never silent. (Mirrors the image decode-failure degrade.)

**5. Classification gains a `pdf` kind.** `classifyAttachment` routes `application/pdf`
(or a `.pdf` extension when JIRA mislabels the mime as octet-stream) to the new `pdf` path;
office/unknown still degrade to the can't-inline note with **no content fetched**. PDF
content **is** fetched (it must be, to extract), under the same metadata-first byte ceiling.

## Consequences

- New `lib/pdf-processor.ts` (`PdfProcessor` seam + lazy unpdf impl); `AttachmentKind` gains
  `"pdf"`; `read-attachment.ts` gains a `pageRange` param, a `pdfProcessor` dep (defaulted to
  unpdf in registration), and a `pdfResult` path.
- New runtime dependency **unpdf** (pure JS, serverless pdf.js). New **devDependency**
  `pdf-lib` (test-fixture PDFs only).
- No new env/config key — PDF reuses the existing token budget and byte ceiling.

## Verification

Driven end-to-end against the faked `JiraClient` with an injected fake `PdfProcessor`:
PDF → extracted text + "(extracted text; layout/images omitted)" note (and the content
**is** fetched, unlike office types); large PDF → page-budgeted truncation with a
`nextPageRange` that continues without re-serving earlier pages; explicit `pageRange="2-3"`
→ a bounded slice; scanned/image-only (all pages blank) → visible "no extractable text"
note + download URL, no empty deliverable; corrupt bytes → visible can't-extract note;
`pageRange` past the last page → a "past the end" note naming the real page count, never an
empty slice. The real unpdf processor has its own unit test (multi-page per-page extraction,
image-only → empty page, non-PDF → throws). **Honest caveat the offline suite cannot
cover:** a real-instance smoke test — fetch an actual PDF attachment and confirm the
extracted text and `pageRange` continuation behave against a real document (and that a real
scanned PDF degrades) — is still required; the fake proves the budgeting/branching logic,
only a real fetch proves unpdf's extraction end-to-end on the host's Node runtime.
