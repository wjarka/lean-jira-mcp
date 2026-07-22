/**
 * workflow-rules — map JIRA workflow condition/validator **ruleKeys** to terse,
 * human-readable `requires` phrases for `describe_project` and `jira_transition`.
 *
 * Issue 19's "real rule-accuracy, not relabeling": the workflow PREVIEW read
 * carries, per transition, the gate TYPES (`ruleKey`) — but NOT their parameters
 * (which role, which field, which value). So every phrase here describes the gate
 * *type* ("restricted to specific users/roles/groups"), and NEVER claims a
 * specific role/field/value we don't have. This is also why neither tool asserts
 * *which* gate blocked a transition: we know the type, not the per-issue verdict.
 *
 * The hard rule: an unrecognized/custom/plugin gate is NEVER dropped. Dropping it
 * would silently re-promise firability (the edge would read as ungated). It
 * degrades to a VISIBLE marker carrying the opaque key instead.
 */

/** Recognized CONDITION ruleKeys → terse phrase (gate TYPE only). */
const CONDITION_PHRASES: Record<string, string> = {
  "system:restrict-issue-transition": "restricted to specific users/groups/roles",
  "system:parent-or-child-status-condition": "depends on parent/sub-task status",
  "system:previous-status-condition": "requires a specific previously-visited status",
  "system:permission-condition": "requires a specific permission",
  "system:separation-of-duties": "must be a different user than a previous transition",
  "system:sub-task-blocking-condition": "blocked until sub-tasks reach a required status",
  "system:block-in-progress-reopen": "blocked while the issue is in progress",
};

/** Recognized VALIDATOR ruleKeys → terse phrase (gate TYPE only). */
const VALIDATOR_PHRASES: Record<string, string> = {
  "system:check-permission-validator": "requires a specific permission",
  "system:validate-field-value": "a field value must satisfy a rule",
  "system:fields-required": "certain fields must be set",
  "system:parent-status-validator": "parent issue must be in a required status",
  "system:previous-status-validator": "requires a specific previously-visited status",
  "system:field-changed-validator": "a specific field must be changed",
  "system:field-has-single-value-validator": "a field must have a single value",
};

/**
 * Turn condition + validator ruleKeys into terse `requires` phrases. Conditions
 * are summarized before validators; duplicate ruleKeys collapse to one phrase
 * (order of first appearance preserved). An unrecognized key on either side
 * becomes a visible `unrecognized condition|validator (<key>)` marker.
 */
export function summarizeRequires(
  conditionKeys: string[],
  validatorKeys: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (phrase: string) => {
    if (!seen.has(phrase)) {
      seen.add(phrase);
      out.push(phrase);
    }
  };
  for (const key of conditionKeys) {
    push(CONDITION_PHRASES[key] ?? `unrecognized condition (${key})`);
  }
  for (const key of validatorKeys) {
    push(VALIDATOR_PHRASES[key] ?? `unrecognized validator (${key})`);
  }
  return out;
}
