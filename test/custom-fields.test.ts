/**
 * Unit tests for the curated custom-field friendly-name mapping.
 *
 * v1 surfaces exactly three agile custom fields — story points, sprint, epic
 * link — by friendly name, and NEVER leaks a `customfield_XXXXX` identifier.
 * Ids vary per JIRA instance, so the mapping is overridable; defaults are the
 * common Atlassian Cloud values. A later reference-resolver slice can feed it
 * ids discovered from the field catalog.
 */

import { test, expect } from "bun:test";
import {
  DEFAULT_CURATED_FIELD_IDS,
  buildCuratedFields,
  extractCuratedFields,
  curatedRequestIds,
  isCuratedFriendlyName,
} from "../src/lib/custom-fields.ts";

const curated = buildCuratedFields(DEFAULT_CURATED_FIELD_IDS);

test("story points resolves to a friendly name with a numeric value", () => {
  const out = extractCuratedFields({ [DEFAULT_CURATED_FIELD_IDS.storyPoints]: 8 }, curated);
  expect(out).toEqual({ storyPoints: 8 });
});

test("sprint resolves to the active sprint's name", () => {
  const out = extractCuratedFields(
    {
      [DEFAULT_CURATED_FIELD_IDS.sprint]: [
        { id: 1, name: "Sprint 1", state: "closed" },
        { id: 2, name: "Sprint 2", state: "active" },
      ],
    },
    curated,
  );
  expect(out).toEqual({ sprint: "Sprint 2" });
});

test("sprint falls back to the last sprint when none is active", () => {
  const out = extractCuratedFields(
    {
      [DEFAULT_CURATED_FIELD_IDS.sprint]: [
        { id: 1, name: "Sprint 1", state: "closed" },
        { id: 2, name: "Sprint 2", state: "closed" },
      ],
    },
    curated,
  );
  expect(out).toEqual({ sprint: "Sprint 2" });
});

test("epic link resolves to the epic issue key", () => {
  const out = extractCuratedFields({ [DEFAULT_CURATED_FIELD_IDS.epicLink]: "PROJ-1" }, curated);
  expect(out).toEqual({ epicLink: "PROJ-1" });
});

test("null / absent curated fields are omitted entirely", () => {
  const out = extractCuratedFields(
    {
      [DEFAULT_CURATED_FIELD_IDS.storyPoints]: null,
      [DEFAULT_CURATED_FIELD_IDS.sprint]: null,
      summary: "noise",
    },
    curated,
  );
  expect(out).toEqual({});
});

test("the raw customfield identifier never appears as an output key", () => {
  const out = extractCuratedFields({ [DEFAULT_CURATED_FIELD_IDS.storyPoints]: 3 }, curated);
  for (const key of Object.keys(out)) {
    expect(key).not.toMatch(/^customfield_/);
  }
});

test("curatedRequestIds returns the underlying customfield ids to request from JIRA", () => {
  const ids = curatedRequestIds(curated);
  expect(ids).toContain(DEFAULT_CURATED_FIELD_IDS.storyPoints);
  expect(ids).toContain(DEFAULT_CURATED_FIELD_IDS.sprint);
  expect(ids).toContain(DEFAULT_CURATED_FIELD_IDS.epicLink);
});

test("isCuratedFriendlyName recognizes the curated names case-insensitively", () => {
  expect(isCuratedFriendlyName("storyPoints")).toBe(true);
  expect(isCuratedFriendlyName("StoryPoints")).toBe(true);
  expect(isCuratedFriendlyName("sprint")).toBe(true);
  expect(isCuratedFriendlyName("epicLink")).toBe(true);
  expect(isCuratedFriendlyName("duedate")).toBe(false);
});

test("ids are overridable for instances whose custom fields differ", () => {
  const custom = buildCuratedFields({
    storyPoints: "customfield_99999",
    sprint: "customfield_99998",
    epicLink: "customfield_99997",
  });
  const out = extractCuratedFields({ customfield_99999: 13 }, custom);
  expect(out).toEqual({ storyPoints: 13 });
});
