# ADR 0001 — zod `.describe()` renders in the emitted tool schema (SDK #1143)

Status: accepted
Date: 2026-06-25

## Context

The whole design leans on input-field description quality: the agent reads
`inputSchema.properties.<field>.description` to use each tool correctly. SDK
issue [#1143] reported that zod `.describe()` field descriptions sometimes do
not propagate into the JSON Schema the SDK emits to clients. The walking-skeleton
issue (01) required verifying this before building nine more tools on the pattern.

## Decision

Verified on the pinned versions — **`@modelcontextprotocol/sdk` 1.29.0 + `zod`
3.25.76** — that `.describe()` propagates correctly. A tool registered via
`server.registerTool(..., { inputSchema: <zod raw shape> }, ...)` emits each
field's `description`, plus `required`, `default`, and numeric bounds.

`#1143 does not bite on these versions. No workaround is needed.`

The convention going forward: define input schemas as a **zod raw shape**
(an object of zod types, not a wrapped `z.object`) and `.describe()` every field.

## Verification

`client.listTools()` over an in-memory transport issues the same `tools/list`
request MCP Inspector does, so its result is exactly what the Inspector shows.
This is asserted as a durable regression test in
`test/schema-descriptions.test.ts` — if a future SDK/zod bump regresses #1143,
that test fails. (The manual MCP Inspector check is therefore redundant but still
available: `bunx @modelcontextprotocol/inspector bun run src/index.ts`.)

## Consequences

- Pinning matters: a major SDK or zod bump must re-run the schema-descriptions
  test before being accepted.
- If a future version regresses, the fallback is to post-process the emitted
  schema (inject descriptions) in the tool registry, keeping the `.describe()`
  authoring convention unchanged.

[#1143]: https://github.com/modelcontextprotocol/typescript-sdk/issues/1143
