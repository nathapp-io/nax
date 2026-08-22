/**
 * In-process context load for `nax finish`.
 *
 * Replaces `load_ctx`, which shelled `nax features resolve --json` and
 * re-parsed its output (`flows/nax-finish/steps/context.ts`, read-only
 * reference — `flows/` is a separate module system and is never imported from
 * `src/`). In-process the resolver is a direct call, so the JSON contract, the
 * `FINISH_RESOLVE_UNPARSEABLE` error and `toAcceptanceStatus`'s degrade-to-
 * `no-prd` narrowing all disappear — there is nothing left to narrow.
 *
 * One call, not three: `resolveFeatureSpec` already returns `acceptance`
 * (from `resolveFeatureAcceptance`) and `testPatterns` on an `ok` result
 * (`src/cli/features-resolve.ts:205-212`). Calling those resolvers separately
 * would run acceptance resolution twice and lose the "resolve once" property
 * `load_ctx`'s header comment exists to state.
 */
import { resolveFeatureSpec } from "@/cli";
import type { AcceptanceGroupResult, AcceptanceResolutionStatus } from "@/cli";
import { errorMessage } from "@/utils/errors";
import { gitWithTimeout } from "@/utils/git";
import { readLedger } from "./audit";

export const _finishContextDeps = {
  git: gitWithTimeout,
  resolveFeatureSpec,
};

export interface FinishContext {
  base: string;
  specPath: string;
  acceptanceStatus: AcceptanceResolutionStatus;
  groups: AcceptanceGroupResult[];
  /** Regex sources from the ADR-009 SSOT. Empty means "cannot classify", never "nothing is a test". */
  testFileRegex: string[];
  commitsAhead: number;
  route: "proceed" | "nothing-to-finish" | "escalate" | "already-finished";
  reason?: string;
  /** Set only when `route` is `"already-finished"`: the ledger's recorded PR url, if it has one. */
  ledgerPrUrl?: string;
}

/**
 * Inputs to the finish-ledger entry check (#1674 part 1). Optional on
 * `loadFinishContext` — every caller that omits it (including every test
 * predating the ledger) gets the pre-ledger behaviour: `route` never becomes
 * `"already-finished"`.
 */
export interface LoadFinishContextOptions {
  /** The current branch, compared against the ledger's recorded one. */
  branch: string;
  /** `<outputDir>/finish-audit/<feature>` — where `last.json` would live. */
  auditDir: string;
  /** `finish.rerun`; `"always"` skips the ledger check entirely. */
  rerun: "on-change" | "always";
}

const LEDGER_TERMINAL_STATUSES = new Set(["opened", "promoted", "already-ready", "escalated"]);

/**
 * The entry check itself: does the ledger already cover this exact commit?
 *
 * Fails open at every step — a missing/corrupt ledger (`readLedger` already
 * returns `null` for both), a branch mismatch, a non-terminal recorded
 * status, or a `git rev-parse HEAD` that errors all return `null`, which
 * `loadFinishContext` reads as "check did not fire, proceed as normal". A
 * false negative here just means finish re-does one run's worth of
 * unnecessary work (today's behaviour); a false positive would silently drop
 * a run that genuinely had something to finish, which is the wrong side to
 * fail on.
 */
async function checkLedger(workdir: string, opts: LoadFinishContextOptions) {
  const ledger = await readLedger(opts.auditDir);
  if (!ledger) return null;
  if (ledger.branch !== opts.branch) return null;
  if (!LEDGER_TERMINAL_STATUSES.has(ledger.status)) return null;

  const head = await _finishContextDeps.git(["rev-parse", "HEAD"], workdir);
  if (head.exitCode !== 0) return null;
  const sha = head.stdout.trim();
  if (!sha || sha !== ledger.headSha) return null;

  return ledger;
}

/**
 * Which branch the reviewers diff against and the PR targets.
 *
 * Ported verbatim from `detectBaseBranch` in
 * `flows/nax-finish/steps/context.ts`: `git remote show origin`, matching
 * `HEAD branch:`, falling back to verifying `origin/main` exists, then
 * `origin/master` unverified. That last resort is exactly why the rev-list
 * preflight below must never trust a zero blindly — a repo whose base ref
 * isn't fetched locally reaches `preflight` with an unverified `base`.
 */
async function detectBaseBranch(workdir: string): Promise<string> {
  const res = await _finishContextDeps.git(["remote", "show", "origin"], workdir);
  const m = res.stdout.match(/HEAD branch:\s*(\S+)/);
  if (m) return `origin/${m[1]}`;
  const main = await _finishContextDeps.git(["rev-parse", "--verify", "origin/main"], workdir);
  return main.exitCode === 0 ? "origin/main" : "origin/master";
}

