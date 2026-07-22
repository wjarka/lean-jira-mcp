/**
 * Shared field-builder.
 *
 * Assembles JIRA's native write payload — `fields` for plain "set this value"
 * and `update` for add/remove/set operations on multi-value fields — out of the
 * resolved inputs a write tool collects. This is a shared `lib/` primitive:
 * `jira_create_issue` (this slice) uses the set side; `jira_update_issue` (05)
 * reuses it for presence-aware partial updates and `addLabels`/`removeLabels`
 * deltas; `jira_transition` (06) reuses it to attach screen fields. Keeping the
 * payload shape in one place means every write tool emits an identical
 * `{ fields, update }` envelope.
 *
 * It is intentionally dumb: callers decide *what* to set (the resolver turns
 * human references into the values); the builder only routes set-vs-op and
 * drops empty halves so a payload never carries `fields: {}` or `update: {}`.
 */

import type { JiraWritePayload } from "./jira-client.ts";

export type UpdateOperation = "add" | "remove" | "set";

export class IssueFieldsBuilder {
  private readonly fields: Record<string, unknown> = {};
  private readonly update: Record<string, Array<Record<string, unknown>>> = {};

  /** Set a field outright (the create case, and update's set-ops). */
  set(fieldId: string, value: unknown): this {
    this.fields[fieldId] = value;
    return this;
  }

  /**
   * Presence-aware set: `undefined` means "field absent, leave it" and is
   * skipped; `null` means "explicit clear" and is preserved (JIRA clears a
   * field set to null). This is the semantic update (05) needs.
   */
  setIfPresent(fieldId: string, value: unknown): this {
    if (value !== undefined) this.fields[fieldId] = value;
    return this;
  }

  /** Queue an add/remove/set operation under `update` (multi-value deltas). */
  op(fieldId: string, operation: UpdateOperation, value: unknown): this {
    (this.update[fieldId] ??= []).push({ [operation]: value });
    return this;
  }

  build(): JiraWritePayload {
    const payload: JiraWritePayload = {};
    if (Object.keys(this.fields).length > 0) payload.fields = this.fields;
    if (Object.keys(this.update).length > 0) payload.update = this.update;
    return payload;
  }
}
