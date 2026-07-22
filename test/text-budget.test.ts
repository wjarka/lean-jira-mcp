/**
 * Unit tests for the token-budget truncation helper.
 *
 * `jira_get_issue`'s summary level truncates a long description at a paragraph
 * boundary and reports how much was omitted; the comment serializer reuses the
 * same primitive to cap oversized comments (slice 08).
 */

import { test, expect } from "bun:test";
import { estimateTokens, truncateToTokenBudget, CHARS_PER_TOKEN } from "../src/lib/text-budget.ts";

test("estimateTokens approximates ~CHARS_PER_TOKEN chars per token", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("a".repeat(CHARS_PER_TOKEN * 10))).toBe(10);
});

test("text within budget is returned untruncated with zero omitted", () => {
  const md = "Short paragraph.\n\nAnother short one.";
  const r = truncateToTokenBudget(md, 1000);
  expect(r.truncated).toBe(false);
  expect(r.text).toBe(md);
  expect(r.tokensOmitted).toBe(0);
  expect(r.paragraphsOmitted).toBe(0);
});

test("truncates at a paragraph boundary, never mid-paragraph", () => {
  const p1 = "A".repeat(400); // ~100 tokens
  const p2 = "B".repeat(400);
  const p3 = "C".repeat(400);
  const md = [p1, p2, p3].join("\n\n");

  const r = truncateToTokenBudget(md, 150); // fits one ~100-tok paragraph, not two
  expect(r.truncated).toBe(true);
  expect(r.text).toBe(p1); // whole paragraphs only — no partial p1, no p2
  expect(r.paragraphsOmitted).toBe(2);
  expect(r.tokensOmitted).toBeGreaterThan(0);
});

test("always keeps at least the first paragraph even if it alone exceeds budget", () => {
  const big = "X".repeat(4000); // ~1000 tokens, way over a 50-token budget
  const r = truncateToTokenBudget(`${big}\n\nsecond`, 50);
  expect(r.truncated).toBe(true);
  expect(r.text).toBe(big);
  expect(r.paragraphsOmitted).toBe(1);
});

test("a single over-budget paragraph is returned whole and NOT flagged truncated", () => {
  // No paragraph boundary to cut at — better to over-serve than to claim a
  // truncation that omitted zero content.
  const big = "X".repeat(4000);
  const r = truncateToTokenBudget(big, 50);
  expect(r.truncated).toBe(false);
  expect(r.text).toBe(big);
  expect(r.paragraphsOmitted).toBe(0);
  expect(r.tokensOmitted).toBe(0);
});

test("reports tokensShown for the retained text", () => {
  const p1 = "A".repeat(400);
  const p2 = "B".repeat(400);
  const r = truncateToTokenBudget(`${p1}\n\n${p2}`, 150);
  expect(r.tokensShown).toBe(estimateTokens(p1));
});

test("empty input is a no-op", () => {
  const r = truncateToTokenBudget("", 100);
  expect(r.truncated).toBe(false);
  expect(r.text).toBe("");
  expect(r.tokensShown).toBe(0);
});
