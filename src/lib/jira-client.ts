/**
 * JiraClient — the single HTTP boundary to JIRA Cloud.
 *
 * This is the project's one external test seam. It owns:
 *   - auth (HTTP basic: email + API token),
 *   - rate-limit handling + retry/backoff for transient failures,
 *   - turning non-2xx responses into typed {@link JiraApiError}s.
 *
 * Tool handlers depend on the {@link IJiraClient} interface, never on `fetch`.
 * Handler tests inject a fake `IJiraClient` (see test/helpers/fake-jira-client.ts);
 * the retry/backoff logic here is tested against an injected fake `fetch`.
 */

import { log } from "../utils/logging.ts";
import { summarizeRequires } from "./workflow-rules.ts";

// --- REST shapes (the canned payloads fakes return) -------------------------

export interface JiraRestIssue {
  id?: string;
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraSearchResult {
  issues: JiraRestIssue[];
  /** Opaque continuation token; absent on the last page. */
  nextPageToken?: string;
  /** Some deployments return this explicitly; otherwise derived from nextPageToken. */
  isLast?: boolean;
}

export interface JiraApproximateCount {
  count: number;
}

export interface JiraSearchParams {
  jql: string;
  maxResults?: number;
  nextPageToken?: string;
  fields?: string[];
}

export interface JiraGetIssueParams {
  issueKey: string;
  /** Explicit field list; lean reads request only what they render. */
  fields?: string[];
  /** Expand directives (e.g. comment properties in later slices). */
  expand?: string[];
}

/** A create/update payload split into JIRA's native `fields` (set) and `update` (ops). */
export interface JiraWritePayload {
  fields?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

/** What `POST /rest/api/3/issue` returns. */
export interface JiraCreatedIssue {
  id: string;
  key: string;
  self?: string;
}

/** A partial-update payload (`PUT /rest/api/3/issue/{key}`) targeting one issue. */
export interface JiraUpdateIssueParams extends JiraWritePayload {
  issueKey: string;
}

/** A user as the resolver consumes it. accountId is never surfaced to the agent. */
export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

/**
 * A project's managed style. `next-gen`/`simplified` is team-managed (parent
 * field for epic membership); `classic` is company-managed (Epic Link field).
 */
export interface JiraProject {
  id: string;
  key: string;
  name?: string;
  /** Project description, when JIRA reports it. Backs describe_project's identity echo. */
  description?: string;
  /** Display name of the project lead, when JIRA reports it. */
  lead?: string;
  style?: string;
  simplified?: boolean;
  /**
   * The project's issue types, by friendly name. Populated by `getProject`
   * (the project endpoint returns them inline); backs `jira_describe_project`'s
   * tier-1 listing and its invalid-issue-type recovery hint.
   */
  issueTypes?: { id: string; name: string }[];
}

/** One sprint on a board, as the Agile API reports it. Closed sprints are excluded by the client. */
export interface JiraBoardSprint {
  id: number;
  name: string;
  /** `active` or `future` (open sprints). Both are valid assignment targets. */
  state: string;
}

/**
 * A project's board plus its open sprints. `type` is JIRA's board type
 * (`scrum` | `kanban` | `simple`); a Kanban board never supports sprints, so it
 * always carries an empty `sprints` (its `/sprint` endpoint 400s and is never
 * queried). Backs both `describe_project`'s `boards[]` discovery and the sprint
 * resolver's sprint-supporting-board filtering.
 */
export interface JiraProjectBoard {
  id: number;
  name: string;
  type: string;
  sprints: JiraBoardSprint[];
}

/**
 * Whether a board can carry sprints. Only `kanban` boards categorically cannot
 * (their `/sprint` endpoint 400s). `scrum` and team-managed (`next-gen`,
 * reported as `simple`) boards do — so the filter is "not kanban", NOT
 * "scrum only": an allowlist of `scrum` alone would silently exclude every
 * team-managed project's sprints. Compared case-insensitively.
 */
export function boardSupportsSprints(boardType: string): boolean {
  return boardType.trim().toLowerCase() !== "kanban";
}

// --- static reference data (the `resources/` registry) ----------------------

/**
 * A project as the `projects` resource catalog lists it. Deliberately FLAT —
 * key, name, type — and distinct from {@link JiraProject}'s drill-down shape
 * (issue types) and from `describe_project`'s per-project workflow. This is the
 * "what projects can I see?" catalog, nothing more.
 */
export interface JiraProjectSummary {
  key: string;
  name: string;
  id: string;
  /** JIRA's `projectTypeKey` — e.g. "software", "service_desk", "business". */
  projectTypeKey?: string;
  /** Display name of the project lead, when JIRA reports it. */
  lead?: string;
}

/**
 * One field from the JQL field catalog (`jql-fields` resource). The whole point
 * of this resource is custom-field discovery: `custom` flags a custom field and
 * `clauseNames` carries the identifiers that actually work in a JQL clause
 * (JIRA's own `clauseNames` — for a custom field these include both the friendly
 * name and `cf[NNNNN]`), so an agent can correct a bad JQL field reference.
 */
export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  /** Identifiers usable in a JQL clause (e.g. `["Story Points", "cf[10016]"]`). */
  clauseNames: string[];
  /** Schema type (e.g. "string", "number", "user"), when present. */
  schemaType?: string;
  /**
   * The field's `schema.custom` key (e.g. `com.pyxis.greenhopper.jira:gh-sprint`),
   * when present. This is the stable, per-instance-invariant identity of an agile
   * custom field — curated-field detection (issue 13) matches on it rather than on
   * the volatile `customfield_XXXXX` id.
   */
  schemaCustom?: string;
}

/** An issue link type (`link-types` resource), for when `jira_link` lands later. */
export interface JiraIssueLinkType {
  id: string;
  name: string;
  /** The inward relationship phrase, e.g. "is blocked by". */
  inward: string;
  /** The outward relationship phrase, e.g. "blocks". */
  outward: string;
}

/**
 * Normalized createmeta — fetched ONLY on a create failure, never proactively
 * (it's the round-trip tax the design deliberately avoids). `issueTypes` backs
 * the invalid-issuetype hint; `requiredFields` (for the requested type) backs
 * the missing-required-field hint.
 */
export interface JiraCreateMetaField {
  fieldId: string;
  name: string;
}

export interface JiraCreateMeta {
  issueTypes: { id: string; name: string }[];
  requiredFields: JiraCreateMetaField[];
}

export interface JiraCreateMetaParams {
  projectKey: string;
  /** When given, `requiredFields` is populated for this type. */
  issuetypeName?: string;
}

// --- workflow (describe_project) --------------------------------------------

/**
 * One workflow transition, normalized to status NAMES (never numeric ids).
 * A global transition (firable from any status) has `isGlobal:true` and an empty
 * `fromStatuses`; a directed transition lists the source status name(s) it leaves
 * from. The handler expands this into the agent-facing `{name, from, to}` edge
 * list, with global edges rendered as `from:"*"`.
 */
export interface JiraWorkflowTransition {
  name: string;
  /** Target status name. */
  toStatus: string;
  /** Source status names; empty when `isGlobal` (firable from anywhere). */
  fromStatuses: string[];
  isGlobal: boolean;
  /**
   * Terse human-readable phrases for the gates (conditions + validators) this
   * transition defines, derived from the workflow PREVIEW read (issue 19). Each
   * phrase describes a gate's TYPE, never its parameters (preview carries no
   * role/field/value). `[]` means ungated — but ONLY trust that under
   * {@link JiraProjectWorkflow.ruleFidelity} `"full"`; under `"topology"` a
   * missing/empty `requires` means UNKNOWN. Post-functions and triggers are
   * deliberately excluded (side-effects, not gates).
   */
  requires?: string[];
  /**
   * True when JIRA has a transition SCREEN (a form) configured on this edge.
   * Note: HAS a screen, not NEEDS input — a screen may carry only optional
   * fields, so the edge can still fire with no payload. The authoritative "you
   * must supply X" signal is `jira_transition`'s per-issue required-field check,
   * which reads each field's `required` flag (data preview does not carry).
   */
  hasScreen?: boolean;
}

/**
 * A project's workflow for ONE issue type, normalized so company-managed and
 * team-managed projects yield the identical shape. Status references and numeric
 * transition ids are resolved to names at this boundary, never surfaced.
 */
export interface JiraProjectWorkflow {
  /** Status names available for the issue type. */
  statuses: string[];
  transitions: JiraWorkflowTransition[];
  /**
   * How much gate truth the transitions carry, set from WHAT WAS PARSED — never
   * from "is this token admin" (issue 19, section A: the rules ride the
   * always-available preview read, so there is no admin probe).
   *   - `"full"`   — the workflow definition was read; `requires`/`hasScreen`
   *                  are authoritative, so a missing `requires` means UNGATED.
   *   - `"topology"` — the workflow definition could NOT be read (statuses-only
   *                  degradation); a missing `requires` means UNKNOWN, not none.
   */
  ruleFidelity: "full" | "topology";
}

export interface JiraProjectWorkflowParams {
  projectKey: string;
  issueType: string;
  /**
   * The project's numeric id, when the caller already holds it (avoids a
   * redundant project fetch). Falls back to looking the project up when absent.
   */
  projectId?: string;
}

/**
 * company- vs team-managed, the single source of truth for that classification.
 * Team-managed (next-gen / simplified) projects express epic membership through
 * the native `parent` field and expose a per-type workflow; company-managed
 * (classic) projects use the Epic Link field. Both parent resolution and
 * `describe_project`'s project-type reporting key off this one function so they
 * can never disagree.
 */
export function isTeamManaged(project: JiraProject): boolean {
  return project.style === "next-gen" || project.simplified === true;
}

// --- transitions (jira_transition) ------------------------------------------

/**
 * A field on a transition's screen, normalized from the `expand=transitions.fields`
 * map JIRA returns keyed by field id. `required` drives `jira_transition`'s
 * PROACTIVE screen-field check: the same `/transitions` read that resolves the
 * transition name yields these for free, so a missing required field is reported
 * up front rather than after a failed transition attempt. `name` is the friendly
 * label surfaced in hints — the agent never has to read a raw `customfield_*` id.
 */
export interface JiraTransitionField {
  /** The id JIRA keys the transition `fields` payload by (e.g. `resolution`). */
  fieldId: string;
  name: string;
  required: boolean;
}

/**
 * One transition available FROM an issue's current status, normalized from
 * `GET .../transitions?expand=transitions.fields`. The numeric `id` is the only
 * thing JIRA's execute endpoint accepts; it stays inside the server — the agent
 * addresses a transition by name or target status, never by id.
 */
export interface JiraAvailableTransition {
  id: string;
  name: string;
  /** Target status name. */
  toStatus: string;
  /** Screen fields (present when `expand=transitions.fields` was requested). */
  fields: JiraTransitionField[];
}

export interface JiraGetTransitionsParams {
  issueKey: string;
}

export interface JiraDoTransitionParams {
  issueKey: string;
  /** The resolved numeric transition id (never surfaced to the agent). */
  transitionId: string;
  /** Screen-field values to set during the transition (JIRA's `fields` object). */
  fields?: Record<string, unknown>;
}

// --- comments ---------------------------------------------------------------

/** A comment visibility restriction (role or group). Default is unrestricted. */
export interface JiraCommentVisibility {
  type: "role" | "group";
  /** Role name or group name. */
  value: string;
}

/** An out-of-band comment property — the authorship machine truth lives here. */
export interface JiraCommentProperty {
  key: string;
  value: unknown;
}

/**
 * A comment as JIRA returns it on write / get. `properties` is populated only
 * when requested via `expand=properties` (the edit guard needs it to resolve
 * authorship before replacing the body).
 */
export interface JiraRestCommentFull {
  id: string;
  author?: { displayName?: string; accountId?: string } | null;
  body?: unknown;
  created?: string;
  updated?: string;
  visibility?: JiraCommentVisibility;
  properties?: JiraCommentProperty[];
}

export interface JiraAddCommentParams {
  issueKey: string;
  /** ADF document. */
  body: unknown;
  visibility?: JiraCommentVisibility;
  /** Stamped on write; the server always sends the origin property. */
  properties?: JiraCommentProperty[];
  /** e.g. `["properties"]` to read the stamped property back. */
  expand?: string[];
}

export interface JiraUpdateCommentParams extends JiraAddCommentParams {
  commentId: string;
}

export interface JiraGetCommentParams {
  issueKey: string;
  commentId: string;
  expand?: string[];
}

/** One page of an issue's comments (the list endpoint is offset-paginated). */
export interface JiraCommentsPage {
  comments: JiraRestCommentFull[];
  startAt: number;
  maxResults: number;
  total: number;
}

export interface JiraGetCommentsParams {
  issueKey: string;
  /** Offset of the first comment to return (0-based). */
  startAt?: number;
  maxResults?: number;
  /** `created` (oldest first) or `-created` (newest first). */
  orderBy?: "created" | "-created";
  /** e.g. `["properties"]` to read each comment's authorship property. */
  expand?: string[];
}

// --- attachments (jira_read_attachment) -------------------------------------

/**
 * One attachment's metadata, normalized from the issue's `attachment` field and
 * from `GET /rest/api/3/attachment/{id}`. Deliberately small and bounded — it is
 * the "find" surface (rides `get_issue`) and the sized read decision for
 * `jira_read_attachment` (the byte ceiling is checked against `size` BEFORE any
 * content download). `contentUrl` is JIRA's authenticated content endpoint, also
 * surfaced to the agent as the download link when a file can't be inlined.
 */
export interface JiraAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  /** Size in bytes, as JIRA reports it. */
  size: number;
  created: string | null;
  /** Author display name, or null when JIRA omits it. */
  author: string | null;
  /** The authenticated content endpoint (JIRA's `content` URL). */
  contentUrl: string | null;
}

