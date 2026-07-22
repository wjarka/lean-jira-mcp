/**
 * Comment-thread machinery shared by the comment-reading surfaces.
 *
 * `jira_get_comments` exposes a thread as an opaque-cursor, offset-paginated
 * page (the agent never computes offsets). `jira_get_issue` reuses the SAME
 * `getComments` endpoint two ways: `comments:"all"` WALKS every page for the
 * COMPLETE thread, and `comments:"recent"` fetches just the NEWEST page when the
 * bounded comment page the issue GET returns inline is a partial (a long
 * thread) — so "recent" is the genuine newest N, not the tail of the oldest
 * inline page. Both read properties, so every comment carries the `mcp.origin`
 * property needed for `authoredBy`.
 *
 * The cursor codec, the full-thread walk, and the newest-page fetch live here
 * so the pagination contract (opaque cursor in, full coverage) is defined once.
 */

import type { IJiraClient, JiraRestCommentFull } from "./jira-client.ts";

/** JIRA caps a comment page at 100; we walk in full pages for `comments:"all"`. */
const FULL_THREAD_PAGE_SIZE = 100;

/**
 * Opaque pagination cursor. We encode JIRA's offset (`startAt`) so the agent
 * passes a single token back verbatim — exactly the `jira_search` contract —
 * and never sees or computes an offset.
 */
export function encodeCommentCursor(startAt: number): string {
  return Buffer.from(JSON.stringify({ startAt }), "utf8").toString("base64url");
}

/** Decode a cursor back to its offset; null if it's not one we minted. */
export function decodeCommentCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      startAt?: unknown;
    };
    return typeof parsed.startAt === "number" && Number.isInteger(parsed.startAt) && parsed.startAt >= 0
      ? parsed.startAt
      : null;
  } catch {
    return null;
  }
}

/**
 * Walk every page of an issue's thread (oldest-first), expanding properties so
 * authorship resolves property-first. Bounded by the reported `total`, so it
 * always terminates even if a page response is malformed.
 */
export async function fetchAllComments(
  jira: IJiraClient,
  issueKey: string,
): Promise<JiraRestCommentFull[]> {
  const all: JiraRestCommentFull[] = [];
  let startAt = 0;

  for (;;) {
    const page = await jira.getComments({
      issueKey,
      startAt,
      maxResults: FULL_THREAD_PAGE_SIZE,
      orderBy: "created",
      expand: ["properties"],
    });
    const batch = page.comments ?? [];
    all.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= page.total) break;
  }

  return all;
}

/**
 * Fetch the newest `count` comments of a thread in ONE call, without walking
 * every page. The endpoint pages oldest-first, so the newest N sit on the last
 * page: `startAt = max(0, total - count)` returns exactly them (fewer when the
 * thread is shorter than `count`). `total` is the count the issue GET reported;
 * a concurrent add/delete can make the live thread longer or shorter, so the
 * returned page is used as-is — possibly short or empty — rather than assumed to
 * be exactly `count`. Properties are expanded so authorship resolves
 * property-first, matching {@link fetchAllComments}.
 */
export async function fetchNewestComments(
  jira: IJiraClient,
  issueKey: string,
  total: number,
  count: number,
): Promise<JiraRestCommentFull[]> {
  const page = await jira.getComments({
    issueKey,
    startAt: Math.max(0, total - count),
    maxResults: count,
    orderBy: "created",
    expand: ["properties"],
  });
  return page.comments ?? [];
}
