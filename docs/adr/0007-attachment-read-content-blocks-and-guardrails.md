# ADR 0007 — Attachment read: discovery on `get_issue`, a 9th tool returning content blocks, and the triple-lock token guardrails

Status: accepted
Date: 2026-06-29

## Context

v1 deferred attachments. The user now needs an agent to **find** attached files
on an issue and **read** them — including screenshots, which are common and
high-value QA/grooming context. The mentor ruling (issue 16) fixed the shape:
discovery rides `get_issue` (no new surface), reading earns one new tool, one
attachment per call, per-type content with **visible degradation**, read-only.
This issue covers images + text; PDF text extraction is the fast-follow (issue
17) and office/unknown degrade to a metadata + can't-inline note here.

The non-obvious risk an offline test suite can hide: an image's token cost is
driven by its **dimensions, not its base64 byte length**. A naive "stream
whatever JIRA returns" — or, worse, a base64 image dropped into a *text* block —
torches the context window on a single large file. So the content-block contract
and the size guardrails are the heart of this slice, not an afterthought.

## Decision

**1. Discovery rides `get_issue` (no new tool/resource).** Attachments are an
issue sub-resource like comments/links/subtasks, and their metadata is small and
bounded, so they mirror that pattern: `summary` → a **count** (in `counts`),
`full` → the **list** `[{id, filename, mimeType, size, created, author}]`, not
paginated. The list carries the `id` + `mimeType` + **`size`** that make a read a
deliberate, sized choice. `attachment` is added to the requested field set and to
the detail-controlled set (a `fields[]` override for it is reported, not honored).

**2. Reading earns the 9th tool, `jira_read_attachment(attachmentId, offset?)`.**
It earns a tool on the `get_comments` precedent: a distinct binary access pattern
that returns **content blocks** (an `image` block, or text), never a structured
object, and is never wanted inline by default. **One id per call** — there is no
batch form, by construction (guardrail 1). Fetched through the `JiraClient` seam,
so rate-limit/retry/backoff are handled there like every other call.

**3. Two seam methods; metadata is read FIRST.** `getAttachmentMeta(id)`
(`GET /rest/api/3/attachment/{id}`) returns `{id, filename, mimeType, size,
created, author, contentUrl}`; `getAttachmentContent(id)`
(`GET /.../attachment/content/{id}`) returns the raw bytes. Metadata is always
read first so `size`/`mimeType` drive the read decision **before** a single
content byte is fetched — that is what makes the byte ceiling a true backstop and
lets non-inlinable types skip the download entirely. The binary path reuses the
client's shared retry/backoff via a small `requestRaw` refactor (the JSON
`request` now delegates to it), so attachment fetches retry 429/5xx identically;
`fetch` follows JIRA's 303 redirect to the signed media URL.

**4. Per-type policy degrades VISIBLY (PRD content-fidelity contract).**
- **Image → a native MCP `image` content block, downscaled server-side** to
  ≤ ~1568px longest edge, with a visible note when downscaled (`"image
  downscaled 4000×3000 → 1568×1176 for context efficiency; original 12 MB."`).
  Image bytes go in the `image` block **only** — never a text block (base64 in a
  text block is tokenized; an image block is dimension-costed). A decode failure
  degrades to a can't-process note — **never** a raw, unbounded-dimension
  original in an image block.
- **Text-ish (`text/*`, json/csv/yaml/xml/log/source, and octet-stream with a
  textish extension) → text, byte/token-budgeted** (~14k bytes ≈ 3.5k tokens,
  matching `get_comments`' page discipline) with a visible truncation marker and
  an `offset` to continue. Never silent.
- **PDF / office / unknown → metadata + a visible `"can't inline <mimeType>
  (<size>); download at <url>"` note**, with no content fetched. (PDF takes this
  path until issue 17.) Never silent, never an empty block.

The result is built so **content[0] is always a base64-free JSON envelope**
(`{attachment, …, hints}`) and an optional deliverable block (image, or the
file's text) follows it — which is what structurally guarantees image bytes only
ever live in an `image` block, and keeps the `hints`-on-every-response contract.

**5. The downscaler is jimp, behind an injectable seam.** Downscaling needs a
real image decoder. We chose **jimp (pure JS, no native binary)** over sharp
deliberately: this server ships via npx and a `.mcpb` bundle, where a native,
per-platform prebuilt binary is the classic packaging failure. jimp is loaded
**lazily** (dynamic import) so startup stays light and the dependency is only
touched when an image is actually read. It sits behind an `ImageProcessor` seam
so handler tests stay offline/deterministic with a fake processor (mirroring the
`IJiraClient` seam), while the real jimp-backed processor gets its own direct
unit test (decode + downscale a generated image). The documented fallback (inline
small as-is, degrade oversize) was **not** needed: jimp proved clean under Bun,
so it landed; a decode failure simply takes the visible can't-process path.

**6. Triple-lock size/token guardrails.** (1) Informed selection — discovery
showed filename/mimeType/size. (2) One-at-a-time — no batch, by construction.
(3) Server-side caps regardless of the agent's choice — images downscaled
(dimensions → bounded tokens), text byte/token-budgeted with `offset`. Plus an
optional **hard byte ceiling** (`JIRA_MCP_ATTACHMENT_MAX_BYTES`, default 25 MB):
a file over it is refused *before* download (note + download URL), a backstop for
pathological files.

## Consequences

- New seam: `JiraAttachmentMeta` + `getAttachmentMeta`/`getAttachmentContent` on
  `IJiraClient` (and the fake); `request` refactored over a shared `requestRaw`.
- New `lib/`: `attachments.ts` (serialize + classify + `formatBytes`, pure/unit-
  tested) and `image-processor.ts` (the `ImageProcessor` seam + jimp impl).
- New tool `src/tools/read-attachment.ts`; `get_issue` gains the count/list;
  `env` gains `attachmentMaxBytes`; wired through `tools`/`server`/`index` and
  advertised in `manifest.json` (9th tool + the new user_config prompt).
- New dependency **jimp** (pure JS). Re-encode on downscale targets the input
  format when jimp can write it, else PNG (lossless).

## Verification

Driven end-to-end against the faked `JiraClient` with an injected fake image
processor: image → image block + downscale note (and the bytes-only-in-the-image-
block invariant asserted directly); small image inlined as-is; undecodable image
→ visible can't-process degrade; text full vs. oversize-truncation-with-`offset`
continuation across three chunks; structured-data/octet-stream-with-extension
routed to text; PDF/unknown → can't-inline note **with content never fetched**;
byte-ceiling refusal **before download**; not-found recovery hint. The real jimp
processor has its own unit test (4000×3000 → 1568×1176, already-small passthrough,
non-image throws). **Honest caveat the offline suite cannot cover:** a real-
instance smoke test — fetch an actual image attachment (e.g. on PROJ-129) and
confirm it renders as an *image* (not a base64 wall) in the client, that a text
attachment and an oversize one behave — is still required; the fake proves the
logic, only a real fetch proves the content-block handling end-to-end.
