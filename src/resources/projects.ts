/**
 * `projects` resource — the catalog of every project the token can see.
 *
 * This is an MCP **resource**, not a tool: static, browseable reference data
 * that shouldn't cost a tool slot or re-burn schema budget on every turn (PRD
 * user story 43). It is deliberately distinct from `jira_describe_project`: a
 * flat catalog ("what projects exist?") rather than a per-project workflow map
 * (issue types, statuses, transitions). An agent browses here to find a project
 * KEY, then drills into `describe_project` for the workflow.
 *
 * The handler is exported separately from registration so tests can drive it
 * end-to-end against a faked JiraClient with no transport and no network.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { IJiraClient, JiraProjectSummary } from "../lib/jira-client.ts";
import { jsonResource } from "./shape.ts";

export const PROJECTS_URI = "jira://projects";

export async function projectsResourceHandler(
  jira: Pick<IJiraClient, "listProjects">,
  uri: string = PROJECTS_URI,
): Promise<ReadResourceResult> {
  const projects = await jira.listProjects();
  return jsonResource(uri, {
    projects: projects.map((p) => ({
      key: p.key,
      name: p.name,
      ...(p.projectTypeKey !== undefined ? { type: p.projectTypeKey } : {}),
      ...(p.lead !== undefined ? { lead: p.lead } : {}),
    })),
    count: projects.length,
    note:
      "Catalog of projects visible to the token. Use a `key` with `jira_describe_project` " +
      "to get that project's issue types, statuses, and transition graph.",
  });
}

/**
 * Per-process memoization of the project catalog, mirroring
 * {@link createCuratedFieldsProvider}'s cache/inflight shape: a successful
 * fetch is cached for the process lifetime (the catalog changes rarely, and
 * `jira_search`'s guidance to re-read a resource after an error is really
 * about `jql-fields`, not this one — no TTL needed here either). A rejected
 * fetch is deliberately NOT cached and NOT swallowed: `inflight` still clears
 * so the next read retries, but the rejection itself propagates unshaped out
 * of this closure for the resource error boundary (core/server.ts) to catch
 * and shape, exactly as an uncached read would have failed.
 */
function createProjectsCache(
  jira: Pick<IJiraClient, "listProjects">,
): Pick<IJiraClient, "listProjects"> {
  let cached: JiraProjectSummary[] | null = null;
  let inflight: Promise<JiraProjectSummary[]> | null = null;

  return {
    listProjects(): Promise<JiraProjectSummary[]> {
      if (cached) return Promise.resolve(cached);
      if (!inflight) {
        inflight = jira
          .listProjects()
          .then((projects) => {
            cached = projects;
            return projects;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

export function registerProjectsResource(server: McpServer, jira: IJiraClient): void {
  const cachedJira = createProjectsCache(jira);
  server.registerResource(
    "projects",
    PROJECTS_URI,
    {
      title: "JIRA project catalog",
      description:
        "Catalog of every project the token can see (key, name, type). The flat " +
        "directory to find a project key; drill into `jira_describe_project` for a " +
        "project's workflow.",
      mimeType: "application/json",
    },
    (uri) => projectsResourceHandler(cachedJira, uri.toString()),
  );
}
