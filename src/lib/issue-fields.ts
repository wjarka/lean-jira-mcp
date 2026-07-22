/**
 * Shared accessors for the standard JIRA issue "card" fields.
 *
 * Both `jira_search` (compact cards) and `jira_get_issue` (summary + full)
 * present the same seven-field card — key/summary/status/type/priority/
 * assignee/labels/updated — so the field-shape logic lives here once. The raw
 * JIRA shapes are nested (`status.name`, `assignee.displayName`); these
 * accessors flatten them and never surface accountIds or other internals.
 */

/** Card fields always requested from JIRA. Rank is deliberately never requested. */
export const CARD_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "labels",
  "updated",
] as const;

export interface CardFields {
  summary: string | null;
  status: string | null;
  type: string | null;
  priority: string | null;
  assignee: string | null;
  labels: string[];
  updated: string | null;
}

export function nameOf(value: unknown): string | null {
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

export function displayNameOf(value: unknown): string | null {
  if (value && typeof value === "object" && "displayName" in value) {
    const displayName = (value as { displayName: unknown }).displayName;
    return typeof displayName === "string" ? displayName : null;
  }
  return null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Derive the project key from an issue key (`PROJ-123` → `PROJ`). JIRA project
 * keys never contain a hyphen, so everything before the final hyphen is the
 * project key; a key with no hyphen is returned unchanged.
 */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf("-");
  return dash > 0 ? issueKey.slice(0, dash) : issueKey;
}

/**
 * Names a card already presents — raw JIRA names plus the agent-facing aliases
 * (`type` for `issuetype`, `key` itself). A `fields[]` extra naming one of these
 * is ALREADY in the response, so it must not be re-emitted as a duplicate
 * `extraFields` block. Compared case-insensitively via {@link isCardField}.
 */
export const CARD_FIELD_NAMES: ReadonlySet<string> = new Set([
  "key",
  "summary",
  "status",
  "issuetype",
  "type",
  "priority",
  "assignee",
  "labels",
  "updated",
]);

/** True when `name` is a field the card already presents (case-insensitive). */
export function isCardField(name: string): boolean {
  return CARD_FIELD_NAMES.has(name.toLowerCase());
}

/** Pure JIRA REST plumbing — never meaningful to an agent, always stripped. */
const FIELD_NOISE_KEYS: ReadonlySet<string> = new Set([
  "self",
  "iconurl",
  "avatarurls",
  "statuscategory",
]);

/**
 * Flatten an arbitrary raw JIRA field value to its lean, meaningful form, with
 * the same discipline as the card accessors above: a status/priority/option
 * collapses to its display string (`name`/`value`), a user to its `displayName`,
 * an array maps element-wise, and REST plumbing (`self`, `iconUrl`, `avatarUrls`,
 * `statusCategory`, and the nested `self` URLs under them) is stripped.
 * Primitives pass through unchanged. Used to flatten `fields[]` extras so they
 * never reach the agent as fat raw objects.
 */
export function leanFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(leanFieldValue);
  if (typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  // Recognized single-value shapes collapse to their meaningful scalar.
  if (typeof obj.displayName === "string") return obj.displayName;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.value === "string") return obj.value;

  // Unrecognized object: keep its data but strip plumbing, recursing in.
  const cleaned: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (FIELD_NOISE_KEYS.has(key.toLowerCase())) continue;
    cleaned[key] = leanFieldValue(v);
  }
  return cleaned;
}

/** Flatten a raw `fields` object into the standard card shape. */
export function toCardFields(fields: Record<string, unknown>): CardFields {
  return {
    summary: stringOrNull(fields.summary),
    status: nameOf(fields.status),
    type: nameOf(fields.issuetype),
    priority: nameOf(fields.priority),
    assignee: fields.assignee == null ? null : displayNameOf(fields.assignee),
    labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
    updated: stringOrNull(fields.updated),
  };
}
