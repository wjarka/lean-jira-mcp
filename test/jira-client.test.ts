/**
 * JiraClient retry/backoff — the real client driven against an injected fake
 * `fetch`, so the retry logic is exercised with no network and no real waiting.
 */

import { test, expect } from "bun:test";
import { JiraApiError, JiraClient } from "../src/lib/jira-client.ts";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(
  responses: Array<Response | (() => never)>,
  opts?: { sleeps?: number[]; myself?: Response },
) {
  let i = 0;
  let myselfCalls = 0;
  const sleeps = opts?.sleeps ?? [];
  // The client preflights `/myself` once; route it separately so the `responses`
  // queue stays the data-endpoint script the tests assert against.
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/myself")) {
      myselfCalls++;
      return opts?.myself ?? jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    const next = responses[i++];
    if (typeof next === "function") return next();
    if (!next) throw new Error("fetch called more times than expected");
    return next;
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetries: 3,
    baseDelayMs: 100,
  });
  return { client, callCount: () => i, myselfCount: () => myselfCalls };
}

test("addAttachment sends multipart with X-Atlassian-Token and no JSON content-type", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    captured = { url, init };
    return jsonResponse(200, [{ id: "99", filename: "shot.png", size: 12, mimeType: "image/png" }]);
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  const result = await client.addAttachment({
    issueKey: "PROJ-12",
    filename: "shot.png",
    mimeType: "image/png",
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });

  expect(result).toEqual([{ id: "99", filename: "shot.png", size: 12, mimeType: "image/png" }]);
  expect(captured?.url).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-12/attachments");
  const headers = captured?.init?.headers as Record<string, string>;
  expect(headers["X-Atlassian-Token"]).toBe("no-check");
  // multipart: Content-Type must NOT be forced to JSON (fetch sets the boundary),
  // and the body is a FormData carrying the file part.
  expect(headers["Content-Type"]).toBeUndefined();
  expect(captured?.init?.body).toBeInstanceOf(FormData);
  const form = captured?.init?.body as unknown as FormData;
  expect(form.get("file")).toBeInstanceOf(Blob);
});

test("retries a 429 and returns the eventual success; agent never sees the 429", async () => {
  const { client, callCount } = makeClient([
    jsonResponse(429, { errorMessages: ["rate limited"] }, { "retry-after": "2" }),
    jsonResponse(200, { issues: [], isLast: true }),
  ]);
  const result = await client.searchJql({ jql: "project = ABC" });
  expect(result.issues).toEqual([]);
  expect(callCount()).toBe(2);
});

test("honors Retry-After (seconds) for the backoff wait", async () => {
  const sleeps: number[] = [];
  const { client } = makeClient(
    [
      jsonResponse(429, {}, { "retry-after": "2" }),
      jsonResponse(200, { issues: [], isLast: true }),
    ],
    { sleeps },
  );
  await client.searchJql({ jql: "project = ABC" });
  expect(sleeps[0]).toBe(2000);
});

test("retries transient 5xx errors", async () => {
  const { client, callCount } = makeClient([
    jsonResponse(503, {}),
    jsonResponse(502, {}),
    jsonResponse(200, { count: 7 }),
  ]);
  const result = await client.approximateCount("project = ABC");
  expect(result.count).toBe(7);
  expect(callCount()).toBe(3);
});

test("does not retry a 400 and surfaces a typed JqlError", async () => {
  const { client, callCount } = makeClient([
    jsonResponse(400, { errorMessages: ["Error in the JQL Query"] }),
  ]);
  await expect(client.searchJql({ jql: "bad" })).rejects.toMatchObject({
    name: "JiraApiError",
    status: 400,
  });
  expect(callCount()).toBe(1);

  // And the error classifies as a JQL error.
  const { client: c2 } = makeClient([jsonResponse(400, { errorMessages: ["x"] })]);
  const err = await c2.searchJql({ jql: "bad" }).catch((e) => e);
  expect(err).toBeInstanceOf(JiraApiError);
  expect((err as JiraApiError).isJqlError).toBe(true);
});

test("preflights /myself and fails with an auth error when creds are rejected; data endpoint never hit", async () => {
  const { client, callCount } = makeClient([jsonResponse(200, { issues: [], isLast: true })], {
    myself: jsonResponse(401, { message: "unauthenticated" }),
  });
  const err = await client.searchJql({ jql: "project = ABC" }).catch((e) => e);
  expect(err).toBeInstanceOf(JiraApiError);
  expect((err as JiraApiError).isAuthError).toBe(true);
  expect(callCount()).toBe(0); // never reached the search endpoint
});