/** Params for a single-file multipart attachment upload. */
export interface JiraAddAttachmentParams {
  issueKey: string;
  /** The name JIRA stores the attachment under. */
  filename: string;
  /** Content-Type sent in the multipart part (detected from content, not extension). */
  mimeType: string;
  /** The file's raw bytes. */
  data: Buffer;
}

/** One attachment as JIRA returns it from the upload endpoint (an array of these). */
export interface JiraUploadedAttachment {
  id: string;
  filename: string;
  /** Size in bytes, as JIRA reports it back. */
  size: number;
  mimeType: string;
}

export interface IJiraClient {
  searchJql(params: JiraSearchParams): Promise<JiraSearchResult>;
  approximateCount(jql: string): Promise<JiraApproximateCount>;
  getIssue(params: JiraGetIssueParams): Promise<JiraRestIssue>;
  createIssue(payload: JiraWritePayload): Promise<JiraCreatedIssue>;
  /** Apply a partial update — `fields` (set) + `update` (add/remove/set ops) — to one issue. */
  updateIssue(params: JiraUpdateIssueParams): Promise<void>;
  /** Fetched only on a create failure, to build a recovery hint. */
  getCreateMeta(params: JiraCreateMetaParams): Promise<JiraCreateMeta>;
  searchUsers(query: string): Promise<JiraUser[]>;
  getCurrentUser(): Promise<JiraUser>;
  getProject(projectKey: string): Promise<JiraProject>;
  /** A project issue type's workflow (statuses + named transition graph), company/team uniform. */
  getProjectWorkflow(params: JiraProjectWorkflowParams): Promise<JiraProjectWorkflow>;
  /**
   * Transitions available from an issue's CURRENT status, with each transition's
   * screen fields (expand=transitions.fields) — one read backs both name
   * resolution and the proactive required-field check in `jira_transition`.
   */
  getTransitions(params: JiraGetTransitionsParams): Promise<JiraAvailableTransition[]>;
  /** Execute a resolved transition by numeric id, optionally setting screen fields. */
  doTransition(params: JiraDoTransitionParams): Promise<void>;
  /**
   * A project's boards, each with its open (active+future) sprints. Backs
   * `describe_project`'s `boards[]` and the sprint resolver's scrum-board
   * filter. Sprints are fetched only for scrum boards (Kanban boards 400).
   */
  listProjectBoards(projectKey: string): Promise<JiraProjectBoard[]>;
  /**
   * Add an issue to a sprint via the Agile MOVE endpoint
   * (`POST /rest/agile/1.0/sprint/{id}/issue`). Screen-independent — it does not
   * touch the Sprint custom field, so it works regardless of the field's screen
   * configuration. This is the sprint-WRITE mechanism (issue 15).
   */
  addIssueToSprint(sprintId: number, issueKey: string): Promise<void>;
  /**
   * Move an issue to the backlog (`POST /rest/agile/1.0/backlog/issue`),
   * clearing its sprint membership. The clear counterpart to {@link addIssueToSprint}.
   */
  moveIssueToBacklog(issueKey: string): Promise<void>;
  /** Post a comment (with authorship property + visibility). */
  addComment(params: JiraAddCommentParams): Promise<JiraRestCommentFull>;
  /** Replace an existing comment's body (PUT) — re-stamps property + marker. */
  updateComment(params: JiraUpdateCommentParams): Promise<JiraRestCommentFull>;
  /** Fetch a single comment; `expand:["properties"]` backs the edit guard. */
  getComment(params: JiraGetCommentParams): Promise<JiraRestCommentFull>;
  /** Read an issue's comments, offset-paginated; `expand:["properties"]` backs `authoredBy`. */
  getComments(params: JiraGetCommentsParams): Promise<JiraCommentsPage>;
  /** Project role names, fetched only on a visibility failure for the hint. */
  getProjectRoles(projectKey: string): Promise<string[]>;
  /** Catalog of every project the token can see (backs the `projects` resource). */
  listProjects(): Promise<JiraProjectSummary[]>;
  /** The JQL field catalog incl. custom field names (backs the `jql-fields` resource). */
  listFields(): Promise<JiraField[]>;
  /** Available issue link types (backs the `link-types` resource). */
  listIssueLinkTypes(): Promise<JiraIssueLinkType[]>;
  /**
   * One attachment's metadata (`GET /rest/api/3/attachment/{id}`). Read FIRST by
   * `jira_read_attachment` so the size/mime drive the read decision (and the hard
   * byte ceiling) before any content is fetched.
   */
  getAttachmentMeta(attachmentId: string): Promise<JiraAttachmentMeta>;
  /**
   * One attachment's raw bytes (`GET /rest/api/3/attachment/content/{id}`). The
   * endpoint 303-redirects to a signed media URL, which `fetch` follows. Returns
   * the bytes only — the mime type comes from {@link getAttachmentMeta} (the
   * media redirect commonly reports a generic `application/octet-stream`).
   */
  getAttachmentContent(attachmentId: string): Promise<Buffer>;
  /**
   * Upload ONE file to an issue via multipart
   * (`POST /rest/api/3/issue/{key}/attachments`, `X-Atlassian-Token: no-check`).
   * Returns the created attachment(s) JIRA echoes back (an array, even for one
   * file). Shares the client's auth + retry/backoff like every other call.
   */
  addAttachment(params: JiraAddAttachmentParams): Promise<JiraUploadedAttachment[]>;
}

