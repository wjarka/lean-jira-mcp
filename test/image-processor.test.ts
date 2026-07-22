/**
 * The real, jimp-backed image processor — driven against synthesized images so
 * the decode/downscale/re-encode path is proven without a live JIRA. This is the
 * offline suite's stand-in for the live-instance image smoke test (which only a
 * real fetch + client render can fully prove).
 */

import { test, expect } from "bun:test";
import { Jimp } from "jimp";
import { jimpImageProcessor } from "../src/lib/image-processor.ts";

const MAX_EDGE = 1568;

async function png(width: number, height: number): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x3366ffff });
  return Buffer.from(await img.getBuffer("image/png"));
}

test("downscales an oversize image so the longest edge is <= maxEdge", async () => {
  const bytes = await png(4000, 3000);
  const out = await jimpImageProcessor.downscale({ data: bytes, mimeType: "image/png" }, MAX_EDGE);

  expect(out.downscaled).toBe(true);
  expect(out.originalWidth).toBe(4000);
  expect(out.originalHeight).toBe(3000);
  expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(MAX_EDGE);
  // Aspect ratio preserved (4:3).
  expect(out.width).toBe(1568);
  expect(out.height).toBe(1176);
  // The bytes returned actually decode at the new dimensions.
  const re = await Jimp.read(out.data);
  expect(Math.max(re.width, re.height)).toBeLessThanOrEqual(MAX_EDGE);
});

test("returns an already-small image untouched (original bytes, downscaled:false)", async () => {
  const bytes = await png(800, 600);
  const out = await jimpImageProcessor.downscale({ data: bytes, mimeType: "image/png" }, MAX_EDGE);

  expect(out.downscaled).toBe(false);
  expect(out.width).toBe(800);
  expect(out.height).toBe(600);
  expect(out.mimeType).toBe("image/png");
  // Original bytes are passed through verbatim — no needless re-encode.
  expect(out.data).toBe(bytes);
});

test("throws on bytes that aren't a decodable image (→ handler degrades visibly)", async () => {
  const notAnImage = Buffer.from("this is plainly not an image", "utf8");
  await expect(
    jimpImageProcessor.downscale({ data: notAnImage, mimeType: "image/png" }, MAX_EDGE),
  ).rejects.toBeDefined();
});