test("verifies auth once and caches it across subsequent calls", async () => {
  const { client, myselfCount } = makeClient([
    jsonResponse(200, { issues: [], isLast: true }),
    jsonResponse(200, { count: 1 }),
  ]);
  await client.searchJql({ jql: "project = ABC" });
  await client.approximateCount("project = ABC");
  expect(myselfCount()).toBe(1);
});

test("getComments builds the comment-list URL with startAt, maxResults, orderBy, and expand", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    capturedUrl = String(url);
    return jsonResponse(200, { comments: [], startAt: 0, maxResults: 20, total: 0 });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  await client.getComments({
    issueKey: "ABC-1",
    startAt: 40,
    maxResults: 20,
    orderBy: "-created",
    expand: ["properties"],
  });

  expect(capturedUrl).toContain("/rest/api/3/issue/ABC-1/comment?");
  expect(capturedUrl).toContain("startAt=40");
  expect(capturedUrl).toContain("maxResults=20");
  expect(capturedUrl).toContain("orderBy=-created");
  expect(capturedUrl).toContain("expand=properties");
});

test("retries network errors then throws after exhausting retries", async () => {
  const boom = () => {
    throw new Error("ECONNRESET");
  };
  const { client, callCount } = makeClient([boom, boom, boom, boom]);
  await expect(client.searchJql({ jql: "project = ABC" })).rejects.toBeInstanceOf(JiraApiError);
  expect(callCount()).toBe(4); // 1 initial + 3 retries
});

test("getProjectWorkflow hits the workflow PREVIEW endpoint with {projectId, issueTypeIds}", async () => {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith("/statuses")) {
      return jsonResponse(200, [{ id: "10101", name: "Task", statuses: [{ id: "1", name: "To Do" }] }]);
    }
    return jsonResponse(200, { statuses: [], workflows: [] });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  await client.getProjectWorkflow({ projectKey: "ENG", issueType: "Task", projectId: "11993" });

  const workflowCall = calls.find((c) => c.url.includes("/workflows"));
  expect(workflowCall?.url).toContain("/rest/api/3/workflows/preview");
  // Permission check keys off projectId; issueTypeIds selects the workflow(s).
  expect(workflowCall?.body).toEqual({ projectId: "11993", issueTypeIds: ["10101"] });
});

test("getProjectWorkflow maps the preview response: INITIAL dropped, GLOBAL flagged, DIRECTED keyed by source", async () => {
  const { client } = makeClient([
    // 1) GET /project/ENG/statuses
    jsonResponse(200, [
      {
        id: "1",
        name: "Task",
        statuses: [
          { id: "1", name: "To Do" },
          { id: "2", name: "In Progress" },
          { id: "3", name: "Done" },
        ],
      },
    ]),
    // 2) POST /rest/api/3/workflows/preview
    jsonResponse(200, {
      statuses: [
        { statusReference: "s1", name: "To Do" },
        { statusReference: "s2", name: "In Progress" },
        { statusReference: "s3", name: "Done" },
      ],
      workflows: [
        {
          transitions: [
            { name: "Create", type: "INITIAL", toStatusReference: "s1" },
            { name: "Start", type: "DIRECTED", toStatusReference: "s2", links: [{ fromStatusReference: "s1" }] },
            { name: "Finish", type: "GLOBAL", toStatusReference: "s3" },
          ],
        },
      ],
    }),
  ]);

  const wf = await client.getProjectWorkflow({ projectKey: "ENG", issueType: "Task", projectId: "10000" });

  expect(wf.statuses).toEqual(["To Do", "In Progress", "Done"]);
  // INITIAL (the create pseudo-transition) is dropped; GLOBAL has empty sources.
  expect(wf.transitions).toEqual([
    { name: "Start", toStatus: "In Progress", fromStatuses: ["To Do"], isGlobal: false, requires: [], hasScreen: false },
    { name: "Finish", toStatus: "Done", fromStatuses: [], isGlobal: true, requires: [], hasScreen: false },
  ]);
  // A successfully-parsed preview read is FULL fidelity — a missing `requires`
  // genuinely means ungated.
  expect(wf.ruleFidelity).toBe("full");
});