// --- Errors -----------------------------------------------------------------

export class JiraApiError extends Error {
  readonly status: number;
  readonly errorMessages: string[];
  readonly errors: Record<string, string>;

  constructor(
    status: number,
    errorMessages: string[],
    errors: Record<string, string>,
    message?: string,
  ) {
    super(message ?? errorMessages[0] ?? `JIRA request failed with status ${status}`);
    this.name = "JiraApiError";
    this.status = status;
    this.errorMessages = errorMessages;
    this.errors = errors;
  }

  /** A 400 from the search endpoint is, in practice, a JQL parse/validation failure. */
  get isJqlError(): boolean {
    return this.status === 400;
  }

  /** The issue key (or its project) doesn't exist, or the token can't see it. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Credentials rejected. Note: bad basic-auth creds make Cloud serve requests
   *  as anonymous, so search returns 200-empty rather than 401 — only a
   *  `/myself` preflight reliably surfaces this. See {@link JiraClient}. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

// --- Client -----------------------------------------------------------------

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts = maxRetries + 1. Default 3 retries. */
  maxRetries?: number;
  /** Base backoff delay in ms (exponential). Default 500. */
  baseDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class JiraClient implements IJiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private authVerified = false;
  private authPromise: Promise<void> | null = null;

  constructor(config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 500;
  }

