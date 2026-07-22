# ADR 0005 — `jira_transition`: name-first resolution, proactive screen fields, no pathfinding

Status: accepted
Date: 2026-06-26

## Context

`jira_transition` (issue 06) is the most behaviorally subtle tool in v1. JIRA's
own transition model leaks internals the agent should never touch (numeric
transition ids), and the "obvious" conveniences — pick a transition for the
agent, auto-fill screen fields, route multi-hop to a distant status — are all
traps that fire the wrong irreversible action or hide a decision the agent
should own. The PRD's split governs: **the system describes and executes; the
agent plans and chooses.** Three decisions pin that down.

## Decision

**1. A single `transition` field, resolved NAME-FIRST.** The agent passes one
string that is either a transition name or a target status. Resolution order:

1. **Exact transition-name match** (case/whitespace-insensitive) → that
   transition. This *must* win over status matching, because two transitions can
   share a target status while carrying different post-functions (e.g. "QA
   Failed" and "Put on Hold" both land in "To Do"). Naming the transition is how
   the agent selects the intended side-effects. JIRA also permits two transitions
   to share a *name*; if the name matches more than one we **refuse** (same rule
   as the ambiguous-status case below) rather than fire one at random.
2. Else **target-status match** over the transitions firable from the current
   status:
   - exactly one → fire it;
   - **more than one → REFUSE**, returning the named transitions as options. We
     do *not* "pick the first" — a status reachable by several transitions is
     genuinely ambiguous, and guessing would silently fire the wrong action.
     The hint names the options ("'To Do' is reachable via 'QA Failed' or 'Put
     on Hold' — pass the transition name").
3. Asking for the status the issue is **already in** is a graceful no-op
   (`moved:false`), never an error.

Numeric ids never surface: the handler resolves a name/status to the id and
passes only that to the seam's `doTransition`.

**2. Screen fields are validated PROACTIVELY off free metadata.** The one
`GET .../transitions?expand=transitions.fields` read that resolves the name also
returns each transition's screen fields with their `required` flags — at no extra
cost. So when a transition requires a field the agent omitted (the classic case:
a resolution on "Done"), we return the precise required-field list as a hint
**without attempting the transition**. We deliberately do *not* fire-and-report
the failure: a failed transition can have observable side-effects, and the whole
point of having the metadata in hand is to fail before the attempt, not after.
Fields are accepted keyed by friendly name or id and mapped to the field id for
the execute payload (reusing the shared `IssueFieldsBuilder`).

**3. NO server-side pathfinding.** When no transition reaches the target in one
hop, the server returns the current status's available next steps plus a pointer
to `jira_describe_project` (scoped to the issue's project key) — and computes no
route. The agent walks multi-hop itself, one deliberate transition at a time.

This is a deliberate refusal, not a missing feature. Each hop in a JIRA workflow
can fire irreversible side-effects — notifications, automation rules, SLA clocks
— so a server that "helpfully" auto-walked a shortest path would commit the agent
to side-effects it never saw. Routing is a *planning* decision; planning belongs
to the agent (which is why the workflow map lives in `describe_project`).
Gated multi-hop auto-walk is explicitly out of scope for v1 (see the PRD).

The **in-tool complement** to refusing to route: after a *successful* transition,
one fresh `getTransitions` reads the next legal steps from the NEW status and
appends them to the hints, so a manual multi-step move takes its next hop without
a separate lookup. This surfaces next steps (it does not plan a route) and is
computed from a live `getTransitions` — not `describe_project`'s static graph —
so it respects this issue's per-issue conditions and permissions. A status with
no outgoing transitions is reported terminal ("no further transitions available").
The follow-up read is **best-effort**: if it fails the transition still succeeded,
so the hint is omitted rather than turning a completed move into a tool failure.
Only the success path re-reads (its status changed, so the up-front list is now
stale); every non-success outcome (no-op, refusal, no-direct-edge, reactive
rejection) reuses the up-front `getTransitions` result — no double-fetch. All of
these "available from `<status>`" clauses render through one
`availableTransitionsHint(status, transitions)` helper so their wording cannot
drift; outcomes differ only by a thin prefix.

The "no direct edge" and "invalid/unknown target" cases collapse into one branch:
from the available-transitions read alone we cannot distinguish a real-but-distant
status from a typo, and both recover the same way — show the current status's
options and point at the workflow map. A 4xx JIRA *still* returns at execute time
(a field we couldn't pre-validate) comes back with the same available-transitions
hint, reactively.

## Why a separate current-status read

`GET .../transitions` lists only what is firable *from* the current status and
does **not** report the current status itself. The no-op check ("already in that
status") and the "from <status> you can go to…" hints both need the current
status name, so the handler reads it with a lean `getIssue({fields:["status"]})`
alongside the transitions read. The "free metadata" point in the PRD is about not
making a *separate screen-field* call — `expand=transitions.fields` folds that
into the transitions read — not about avoiding the status read.

## Verification

Driven end-to-end against the faked `JiraClient` in `test/transition.test.ts`:
status- and name-based moves; the >1-transition refusal (asserting it lists the
named options and fires nothing); exact-name resolution preserving the right id
when a status is shared; the current-status no-op; the proactive
required-field hint with no `doTransition` call, then completion when the field
is supplied (asserting it is sent keyed by field id); invalid-target and
no-direct-edge (asserting the `describe_project` pointer and that no path is
computed); case/whitespace insensitivity; and the reactive 400 hint. The seam's
endpoint URLs, request bodies, and field-map normalization are pinned in
`test/jira-client.test.ts`.

Live JIRA Cloud verification of the transition endpoints (an actual fire against
a real instance) is deferred to the same end-to-end pass that validates the other
write tools; the shapes used here match JIRA Cloud REST v3
(`GET/POST /rest/api/3/issue/{key}/transitions`).

## Consequences

- Two new seam methods (`getTransitions`, `doTransition`) and the
  `JiraAvailableTransition` / `JiraTransitionField` normalized shapes; numeric
  ids stay inside the client.
- `jira_transition` needs no per-instance config (the project key for the
  `describe_project` pointer is derived from the issue key), so it registers with
  just the client.
- Comment-on-transition and gated multi-hop auto-walk remain out of scope (PRD).