test("getProjectWorkflow parses preview conditions/validators/screen into requires + hasScreen (rules ride preview — no admin gate)", async () => {
  const { client } = makeClient([
    jsonResponse(200, [
      { id: "1", name: "Task", statuses: [{ id: "1", name: "In Review" }, { id: "2", name: "Release Pending" }] },
    ]),
    // The PROJ-104 reproduction shape: a DIRECTED edge gated by a restrict-issue-
    // transition CONDITION, plus a screen, plus a validator on another edge.
    jsonResponse(200, {
      statuses: [
        { statusReference: "s1", name: "In Review" },
        { statusReference: "s2", name: "Release Pending" },
      ],
      workflows: [
        {
          transitions: [
            {
              name: "Release Pending",
              type: "DIRECTED",
              toStatusReference: "s2",
              links: [{ fromStatusReference: "s1" }],
              conditions: {
                operation: "ALL",
                conditionGroups: [],
                conditions: [{ ruleKey: "system:restrict-issue-transition", id: "c1" }],
              },
              validators: [],
              actions: [{ ruleKey: "system:update-field", id: "a1" }],
              triggers: [{ ruleKey: "system:development-triggers", id: "t1" }],
            },
            {
              name: "QA Fail",
              type: "DIRECTED",
              toStatusReference: "s1",
              links: [{ fromStatusReference: "s2" }],
              validators: [{ ruleKey: "system:validate-field-value", id: "v1" }],
              transitionScreen: { ruleKey: "system:transition-screen", id: "sc1" },
            },
          ],
        },
      ],
    }),
  ]);

  const wf = await client.getProjectWorkflow({ projectKey: "PROJ", issueType: "Task", projectId: "11993" });

  expect(wf.ruleFidelity).toBe("full");
  const prod = wf.transitions.find((t) => t.name === "Release Pending")!;
  // The restrict condition becomes a terse phrase; actions/triggers are dropped.
  expect(prod.requires).toEqual(["restricted to specific users/groups/roles"]);
  expect(prod.hasScreen).toBe(false);
  const qa = wf.transitions.find((t) => t.name === "QA Fail")!;
  expect(qa.requires).toEqual(["a field value must satisfy a rule"]);
  expect(qa.hasScreen).toBe(true);
});

test("getProjectWorkflow collects nested conditionGroups ruleKeys (never silently drops a gate)", async () => {
  const { client } = makeClient([
    jsonResponse(200, [{ id: "1", name: "Task", statuses: [{ id: "1", name: "A" }, { id: "2", name: "B" }] }]),
    jsonResponse(200, {
      statuses: [{ statusReference: "s1", name: "A" }, { statusReference: "s2", name: "B" }],
      workflows: [
        {
          transitions: [
            {
              name: "Go",
              type: "DIRECTED",
              toStatusReference: "s2",
              links: [{ fromStatusReference: "s1" }],
              conditions: {
                operation: "ANY",
                conditions: [{ ruleKey: "system:restrict-issue-transition", id: "c1" }],
                conditionGroups: [
                  { operation: "ALL", conditions: [{ ruleKey: "com.acme:plugin-condition", id: "c2" }], conditionGroups: [] },
                ],
              },
              validators: [],
            },
          ],
        },
      ],
    }),
  ]);

  const wf = await client.getProjectWorkflow({ projectKey: "ENG", issueType: "Task", projectId: "10000" });
  const go = wf.transitions.find((t) => t.name === "Go")!;
  // The top-level recognized condition AND the nested custom one both surface;
  // the custom plugin gate degrades visibly rather than vanishing.
  expect(go.requires).toContain("restricted to specific users/groups/roles");
  expect(go.requires!.some((r) => r.includes("com.acme:plugin-condition"))).toBe(true);
});

test("getProjectWorkflow degrades to statuses-only when the workflow read is forbidden (admin-gated)", async () => {
  const { client } = makeClient([
    // GET /project/ENG/statuses succeeds with the same token...
    jsonResponse(200, [
      { id: "1", name: "Task", statuses: [{ id: "1", name: "To Do" }, { id: "2", name: "Done" }] },
    ]),
    // ...but the workflow read can still 403 (e.g. restricted workflow) → degrade.
    jsonResponse(403, { errorMessages: ["No permission to view workflow."] }),
  ]);

  const wf = await client.getProjectWorkflow({ projectKey: "ENG", issueType: "Task", projectId: "10000" });

  // Statuses still come back; transitions degrade to empty rather than throwing.
  expect(wf.statuses).toEqual(["To Do", "Done"]);
  expect(wf.transitions).toEqual([]);
  // The workflow DEFINITION couldn't be read → topology fidelity, so a missing
  // `requires` reads as UNKNOWN, not none.
  expect(wf.ruleFidelity).toBe("topology");
});

