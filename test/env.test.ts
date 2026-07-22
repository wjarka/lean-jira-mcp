import { test, expect } from "bun:test";
import { loadEnvConfig, EnvError } from "../src/config/env.ts";

const valid = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_EMAIL: "me@acme.com",
  JIRA_API_TOKEN: "tok",
} as NodeJS.ProcessEnv;

test("loads a valid config and applies defaults", () => {
  const cfg = loadEnvConfig(valid);
  expect(cfg.baseUrl).toBe("https://acme.atlassian.net");
  expect(cfg.email).toBe("me@acme.com");
  expect(cfg.apiToken).toBe("tok");
  expect(cfg.commentMarker).toBe(":claude:"); // default
  expect(cfg.projectDefault).toBeUndefined();
  expect(cfg.attachmentMaxBytes).toBe(25 * 1024 * 1024); // default 25 MB
  expect(cfg.attachmentUploadMaxBytes).toBe(25 * 1024 * 1024); // default 25 MB
  // Default upload roots are populated (cwd + temp dirs), non-empty.
  expect(cfg.attachmentRoots.length).toBeGreaterThan(0);
});

test("attachmentRoots parses JIRA_ATTACHMENT_ROOT and upload cap reads its own var", () => {
  const cfg = loadEnvConfig({
    ...valid,
    JIRA_ATTACHMENT_ROOT: "/tmp",
    JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES: "1048576",
  });
  // /tmp realpaths to /private/tmp on macOS; either canonical form is valid.
  expect(cfg.attachmentRoots.some((r) => r === "/tmp" || r === "/private/tmp")).toBe(true);
  expect(cfg.attachmentUploadMaxBytes).toBe(1048576);
  // Invalid upload cap falls back to the default rather than throwing.
  expect(
    loadEnvConfig({ ...valid, JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES: "nope" }).attachmentUploadMaxBytes,
  ).toBe(25 * 1024 * 1024);
});

test("attachmentMaxBytes reads JIRA_MCP_ATTACHMENT_MAX_BYTES and ignores invalid values", () => {
  expect(loadEnvConfig({ ...valid, JIRA_MCP_ATTACHMENT_MAX_BYTES: "1048576" }).attachmentMaxBytes).toBe(
    1048576,
  );
  // Non-positive / non-numeric falls back to the default rather than throwing.
  expect(loadEnvConfig({ ...valid, JIRA_MCP_ATTACHMENT_MAX_BYTES: "-5" }).attachmentMaxBytes).toBe(
    25 * 1024 * 1024,
  );
  expect(loadEnvConfig({ ...valid, JIRA_MCP_ATTACHMENT_MAX_BYTES: "nope" }).attachmentMaxBytes).toBe(
    25 * 1024 * 1024,
  );
});

test("reads optional later-slice keys through the single read path", () => {
  const cfg = loadEnvConfig({
    ...valid,
    JIRA_PROJECT_DEFAULT: "ABC",
    JIRA_MCP_COMMENT_MARKER: ":robot:",
  });
  expect(cfg.projectDefault).toBe("ABC");
  expect(cfg.commentMarker).toBe(":robot:");
});

test("curatedFieldOverrides carries ONLY the explicitly set ids (for detection precedence)", () => {
  // No JIRA_FIELD_* set: empty, so the read path detects everything.
  expect(loadEnvConfig(valid).curatedFieldOverrides).toEqual({});

  const cfg = loadEnvConfig({ ...valid, JIRA_FIELD_SPRINT: "customfield_10113" });
  expect(cfg.curatedFieldOverrides).toEqual({ sprint: "customfield_10113" });
  // Defaults are NOT folded into the overrides — absent keys are left to detection.
  expect(cfg.curatedFieldOverrides.storyPoints).toBeUndefined();
  expect(cfg.curatedFieldOverrides.epicLink).toBeUndefined();
});

test("trims surrounding whitespace and a trailing slash on base URL", () => {
  const cfg = loadEnvConfig({
    JIRA_BASE_URL: "  https://acme.atlassian.net/  ",
    JIRA_EMAIL: "  me@acme.com ",
    JIRA_API_TOKEN: " tok ",
  } as NodeJS.ProcessEnv);
  expect(cfg.baseUrl).toBe("https://acme.atlassian.net");
  expect(cfg.email).toBe("me@acme.com");
  expect(cfg.apiToken).toBe("tok");
});

test.each(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"])(
  "fails fast with a clear message when %s is missing",
  (key) => {
    const env = { ...valid };
    delete (env as Record<string, unknown>)[key];
    expect(() => loadEnvConfig(env)).toThrow(EnvError);
    expect(() => loadEnvConfig(env)).toThrow(key);
  },
);

test("rejects a blank required value (not just absent)", () => {
  expect(() => loadEnvConfig({ ...valid, JIRA_API_TOKEN: "   " })).toThrow(EnvError);
});

test("rejects a base URL that is not an absolute http(s) URL", () => {
  expect(() => loadEnvConfig({ ...valid, JIRA_BASE_URL: "acme.atlassian.net" })).toThrow(
    /absolute http/,
  );
});
