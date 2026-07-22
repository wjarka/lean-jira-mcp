/**
 * Shared sprint-assignment hint shaping for `jira_create_issue` and
 * `jira_update_issue`.
 *
 * Sprint write rides the Agile move endpoint (issue 15), not the Sprint custom
 * field — so the two write tools share both the resolution-failure surface
 * (no scrum board / no active / no match / ambiguous, all surface-don't-guess)
 * and the non-atomic move-failure note. Keeping the wording here means the two
 * tools cannot drift; they differ only in the verb ("created" vs "changed").
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { shapeError } from "./response-shaper.ts";
import type { SprintCandidate, SprintInventory, SprintResolution } from "./reference-resolver.ts";

/** The tool's mutation verb, used in "Nothing was <verb>." tails. */
export type SprintNoun = "created" | "changed";

/** `'Sprint 3' (id 4009, board 'PROJ Scrum')` — the inline id the next call needs. */
function describeCandidate(s: SprintCandidate): string {
  return `'${s.name}' (id ${s.id}, board '${s.boardName}')`;
}

/** A sprint candidate shaped for a structured `options` payload. */
function toSprintOption(s: SprintCandidate): { id: number; name: string; state: string; board: string } {
  return { id: s.id, name: s.name, state: s.state, board: s.boardName };
}

/**
 * A recovery clause naming the project's open sprints (names + ids), appended to
 * a sprint MOVE failure so a numeric `sprint:<id>` that matched no sprint still
 * teaches the valid ids — restoring the universal recovery-hint invariant (a raw
 * failure reason alone left the agent with no way forward). Empty-board and
 * no-open-sprint cases say so explicitly rather than listing nothing.
 */
export function availableSprintsClause(inventory: SprintInventory): string {
  if (!inventory.hasSprintBoard) return " The project has no sprint-supporting board (Kanban-only).";
  if (inventory.candidates.length === 0) return " The project has no open sprints to assign to.";
  return (
    ` Available sprints: ${inventory.candidates.map(describeCandidate).join(", ")}.` +
    " Pass a valid sprint:<id>."
  );
}

/** The structured `options` for a move-failure error — the candidate sprints, or undefined when none. */
export function sprintCandidateOptions(
  inventory: SprintInventory,
): { id: number; name: string; state: string; board: string }[] | undefined {
  if (inventory.candidates.length === 0) return undefined;
  return inventory.candidates.map(toSprintOption);
}

/**
 * Shape a non-resolved {@link SprintResolution} into the recovery hint the agent
 * sees. Every variant teaches the fix inline (a Kanban-only project gets a clean
 * "no sprint-supporting board" message, never a raw 400 passthrough), and every
 * hint ends by stating nothing was written.
 */
export function sprintResolutionFailure(
  resolution: Exclude<SprintResolution, { kind: "resolved" }>,
  projectKey: string,
  noun: SprintNoun,
): CallToolResult {
  const tail = ` Nothing was ${noun}.`;

  switch (resolution.kind) {
    case "no_sprint_board":
      return shapeError(
        {
          message: `Project ${projectKey} has no sprint-supporting board.`,
          code: "sprint_no_board",
        },
        [
          `Project ${projectKey} has no sprint-supporting board (it is Kanban-only); cannot assign a sprint.` +
            tail,
        ],
      );

    case "no_active":
      return shapeError(
        { message: `No active sprint for project ${projectKey}.`, code: "sprint_none_active" },
        [
          `\`current\` was requested but ${projectKey} has no active sprint. Start a sprint, or ` +
            `pass a specific sprint id (see \`jira_describe_project\` → boards).` +
            tail,
        ],
      );

    case "no_match": {
      const available = resolution.available;
      const list =
        available.length > 0
          ? ` Open sprints: ${available.map(describeCandidate).join(", ")}. Pass sprint:<id>.`
          : ` ${projectKey} has no open sprints.`;
      return shapeError(
        {
          message: `No sprint named "${resolution.ref}" in ${projectKey}.`,
          code: "sprint_not_found",
          ...(available.length > 0 ? { options: available.map(toSprintOption) } : {}),
        },
        [`No open sprint named "${resolution.ref}" in ${projectKey}.${list}${tail}`],
      );
    }

    case "ambiguous":
      return shapeError(
        {
          message: `Sprint reference is ambiguous for ${projectKey}: ${resolution.candidates.length} matches.`,
          code: "sprint_ambiguous",
          options: resolution.candidates.map(toSprintOption),
        },
        [
          `${projectKey} has ${resolution.candidates.length} matching sprints: ` +
            resolution.candidates.map(describeCandidate).join(", ") +
            `. Pass sprint:<id>.` +
            tail,
        ],
      );
  }
}
