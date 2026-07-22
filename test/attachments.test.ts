/**
 * Attachment helpers — classification, serialization, byte formatting.
 * Pure functions, so they're unit-tested directly (the rich branching the PRD
 * calls out for direct tests).
 */

import { test, expect } from "bun:test";
import {
  classifyAttachment,
  formatBytes,
  serializeAttachment,
  serializeAttachments,
} from "../src/lib/attachments.ts";

test("serializeAttachment flattens to the bounded discovery shape", () => {
  const out = serializeAttachment({
    id: 10042,
    filename: "design.png",
    mimeType: "image/png",
    size: 2048,
    created: "2026-06-20T08:00:00.000+0000",
    author: { displayName: "Jane Doe" },
  });
  expect(out).toEqual({
    id: "10042",
    filename: "design.png",
    mimeType: "image/png",
    size: 2048,
    created: "2026-06-20T08:00:00.000+0000",
    author: "Jane Doe",
  });
});

test("serializeAttachments returns [] for a missing/non-array field", () => {
  expect(serializeAttachments(undefined)).toEqual([]);
  expect(serializeAttachments(null)).toEqual([]);
  expect(serializeAttachments("nope")).toEqual([]);
});

test("classifyAttachment routes raster images to the image path", () => {
  expect(classifyAttachment("image/png", "a.png")).toBe("image");
  expect(classifyAttachment("image/jpeg", "a.jpg")).toBe("image");
  expect(classifyAttachment("image/gif", "a.gif")).toBe("image");
  expect(classifyAttachment("IMAGE/WEBP", "a.webp")).toBe("image");
});

test("classifyAttachment treats text/* and structured-data mimes as text", () => {
  expect(classifyAttachment("text/plain", "notes.txt")).toBe("text");
  expect(classifyAttachment("text/markdown", "README.md")).toBe("text");
  expect(classifyAttachment("application/json", "data.json")).toBe("text");
  expect(classifyAttachment("application/xml", "pom.xml")).toBe("text");
  // SVG is XML markup, not a raster jimp can decode — read it as text, not image.
  expect(classifyAttachment("image/svg+xml", "logo.svg")).toBe("text");
});

test("classifyAttachment falls back to the extension when the mime is unhelpful", () => {
  expect(classifyAttachment("application/octet-stream", "server.log")).toBe("text");
  expect(classifyAttachment("", "config.yaml")).toBe("text");
  expect(classifyAttachment("application/octet-stream", "Main.java")).toBe("text");
  // An unknown binary with no textish extension stays `other`.
  expect(classifyAttachment("application/octet-stream", "archive.bin")).toBe("other");
});

test("classifyAttachment routes PDFs to the dedicated pdf (text-extraction) path", () => {
  expect(classifyAttachment("application/pdf", "spec.pdf")).toBe("pdf");
  expect(classifyAttachment("APPLICATION/PDF", "SPEC.PDF")).toBe("pdf");
  // A .pdf extension wins even when JIRA mislabels the mime as octet-stream.
  expect(classifyAttachment("application/octet-stream", "spec.pdf")).toBe("pdf");
});

test("classifyAttachment leaves office/unknown as the degrade-visibly default", () => {
  expect(
    classifyAttachment(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "doc.docx",
    ),
  ).toBe("other");
  expect(classifyAttachment("application/zip", "bundle.zip")).toBe("other");
});

test("formatBytes is human-readable across magnitudes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(8 * 1024)).toBe("8.0 KB");
  expect(formatBytes(12.3 * 1024 * 1024)).toBe("12.3 MB");
  expect(formatBytes(-1)).toBe("unknown size");
});
