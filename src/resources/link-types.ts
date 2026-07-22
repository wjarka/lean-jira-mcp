/**
 * `link-types` resource — the issue link types available on the instance.
 *
 * Reference data for when `jira_link` lands later (it's out of scope for v1, see
 * the PRD): the agent can see the named relationships ("Blocks", "Relates",
 * each with its inward/outward phrasing) without a tool. An MCP resource, not a
 * tool (PRD user story 43). Handler exported separately for end-to-end tests.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { IJiraClient, JiraIssueLinkType } from "../lib/jira-client.ts";
import { jsonResource } from "./shape.ts";

export const LINK_TYPES_URI = "jira://link-types";

export async function linkTypesResourceHandler(
  jira: Pick<IJiraClient, "listIssueLinkTypes">,
  uri: string = LINK_TYPES_URI,
): Promise<ReadResourceResult> {
  const linkTypes = await jira.listIssueLinkTypes();
  return jsonResource(uri, {
    linkTypes: linkTypes.map((t) => ({
      name: t.name,
      inward: t.inward,
      outward: t.outward,
    })),
    count: linkTypes.length,
    note:
      "Issue link types available on this instance. `inward`/`outward` are the two " +
      "directions of each relationship (e.g. 'is blocked by' / 'blocks').",
  });
}

/**
 * Per-process memoization of the link-type catalog, mirroring
 * {@link createCuratedFieldsProvider}'s cache/inflight shape: a successful
 * fetch is cached for the process lifetime (link types are effectively
 * static). A rejected fetch is NOT cached (`inflight` clears so the next read
 * retries) and NOT swallowed — the rejection propagates unshaped for the
 * resource error boundary (core/server.ts) to catch and shape.
 */
function createLinkTypesCache(
  jira: Pick<IJiraClient, "listIssueLinkTypes">,
): Pick<IJiraClient, "listIssueLinkTypes"> {
  let cached: JiraIssueLinkType[] | null = null;
  let inflight: Promise<JiraIssueLinkType[]> | null = null;

  return {
    listIssueLinkTypes(): Promise<JiraIssueLinkType[]> {
      if (cached) return Promise.resolve(cached);
      if (!inflight) {
        inflight = jira
          .listIssueLinkTypes()
          .then((types) => {
            cached = types;
            return types;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

export function registerLinkTypesResource(server: McpServer, jira: IJiraClient): void {
  const cachedJira = createLinkTypesCache(jira);
  server.registerResource(
    "link-types",
    LINK_TYPES_URI,
    {
      title: "Issue link types",
      description:
        "The named issue link relationships on this instance (e.g. Blocks, Relates), " +
        "each with its inward and outward phrasing.",
      mimeType: "application/json",
    },
    (uri) => linkTypesResourceHandler(cachedJira, uri.toString()),
  );
}
