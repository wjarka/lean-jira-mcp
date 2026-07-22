/**
 * Curated custom-field friendly-name mapping.
 *
 * JIRA exposes agile fields as opaque `customfield_XXXXX` ids that (a) vary per
 * instance and (b) are meaningless to the agent. v1 surfaces exactly three of
 * them by friendly name — story points, sprint, epic link — and never lets a
 * raw identifier reach the model. Everything else stays hidden unless the agent
 * names it via `fields[]`.
 *
 * The ids vary per instance, so they are DETECTED from the field catalog
 * ({@link detectCuratedFieldIds}) and resolved by precedence — explicit
 * `JIRA_FIELD_*` override → detected → cloud default only as a last resort
 * ({@link resolveCuratedFields}). The hardcoded {@link DEFAULT_CURATED_FIELD_IDS}
 * are that final fallback, not the primary source. Shared `lib/` primitive
 * reused by `jira_get_issue`; the live, memoized resolution lives in
 * `curated-field-provider.ts`.
 */

export type CuratedFieldKey = "storyPoints" | "sprint" | "epicLink";

/** Map of friendly name → the JIRA `customfield_XXXXX` id that backs it. */
export type CuratedFieldIds = Record<CuratedFieldKey, string>;

/**
 * Common Atlassian Cloud defaults. Instances differ; these are used ONLY as the
 * last-resort fallback when per-instance detection can't run at all (see
 * {@link resolveCuratedFields}). When detection runs, the detected ids win.
 */
export const DEFAULT_CURATED_FIELD_IDS: CuratedFieldIds = {
  storyPoints: "customfield_10016",
  sprint: "customfield_10020",
  epicLink: "customfield_10014",
};

/**
 * The `schema.custom` keys that identify the agile fields on ANY instance.
 * Sprint and Epic Link are JIRA Software (greenhopper) fields with stable schema
 * keys — matching these is robust where matching the volatile `customfield_XXXXX`
 * id is exactly the bug issue 13 fixes. Story Points has no single stable schema
 * key across company-/team-managed projects, so it is matched by name instead.
 */
export const CURATED_SCHEMA_CUSTOM: Readonly<Record<"sprint" | "epicLink", string>> = {
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
  epicLink: "com.pyxis.greenhopper.jira:gh-epic-link",
};

/**
 * Field names that identify Story Points: `Story Points` (company-managed) and
 * `Story point estimate` (team-managed). Compared case-insensitively, trimmed.
 */
export const STORY_POINTS_FIELD_NAMES: readonly string[] = ["Story Points", "Story point estimate"];

/**
 * The single source of truth for the `JIRA_FIELD_*` env var that overrides each
 * curated field's id. `config/env.ts` reads from these, and `jira_get_issue`'s
 * degradation note points the operator at them — both off this one map.
 */
export const CURATED_FIELD_ENV_VARS: Readonly<Record<CuratedFieldKey, string>> = {
  storyPoints: "JIRA_FIELD_STORY_POINTS",
  sprint: "JIRA_FIELD_SPRINT",
  epicLink: "JIRA_FIELD_EPIC_LINK",
};

const STORY_POINTS_NAMES_LOWER = new Set(STORY_POINTS_FIELD_NAMES.map((n) => n.toLowerCase()));

/** The minimal field-metadata shape detection needs (a subset of `JiraField`). */
export interface FieldMeta {
  id: string;
  name: string;
  /** `schema.custom`, when present. */
  schemaCustom?: string;
}

/**
 * Detect the curated field ids from an instance's field metadata. Sprint and
 * Epic Link are matched by `schema.custom`; Story Points by name. Only fields
 * positively identified are returned — an absent key means "this curated field
 * was not found on this instance", never "use a default" (the caller decides
 * precedence). The first match for each key wins.
 */
export function detectCuratedFieldIds(fields: FieldMeta[]): Partial<CuratedFieldIds> {
  const out: Partial<CuratedFieldIds> = {};
  for (const f of fields) {
    if (out.sprint === undefined && f.schemaCustom === CURATED_SCHEMA_CUSTOM.sprint) {
      out.sprint = f.id;
    }
    if (out.epicLink === undefined && f.schemaCustom === CURATED_SCHEMA_CUSTOM.epicLink) {
      out.epicLink = f.id;
    }
    // Story Points is always a custom field; the `customfield_` id guard avoids
    // binding a coincidentally same-named system field (whose values the numeric
    // normalizer would then silently drop).
    if (
      out.storyPoints === undefined &&
      f.id.startsWith("customfield_") &&
      STORY_POINTS_NAMES_LOWER.has(f.name.trim().toLowerCase())
    ) {
      out.storyPoints = f.id;
    }
  }
  return out;
}

/** Where a resolved curated id came from (for logging / visible degradation). */
export type CuratedFieldSource = "override" | "detected" | "default";

export interface ResolvedCuratedFields {
  /** Built defs for the fields that resolved to a concrete id (read these). */
  curated: CuratedFieldDef[];
  /** Curated fields skipped: no override, and detection ran but didn't find them. */
  omitted: CuratedFieldKey[];
  /** Provenance per resolved key. */
  sources: Partial<Record<CuratedFieldKey, CuratedFieldSource>>;
}

