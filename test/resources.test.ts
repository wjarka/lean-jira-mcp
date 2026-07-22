/**
 * Static reference resources (`projects`, `jql-fields`, `link-types`), driven
 * end-to-end against the faked JiraClient — no transport, no network. Asserts on
 * the JSON document the agent reads back from each resource.
 *
 * Two design guarantees get explicit coverage here:
 *   1. these are MCP *resources*, not tools — `registerAllResources` must use
 *      `registerResource` and never add to the tool surface; and
 *   2. `jql-fields` actually surfaces custom field names usefully (its whole
 *      reason to exist — it's where `jira_search`'s parse-error hint points).
 */

import { test, expect, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IJiraClient } from "../src/lib/jira-client.ts";
import { FakeJiraClient } from "./helpers/fake-jira-client.ts";
import { parseResource } from "../src/resources/shape.ts";
import {
  projectsResourceHandler,
  registerProjectsResource,
  PROJECTS_URI,
} from "../src/resources/projects.ts";
import {
  jqlFieldsResourceHandler,
  registerJqlFieldsResource,
  JQL_FIELDS_URI,
} from "../src/resources/jql-fields.ts";
import {
  linkTypesResourceHandler,
  registerLinkTypesResource,
  LINK_TYPES_URI,
} from "../src/resources/link-types.ts";
import { registerAllResources } from "../src/resources/index.ts";

/**
 * Registers a single resource against a fake server and returns its captured
 * read callback — the same closure the MCP SDK would invoke on every actual
 * `resources/read`, so calling it more than once here exercises the handler
 * factory's cache exactly as repeated real reads would.
 */
function captureReadCallback(
  register: (server: McpServer, jira: IJiraClient) => void,
  jira: IJiraClient,
): (uri: string) => Promise<Parameters<typeof parseResource>[0]> {
  let readCallback: ((uri: { toString(): string }) => unknown) | undefined;
  const registerResource = mock((..._args: unknown[]) => {
    readCallback = _args[_args.length - 1] as typeof readCallback;
    return {};
  });
  const fakeServer = { registerResource, registerTool: mock(() => ({})) } as unknown as McpServer;
  register(fakeServer, jira);
  if (!readCallback) throw new Error("resource was not registered");
  const cb = readCallback;
  return (uri: string) => Promise.resolve(cb({ toString: () => uri })) as Promise<any>;
}

// --- projects ---------------------------------------------------------------

test("projects returns a flat catalog of visible projects, fetched via JiraClient", async () => {
  const jira = new FakeJiraClient().setProjectCatalog([
    { key: "ENG", name: "Engineering", id: "1", projectTypeKey: "software", lead: "Ada" },
    { key: "OPS", name: "Operations", id: "2", projectTypeKey: "business" },
  ]);

  const result = await projectsResourceHandler(jira);
  const payload = parseResource<any>(result);

  expect(jira.listProjectsCalls).toBe(1);
  expect(result.contents[0]!.uri).toBe(PROJECTS_URI);
  expect(result.contents[0]!.mimeType).toBe("application/json");
  expect(payload.count).toBe(2);
  expect(payload.projects).toEqual([
    { key: "ENG", name: "Engineering", type: "software", lead: "Ada" },
    { key: "OPS", name: "Operations", type: "business" },
  ]);
});

test("projects does not duplicate describe_project's per-project workflow shape", async () => {
  const jira = new FakeJiraClient().setProjectCatalog([
    { key: "ENG", name: "Engineering", id: "1", projectTypeKey: "software" },
  ]);

  const payload = parseResource<any>(await projectsResourceHandler(jira));
  const entry = payload.projects[0];

  // Catalog, not a drill-down: none of describe_project's workflow fields appear.
  expect(entry).not.toHaveProperty("issueTypes");
  expect(entry).not.toHaveProperty("statuses");
  expect(entry).not.toHaveProperty("transitions");
});

// --- jql-fields -------------------------------------------------------------

