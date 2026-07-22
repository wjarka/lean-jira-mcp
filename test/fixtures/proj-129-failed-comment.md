⚠️ Grooming note on PROJ-129

The reporter's `jira_comment` `body` that JIRA rejected with `INVALID_INPUT`
(surfaced as `jira_http_400`). Reconstructed from issue 20's recorded evidence:
the only ADF anomalies are TWO `code`+`strong` nodes on `error` (from the
**`error`** spans below). The `⚠️` emoji, the `→` arrow, and the `—` em dash
were wrongly blamed — they must survive as valid text nodes.

The flex layout flips the wrong way — the container throws **`error`** when the
axis is unset. Concretely the alignment goes `items-end → items-start` on the
first render, then the console shows **`error`** again on resize.

Recommended default — swap the axis before mount and the `→` transition settles.
