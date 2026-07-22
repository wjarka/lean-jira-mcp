/**
 * Reference resolver — turns the human-friendly references an agent passes into
 * the internal identifiers JIRA needs, so the agent never handles an accountId,
 * a sprint id, or the company- vs team-managed parent mechanism itself.
 *
 * Shared `lib/` primitive: `jira_create_issue` (this slice) uses all three;
 * `jira_update_issue` (05) reuses assignee/parent/sprint and `jira_transition`
 * (06) reuses assignee. Each resolver returns a discriminated result rather than
 * throwing, so the calling tool can shape a recovery hint (with candidate
 * options) when a reference is unresolvable or ambiguous — never guessing.
 */

import {
  JiraApiError,
  boardSupportsSprints,
  isTeamManaged,
  type IJiraClient,
  type JiraUser,
} from "./jira-client.ts";

// --- assignee ---------------------------------------------------------------

/** Aliases (case-insensitive) that mean "the token's own user". */
const CURRENT_USER_ALIASES = new Set(["me", "currentuser", "current user", "@me"]);

export type AssigneeResolution =
  | { kind: "resolved"; accountId: string }
  | { kind: "none"; query: string }
  | { kind: "ambiguous"; query: string; candidates: JiraUser[] };

/**
 * Resolve an assignee reference (email / display name / `me` / `currentUser`)
 * to an accountId. `me`/`currentUser` short-circuit to `/myself`; otherwise the
 * user search runs and, when it returns several, an exact email or display-name
 * match disambiguates before falling back to surfacing the candidates.
 */
export async function resolveAssignee(
  jira: IJiraClient,
  ref: string,
): Promise<AssigneeResolution> {
  const query = ref.trim();
  if (CURRENT_USER_ALIASES.has(query.toLowerCase())) {
    const me = await jira.getCurrentUser();
    return { kind: "resolved", accountId: me.accountId };
  }

  const users = await jira.searchUsers(query);
  if (users.length === 0) return { kind: "none", query };
  if (users.length === 1) return { kind: "resolved", accountId: users[0]!.accountId };

  const exactEmail = users.filter((u) => u.emailAddress?.toLowerCase() === query.toLowerCase());
  if (exactEmail.length === 1) return { kind: "resolved", accountId: exactEmail[0]!.accountId };

  const exactName = users.filter((u) => u.displayName.toLowerCase() === query.toLowerCase());
  if (exactName.length === 1) return { kind: "resolved", accountId: exactName[0]!.accountId };

  return { kind: "ambiguous", query, candidates: users };
}

/** `Display Name <email>` for a candidate list, or just the name when no email is known. */
export function describeUser(user: JiraUser): string {
  return user.emailAddress ? `${user.displayName} <${user.emailAddress}>` : user.displayName;
}

// --- parent -----------------------------------------------------------------

/** How a parent key is attached, resolved from the project's managed style. */
export interface ParentContribution {
  fieldId: string;
  value: unknown;
  mechanism: "parent" | "epic-link";
}

export type ParentResolution =
  | { kind: "resolved"; contribution: ParentContribution }
  | { kind: "not_found"; parentKey: string }
  /**
   * A company-managed project needs the Epic Link field id to attach a parent,
   * but it could not be detected for this instance and no override is set —
   * writing a guessed id would target the wrong field, so we refuse (issue 13's
   * read/write contract). Team-managed projects never hit this (they use `parent`).
   */
  | { kind: "epic_link_unavailable"; parentKey: string };

/**
 * Resolve the mechanism for attaching a `parent` by key, and validate the key
 * first. Team-managed (next-gen / simplified) projects express epic membership
 * and subtask parentage through the native `parent` field; company-managed
 * (classic) projects use the Epic Link custom field. The agent passes only the
 * key — this picks the right field by inspecting the project, so the same input
 * "just works" across both project styles.
 *
 * Crucially the parent is VALIDATED to exist before it is attached: the
 * team-managed `parent:{key}` path would otherwise accept a wrong/nonexistent
 * key silently. A missing key returns `not_found` (the caller surfaces a
 * recovery hint and creates nothing); auth/network errors bubble up to the
 * handler boundary unchanged.
 */
export async function resolveParent(
  jira: IJiraClient,
  projectKey: string,
  parentKey: string,
  epicLinkFieldId: string | undefined,
): Promise<ParentResolution> {
  try {
    await jira.getIssue({ issueKey: parentKey, fields: ["summary"] });
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) {
      return { kind: "not_found", parentKey };
    }
    throw err;
  }

  const project = await jira.getProject(projectKey);
  if (isTeamManaged(project)) {
    return {
      kind: "resolved",
      contribution: { fieldId: "parent", value: { key: parentKey }, mechanism: "parent" },
    };
  }
  // Company-managed: the parent rides the Epic Link field. Refuse to write a
  // guessed id when it could not be detected (issue 13/15 A2).
  if (!epicLinkFieldId) return { kind: "epic_link_unavailable", parentKey };
  return {
    kind: "resolved",
    contribution: { fieldId: epicLinkFieldId, value: parentKey, mechanism: "epic-link" },
  };
}

