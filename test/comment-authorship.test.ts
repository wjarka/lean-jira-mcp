/**
 * Unit tests for the comment-authorship primitive: marker stamping (idempotent,
 * no opt-out) and the property-primary / marker-fallback authorship derivation
 * that backs the edit guard (07) and `authoredBy` (08).
 */

import { test, expect } from "bun:test";
import {
  ORIGIN_PROPERTY_KEY,
  ORIGIN_PROPERTY_VALUE,
  LEGACY_MARKER,
  stampMarkerAdf,
  isEmojiMarker,
  hasOriginProperty,
  deriveAuthoredBy,
} from "../src/lib/comment-authorship.ts";
import { markdownToAdf, type AdfDoc } from "../src/lib/markdown-to-adf.ts";
import { adfToMarkdown } from "../src/lib/adf-to-markdown.ts";

// --- isEmojiMarker ----------------------------------------------------------

test("isEmojiMarker recognises emoji shortcodes and rejects plain text", () => {
  expect(isEmojiMarker(":claude:")).toBe(true);
  expect(isEmojiMarker(":+1:")).toBe(true);
  expect(isEmojiMarker("[AGENT]")).toBe(false);
  expect(isEmojiMarker("claude")).toBe(false);
});

// --- stampMarkerAdf ---------------------------------------------------------

const firstParagraph = (doc: AdfDoc) => doc.content[0] as { type: string; content: any[] };

test("an emoji-shortcode marker is stamped as a real ADF emoji node, not literal text", () => {
  const stamped = stampMarkerAdf(markdownToAdf("Looks good."), ":claude:");
  const lead = firstParagraph(stamped).content[0];
  expect(lead).toEqual({ type: "emoji", attrs: { shortName: ":claude:" } });
  // and it flattens back to the shortcode on read, so detection still works
  expect(adfToMarkdown(stamped).trimStart().startsWith(":claude:")).toBe(true);
});

test("a non-emoji marker is stamped as plain leading text", () => {
  const stamped = stampMarkerAdf(markdownToAdf("Looks good."), "[AGENT]");
  const lead = firstParagraph(stamped).content[0];
  expect(lead.type).toBe("text");
  expect(lead.text).toBe("[AGENT] ");
});

test("stampMarkerAdf prepends the marker into the first paragraph", () => {
  const stamped = stampMarkerAdf(markdownToAdf("hello"), ":robot:");
  expect(adfToMarkdown(stamped)).toBe(":robot: hello");
});

test("a body opening with a non-paragraph block gets a new leading marker paragraph", () => {
  const stamped = stampMarkerAdf(markdownToAdf("# Heading\n\nbody"), ":claude:");
  const lead = firstParagraph(stamped);
  expect(lead.type).toBe("paragraph");
  expect(lead.content[0]).toEqual({ type: "emoji", attrs: { shortName: ":claude:" } });
});

test("stampMarkerAdf is idempotent — re-stamping an already-marked body does not double it", () => {
  const once = stampMarkerAdf(markdownToAdf("note"), ":claude:");
  const twice = stampMarkerAdf(once, ":claude:");
  expect(twice).toEqual(once);
});

// --- hasOriginProperty ------------------------------------------------------

test("hasOriginProperty detects the origin property by key", () => {
  expect(hasOriginProperty([{ key: ORIGIN_PROPERTY_KEY, value: ORIGIN_PROPERTY_VALUE }])).toBe(true);
  expect(hasOriginProperty([{ key: "other", value: 1 }])).toBe(false);
  expect(hasOriginProperty(null)).toBe(false);
  expect(hasOriginProperty(undefined)).toBe(false);
});

// --- deriveAuthoredBy -------------------------------------------------------

test("the origin property makes a comment agent-authored regardless of body", () => {
  const got = deriveAuthoredBy(
    { properties: [{ key: ORIGIN_PROPERTY_KEY }], bodyText: "no marker here", hasAuthor: true },
    { marker: ":claude:" },
  );
  expect(got).toBe("agent");
});

test("the configured marker is an agent fallback when no property is present", () => {
  const got = deriveAuthoredBy(
    { properties: [], bodyText: ":robot: hello", hasAuthor: true },
    { marker: ":robot:" },
  );
  expect(got).toBe("agent");
});

test("the legacy :claude: marker is always recognised even under a reconfigured marker", () => {
  const got = deriveAuthoredBy(
    { properties: [], bodyText: `${LEGACY_MARKER} old comment`, hasAuthor: true },
    { marker: ":robot:" },
  );
  expect(got).toBe("agent");
});

test("a marker only counts at the START of the body — a mid-text mention stays human", () => {
  const got = deriveAuthoredBy(
    { properties: [], bodyText: "We should configure the :claude: marker next sprint.", hasAuthor: true },
    { marker: ":claude:" },
  );
  expect(got).toBe("human");
});

test("no property and no marker is human-authored", () => {
  const got = deriveAuthoredBy(
    { properties: [], bodyText: "a human wrote this", hasAuthor: true },
    { marker: ":claude:" },
  );
  expect(got).toBe("human");
});

test("no author at all is unknown, not human", () => {
  const got = deriveAuthoredBy(
    { properties: [], bodyText: "orphaned", hasAuthor: false },
    { marker: ":claude:" },
  );
  expect(got).toBe("unknown");
});
