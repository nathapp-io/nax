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
import { viewArgv } from "@/forge";
import type { ForgeDeps, ForgeKind } from "@/forge";
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
  /**
   * The PR/MR this context already knows about, when one stood the run down:
   * the ledger's recorded url on the `already-finished` route (#1674 part 1),
   * or the merged PR's url on the `nothing-to-finish` route (#1674 part 2).
   * Absent on every route that has no such PR.
   */
  prUrl?: string;
  /**
   * Set only by the closed-PR escalation below: `ops.escalate` must NOT run
   * its usual `commitAndPush` for this one.
   *
   * That push is unconditional (`commit.ts`'s `commitAndPush` pushes whether
   * or not anything was committed), and `git push --set-upstream` against a
   * branch whose closed PR had its head branch auto-deleted RECREATES it —
   * undoing the cleanup the human's close performed. Nothing has run at this
   * point either, so there are no partial fixes the push could be carrying.
   */
  escalateWithoutPush?: boolean;
  /**
   * Why a `nothing-to-finish` route is a *skip* rather than a plain
   * zero-commits preflight. Only `"pr-merged"` (#1674 part 2) is set here —
   * the `already-finished` route carries its own reason in `route` itself,
   * and the machine stamps that skipReason from the route.
   */
  skipReason?: "pr-merged";
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
  /**
   * Forge access for the merged/closed short-circuit (#1674 part 2). Omit it,
   * or pass a null `kind`, and that check never fires — every caller that
   * predates it keeps the pre-#1674-part-2 behaviour of routing on the commit
   * count alone.
   */
  forge?: { kind: ForgeKind | null; deps: ForgeDeps };
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

/** What the branch's existing PR/MR is, when it is no longer open. */
type ClosedPrState = { state: "merged" | "closed"; url?: string };

/**
 * Read the branch's PR/MR and report it only when it is merged or closed
 * (#1674 part 2).
 *
 * Returns `null` — "carry on as normal" — for every other answer, and that is
 * the whole design: no PR yet, an open PR, an unauthenticated `gh`, a forge
 * outage, a JSON schema this does not recognise and a `kind` of `null` are
 * indistinguishable to a caller that only knows the run must not be dropped
 * on a guess. A false negative costs one redundant finish run, which is
 * exactly today's behaviour; a false positive would abandon a branch that
 * still had real work to finish.
 *
 * `viewArgv` (`@/forge`) supplies the argv so this shares the field list
 * shape with `openOrPromotePr`'s view call. GitHub's `state` is upper-case
 * (`OPEN` / `CLOSED` / `MERGED`) and GitLab's is lower-case (`opened` /
 * `closed` / `merged`, with `locked` also possible), so the comparison is
 * case-folded rather than forked per forge. GitLab additionally reports a
 * merged MR as `state: "merged"`, so `mergedAt`/`merged_at` is only a
 * fallback for a schema that reports the timestamp without the state.
 */
async function checkPrState(
  workdir: string,
  branch: string,
  forge: { kind: ForgeKind | null; deps: ForgeDeps },
): Promise<ClosedPrState | null> {
  const { kind, deps } = forge;
  if (kind === null) return null;

  let res: Awaited<ReturnType<ForgeDeps["run"]>>;
  try {
    res = await deps.run(viewArgv(kind, branch, "state,mergedAt,url"), { cwd: workdir });
  } catch {
    return null;
  }
  if (res.exitCode !== 0) return null;

  // CRITICAL (post-review): the shape check is NOT redundant with the catch.
  // `JSON.parse("null")` SUCCEEDS and returns `null`, so the catch never
  // fires and the first property read below throws a TypeError — out of
  // `loadFinishContext`, which runs *before* the state machine and so is
  // outside its outer catch. That aborts the whole finish phase (no PR, no
  // escalation, a bare "could not run" log): the exact opposite of the
  // fail-open this function promises, on an input a forge CLI or an API
  // wrapper can legitimately print for "no result".
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const view = parsed as Record<string, unknown>;
  const url = typeof view.url === "string" ? view.url : typeof view.web_url === "string" ? view.web_url : undefined;
  const state = typeof view.state === "string" ? view.state.toLowerCase() : "";
  const mergedAt = view.mergedAt ?? view.merged_at;

  if (state === "merged" || (state === "closed" && typeof mergedAt === "string" && mergedAt !== "")) {
    return { state: "merged", ...(url ? { url } : {}) };
  }
  if (state === "closed") return { state: "closed", ...(url ? { url } : {}) };
  return null;
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
        ...(ledger.prUrl ? { prUrl: ledger.prUrl } : {}),
      };
    }
  }

  // #1674 part 2. Ordered after the ledger check because that one is local
  // (a file read plus `git rev-parse`) while this one is a forge round trip,
  // and both stand the same run down.
  if (pre.route === "proceed" && ledgerOpts?.forge) {
    const pr = await checkPrState(workdir, ledgerOpts.branch, ledgerOpts.forge);
    if (pr?.state === "merged") {
      // Every step after this writes to a PR that no longer accepts work:
      // the reviewers would diff commits already on the base branch, the fix
      // loop would commit onto a merged branch, and the terminal step would
      // rewrite the merged PR's title and body. There is nothing left to
      // finish, so this is a `nothing-to-finish` — flagged `pr-merged` so a
      // reader of status.json can tell it from a zero-commit branch.
      return {
        base,
        specPath: resolved.specSource.path,
        acceptanceStatus,
        groups,
        testFileRegex,
        commitsAhead: pre.commitsAhead,
        route: "nothing-to-finish",
        skipReason: "pr-merged",
        reason: `The PR/MR for "${ledgerOpts.branch}" is already merged — nothing left to finish.`,
        ...(pr.url ? { prUrl: pr.url } : {}),
      };
    }
    if (pr?.state === "closed") {
      // Deliberately NOT `nothing-to-finish`. A closed-unmerged PR means a
      // human rejected or abandoned this branch while its commits still
      // exist: silently reporting success would hide that, and reopening or
      // re-pushing is not a decision an automated fix loop gets to make.
      // Escalating hands it to the person who closed it. The ledger (#1674
      // part 1) records the escalation against this HEAD, so a re-run at the
      // same commit pages them once, not once per run.
      return {
        base,
        specPath: resolved.specSource.path,
        acceptanceStatus,
        groups,
        testFileRegex,
        commitsAhead: pre.commitsAhead,
        route: "escalate",
        escalateWithoutPush: true,
        reason: `The PR/MR for "${ledgerOpts.branch}" is closed without being merged${pr.url ? ` (${pr.url})` : ""}, but the branch still has ${pre.commitsAhead} commit(s) ahead of "${base}". nax-finish will not reopen it or push to it — a human needs to decide whether this branch is still wanted.`,
        ...(pr.url ? { prUrl: pr.url } : {}),
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
