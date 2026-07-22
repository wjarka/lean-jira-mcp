/**
 * Faked JiraClient — the shared test fixture for the project's one external seam.
 *
 * Tool-handler tests inject this in place of the real {@link JiraClient}: it
 * implements {@link IJiraClient}, returns canned REST payloads, records calls
 * (so tests can assert e.g. that no count call was made), and can be told to
 * throw a {@link JiraApiError}. Every later tool slice (issues 02–10) extends
 * this fixture with the methods it needs.
 */

import {
  JiraApiError,
  type IJiraClient,
  type JiraAddCommentParams,
  type JiraApproximateCount,
  type JiraAddAttachmentParams,
  type JiraAttachmentMeta,
  type JiraUploadedAttachment,
  type JiraAvailableTransition,
  type JiraCommentsPage,
  type JiraCreateMeta,
  type JiraCreateMetaParams,
  type JiraCreatedIssue,
  type JiraDoTransitionParams,
  type JiraField,
  type JiraGetCommentParams,
  type JiraGetCommentsParams,
  type JiraGetIssueParams,
  type JiraGetTransitionsParams,
  type JiraIssueLinkType,
  type JiraProject,
  type JiraProjectSummary,
  type JiraProjectWorkflow,
  type JiraProjectWorkflowParams,
  type JiraRestCommentFull,
  type JiraRestIssue,
  type JiraProjectBoard,
  type JiraSearchParams,
  type JiraSearchResult,
  type JiraUpdateCommentParams,
  type JiraUpdateIssueParams,
  type JiraUser,
  type JiraWritePayload,
} from "../../src/lib/jira-client.ts";

type SearchResponder = (
  params: JiraSearchParams,
) => JiraSearchResult | Promise<JiraSearchResult>;

type GetIssueResponder = (
  params: JiraGetIssueParams,
) => JiraRestIssue | Promise<JiraRestIssue>;

type CreateResponder = (
  payload: JiraWritePayload,
) => JiraCreatedIssue | Promise<JiraCreatedIssue>;

type UpdateIssueResponder = (
  params: JiraUpdateIssueParams,
) => void | Promise<void>;

type AddCommentResponder = (
  params: JiraAddCommentParams,
) => JiraRestCommentFull | Promise<JiraRestCommentFull>;

type UpdateCommentResponder = (
  params: JiraUpdateCommentParams,
) => JiraRestCommentFull | Promise<JiraRestCommentFull>;

type GetCommentResponder = (
  params: JiraGetCommentParams,
) => JiraRestCommentFull | Promise<JiraRestCommentFull>;

type GetCommentsResponder = (
  params: JiraGetCommentsParams,
) => JiraCommentsPage | Promise<JiraCommentsPage>;

type ProjectWorkflowResponder = (
  params: JiraProjectWorkflowParams,
) => JiraProjectWorkflow | Promise<JiraProjectWorkflow>;

type GetTransitionsResponder = (
  params: JiraGetTransitionsParams,
) => JiraAvailableTransition[] | Promise<JiraAvailableTransition[]>;

type DoTransitionResponder = (
  params: JiraDoTransitionParams,
) => void | Promise<void>;

export class FakeJiraClient implements IJiraClient {
  readonly searchCalls: JiraSearchParams[] = [];
  readonly approximateCountCalls: string[] = [];
  readonly getIssueCalls: JiraGetIssueParams[] = [];
  readonly createIssueCalls: JiraWritePayload[] = [];
  readonly updateIssueCalls: JiraUpdateIssueParams[] = [];
  readonly createMetaCalls: JiraCreateMetaParams[] = [];
  readonly searchUsersCalls: string[] = [];
  getCurrentUserCalls = 0;
  readonly getProjectCalls: string[] = [];
  readonly getProjectWorkflowCalls: JiraProjectWorkflowParams[] = [];
  readonly getTransitionsCalls: JiraGetTransitionsParams[] = [];
  readonly doTransitionCalls: JiraDoTransitionParams[] = [];
  readonly listProjectBoardsCalls: string[] = [];
  readonly addIssueToSprintCalls: { sprintId: number; issueKey: string }[] = [];
  readonly moveIssueToBacklogCalls: string[] = [];
  readonly addCommentCalls: JiraAddCommentParams[] = [];
  readonly updateCommentCalls: JiraUpdateCommentParams[] = [];
  readonly getCommentCalls: JiraGetCommentParams[] = [];
  readonly getCommentsCalls: JiraGetCommentsParams[] = [];
  readonly getProjectRolesCalls: string[] = [];
  readonly getAttachmentMetaCalls: string[] = [];
  readonly getAttachmentContentCalls: string[] = [];
  readonly addAttachmentCalls: JiraAddAttachmentParams[] = [];
  listProjectsCalls = 0;
  listFieldsCalls = 0;
  listIssueLinkTypesCalls = 0;

