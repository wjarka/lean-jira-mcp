/**
 * Tool registry — the single place every tool is wired into the server.
 * Later slices (issues 02–10) add their `register*Tool` call here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IJiraClient } from "../lib/jira-client.ts";
import type { CuratedFieldsProvider } from "../lib/curated-field-provider.ts";
import { registerSearchTool, type SearchDeps } from "./search.ts";
import { registerGetIssueTool } from "./get-issue.ts";
import { registerCreateIssueTool, type CreateIssueDeps } from "./create-issue.ts";
import { registerUpdateIssueTool, type UpdateIssueDeps } from "./update-issue.ts";
import { registerCommentTool, type CommentDeps } from "./comment.ts";
import { registerGetCommentsTool } from "./get-comments.ts";
import { registerDescribeProjectTool } from "./describe-project.ts";
import { registerTransitionTool } from "./transition.ts";
import { registerReadAttachmentTool, type RegisterReadAttachmentDeps } from "./read-attachment.ts";
import { registerAddAttachmentTool, type AddAttachmentDeps } from "./add-attachment.ts";

export function registerAllTools(
  server: McpServer,
  jira: IJiraClient,
  curatedFieldsProvider: CuratedFieldsProvider | undefined,
  searchDeps: SearchDeps,
  createIssueDeps: CreateIssueDeps,
  updateIssueDeps: UpdateIssueDeps,
  commentDeps: CommentDeps,
  readAttachmentDeps: RegisterReadAttachmentDeps,
  addAttachmentDeps: AddAttachmentDeps,
): void {
  registerSearchTool(server, jira, searchDeps);
  registerGetIssueTool(server, jira, curatedFieldsProvider, commentDeps.marker);
  registerCreateIssueTool(server, jira, createIssueDeps);
  registerUpdateIssueTool(server, jira, updateIssueDeps);
  registerCommentTool(server, jira, commentDeps);
  registerGetCommentsTool(server, jira, { marker: commentDeps.marker });
  registerDescribeProjectTool(server, jira);
  registerTransitionTool(server, jira);
  registerReadAttachmentTool(server, jira, readAttachmentDeps);
  registerAddAttachmentTool(server, jira, addAttachmentDeps);
}
