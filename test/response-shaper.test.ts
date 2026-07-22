import { test, expect } from "bun:test";
import { shapeSuccess, shapeError, parseShaped, browseUrl } from "../src/lib/response-shaper.ts";

test("shapeSuccess stamps hints onto the payload and is not an error", () => {
  const result = shapeSuccess({ issues: [], count: 0 }, ["a hint"]);
  expect(result.isError).toBeFalsy();
  const payload = parseShaped(result) as Record<string, unknown>;
  expect(payload.issues).toEqual([]);
  expect(payload.count).toBe(0);
  expect(payload.hints).toEqual(["a hint"]);
});

test("shapeError marks isError, includes the message and hints", () => {
  const result = shapeError({ message: "bad value", code: "x" }, ["fix it"]);
  expect(result.isError).toBe(true);
  const payload = parseShaped(result) as {
    error: { message: string; code?: string; options?: unknown };
    hints: string[];
  };
  expect(payload.error.message).toBe("bad value");
  expect(payload.error.code).toBe("x");
  expect(payload.hints).toEqual(["fix it"]);
});

test("shapeError carries valid options for the offending entity when provided", () => {
  const result = shapeError(
    { message: "unknown status", options: ["To Do", "Done"] },
    ["pick one of the options"],
  );
  const payload = parseShaped(result) as { error: { options?: unknown } };
  expect(payload.error.options).toEqual(["To Do", "Done"]);
});

test("both success and error always carry a hints field", () => {
  expect((parseShaped(shapeSuccess({}, [])) as { hints: unknown }).hints).toBeDefined();
  expect((parseShaped(shapeError({ message: "e" }, [])) as { hints: unknown }).hints).toBeDefined();
});

test("browseUrl builds a plain issue deep link and strips trailing slashes from baseUrl", () => {
  expect(browseUrl("https://acme.atlassian.net", "ABC-123")).toBe(
    "https://acme.atlassian.net/browse/ABC-123",
  );
  expect(browseUrl("https://acme.atlassian.net/", "ABC-123")).toBe(
    "https://acme.atlassian.net/browse/ABC-123",
  );
  expect(browseUrl("https://acme.atlassian.net///", "ABC-123")).toBe(
    "https://acme.atlassian.net/browse/ABC-123",
  );
});

test("browseUrl URI-encodes the issue key (a no-op for a normal key)", () => {
  expect(browseUrl("https://acme.atlassian.net", "ABC-123")).toBe(
    "https://acme.atlassian.net/browse/ABC-123",
  );
  expect(browseUrl("https://acme.atlassian.net", "ABC 123")).toBe(
    "https://acme.atlassian.net/browse/ABC%20123",
  );
});

test("browseUrl appends an encoded focusedCommentId when given", () => {
  expect(browseUrl("https://acme.atlassian.net", "ABC-1", { focusedCommentId: "98765" })).toBe(
    "https://acme.atlassian.net/browse/ABC-1?focusedCommentId=98765",
  );
  expect(browseUrl("https://acme.atlassian.net", "ABC-1", {})).toBe(
    "https://acme.atlassian.net/browse/ABC-1",
  );
});