  private searchResponder: SearchResponder = () => ({ issues: [], isLast: true });
  private approxCount = 0;
  private getIssueResponder: GetIssueResponder = () => {
    throw new JiraApiError(404, ["Issue does not exist or no permission to view it."], {});
  };
  private createResponder: CreateResponder = () => ({ id: "10000", key: "TEST-1" });
  private updateIssueResponder: UpdateIssueResponder = () => {};
  private createMeta: JiraCreateMeta = { issueTypes: [], requiredFields: [] };
  private users: JiraUser[] = [];
  private currentUser: JiraUser = { accountId: "me-account", displayName: "Current User" };
  private project: JiraProject = { id: "1", key: "TEST", style: "classic" };
  private projectBoards: JiraProjectBoard[] = [];
  private addIssueToSprintResponder: () => void | Promise<void> = () => {};
  private moveIssueToBacklogResponder: () => void | Promise<void> = () => {};
  private projectWorkflowResponder: ProjectWorkflowResponder = () => ({
    statuses: [],
    transitions: [],
    ruleFidelity: "full",
  });
  private getTransitionsResponder: GetTransitionsResponder = () => [];
  private doTransitionResponder: DoTransitionResponder = () => {};

  // Default responders mimic JIRA Cloud: it echoes back the body, visibility,
  // and (crucially) any properties sent — which is exactly why the fake CANNOT
  // prove the `mcp.origin` property actually persists; that needs a live test.
  private addCommentResponder: AddCommentResponder = (params) => ({
    id: "comment-1",
    author: { displayName: "Current User", accountId: "me-account" },
    body: params.body,
    created: "2026-06-25T12:00:00.000+0000",
    ...(params.visibility ? { visibility: params.visibility } : {}),
    ...(params.properties ? { properties: params.properties } : {}),
  });
  private updateCommentResponder: UpdateCommentResponder = (params) => ({
    id: params.commentId,
    author: { displayName: "Current User", accountId: "me-account" },
    body: params.body,
    created: "2026-06-25T12:00:00.000+0000",
    updated: "2026-06-25T13:00:00.000+0000",
    ...(params.visibility ? { visibility: params.visibility } : {}),
    ...(params.properties ? { properties: params.properties } : {}),
  });
  private getCommentResponder: GetCommentResponder = () => {
    throw new JiraApiError(404, ["Comment does not exist or no permission to view it."], {});
  };
  private getCommentsResponder: GetCommentsResponder = () => ({
    comments: [],
    startAt: 0,
    maxResults: 0,
    total: 0,
  });
  private projectRoles: string[] = [];
  private attachmentMetaResponder: (id: string) => JiraAttachmentMeta | Promise<JiraAttachmentMeta> =
    () => {
      throw new JiraApiError(404, ["The attachment with id does not exist."], {});
    };
  private attachmentContentResponder: (id: string) => Buffer | Promise<Buffer> = () =>
    Buffer.from("");
  // Default: echo back one created attachment built from the upload params (the
  // shape JIRA returns). The fake CANNOT prove the multipart bytes actually
  // reached JIRA — that needs a live test (see the issue's verification note).
  private addAttachmentResponder: (
    params: JiraAddAttachmentParams,
  ) => JiraUploadedAttachment[] | Promise<JiraUploadedAttachment[]> = (params) => [
    {
      id: "att-1",
      filename: params.filename,
      size: params.data.length,
      mimeType: params.mimeType,
    },
  ];
  private projectCatalog: JiraProjectSummary[] = [];
  private fieldCatalog: JiraField[] = [];
  private issueLinkTypes: JiraIssueLinkType[] = [];

