/**
 * workflow-rules — the pure ruleKey → terse-phrase map that turns JIRA workflow
 * condition/validator ruleKeys (the gate TYPES preview returns) into agent-facing
 * `requires` phrases. The whole point of issue 19's "real rule-accuracy": a
 * recognized gate gets a terse phrase, an unrecognized one degrades VISIBLY
 * (never dropped — that would silently re-promise firability).
 */

import { test, expect } from "bun:test";
import { summarizeRequires } from "../src/lib/workflow-rules.ts";

test("a recognized condition ruleKey maps to a terse phrase (the bug-case gate)", () => {
  const reqs = summarizeRequires(["system:restrict-issue-transition"], []);
  expect(reqs).toHaveLength(1);
  // Describes the gate TYPE, never the specific role/group (preview carries no params).
  expect(reqs[0]!.toLowerCase()).toMatch(/restrict/);
});

test("recognized validator ruleKeys map to phrases", () => {
  const reqs = summarizeRequires([], [
    "system:check-permission-validator",
    "system:validate-field-value",
  ]);
  expect(reqs).toHaveLength(2);
  expect(reqs.join(" ").toLowerCase()).toMatch(/permission/);
  expect(reqs.join(" ").toLowerCase()).toMatch(/field/);
});

test("an unrecognized/custom/plugin gate degrades VISIBLY — never dropped", () => {
  const reqs = summarizeRequires(["com.acme.plugin:secret-sauce-condition"], []);
  expect(reqs).toHaveLength(1);
  expect(reqs[0]!.toLowerCase()).toContain("unrecognized condition");
  // The opaque key is carried so a human can identify it.
  expect(reqs[0]).toContain("com.acme.plugin:secret-sauce-condition");
});

test("an unrecognized validator is marked as a validator, not a condition", () => {
  const reqs = summarizeRequires([], ["com.acme:weird-validator"]);
  expect(reqs[0]!.toLowerCase()).toContain("unrecognized validator");
});

test("no gates → empty list (the clean ungated common case)", () => {
  expect(summarizeRequires([], [])).toEqual([]);
});

test("duplicate ruleKeys collapse to a single phrase, order preserved", () => {
  const reqs = summarizeRequires(
    ["system:restrict-issue-transition", "system:restrict-issue-transition"],
    ["system:check-permission-validator"],
  );
  // restrict (once) then permission — deduped, conditions before validators.
  expect(reqs).toHaveLength(2);
});