// --- sprint -----------------------------------------------------------------

/** A sprint surfaced in an ambiguity/availability hint. Carries the board for disambiguation. */
export interface SprintCandidate {
  id: number;
  name: string;
  state: string;
  boardName: string;
}

/** The project's open sprints, plus whether it has any sprint-supporting board. */
export interface SprintInventory {
  /** True when the project has at least one non-Kanban (sprint-supporting) board. */
  hasSprintBoard: boolean;
  /** Open (active+future) sprints across sprint-supporting boards, de-duplicated. */
  candidates: SprintCandidate[];
}

/**
 * Enumerate a project's open sprints across its sprint-supporting (non-Kanban)
 * boards, de-duplicated and carrying the board name for hints. The shared
 * gathering behind both {@link resolveSprint} (name/current matching) and the
 * write tools' move-failure recovery (listing valid ids when a numeric `sprint`
 * matched none) — so the candidate list the agent sees is identical on both
 * paths.
 */
export async function gatherSprintCandidates(
  jira: IJiraClient,
  projectKey: string,
): Promise<SprintInventory> {
  const boards = await jira.listProjectBoards(projectKey);
  const sprintBoards = boards.filter((b) => boardSupportsSprints(b.type));
  const candidates: SprintCandidate[] = [];
  const seen = new Set<number>();
  for (const board of sprintBoards) {
    for (const s of board.sprints) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      candidates.push({ id: s.id, name: s.name, state: s.state, boardName: board.name });
    }
  }
  return { hasSprintBoard: sprintBoards.length > 0, candidates };
}

/**
 * {@link gatherSprintCandidates}, but best-effort: returns `undefined` instead of
 * throwing when board discovery fails. The write tools use this on a sprint MOVE
 * failure to enrich the recovery hint — a discovery error there must fall back to
 * the bare failure reason, never mask the original error or fail the response.
 */
export async function safeGatherSprintCandidates(
  jira: IJiraClient,
  projectKey: string,
): Promise<SprintInventory | undefined> {
  try {
    return await gatherSprintCandidates(jira, projectKey);
  } catch {
    return undefined;
  }
}

export type SprintResolution =
  | { kind: "resolved"; sprintId: number }
  /** The project has no sprint-supporting board at all (Kanban-only). */
  | { kind: "no_sprint_board" }
  /** `current` was asked but no sprint is active on any sprint-supporting board. */
  | { kind: "no_active" }
  /** A name was asked but no open sprint matches; `available` lists what exists. */
  | { kind: "no_match"; ref: string; available: SprintCandidate[] }
  /** More than one sprint matches — surface the candidates, never guess. */
  | { kind: "ambiguous"; candidates: SprintCandidate[] };

/**
 * Resolve a sprint reference against the project's boards, filtering to
 * sprint-supporting boards FIRST — never resolving against a Kanban board (the
 * benchmark-failure fix; see {@link boardSupportsSprints}, which keeps scrum and
 * team-managed boards while excluding Kanban). Behaviors:
 *
 *   - **numeric id** (number or all-digit string) → taken at face value, no lookup;
 *   - **no sprint-supporting board** → `no_sprint_board` (a Kanban-only project can't take a sprint);
 *   - **`current`** → active sprints across those boards: 0 → `no_active`, 1 →
 *     resolved silently, >1 → `ambiguous` (candidates listed);
 *   - **by name** → matched (case-insensitive) across active+future sprints: 0 →
 *     `no_match` with the available names, 1 → resolved, >1 → `ambiguous`.
 *
 * The same surface-don't-guess discipline as transition/cross-project resolution:
 * an ambiguous reference returns candidate ids inline so the next call succeeds.
 */
export async function resolveSprint(
  jira: IJiraClient,
  ref: string | number,
  projectKey: string,
): Promise<SprintResolution> {
  if (typeof ref === "number") return { kind: "resolved", sprintId: ref };

  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return { kind: "resolved", sprintId: Number(trimmed) };

  const { hasSprintBoard, candidates } = await gatherSprintCandidates(jira, projectKey);
  if (!hasSprintBoard) return { kind: "no_sprint_board" };

  if (trimmed.toLowerCase() === "current") {
    const active = candidates.filter((s) => s.state === "active");
    if (active.length === 0) return { kind: "no_active" };
    if (active.length === 1) return { kind: "resolved", sprintId: active[0]!.id };
    return { kind: "ambiguous", candidates: active };
  }

  const matches = candidates.filter((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  if (matches.length === 0) return { kind: "no_match", ref: trimmed, available: candidates };
  if (matches.length === 1) return { kind: "resolved", sprintId: matches[0]!.id };
  return { kind: "ambiguous", candidates: matches };
}
