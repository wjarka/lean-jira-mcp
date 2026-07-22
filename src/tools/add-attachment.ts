/**
 * jira_add_attachment — the 10th tool: attach ONE local file to an issue by path.
 *
 * Earns a tool on the `read_attachment` precedent — a distinct binary *write*
 * with its own mechanism (multipart), byte-source resolution, and failure modes.
 * NOT folded into update_issue: attachments aren't a field, and a multipart write
 * would muddy the field-setter. Source is a local filesystem PATH only — URL
 * fetch is a deferred fast-follow, and base64-inline / "context image" are
 * architecturally rejected (the model has no bytes for an image it merely saw).
 *
 * Upload is outward-facing AND prompt-injectable, so the path is the security
 * surface, handled in `lib/attachment-path.ts`:
 *   - scope to configured roots (default: project cwd + OS temp dirs),
 *     refusing anything resolving (after `..`/symlink) outside them — this blocks
 *     the "attach ~/.ssh/id_rsa to PUBLIC-1" exfiltration vector;
 *   - denylist dotfiles / key material even inside a root (defense in depth).
 *
 * Other guardrails: a size cap → a hint (never a raw 413); MIME detected from
 * CONTENT (not extension) and sent as the multipart Content-Type; a same-name
 * collision refused unless `allowDuplicate:true` (JIRA silently allows dupes, we
 * don't — degrade visibly); one file per call. Success surfaces what was shipped
 * (filename, size, type, destination issue) because it's outward-facing.
 *
 * The handler is exported separately from registration so tests drive it
 * end-to-end against a faked JiraClient with real temp files on disk.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { JiraApiError, type IJiraClient } from "../lib/jira-client.ts";
import { shapeError, shapeSuccess } from "../lib/response-shaper.ts";
import {
  authErrorResult,
  genericJiraErrorResult,
  unexpectedErrorResult,
} from "../lib/jira-errors.ts";
import { formatBytes, serializeAttachments } from "../lib/attachments.ts";
import { detectMimeType } from "../lib/mime-detect.ts";
import { resolveAttachmentPath, type ResolvedAttachmentPath } from "../lib/attachment-path.ts";

export interface AddAttachmentDeps {
  /** Canonical allowed roots a path must resolve inside (the exfil guardrail). */
  roots: string[];
  /** Upload size cap — a larger file is refused with a hint, not a raw 413. */
  maxBytes: number;
}

export const addAttachmentInputShape = {
  issueKey: z
    .string()
    .min(1)
    .describe("The issue to attach the file to, e.g. `PROJ-12`."),
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute (or `~`-prefixed) filesystem path to the ONE file to upload. The file must " +
        "already exist ON DISK — a file the host tooling saved, an exported/downloaded asset, " +
        "or a file in the project. An image you only SAW in context is " +
        "NOT attachable (there are no bytes to send). Paths are scoped to safe roots (by default " +
        "the project dir and temp dirs; extendable via JIRA_ATTACHMENT_ROOT); a path " +
        "outside them, or a sensitive file (.ssh, .env, dotfiles, keys), is refused.",
    ),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe(
      "When the issue already has an attachment with the same filename, the upload is refused by " +
        "default (JIRA silently allows duplicates; this tool does not). Pass `true` to add a second " +
        "copy anyway.",
    ),
};

export const addAttachmentInputSchema = z.object(addAttachmentInputShape);
export type AddAttachmentArgs = z.infer<typeof addAttachmentInputSchema>;

export const ADD_ATTACHMENT_DESCRIPTION =
  "Attach ONE local file to an issue by filesystem path (multipart upload). The file must already " +
  "exist ON DISK — a file the host tooling saved (a capture, an export, a download), " +
  "or a file in the project. An image you only SAW in your context is NOT attachable: there " +
  "are no bytes to send and no mechanism to pass them. Paths are scoped to safe roots (by default " +
  "the project dir + temp dirs) and sensitive files (.ssh, .env, dotfiles, keys) are refused, " +
  "so a path can't exfiltrate. MIME type is detected from content. A same-name file is refused unless " +
  "allowDuplicate:true. One file per call. The upload is visible to anyone who can see the issue.";

