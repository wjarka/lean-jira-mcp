/**
 * `jql-fields` resource — the JQL field catalog, including custom field names.
 *
 * This is the resource with a live dependency: `jira_search`'s JQL-parse-error
 * hint points the agent HERE to discover the correct field identifier and
 * self-correct a bad query (PRD user stories 3 & 9). Its entire reason to exist
 * is custom-field discovery, so it surfaces each field's `custom` flag and the
 * `jqlNames` (JIRA's `clauseNames`) that actually work in a clause — for a custom
 * field that's both the quoted friendly name and `cf[NNNNN]`.
 *
 * An MCP resource, not a tool (PRD user story 43): static reference data that
 * shouldn't cost a tool slot. Handler exported separately for end-to-end tests.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { IJiraClient, JiraField } from "../lib/jira-client.ts";
import { jsonResource } from "./shape.ts";

export const JQL_FIELDS_URI = "jira://jql-fields";

function toEntry(f: JiraField) {
  return {
    name: f.name,
    custom: f.custom,
    // The identifiers usable in a JQL clause. Falls back to the field id when
    // JIRA reports no clause names, so every entry is queryable.
    jqlNames: f.clauseNames.length > 0 ? f.clauseNames : [f.id],
    ...(f.schemaType !== undefined ? { type: f.schemaType } : {}),
  };
}

export async function jqlFieldsResourceHandler(
  jira: Pick<IJiraClient, "listFields">,
  uri: string = JQL_FIELDS_URI,
): Promise<ReadResourceResult> {
  const fields = await jira.listFields();
  // Custom fields first — they're the discovery target an agent comes here for.
  const custom = fields.filter((f) => f.custom);
  const system = fields.filter((f) => !f.custom);
  return jsonResource(uri, {
    fields: [...custom, ...system].map(toEntry),
    count: fields.length,
    customFieldCount: custom.length,
    note:
      "Use a value from a field's `jqlNames` in JQL. Custom fields are addressable by " +
      'their quoted name (e.g. "Story Points") or by `cf[ID]`. Quote any multi-word value.',
  });
}

/**
 * Per-process memoization of the field catalog, mirroring
 * {@link createCuratedFieldsProvider}'s cache/inflight shape. `jira_search`'s
 * JQL-parse-error hint sends the agent HERE to self-correct — a session-long
 * cache is still correct (field catalogs change rarely on an instance), so no
 * TTL. A rejected fetch is NOT cached (`inflight` clears so the next read
 * retries) and NOT swallowed here — the rejection propagates unshaped for the
 * resource error boundary (core/server.ts) to catch and shape.
 */
function createJqlFieldsCache(jira: Pick<IJiraClient, "listFields">): Pick<IJiraClient, "listFields"> {
  let cached: JiraField[] | null = null;
  let inflight: Promise<JiraField[]> | null = null;

  return {
    listFields(): Promise<JiraField[]> {
      if (cached) return Promise.resolve(cached);
      if (!inflight) {
        inflight = jira
          .listFields()
          .then((fields) => {
            cached = fields;
            return fields;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

export function registerJqlFieldsResource(server: McpServer, jira: IJiraClient): void {
  const cachedJira = createJqlFieldsCache(jira);
  server.registerResource(
    "jql-fields",
    JQL_FIELDS_URI,
    {
      title: "JQL field catalog",
      description:
        "Every field queryable in JQL, including custom fields, with the identifiers " +
        "(`jqlNames`) that work in a clause. Consult this to correct a JQL field reference " +
        "after a parse error from `jira_search`.",
      mimeType: "application/json",
    },
    (uri) => jqlFieldsResourceHandler(cachedJira, uri.toString()),
  );
}