  /** Return a fixed result for every searchJql call. */
  setSearchResult(result: JiraSearchResult): this {
    this.searchResponder = () => result;
    return this;
  }

  /** Return a result computed from the params (e.g. for paging by nextPageToken). */
  setSearchResponder(responder: SearchResponder): this {
    this.searchResponder = responder;
    return this;
  }

  /** Make searchJql throw — e.g. a 400 JQL parse error. */
  setSearchError(error: JiraApiError): this {
    this.searchResponder = () => {
      throw error;
    };
    return this;
  }

  setApproximateCount(count: number): this {
    this.approxCount = count;
    return this;
  }

  /** Return a fixed issue for every getIssue call. */
  setIssue(issue: JiraRestIssue): this {
    this.getIssueResponder = () => issue;
    return this;
  }

  /** Return an issue computed from the params (e.g. to assert requested fields). */
  setIssueResponder(responder: GetIssueResponder): this {
    this.getIssueResponder = responder;
    return this;
  }

  /** Make getIssue throw — e.g. a 404 unknown-key error. */
  setGetIssueError(error: JiraApiError): this {
    this.getIssueResponder = () => {
      throw error;
    };
    return this;
  }

  /** Return a fixed created-issue for every createIssue call. */
  setCreatedIssue(issue: JiraCreatedIssue): this {
    this.createResponder = () => issue;
    return this;
  }

  /** Inspect the payload (e.g. to assert resolved fields) when responding. */
  setCreateResponder(responder: CreateResponder): this {
    this.createResponder = responder;
    return this;
  }

  /** Make createIssue throw — e.g. a 400 with required-field errors. */
  setCreateError(error: JiraApiError): this {
    this.createResponder = () => {
      throw error;
    };
    return this;
  }

  /** Inspect the update payload (e.g. assert resolved fields / ops) when responding. */
  setUpdateIssueResponder(responder: UpdateIssueResponder): this {
    this.updateIssueResponder = responder;
    return this;
  }

  /** Make updateIssue throw — e.g. a 400 reporter-permission rejection. */
  setUpdateIssueError(error: JiraApiError): this {
    this.updateIssueResponder = () => {
      throw error;
    };
    return this;
  }

  setCreateMeta(meta: JiraCreateMeta): this {
    this.createMeta = meta;
    return this;
  }

  /** Users returned by searchUsers (the resolver picks 0/1/many from these). */
  setUsers(users: JiraUser[]): this {
    this.users = users;
    return this;
  }

  setCurrentUser(user: JiraUser): this {
    this.currentUser = user;
    return this;
  }

  setProject(project: JiraProject): this {
    this.project = project;
    return this;
  }

  /** Return a fixed workflow for every getProjectWorkflow call. */
  setProjectWorkflow(workflow: JiraProjectWorkflow): this {
    this.projectWorkflowResponder = () => workflow;
    return this;
  }

  /** Return a workflow computed from the params (e.g. per issue type). */
  setProjectWorkflowResponder(responder: ProjectWorkflowResponder): this {
    this.projectWorkflowResponder = responder;
    return this;
  }

  setProjectWorkflowError(error: JiraApiError): this {
    this.projectWorkflowResponder = () => {
      throw error;
    };
    return this;
  }

  /** Available transitions for the issue's current status (with screen fields). */
  setTransitions(transitions: JiraAvailableTransition[]): this {
    this.getTransitionsResponder = () => transitions;
    return this;
  }

  setTransitionsResponder(responder: GetTransitionsResponder): this {
    this.getTransitionsResponder = responder;
    return this;
  }

  setGetTransitionsError(error: JiraApiError): this {
    this.getTransitionsResponder = () => {
      throw error;
    };
    return this;
  }

  /** Make doTransition throw — e.g. a 400 JIRA still rejects after resolution. */
  setDoTransitionError(error: JiraApiError): this {
    this.doTransitionResponder = () => {
      throw error;
    };
    return this;
  }

  /** The project's boards (with open sprints) that listProjectBoards returns. */
  setProjectBoards(boards: JiraProjectBoard[]): this {
    this.projectBoards = boards;
    return this;
  }

