# JIRA MCP Server — Design

A lean, agent-first MCP server for JIRA Cloud. Built as a deliberate counter to Atlassian's
official server, whose sins are: 1:1 endpoint→tool mapping (huge tool surface = permanent
schema tax on every turn), raw verbose payloads (full ADF, all custom fields, rendered+raw
duplicates), leaky abstractions (internal IDs, multi-call intents), and contextless responses.

## Guiding principles (apply to every tool)

- **Design around intents, not endpoints.** ~10 tools cover a full JIRA workday.
- **Lean by default, verbose on opt-in** (`detail` / `fields` params). Never dump.
- **Flatten ADF → markdown on read; markdown → ADF on write** (safe subset, round-trip lossy by design).
  - **"Degrade gracefully" = degrade *visibly*.** The sin is *undetectable* loss, not loss. We may
    drop how content *looks* (column alignment, list-nesting depth, panel chrome); we may **never
    silently drop or alter what it *says***. Per-node test the implementer applies: *render this node
    to nothing — does the reader lose information they'd act on, or just formatting?* Formatting →
    drop silently. Information (image existence/filename, status-lozenge text, dates, checkbox state,
    link targets, panel type) → preserve as text, or a visible marker; never `""`.
  - **Read** marks the gap inline (`[image: screenshot.png]`, `[status: DONE]`, `[panel: warning] …`;
    render checkboxes as real `- [x]`/`- [ ]`). **Write** reports the diff coarsely in `hints`
    ("stored body differs: image saved as link; checkboxes flattened"). **Reject-with-hint** only when
    best-effort output would be *actively misleading* (not merely simpler) — and first fix the
    converter so no branch ever emits literal garbage.
  - **"Never mislead" scales by the *kind* of gap.** An **incidental** absence (content the tool
    *could* return but dropped/truncated on a given call) is marked **inline, per-response** — it's
    situational. A **structural** absence (categorically missing from the source, every call, forever —
    e.g. comment *reactions*, which the REST API doesn't expose) is documented **once at the grounding
    layer** (tool description + README "known limitations"), **never per-response** — repeating a
    permanent fact on the hot path is noise, and you'd otherwise annotate every response with the
    infinite list of things JIRA has that the API doesn't.
- **Decisions ride API-visible artifacts, never inferred-from-what-the-API-can't-see.** Any state
  advance (hand-off, consensus, approval) must key off a *readable* artifact — text comment, label, or
  status — never a signal the API can't return (a 👍 reaction is often the human's actual approval, yet
  it's invisible to REST). So **never equate "no text reply" with "no response"** — the human may have
  reacted invisibly. (Our `:claude:`-marker + label-flip + text hand-off already conforms; the guard is
  don't regress into consensus/sentiment inference on comment data that isn't complete.)
- **Server-side resolution of human refs** — assignee email/display-name/`me`, project key, sprint
  `"current"`, status names. The model never sees or passes internal IDs (transition ids,
  `customfield_XXXXX`, accountIds).
- **`hints` field on every response**, success *and* error — tell the model what to do next.
  Bad value → return the valid options for *this* entity. This is a **universal invariant, not a
  feature with coverage**: a bad reference *always* teaches the valid options — no exceptions. The
  rare failure path is the *high-value* one (a self-correction contract exists for exactly the moment
  things go wrong), and an agent in a loop can't shrug off a raw error the way a human can.
- **Invariants are fixed now; increments are scheduled.** Triage rule for "fix immediately vs defer":
  if the change restores something promised to be *always* true (e.g. the recovery-hint contract),
  it's an **invariant violation → fix now**, regardless of size or frequency — one exception costs the
  ability to *rely on* the rule at all. If it's just more coverage/depth nobody was promised, it's an
  **increment → defer** on cost/frequency grounds. The test: *would the plain-English statement of the
  rule need an "except…"?* If yes, it's an invariant hole; close it. Frequency governs features, not
  invariants.
- **Surface every layer of truth you can read, tag each with its fidelity, and stop at the layer you
  can read but not compute.** When sources answer different questions, don't let one impersonate
  another; *relabeling is the floor when higher fidelity is unreadable, not the ceiling.* Canonical
  case — workflow transitions have **three layers**: (1) **topology** ("defined", always readable via
  preview), (2) **gates** ("requires [conditions/validators]; has a screen", readable from the rich
  workflow endpoint *if permitted*), (3) **runtime verdict** ("firable now for this issue+user",
  `getTransitions` — gives only the available set, never *why* a hidden edge is hidden). `describe_project`
  surfaces 1+2 (the map = *what's possible* + *what gates it*), `jira_transition` owns 3 (*what's
  firable now*). Expose what you can read (tag missing-because-unreadable vs missing-because-absent via
  a fidelity field); **never assert a verdict you didn't evaluate** — name *what* gates an edge, never
  *which* gate failed (evaluating conditions = reimplementing Jira's engine = forbidden).
- **Rate limiting, retries, backoff, pagination mechanics** are handled server-side. Never
  pushed onto the agent.
- **The system describes and executes; the agent plans and chooses.** No server-side semantic
  decisions (e.g. no transition pathfinding).
- **Never make the agent guess a fact; never silently decide an intent.** A missing identifier the
  agent would have to *invent* (a project key/name) is the *server's* bug — inject it (tool results,
  tool descriptions, server instructions). An *ambiguous intent* ("the project" = the configured
  default, or genuinely cross-project?) is the *user's* call — surface the default and hint/ask,
  never auto-decide. Applied to the default project: a **hard** default for `create_issue` (no
  legitimate ambiguity), only **surfaced** to reads (raw JQL stays raw — we flag too-broad results,
  we don't rewrite the query).

## Locked decisions (foundation)

- **Stack:** TypeScript on **Bun** (official `@modelcontextprotocol/sdk`, stdio transport).
- **Target:** JIRA Cloud (REST v3; the new enhanced-search endpoint).
- **Auth:** API token + email (basic), via env. Designed so OAuth 2.0 can slot in later.
  Server is stateless per call; host manages credentials.
- **Distribution:** npx-able bin + `.mcpb` MCP Bundle for one-click Claude Desktop install.

## Project scaffolding references

- **Bootstrap** from the official SDK `docs/server.md` (`McpServer` + `registerTool` +
  `registerResource` + `StdioServerTransport`). The SDK auto-derives JSON Schema from zod.
- **Layout + hints philosophy** from `iceener/files-stdio-mcp-server`: `config/` (metadata
  separated from handlers) · `core/` (MCP setup) · `tools/` (+ central `tools/index.ts` registry)
  · `lib/` (ADF↔md converter, ref resolver, retry HTTP client) · `utils/` (errors+logging) · `.mcpb`.
- **Registry + zod + resources patterns** from `iceener/streamable-mcp-server-template`
  (`defineTool`/`defineResource`, zod `.describe()`); **skip** its HTTP/Workers/OAuth/session weight.
- **Add ourselves** (templates lack): a `resources/` registry, a shared response-shaper that stamps
  `hints` on success+error uniformly.
- **Verify early:** zod `.describe()` field-description propagation in MCP Inspector (SDK issue #1143)
  — our design leans hard on description quality.

---

## Tool surface — 10 tools

`search` · `get_issue` · `create_issue` · `update_issue` · `transition` · `comment` · `get_comments` · `describe_project` · `read_attachment` · `add_attachment`
(+ `link` designed, not yet built — see §11)

### 1. `jira_search`
- **Input:** raw **JQL** (single `jql` param). Claude is good at JQL; the real footgun is *data*
  (custom field names, status/sprint names), solved by the `jql-fields` resource + server-side
  ref resolution, not by a structured wrapper. JQL can't escape the token's permission scope.
- **Result card (default):** `key, summary, status, type, priority, assignee (display name),
  labels, updated`. Rank used only as **sort order** (list position carries it), never emitted.
  Optional `fields` overrides.
- **Pagination:** opaque token cursor (`nextCursor`, passed back **verbatim** — labeled "do not
  modify"). Default page **25**; `limit` param caps ~100.
- **Count:** none by default. Scope comes **free** from `isLast`: first page `isLast:true` →
  exact total = rows returned ("Showing all 7"); `isLast:false` → "25+ available." `includeCount`
  opt-in hits `/approximate-count`, returned **labeled approximate** ("~300"), for reporting intents only.
- **Errors:** JQL parse error echoed + hint pointing at `jql-fields`.
- **Default-project grounding (surfaced, never auto-injected):** when `JIRA_PROJECT_DEFAULT` is set,
  the configured default is surfaced to the agent (server instructions + the search tool description:
  "when the user says 'the project'/'the sprint' without naming one, add `project = <default>`; for
  deliberate cross-project queries, omit it"). The server does **not** rewrite the agent's JQL. As a
  read-side safety net, when a default is configured **and** the JQL had no project clause **and**
  results span >1 project, the response `hints` flag the breadth ("results span PROJ, FOO, BAR;
  default PROJ is configured — add `project = PROJ` to scope"), so unintended cross-project reads are
  caught on the spot without mutating the query.

### 2. `jira_get_issue`
- **`detail: "summary" | "full"`** (default `summary`) — depth preset for the standard payload.
  - `summary`: card fields + Story Points + flattened description (**token-budget truncated** ~450 tok
    at a paragraph boundary, with a size-aware hint "showing ~450 of ~3200 tokens, use detail:full")
    + **counts** ("12 comments, 3 links, 5 subtasks").
  - `full`: + untruncated description + links + subtasks + last 3 comments + curated agile fields.
- **`fields: string[]`** — *additive* override for named **extras only** (mostly custom fields). Must
  **not** re-specify what `detail`/the card already controls — a named card/standard field is
  ignored (it's already present), never re-emitted as a duplicate. Extras are returned **flattened to
  lean values** (status→name, priority→name, user→display name), never raw JIRA field objects with
  `self`/`iconUrl`/`statusCategory` (that bloat is the very thing the server exists to avoid).
- **`comments: "none" | "recent" | "all"`** (default `none`; auto-`recent` when `detail:full`).
  `recent` = last 3 preview; `all` = paginated (`commentsCursor` / `commentsIsLast`).
- **Custom fields:** arbitrary ones hidden unless named in `fields`. A **curated agile set**
  (Story Points, Sprint, Epic Link) resolved server-side and shown by **friendly name**. Model never
  sees `customfield_XXXXX`. The curated field ids are **auto-detected per instance** from field
  metadata (match Sprint/Epic-Link by schema custom key, Story Points by name), memoized; precedence
  is explicit `JIRA_FIELD_*` env override → detected → hardcoded cloud default as last resort.
  Hardcoding the cloud defaults silently breaks these fields (read *and* sprint write) on any
  instance whose ids differ.
- **Changelog/history:** punted for v1. No `raw` level (would contradict the ADF-flatten contract).
- **Attachments:** an issue sub-resource like comments/links — `summary` shows a **count**, `full`
  shows the **list** (`{id, filename, mimeType, size, created, author}`, not paginated). This is the
  "find" surface; the agent reads a specific one with `read_attachment` (below).

### 3 & 4. `jira_create_issue` + `jira_update_issue` (one shared field-builder)
- **Rich text:** model writes **markdown → server converts to ADF** (safe subset: headings,
  bold/italic, lists, code blocks w/ language, inline code, links, blockquote, hr, flat GFM tables).
  @mentions punted to v1.1. The converter's contract is **schema-valid ADF, not just plausible ADF**:
  in particular the **`code` mark is exclusive** (never combined with strong/em/strike/link/etc. — e.g.
  inline code nested in bold emits a code-only node), and a final validity pass strips disallowed mark
  combinations. Emitting invalid ADF gets the whole write rejected by JIRA as a bare `INVALID_INPUT`
  (issue 20).
- **Multi-value fields:** use JIRA's **native `update` ops** (not server-side read-modify-write).
  `addLabels[]` / `removeLabels[]` primary; explicit `setLabels[]` for replace-all (named so never
  accidental). Same for `components`, `fixVersions`. Watchers punted. Labels normalized (no spaces).
- **Assignee:** accept email / display name / `me` / `currentUser` → accountId; `null` clears.
  **Reporter** reuses the resolver (expect permission failures → clear hint). Skip the `-1` default case.
- **Create defaults:** `summary` required; `project` from env default; `issuetype` default `"Task"`
  (validated per-project). **createmeta fetched only on failure** → returns required-field list as a hint.
- **Parent:** single `parent` key; server resolves company- vs team-managed mechanism.
- **Sprint:** accepts `id`, `"current"`, or a sprint **name**. Assignment uses the **Agile API**
  (`POST /rest/agile/1.0/sprint/{id}/issue`; clear → backlog endpoint) — screen-independent, needs no
  Sprint custom-field id. `"current"`/name resolution **filters to sprint-supporting boards first** —
  *any non-Kanban board*, i.e. scrum AND team-managed "simple" boards (filter on "supports sprints",
  NOT literally `type=="scrum"`, or you silently break next-gen projects); never a Kanban board → no "board does not support sprints" 400), resolves silently when unambiguous, and
  **surfaces candidate sprints + ids when ambiguous** (>1 active sprint / same name on two boards) —
  never guesses. Board/sprint ids come from `describe_project` tier-1 `boards[]`. On create, sprint
  is a create-then-move (non-atomic — a move failure after create returns a hint). See issue 15.
- **Partial update (presence-aware):** field absent = leave alone; `field: null` = clear. Set-ops →
  `fields` section, add/remove → `update` section.
- **Divergence:** create requires summary/project/issuetype, returns `{key, url}`; update requires
  issueKey and owns the add/remove deltas. Conversion/resolution logic identical.

### 5. `jira_transition`
- **Input:** single **`transition`** field accepting a transition **name OR** target **status**.
  Resolution order: exact transition-name match → else target-status match → if a status matches
  **>1 transition, refuse** and return the named options ("'To Do' is reachable via 'QA Failed' or
  'Put on Hold' — pass the transition name"). Model never passes a numeric transition id. Same
  status → graceful no-op.
- **Why name-or-status:** transitions are **semantic actions, not status-moves**. Two transitions
  can land on one status with different post-functions/notifications; name-addressing preserves that.
  Status-addressing is frictionless for the ~80% that are 1:1.
- **Screen fields (in v1, validated PROACTIVELY):** the `GET /transitions?expand=transitions.fields`
  call we already make to resolve the name *also* yields required fields **for free**. Accept optional
  `fields` (shared builder; `resolution` headliner); if required fields missing, return the list as a
  hint *without* a failing attempt.
- **No server pathfinding.** Route choice is semantic — the server has no business ranking routes.
  No-direct-edge → return current status's available next steps + a `describe_project` pointer; the
  agent walks multi-hop itself, choosing named transitions by meaning.
- **Reconcile a miss against the design-time graph** (issue 19). On a target miss, cross-reference the
  edges the workflow *defines* from the current status — plus their gates when readable — (one extra
  call, failure-only, cached capability) and distinguish three cases: **defined-but-gated** ("the
  workflow defines X from here; it requires [assignee-only, sub-tasks resolved] and isn't currently
  available — one or more of those or a permission isn't met for this issue/you; we don't evaluate
  which"), **defined-but-rules-unreadable** ("defines X but not firable now; gating rules not readable
  at this permission level"), and **genuinely undefined** ("no transition X is defined from here").
  **Verb discipline:** state what the workflow *defines* / *requires* and that an edge is *not
  available* (facts held); never claim *which* gate *failed* (a verdict you didn't evaluate —
  getTransitions never tells you *why*). This stops `no_direct_transition` from contradicting the map.
- **After a successful transition**, the response hints the transitions now available from the *new*
  status (one extra `getTransitions` read), so the agent can take the next hop of a manual multi-step
  move without a separate lookup. This is the in-tool complement to "no pathfinding" — the server
  doesn't plan the route, but it surfaces the next legal steps after each hop. Best-effort: if that
  read fails the transition still succeeded (omit the hint, never fail the tool); a terminal status
  reports "no further transitions available."
- Comment-on-transition **punted** (that inline path can't carry the `mcp.origin` property → would
  split stamping logic). Case/whitespace-insensitive matching.

### 6. `jira_comment` (write)
- **Body** markdown → ADF (shared converter). Model passes **only `body`**.
- **Auto-stamp every comment — no opt-out:** an `mcp.origin` comment **property** (machine truth)
  + a **visible marker** (human courtesy in the JIRA UI). An opt-out would create unattributable
  comments and silently break `sinceLastAgentComment` + detection loops.
- **Configurable marker:** the visible emoji is config-driven (`JIRA_MCP_COMMENT_MARKER`, default
  `:claude:`) — decoupled from Claude, since the machine truth is the property.
- **Update via optional `commentId`, guarded:** only edit comments the MCP authored
  (`authoredBy:agent`), else refuse with a hint; **re-stamp** marker on edit.
- **`visibility`** param (role/group restriction), default public; bad role → hint. JSM notes punted.
- **Response:** `{ commentId, url (deep-link), authoredBy, created, updated?, visibility?, hint }`.

### 7. `jira_get_comments` (read)
- Promoted to its own tool: comment-reading dominates 2/4 of the user's real workflows
  (grooming, impl-prep), is independently paginated, and decoupled from the issue body.
- **Per comment:** `{ id, author, authoredBy: "agent"|"human"|"unknown", created, updated (if≠created),
  body (flattened md, marker preserved) }`.
- **Authorship (`authoredBy`):** derived server-side — `mcp.origin` property primary; **emoji-marker
  fallback** for pre-property comments (matches the *configured* marker **and** legacy `:claude:` so
  existing history doesn't read as `human`). Honest best-effort; absent both → `human`/`unknown`.
  *Property round-trip to be verified against JIRA Cloud during build; emoji fallback ships day one.*
- **Full bodies by default — comment bodies are NEVER truncated.** Comment content is this tool's
  entire deliverable, so (unlike get_issue's incidental description) the lean lever is *how many
  comments per page*, never *how much of each comment*. Truncating the thing the caller came for, and
  pointing them at another tool to read it, is a bug — removed.
  - **Pagination is token-budgeted** (~3–4k tokens/page) over *whole* comments, with a ~25-comment
    count backstop. A single over-budget comment becomes **its own page, returned whole** — comments
    are never split, so there is no routine "capped" state.
  - **`preview: true`** is the only truncation that exists — explicit, opt-in short snippets for
    scanning a thread cheaply (inverts lean-default for this tool, where verbose *is* the job).
  - **`commentId`** returns just that one comment, full — and is the recovery target for `get_issue`'s
    clipped last-3 preview (whose hint points here, NOT at `detail:full`).
  - **`sinceLastAgentComment` and `commentId` always return full bodies.**
  - Every hint resolves **within this tool** — never "read it elsewhere."
  - Per comment: `{ id, author, authoredBy, created, updated (if≠created), body }` (markdown, marker
    preserved). Same opaque `nextCursor` + `isLast` cursor mechanics as search.
- **Killer feature — `sinceLastAgentComment: true`** (+ `since: <id|timestamp>`): because the MCP owns
  authorship, it answers the real loop question ("did the human reply since I last posted?") by
  returning only comments after our last stamped one. Collapses an 80-comment re-read into the 1–2
  genuinely new ones.
- **Reactions are not exposed** (structural blind spot): the REST API doesn't return emoji reactions,
  so `get_comments` can't include them — stated once in the tool description (not per-response). A
  human's 👍 is invisible here; never infer approval/response from its presence or absence (issue 21).

### 8. `jira_describe_project`
- **A tool, not a resource** — it's a *parameterized, on-demand* lookup consumed mid-reasoning;
  resource activation isn't reliably agent-driven.
- **Tiered (like get_issue), now with a tier-0 catalog:**
  - `jira_describe_project()` (no arg) → the **project catalog** (`{key, name, lead}[]`). A reliable
    *tool* path to the catalog so the agent never has to guess a project key/name — fixes the
    resource-activation gap (the `projects` resource is demoted to an optional UI/host-facing mirror).
  - `jira_describe_project(projectKey)` → **project identity** (`key, name, description, lead`) +
    `projectType: "company"|"team"` + `issueTypes: [...]` + **`boards[]`** (`{id, name,
    type:"scrum"|"kanban"|"simple", sprints:[{id, name, state:"active"|"future"}]}`; closed excluded).
    Echoing identity kills project-name hallucination; `boards[]` is the agent's source for sprint
    ids (so sprint assignment / "current" resolution has no separate discovery tool or resource).
  - `jira_describe_project(projectKey, issueType)` → `{ statuses: [...], transitions: [{name,
    from, to, requires?, hasScreen?}], ruleFidelity: "full"|"topology" }` (global edges as `from:
    "*"`). It's the **design-time** graph (what's *possible*) — the design-time framing is carried by
    **`ruleFidelity`** + the per-call hint (not by the field name; shipped as `transitions`). When the
    rich workflow read is permitted, each edge carries **`requires`** (terse human-readable gate
    phrases — recognized condition/validator types mapped to short strings; an unsummarizable/custom
    gate shows a visible `"unrecognized condition"` marker, never dropped) and **`hasScreen`** (a
    transition *screen exists* — NOT that input is mandatory; `jira_transition` reports which fields,
    if any, are actually required); ungated edges omit `requires`; raw rule config and post-functions
    are NOT included. **`ruleFidelity`** is set from *observed data*: `full` (rules read → missing
    `requires` means ungated) or `topology` (rules unreadable → one note, and missing `requires` means
    *unknown*, not none). Source is **capability-detected**: attempt the rich workflow read, fall back to preview
    on a 403, cache the capability per session. This is "possible by design + what gates it";
    `jira_transition` owns "firable now" — `describe_project` never asserts per-issue firability.
- **Workflow-only** — no createmeta/required-fields folded in (heavy; stays lazy in create_issue).
  Abstracts company- vs team-managed; uniform shape, `projectType` exposed for the rare epic-handling case.
- It's the **map** the agent plans transition routes against — and, via tier-0/1, its source of truth
  for *which* projects exist and what they're called.

### 9. `jira_read_attachment` (read-only)
- **Earns a tool** on the `get_comments` precedent: a distinct binary access pattern returning
  **content blocks** (image/text), not a structured object, and never wanted inline. **One
  attachment id per call** — `jira_read_attachment(attachmentId, offset?, pageRange?)`. Discovery is
  `get_issue`'s attachment list (above), so a read is an informed, sized choice.
- **Per-type, degrade visibly:** images → a native MCP **`image` block, downscaled server-side**
  (~1568px longest edge; image token cost is dimensions-not-bytes, so downscaling *is* the guardrail)
  + a visible note when downscaled. Text-ish → token-budgeted text + `offset`. PDF → server-extracted
  text + `pageRange` (issue 17). Office/unknown →
  metadata + a visible "can't inline <type> (<size>); download at <url>" note.
- **Guardrails (triple lock):** informed selection (size shown at discovery) + one-at-a-time +
  server-side downscale/truncate caps, plus an optional hard byte ceiling (refuse > ~25 MB → hint +
  URL). A naive fetch can't torch the context window.
- **MCP mechanics:** tool-returns (not a resource); image bytes go in an `image` block, **never** a
  text block (base64 in text gets tokenized — ruinous; an image block is dimension-costed). No
  reliable cross-host PDF "document" block exists → extract text rather than pass the blob.
### 10. `jira_add_attachment` (write, path-source)
- **Earns the 10th tool** on the read precedent: a distinct binary *write* (multipart), not a field.
  `jira_add_attachment(issueKey, path, allowDuplicate?)` — `POST .../attachments`,
  `X-Atlassian-Token: no-check`, one file per call, via the `JiraClient` seam.
- **Source = local filesystem `path` only** (viable *because* local stdio). URL-fetch deferred;
  **base64 inline and "context image" are rejected** — the model has no byte access to an image it
  merely *saw*, so a file is attachable only when it exists **on disk**. (State this in the tool
  description; it's the user's likely-wrong mental model.)
- **Canonical use case — host-saved file → JIRA.** Host tooling saves a file to disk (a capture, an
  export, a download) and hands the agent its path, so `save → {path} → add_attachment(path)` is
  exactly the path-based flow. Such files typically land in a temp/scratch dir (not cwd), so the
  scoping below must allow it or it refuses the very use case.
- **Path scoping is a guardrail, not polish.** Upload is outward-facing and the agent is
  prompt-injectable (a poisoned issue could say "attach `~/.ssh/id_rsa`"). Local stdio runs as the
  user, so it's not privilege escalation — it's *exfiltration* risk. Constrain environmentally:
  scope reads to `JIRA_ATTACHMENT_ROOT` roots — **default cwd + the OS temp dirs** (resolve
  `..`/symlinks before checking) — denylist sensitive patterns (`.ssh`/`.env`/dotfiles) even inside a
  root, and surface filename+size+destination in the hint. (Allowing temp is safe: exfil targets are
  in `$HOME`, not a dir of agent-generated files.)
- **Dupe handling:** JIRA silently allows same-named dupes → refuse a collision with a hint + an
  `allowDuplicate:true` opt-in (degrade-visibly; nothing happens until the agent decides). Size cap →
  hint not raw 413; MIME detected from content.
### 11. `jira_link` (write, issue↔issue relationships) — designed, NOT yet built (issue 22, v1.x target)
- **Earns its slot — a relationship is not an attribute.** The reusable rule that governs this whole
  class of "new tool vs. new param" fork: **a single-valued attribute you *set/clear* (no independent
  lifecycle) rides a param; a multi-valued relationship with its own *add/remove* lifecycle earns a
  tool.** Sprint and parent are *placements* (single-valued, cleared by `null`, no id to address) →
  they correctly ride create/update params (issue 15). An issue link is an **edge in a graph** —
  "PROJ-1 blocks PROJ-2" is a fact about a *pair*, it's multi-valued, it appears on **both** issues, and
  it's created/removed independently of either issue's own content. A `links[]` param would (a) muddy
  the locked present/absent/`null` partial-update semantics, (b) can't address one specific edge for
  removal (you can't `null` away just the blocks-PROJ-2 edge), and (c) forces an issue update for a
  lifecycle that has nothing to do with the issue's fields. So `jira_link` earns the 11th slot on the
  same bar as `get_comments`/`read_attachment`: a distinct operation with a distinct shape. It is
  **intent-shaped** ("relate these issues"), not a 1:1 REST wrapper — it honors anti-1:1.
- **No hybrid.** A `links[]` param *and* a tool is the two-ways-to-do-one-thing footgun killed
  everywhere else. `jira_link` is the **single canonical path**; "create a bug that blocks PROJ-5" costs
  one extra call, and that unambiguity is worth more than saving a round-trip.
- **Shape:** `jira_link(action: "add" | "remove" = "add", from, relationship, to, linkId?)`.
  - **`relationship` is a natural directional phrase** matching an inward *or* outward phrase from the
    `link-types` resource — stated in **reading order** `(from, relationship, to)`. The server owns
    inward/outward resolution: "PROJ-1 **blocks** PROJ-2" → Blocks type, outward → `outwardIssue=PROJ-1`,
    `inwardIssue=PROJ-2`; "PROJ-2 **is blocked by** PROJ-1" resolves to the identical edge, sides flipped.
    The agent **never** specifies inward/outward — that JSON field pair is exactly the leaky REST detail
    anti-1:1 exists to hide. An unrecognized phrase → hint listing the available relationship phrases
    (recovery-hint pattern reusing `link-types`).
  - **`add` is idempotent on (type, direction, ordered-pair):** if the edge already exists → **no-op
    success + hint** ("PROJ-1 already blocks PROJ-2; no change"). A link is set membership — a duplicate
    edge carries zero information. (This *differs* from the `add_attachment` refuse-+-`allowDuplicate`
    default **on purpose:** two same-named files can be genuinely different content; two identical links
    are definitionally the same edge. Same principle — never create a confusing duplicate — different
    default because the data models differ.) Idempotency also keeps remove-by-triple unambiguous in the
    common case, since duplicates are never manufactured.
  - **`remove` addresses the edge by the same semantic triple you add with** — `(from, relationship,
    to)` → server resolves triple → link id → delete. The agent does **not** carry link ids (the
    leaky-internal-id anti-pattern). 0 matches → hint; >1 match (legacy duplicates) → surface the
    candidate edges + their ids as a hint and accept the optional `linkId` to disambiguate. So
    `get_issue`'s serialized links gain the **link `id`** — but only as a disambiguation *escape hatch*,
    never the primary interface. Semantic-first, id-as-fallback (mirrors transition-name→id, sprint-name→id).
- **Out of scope:** **remote/web (URL) links** — different endpoint, different mental model (issue→URL,
  not issue↔issue), low demand for the grooming/impl/QA workflows (they comment URLs, not API-attach
  them). Overloading `jira_link` with two mental models hurts legibility. Revisit as its own param-vs-tool
  decision if demand appears; not pre-wired now.
- **Invariants (locked):** (1) `jira_link` is the single canonical path for issue↔issue links, never a
  create/update param; (2) the agent never specifies inward/outward — server owns direction resolution
  against `link-types`; (3) `add` is idempotent on (type, direction, ordered-pair); (4) hierarchy stays
  on the `parent` param — `jira_link` never touches parent/epic (don't reintroduce a dual path); (5)
  remote/web links stay out of scope for `jira_link`.

---

## Resources — 3 (static reference data)

- **`projects`** — catalog of all projects (list). **Demoted to an optional UI/host-facing mirror:**
  the agent's reliable path to the catalog is now `describe_project()` tier-0 (a tool), because
  resource activation isn't reliably agent-driven. This resource stays for host/user browsing.
- **`jql-fields`** — JQL field catalog incl. custom field names, for search discovery.
- **`link-types`** — issue link types; the named relationship phrases the designed `jira_link` (§11, not yet built) will resolve against.

(The originally-planned per-issue `transitions` resource was **dropped** — redundant with
`describe_project` + the reactive available-transitions hint.)

---

## Cross-cutting / authorship architecture

- **Machine truth = `mcp.origin` comment property** (out-of-band metadata, survives flattening,
  can't be human-typed). Visible marker is decorative + configurable.
- `authoredBy` enum is the *only* authorship signal the agent reads — it never parses ADF.
- Detection mechanism (property primary, emoji fallback) is an internal implementation detail.

## Deferred to v1.1+ (explicit cuts)

- **Issue linking** (`jira_link`) is designed (§11, issue 22) but not yet built — planned as tool #11
  for v1.x, issue↔issue links only.
  **Remote/web (URL) links remain deferred** (different endpoint + mental model; revisit on demand).
- Agile **admin** only: creating/closing/moving sprints, board CRUD, backlog ranking,
  velocity/burndown. (Sprint *assignment* + board/sprint *discovery* + current/by-name *resolution*
  are now IN v1.x — see issue 15 — done with no new tools: discovery rides `describe_project`,
  assignment rides `create/update_issue`.)
- Custom-field **writes** incl. Story Points (read surfaces curated agile fields; write only covers
  Sprint + Epic-Link-via-parent). v1.1 adds a write-side custom-field mechanism mirroring `fields[]`.
- Worklog / time-tracking.
- **Comment reactions** (emoji 👍) — the supported REST/token API doesn't expose them (only an
  internal cookie-auth endpoint incompatible with our auth, or DOM scraping). **Won't do**; documented
  as a structural blind spot in `get_comments`'s description + README. The honest out-of-band route is
  browser automation against the rendered UI (session auth) — a different tool. See issue 21.
- Attachment **read** (images + text) is IN v1.x (issue 16), and **PDF-as-extracted-text** shipped
  with it (issue 17). Attachment **upload** (path-source) is IN v1.x (issue 18). Deferred: attachment
  **URL-fetch upload** (clean fast-follow) and **office-doc text extraction** (docx/xlsx/pptx →
  metadata + can't-inline note for now). **Rejected (won't do):** base64-inline and context-image
  upload (architecturally unreachable — the model has no bytes for an image it only saw).
- @mentions in write bodies; watchers add/remove.
- Changelog/history exposure; `raw` get_issue level.
- Gated `dryRun` multi-hop transition auto-walk (single-step + path-hint covers it).
- Comment piggybacked on transition; JSM internal/public notes.
- OAuth 2.0 (start API-token, design for it).