  async searchJql(params: JiraSearchParams): Promise<JiraSearchResult> {
    await this.ensureAuthenticated();
    const body: Record<string, unknown> = { jql: params.jql };
    if (params.maxResults !== undefined) body.maxResults = params.maxResults;
    if (params.nextPageToken !== undefined) body.nextPageToken = params.nextPageToken;
    if (params.fields !== undefined) body.fields = params.fields;
    return this.request<JiraSearchResult>("POST", "/rest/api/3/search/jql", body);
  }

  async approximateCount(jql: string): Promise<JiraApproximateCount> {
    await this.ensureAuthenticated();
    return this.request<JiraApproximateCount>(
      "POST",
      "/rest/api/3/search/approximate-count",
      { jql },
    );
  }

  async getIssue(params: JiraGetIssueParams): Promise<JiraRestIssue> {
    await this.ensureAuthenticated();
    const query = new URLSearchParams();
    if (params.fields?.length) query.set("fields", params.fields.join(","));
    if (params.expand?.length) query.set("expand", params.expand.join(","));
    const qs = query.toString();
    const path = `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}${qs ? `?${qs}` : ""}`;
    return this.request<JiraRestIssue>("GET", path);
  }

  async createIssue(payload: JiraWritePayload): Promise<JiraCreatedIssue> {
    await this.ensureAuthenticated();
    return this.request<JiraCreatedIssue>("POST", "/rest/api/3/issue", payload);
  }

  /**
   * Apply a partial update to one issue. JIRA's edit endpoint takes the same
   * `{ fields, update }` envelope create does and returns 204 No Content; the
   * caller assembles the payload via the shared {@link IssueFieldsBuilder}.
   */
  async updateIssue(params: JiraUpdateIssueParams): Promise<void> {
    await this.ensureAuthenticated();
    const { issueKey, ...payload } = params;
    await this.request<unknown>(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      payload,
    );
  }

  /**
   * Normalized createmeta via the modern split endpoints. Called only on a
   * create failure: first the project's issue types (for the invalid-type
   * hint), then — when an issue type is named — that type's required fields
   * (for the missing-field hint).
   */
  async getCreateMeta(params: JiraCreateMetaParams): Promise<JiraCreateMeta> {
    await this.ensureAuthenticated();
    const key = encodeURIComponent(params.projectKey);
    const typesResp = await this.request<{ values?: RawCreateMetaType[] }>(
      "GET",
      `/rest/api/3/issue/createmeta/${key}/issuetypes`,
    );
    const rawTypes = Array.isArray(typesResp.values) ? typesResp.values : [];
    const issueTypes = rawTypes
      .filter((t): t is RawCreateMetaType => typeof t?.id === "string" && typeof t?.name === "string")
      .map((t) => ({ id: t.id, name: t.name }));

    let requiredFields: JiraCreateMetaField[] = [];
    if (params.issuetypeName) {
      const match = issueTypes.find(
        (t) => t.name.toLowerCase() === params.issuetypeName!.toLowerCase(),
      );
      if (match) {
        const fieldsResp = await this.request<{ values?: RawCreateMetaField[] }>(
          "GET",
          `/rest/api/3/issue/createmeta/${key}/issuetypes/${encodeURIComponent(match.id)}`,
        );
        const rawFields = Array.isArray(fieldsResp.values) ? fieldsResp.values : [];
        requiredFields = rawFields
          .filter((f) => f?.required === true && typeof f?.fieldId === "string")
          .map((f) => ({ fieldId: f.fieldId!, name: typeof f.name === "string" ? f.name : f.fieldId! }));
      }
    }

    return { issueTypes, requiredFields };
  }

  async searchUsers(query: string): Promise<JiraUser[]> {
    await this.ensureAuthenticated();
    const qs = new URLSearchParams({ query }).toString();
    const users = await this.request<RawUser[]>("GET", `/rest/api/3/user/search?${qs}`);
    return (Array.isArray(users) ? users : [])
      .filter((u): u is RawUser => typeof u?.accountId === "string")
      .map(toJiraUser);
  }

  async getCurrentUser(): Promise<JiraUser> {
    await this.ensureAuthenticated();
    return toJiraUser(await this.request<RawUser>("GET", "/rest/api/3/myself"));
  }

  async getProject(projectKey: string): Promise<JiraProject> {
    await this.ensureAuthenticated();
    const raw = await this.request<RawProject>(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    );
    const issueTypes = Array.isArray(raw.issueTypes)
      ? raw.issueTypes
          .filter((t): t is { id: unknown; name: string } => typeof t?.name === "string")
          .map((t) => ({ id: String(t.id ?? ""), name: t.name }))
      : undefined;
    return {
      id: String(raw.id ?? ""),
      key: typeof raw.key === "string" ? raw.key : projectKey,
      name: typeof raw.name === "string" ? raw.name : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      lead: typeof raw.lead?.displayName === "string" ? raw.lead.displayName : undefined,
      style: typeof raw.style === "string" ? raw.style : undefined,
      simplified: typeof raw.simplified === "boolean" ? raw.simplified : undefined,
      ...(issueTypes ? { issueTypes } : {}),
    };
  }