/**
 * Resolve the curated field ids by precedence, per field:
 *
 *   1. explicit `JIRA_FIELD_*` override (the operator knows best) — always wins;
 *   2. else the detected id;
 *   3. else, ONLY when detection couldn't run at all (`detected === null`), the
 *      hardcoded cloud default as a last resort.
 *
 * A field with no override that detection ran but did not find is OMITTED — it is
 * never read against a guessed id (that silent-wrong-id read is the bug this
 * fixes). `detected === null` signals total detection failure (e.g. the metadata
 * read threw): the defaults keep the feature working on default-id instances.
 */
export function resolveCuratedFields(
  detected: Partial<CuratedFieldIds> | null,
  overrides: Partial<CuratedFieldIds>,
): ResolvedCuratedFields {
  const keys = Object.keys(NORMALIZERS) as CuratedFieldKey[];
  const ids: Partial<CuratedFieldIds> = {};
  const sources: Partial<Record<CuratedFieldKey, CuratedFieldSource>> = {};
  const omitted: CuratedFieldKey[] = [];

  for (const key of keys) {
    if (overrides[key]) {
      ids[key] = overrides[key];
      sources[key] = "override";
    } else if (detected === null) {
      ids[key] = DEFAULT_CURATED_FIELD_IDS[key];
      sources[key] = "default";
    } else if (detected[key]) {
      ids[key] = detected[key];
      sources[key] = "detected";
    } else {
      omitted.push(key);
    }
  }

  const curated: CuratedFieldDef[] = keys
    .filter((key) => ids[key] !== undefined)
    .map((key) => ({ friendlyName: key, fieldId: ids[key]!, normalize: NORMALIZERS[key] }));

  return { curated, omitted, sources };
}

export interface CuratedFieldDef {
  /** Friendly name the agent sees as the output key. */
  friendlyName: CuratedFieldKey;
  /** The raw JIRA field id this resolves (never surfaced to the agent). */
  fieldId: string;
  /** Normalize the raw JIRA value to a clean, agent-readable value (or null). */
  normalize(raw: unknown): unknown;
}

const NORMALIZERS: Record<CuratedFieldKey, (raw: unknown) => unknown> = {
  storyPoints: (raw) => (typeof raw === "number" ? raw : null),
  sprint: normalizeSprint,
  epicLink: (raw) => (typeof raw === "string" && raw.length > 0 ? raw : null),
};

/** Build the curated field set from a (possibly overridden) id map. */
export function buildCuratedFields(ids: CuratedFieldIds): CuratedFieldDef[] {
  return (Object.keys(NORMALIZERS) as CuratedFieldKey[]).map((friendlyName) => ({
    friendlyName,
    fieldId: ids[friendlyName],
    normalize: NORMALIZERS[friendlyName],
  }));
}

/** The underlying `customfield_XXXXX` ids to request from JIRA. */
export function curatedRequestIds(curated: CuratedFieldDef[]): string[] {
  return curated.map((f) => f.fieldId);
}

/**
 * Extract the curated fields present in a raw `fields` object, keyed by
 * friendly name. Null / absent fields are omitted; raw ids never appear.
 */
export function extractCuratedFields(
  rawFields: Record<string, unknown>,
  curated: CuratedFieldDef[],
): Partial<Record<CuratedFieldKey, unknown>> {
  const out: Partial<Record<CuratedFieldKey, unknown>> = {};
  for (const field of curated) {
    const value = field.normalize(rawFields[field.fieldId]);
    if (value !== null && value !== undefined) {
      out[field.friendlyName] = value;
    }
  }
  return out;
}

const CURATED_NAMES_LOWER = new Set<string>(
  (Object.keys(NORMALIZERS) as CuratedFieldKey[]).map((k) => k.toLowerCase()),
);

/** True when `name` is one of the curated friendly names (case-insensitive). */
export function isCuratedFriendlyName(name: string): boolean {
  return CURATED_NAMES_LOWER.has(name.toLowerCase());
}

interface SprintLike {
  name?: unknown;
  state?: unknown;
}

/**
 * The sprint field is an array of sprint objects (a story can sit in several:
 * past closed sprints plus the current one). Prefer the active sprint; else the
 * most recent. Legacy string form (`...[name=Sprint 1,...]`) is parsed too.
 */
function normalizeSprint(raw: unknown): string | null {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const sprints = raw.filter((s): s is SprintLike => !!s && typeof s === "object");
    const active = sprints.find((s) => s.state === "active");
    const chosen = active ?? sprints[sprints.length - 1];
    return chosen ? sprintName(chosen) : legacySprintName(raw);
  }

  if (typeof raw === "object") return sprintName(raw as SprintLike);
  if (typeof raw === "string") return legacySprintName([raw]);
  return null;
}

function sprintName(sprint: SprintLike): string | null {
  if (typeof sprint.name === "string" && sprint.name.length > 0) return sprint.name;
  return null;
}

function legacySprintName(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = value.match(/name=([^,\]]+)/);
    if (match?.[1]) return match[1];
  }
  return null;
}
