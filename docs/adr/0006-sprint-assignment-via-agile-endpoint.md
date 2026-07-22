# ADR 0006 — Sprint assignment via the Agile move endpoint; scrum-board-filtered resolution; epic-link write through the detected id

Status: accepted
Date: 2026-06-27

## Context

Benchmarking surfaced a real parity gap: assigning an issue to a sprint failed.
The server resolved the sprint against the project's *default* board — a Kanban
board — and JIRA returned `400 "the board does not support sprints"`, passed
through raw. There was also no board/sprint discovery, so an agent had no way to
learn a sprint id. Sprints are central to the grooming/impl/QA workflows, so the
mentor ruling pulled sprint **assignment + discovery + current/by-name
resolution** into v1.x — but with **no new tools and no new resource** (only
agile *admin* stays deferred). Discovery rides `describe_project`; assignment
rides `create`/`update`.

Two adjacent correctness issues were folded in: the sprint WRITE mechanism, and
the epic-link write that issue 13 left split between read and write.

## Decision

**1. Sprint write is the Agile MOVE endpoint, never a custom-field write.**
Assign is `POST /rest/agile/1.0/sprint/{id}/issue`; clear (`update sprint:null`)
is `POST /rest/agile/1.0/backlog/issue`. These are screen-independent — they need
no Sprint custom-field id and work regardless of the field's screen
configuration, which is the whole point. Sprint is therefore no longer a field on
the create/update payload at all; the builder never carries it. The agent-facing
`sprint:` input is unchanged — the mechanism change is invisible to it.

**2. Resolution filters to sprint-supporting boards FIRST.** This is the literal
benchmark fix. `listProjectBoards` returns every board with its open
(active+future) sprints, but fetches sprints **only for sprint-supporting
boards** — `boardSupportsSprints(type)`, i.e. anything that is *not* Kanban. The
filter is deliberately "not Kanban" rather than "scrum only": team-managed
(next-gen) software boards report `type: "simple"` yet carry sprints, so an
allowlist of `scrum` alone would silently break sprint resolution for every
team-managed project (the same project class the parent-resolution and
`describe_project` paths already take care to support). A Kanban board's
`/sprint` endpoint 400s, so it is never queried and always carries empty
`sprints`; and the per-board sprint read is wrapped so a board that unexpectedly
rejects it degrades to empty rather than re-surfacing the raw 400. `resolveSprint`
filters to sprint-supporting boards before doing anything else:

- **no sprint-supporting board** → `no_sprint_board`, shaped as a clean
  `"Project X has no sprint-supporting board (it is Kanban-only); cannot assign a
  sprint."` — never a raw 400 passthrough;
- **`current`** → active sprints across those boards: 0 → hint, **1 → resolve
  silently** (the common case, no friction), >1 → surface candidates + ids;
- **by name** → matched (case-insensitive) across active+future: 0 → hint listing
  the available sprints, 1 → resolve, >1 (same name on two boards) → surface
  candidates + ids;
- **numeric id** → used directly, no board lookup on the happy path. If the move
  then fails because the id matched no sprint, the failure hint lists the
  project's open sprints (names + ids) — gathered via the same
  `gatherSprintCandidates` resolution uses — so the recovery-hint invariant holds
  even on the lookup-free path (and a rare numeric-*named* sprint becomes
  reachable in two hops, without paying a name match on every numeric input).

This is the same surface-don't-guess discipline as the >1-transition refusal and
cross-project resolution (ADR 0005): the ambiguity hint teaches the ids inline so
the next call succeeds, and the server never picks one.

**3. create-then-move is non-atomic, and says so.** A `create_issue` with
`sprint:` is two operations — create, then move. The sprint reference is resolved
*before* the create (fail fast: an ambiguous/unknown sprint creates nothing), but
the move runs after. A move failure does NOT roll back the create; the response
reports the truth: `"Created PROJ-5; sprint assignment failed (<reason>) — the
issue is in the backlog."` `update_issue` mirrors this: when a field update
succeeds but the sprint move fails, it returns a **partial success** naming what
changed and that the sprint did not; a sprint-only move that fails is a plain
error.

**4. Discovery rides `describe_project` tier-1.** The identity tier
(`describe_project(projectKey)`) gains `boards: [{id, name, type, sprints:[{id,
name, state}]}]` with active+future sprints (closed excluded — they are never
assignment targets). This is additive to issue 12's tier-1 identity/issueTypes,
not a competing shape. The boards read is **best-effort**: a project without JIRA
Software (or no agile access) returns `boards:[]` rather than failing the
identity echo the tier exists for.

**5. Epic-link write goes through the DETECTED id (closes issue 13's split).**
Issue 13 wired the *read* path to per-instance detected curated ids but left
`create`/`update` writing epic link against the static cloud default. On a
non-default instance, reads and writes then disagreed. The company-managed parent
write now routes through the same curated-field provider the read path uses
(`resolveEpicLinkFieldId`). When the epic-link id can't be detected and no
`JIRA_FIELD_EPIC_LINK` override is set, the write **degrades visibly** —
`epic_link_unavailable`, refusing to write a guessed id — per issue 13's
contract. Sprint sidesteps this entirely (the Agile endpoint needs no field id),
so this item is specifically epic link. Team-managed projects never hit it (they
use the native `parent` field).

## Consequences

- Three new seam methods (`listProjectBoards`, `addIssueToSprint`,
  `moveIssueToBacklog`) replace `findActiveSprints`, which resolved against all
  boards (the bug). New normalized shapes: `JiraProjectBoard` / `JiraBoardSprint`.
- `resolveSprint`'s result type gains `no_scrum_board` / `no_active` / `no_match`
  / `ambiguous` variants (with `SprintCandidate`s carrying the board name for
  disambiguation); the two write tools share one `sprintResolutionFailure` hint
  shaper so their wording can't drift.
- `create`/`update` deps drop `sprintFieldId` and `epicLinkFieldId`; the
  curated-field provider is injected instead (defaulting to the cloud-default
  ids, matching `get_issue`). `env.curatedFieldIds` (the old merged write-path
  map) is removed — both writes now resolve their ids elsewhere.
- `update_issue`'s `sprint` becomes nullable (`null` → backlog); `create_issue`'s
  rejects `null` with a teaching hint rather than a raw zod error.

## Verification

Driven end-to-end against the faked `JiraClient`, whose board fixture pairs a
Kanban board with a Scrum board so the board filter is actually exercised: the
Agile-endpoint mechanism (assign + backlog, not a field write); create-then-move
non-atomicity (and update's partial-success report); `current` 0/1/>1 and by-name
0/1/>1 resolution; the Kanban-only "no sprint-supporting board" path; a
team-managed (`simple`) board's sprints being kept; numeric-id passthrough;
`boards[]` in `describe_project` tier-1 incl. the best-effort degrade that
distinguishes "couldn't read boards" from "Kanban-only"; and the epic-link write
targeting the detected id with a visible degrade when undetectable. Live JIRA
Cloud verification of the agile endpoints is deferred to the same end-to-end pass
that validates the other write tools; the shapes match JIRA Cloud Agile REST 1.0.