// --- transitions (jira_transition seam) -------------------------------------

test("getTransitions GETs the issue transitions with expand=transitions.fields", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    capturedUrl = String(url);
    return jsonResponse(200, { transitions: [] });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  await client.getTransitions({ issueKey: "ABC-1" });

  expect(capturedUrl).toContain("/rest/api/3/issue/ABC-1/transitions");
  expect(capturedUrl).toContain("expand=transitions.fields");
});

test("getTransitions normalizes id/name/toStatus and flattens the screen-fields map", async () => {
  const { client } = makeClient([
    jsonResponse(200, {
      transitions: [
        { id: "11", name: "Start Progress", to: { name: "In Progress" } },
        {
          id: "31",
          name: "Done",
          to: { name: "Done" },
          fields: {
            resolution: { name: "Resolution", required: true },
            customfield_10001: { name: "Sign-off", required: false },
          },
        },
      ],
    }),
  ]);

  const transitions = await client.getTransitions({ issueKey: "ABC-1" });

  expect(transitions).toEqual([
    { id: "11", name: "Start Progress", toStatus: "In Progress", fields: [] },
    {
      id: "31",
      name: "Done",
      toStatus: "Done",
      fields: [
        { fieldId: "resolution", name: "Resolution", required: true },
        { fieldId: "customfield_10001", name: "Sign-off", required: false },
      ],
    },
  ]);
});