  /** Make addIssueToSprint throw — e.g. a 400 on a create-then-move failure. */
  setAddIssueToSprintError(error: JiraApiError): this {
    this.addIssueToSprintResponder = () => {
      throw error;
    };
    return this;
  }

  /** Make moveIssueToBacklog throw — e.g. a 404 on the target issue. */
  setMoveIssueToBacklogError(error: JiraApiError): this {
    this.moveIssueToBacklogResponder = () => {
      throw error;
    };
    return this;
  }

  /** Inspect the add-comment payload when responding (e.g. assert the property). */
  setAddCommentResponder(responder: AddCommentResponder): this {
    this.addCommentResponder = responder;
    return this;
  }

  /** Make addComment throw — e.g. a 400 for an invalid visibility role/group. */
  setAddCommentError(error: JiraApiError): this {
    this.addCommentResponder = () => {
      throw error;
    };
    return this;
  }

  setUpdateCommentResponder(responder: UpdateCommentResponder): this {
    this.updateCommentResponder = responder;
    return this;
  }

  setUpdateCommentError(error: JiraApiError): this {
    this.updateCommentResponder = () => {
      throw error;
    };
    return this;
  }

  /** The existing comment the edit guard fetches before replacing the body. */
  setExistingComment(comment: JiraRestCommentFull): this {
    this.getCommentResponder = () => comment;
    return this;
  }

  setGetCommentError(error: JiraApiError): this {
    this.getCommentResponder = () => {
      throw error;
    };
    return this;
  }

  setProjectRoles(roles: string[]): this {
    this.projectRoles = roles;
    return this;
  }

  /** Fixed attachment metadata for getAttachmentMeta. */
  setAttachmentMeta(meta: JiraAttachmentMeta): this {
    this.attachmentMetaResponder = () => meta;
    return this;
  }

  /** Inspect the id when responding (e.g. to serve different attachments). */
  setAttachmentMetaResponder(
    responder: (id: string) => JiraAttachmentMeta | Promise<JiraAttachmentMeta>,
  ): this {
    this.attachmentMetaResponder = responder;
    return this;
  }

  setGetAttachmentMetaError(error: JiraApiError): this {
    this.attachmentMetaResponder = () => {
      throw error;
    };
    return this;
  }

  /** The raw bytes getAttachmentContent returns. */
  setAttachmentContent(bytes: Buffer): this {
    this.attachmentContentResponder = () => bytes;
    return this;
  }

  setAttachmentContentResponder(responder: (id: string) => Buffer | Promise<Buffer>): this {
    this.attachmentContentResponder = responder;
    return this;
  }

  setGetAttachmentContentError(error: JiraApiError): this {
    this.attachmentContentResponder = () => {
      throw error;
    };
    return this;
  }

  /** Fixed uploaded-attachment result for addAttachment. */
  setAddAttachmentResult(result: JiraUploadedAttachment[]): this {
    this.addAttachmentResponder = () => result;
    return this;
  }

  setAddAttachmentResponder(
    responder: (
      params: JiraAddAttachmentParams,
    ) => JiraUploadedAttachment[] | Promise<JiraUploadedAttachment[]>,
  ): this {
    this.addAttachmentResponder = responder;
    return this;
  }

  /** Make addAttachment throw — e.g. a 413 too-large or a 404 issue. */
  setAddAttachmentError(error: JiraApiError): this {
    this.addAttachmentResponder = () => {
      throw error;
    };
    return this;
  }

  /** The catalog the `projects` resource reads. */
  setProjectCatalog(projects: JiraProjectSummary[]): this {
    this.projectCatalog = projects;
    return this;
  }

  /** The field catalog the `jql-fields` resource reads. */
  setFieldCatalog(fields: JiraField[]): this {
    this.fieldCatalog = fields;
    return this;
  }

  /** The link types the `link-types` resource reads. */
  setIssueLinkTypes(types: JiraIssueLinkType[]): this {
    this.issueLinkTypes = types;
    return this;
  }

  /** Inspect the getComments params when responding (e.g. assert expand/orderBy). */
  setGetCommentsResponder(responder: GetCommentsResponder): this {
    this.getCommentsResponder = responder;
    return this;
  }

