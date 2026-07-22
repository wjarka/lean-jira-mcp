# ADR 0010 — Workflow gates, rule fidelity, and the reconciled transition miss

Status: accepted
Date: 2026-06-30

Amends ADR 0004 (`describe_project` workflow sourcing) and ADR 0005
(`jira_transition` resolution). Implements issue 19.

## Context

`jira_describe_project` advertised a transition edge — `In Review → Prod
Awaiting` on PROJ-104 — that `jira_transition` then refused at runtime with
`no_direct_transition`. The map contradicted reality, and nothing reconciled the
two. The original hypothesis (a name-vs-status resolution bug in `jira_transition`)
was **wrong**: `jira_transition` behaved correctly. The two tools simply read
**different sources**, and neither said so:

- `describe_project` reads the **design-time workflow DEFINITION** (the workflow
  PREVIEW endpoint) — every transition the workflow defines, regardless of
  conditions.
- `jira_transition` reads the **runtime AVAILABLE set** (`GET .../transitions`) —
  only transitions whose conditions currently pass for that issue + user.

`Release Pending` is in the definition but **condition-gated** (a
`system:restrict-issue-transition` condition), so it appears on the static map yet
isn't firable. The defect: the map carried no gating truth, and the failure didn't
reconcile against the definition.

## Three layers of truth

Workflow reality has three layers; each is knowable at a different place, and **a
lower layer must never impersonate a higher one**:

1. **Topology** — "this edge is defined." Preview endpoint, always readable.
2. **Gates** — "this edge requires [conditions/validators]; shows [screen]." Also
   the preview endpoint (see the empirical finding below).
3. **Runtime verdict** — "firable now for this issue + user." `getTransitions`,
   per-issue. It gives only the *available set* — **never why** a hidden edge is
   hidden.

**The hard ceiling, never crossed:** we never evaluate conditions ourselves.
Reimplementing Jira's condition engine (dozens of system types + custom/plugin
rules, none of whose parameters we even receive) is a tarpit. `getTransitions` is
the **sole firability authority**. We surface **what gates** an edge, never assert
**which gate** is unmet.

## Empirical finding that shaped the design (section A)

The whole design branched on what the endpoints actually return, so we probed the
live instance with a **normal (non-admin) project-scoped token** before building
(recorded in `.scratch/jira-mcp-v1/issues/19-empirical-findings.md` — local
scratch notes, not shipped in the repo):

- `POST /rest/api/3/workflows/preview` — the endpoint `describe_project` already
  uses for topology — **also returns each transition's `conditions`,
  `validators`, `actions`, `triggers`, and `transitionScreen` for a normal
  token.** The rule data is **not admin-gated**: full fidelity is free.
- Rules carry only a **`ruleKey` (the gate TYPE) + an opaque `id`** — **no
  parameters** (no role, field, or value). So a phrase can name the gate's *type*
  ("restricted to specific users/roles"), never the specific binding.
- `conditions` is a possibly-nested `{operation, conditions[], conditionGroups[]}`
  tree; `validators` is a flat array; `transitionScreen` is present only when a
  screen is shown (and carries **no screen name**).
- The bulk `POST /rest/api/3/workflows` needs an explicit ID/name/project body
  (400 otherwise); `/workflows/search` is GET-only. Neither is needed.

**Consequence for the fidelity model.** Because the rich rule data rides the
always-available preview call, the model collapses to **two levels** (the issue's
"if not, it's just full vs topology"). There is **no presence-without-detail
middle level** (`gated:true` with unknown type): gate presence always arrives
*with* its type. And there is **no separate admin-gated rich endpoint** to probe,
fall back from, or cache — capability detection is degenerate. `ruleFidelity` is
therefore set from **what was parsed**, never from "is this token admin":

- `"full"` — the preview workflow read succeeded; `requires`/`hasScreen` are
  authoritative, so a missing `requires` means **ungated**.
- `"topology"` — the workflow definition could not be read at all (the existing
  statuses-only degradation); a missing `requires` means **unknown**, not none.

## Decision

**1. The `JiraClient` seam parses gates off the preview read.** `getProjectWorkflow`
returns `JiraProjectWorkflow.ruleFidelity` (`"full"` once a preview read parses,
`"topology"` on the degrade path) and each `JiraWorkflowTransition` carries
`requires` (terse phrases) + `hasScreen`. `fetchWorkflowTransitions` walks the
nested `conditions` tree and the `validators` array, mapping ruleKeys to phrases
via the pure `lib/workflow-rules.ts` module; `actions` (post-functions) and
`triggers` (side-effects, not gates) are dropped, as is the screen *name* (not
returned). Per ADR 0004's seam principle, if JIRA changes the shape, only
`fetchWorkflowTransitions` + `workflow-rules` change.

