/**
 * detectMimeType — MIME from CONTENT (magic bytes), not extension. The point is
 * that a renamed/extension-lying file is classified by what it actually is, so
 * JIRA renders it with the correct Content-Type.
 */

import { test, expect } from "bun:test";
import { detectMimeType } from "../src/lib/mime-detect.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a\x00\x00", "binary");
const PDF = Buffer.from("%PDF-1.7\n...", "binary");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);

test("detects raster images from magic bytes", () => {
  expect(detectMimeType(PNG)).toBe("image/png");
  expect(detectMimeType(JPEG)).toBe("image/jpeg");
  expect(detectMimeType(GIF)).toBe("image/gif");
  expect(detectMimeType(Buffer.from([0x42, 0x4d, 0, 0]))).toBe("image/bmp");
});

test("WEBP needs both the RIFF prefix and the WEBP tag", () => {
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  expect(detectMimeType(webp)).toBe("image/webp");
  // RIFF without WEBP (e.g. a WAV) is not classified as webp.
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")]);
  expect(detectMimeType(wav)).not.toBe("image/webp");
});

test("detects PDF and zip-fronted containers", () => {
  expect(detectMimeType(PDF)).toBe("application/pdf");
  expect(detectMimeType(ZIP)).toBe("application/zip");
});

test("content wins over a lying extension", () => {
  // A real PNG named .txt is still image/png — extension is NOT trusted.
  expect(detectMimeType(PNG, "screenshot.txt")).toBe("image/png");
  // A text file named .png is text — no PNG magic bytes.
  expect(detectMimeType(Buffer.from("hello, world\n"), "fake.png")).toBe("text/plain");
});

test("text heuristic: UTF-8 text → text/plain, NUL/invalid → octet-stream", () => {
  expect(detectMimeType(Buffer.from("plain notes\n"))).toBe("text/plain");
  expect(detectMimeType(Buffer.from("héllo utf-8 ☃"))).toBe("text/plain");
  expect(detectMimeType(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))).toBe("application/octet-stream");
});

test("text subtypes are disambiguated by content/extension", () => {
  expect(detectMimeType(Buffer.from('{"a":1}'), "data.json")).toBe("application/json");
  expect(detectMimeType(Buffer.from("<svg xmlns='...'></svg>"))).toBe("image/svg+xml");
  expect(detectMimeType(Buffer.from("<?xml version='1.0'?>"))).toBe("application/xml");
  expect(detectMimeType(Buffer.from("a,b,c\n1,2,3"), "data.csv")).toBe("text/csv");
});

test("a bare leading { or [ is NOT mislabeled as JSON (markdown link, config snippet)", () => {
  // text/plain is the honest fallback; only a .json ext claims application/json.
  expect(detectMimeType(Buffer.from("[label](http://x)\nnotes"))).toBe("text/plain");
  expect(detectMimeType(Buffer.from("{ not really json"))).toBe("text/plain");
  // A mid-buffer "<svg" substring (a log quoting markup) is not labeled SVG.
  expect(detectMimeType(Buffer.from("error near <svg> tag in input"))).toBe("text/plain");
});

test("an empty file is treated as text, not unknown binary", () => {
  expect(detectMimeType(Buffer.from(""))).toBe("text/plain");
});