  /**
   * Serve a canonical thread (oldest-first) through the real offset-pagination
   * machinery: orders per `orderBy`, slices by `startAt`/`maxResults`, and
   * reports the true `total`. This is what drives the handler's paging and
   * delta-walk logic end-to-end, exactly as JIRA Cloud's comment list would.
   */
  setCommentThread(thread: JiraRestCommentFull[]): this {
    this.getCommentsResponder = (params) => {
      const ordered =
        params.orderBy === "-created" ? [...thread].reverse() : [...thread];
      const startAt = params.startAt ?? 0;
      const maxResults = params.maxResults ?? ordered.length;
      return {
        comments: ordered.slice(startAt, startAt + maxResults),
        startAt,
        maxResults,
        total: thread.length,
      };
    };
    return this;
  }

  setGetCommentsError(error: JiraApiError): this {
    this.getCommentsResponder = () => {
      throw error;
    };
    return this;
  }

  async searchJql(params: JiraSearchParams): Promise<JiraSearchResult> {
    this.searchCalls.push(params);
    return this.searchResponder(params);
  }

  async approximateCount(jql: string): Promise<JiraApproximateCount> {
    this.approximateCountCalls.push(jql);
    return { count: this.approxCount };
  }

  async getIssue(params: JiraGetIssueParams): Promise<JiraRestIssue> {
    this.getIssueCalls.push(params);
    return this.getIssueResponder(params);
  }

  async createIssue(payload: JiraWritePayload): Promise<JiraCreatedIssue> {
    this.createIssueCalls.push(payload);
    return this.createResponder(payload);
  }

  async updateIssue(params: JiraUpdateIssueParams): Promise<void> {
    this.updateIssueCalls.push(params);
    return this.updateIssueResponder(params);
  }

  async getCreateMeta(params: JiraCreateMetaParams): Promise<JiraCreateMeta> {
    this.createMetaCalls.push(params);
    return this.createMeta;
  }

  async searchUsers(query: string): Promise<JiraUser[]> {
    this.searchUsersCalls.push(query);
    return this.users;
  }

  async getCurrentUser(): Promise<JiraUser> {
    this.getCurrentUserCalls += 1;
    return this.currentUser;
  }

  async getProject(projectKey: string): Promise<JiraProject> {
    this.getProjectCalls.push(projectKey);
    return this.project;
  }

  async getProjectWorkflow(params: JiraProjectWorkflowParams): Promise<JiraProjectWorkflow> {
    this.getProjectWorkflowCalls.push(params);
    return this.projectWorkflowResponder(params);
  }

  async getTransitions(params: JiraGetTransitionsParams): Promise<JiraAvailableTransition[]> {
    this.getTransitionsCalls.push(params);
    return this.getTransitionsResponder(params);
  }

  async doTransition(params: JiraDoTransitionParams): Promise<void> {
    this.doTransitionCalls.push(params);
    return this.doTransitionResponder(params);
  }

  async listProjectBoards(projectKey: string): Promise<JiraProjectBoard[]> {
    this.listProjectBoardsCalls.push(projectKey);
    return this.projectBoards;
  }

  async addIssueToSprint(sprintId: number, issueKey: string): Promise<void> {
    this.addIssueToSprintCalls.push({ sprintId, issueKey });
    await this.addIssueToSprintResponder();
  }

  async moveIssueToBacklog(issueKey: string): Promise<void> {
    this.moveIssueToBacklogCalls.push(issueKey);
    await this.moveIssueToBacklogResponder();
  }

  async addComment(params: JiraAddCommentParams): Promise<JiraRestCommentFull> {
    this.addCommentCalls.push(params);
    return this.addCommentResponder(params);
  }

  async updateComment(params: JiraUpdateCommentParams): Promise<JiraRestCommentFull> {
    this.updateCommentCalls.push(params);
    return this.updateCommentResponder(params);
  }

  async getComment(params: JiraGetCommentParams): Promise<JiraRestCommentFull> {
    this.getCommentCalls.push(params);
    return this.getCommentResponder(params);
  }

  async getComments(params: JiraGetCommentsParams): Promise<JiraCommentsPage> {
    this.getCommentsCalls.push(params);
    return this.getCommentsResponder(params);
  }

