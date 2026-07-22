#!/usr/bin/env bun
/**
 * Entry point: build the JIRA client from env, construct the MCP server, and
 * serve it over stdio.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvConfig } from "./config/env.ts";
import { JiraClient } from "./lib/jira-client.ts";
import { createCuratedFieldsProvider } from "./lib/curated-field-provider.ts";
import { createServer } from "./core/server.ts";
import { log } from "./utils/logging.ts";

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const jira = new JiraClient({
    baseUrl: env.baseUrl,
    email: env.email,
    apiToken: env.apiToken,
  });

  const curatedFieldsProvider = createCuratedFieldsProvider(jira, env.curatedFieldOverrides);

  const server = createServer({
    jira,
    curatedFieldsProvider,
    searchDeps: {
      projectDefault: env.projectDefault,
    },
    createIssueDeps: {
      projectDefault: env.projectDefault,
      baseUrl: env.baseUrl,
      curatedFieldsProvider,
    },
    updateIssueDeps: {
      baseUrl: env.baseUrl,
      curatedFieldsProvider,
    },
    commentDeps: {
      baseUrl: env.baseUrl,
      marker: env.commentMarker,
    },
    readAttachmentDeps: {
      maxBytes: env.attachmentMaxBytes,
    },
    addAttachmentDeps: {
      roots: env.attachmentRoots,
      maxBytes: env.attachmentUploadMaxBytes,
    },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("lean-jira-mcp server connected over stdio");
}

main().catch((err) => {
  log.error("fatal startup error", err instanceof Error ? err.message : err);
  process.exit(1);
});