/** Map a path-resolution refusal to a specific, recoverable hint. */
function pathRejection(
  inputPath: string,
  rejected: Extract<ResolvedAttachmentPath, { ok: false }>,
  roots: string[],
): CallToolResult {
  switch (rejected.reason) {
    case "not_found":
      return shapeError(
        { message: `No file exists at ${inputPath}.`, code: "path_not_found" },
        [
          `Nothing was found at \`${inputPath}\` (resolved to \`${rejected.absPath}\`). The file must ` +
            "exist ON DISK to upload — an image you only saw in context has no bytes to send. Check " +
            "the path, or have the host save the file to disk first.",
        ],
      );
    case "unreadable":
      return shapeError(
        { message: `Can't read ${inputPath}.`, code: "path_unreadable" },
        [
          `\`${inputPath}\` exists but couldn't be read (permissions, or it's a special file). ` +
            "Check the file is readable and is a regular file, then retry.",
        ],
      );
    case "not_file":
      return shapeError(
        { message: `${inputPath} is not a regular file.`, code: "path_not_file" },
        [
          `\`${inputPath}\` is a directory (or other non-file). Upload one regular file per call — ` +
            "point `path` at a single file.",
        ],
      );
    case "outside_root":
      return shapeError(
        {
          message: `${inputPath} resolves outside the allowed attachment roots.`,
          code: "path_outside_root",
          options: { allowedRoots: roots },
        },
        [
          `\`${inputPath}\`${rejected.canonicalPath && rejected.canonicalPath !== rejected.absPath ? ` (a symlink to \`${rejected.canonicalPath}\`)` : ""} ` +
            `is outside every allowed attachment root: ${roots.map((r) => `\`${r}\``).join(", ")}. ` +
            "This scoping prevents a path from exfiltrating files like `~/.ssh/id_rsa`. Move the file " +
            "into one of those roots (e.g. the project dir or a temp dir) and retry, or set " +
            "`JIRA_ATTACHMENT_ROOT` to include its location.",
        ],
      );
    case "denylisted":
      return shapeError(
        {
          message: `${inputPath} matches the sensitive-file denylist and won't be uploaded.`,
          code: "path_denylisted",
        },
        [
          `\`${inputPath}\` matches the sensitive-file denylist (dotfiles, \`.ssh\`, \`.env\`, private ` +
            "keys, credentials) and is refused even though it's inside an allowed root — defense " +
            "against leaking secrets. If this file is genuinely safe to share, copy it to a " +
            "non-sensitive name/location and retry.",
        ],
      );
  }
}

/** Map an upload/dupe-check JIRA error to a shaped, recoverable result. */
function jiraError(issueKey: string, filename: string, size: number, err: unknown): CallToolResult {
  if (err instanceof JiraApiError) {
    if (err.isAuthError) return authErrorResult(err);
    if (err.isNotFound) {
      return shapeError(
        { message: `Issue ${issueKey} was not found.`, code: "issue_not_found" },
        [
          `No issue matched \`${issueKey}\` (it may not exist, or the token can't see it). Verify the ` +
            "key with `jira_search` or `jira_get_issue`, then retry.",
        ],
      );
    }
    // 413 → a clean size hint, never a raw 413. Keyed on the status code, not
    // the message text: a 4xx whose prose merely mentions "size"/"maximum" (a
    // field-validation error) must NOT be mis-mapped to "too large".
    if (err.status === 413) {
      return shapeError(
        { message: `JIRA rejected ${filename} as too large.`, code: "attachment_too_large" },
        [
          `JIRA rejected \`${filename}\` (${formatBytes(size)}) — it exceeds this instance's attachment ` +
            "size limit (set by a JIRA admin, and lower than the server's own cap). Reduce the file " +
            "size (e.g. downscale the image) and retry.",
        ],
      );
    }
    return genericJiraErrorResult(err);
  }
  return unexpectedErrorResult(err);
}

