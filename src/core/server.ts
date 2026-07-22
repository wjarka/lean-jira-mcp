/**
 * MCP server construction. Dependency-injected so tests can build a server
 * around a faked JiraClient without touching env or the network.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { IJiraClient } from "../lib/jira-client.ts";
import type { CuratedFieldsProvider } from "../lib/curated-field-provider.ts";
import { registerAllTools } from "../tools/index.ts";
import { registerAllResources } from "../resources/index.ts";
import { withErrorBoundary, withResourceErrorBoundary } from "../lib/jira-errors.ts";
import type { SearchDeps } from "../tools/search.ts";
import type { CreateIssueDeps } from "../tools/create-issue.ts";
import type { UpdateIssueDeps } from "../tools/update-issue.ts";
import type { CommentDeps } from "../tools/comment.ts";
import type { RegisterReadAttachmentDeps } from "../tools/read-attachment.ts";
import type { AddAttachmentDeps } from "../tools/add-attachment.ts";

export interface ServerDeps {
  jira: IJiraClient;
  /**
   * Resolves the curated agile-field ids per instance (detected + override +
   * default precedence), memoized. Defaults to the common Cloud ids when omitted.
   */
  curatedFieldsProvider?: CuratedFieldsProvider;
  /** Config jira_search needs (the surfaced default project). */
  searchDeps: SearchDeps;
  /** Config the write tools need (default project, base URL, agile field ids). */
  createIssueDeps: CreateIssueDeps;
  /** Config jira_update_issue needs (base URL, agile field ids). */
  updateIssueDeps: UpdateIssueDeps;
  /** Config jira_comment needs (base URL for deep-links, the visible marker). */
  commentDeps: CommentDeps;
  /** Config jira_read_attachment needs (the hard byte ceiling). */
  readAttachmentDeps: RegisterReadAttachmentDeps;
  /**
   * Config jira_add_attachment needs (the allowed upload roots + size cap).
   * Required — the upload tool is security-sensitive, so the scoping roots must
   * be supplied explicitly (from `JIRA_ATTACHMENT_ROOT`/the defaults via env),
   * never silently defaulted at this layer where an embedder could miss them.
   */
  addAttachmentDeps: AddAttachmentDeps;
}

/**
 * Ambient, session-long project grounding. The configured default is SURFACED
 * here (and in the search tool's description) so the agent can decide intent —
 * the server never silently scopes a query. The default-project line is omitted
 * entirely when none is configured, so nothing is invented.
 */
export function buildServerInstructions(projectDefault?: string): string {
  const base =
    "JIRA MCP server. Tools cover a full JIRA workday: search (raw JQL), get/create/update " +
    "issues, transitions, comments, and project discovery (`jira_describe_project`). " +
    "Resolve human references (assignee, project, sprint, status) by name — never pass internal ids.";
  if (!projectDefault) return base;
  return (
    base +
    ` A default project \`${projectDefault}\` is configured. When the user says "the project", ` +
    `"the sprint", or "the backlog" without naming one, scope to \`${projectDefault}\` ` +
    "(e.g. `project = " +
    projectDefault +
    "` in JQL, or omit `project` in create_issue to use the default). " +
    "For a deliberately cross-project request, omit the project filter. If which project they mean " +
    "is genuinely ambiguous, ask rather than guess."
  );
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: "lean-jira-mcp",
      version: "0.1.1",
    },
    {
      instructions: buildServerInstructions(deps.searchDeps.projectDefault),
    },
  );

  wrapToolHandlersWithBoundary(server);
  wrapResourceHandlersWithBoundary(server);
  registerAllTools(
    server,
    deps.jira,
    deps.curatedFieldsProvider,
    deps.searchDeps,
    deps.createIssueDeps,
    deps.updateIssueDeps,
    deps.commentDeps,
    deps.readAttachmentDeps,
    deps.addAttachmentDeps,
  );
  registerAllResources(server, deps.jira);

  return server;
}

/**
 * Intercept `registerTool` so every tool's handler is wrapped in the top-level
 * error boundary — a single choke point, so no current or future tool can leak
 * an unshaped error (e.g. an auth/network throw during reference resolution,
 * which runs before a handler's own try/catch). See {@link withErrorBoundary}.
 */
function wrapToolHandlersWithBoundary(server: McpServer): void {
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (...callArgs: unknown[]) => {
    const last = callArgs.length - 1;
    const handler = callArgs[last] as (...a: unknown[]) => CallToolResult | Promise<CallToolResult>;
    callArgs[last] = withErrorBoundary(handler);
    return original(...callArgs);
  };
}

/**
 * The resource analog of {@link wrapToolHandlersWithBoundary}: intercept
 * `registerResource` so every resource's read handler runs inside the resource
 * error boundary, routing a caught error (a rejected-credentials JiraApiError
 * especially, ADR 0002) through the SAME shaping logic tool calls use. Without
 * it a resource read that hits an auth/network throw leaks a bare, contextless
 * JSON-RPC error instead of the classic-token recovery guidance the identical
 * failure earns on a tool call. See {@link withResourceErrorBoundary} for the
 * choice to surface the failure AS an error rather than as error-shaped contents.
 *
 * Slightly less brittle than the tool interceptor: it wraps the trailing arg
 * ONLY when it is actually the read callback (a function), so a future SDK arity
 * change degrades to an unwrapped passthrough rather than corrupting the call.
 */
function wrapResourceHandlersWithBoundary(server: McpServer): void {
  const original = server.registerResource.bind(server) as (...a: unknown[]) => unknown;
  (server as { registerResource: unknown }).registerResource = (...callArgs: unknown[]) => {
    const last = callArgs.length - 1;
    const handler = callArgs[last];
    if (typeof handler === "function") {
      callArgs[last] = withResourceErrorBoundary(
        handler as (...a: unknown[]) => ReadResourceResult | Promise<ReadResourceResult>,
      );
    }
    return original(...callArgs);
  };
}
