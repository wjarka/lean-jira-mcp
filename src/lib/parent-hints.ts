/**
 * Shared parent-attach hint shaping for `jira_create_issue` and
 * `jira_update_issue`.
 *
 * Both write tools attach a parent the same way — team-managed via the native
 * `parent` field, company-managed via the detected Epic Link id — and degrade
 * the same way when that id can't be detected (issue 15 A2). Keeping the wording
 * here means the two tools can't drift and neither has to import the other.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { shapeError } from "./response-shaper.ts";

/** A company-managed parent write blocked because the Epic Link id is undetectable. */
export function epicLinkUnavailableResult(
  parentKey: string,
  noun: "created" | "changed",
): CallToolResult {
  return shapeError(
    {
      message: `Cannot attach parent ${parentKey}: the Epic Link field id could not be detected for this instance.`,
      code: "epic_link_unavailable",
    },
    [
      `Parent ${parentKey} attaches via the Epic Link field on this company-managed project, but ` +
        "that field wasn't detected and no JIRA_FIELD_EPIC_LINK override is set — writing a guessed " +
        `id would target the wrong field. Set JIRA_FIELD_EPIC_LINK and retry. Nothing was ${noun}.`,
    ],
  );
}
