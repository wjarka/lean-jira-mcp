# ADR 0004 — `describe_project`: uniform workflow map over company/team-managed

Status: accepted
Date: 2026-06-26

## Context

`jira_describe_project` (issue 03) must hand the agent a workflow map it can plan
transitions over, with a **uniform shape across company-managed and team-managed
projects**. The company/team divergence is exactly where issue 04's parent
resolution bug hid, so the uniformity has to be a deliberate, tested guarantee,
not an accident of one project type happening to look like the other.

Two sub-problems:

1. **What signal decides `projectType`,** and where does it live?
2. **Where does the named transition graph come from,** given JIRA Cloud exposes
   no single clean "give me this issue type's workflow graph by name" endpoint
   that is reliable across both project styles?

## Decision

**1. `projectType` is derived from `style`/`simplified`, in one place.**
`team` iff `style === "next-gen" || simplified === true`, else `company`. This is
the *same* signal `reference-resolver` keys parent resolution off of (Epic Link
field vs native `parent`). Keeping the derivation identical means the two tools
can never disagree about a project's type.

**2. The workflow is normalized at the `JiraClient` seam, expanded to edges in
the handler.** `getProjectWorkflow(projectKey, issueType)` returns a normalized
`{ statuses: string[], transitions: JiraWorkflowTransition[] }` where every
status reference and numeric transition id is already resolved to a **name**.
The handler expands each transition into agent-facing `{name, from, to}` edges:

- a global transition → a single `{name, from:"*", to}` edge;
- a directed transition reachable from N statuses → N edges, one per source.

So both project types flow through the identical handler path; the divergence (if
any) is absorbed at the seam. Numeric transition ids never leave the client, and
createmeta / required-field data is deliberately **not** folded in — that stays
lazy in `create_issue`.

**3. The transition read is best-effort; statuses are not.** `getProjectWorkflow`
composes two sources:

- **statuses** from `GET /rest/api/3/project/{key}/statuses` (the per-issue-type
  status list — reliable and uniform across both styles); and
- **transitions** from the workflow **preview** read
  (`POST /rest/api/3/workflows/preview`, body `{projectId, issueTypeIds:[id]}`),
  mapping `type:"GLOBAL"` → global edges, `type:"DIRECTED"` → directed edges via
  each transition's `links[].fromStatusReference`, and dropping `type:"INITIAL"`
  (the create pseudo-transition, not an edge an agent fires).

**Endpoint choice: `/workflows/preview`, not `/workflows`.** The bulk read
(`POST /rest/api/3/workflows`) is **admin-gated** — a normal project-scoped token
gets `403 "No permission to view workflow"`. The *preview* endpoint takes the
same lookup (`projectId` required for the permission check, `issueTypeIds` to
select the type's workflow) and returns the **identical** `{statuses, workflows}`
shape, but works with an ordinary user token. This was found by testing both live
(see Verification), and is why the tool can return real transition graphs rather
than degrading for every non-admin caller.

If the transition read fails or the workflow can't be located, statuses are still
returned with an empty `transitions` and the handler emits a degradation hint —
a usable partial map beats a hard failure for a planning tool.

**The transition read degrades on _any_ failure, including 403.** A workflow can
still be unreadable for other reasons (a restricted workflow, a transient blip).
That must not be reported as an auth/credential failure: the
`/project/{key}/statuses` GET immediately before it succeeded with the same token,
which proves the session is authenticated, so a failure on the workflow read is by
construction never a credential problem. The catch therefore swallows everything
(logging it) and returns statuses-only, rather than re-throwing auth errors.
(Genuine credential failures are caught upstream by the `/myself` preflight and
would already have failed tier 1.)

## Verification

The handler + edge-expansion + `projectType` derivation are driven end-to-end
against the faked `JiraClient` in `test/describe-project.test.ts`, exercising
**both** a company-managed and a team-managed project and asserting an identical
response shape for each (the issue's central guarantee).

**Live behavior verified** against a real instance (`PROJ` / `Task`) with a normal
(non-admin) user token:

- `POST /rest/api/3/workflows` → `403 "No permission to view workflow"` (admin-gated).
- `POST /rest/api/3/workflows/preview` with `{projectId, issueTypeIds:[id]}` →
  `200`, returning `{statuses, workflows}` where transitions carry
  `type`/`toStatusReference`/`links[].fromStatusReference` exactly as the mapping
  expects. End-to-end, `getProjectWorkflow("PROJ","Task")` returns 12 statuses and
  23 edges (24 raw transitions minus the dropped INITIAL), with GLOBAL rendered as
  `from:"*"`.

The endpoint URL + request body and the INITIAL/GLOBAL/DIRECTED mapping are pinned
by client unit tests (`test/jira-client.test.ts`); the statuses-only degradation
on a 403 is tested there too. If JIRA ever changes the preview response shape,
adjust `fetchWorkflowTransitions` only — the normalized seam shape and the handler
stay unchanged.

## Consequences

- `JiraProject` gained an optional `issueTypes` field, populated by `getProject`
  (the project endpoint returns them inline); tier 1 lists them and tier 2
  validates the requested type against them before spending a workflow fetch.
- A new seam method (`getProjectWorkflow`) every future workflow-aware tool can
  reuse — `jira_transition` (slice 06) points agents here when no direct edge
  exists between two statuses.
