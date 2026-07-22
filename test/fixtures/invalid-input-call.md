# Bug: create fails with INVALID_INPUT

The reporter's original `jira_create_issue` `description` that JIRA rejected
with a top-level `INVALID_INPUT`. Reconstructed from issue 20's recorded
evidence: the poison construct is **error `<p>`** — an inline code span nested
inside bold, which the converter emitted as a single text node carrying both
`strong` and `code` marks. The `<div>`/`<p>` tags and the `&&` operator the
reporter blamed convert fine; they must survive as plain text.

## Steps to reproduce

1. Open the editor with a `<div>` wrapper already present.
2. Type a guard like `if (a && b)` inside the block.
3. Save — the server logs **error `<p>`** and rolls back the change.

## Notes

The failing path renders as **error `<p>`** in the log. Compare the passing
case `if (x && y)`, which stays inside the `<section>` boundary. A `<p>`
without a matching `</p>` is what trips the **error `<p>`** guard above.
