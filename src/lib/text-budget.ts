/**
 * Token-budget truncation.
 *
 * Lean-by-default reads cap large rich text at a token budget and tell the
 * agent how much was withheld so it can decide whether to pull the rest.
 * Truncation happens at a paragraph boundary (never mid-sentence): we keep
 * whole `\n\n`-separated blocks until the next one would blow the budget.
 *
 * Token counts are an estimate — a cheap chars/token heuristic, not a real
 * tokenizer. That's deliberate: the number drives a "how much was omitted"
 * hint, not billing, so an approximation the agent can reason about is enough.
 *
 * Shared `lib/` primitive: `jira_get_issue` truncates the summary description
 * here, and the comment serializer reuses {@link CHARS_PER_TOKEN}/{@link
 * estimateTokens} for its preview-snippet cap and `jira_get_comments`'s
 * token-budgeted paging. (Comment *bodies* are never truncated — slice 08.)
 */

/** Rough chars-per-token ratio for English prose / markdown. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The kept prefix of a {@link packUntilBudget} pass plus its drop/size accounting. */
export interface PackResult<T> {
  /** Items kept within budget — always at least the first, when any exist. */
  kept: T[];
  /** How many trailing items were dropped to stay within the budget/count. */
  dropped: number;
  /** Summed `sizeOf` of the kept items (the running total when packing stopped). */
  size: number;
}

/**
 * Pack a PREFIX of `items` into a size budget, always keeping the FIRST item even
 * if it alone exceeds `budget` — better to over-serve one whole unit than return
 * nothing. After the first, each item is kept only while the running size stays
 * within `budget` and (when `maxCount` is given) the kept count stays under it;
 * packing stops at the first item that would breach either limit and never skips
 * ahead to fit a smaller later one, so the kept order is preserved.
 *
 * The single place the lean-read paths express "accumulate whole units until the
 * token budget": `jira_get_issue`'s paragraph truncation, `jira_get_comments`'s
 * page packing (with a comment-count backstop), and `jira_read_attachment`'s PDF
 * page slice all route here, so the always-keep-first rule and the drop
 * accounting live once rather than three times.
 */
export function packUntilBudget<T>(
  items: T[],
  sizeOf: (item: T) => number,
  budget: number,
  maxCount?: number,
): PackResult<T> {
  const kept: T[] = [];
  let size = 0;
  for (const item of items) {
    const cost = sizeOf(item);
    if (kept.length === 0) {
      // Always keep the first item, even if it alone is over budget.
      kept.push(item);
      size = cost;
      continue;
    }
    if (maxCount !== undefined && kept.length >= maxCount) break;
    if (size + cost > budget) break;
    kept.push(item);
    size += cost;
  }
  return { kept, dropped: items.length - kept.length, size };
}

export interface TruncateResult {
  /** The retained text (whole paragraphs only). */
  text: string;
  /** True when at least one paragraph was dropped. */
  truncated: boolean;
  /** Estimated tokens in the retained text. */
  tokensShown: number;
  /** Estimated tokens in the dropped paragraphs. */
  tokensOmitted: number;
  /** Number of paragraphs dropped. */
  paragraphsOmitted: number;
}

/**
 * Truncate `markdown` to at most `maxTokens` estimated tokens, cutting only at
 * paragraph boundaries. At least the first paragraph is always retained, even
 * if it alone exceeds the budget (better to over-serve one block than return
 * nothing).
 */
export function truncateToTokenBudget(markdown: string, maxTokens: number): TruncateResult {
  const full = markdown ?? "";
  if (full.length === 0) {
    return { text: "", truncated: false, tokensShown: 0, tokensOmitted: 0, paragraphsOmitted: 0 };
  }

  const total = estimateTokens(full);
  if (total <= maxTokens) {
    return { text: full, truncated: false, tokensShown: total, tokensOmitted: 0, paragraphsOmitted: 0 };
  }

  const paragraphs = full.split(/\n\n+/);
  const { kept, dropped: paragraphsOmitted } = packUntilBudget(paragraphs, estimateTokens, maxTokens);

  // If nothing was actually dropped (a single over-budget paragraph has no
  // boundary to cut at), report the whole text untruncated rather than claiming
  // a truncation that omitted zero content.
  if (paragraphsOmitted === 0) {
    return { text: full, truncated: false, tokensShown: total, tokensOmitted: 0, paragraphsOmitted: 0 };
  }

  const text = kept.join("\n\n");
  const tokensShown = estimateTokens(text);
  return {
    text,
    truncated: true,
    tokensShown,
    tokensOmitted: Math.max(0, total - tokensShown),
    paragraphsOmitted,
  };
}
