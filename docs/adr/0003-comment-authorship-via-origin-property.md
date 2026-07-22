# ADR 0003 — Comment authorship: `mcp.origin` property confirmed as the machine truth

Status: accepted
Date: 2026-06-25

## Context

`jira_comment` (issue 07) must let an agent tell its own comments from a human's
without hand-parsing ADF. The PRD's authorship architecture proposes two signals
stamped on every comment the server writes, with no opt-out:

1. an out-of-band comment **property** (`mcp.origin`) — the machine truth,
   invisible in the JIRA UI; and
2. a **visible marker** in the body (`JIRA_MCP_COMMENT_MARKER`, default
   `:claude:`) for humans.

The property is only viable if JIRA Cloud actually **persists and round-trips**
it: set via the comment-write `properties` field, read back via
`expand=properties`. The PRD explicitly required this be **verified live during
this slice** — the fake `JiraClient` echoes whatever it is given and so cannot
prove persistence — with a documented marker-only fallback if it fails. Issue 07
was sequenced early precisely to settle this before `jira_get_comments` (08)
builds `authoredBy` on it.

## Decision

**Use the `mcp.origin` comment property as the primary authorship signal.** The
live round-trip is confirmed, so no fallback is triggered.

- Property key: `mcp.origin`. Value: `{ "authoredBy": "agent", "source": "lean-jira-mcp" }`. (Detection matches the key only, so comments stamped under the pre-rename `"source": "jira-mcp"` are still recognised.)
  Presence of the key is what authorship derivation keys on; the value records
  who/what for forward compatibility.
- The visible marker remains a **secondary** signal: a human-facing decoration
  and a fallback for comments written before the property existed (or by another
  agent using the same/legacy marker).
- `deriveAuthoredBy` (`src/lib/comment-authorship.ts`) resolves authorship
  property-first, then marker (configured **and** legacy `:claude:`), else
  human / unknown. This is the derivation slice 08 reuses for `authoredBy`.
- Both signals are stamped through a single write path (`buildStampedWrite`), so
  neither the post nor the edit branch can emit an unstamped comment.

## Live verification (the point of doing 07 early)

Run against `https://example.atlassian.net` with the real `JiraClient`
(throwaway issue created in a sandbox project, then cleaned up):

- `POST /rest/api/3/issue/{key}/comment` with a `properties: [{key:"mcp.origin", value:{…}}]`
  field succeeds.
- A **separate** `GET .../comment/{id}?expand=properties` returns the property
  with its value intact — proving persistence, not POST echo. ✅
- The property **survives an edit**: after `PUT .../comment/{id}` (which replaces
  the body), a fresh GET still returns `mcp.origin`. The handler re-stamps it on
  every edit regardless, so this holds even if a future API stopped persisting
  properties across a body PUT. ✅

(The smoke script lived in the scratchpad and is not committed; these results are
the artifact.)

## Consequences

- `authoredBy` (slice 08) can trust the property as primary; the marker-only
  fallback path is NOT needed for new comments and exists only for legacy/history.
- Marker stamping is idempotent and configurable; the property value is fixed.
- The edit guard (07) reads `expand=properties` on the target comment and refuses
  to edit anything not resolved as agent-authored.

## Note discovered during this slice (out of scope, flagged)

The live `createmeta` endpoint
(`/rest/api/3/issue/createmeta/{key}/issuetypes`) returns the issue types under
an `issueTypes` key, but `JiraClient.getCreateMeta` (issue 04) reads them from
`values`. The create *recovery hint* path (fetched only on a create failure) is
therefore degraded against real JIRA — it would report no creatable types /
no required fields. Create itself works. This is an issue-04 bug, left untouched
here to keep this commit scoped to 07; flagged for a follow-up fix.