interface Preflight {
  commitsAhead: number;
  route: "proceed" | "nothing-to-finish" | "escalate";
  reason?: string;
}

/**
 * How far ahead of `base` this branch is.
 *
 * A failed count must never be reported as zero. `base` may be the unverified
 * `origin/master` last resort from `detectBaseBranch`, so a repo whose base
 * ref is not fetched locally makes `rev-list` exit non-zero with empty
 * stdout. Treating that as `Number.parseInt("") || 0` would be
 * indistinguishable from "this branch has no new commits" — reporting
 * `nothing-to-finish` having verified, reviewed and pushed nothing. Both the
 * non-zero exit and unreadable output escalate instead: a human can fetch the
 * base, and no fix node can. Only a cleanly parsed finite count may return
 * `nothing-to-finish`.
 */
async function preflight(workdir: string, base: string): Promise<Preflight> {
  const res = await _finishContextDeps.git(["rev-list", "--count", `${base}..HEAD`], workdir);
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`;
    return {
      commitsAhead: 0,
      route: "escalate",
      reason: `Could not count commits against "${base}" — git rev-list failed: ${detail}. The base branch may not exist locally; nax-finish will not treat that as "nothing to finish".`,
    };
  }
  const commitsAhead = Number.parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(commitsAhead)) {
    return {
      commitsAhead: 0,
      route: "escalate",
      reason: `git rev-list --count ${base}..HEAD exited 0 but printed no readable count: "${res.stdout.trim()}".`,
    };
  }
  return { commitsAhead, route: commitsAhead > 0 ? "proceed" : "nothing-to-finish" };
}

/**
 * Resolves the finish base branch, feature spec, acceptance targets and
 * test-file classification patterns, then preflights the commit count against
 * base to decide whether there is anything to finish.
 *
 * `resolveFeatureSpec` is wrapped in try/catch: unlike `resolveFeatureAcceptance`,
 * which is documented never to throw, `resolveFeatureSpec` has no internal
 * catch and `validateFeatureName` throws on an invalid feature name
 * (`features-resolve.ts:200`). Context load runs before the state machine, so
 * its outer catch is not in play yet — a throw here becomes `route: "escalate"`,
 * not an unhandled rejection in the post-run phase.
 */
export async function loadFinishContext(
  feature: string,
  workdir: string,
  ledgerOpts?: LoadFinishContextOptions,
): Promise<FinishContext> {
  const base = await detectBaseBranch(workdir);

  let resolved: Awaited<ReturnType<typeof resolveFeatureSpec>>;
  try {
    resolved = await _finishContextDeps.resolveFeatureSpec(feature, workdir);
  } catch (err) {
    return {
      base,
      specPath: "",
      acceptanceStatus: "no-prd",
      groups: [],
      testFileRegex: [],
      commitsAhead: 0,
      route: "escalate",
      reason: `Failed to resolve feature "${feature}": ${errorMessage(err)}`,
    };
  }

  if (!resolved.specSource) {
    const checked = resolved.checked ?? [];
    return {
      base,
      specPath: "",
      acceptanceStatus: "no-prd",
      groups: [],
      testFileRegex: [],
      commitsAhead: 0,
      route: "escalate",
      reason: `No spec found for feature "${feature}" — checked: ${checked.join(", ") || "(no candidates)"}.`,
    };
  }

  const acceptanceStatus: AcceptanceResolutionStatus = resolved.acceptance?.status ?? "no-prd";
  const groups: AcceptanceGroupResult[] = resolved.acceptance?.groups ?? [];
  const testFileRegex: string[] = resolved.testPatterns?.regex ?? [];

  const pre = await preflight(workdir, base);

  if (pre.route === "proceed" && ledgerOpts && ledgerOpts.rerun !== "always") {
    const ledger = await checkLedger(workdir, ledgerOpts);
    if (ledger) {
      return {
        base,
        specPath: resolved.specSource.path,
        acceptanceStatus,
        groups,
        testFileRegex,
        commitsAhead: pre.commitsAhead,
        route: "already-finished",
        reason: `Already finished at ${ledger.headSha} on "${ledger.branch}" (status: "${ledger.status}") — nothing has changed since.`,
        ...(ledger.prUrl ? { ledgerPrUrl: ledger.prUrl } : {}),
      };
    }
  }

  return {
    base,
    specPath: resolved.specSource.path,
    acceptanceStatus,
    groups,
    testFileRegex,
    commitsAhead: pre.commitsAhead,
    route: pre.route,
    ...(pre.reason ? { reason: pre.reason } : {}),
  };
}