test("doTransition POSTs {transition:{id}} and the fields payload", async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // JIRA returns 204 No Content on a successful transition.
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  await client.doTransition({
    issueKey: "ABC-1",
    transitionId: "31",
    fields: { resolution: { name: "Done" } },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toContain("/rest/api/3/issue/ABC-1/transitions");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toEqual({
    transition: { id: "31" },
    fields: { resolution: { name: "Done" } },
  });
});

test("doTransition omits the fields key entirely when none are supplied", async () => {
  let capturedBody: unknown;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  await client.doTransition({ issueKey: "ABC-1", transitionId: "11" });

  expect(capturedBody).toEqual({ transition: { id: "11" } });
});

// --- static reference data (resources seam) ---------------------------------

test("listProjects walks every page of /project/search and flattens the catalog", async () => {
  const { client, callCount } = makeClient([
    jsonResponse(200, {
      isLast: false,
      values: [
        { id: "1", key: "ENG", name: "Engineering", projectTypeKey: "software", lead: { displayName: "Ada" } },
        { id: "2", key: "OPS", name: "Operations", projectTypeKey: "business" },
      ],
    }),
    jsonResponse(200, {
      isLast: true,
      values: [{ id: "3", key: "QA", name: "Quality", projectTypeKey: "software" }],
    }),
  ]);

  const projects = await client.listProjects();

  expect(callCount()).toBe(2); // paged through both pages
  expect(projects).toEqual([
    { key: "ENG", name: "Engineering", id: "1", projectTypeKey: "software", lead: "Ada" },
    { key: "OPS", name: "Operations", id: "2", projectTypeKey: "business" },
    { key: "QA", name: "Quality", id: "3", projectTypeKey: "software" },
  ]);
});

test("listFields maps the field catalog, preserving custom flag and clauseNames", async () => {
  const { client } = makeClient([
    jsonResponse(200, [
      { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"], schema: { type: "string" } },
      {
        id: "customfield_10016",
        name: "Story Points",
        custom: true,
        clauseNames: ["cf[10016]", "Story Points"],
        schema: { type: "number" },
      },
    ]),
  ]);

  const fields = await client.listFields();

  expect(fields).toEqual([
    { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"], schemaType: "string" },
    {
      id: "customfield_10016",
      name: "Story Points",
      custom: true,
      clauseNames: ["cf[10016]", "Story Points"],
      schemaType: "number",
    },
  ]);
});

// --- attachments (jira_read_attachment seam) --------------------------------

test("getAttachmentMeta GETs /attachment/{id} and normalizes the metadata", async () => {
  const { client } = makeClient([
    jsonResponse(200, {
      id: "10042",
      filename: "screenshot.png",
      mimeType: "image/png",
      size: 12345,
      created: "2026-06-20T08:00:00.000+0000",
      author: { displayName: "Jane Doe" },
      content: "https://example.atlassian.net/rest/api/3/attachment/content/10042",
    }),
  ]);

  const meta = await client.getAttachmentMeta("10042");

  expect(meta).toEqual({
    id: "10042",
    filename: "screenshot.png",
    mimeType: "image/png",
    size: 12345,
    created: "2026-06-20T08:00:00.000+0000",
    author: "Jane Doe",
    contentUrl: "https://example.atlassian.net/rest/api/3/attachment/content/10042",
  });
});

test("getAttachmentContent reads the content endpoint as raw bytes (not JSON)", async () => {
  let capturedUrl = "";
  let capturedAccept = "";
  const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // PNG-ish bytes
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    capturedUrl = String(url);
    capturedAccept = String((init?.headers as Record<string, string>)?.Accept ?? "");
    return new Response(payload, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  const bytes = await client.getAttachmentContent("10042");

  expect(capturedUrl).toContain("/rest/api/3/attachment/content/10042");
  expect(capturedAccept).toBe("*/*"); // not application/json — it's binary
  expect(Buffer.isBuffer(bytes)).toBe(true);
  expect(new Uint8Array(bytes)).toEqual(payload);
});

test("getAttachmentContent retries a transient 5xx then returns the bytes", async () => {
  const { client, callCount } = makeClient([
    jsonResponse(503, {}),
    new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  ]);
  const bytes = await client.getAttachmentContent("10042");
  expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  expect(callCount()).toBe(2); // retry path is shared with JSON requests
});

test("listProjectBoards fetches board sprints concurrently, preserves board order over completion order, and degrades a failing board to empty sprints", async () => {
  const events: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/myself")) {
      return jsonResponse(200, { accountId: "me", displayName: "Me" });
    }
    if (u.includes("/rest/agile/1.0/board?")) {
      return jsonResponse(200, {
        values: [
          { id: 1, name: "Board One", type: "scrum" },
          { id: 2, name: "Board Two", type: "scrum" },
          { id: 3, name: "Board Three", type: "kanban" },
        ],
      });
    }
    const m = u.match(/board\/(\d+)\/sprint/);
    if (m) {
      const id = m[1]!;
      events.push(`start:${id}`);
      if (id === "2") {
        // Board 2's sprint read is both the SLOWEST and a FAILURE: it finishes
        // last, after board 1 has already finished — proving the fetches ran
        // concurrently (a sequential for-loop would finish board 1 in full
        // before board 2 even starts) — and proving a failing board degrades
        // to empty sprints rather than failing the whole listing.
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end:${id}`);
        return jsonResponse(400, { errorMessages: ["board does not support sprints"] });
      }
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end:${id}`);
      return jsonResponse(200, {
        values: [{ id: 100 + Number(id), name: `Sprint ${id}`, state: "active" }],
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;

  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net",
    email: "me@example.com",
    apiToken: "token",
    fetchImpl,
  });

  const boards = await client.listProjectBoards("ENG");

  // Board order preserved (id order), not completion order (board 2 finishes
  // last but stays second in the result).
  expect(boards.map((b) => b.id)).toEqual([1, 2, 3]);
  expect(boards[0]?.sprints).toEqual([{ id: 101, name: "Sprint 1", state: "active" }]);
  // Board 2's sprint read failed with a 400 -> degrades to empty sprints,
  // the batch as a whole still succeeds.
  expect(boards[1]?.sprints).toEqual([]);
  // Kanban board 3 is never queried for sprints at all.
  expect(boards[2]?.sprints).toEqual([]);

  // Concurrency proof: board 1's sprint request started AND finished before
  // board 2's finished, but board 2's request had already started by then too
  // — i.e. both were in flight together, not run one at a time.
  expect(events).toEqual(["start:1", "start:2", "end:1", "end:2"]);
});

test("listIssueLinkTypes unwraps the issueLinkTypes envelope", async () => {
  const { client } = makeClient([
    jsonResponse(200, {
      issueLinkTypes: [
        { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
      ],
    }),
  ]);

  const types = await client.listIssueLinkTypes();

  expect(types).toEqual([
    { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
  ]);
});