  async getProjectRoles(projectKey: string): Promise<string[]> {
    this.getProjectRolesCalls.push(projectKey);
    return this.projectRoles;
  }

  async getAttachmentMeta(attachmentId: string): Promise<JiraAttachmentMeta> {
    this.getAttachmentMetaCalls.push(attachmentId);
    return this.attachmentMetaResponder(attachmentId);
  }

  async getAttachmentContent(attachmentId: string): Promise<Buffer> {
    this.getAttachmentContentCalls.push(attachmentId);
    return this.attachmentContentResponder(attachmentId);
  }

  async addAttachment(params: JiraAddAttachmentParams): Promise<JiraUploadedAttachment[]> {
    this.addAttachmentCalls.push(params);
    return this.addAttachmentResponder(params);
  }

  async listProjects(): Promise<JiraProjectSummary[]> {
    this.listProjectsCalls += 1;
    return this.projectCatalog;
  }

  async listFields(): Promise<JiraField[]> {
    this.listFieldsCalls += 1;
    return this.fieldCatalog;
  }

  async listIssueLinkTypes(): Promise<JiraIssueLinkType[]> {
    this.listIssueLinkTypesCalls += 1;
    return this.issueLinkTypes;
  }
}

/**
 * A board (with its open sprints) as `listProjectBoards` returns it. Tests pair
 * a `scrum` board carrying sprints with a `kanban` board carrying none, so the
 * resolver's scrum-board filter is actually exercised (a Kanban-only project
 * must surface "no sprint-supporting board", never a raw 400).
 */
export function makeBoard(opts: {
  id: number;
  name: string;
  type: "scrum" | "kanban";
  sprints?: { id: number; name: string; state: "active" | "future" }[];
}): JiraProjectBoard {
  return { id: opts.id, name: opts.name, type: opts.type, sprints: opts.sprints ?? [] };
}

/** Build a JIRA REST issue with the nested field shape the real API returns. */
export function makeIssue(opts: {
  key: string;
  summary?: string;
  status?: string;
  type?: string;
  priority?: string;
  /** Assignee display name, or null for unassigned. */
  assignee?: string | null;
  labels?: string[];
  updated?: string;
  /** Extra raw fields (e.g. custom fields like rank) merged into `fields`. */
  extraFields?: Record<string, unknown>;
}): JiraRestIssue {
  return {
    id: opts.key,
    key: opts.key,
    fields: {
      summary: opts.summary ?? `Summary for ${opts.key}`,
      status: { name: opts.status ?? "To Do" },
      issuetype: { name: opts.type ?? "Task" },
      priority: { name: opts.priority ?? "Medium" },
      assignee:
        opts.assignee === null
          ? null
          : { displayName: opts.assignee ?? "Jane Doe", accountId: "acc-123" },
      labels: opts.labels ?? [],
      updated: opts.updated ?? "2026-06-01T10:00:00.000+0000",
      ...opts.extraFields,
    },
  };
}

/**
 * An available transition as `getTransitions` returns it (already normalized).
 * `to` is the target status name; `fields` are the transition's screen fields
 * (default none). The numeric `id` is what the handler must resolve a name/status
 * down to before firing — tests assert it reaches `doTransition`.
 */
export function makeTransition(opts: {
  id: string;
  name: string;
  to: string;
  fields?: { fieldId: string; name: string; required: boolean }[];
}): JiraAvailableTransition {
  return { id: opts.id, name: opts.name, toStatus: opts.to, fields: opts.fields ?? [] };
}

/** Convenience: a 400 JQL parse error as the real client would surface it. */
export function jqlParseError(message = "Error in the JQL Query: unknown field 'frobnicate'."): JiraApiError {
  return new JiraApiError(400, [message], {});
}

/** Convenience: a 401 auth error as the real client's `/myself` preflight surfaces it. */
export function authError(message = "Client must be authenticated to access this resource."): JiraApiError {
  return new JiraApiError(401, [message], {});
}

/** Convenience: a 404 unknown-issue error as the real client surfaces it. */
export function notFoundError(message = "Issue does not exist or you do not have permission to see it."): JiraApiError {
  return new JiraApiError(404, [message], {});
}

// --- ADF + detail-field builders -------------------------------------------

