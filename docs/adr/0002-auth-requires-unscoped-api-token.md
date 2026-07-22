# ADR 0002 — Auth requires a classic unscoped API token; verify with a /myself preflight

Status: accepted
Date: 2026-06-25

## Context

Auth is HTTP basic (`email:API-token`) per the foundation decisions. During the
first live smoke test, `jira_search` returned zero issues for a project that has
issues. Investigation against the live site showed:

- `GET /rest/api/3/myself` → `401`, `x-seraph-loginreason: AUTHENTICATED_FAILED`
- `POST /rest/api/3/search/jql {"jql":"project = PROJ"}` → `200 {"issues":[],"isLast":true}`
- `GET /rest/api/3/project/PROJ` → `404`; `/project/search` → `total: 0`

The token in use was a **scoped** Atlassian API token (scopes:
`read:jira-user`, `read:jira-work`, `read:me`, `write:jira-work`). Replacing it
with a **classic, unscoped** API token fixed everything immediately.

Root cause: scoped API tokens are intended for OAuth-style flows and are **not
accepted by HTTP basic auth** on the REST API. JIRA Cloud does not return an
error for this — it serves the request **anonymously**, so data endpoints return
`200` with empty results and only identity endpoints (`/myself`) fail with `401`.
The failure mode therefore masquerades as "no results."

## Decision

1. **Require a classic, unscoped API token.** Documented in `README.md` and
   `.env.example`. Scoped tokens are explicitly unsupported for basic auth.

2. **Preflight `/rest/api/3/myself` in `JiraClient`**, once per process,
   memoized on success (creds come from env and don't change). It runs lazily on
   the first real request, so the cost is one round-trip on the first tool call
   and zero thereafter. On failure nothing is cached, so a transient blip
   doesn't permanently brick the client.

3. **Surface auth failure as a recoverable tool error.** `JiraApiError.isAuthError`
   (401/403) is shaped by the tool into an `authentication_failed` response whose
   `hints` tell the operator to use a classic unscoped token. Every tool (issues
   02–10) inherits this because it lives at the `JiraClient` seam.

## Why a preflight rather than detecting it on the search call

Because bad basic-auth creds yield `200`-empty on data endpoints, there is no
reliable per-call signal on `search/jql` itself — "empty" is ambiguous with a
legitimately empty result or a permission-scoped one. `/myself` requires a real
identity, so it is the one call that distinguishes "unauthenticated" from
"authenticated but nothing matched."

## Consequences

- One extra `/myself` request on the first tool call per process.
- A valid token with no access to a given project still returns a legitimate
  empty result (preflight passes) — we do not misreport that as an auth error.
- Tested in `test/jira-client.test.ts` (preflight fails → auth error, data
  endpoint never hit; success memoized across calls) and `test/search.test.ts`
  (handler shapes `authentication_failed` with the recovery hint).