**2. `lib/workflow-rules.ts` is the recognized-types map, and it degrades
visibly.** A small map of recognized `system:*` condition/validator ruleKeys →
terse phrase. An **unrecognized/custom/plugin** key is **never dropped** — it
becomes a visible `unrecognized condition|validator (<key>)` marker, because
dropping it would silently re-promise firability (the edge would read as ungated).

**3. `describe_project` surfaces gates per edge + `ruleFidelity`.** Each edge gets
`requires` (omitted when ungated — the clean common case) and `hasScreen` (only
when true). The tier-2 payload carries top-level `ruleFidelity`, and a hint states
what a missing `requires` means in the current mode (ungated under `full`,
**unknown** under `topology`). No raw rule config; no post-functions.

The PRD and issue spec named this field `needsScreen`; we ship it as **`hasScreen`**
deliberately. Preview only tells us a transition SCREEN is *configured* — not that
firing the edge *needs* input. A screen can carry only optional fields, so a
`needsScreen:true` edge could fire with an empty payload, which is an overclaim of
exactly the kind this issue exists to avoid. The authoritative "you must supply X"
signal is `jira_transition`'s per-issue `required`-field check (data preview never
carries). `hasScreen` states what we actually know; `jira_transition` owns whether
input is required.

**4. `jira_transition` reconciles an on-miss against the definition.** When no
transition reaches the target in one hop, the handler makes **one extra,
failure-only** `getProjectWorkflow` read and cross-references the edges defined
*from the current status*. Outcomes, distinguished:

- **defined + gated (full):** "The workflow **defines** `A → B` via `T`. It
  **requires** [phrases] and **isn't currently available** — one or more of those
  gates or a permission isn't met for this issue/you (we don't evaluate which).
  Firable now: …"
- **defined + rules unreadable (topology):** "The workflow **defines** `A → B` via
  `T`, but it **isn't currently available** and its gating rules **aren't
  readable** at this permission level… Firable now: …"
- **genuinely undefined:** "No transition to `X` is **defined** from `A`." +
  the `describe_project` pointer (the prior behavior).
- **workflow read failed:** fall back to the exact pre-issue-19 recovery (no
  regression).

The **verb discipline** is load-bearing: allowed verbs are *defines* (topology),
*requires* (rule definition), *not available* (`getTransitions`). The forbidden
form is "X failed **because** Z" — `getTransitions` never told us why, and we never
evaluate conditions. The block is always attributed to "one or more of these (we
don't evaluate which)."

**5. Guard — unchanged behaviors.** `jira_transition`'s name-first resolution and
its `>1`-transition refusal are untouched (they were correct; the original
hypothesis was wrong). No per-issue firability is ever computed from the rules.

## Verification

- **Empirical (live, normal token):** recorded in the findings file; `Prod
  Awaiting` confirmed to carry the `restrict-issue-transition` condition, the
  staging route (`Staging Check`) confirmed ungated.
- **Seam (`test/jira-client.test.ts`):** preview gate parsing → `requires` +
  `hasScreen`; nested `conditionGroups` collected (custom gate degrades
  visibly); `ruleFidelity` `"full"` on success and `"topology"` on the degrade.
- **`workflow-rules` (`test/workflow-rules.test.ts`):** recognized → phrase;
  unrecognized → visible marker; dedupe; ungated → `[]`.
- **`describe_project` (`test/describe-project.test.ts`):** full-fidelity gated
  vs ungated edges; `hasScreen`; `ruleFidelity` present; topology-with-edges
  note states a missing `requires` is *unknown*.
- **`jira_transition` (`test/transition.test.ts`):** the PROJ-104 reproduction
  against the faked client (full and topology), the verb-discipline assertion (no
  "failed because"; "don't evaluate which" present), genuinely-undefined, and the
  best-effort fallback — all with no live network.
- **Live end-to-end:** `describe_project(PROJ, Story)` returns `ruleFidelity:
  "full"` with the gated `In Review → Release Pending` and ungated `Staging Check`
  edges, matching the empirical probe.

## Consequences

- `JiraProjectWorkflow` gains a required `ruleFidelity`; `JiraWorkflowTransition`
  gains optional `requires`/`hasScreen`. Fakes and fixtures set them.
- A new pure module (`lib/workflow-rules.ts`) every workflow-aware path reuses.
- `jira_transition` reads `issuetype` (free, on the existing issue read) so the
  on-miss reconciliation can locate the right workflow — one extra workflow read,
  failure-only.
- The recognized-types map is intentionally small; broadening it is additive and
  safe (unknown keys already degrade visibly).
