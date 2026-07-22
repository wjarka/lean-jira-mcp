/**
 * Environment configuration — the single read path for all config.
 *
 * Credentials come from the host environment, never from tool arguments
 * (DESIGN.md: auth via env). Validated once at startup; missing/blank required
 * values fail fast with a clear, actionable message. Later tool slices read
 * *their* config keys (default project, comment marker) from the object this
 * returns — nothing else should touch `process.env` directly.
 */

import {
  CURATED_FIELD_ENV_VARS,
  type CuratedFieldIds,
  type CuratedFieldKey,
} from "../lib/custom-fields.ts";
import { canonicalizeRoots, defaultAttachmentRoots } from "../lib/attachment-path.ts";
import path from "node:path";

export interface AppConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Default project key for create_issue (issue 04). Optional in v1 skeleton. */
  projectDefault?: string;
  /** Visible comment marker (issues 07/08). Defaults to `:claude:`. */
  commentMarker: string;
  /**
   * Hard byte ceiling for `jira_read_attachment` (issue 16). A file larger than
   * this is REFUSED before download — the response carries a note + the download
   * URL rather than fetching it — as a backstop against pathological files.
   * Configurable via `JIRA_MCP_ATTACHMENT_MAX_BYTES`; defaults to 25 MB.
   */
  attachmentMaxBytes: number;
  /**
   * Allowed roots for `jira_add_attachment` (issue 18) — a canonical path
   * resolving outside ALL of these is refused (the exfiltration guardrail).
   * Configurable via `JIRA_ATTACHMENT_ROOT` (a `path.delimiter`-separated list);
   * defaults to the project cwd and the OS temp dir(s). `~/Downloads` is NOT a
   * default (exfiltration surface) — flows saving there must opt in explicitly.
   */
  attachmentRoots: string[];
  /**
   * Upload size cap for `jira_add_attachment` (issue 18). A file larger than
   * this is refused with a hint BEFORE upload, rather than letting JIRA reject
   * it with a raw 413. Configurable via `JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES`;
   * defaults to 25 MB. (JIRA's own per-instance limit may be lower — that is
   * surfaced if JIRA 413s an under-cap file.)
   */
  attachmentUploadMaxBytes: number;
  /**
   * Explicit `JIRA_FIELD_*` overrides the operator set for the curated agile
   * fields — only the keys actually provided. These win over per-instance
   * detection (issue 13); the read path detects the rest, and the write path
   * (epic-link) routes through the same detected/overridden id (issue 15 A2).
   * Empty when none set.
   */
  curatedFieldOverrides: Partial<CuratedFieldIds>;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

const DEFAULT_COMMENT_MARKER = ":claude:";
/** Default hard byte ceiling for attachment reads: 25 MB. */
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Default upload size cap for jira_add_attachment: 25 MB. */
const DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new EnvError(
      `Missing required environment variable ${name}. ` +
        "See .env.example for the expected configuration.",
    );
  }
  return value.trim();
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseUrl = required("JIRA_BASE_URL", env.JIRA_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new EnvError(
      `JIRA_BASE_URL must be an absolute http(s) URL (got "${baseUrl}"). ` +
        "Example: https://your-domain.atlassian.net",
    );
  }

  // Only the keys the operator explicitly set (off the shared env-var map, so
  // env.ts and the get_issue degradation note can never name different vars).
  const curatedFieldOverrides: Partial<CuratedFieldIds> = {};
  for (const key of Object.keys(CURATED_FIELD_ENV_VARS) as CuratedFieldKey[]) {
    const value = optional(env[CURATED_FIELD_ENV_VARS[key]]);
    if (value) curatedFieldOverrides[key] = value;
  }

  return {
    baseUrl,
    email: required("JIRA_EMAIL", env.JIRA_EMAIL),
    apiToken: required("JIRA_API_TOKEN", env.JIRA_API_TOKEN),
    projectDefault: optional(env.JIRA_PROJECT_DEFAULT),
    commentMarker: optional(env.JIRA_MCP_COMMENT_MARKER) ?? DEFAULT_COMMENT_MARKER,
    attachmentMaxBytes: parsePositiveInt(
      env.JIRA_MCP_ATTACHMENT_MAX_BYTES,
      DEFAULT_ATTACHMENT_MAX_BYTES,
    ),
    attachmentRoots: parseAttachmentRoots(env.JIRA_ATTACHMENT_ROOT),
    attachmentUploadMaxBytes: parsePositiveInt(
      env.JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES,
      DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES,
    ),
    curatedFieldOverrides,
  };
}

/**
 * Parse the `JIRA_ATTACHMENT_ROOT` list (split on the OS path delimiter, `:` on
 * POSIX / `;` on Windows), canonicalized. Falls back to the default roots when
 * unset/blank so agent-produced files (project dir, temp dirs) upload without
 * configuration.
 */
function parseAttachmentRoots(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return defaultAttachmentRoots();
  const roots = canonicalizeRoots(trimmed.split(path.delimiter));
  return roots.length > 0 ? roots : defaultAttachmentRoots();
}

/** Parse a positive integer env var, falling back to `fallback` when absent/invalid. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