  /**
   * A normalized workflow for one project + issue type, built so company- and
   * team-managed projects return the identical shape. Two sources are composed:
   *
   *   1. statuses — `GET .../project/{key}/statuses`, the per-issue-type status
   *      list (reliable and uniform across both project styles); and
   *   2. transitions — the issue type's workflow via the workflow PREVIEW read
   *      (`fetchWorkflowTransitions`), mapped to {@link JiraWorkflowTransition}
   *      with status references resolved to names and global transitions flagged.
   *
   * The transition read is best-effort: if it fails or the workflow can't be
   * located, statuses are still returned and `transitions` is empty, so the tool
   * degrades to a partial (statuses-only) map rather than failing outright (see
   * ADR 0004).
   */
  async getProjectWorkflow(params: JiraProjectWorkflowParams): Promise<JiraProjectWorkflow> {
    await this.ensureAuthenticated();
    const key = encodeURIComponent(params.projectKey);
    const statusResp = await this.request<RawProjectStatusType[]>(
      "GET",
      `/rest/api/3/project/${key}/statuses`,
    );
    const typeBlock = (Array.isArray(statusResp) ? statusResp : []).find(
      (t) =>
        typeof t?.name === "string" &&
        t.name.toLowerCase() === params.issueType.toLowerCase(),
    );
    const statuses = (typeBlock?.statuses ?? [])
      .map((s) => (typeof s?.name === "string" ? s.name : null))
      .filter((n): n is string => n !== null);

    let transitions: JiraWorkflowTransition[] = [];
    // Fidelity is set from WHAT WE PARSE: it stays "topology" until a preview
    // read actually succeeds, at which point the gates rode in with it → "full".
    // Never keyed off "is this token admin" (issue 19, section A).
    let ruleFidelity: "full" | "topology" = "topology";
    if (typeBlock?.id) {
      try {
        const projectId =
          params.projectId ?? (await this.getProject(params.projectKey)).id;
        transitions = await this.fetchWorkflowTransitions(projectId, typeBlock.id);
        ruleFidelity = "full";
      } catch (err) {
        // Degrade to a statuses-only map on ANY transition-read failure. This is
        // safe specifically here: the statuses GET just above succeeded with the
        // same token, so the session is authenticated — a failure on the workflow
        // read is never a credential problem. The bulk-workflow endpoint is in
        // fact admin-gated, so a normal token routinely gets 403 "No permission
        // to view workflow" here; reporting that as an auth failure would be
        // wrong and would wrongly tell the agent to fix its credentials. A
        // partial map (statuses, projectType, issue types) is still useful.
        log.warn("workflow transitions unavailable; returning statuses only", {
          project: params.projectKey,
          issueType: params.issueType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { statuses, transitions, ruleFidelity };
  }

  /**
   * Read one issue type's workflow transitions via the workflow PREVIEW endpoint.
   *
   * `POST /rest/api/3/workflows/preview` (not the admin-gated `.../workflows`)
   * works with a normal project-scoped token: `projectId` is required for the
   * permission check and `issueTypeIds` selects the workflow(s) bound to that
   * type. Verified live against JIRA Cloud — see ADR 0004.
   *
   * Crucially (issue 19, section A — verified live), preview ALSO carries each
   * transition's `conditions`, `validators`, `actions`, `triggers`, and
   * `transitionScreen` for a NORMAL token — the rule data is not admin-gated. So
   * we parse the GATES here: `conditions` + `validators` ruleKeys become terse
   * `requires` phrases ({@link summarizeRequires}); `transitionScreen` presence
   * becomes `hasScreen`. `actions` (post-functions) and `triggers` are dropped
   * — they are side-effects, not gates.
   */
  private async fetchWorkflowTransitions(
    projectId: string,
    issueTypeId: string,
  ): Promise<JiraWorkflowTransition[]> {
    const resp = await this.request<RawWorkflowReadResponse>(
      "POST",
      "/rest/api/3/workflows/preview",
      { projectId, issueTypeIds: [issueTypeId] },
    );
    const refToName = new Map<string, string>();
    for (const s of resp.statuses ?? []) {
      if (typeof s?.statusReference === "string" && typeof s?.name === "string") {
        refToName.set(s.statusReference, s.name);
      }
    }

    const out: JiraWorkflowTransition[] = [];
    for (const workflow of resp.workflows ?? []) {
      for (const t of workflow?.transitions ?? []) {
        if (typeof t?.name !== "string") continue;
        // INITIAL is the create pseudo-transition, not a workflow edge an agent fires.
        if (t.type === "INITIAL") continue;
        const toStatus = t.toStatusReference ? refToName.get(t.toStatusReference) : undefined;
        if (!toStatus) continue;
        const requires = summarizeRequires(
          collectConditionKeys(t.conditions),
          (t.validators ?? [])
            .map((v) => v?.ruleKey)
            .filter((k): k is string => typeof k === "string"),
        );
        const hasScreen = typeof t.transitionScreen?.ruleKey === "string";
        if (t.type === "GLOBAL") {
          out.push({ name: t.name, toStatus, fromStatuses: [], isGlobal: true, requires, hasScreen });
          continue;
        }
        const fromStatuses = (t.links ?? [])
          .map((l) => (l?.fromStatusReference ? refToName.get(l.fromStatusReference) : undefined))
          .filter((n): n is string => typeof n === "string");
        out.push({ name: t.name, toStatus, fromStatuses, isGlobal: false, requires, hasScreen });
      }
    }
    return out;
  }

  /**
   * The transitions firable from the issue's current status. `expand=transitions.fields`
   * is always requested: the fields are free on this same call, and
   * `jira_transition` uses them to validate required screen fields up front. The
   * endpoint only ever lists transitions out of the current status — it does NOT
   * report the current status itself (the handler reads that separately), and it
   * never returns multi-hop routes (there is no server-side pathfinding).
   */
  async getTransitions(params: JiraGetTransitionsParams): Promise<JiraAvailableTransition[]> {
    await this.ensureAuthenticated();
    const path =
      `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/transitions` +
      `?expand=transitions.fields`;
    const resp = await this.request<RawTransitionsResponse>("GET", path);
    return (Array.isArray(resp.transitions) ? resp.transitions : [])
      .filter((t): t is RawTransition => typeof t?.id === "string" && typeof t?.name === "string")
      .map((t) => ({
        id: t.id!,
        name: t.name!,
        toStatus: typeof t.to?.name === "string" ? t.to.name : "",
        fields: normalizeTransitionFields(t.fields),
      }));
  }

  /**
   * Fire a transition. JIRA's transition endpoint accepts ONLY the numeric id
   * (resolved server-side from the name/status the agent passed) and returns 204
   * No Content on success.
   */
  async doTransition(params: JiraDoTransitionParams): Promise<void> {
    await this.ensureAuthenticated();
    const body: Record<string, unknown> = { transition: { id: params.transitionId } };
    if (params.fields && Object.keys(params.fields).length > 0) body.fields = params.fields;
    await this.request<unknown>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/transitions`,
      body,
    );
  }

  /**
   * A project's boards with their OPEN (active+future) sprints. Closed sprints
   * are excluded (lean — they are never assignment targets).
   *
   * Sprints are fetched for every board EXCEPT Kanban ({@link boardSupportsSprints}):
   * a Kanban board's `/board/{id}/sprint` returns a 400 "board does not support
   * sprints", so querying it would both error and pollute resolution. This is
   * the structural fix for the benchmark failure — resolution filters to
   * sprint-supporting boards rather than the project's default (often Kanban)
   * board. The per-board sprint fetch is also wrapped: a board that
   * unexpectedly rejects the sprint read (e.g. a team-managed board with sprints
   * disabled) degrades to empty sprints rather than failing the whole listing,
   * so a single odd board can never re-surface the raw 400 the fix removes.
   *
   * The per-board sprint fetches run concurrently (`Promise.all`) rather than
   * one at a time — they're independent reads, so there's no reason to pay their
   * latency sequentially. Each board's fetch keeps its OWN try/catch (a failed
   * board still degrades to empty sprints without failing the batch), and
   * results are assembled back in board order, not completion order.
   */
  async listProjectBoards(projectKey: string): Promise<JiraProjectBoard[]> {
    await this.ensureAuthenticated();
    const boardsResp = await this.request<{ values?: RawBoard[] }>(
      "GET",
      `/rest/agile/1.0/board?${new URLSearchParams({ projectKeyOrId: projectKey }).toString()}`,
    );
    const boards = Array.isArray(boardsResp.values) ? boardsResp.values : [];

    const results = await Promise.all(
      boards.map(async (board): Promise<JiraProjectBoard | null> => {
        if (typeof board?.id !== "number") return null;
        const type = typeof board.type === "string" ? board.type : "";
        let sprints: JiraBoardSprint[] = [];
        if (boardSupportsSprints(type)) {
          try {
            const sprintResp = await this.request<{ values?: RawSprint[] }>(
              "GET",
              `/rest/agile/1.0/board/${board.id}/sprint?state=active,future`,
            );
            sprints = (sprintResp.values ?? [])
              .filter((s): s is RawSprint => typeof s?.id === "number")
              .map((s) => ({
                id: s.id!,
                name: typeof s.name === "string" ? s.name : `Sprint ${s.id}`,
                state: typeof s.state === "string" ? s.state : "",
              }));
          } catch (err) {
            // Best-effort per board: a board that rejects the sprint read keeps an
            // empty sprint list instead of failing the whole project's discovery.
            log.warn("board sprint read failed; treating board as having no open sprints", {
              project: projectKey,
              board: board.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return {
          id: board.id,
          name: typeof board.name === "string" ? board.name : `Board ${board.id}`,
          type,
          sprints,
        };
      }),
    );
    return results.filter((b): b is JiraProjectBoard => b !== null);
  }

  /**
   * Add an issue to a sprint via the Agile move endpoint. Screen-independent:
   * it never touches the Sprint custom field, so it works regardless of the
   * field's screen configuration (the whole point of issue 15). 204 on success.
   */
  async addIssueToSprint(sprintId: number, issueKey: string): Promise<void> {
    await this.ensureAuthenticated();
    await this.request<unknown>("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      issues: [issueKey],
    });
  }

  /** Move an issue to the backlog (clears its sprint). 204 on success. */
  async moveIssueToBacklog(issueKey: string): Promise<void> {
    await this.ensureAuthenticated();
    await this.request<unknown>("POST", "/rest/agile/1.0/backlog/issue", {
      issues: [issueKey],
    });
  }

  async addComment(params: JiraAddCommentParams): Promise<JiraRestCommentFull> {
    await this.ensureAuthenticated();
    const path = `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/comment${commentQuery(params.expand)}`;
    return this.request<JiraRestCommentFull>("POST", path, commentBody(params));
  }

  async updateComment(params: JiraUpdateCommentParams): Promise<JiraRestCommentFull> {
    await this.ensureAuthenticated();
    const path =
      `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/comment/` +
      `${encodeURIComponent(params.commentId)}${commentQuery(params.expand)}`;
    return this.request<JiraRestCommentFull>("PUT", path, commentBody(params));
  }

  async getComment(params: JiraGetCommentParams): Promise<JiraRestCommentFull> {
    await this.ensureAuthenticated();
    const path =
      `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/comment/` +
      `${encodeURIComponent(params.commentId)}${commentQuery(params.expand)}`;
    return this.request<JiraRestCommentFull>("GET", path);
  }

  async getComments(params: JiraGetCommentsParams): Promise<JiraCommentsPage> {
    await this.ensureAuthenticated();
    const query = new URLSearchParams();
    if (params.startAt !== undefined) query.set("startAt", String(params.startAt));
    if (params.maxResults !== undefined) query.set("maxResults", String(params.maxResults));
    if (params.orderBy) query.set("orderBy", params.orderBy);
    if (params.expand?.length) query.set("expand", params.expand.join(","));
    const qs = query.toString();
    const path = `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/comment${qs ? `?${qs}` : ""}`;
    return this.request<JiraCommentsPage>("GET", path);
  }

  async getProjectRoles(projectKey: string): Promise<string[]> {
    await this.ensureAuthenticated();
    // `GET .../project/{key}/role` returns { "<role name>": "<url>", ... }.
    const roles = await this.request<Record<string, unknown>>(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/role`,
    );
    return roles && typeof roles === "object" ? Object.keys(roles) : [];
  }

  /**
   * The catalog of projects the token can see. Uses the modern paginated
   * `/project/search` endpoint and walks every page so the resource is the
   * complete catalog, not just the first ~50.
   */
  async listProjects(): Promise<JiraProjectSummary[]> {
    await this.ensureAuthenticated();
    const out: JiraProjectSummary[] = [];
    let startAt = 0;
    for (;;) {
      const qs = new URLSearchParams({ startAt: String(startAt), maxResults: "50" }).toString();
      const resp = await this.request<RawProjectSearch>(
        "GET",
        `/rest/api/3/project/search?${qs}`,
      );
      const values = Array.isArray(resp.values) ? resp.values : [];
      for (const p of values) {
        if (typeof p?.key !== "string") continue;
        out.push({
          key: p.key,
          name: typeof p.name === "string" ? p.name : p.key,
          id: String(p.id ?? ""),
          ...(typeof p.projectTypeKey === "string" ? { projectTypeKey: p.projectTypeKey } : {}),
          ...(typeof p.lead?.displayName === "string" ? { lead: p.lead.displayName } : {}),
        });
      }
      // Stop on the last page; the empty-page guard prevents an endless loop if
      // a deployment omits `isLast`.
      if (resp.isLast === true || values.length === 0) break;
      startAt += values.length;
    }
    return out;
  }

  /**
   * The JQL field catalog (`GET /rest/api/3/field`) — every field the token can
   * query, system and custom alike. Custom fields are exactly why this exists:
   * `clauseNames` carries the identifiers that work in a JQL clause so an agent
   * can write `"Story Points" >= 3` or `cf[10016] >= 3` without guessing.
   */
  async listFields(): Promise<JiraField[]> {
    await this.ensureAuthenticated();
    const raw = await this.request<RawField[]>("GET", "/rest/api/3/field");
    return (Array.isArray(raw) ? raw : [])
      .filter((f): f is RawField => typeof f?.id === "string" && typeof f?.name === "string")
      .map((f) => ({
        id: f.id!,
        name: f.name!,
        custom: f.custom === true,
        clauseNames: Array.isArray(f.clauseNames)
          ? f.clauseNames.filter((c): c is string => typeof c === "string")
          : [],
        ...(typeof f.schema?.type === "string" ? { schemaType: f.schema.type } : {}),
        ...(typeof f.schema?.custom === "string" ? { schemaCustom: f.schema.custom } : {}),
      }));
  }

  /**
   * One attachment's metadata. `content` is JIRA's authenticated content
   * endpoint; we keep it as the download URL surfaced when a file can't be
   * inlined.
   */
  async getAttachmentMeta(attachmentId: string): Promise<JiraAttachmentMeta> {
    await this.ensureAuthenticated();
    const raw = await this.request<RawAttachment>(
      "GET",
      `/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`,
    );
    return {
      id: String(raw.id ?? attachmentId),
      filename: typeof raw.filename === "string" ? raw.filename : "",
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
      size: typeof raw.size === "number" ? raw.size : 0,
      created: typeof raw.created === "string" ? raw.created : null,
      author: typeof raw.author?.displayName === "string" ? raw.author.displayName : null,
      contentUrl: typeof raw.content === "string" ? raw.content : null,
    };
  }

  /**
   * One attachment's raw bytes. Reads the body as an arrayBuffer rather than
   * JSON; auth + retry/backoff are shared with every other call via
   * {@link requestRaw}. `fetch` follows JIRA's 303 redirect to the signed media
   * URL automatically.
   */
  async getAttachmentContent(attachmentId: string): Promise<Buffer> {
    await this.ensureAuthenticated();
    const response = await this.requestRaw(
      "GET",
      `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
      undefined,
      "*/*",
    );
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Upload one file to an issue. Multipart `form-data` with the `X-Atlassian-Token:
   * no-check` header JIRA requires for attachment uploads; the Content-Type
   * (boundary) is left to `fetch` to set. The Content-Type of the file PART is
   * the detected mime the caller passes, so JIRA renders the file correctly.
   * JIRA returns an array of the created attachments even for a single file.
   */
  async addAttachment(params: JiraAddAttachmentParams): Promise<JiraUploadedAttachment[]> {
    await this.ensureAuthenticated();
    const form = new FormData();
    form.append(
      "file",
      new Blob([params.data], { type: params.mimeType || "application/octet-stream" }),
      params.filename,
    );
    const response = await this.requestRaw(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(params.issueKey)}/attachments`,
      form,
      "application/json",
      { "X-Atlassian-Token": "no-check" },
    );
    const parsed = (await this.parseJson(response)) as RawUploadedAttachment[];
    return (Array.isArray(parsed) ? parsed : [])
      .filter((a): a is RawUploadedAttachment => a != null)
      .map((a) => ({
        id: String(a.id ?? ""),
        filename: typeof a.filename === "string" ? a.filename : params.filename,
        size: typeof a.size === "number" ? a.size : params.data.length,
        mimeType: typeof a.mimeType === "string" ? a.mimeType : params.mimeType,
      }));
  }

  /** The instance's issue link types (`GET /rest/api/3/issueLinkType`). */
  async listIssueLinkTypes(): Promise<JiraIssueLinkType[]> {
    await this.ensureAuthenticated();
    const resp = await this.request<{ issueLinkTypes?: RawLinkType[] }>(
      "GET",
      "/rest/api/3/issueLinkType",
    );
    return (Array.isArray(resp.issueLinkTypes) ? resp.issueLinkTypes : [])
      .filter((t): t is RawLinkType => typeof t?.name === "string")
      .map((t) => ({
        id: String(t.id ?? ""),
        name: t.name!,
        inward: typeof t.inward === "string" ? t.inward : "",
        outward: typeof t.outward === "string" ? t.outward : "",
      }));
  }

  /**
   * Verify the credentials once per process via `/myself`, memoizing success.
   *
   * Why this exists: invalid basic-auth credentials don't make JIRA Cloud
   * return 401 on data endpoints — it serves the request anonymously and
   * returns 200 with empty results. Without this preflight, every tool would
   * silently report "0 results" on an auth failure. `/myself` requires a real
   * identity, so it's the one call that fails loudly (401), which we then turn
   * into a clear, recoverable error for the agent.
   *
   * On success the result is cached for the process lifetime (creds come from
   * env and don't change). On failure nothing is cached, so a later call can
   * re-check — a transient blip won't permanently brick the client, and a
   * genuine auth failure simply fails each call with the same clear error.
   */
  private async ensureAuthenticated(): Promise<void> {
    if (this.authVerified) return;
    if (!this.authPromise) {
      this.authPromise = this.request("GET", "/rest/api/3/myself")
        .then(() => {
          this.authVerified = true;
        })
        .finally(() => {
          this.authPromise = null;
        });
    }
    return this.authPromise;
  }

  /**
   * Perform a JSON request and parse the body. Thin wrapper over
   * {@link requestRaw} — the shared retry/backoff + error mapping lives there so
   * the binary attachment-content path reuses it identically.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.requestRaw(method, path, body);
    return (await this.parseJson(response)) as T;
  }

  /**
   * Perform a request with retry/backoff, returning the raw `Response` on
   * success. Retries on 429 + 5xx (honoring Retry-After) and on network errors;
   * never retries other 4xx; turns a non-2xx terminal response into a typed
   * {@link JiraApiError}. JSON callers parse the body via {@link request}; the
   * attachment-content path reads it as bytes. `accept` defaults to JSON.
   *
   * A `FormData` body is sent as multipart: it is NOT JSON-stringified and the
   * `Content-Type` header is omitted so `fetch` sets the boundary itself.
   * `extraHeaders` carries per-call headers like `X-Atlassian-Token: no-check`.
   */
  private async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/json",
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        const headers: Record<string, string> = {
          Authorization: this.authHeader,
          Accept: accept,
          ...extraHeaders,
        };
        // multipart: let fetch set Content-Type (with the boundary). JSON: set it.
        if (!isForm) headers["Content-Type"] = "application/json";
        response = await this.fetchImpl(url, {
          method,
          headers,
          body:
            body === undefined
              ? undefined
              : isForm
                ? (body as FormData)
                : JSON.stringify(body),
        });
      } catch (err) {
        // Network-level failure: retry with backoff.
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new JiraApiError(0, [String((err as Error)?.message ?? err)], {});
      }

      if (response.ok) {
        return response;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const wait = this.retryAfterMs(response) ?? this.backoffMs(attempt);
        log.warn(`retrying ${method} ${path}`, {
          status: response.status,
          attempt: attempt + 1,
          waitMs: wait,
        });
        await this.sleep(wait);
        continue;
      }

      // Non-retryable, or retries exhausted: surface a typed error.
      throw await this.toApiError(response);
    }

    // Unreachable: every iteration returns or throws. Satisfies the type checker.
    throw new JiraApiError(0, ["request loop exited without a result"], {});
  }

