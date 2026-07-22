/**
 * Direct unit tests for the shared field-builder.
 *
 * The builder assembles JIRA's native `{ fields, update }` write payload and is
 * reused by create (set-only) and update (set + add/remove ops). These tests
 * pin the contract both depend on: set vs op routing, op accumulation,
 * presence-aware setting, and that empty halves are omitted.
 */

import { test, expect } from "bun:test";
import { IssueFieldsBuilder } from "../src/lib/issue-field-builder.ts";

test("set values go under `fields`", () => {
  const payload = new IssueFieldsBuilder()
    .set("summary", "Hello")
    .set("project", { key: "ABC" })
    .build();
  expect(payload).toEqual({ fields: { summary: "Hello", project: { key: "ABC" } } });
});

test("ops go under `update` and accumulate per field", () => {
  const payload = new IssueFieldsBuilder()
    .op("labels", "add", "x")
    .op("labels", "remove", "y")
    .build();
  expect(payload).toEqual({ update: { labels: [{ add: "x" }, { remove: "y" }] } });
});

test("set and op coexist in one payload", () => {
  const payload = new IssueFieldsBuilder()
    .set("summary", "Hello")
    .op("labels", "add", "x")
    .build();
  expect(payload).toEqual({ fields: { summary: "Hello" }, update: { labels: [{ add: "x" }] } });
});

test("an empty builder produces an empty payload (no empty fields/update keys)", () => {
  expect(new IssueFieldsBuilder().build()).toEqual({});
});

test("setIfPresent skips undefined but keeps an explicit null (clear)", () => {
  const payload = new IssueFieldsBuilder()
    .setIfPresent("assignee", undefined)
    .setIfPresent("priority", null)
    .build();
  expect(payload).toEqual({ fields: { priority: null } });
});