export async function addAttachmentHandler(
  jira: IJiraClient,
  args: AddAttachmentArgs,
  deps: AddAttachmentDeps,
): Promise<CallToolResult> {
  // 1. Resolve + security-check the path FIRST — local, and the guardrail. No
  //    network touched until the path is proven safe.
  const resolved = resolveAttachmentPath(args.path, deps.roots);
  if (!resolved.ok) return pathRejection(args.path, resolved, deps.roots);

  const { canonicalPath, filename, size } = resolved;

  // 2. Size guardrails (using the stat size — no bytes read yet). An over-cap
  //    file → a hint, not a raw 413 from JIRA later; a 0-byte file → a hint
  //    (JIRA rejects/uselessly stores empty attachments — degrade visibly).
  if (size === 0) {
    return shapeError(
      { message: `${filename} is empty (0 bytes).`, code: "attachment_empty" },
      [
        `\`${filename}\` is empty (0 bytes) — there's nothing to attach. If a save step produced an ` +
          "empty file (e.g. a screenshot that didn't render), regenerate it and retry.",
      ],
    );
  }
  if (size > deps.maxBytes) {
    return shapeError(
      {
        message: `${filename} is ${formatBytes(size)}, over the ${formatBytes(deps.maxBytes)} upload cap.`,
        code: "attachment_too_large",
      },
      [
        `\`${filename}\` (${formatBytes(size)}) exceeds the ${formatBytes(deps.maxBytes)} upload cap. ` +
          "Reduce the file size (e.g. downscale a screenshot), or raise `JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES`. " +
          "Note JIRA may also enforce a smaller per-instance limit.",
      ],
    );
  }

  // 3. Duplicate-name check (unless opted out) BEFORE reading bytes: it needs
  //    only the filename (known from path resolution), so a refusal here avoids
  //    reading a (potentially large) file we won't upload. JIRA silently allows
  //    same-name dupes and can't overwrite without a destructive delete, so we
  //    refuse and let the agent decide — nothing happens, fully reversible.
  if (!args.allowDuplicate) {
    let existing;
    try {
      existing = await jira.getIssue({ issueKey: args.issueKey, fields: ["attachment"] });
    } catch (err) {
      return jiraError(args.issueKey, filename, size, err);
    }
    const dupe = serializeAttachments(existing.fields?.attachment).find(
      (a) => a.filename === filename,
    );
    if (dupe) {
      return shapeError(
        {
          message: `${args.issueKey} already has an attachment named '${filename}'.`,
          code: "duplicate_attachment",
        },
        [
          `${args.issueKey} already has an attachment named '${filename}'. Pass allowDuplicate:true to ` +
            "add a second copy (JIRA keeps both — it can't overwrite without a destructive delete).",
        ],
      );
    }
  }

  // 4. Read the bytes (under the cap, not a dupe) and detect MIME from CONTENT,
  //    not extension. NOTE: this is a fresh traversal of canonicalPath — there
  //    is a small TOCTOU window vs. the resolve-time check, but the threat model
  //    here is a prompt-injected PATH (blocked at resolve), not a concurrent
  //    local attacker racing the filesystem (a higher-privilege, out-of-scope
  //    threat for a single-user stdio server).
  let bytes: Buffer;
  try {
    bytes = readFileSync(canonicalPath);
  } catch {
    return pathRejection(args.path, { ok: false, reason: "unreadable", absPath: canonicalPath }, deps.roots);
  }
  const mimeType = detectMimeType(bytes, filename);

  // 5. Upload via multipart through the JiraClient seam.
  let uploaded;
  try {
    uploaded = await jira.addAttachment({ issueKey: args.issueKey, filename, mimeType, data: bytes });
  } catch (err) {
    return jiraError(args.issueKey, filename, size, err);
  }

  const created = uploaded[0];
  if (!created) {
    // JIRA accepted the request but returned no attachment — surface it rather
    // than reporting a phantom success.
    return shapeError(
      { message: `JIRA accepted the upload of ${filename} but returned no attachment.`, code: "upload_no_result" },
      [
        `The upload of \`${filename}\` to ${args.issueKey} returned no attachment record. Check the ` +
          "issue with `jira_get_issue` `detail:\"full\"` to confirm whether it landed before retrying.",
      ],
    );
  }

  return shapeSuccess(
    {
      id: created.id,
      filename: created.filename,
      size: created.size,
      mimeType: created.mimeType,
      issueKey: args.issueKey,
    },
    [
      `Uploaded ${created.filename} (${formatBytes(created.size)}, ${created.mimeType}) to ` +
        `${args.issueKey} — it's now visible as an attachment on the issue to anyone who can see ` +
        `${args.issueKey}. Find it via jira_get_issue (detail:"full") or read it with jira_read_attachment.`,
    ],
  );
}

export function registerAddAttachmentTool(
  server: McpServer,
  jira: IJiraClient,
  deps: AddAttachmentDeps,
): void {
  server.registerTool(
    "jira_add_attachment",
    {
      title: "Attach a file to a JIRA issue",
      description: ADD_ATTACHMENT_DESCRIPTION,
      inputSchema: addAttachmentInputShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => addAttachmentHandler(jira, args, deps),
  );
}
