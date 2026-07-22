/**
 * jira_search — search issues with raw JQL.
 *
 * Lean by default: returns compact issue cards, an opaque pagination cursor,
 * and free "scope" (exact total vs "N+ available") derived from `isLast`
 * without a count call. An approximate total is available on opt-in.
 *
 * The handler is exported separately from registration so tests can drive it
 * end-to-end against a faked JiraClient with no transport and no network.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  JiraApiError,
  type IJiraClient,
  type JiraRestIssue,
} from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import {
  CARD_FIELDS,
  isCardField,
  leanFieldValue,
  projectKeyOf,
  toCardFields,
} from "../lib/issue-fields.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const searchInputShape = {
  jql: z
    .string()
    .min(1)
    .describe(
      "A raw JQL query, passed through to JIRA verbatim (e.g. " +
        '`project = ABC AND status = "In Progress" ORDER BY rank`). ' +
        "Use the `jql-fields` resource to discover valid field and custom-field names. " +
        "JIRA enforces permissions via the token, so JQL cannot exceed the token's scope.",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Optional additive list of extra field names to include per card (mostly custom fields). " +
        "The standard card fields are always returned; these are added under `extraFields`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_LIMIT)
    .describe(
      `Max results per page (default ${DEFAULT_LIMIT}). Values above ${MAX_LIMIT} are capped at ${MAX_LIMIT}.`,
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor from a previous response's `nextCursor`. " +
        "Pass it back VERBATIM to fetch the next page — do not parse, modify, or construct it.",
    ),
  includeCount: z
    .boolean()
    .optional()
    .describe(
      "When true, makes one extra call for an APPROXIMATE total (labeled, not exact). " +
        "Omit it unless a reporting intent needs a headline number — scope is otherwise free from `isLast`.",
    ),
};

export const searchInputSchema = z.object(searchInputShape);
export type SearchArgs = z.infer<typeof searchInputSchema>;

/** Config the search tool needs. Mirrors how create gets its default project. */
export interface SearchDeps {
  /**
   * Default project key, when configured. SURFACED to the agent (description +
   * breadth hint), never auto-injected into the JQL — raw JQL stays raw.
   */
  projectDefault?: string;
}

export const SEARCH_DESCRIPTION =
  "Search JIRA issues with a raw JQL query. Returns compact issue cards " +
  "(key, summary, status, type, priority, assignee, labels, updated), an opaque " +
  "pagination cursor, and whether the result set is complete. Lean by default; " +
  "approximate count is opt-in via `includeCount`.";

/**
 * The registered description. When a default project is configured, it tells the
 * agent the scoping convention — surfacing the default so the agent can DECIDE
 * to scope, rather than the server silently deciding for it. The JQL is never
 * rewritten server-side.
 */
export function buildSearchDescription(projectDefault?: string): string {
  if (!projectDefault) return SEARCH_DESCRIPTION;
  return (
    SEARCH_DESCRIPTION +
    ` A default project \`${projectDefault}\` is configured: when the user refers to ` +
    `"the project"/"the sprint" without naming one, add \`project = ${projectDefault}\` to your JQL; ` +
    "omit it for deliberate cross-project queries."
  );
}

/**
 * Best-effort detection of a `project` clause in the JQL string. Used only to
 * decide whether to ADD a breadth hint — never to block or rewrite. A false
 * positive (e.g. the word "project" inside a quoted value) merely suppresses the
 * hint, which is safe.
 */
const PROJECT_CLAUSE =
  /\bproject\s*(=|!=|~|<|>=?|<=|\bin\b|\bnot\b|\bis\b|\bwas\b|\bchanged\b)/i;

interface SearchCard extends Record<string, unknown> {
  key: string;
  extraFields?: Record<string, unknown>;
}

function toCard(issue: JiraRestIssue, extraFields: string[]): SearchCard {
  const f = issue.fields ?? {};
  const card: SearchCard = {
    key: issue.key,
    ...toCardFields(f),
  };

  if (extraFields.length > 0) {
    const extras: Record<string, unknown> = {};
    for (const key of extraFields) {
      if (key in f) extras[key] = leanFieldValue(f[key]);
    }
    if (Object.keys(extras).length > 0) card.extraFields = extras;
  }

  return card;
}