test("jql-fields surfaces custom field names and their JQL identifiers usefully", async () => {
  const jira = new FakeJiraClient().setFieldCatalog([
    { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"], schemaType: "string" },
    {
      id: "customfield_10016",
      name: "Story Points",
      custom: true,
      clauseNames: ["cf[10016]", "Story Points"],
      schemaType: "number",
    },
  ]);

  const result = await jqlFieldsResourceHandler(jira);
  const payload = parseResource<any>(result);

  expect(jira.listFieldsCalls).toBe(1);
  expect(payload.customFieldCount).toBe(1);

  // The custom field is present, named, flagged, and carries the identifiers an
  // agent needs to write correct JQL (`cf[ID]` and the quoted friendly name) —
  // never the raw `customfield_XXXXX` id alone.
  const story = payload.fields.find((f: any) => f.name === "Story Points");
  expect(story).toBeDefined();
  expect(story.custom).toBe(true);
  expect(story.jqlNames).toEqual(["cf[10016]", "Story Points"]);
  expect(story.type).toBe("number");
});

test("jql-fields lists custom fields before system fields", async () => {
  const jira = new FakeJiraClient().setFieldCatalog([
    { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"] },
    { id: "customfield_1", name: "Sprint", custom: true, clauseNames: ["Sprint", "cf[1]"] },
  ]);

  const payload = parseResource<any>(await jqlFieldsResourceHandler(jira));
  expect(payload.fields[0].name).toBe("Sprint");
  expect(payload.fields[0].custom).toBe(true);
});

test("jql-fields falls back to the field id when JIRA reports no clause names", async () => {
  const jira = new FakeJiraClient().setFieldCatalog([
    { id: "customfield_999", name: "Oddball", custom: true, clauseNames: [] },
  ]);

  const payload = parseResource<any>(await jqlFieldsResourceHandler(jira));
  expect(payload.fields[0].jqlNames).toEqual(["customfield_999"]);
});

// --- link-types -------------------------------------------------------------

test("link-types returns the available link types, fetched via JiraClient", async () => {
  const jira = new FakeJiraClient().setIssueLinkTypes([
    { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
  ]);

  const result = await linkTypesResourceHandler(jira);
  const payload = parseResource<any>(result);

  expect(jira.listIssueLinkTypesCalls).toBe(1);
  expect(result.contents[0]!.uri).toBe(LINK_TYPES_URI);
  expect(payload.count).toBe(2);
  expect(payload.linkTypes).toEqual([
    { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { name: "Relates", inward: "relates to", outward: "relates to" },
  ]);
});

// --- registration: resources, not tools -------------------------------------

test("registerAllResources registers three resources and adds nothing to the tool surface", () => {
  const registerResource = mock(() => ({}));
  const registerTool = mock(() => ({}));
  const fakeServer = { registerResource, registerTool } as unknown as McpServer;

  registerAllResources(fakeServer, new FakeJiraClient());

  // Three resources, zero tools.
  expect(registerResource).toHaveBeenCalledTimes(3);
  expect(registerTool).not.toHaveBeenCalled();

  const names = registerResource.mock.calls.map((c: any[]) => c[0]);
  const uris = registerResource.mock.calls.map((c: any[]) => c[1]);
  expect(names).toEqual(["projects", "jql-fields", "link-types"]);
  expect(uris).toEqual([PROJECTS_URI, JQL_FIELDS_URI, LINK_TYPES_URI]);
});

// --- per-process caching -----------------------------------------------------
//
// Each resource re-fetches its full catalog from JIRA on every read with no
// caching otherwise, unlike `get_issue`'s curated-field provider (which already
// memoizes `listFields()`). These confirm the same memoization now applies
// here: a second read is served from cache (no second JiraClient call), and a
// failed fetch is NOT cached — the next read retries instead of being pinned
// to the transient failure.

test("projects resource caches the catalog: a second read makes no further JiraClient call", async () => {
  const jira = new FakeJiraClient().setProjectCatalog([
    { key: "ENG", name: "Engineering", id: "1" },
  ]);
  const read = captureReadCallback(registerProjectsResource, jira);

  await read(PROJECTS_URI);
  await read(PROJECTS_URI);

  expect(jira.listProjectsCalls).toBe(1);
});

test("projects resource does not cache a failed fetch: the next read retries and can succeed", async () => {
  let calls = 0;
  const jira = new FakeJiraClient();
  jira.listProjects = async () => {
    calls++;
    if (calls === 1) throw new Error("transient project-catalog failure");
    return [{ key: "ENG", name: "Engineering", id: "1" }];
  };
  const read = captureReadCallback(registerProjectsResource, jira);

  // The failure propagates unshaped out of the handler (the resource error
  // boundary in core/server.ts is responsible for shaping it) — it must not
  // be swallowed into an error-flavored success payload here.
  await expect(read(PROJECTS_URI)).rejects.toThrow("transient project-catalog failure");
  const payload = parseResource<any>(await read(PROJECTS_URI));

  expect(calls).toBe(2);
  expect(payload.projects).toEqual([{ key: "ENG", name: "Engineering" }]);
});

test("jql-fields resource caches the field catalog: a second read makes no further JiraClient call", async () => {
  const jira = new FakeJiraClient().setFieldCatalog([
    { id: "summary", name: "Summary", custom: false, clauseNames: ["summary"] },
  ]);
  const read = captureReadCallback(registerJqlFieldsResource, jira);

  await read(JQL_FIELDS_URI);
  await read(JQL_FIELDS_URI);

  expect(jira.listFieldsCalls).toBe(1);
});

test("jql-fields resource does not cache a failed fetch: the next read retries and can succeed", async () => {
  let calls = 0;
  const jira = new FakeJiraClient();
  jira.listFields = async () => {
    calls++;
    if (calls === 1) throw new Error("transient field-catalog failure");
    return [{ id: "summary", name: "Summary", custom: false, clauseNames: ["summary"] }];
  };
  const read = captureReadCallback(registerJqlFieldsResource, jira);

  await expect(read(JQL_FIELDS_URI)).rejects.toThrow("transient field-catalog failure");
  const payload = parseResource<any>(await read(JQL_FIELDS_URI));

  expect(calls).toBe(2);
  expect(payload.fields).toEqual([{ name: "Summary", custom: false, jqlNames: ["summary"] }]);
});

test("link-types resource caches the catalog: a second read makes no further JiraClient call", async () => {
  const jira = new FakeJiraClient().setIssueLinkTypes([
    { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  ]);
  const read = captureReadCallback(registerLinkTypesResource, jira);

  await read(LINK_TYPES_URI);
  await read(LINK_TYPES_URI);

  expect(jira.listIssueLinkTypesCalls).toBe(1);
});

test("link-types resource does not cache a failed fetch: the next read retries and can succeed", async () => {
  let calls = 0;
  const jira = new FakeJiraClient();
  jira.listIssueLinkTypes = async () => {
    calls++;
    if (calls === 1) throw new Error("transient link-types failure");
    return [{ id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" }];
  };
  const read = captureReadCallback(registerLinkTypesResource, jira);

  await expect(read(LINK_TYPES_URI)).rejects.toThrow("transient link-types failure");
  const payload = parseResource<any>(await read(LINK_TYPES_URI));

  expect(calls).toBe(2);
  expect(payload.linkTypes).toEqual([{ name: "Blocks", inward: "is blocked by", outward: "blocks" }]);
});