/** Wrap text paragraphs into a minimal ADF document. */
export function adfDoc(...paragraphs: string[]): unknown {
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p }],
    })),
  };
}

/**
 * A raw JIRA comment with an ADF body.
 *
 * `properties` stamps out-of-band comment properties (e.g. the `mcp.origin`
 * authorship key); `author: null` models a comment JIRA returned with no author
 * (the human/unknown split). The `body` string flattens to markdown verbatim, so
 * a body that LEADS WITH a marker (`":claude: …"`) exercises the marker fallback.
 */
export function makeComment(opts: {
  id: string;
  author?: string | null;
  body: string;
  created?: string;
  updated?: string;
  properties?: { key: string; value: unknown }[];
}): Record<string, unknown> {
  return {
    id: opts.id,
    author:
      opts.author === null
        ? null
        : { displayName: opts.author ?? "Jane Doe", accountId: "acc-123" },
    body: adfDoc(opts.body),
    created: opts.created ?? "2026-06-01T10:00:00.000+0000",
    ...(opts.updated ? { updated: opts.updated } : {}),
    ...(opts.properties ? { properties: opts.properties } : {}),
  };
}

/** An `mcp.origin` authorship property, as the server stamps it. */
export function originProperty(): { key: string; value: unknown } {
  return { key: "mcp.origin", value: { authoredBy: "agent", source: "lean-jira-mcp" } };
}

/** The `fields.comment` container JIRA returns on an issue. */
export function makeCommentField(comments: Record<string, unknown>[], total = comments.length): Record<string, unknown> {
  return { comments, total, maxResults: comments.length, startAt: 0 };
}

/** An issue link (inward or outward) as JIRA returns it under `issuelinks`. */
export function makeIssueLink(opts: {
  direction: "inward" | "outward";
  key: string;
  summary?: string;
  status?: string;
  inward?: string;
  outward?: string;
}): Record<string, unknown> {
  const linked = {
    key: opts.key,
    fields: { summary: opts.summary ?? `Summary for ${opts.key}`, status: { name: opts.status ?? "To Do" } },
  };
  return {
    id: `link-${opts.key}`,
    type: { name: "Blocks", inward: opts.inward ?? "is blocked by", outward: opts.outward ?? "blocks" },
    ...(opts.direction === "inward" ? { inwardIssue: linked } : { outwardIssue: linked }),
  };
}

/**
 * An attachment as JIRA returns it under `fields.attachment` on an issue. The
 * same flat shape the `get_issue` full list serializes from; pair it with
 * `setAttachmentMeta` (built from these fields) when driving `jira_read_attachment`.
 */
export function makeAttachment(opts: {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created?: string;
  author?: string | null;
  content?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    filename: opts.filename,
    mimeType: opts.mimeType,
    size: opts.size,
    created: opts.created ?? "2026-06-20T08:00:00.000+0000",
    author:
      opts.author === null ? null : { displayName: opts.author ?? "Jane Doe", accountId: "acc-123" },
    content:
      opts.content ?? `https://example.atlassian.net/rest/api/3/attachment/content/${opts.id}`,
  };
}

/** The normalized attachment metadata `getAttachmentMeta` returns. */
export function makeAttachmentMeta(opts: {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created?: string;
  author?: string | null;
  contentUrl?: string | null;
}): JiraAttachmentMeta {
  return {
    id: opts.id,
    filename: opts.filename,
    mimeType: opts.mimeType,
    size: opts.size,
    created: opts.created ?? "2026-06-20T08:00:00.000+0000",
    author: opts.author === undefined ? "Jane Doe" : opts.author,
    contentUrl:
      opts.contentUrl === undefined
        ? `https://example.atlassian.net/rest/api/3/attachment/content/${opts.id}`
        : opts.contentUrl,
  };
}

/** A subtask reference as JIRA returns it under `subtasks`. */
export function makeSubtask(opts: { key: string; summary?: string; status?: string }): Record<string, unknown> {
  return {
    key: opts.key,
    fields: {
      summary: opts.summary ?? `Summary for ${opts.key}`,
      status: { name: opts.status ?? "To Do" },
      issuetype: { name: "Sub-task" },
    },
  };
}