  private backoffMs(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** attempt;
    const jitter = exp * 0.25 * Math.random();
    return Math.round(exp + jitter);
  }

  private retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get("retry-after");
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new JiraApiError(response.status, ["JIRA returned a non-JSON response"], {});
    }
  }

  private async toApiError(response: Response): Promise<JiraApiError> {
    const parsed = await this.parseJson(response).catch(() => ({}));
    const obj = (parsed ?? {}) as {
      errorMessages?: unknown;
      errors?: unknown;
    };
    const errorMessages = Array.isArray(obj.errorMessages)
      ? obj.errorMessages.map(String)
      : [];
    const errors =
      obj.errors && typeof obj.errors === "object"
        ? (obj.errors as Record<string, string>)
        : {};
    if (errorMessages.length === 0 && Object.keys(errors).length === 0) {
      errorMessages.push(`JIRA request failed with status ${response.status}`);
    }
    return new JiraApiError(response.status, errorMessages, errors);
  }
}

// --- raw REST shapes (normalized by the methods above) ----------------------

interface RawUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

interface RawProject {
  id?: string | number;
  key?: string;
  name?: string;
  description?: string;
  lead?: { displayName?: string };
  style?: string;
  simplified?: boolean;
  issueTypes?: { id?: unknown; name?: unknown }[];
}

