/**
 * Shared resource-content shaper.
 *
 * Resources return reference data, not the tool `hints` envelope — they are read
 * by URI and their whole payload is the deliverable. Each resource serializes a
 * plain JSON document into a single `application/json` text content block; the
 * agent reads `contents[0].text`, and tests parse it back with {@link parseResource}.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Test helper: parse the JSON payload back out of a resource read result. */
export function parseResource<T = unknown>(result: ReadResourceResult): T {
  const first = result.contents?.[0];
  if (!first || !("text" in first) || typeof first.text !== "string") {
    throw new Error("resource result has no text content");
  }
  return JSON.parse(first.text) as T;
}
