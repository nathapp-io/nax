/**
 * Shared check-list classification for the CI wait: used by the `gh pr checks` path in
 * `ci-wait.ts` and the commit check-runs path in `ci-wait-commit.ts`. Type-only imports from
 * `ci-wait.ts` keep the import graph acyclic.
 */
import type { ForgeRunResult } from "@/forge";
import type { GhCheck, Poll } from "./ci-wait";

export const GH_FAILED = new Set(["fail", "cancel"]);
export const GH_OK = new Set(["pass", "skipping"]);

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJson(stdout: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch {
    return { ok: false };
  }
}

export function cliError(r: ForgeRunResult): Poll {
  return { state: "error", detail: r.stderr.trim() || `exit ${r.exitCode}` };
}

/** `3/15 passed, 12 pending`, plus the failing names — `passed` is the set `classifyChecks` calls green. */
function ghSummary(checks: readonly GhCheck[]): string {
  const passed = checks.filter((c) => GH_OK.has(c.bucket)).length;
  const failed = checks.filter((c) => GH_FAILED.has(c.bucket));
  const pending = checks.length - passed - failed.length;
  const names = failed.map((c) => c.name).filter((n) => n !== "");
  const failing = names.length > 0 ? `, failing: ${names.join(", ")}` : "";
  return `${passed}/${checks.length} passed, ${pending} pending${failing}`;
}

/** Classify a parsed check list into a poll; an empty list is a summary-less waiting poll. */
export function classifyChecks(checks: readonly GhCheck[]): Poll {
  if (checks.length === 0) return { state: "waiting" };
  const summary = `CI checks: ${ghSummary(checks)}`;
  const listed = checks.map((c) => `${c.name} (${c.bucket})`).join(", ");
  const failed = checks.filter((c) => GH_FAILED.has(c.bucket));
  if (failed.length > 0) {
    const pending = checks.filter((c) => !GH_FAILED.has(c.bucket) && !GH_OK.has(c.bucket)).length;
    return {
      state: "failed",
      summary,
      checks: listed,
      ghChecks: checks,
      pending,
      failureDetail: `CI failed: ${failed.map((c) => c.name).join(", ")}; ${pending} still pending`,
    };
  }
  return checks.every((c) => GH_OK.has(c.bucket))
    ? { state: "green", summary, checks: listed, ghChecks: checks }
    : { state: "waiting", summary, checks: listed, ghChecks: checks };
}
