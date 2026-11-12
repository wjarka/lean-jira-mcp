# lean-jira-mcp

A lean, agent-first MCP server for JIRA Cloud. See [`DESIGN.md`](./DESIGN.md)
for the rationale and design decisions.

Instead of mapping the REST API 1:1, it exposes 10 intent-shaped tools that read
and write markdown (not raw ADF), resolve human references (emails, "me", status
names) server-side, hide internal IDs and pagination mechanics, and stamp every
response — success or error — with recovery `hints`.

## Tools & resources

**Tools:** `jira_search`, `jira_get_issue`, `jira_create_issue`,
`jira_update_issue`, `jira_transition`, `jira_comment`, `jira_get_comments`,
`jira_describe_project`, `jira_read_attachment`, `jira_add_attachment`.

**Resources:** `jira://projects` (project catalog), `jira://jql-fields` (JQL
field catalog incl. custom fields), `jira://link-types`.

## Requirements

- A JIRA Cloud site + a **classic, unscoped** [API token](https://id.atlassian.com/manage-profile/security/api-tokens) (see below)
- One of: a host that can run the published bin via `npx` (Node ≥ 24), the
  one-click `.mcpb` bundle (also Node ≥ 24), or [Bun](https://bun.sh) for local development

## Configuration

All configuration is read from the environment at startup — **credentials are
never passed as tool arguments**. Missing or blank required values fail fast with
a clear startup error naming the variable.

| Variable                  | Required | Default            | Description                                                              |
| ------------------------- | -------- | ------------------ | ------------------------------------------------------------------------ |
| `JIRA_BASE_URL`           | yes      | —                  | Your JIRA Cloud site, e.g. `https://your-domain.atlassian.net`           |
| `JIRA_EMAIL`              | yes      | —                  | Atlassian account email (HTTP basic auth)                                |
| `JIRA_API_TOKEN`          | yes      | —                  | **Classic, unscoped** API token (see below)                             |
| `JIRA_PROJECT_DEFAULT`    | no       | —                  | Project key used by `jira_create_issue` when none is given (e.g. `PROJ`) |
| `JIRA_MCP_COMMENT_MARKER` | no       | `:claude:`         | Visible marker prefixed to comments the agent posts                      |
| `JIRA_FIELD_STORY_POINTS` | no       | auto-detected       | Custom-field id backing Story Points (explicit override)                 |
| `JIRA_FIELD_SPRINT`       | no       | auto-detected       | Custom-field id backing Sprint (explicit override)                       |
| `JIRA_FIELD_EPIC_LINK`    | no       | auto-detected       | Custom-field id backing Epic Link (explicit override)                    |
| `JIRA_MCP_ATTACHMENT_MAX_BYTES` | no | `26214400` (25 MB) | Hard byte ceiling for `jira_read_attachment`; a larger file is refused before download (note + URL returned) |
| `JIRA_ATTACHMENT_ROOT`    | no       | cwd + temp dirs    | Path-delimiter (`:`/`;`)-separated roots `jira_add_attachment` may upload from; a path outside all roots (after `..`/symlink resolution) is refused, blocking exfiltration of e.g. `~/.ssh`. Defaults cover only agent-produced dirs; a dir holding personal files (e.g. `~/Downloads`) is a deliberate opt-in |
| `JIRA_MCP_ATTACHMENT_UPLOAD_MAX_BYTES` | no | `26214400` (25 MB) | Size cap for `jira_add_attachment`; a larger file is refused with a hint instead of a raw 413 |

The three `JIRA_FIELD_*` ids back the curated agile fields surfaced by
`jira_get_issue`. The server detects each id automatically per instance at
startup (Sprint and Epic Link by their stable JIRA Software schema key, Story
Points by field name), so these are only needed as an explicit override when
detection misses on your instance — find the id at `/rest/api/3/field` and set
the matching variable. If a field isn't detected and no override is set, the
server logs a warning naming it and omits it from `jira_get_issue` rather than
guessing.

### The API token must be unscoped

Create the token at
[id.atlassian.com → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
with **"Create API token"** — *not* "Create API token with scopes".

A **scoped** token (one with granular scopes such as `read:jira-work`,
`write:jira-work`, `read:jira-user`, `read:me`) **does not work with HTTP basic
auth**. JIRA Cloud doesn't reject it outright — it silently treats the request as
**anonymous**, so data endpoints return `200` with *empty* results while
`/myself` returns `401`. The symptom is "every search returns 0 issues."

The server guards against this: on the first tool call it preflights `/rest/api/3/myself`
once (memoized). If the credentials are rejected, the tool returns an
`authentication_failed` error with a hint instead of a misleading empty result.

Quick check that a token works:

```sh
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  https://your-domain.atlassian.net/rest/api/3/myself
# → your user JSON (good)   |   401 "Client must be authenticated" (bad token)
```

## Install

### Claude Code

```sh
claude mcp add jira \
  -e JIRA_BASE_URL=https://your-domain.atlassian.net \
  -e JIRA_EMAIL=you@example.com \
  -e JIRA_API_TOKEN=your-api-token \
  -- npx -y lean-jira-mcp
```

Default scope is `local` (this project only); add `-s user` before `--` to make
it available in all your projects.

### Codex CLI

```sh
codex mcp add jira \
  --env JIRA_BASE_URL=https://your-domain.atlassian.net \
  --env JIRA_EMAIL=you@example.com \
  --env JIRA_API_TOKEN=your-api-token \
  -- npx -y lean-jira-mcp
```

Or edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.jira]
command = "npx"
args = ["-y", "lean-jira-mcp"]

[mcp_servers.jira.env]
JIRA_BASE_URL = "https://your-domain.atlassian.net"
JIRA_EMAIL = "you@example.com"
JIRA_API_TOKEN = "your-api-token"
```

### Any other MCP client — `npx`

No manual build: the published package ships a self-contained, Node-runnable bin.
Point your client's MCP config at it and supply credentials via `env`:

```jsonc
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "lean-jira-mcp"],
      "env": {
        "JIRA_BASE_URL": "https://your-domain.atlassian.net",
        "JIRA_EMAIL": "you@example.com",
        "JIRA_API_TOKEN": "your-unscoped-api-token",
        "JIRA_PROJECT_DEFAULT": "PROJ",
        "JIRA_MCP_COMMENT_MARKER": ":claude:"
      }
    }
  }
}
```

(In Claude Desktop this lives in `claude_desktop_config.json`. Only the first
three env vars are required; the rest are optional.)

### Claude Desktop — `.mcpb` bundle (one-click)

Build the bundle, then open it in Claude Desktop (Settings → Extensions, or
double-click the `.mcpb` file). Claude Desktop prompts for the configuration
values listed above and stores the API token securely.

```sh
bun install
bun run build:mcpb   # → dist/lean-jira-mcp.mcpb
```

The bundle is a self-contained Node payload (no `node_modules` to ship) plus a
[`manifest.json`](./manifest.json) whose config prompts map 1:1 onto the env
variables in the table above. To validate the manifest against the official spec:

```sh
npx -y @anthropic-ai/mcpb validate manifest.json
```

## Known limitations

- **Comment reactions are not readable.** Emoji reactions (👍 etc.) are not
  exposed by the Jira Cloud REST/token API — there is no `reactions` field,
  expand, or Jira Expressions route, and the internal reaction endpoints are
  absent on Cloud (or cookie/session-auth only). The only honest out-of-band
  route is **browser automation against the rendered UI** (session auth) — a
  different mechanism and a different tool, **explicitly out of scope** for this
  REST/token-auth server. Treat reactions as a blind spot: never infer a
  decision, approval, or consensus from them — this server keys hand-offs off
  API-visible artifacts (text comments, labels, status) only.

## Local development

Use the Node LTS version in `.node-version` and the Bun version in `.bun-version`.
CI checks both Node 24.0.0 (the supported minimum) and the pinned tooling version.

```sh
bun install
cp .env.example .env   # fill in JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN

bun run start        # serve over stdio
bun test             # full offline test suite (no network)
bun run typecheck    # tsc --noEmit
bun run build        # bundle the Node bin → dist/index.js
bun run test:node    # smoke-test the built bundle under Node, using a local Jira stub
bun run test:runtimes # check runtime update selection
```

### Dependency and runtime updates

Dependabot checks Bun dependencies (`package.json` and `bun.lock`) and GitHub
Actions weekly. Minor and patch dependency updates are grouped; major upgrades
remain separate PRs.

The **Update runtimes** workflow checks the official Node and Bun release feeds
weekly and opens or refreshes one PR for the latest Node LTS and stable Bun pins.
It can also be run manually from Actions. It never downgrades a pin or raises
the minimum supported Node version automatically. The workflow explicitly
dispatches CI on its branch because PRs created with `GITHUB_TOKEN` do not
trigger `pull_request` workflows.

These workflows become active once merged to the default branch. In repository
**Settings → Actions → General → Workflow permissions**, enable **Allow GitHub
Actions to create and approve pull requests** so runtime PR creation can work.
The workflow only creates PRs; review and merge updates after CI passes.

### The Bun `.env` autoload footgun (config can look ignored)

Bun **auto-loads a `.env` from the working directory**. When an MCP client
launches the server with `bun run src/index.ts` and cwd = this repo, a stray
repo `.env` **backfills any env var the client didn't set in its own config** —
silently. That can:

- **mask the fail-fast contract** — a missing required var looks "set" because
  `.env` filled it in, so the server starts instead of failing loudly; and
- **make `JIRA_PROJECT_DEFAULT` look ignored** — the repo `.env`'s value wins
  over what you thought the client was (or wasn't) passing.

The published **Node bin does not autoload `.env`** — this only bites local
development/testing via Bun. To test config and fail-fast behaviour faithfully,
run from a **clean cwd** (or temporarily move the repo `.env` aside) so only the
vars you actually pass are in scope:

```sh
cd "$(mktemp -d)" && JIRA_BASE_URL=… JIRA_EMAIL=… JIRA_API_TOKEN=… bun run /path/to/repo/src/index.ts
```

### Architecture

- `src/config/env.ts` — the single config read path: loads + validates env, fails fast.
- `src/lib/jira-client.ts` — the single HTTP boundary to JIRA (auth, retry/backoff).
  The one external test seam; tool handlers depend on the `IJiraClient` interface.
- `src/lib/response-shaper.ts` — uniform success/error envelope that stamps `hints`.
- `src/tools/` — one file per tool + a central registry (`tools/index.ts`).
- `src/resources/` — the static reference resources + registry.
- `src/core/server.ts` — dependency-injected `McpServer` construction.
- `test/helpers/fake-jira-client.ts` — the faked-`JiraClient` fixture every tool reuses.

### Manual / live smoke test

The test suite runs fully offline against the fake client. To exercise the real
JIRA path, set credentials in `.env` and point MCP Inspector at the server:

```sh
bunx @modelcontextprotocol/inspector bun run src/index.ts
```

Then call `jira_search` with a real `jql` (e.g. `project = ABC ORDER BY updated DESC`).
