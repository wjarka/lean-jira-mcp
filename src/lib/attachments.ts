/**
 * Attachment helpers — pure, deterministic, shared between `jira_get_issue`'s
 * discovery list and `jira_read_attachment`'s per-type content policy.
 *
 * Two concerns live here, both with rich-enough branching to unit-test directly:
 *   - serializing an issue's `attachment` field into the small, bounded metadata
 *     list the "find" surface returns (`{id, filename, mimeType, size, created,
 *     author}`); and
 *   - classifying an attachment by mime/extension into the three read paths —
 *     `image` (downscaled into an image content block), `text` (token-budgeted
 *     text), or `other` (PDF/office/unknown → metadata + a visible can't-inline
 *     note). The split decides which path `jira_read_attachment` takes, so it
 *     must degrade VISIBLY: anything not confidently image/text is `other`,
 *     never silently treated as inlinable.
 */

import { displayNameOf, stringOrNull } from "./issue-fields.ts";

/** The flat metadata one attachment exposes in the `get_issue` full list. */
export interface SerializedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
  created: string | null;
  /** Author display name, or null when JIRA omits it. */
  author: string | null;
}

/** The read paths `jira_read_attachment` routes an attachment into. */
export type AttachmentKind = "image" | "text" | "pdf" | "other";

interface RawIssueAttachment {
  id?: string | number;
  filename?: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string } | null;
}

/** Flatten one raw issue attachment into the bounded discovery shape. Reuses the
 *  shared card-field accessors so null/string normalization stays in one place. */
export function serializeAttachment(raw: RawIssueAttachment): SerializedAttachment {
  return {
    id: String(raw?.id ?? ""),
    filename: stringOrNull(raw?.filename) ?? "",
    mimeType: stringOrNull(raw?.mimeType) ?? "application/octet-stream",
    size: typeof raw?.size === "number" ? raw.size : 0,
    created: stringOrNull(raw?.created),
    author: displayNameOf(raw?.author),
  };
}

/** The whole `attachment` field → a serialized list (empty when absent). */
export function serializeAttachments(field: unknown): SerializedAttachment[] {
  return (Array.isArray(field) ? field : []).map((a) => serializeAttachment(a as RawIssueAttachment));
}

/**
 * Mime types we treat as text even though they aren't `text/*`. Structured-data
 * formats an agent routinely wants to read inline.
 */
const TEXTISH_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
  "application/x-sh",
  "application/csv",
  "image/svg+xml", // XML markup, not a raster image jimp can decode — read as text.
]);

/**
 * Filename extensions we treat as text when the mime type is unhelpful
 * (`application/octet-stream` is JIRA's frequent fallback for source/log files).
 */
const TEXTISH_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "csv", "tsv", "log", "json", "ndjson",
  "yaml", "yml", "xml", "html", "htm", "css", "ini", "toml", "conf", "cfg", "env",
  "properties", "sql", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cs", "php", "pl", "lua",
  "r", "scala", "swift", "diff", "patch", "gradle", "dockerfile", "gitignore",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Decide which read path an attachment takes. Conservative by design — only a
 * confident image or text classification leaves the `other` (degrade-visibly)
 * default, so a PDF/office doc/unknown binary is never mistaken for inlinable.
 */
export function classifyAttachment(mimeType: string, filename: string): AttachmentKind {
  const mime = (mimeType || "").toLowerCase().trim();
  const ext = extensionOf(filename || "");

  // PDF earns its own path: text is extracted server-side (issue 17), not
  // inlined as a blob. A `.pdf` extension wins even when JIRA mislabels the mime.
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  // SVG and other textish-but-image-prefixed types are handled by the set first.
  if (TEXTISH_MIME.has(mime)) return "text";
  // A real raster image jimp can decode. (SVG was already routed to text above.)
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";
  // Mime unhelpful (octet-stream / empty) — fall back to the extension.
  if (mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    if (TEXTISH_EXT.has(ext)) return "text";
  }
  return "other";
}

/** Human-readable byte size, e.g. `12.3 MB`, `8.0 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