interface RawProjectStatusType {
  id?: string;
  name?: string;
  statuses?: { id?: string; name?: string }[];
}

interface RawProjectSearch {
  isLast?: boolean;
  values?: RawProjectSummary[];
}

interface RawProjectSummary {
  id?: string | number;
  key?: string;
  name?: string;
  projectTypeKey?: string;
  lead?: { displayName?: string };
}

interface RawField {
  id?: string;
  name?: string;
  custom?: boolean;
  clauseNames?: unknown[];
  schema?: { type?: string; custom?: string };
}

interface RawLinkType {
  id?: string | number;
  name?: string;
  inward?: string;
  outward?: string;
}

interface RawWorkflowReadResponse {
  statuses?: { statusReference?: string; name?: string }[];
  workflows?: RawWorkflow[];
}

interface RawWorkflow {
  transitions?: RawWorkflowTransition[];
}

interface RawWorkflowTransition {
  name?: string;
  /** "INITIAL" (create) | "GLOBAL" (from any status) | "DIRECTED" (status→status). */
  type?: string;
  toStatusReference?: string;
  links?: { fromStatusReference?: string }[];
  /** Condition gates (only present when the edge is condition-gated). Can nest. */
  conditions?: RawWorkflowConditionGroup;
  /** Validator gates (always an array; `[]` when none). */
  validators?: { ruleKey?: string }[];
  /** Present only when a transition screen (form) is shown. */
  transitionScreen?: { ruleKey?: string };
}

