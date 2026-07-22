/**
 * Per-process curated-field resolution, memoized.
 *
 * The curated agile ids (Story Points, Sprint, Epic Link) vary per instance, so
 * they're detected from the field metadata rather than assumed (issue 13). That
 * detection costs one `GET /rest/api/3/field`, so it's cached for the process
 * lifetime exactly like the `/myself` auth preflight: success is memoized; a
 * failure is NOT cached (a later call can re-detect) but still returns a usable
 * fallback so a transient blip never bricks the read path.
 *
 * The read tool (`jira_get_issue`) consumes the resolved {@link ResolvedCuratedFields}
 * through {@link CuratedFieldsProvider}; tests inject either the live provider
 * (over the faked `JiraClient.listFields` seam) or {@link staticCuratedFieldsProvider}.
 */

import type { IJiraClient } from "./jira-client.ts";
import {
  buildCuratedFields,
  detectCuratedFieldIds,
  resolveCuratedFields,
  DEFAULT_CURATED_FIELD_IDS,
  type CuratedFieldDef,
  type CuratedFieldIds,
  type ResolvedCuratedFields,
} from "./custom-fields.ts";
import { log } from "../utils/logging.ts";

export interface CuratedFieldsProvider {
  /** Resolve (and memoize) the curated field set for this process. */
  get(): Promise<ResolvedCuratedFields>;
}

/**
 * A live provider that detects the curated ids from instance metadata once and
 * memoizes the result. `overrides` are the explicit `JIRA_FIELD_*` ids the
 * operator set (they win over detection — see {@link resolveCuratedFields}).
 */
export function createCuratedFieldsProvider(
  jira: Pick<IJiraClient, "listFields">,
  overrides: Partial<CuratedFieldIds>,
): CuratedFieldsProvider {
  let cached: ResolvedCuratedFields | null = null;
  let inflight: Promise<ResolvedCuratedFields> | null = null;

  return {
    get(): Promise<ResolvedCuratedFields> {
      if (cached) return Promise.resolve(cached);
      if (!inflight) {
        inflight = jira
          .listFields()
          .then((fields) => {
            const resolved = resolveCuratedFields(detectCuratedFieldIds(fields), overrides);
            cached = resolved;
            reportResolution(resolved);
            return resolved;
          })
          .catch((err) => {
            // Detection couldn't run: fall back to defaults (last resort) but do
            // NOT cache, so a later call retries — a transient failure shouldn't
            // permanently pin the wrong ids for the process.
            log.warn(
              "curated-field detection failed; falling back to cloud-default ids for this call",
              { error: err instanceof Error ? err.message : String(err) },
            );
            return resolveCuratedFields(null, overrides);
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

/** A provider that always returns a fixed set, reading no metadata (defaults / tests). */
export function staticCuratedFieldsProvider(curated: CuratedFieldDef[]): CuratedFieldsProvider {
  const resolved: ResolvedCuratedFields = { curated, omitted: [], sources: {} };
  return { get: () => Promise.resolve(resolved) };
}

/**
 * The fallback provider — the cloud-default curated ids, matching `get_issue`'s
 * default — used when a write tool was constructed without an injected provider.
 * Real deployments always inject the live per-instance provider.
 */
export const defaultCuratedFieldsProvider: CuratedFieldsProvider = staticCuratedFieldsProvider(
  buildCuratedFields(DEFAULT_CURATED_FIELD_IDS),
);

/**
 * The instance's detected Epic Link field id, or `undefined` when it could not
 * be detected and no override is set (the field is OMITTED). The WRITE path
 * (create/update parent on a company-managed project) routes through this so it
 * targets the same id the READ path uses, closing the read/write split issue 13
 * left — and degrades visibly rather than writing a guessed id (issue 15 A2).
 *
 * Accepts an optional provider so the two write tools share one default — when
 * omitted, the cloud-default provider is used.
 */
export async function resolveEpicLinkFieldId(
  provider: CuratedFieldsProvider = defaultCuratedFieldsProvider,
): Promise<string | undefined> {
  const { curated } = await provider.get();
  return curated.find((f) => f.friendlyName === "epicLink")?.fieldId;
}

/** Log resolved provenance once, and warn (visibly) about any omitted field. */
function reportResolution(resolved: ResolvedCuratedFields): void {
  log.info("curated agile fields resolved", {
    sources: resolved.sources,
    ids: Object.fromEntries(resolved.curated.map((f) => [f.friendlyName, f.fieldId])),
  });
  if (resolved.omitted.length > 0) {
    log.warn(
      "curated agile field(s) not detected and omitted from get_issue; set the matching " +
        "JIRA_FIELD_* env var to surface them",
      { omitted: resolved.omitted },
    );
  }
}
