/**
 * Content-based MIME detection for `jira_add_attachment`.
 *
 * The tool sends the detected Content-Type in the multipart part and surfaces it
 * in the response. We detect from the file's BYTES, not its extension: a blind
 * extension trust lets a renamed `evil.png` (actually a script) be mislabeled,
 * and JIRA renders by the Content-Type we send. Magic-byte signatures cover the
 * common binary types (the canonical case is PNG/GIF images); anything that
 * isn't a recognized binary falls back to a UTF-8 text heuristic, else
 * `application/octet-stream` (JIRA accepts the upload regardless — the value is
 * honesty about what we send).
 *
 * Pure and deterministic — unit-tested directly with crafted buffers.
 */

/** Does `bytes` start with the given byte signature at `offset`? */
function startsWith(bytes: Buffer, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** ASCII helper: are `len` bytes from `offset` equal to `ascii`? */
function asciiAt(bytes: Buffer, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Heuristic: does the (already byte-checked) buffer look like UTF-8 text? A NUL
 * byte in the first window is a strong binary signal; otherwise we require the
 * bytes to decode as valid UTF-8 (a strict decoder throws on malformed input).
 */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return true; // an empty file is harmless text.
  const window = bytes.subarray(0, 4096);
  if (window.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(window);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a file's MIME type from its content. `filename` is used ONLY to
 * disambiguate text subtypes a content sniff can't (e.g. `.svg` vs generic XML);
 * it never overrides a confident binary signature.
 */
export function detectMimeType(bytes: Buffer, filename?: string): string {
  // --- raster images (the most common attachment case) ---
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, "GIF87a") || asciiAt(bytes, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, "RIFF") && asciiAt(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";

  // --- documents / containers ---
  if (asciiAt(bytes, "%PDF-")) return "application/pdf";
  // ZIP magic also fronts docx/xlsx/pptx/jar; without unzipping we report zip.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";

  // --- text-ish ---
  if (looksLikeText(bytes)) {
    const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
    const head = bytes.subarray(0, 256).toString("utf-8").trimStart().toLowerCase();
    // Subtypes are claimed only on a CONFIDENT signal — the file extension, or a
    // document that STARTS with the type's marker. We deliberately do NOT sniff
    // a bare leading `{`/`[` as JSON or a mid-buffer `<svg` substring as SVG:
    // a markdown link `[x](y)` or a log line quoting markup would be mislabeled.
    // text/plain is the safe, honest fallback (JIRA stores it fine either way).
    if (ext === "svg" || head.startsWith("<svg")) return "image/svg+xml";
    if (ext === "json") return "application/json";
    if (ext === "html" || ext === "htm") return "text/html";
    if (ext === "csv") return "text/csv";
    if (ext === "xml" || head.startsWith("<?xml")) return "application/xml";
    return "text/plain";
  }

  return "application/octet-stream";
}