export async function searchHandler(
  jira: IJiraClient,
  args: SearchArgs,
  deps: SearchDeps = {},
): Promise<CallToolResult> {
  const limit = Math.min(args.limit, MAX_LIMIT);
  const clamped = args.limit > MAX_LIMIT;
  // `fields[]` is for EXTRAS only: a name the card already presents (status,
  // priority, …) is dropped silently — it's already in every card, so neither
  // re-requested nor re-emitted as a duplicate block. This keeps a search with
  // card-named fields[] byte-identical to the lean card payload.
  const extraFields = (args.fields ?? []).filter((name) => !isCardField(name));
  const firstPage = args.cursor === undefined;

  try {
    // The count call has no data dependency on the search call (both take only
    // `args.jql`), so fire it alongside search instead of after it. The `.catch`
    // no-ops the promise itself so an early search failure below doesn't leave
    // this rejection unhandled; the real outcome is still read via the awaited
    // `countPromise` further down, preserving the original priority — a search
    // failure throws immediately (matching the old sequential order, where
    // count was never even called), and a count failure (with search OK) still
    // throws from the `await countPromise` below, exactly as it did before.
    const countPromise = args.includeCount ? jira.approximateCount(args.jql) : undefined;
    countPromise?.catch(() => {});

    const result = await jira.searchJql({
      jql: args.jql,
      maxResults: limit,
      nextPageToken: args.cursor,
      fields: [...CARD_FIELDS, ...extraFields],
    });

    const issues = result.issues ?? [];
    const cards = issues.map((issue) => toCard(issue, extraFields));
    const isLast = result.isLast ?? !result.nextPageToken;
    const nextCursor = isLast ? undefined : result.nextPageToken;

    const hints: string[] = [];

    // Scope, free from isLast — no count call needed.
    if (isLast && firstPage) {
      hints.push(`Showing all ${cards.length} result(s) — this is the complete set.`);
    } else if (!isLast) {
      hints.push(
        `${cards.length}+ result(s) available — pass \`nextCursor\` back verbatim as \`cursor\` to fetch the next page.`,
      );
    } else {
      hints.push("Last page reached — no further results.");
    }

    if (clamped) {
      hints.push(`Requested limit exceeded ${MAX_LIMIT}; capped at ${MAX_LIMIT}.`);
    }

    // Read-side breadth safety net (surface, never mutate): if a default project
    // is configured, the agent's JQL didn't scope to a project, and the results
    // span more than one project, flag it and name the default so an unintended
    // cross-project read is caught on the spot. We do NOT rewrite the query.
    if (deps.projectDefault && !PROJECT_CLAUSE.test(args.jql)) {
      const spanned = [...new Set(cards.map((c) => projectKeyOf(c.key)))];
      if (spanned.length > 1) {
        hints.push(
          `Results span ${spanned.join(", ")}; default project ${deps.projectDefault} is configured — ` +
            `add \`project = ${deps.projectDefault}\` to your JQL to scope to it (or keep the query as-is if cross-project was intended).`,
        );
      }
    }

    const data: Record<string, unknown> = {
      issues: cards,
      count: cards.length,
      isLast,
    };
    if (nextCursor !== undefined) data.nextCursor = nextCursor;

    // Opt-in approximate count — already in flight (fired above), so this just
    // reads its outcome rather than starting a new sequential call.
    if (args.includeCount) {
      const { count } = await countPromise!;
      data.approximateCount = count;
      data.countIsApproximate = true;
      hints.push(`Approximate total ~${count} (an estimate, not an exact count).`);
    }

    return shapeSuccess(data, hints);
  } catch (err) {
    if (err instanceof JiraApiError && err.isAuthError) {
      return authErrorResult(err);
    }
    if (err instanceof JiraApiError && err.isJqlError) {
      const message = err.errorMessages.join("; ") || "The JQL query could not be parsed.";
      return shapeError(
        { message, code: "jql_parse_error" },
        [
          "JIRA rejected the JQL. Check field names, custom-field names, and quoting against the `jql-fields` resource (the JQL field catalog), then retry.",
          'Common fixes: quote multi-word values ("In Progress"), use a custom field\'s friendly name, and verify the field actually exists.',
        ],
      );
    }
    if (err instanceof JiraApiError) {
      return genericJiraErrorResult(err);
    }
    return unexpectedErrorResult(err);
  }
}

export function registerSearchTool(
  server: McpServer,
  jira: IJiraClient,
  deps: SearchDeps = {},
): void {
  server.registerTool(
    "jira_search",
    {
      title: "Search JIRA issues (JQL)",
      description: buildSearchDescription(deps.projectDefault),
      inputSchema: searchInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => searchHandler(jira, args, deps),
  );
}
