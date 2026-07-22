/**
 * Curated custom-field DETECTION — the fix for the hardcoded-cloud-default bug
 * (issue 13). The curated agile ids (Story Points, Sprint, Epic Link) vary per
 * instance; assuming the cloud defaults silently broke `get_issue` on any
 * instance whose ids differ. Detection reads the field metadata once and matches
 * by SCHEMA (Sprint/Epic Link) or NAME (Story Points), never by a guessed id.
 *
 * Precedence: explicit `JIRA_FIELD_*` override → auto-detected → hardcoded
 * default (ONLY when detection couldn't run at all). A field that detection ran
 * but did not find, with no override, is OMITTED — never read against a guess.
 */

import { test, expect } from "bun:test";
import {
  DEFAULT_CURATED_FIELD_IDS,
  detectCuratedFieldIds,
  resolveCuratedFields,
  type FieldMeta,
} from "../src/lib/custom-fields.ts";
import {
  createCuratedFieldsProvider,
  staticCuratedFieldsProvider,
} from "../src/lib/curated-field-provider.ts";
import type { JiraField } from "../src/lib/jira-client.ts";

/** A realistic non-default field catalog: every curated id differs from the cloud default. */
const NON_DEFAULT_CATALOG: FieldMeta[] = [
  { id: "summary", name: "Summary" },
  { id: "customfield_10113", name: "Sprint", schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint" },
  { id: "customfield_10111", name: "Epic Link", schemaCustom: "com.pyxis.greenhopper.jira:gh-epic-link" },
  { id: "customfield_10105", name: "Story Points" },
];

test("detects sprint by schema.custom regardless of its id", () => {
  const ids = detectCuratedFieldIds(NON_DEFAULT_CATALOG);
  expect(ids.sprint).toBe("customfield_10113");
});

test("detects epic link by schema.custom regardless of its id", () => {
  const ids = detectCuratedFieldIds(NON_DEFAULT_CATALOG);
  expect(ids.epicLink).toBe("customfield_10111");
});

test("detects story points by name (company-managed 'Story Points')", () => {
  const ids = detectCuratedFieldIds(NON_DEFAULT_CATALOG);
  expect(ids.storyPoints).toBe("customfield_10105");
});

test("detects team-managed story points by 'Story point estimate'", () => {
  const ids = detectCuratedFieldIds([
    { id: "customfield_10222", name: "Story point estimate" },
  ]);
  expect(ids.storyPoints).toBe("customfield_10222");
});

test("name match for story points is case-insensitive and trimmed", () => {
  const ids = detectCuratedFieldIds([{ id: "customfield_10300", name: "  STORY POINTS " }]);
  expect(ids.storyPoints).toBe("customfield_10300");
});

test("does NOT match sprint by a guessed id or by name alone — schema is required", () => {
  // A field literally named "Sprint" but without the greenhopper schema key is
  // not the agile Sprint field; matching it would re-introduce the guessing bug.
  const ids = detectCuratedFieldIds([{ id: "customfield_10020", name: "Sprint" }]);
  expect(ids.sprint).toBeUndefined();
});

test("a curated field absent from the catalog is simply not detected", () => {
  const ids = detectCuratedFieldIds([{ id: "summary", name: "Summary" }]);
  expect(ids).toEqual({});
});

test("story points must be a customfield_ id — a same-named system field is ignored", () => {
  const ids = detectCuratedFieldIds([
    { id: "storypointsystem", name: "Story Points" },
    { id: "customfield_10105", name: "Story Points" },
  ]);
  expect(ids.storyPoints).toBe("customfield_10105");
});

// --- precedence ------------------------------------------------------------

test("precedence: explicit override wins over detection", () => {
  const detected = { sprint: "customfield_10113" };
  const resolved = resolveCuratedFields(detected, { sprint: "customfield_99999" });
  const sprint = resolved.curated.find((f) => f.friendlyName === "sprint");
  expect(sprint?.fieldId).toBe("customfield_99999");
  expect(resolved.sources.sprint).toBe("override");
});

test("precedence: detection wins over the hardcoded default", () => {
  const detected = detectCuratedFieldIds(NON_DEFAULT_CATALOG);
  const resolved = resolveCuratedFields(detected, {});
  const sprint = resolved.curated.find((f) => f.friendlyName === "sprint");
  expect(sprint?.fieldId).toBe("customfield_10113");
  expect(sprint?.fieldId).not.toBe(DEFAULT_CURATED_FIELD_IDS.sprint);
  expect(resolved.sources.sprint).toBe("detected");
});

test("a field with no override that detection did not find is OMITTED, not defaulted", () => {
  // Detection ran (non-null) and found only sprint; story points / epic link are
  // omitted rather than read against the guessed cloud default.
  const resolved = resolveCuratedFields({ sprint: "customfield_10113" }, {});
  expect(resolved.curated.map((f) => f.friendlyName)).toEqual(["sprint"]);
  expect(resolved.omitted.sort()).toEqual(["epicLink", "storyPoints"]);
  for (const f of resolved.curated) {
    expect(f.fieldId).not.toBeUndefined();
  }
});

test("an omitted field can still be rescued by an explicit override", () => {
  const resolved = resolveCuratedFields(
    { sprint: "customfield_10113" },
    { storyPoints: "customfield_10500" },
  );
  const sp = resolved.curated.find((f) => f.friendlyName === "storyPoints");
  expect(sp?.fieldId).toBe("customfield_10500");
  expect(resolved.sources.storyPoints).toBe("override");
  expect(resolved.omitted).toEqual(["epicLink"]);
});

test("detection UNAVAILABLE (null) falls back to the hardcoded default — last resort", () => {
  const resolved = resolveCuratedFields(null, {});
  const byName = Object.fromEntries(resolved.curated.map((f) => [f.friendlyName, f.fieldId]));
  expect(byName).toEqual(DEFAULT_CURATED_FIELD_IDS);
  expect(resolved.omitted).toEqual([]);
  expect(resolved.sources.sprint).toBe("default");
});

test("detection unavailable + override: override still wins over the default", () => {
  const resolved = resolveCuratedFields(null, { sprint: "customfield_77777" });
  const sprint = resolved.curated.find((f) => f.friendlyName === "sprint");
  expect(sprint?.fieldId).toBe("customfield_77777");
  expect(resolved.sources.sprint).toBe("override");
  expect(resolved.sources.epicLink).toBe("default");
});

// --- memoized provider -----------------------------------------------------

/** Minimal listFields seam stub with a call counter and optional throw. */
function fieldStub(catalog: JiraField[], opts: { throwTimes?: number } = {}) {
  let calls = 0;
  let remainingThrows = opts.throwTimes ?? 0;
  return {
    get calls() {
      return calls;
    },
    async listFields(): Promise<JiraField[]> {
      calls += 1;
      if (remainingThrows > 0) {
        remainingThrows -= 1;
        throw new Error("transient");
      }
      return catalog;
    },
  };
}

const asField = (f: FieldMeta): JiraField => ({
  id: f.id,
  name: f.name,
  custom: f.id.startsWith("customfield_"),
  clauseNames: [],
  ...(f.schemaCustom !== undefined ? { schemaCustom: f.schemaCustom } : {}),
});

test("provider reads field metadata exactly ONCE across repeated calls (memoized)", async () => {
  const stub = fieldStub(NON_DEFAULT_CATALOG.map(asField));
  const provider = createCuratedFieldsProvider(stub, {});

  const [a, b] = await Promise.all([provider.get(), provider.get()]);
  await provider.get();

  expect(stub.calls).toBe(1);
  expect(a).toBe(b);
  const sprint = a.curated.find((f) => f.friendlyName === "sprint");
  expect(sprint?.fieldId).toBe("customfield_10113");
});

test("provider falls back to defaults when the metadata read fails, and retries next call", async () => {
  const stub = fieldStub(NON_DEFAULT_CATALOG.map(asField), { throwTimes: 1 });
  const provider = createCuratedFieldsProvider(stub, {});

  const first = await provider.get(); // listFields throws → defaults, not cached
  const byName = Object.fromEntries(first.curated.map((f) => [f.friendlyName, f.fieldId]));
  expect(byName).toEqual(DEFAULT_CURATED_FIELD_IDS);

  const second = await provider.get(); // retried → detection succeeds now
  expect(second.curated.find((f) => f.friendlyName === "sprint")?.fieldId).toBe("customfield_10113");
  expect(stub.calls).toBe(2);
});

test("staticCuratedFieldsProvider returns a fixed set and never reads metadata", async () => {
  const stub = fieldStub([]);
  const resolved = resolveCuratedFields(null, {});
  const provider = staticCuratedFieldsProvider(resolved.curated);
  const got = await provider.get();
  expect(got.curated).toBe(resolved.curated);
  expect(stub.calls).toBe(0);
});
