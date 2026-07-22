/**
 * Resource registry — the single place every static reference resource is wired
 * into the server, mirroring `tools/index.ts`. These are MCP *resources*
 * (`registerResource`), not tools: browseable reference data that doesn't cost a
 * tool slot (PRD user story 43).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IJiraClient } from "../lib/jira-client.ts";
import { registerProjectsResource } from "./projects.ts";
import { registerJqlFieldsResource } from "./jql-fields.ts";
import { registerLinkTypesResource } from "./link-types.ts";

export function registerAllResources(server: McpServer, jira: IJiraClient): void {
  registerProjectsResource(server, jira);
  registerJqlFieldsResource(server, jira);
  registerLinkTypesResource(server, jira);
}