/**
 * A workflow condition node: a flat `conditions` list plus nested
 * `conditionGroups` (each the same shape). Issue 19 collects EVERY ruleKey
 * across the whole tree so a gate buried in a nested group is never dropped.
 */
interface RawWorkflowConditionGroup {
  operation?: string;
  conditions?: { ruleKey?: string }[];
  conditionGroups?: RawWorkflowConditionGroup[];
}

/** Recursively collect all condition ruleKeys across nested condition groups. */
function collectConditionKeys(node: RawWorkflowConditionGroup | undefined): string[] {
  if (!node || typeof node !== "object") return [];
  const keys: string[] = [];
  for (const c of node.conditions ?? []) {
    if (typeof c?.ruleKey === "string") keys.push(c.ruleKey);
  }
  for (const group of node.conditionGroups ?? []) {
    keys.push(...collectConditionKeys(group));
  }
  return keys;
}

interface RawTransitionsResponse {
  transitions?: RawTransition[];
}

interface RawTransition {
  id?: string;
  name?: string;
  to?: { name?: string };
  /** `expand=transitions.fields`: a map of fieldId → field metadata. */
  fields?: Record<string, RawTransitionField>;
}

interface RawTransitionField {
  name?: string;
  required?: boolean;
}

/** Flatten JIRA's fieldId-keyed transition-fields map into a normalized list. */
function normalizeTransitionFields(
  fields: Record<string, RawTransitionField> | undefined,
): JiraTransitionField[] {
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields).map(([fieldId, meta]) => ({
    fieldId,
    name: typeof meta?.name === "string" ? meta.name : fieldId,
    required: meta?.required === true,
  }));
}

interface RawBoard {
  id?: number;
  name?: string;
  /** JIRA's board type — `scrum` | `kanban` | `simple`. */
  type?: string;
}

interface RawSprint {
  id?: number;
  name?: string;
  state?: string;
}

interface RawAttachment {
  id?: string | number;
  filename?: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
  content?: string;
}

interface RawUploadedAttachment {
  id?: string | number;
  filename?: string;
  size?: number;
  mimeType?: string;
}

interface RawCreateMetaType {
  id: string;
  name: string;
}

interface RawCreateMetaField {
  fieldId?: string;
  name?: string;
  required?: boolean;
}

function commentQuery(expand?: string[]): string {
  return expand?.length ? `?expand=${encodeURIComponent(expand.join(","))}` : "";
}

function commentBody(params: JiraAddCommentParams): Record<string, unknown> {
  const body: Record<string, unknown> = { body: params.body };
  if (params.visibility) body.visibility = params.visibility;
  if (params.properties) body.properties = params.properties;
  return body;
}

function toJiraUser(raw: RawUser): JiraUser {
  return {
    accountId: raw.accountId ?? "",
    displayName: typeof raw.displayName === "string" ? raw.displayName : "",
    ...(typeof raw.emailAddress === "string" ? { emailAddress: raw.emailAddress } : {}),
  };
}
