/**
 * CI wait (spec §7.1, P4-R4). Polls the branch's PR/MR checks until they are green,
 * all settle, a conflict is detected, or `timeoutMs` passes. GitHub failures wait for unfinished
 * checks. A run of `CI_ERROR_POLL_LIMIT` unreadable polls preserves an observed failure; otherwise
 * it is `unavailable`. At the deadline the latest readable failing poll wins over errors.
 * A check-less timeout is `no-checks`; slow CI is `pending`, which blocks readiness
 * like every other non-green outcome (strict green, ruled 2026-10-21). `_ciWaitDeps` is the test
 * seam (spawn, sleep, clock).
 *
 * US-005 (nax#2526): the wait reports its own progress — a start line, a line whenever the check
 * summary changes, a heartbeat at least every `CI_WAIT_HEARTBEAT_MS`, and an end line — so a long
 * CI wait is no longer a silent gap between `final-gates green` and `publish draft <url>`. The
 * lines are `workflow`-tagged with `storyId: "_run"` first; with no logger installed they are
 * skipped and every result is exactly what it was.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { defaultForgeDeps, type ForgeKind, type ForgeRunResult } from "@/forge";
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";

export type CiWaitOutcome = "green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable";

export interface CiWaitResult {
  readonly outcome: CiWaitOutcome;
  readonly detail: string;
}

/**
 * US-003: the one CI rule. `green` is the only outcome that lets a PR be ready — a CI that is
 * still pending blocks too (strict green, ruled 2026-10-21). Every readiness decision asks this
 * one function, so the workflow's own publish and `nax workflow promote` cannot disagree about
 * whether CI is done (`nax bot fix` joins them in US-005).
 */
export function ciAllowsReady(outcome: CiWaitOutcome): boolean {
  return outcome === "green";
}

/** Consecutive unreadable polls (CLI error, spawn failure, unparseable output) that end the wait (nax#2550). */
export const CI_ERROR_POLL_LIMIT = 3;

/** How long the wait may go without an info line before it says it is still waiting (US-005). */
export const CI_WAIT_HEARTBEAT_MS = 60_000;

export const _ciWaitDeps = {
  run: (cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult> => defaultForgeDeps.run(cmd, opts),
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: (): number => Date.now(),
  /**
   * The wait's own clock, independent of polling and of any single sleep. It
   * fires `fn` every `ms` until the returned cancel runs, so a heartbeat still
   * lands while a slow forge call or a long poll interval is in flight (B3).
   */
  schedule: (fn: () => void, ms: number): (() => void) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/** The run scope, first in every progress line's data (the logger convention; AC-23). */
const RUN_SCOPE = "_run";

/** The heartbeat's stand-in when no summary has been logged yet (a CLI error, no checks reported). */
const NO_SUMMARY = "no CI status yet";

type Poll =
  | {
      readonly state: "green" | "failed" | "waiting";
      readonly summary?: string;
      /** GitHub failures with unfinished checks wait, but remain failed for one-shot reads. */
      readonly pending?: number;
      readonly failureDetail?: string;
      /** Every reported check with its bucket; only a one-shot read reports it (nax#2631). */
      readonly checks?: string;
      readonly sha?: string;
      readonly mismatch?: string;
    }
  | { readonly state: "error" | "conflicting" | "unavailable"; readonly detail: string };

const GH_FAILED = new Set(["fail", "cancel"]);
const GH_OK = new Set(["pass", "skipping"]);
const GL_FAILED = new Set(["failed", "canceled"]);
const NO_CHECKS = /no checks reported/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(stdout: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch {
    return { ok: false };
  }
}

function cliError(r: ForgeRunResult): Poll {
  return { state: "error", detail: r.stderr.trim() || `exit ${r.exitCode}` };
}

interface GhCheck {
  readonly name: string;
  readonly bucket: string;
}

function ghChecks(value: readonly unknown[]): GhCheck[] {
  return value.map((c) => ({
    name: isRecord(c) && typeof c.name === "string" ? c.name : "",
    bucket: isRecord(c) && typeof c.bucket === "string" ? c.bucket : "pending",
  }));
}

/** `3/15 passed, 12 pending`, plus the failing names — `passed` is the set `classifyGh` calls green. */
function ghSummary(checks: readonly GhCheck[]): string {
  const passed = checks.filter((c) => GH_OK.has(c.bucket)).length;
  const failed = checks.filter((c) => GH_FAILED.has(c.bucket));
  const pending = checks.length - passed - failed.length;
  const names = failed.map((c) => c.name).filter((n) => n !== "");
  const failing = names.length > 0 ? `, failing: ${names.join(", ")}` : "";
  return `${passed}/${checks.length} passed, ${pending} pending${failing}`;
}

function classifyGh(r: ForgeRunResult): Poll {
  const out = r.stdout.trim();
  if (out === "") return NO_CHECKS.test(r.stderr) ? { state: "waiting" } : cliError(r);
  const parsed = parseJson(out);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return { state: "error", detail: `unparseable gh output: ${out.slice(0, 200)}` };
  }
  const checks = ghChecks(parsed.value);
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
      pending,
      failureDetail: `CI failed: ${failed.map((c) => c.name).join(", ")}; ${pending} still pending`,
    };
  }
  return checks.every((c) => GH_OK.has(c.bucket))
    ? { state: "green", summary, checks: listed }
    : { state: "waiting", summary, checks: listed };
}

/** GitLab can expose the commit on either pipeline object. */
function glabPipelineSha(mr: Record<string, unknown>): string | undefined {
  const head = mr.head_pipeline;
  const fallback = mr.pipeline;
  const sha = (isRecord(head) ? head.sha : undefined) ?? (isRecord(fallback) ? fallback.sha : undefined);
  return typeof sha === "string" ? sha : undefined;
}

function classifyGlab(r: ForgeRunResult): Poll {
  if (r.exitCode !== 0) return cliError(r);
  const parsed = parseJson(r.stdout.trim());
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { state: "error", detail: `unparseable glab output: ${r.stdout.slice(0, 200)}` };
  }
  const pipeline = parsed.value.head_pipeline ?? parsed.value.pipeline;
  const status = isRecord(pipeline) && typeof pipeline.status === "string" ? pipeline.status : undefined;
  if (status === undefined) return glabWaiting(parsed.value);
  const summary = `CI pipeline: ${status}`;
  if (status === "manual" || status === "scheduled") {
    return { state: "unavailable", detail: `pipeline is waiting on a ${status} job` };
  }
  // A green pipeline does not make a conflicting MR mergeable.
  if (status === "success" || status === "skipped") {
    const waiting = glabWaiting(parsed.value, summary);
    const sha = glabPipelineSha(parsed.value);
    return waiting.state === "conflicting" ? waiting : { state: "green", summary, sha };
  }
  return GL_FAILED.has(status)
    ? { state: "failed", summary, sha: glabPipelineSha(parsed.value) }
    : glabWaiting(parsed.value, summary);
}

function conflictPoll(base: unknown): Poll {
  const target = typeof base === "string" && base !== "" ? base : "its base branch";
  return { state: "conflicting", detail: `PR has merge conflicts with ${target}` };
}

function glabWaiting(mr: Record<string, unknown>, summary?: string): Poll {
  return mr.has_conflicts === true || mr.detailed_merge_status === "conflict"
    ? conflictPoll(mr.target_branch)
    : { state: "waiting", summary };
}

/**
 * Waiting and green polls read GitHub mergeability: push-triggered checks run (and can pass) on a
 * conflicting PR, so reported checks do not rule a conflict out (nax#2550). A failed check keeps its
 * meaning. Auxiliary reads fail open silently, unlike failures of the main checks command.
 */
async function githubWaiting(poll: Poll, prRef: string, cwd: string): Promise<Poll> {
  if (poll.state !== "waiting" && poll.state !== "green") return poll;
  try {
    const r = await _ciWaitDeps.run(
      ["gh", "pr", "view", prRef, "--json", "mergeable,mergeStateStatus,baseRefName,headRefOid"],
      {
        cwd,
      },
    );
    if (r.exitCode !== 0) return poll;
    const parsed = parseJson(r.stdout);
    if (!parsed.ok || !isRecord(parsed.value)) return poll;
    const mr = parsed.value;
    if (mr.mergeable === "CONFLICTING" || mr.mergeStateStatus === "DIRTY") return conflictPoll(mr.baseRefName);
    return typeof mr.headRefOid === "string" ? { ...poll, sha: mr.headRefOid } : poll;
  } catch {
    return poll;
  }
}

function checksArgv(forge: ForgeKind, prRef: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "checks", prRef, "--json", "name,state,bucket"]
    : ["glab", "mr", "view", prRef, "--output", "json"];
}

async function pollOnce(forge: ForgeKind, prRef: string, cwd: string): Promise<Poll> {
  try {
    const r = await _ciWaitDeps.run(checksArgv(forge, prRef), { cwd });
    return forge === "github" ? await githubWaiting(classifyGh(r), prRef, cwd) : classifyGlab(r);
  } catch (err) {
    return { state: "error", detail: errorMessage(err) };
  }
}

interface ProgressLog {
  start(prRef: string, timeoutMs: number, pollMs: number): void;
  /** Logs a changed check summary; an unchanged poll says nothing (AC-10). */
  note(summary: string | undefined): void;
  /** How long since the last info line, so a wait can bound its slices. */
  sinceLastInfo(): number;
  /** A heartbeat once `CI_WAIT_HEARTBEAT_MS` have passed since the last info line. */
  heartbeatIfDue(startedAt: number): void;
  done(outcome: CiWaitOutcome, startedAt: number): void;
}

/** The wait's voice. Every line is `<message>` at info, stage `workflow`, `storyId` first. */
function progressLog(onInfo: () => void): ProgressLog {
  let lastInfoAt = _ciWaitDeps.now();
  let lastSummary = "";
  const say = (message: string): void => {
    lastInfoAt = _ciWaitDeps.now();
    getSafeLogger()?.info("workflow", message, { storyId: RUN_SCOPE });
    onInfo();
  };
  return {
    start(prRef, timeoutMs, pollMs) {
      say(`CI wait: ${prRef} (timeout ${timeoutMs}ms, poll ${pollMs}ms)`);
    },
    note(summary) {
      if (summary === undefined || summary === lastSummary) return;
      lastSummary = summary;
      say(summary);
    },
    sinceLastInfo() {
      return _ciWaitDeps.now() - lastInfoAt;
    },
    heartbeatIfDue(startedAt) {
      if (_ciWaitDeps.now() - lastInfoAt < CI_WAIT_HEARTBEAT_MS) return;
      say(
        `CI wait: still waiting after ${formatDuration(_ciWaitDeps.now() - startedAt)} (${lastSummary || NO_SUMMARY})`,
      );
    },
    done(outcome, startedAt) {
      say(`CI wait done: ${outcome} after ${formatDuration(_ciWaitDeps.now() - startedAt)}`);
    },
  };
}

/**
 * Wait out one polling interval without letting a heartbeat slip past the
 * interval bound: the wait is sliced so the next slice never runs longer than
 * the time left until a heartbeat is due. The slices sum to `ms`, so the
 * configured polling cadence is unchanged; only the progress reporting gained
 * an upper bound (B3).
 */
async function waitWithHeartbeat(ms: number, startedAt: number, progress: ProgressLog): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const untilBeat = Math.max(1, CI_WAIT_HEARTBEAT_MS - progress.sinceLastInfo());
    const slice = Math.min(remaining, untilBeat);
    await _ciWaitDeps.sleep(slice);
    remaining -= slice;
    // Each `say` resets the last-info clock; `startedAt` is untouched.
    progress.heartbeatIfDue(startedAt);
  }
}

/** Only a would-be green poll is held back; absent SHAs preserve the auxiliary read's fail-open contract. */
function bindToHead(poll: Poll, expectedSha?: string): Poll {
  if (poll.state !== "green" || !expectedSha || !poll.sha || poll.sha === expectedSha) return poll;
  return {
    ...poll,
    state: "waiting",
    mismatch: `checks report ${poll.sha.slice(0, 8)} but HEAD is ${expectedSha.slice(0, 8)}`,
  };
}

function terminalPoll(poll: Poll): CiWaitResult | undefined {
  if (poll.state === "unavailable") return { outcome: "unavailable", detail: poll.detail };
  if (poll.state === "green") return { outcome: "green", detail: "all checks passed" };
  if (poll.state === "failed" && !poll.pending) return { outcome: "failed", detail: "a check failed" };
  if (poll.state === "conflicting") {
    getSafeLogger()?.info("workflow", `CI wait: ${poll.detail} — CI cannot start`, { storyId: RUN_SCOPE });
    return { outcome: "conflicting", detail: poll.detail };
  }
  return undefined;
}

/**
 * The run of unreadable polls (nax#2550). One error is retried — a rate limit or network blip must
 * not end the wait — and any readable poll resets the run. `CI_ERROR_POLL_LIMIT` in a row, or a
 * deadline reached while the latest poll errored, supplies `unavailable`. The wait's check history
 * overrides that fallback when a failing poll was observed.
 */
function errorRun(forge: ForgeKind) {
  let consecutive = 0;
  let last: string | undefined;
  const unavailable = (detail: string): CiWaitResult => ({
    outcome: "unavailable",
    detail: `CI status unavailable: ${detail}`,
  });
  return {
    note(poll: Poll): CiWaitResult | undefined {
      if (poll.state !== "error") {
        consecutive = 0;
        last = undefined;
        return undefined;
      }
      consecutive += 1;
      last = poll.detail;
      getSafeLogger()?.warn("workflow", "CI status unavailable", {
        storyId: RUN_SCOPE,
        forge,
        error: poll.detail,
        attempt: consecutive,
        limit: CI_ERROR_POLL_LIMIT,
      });
      return consecutive >= CI_ERROR_POLL_LIMIT ? unavailable(poll.detail) : undefined;
    },
    timeout(): CiWaitResult | undefined {
      return last === undefined ? undefined : unavailable(last);
    },
  };
}

/** A summary exists exactly when this poll reported checks (GitHub) or a pipeline status (GitLab). */
function checkHistory() {
  let reported = false;
  let observedFailure: CiWaitResult | undefined;
  let latestFailure: CiWaitResult | undefined;
  return {
    note(poll: Poll) {
      if ("summary" in poll && poll.summary !== undefined) reported = true;
      if (poll.state === "error") return;
      latestFailure =
        poll.state === "failed" && poll.pending
          ? { outcome: "failed", detail: poll.failureDetail ?? "a check failed" }
          : undefined;
      observedFailure ??= latestFailure;
    },
    onErrorLimit(result: CiWaitResult | undefined): CiWaitResult | undefined {
      return result ? (observedFailure ?? result) : undefined;
    },
    failingTimeout(): CiWaitResult | undefined {
      return latestFailure;
    },
    timeout(timeoutMs: number): CiWaitResult {
      return reported
        ? { outcome: "pending", detail: `no CI result within ${timeoutMs}ms` }
        : { outcome: "no-checks", detail: `no CI check reported within ${formatDuration(timeoutMs)}` };
    },
  };
}

export async function waitForChecks(
  forge: ForgeKind,
  prRef: string,
  opts: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly pollMs: number;
    readonly signal?: AbortSignal;
    readonly expectedSha?: string;
  },
): Promise<CiWaitResult> {
  const startedAt = _ciWaitDeps.now();
  const deadline = startedAt + opts.timeoutMs;
  const history = checkHistory();
  const errors = errorRun(forge);
  let cancelHeartbeat = (): void => {};
  const progress = progressLog(() => {
    // Every info line starts a fresh deadline. A fixed interval could skip a
    // tick after a changed summary and leave almost two minutes of silence.
    cancelHeartbeat();
    cancelHeartbeat = _ciWaitDeps.schedule(() => progress.heartbeatIfDue(startedAt), CI_WAIT_HEARTBEAT_MS);
  });
  progress.start(prRef, opts.timeoutMs, opts.pollMs);
  /** Every terminal return, and only a terminal return, says how it ended. */
  const end = (outcome: CiWaitOutcome, detail: string): CiWaitResult => {
    progress.done(outcome, startedAt);
    return { outcome, detail };
  };
  // Independent of polling and of any single sleep: a slow forge call cannot
  // suppress the heartbeat, and the schedule is cancelled on every return path.
  try {
    for (;;) {
      if (opts.signal?.aborted) return end("pending", "aborted");
      const poll = bindToHead(await pollOnce(forge, prRef, opts.cwd), opts.expectedSha);
      history.note(poll);
      if ("summary" in poll) progress.note(poll.summary);
      const terminal = terminalPoll(poll) ?? history.onErrorLimit(errors.note(poll));
      if (terminal) return end(terminal.outcome, terminal.detail);
      if (_ciWaitDeps.now() + opts.pollMs > deadline) {
        if ("mismatch" in poll && poll.mismatch) return end("unavailable", poll.mismatch);
        const timeout = history.failingTimeout() ?? errors.timeout() ?? history.timeout(opts.timeoutMs);
        return end(timeout.outcome, timeout.detail);
      }
      // Both sides of the wait: `_ciWaitDeps.now` may move during a slow forge call or during the
      // wait itself, and the heartbeat has to hold either way (each `say` resets the clock).
      progress.heartbeatIfDue(startedAt);
      await waitWithHeartbeat(opts.pollMs, startedAt, progress);
      progress.heartbeatIfDue(startedAt);
    }
  } finally {
    cancelHeartbeat();
  }
}

/** The PR's current head, for a GitHub red read; `undefined` when it cannot be read (fail open, as green does). */
async function ghHeadSha(prRef: string, cwd: string): Promise<string | undefined> {
  try {
    const r = await _ciWaitDeps.run(["gh", "pr", "view", prRef, "--json", "headRefOid"], { cwd });
    const parsed = r.exitCode === 0 ? parseJson(r.stdout) : { ok: false as const };
    return parsed.ok && isRecord(parsed.value) && typeof parsed.value.headRefOid === "string"
      ? parsed.value.headRefOid
      : undefined;
  } catch {
    return undefined;
  }
}

function onceDetail(poll: { readonly summary?: string; readonly checks?: string }, fallback: string): string {
  const summary = poll.summary ?? fallback;
  return poll.checks ? `${summary}; checks: ${poll.checks}` : summary;
}

/**
 * One read of the PR's checks, never a wait and no progress lines (nax#2631): a caller judging one
 * exact head (bot review, a bot fix baseline) needs CI's verdict now, not CI's eventual one. Green
 * and red are both bound to `expectedSha`; checks for another head are `unavailable`, never this
 * head's verdict. The detail carries the check names, so a reader can tell what CI actually ran.
 */
export async function readChecksOnce(
  forge: ForgeKind,
  prRef: string,
  opts: { readonly cwd: string; readonly expectedSha: string },
): Promise<CiWaitResult> {
  const poll = await pollOnce(forge, prRef, opts.cwd);
  switch (poll.state) {
    case "error":
      return { outcome: "unavailable", detail: `CI status unavailable: ${poll.detail}` };
    case "unavailable":
    case "conflicting":
      return { outcome: poll.state, detail: poll.detail };
    case "waiting":
      return poll.summary === undefined
        ? { outcome: "no-checks", detail: "no CI check reported for this head yet" }
        : { outcome: "pending", detail: onceDetail(poll, "") };
    case "green":
      return verdictForHead(forge, prRef, opts, { ...poll, state: "green" });
    case "failed":
      return verdictForHead(forge, prRef, opts, { ...poll, state: "failed" });
  }
}

/** A green or red read is this head's verdict only when the checks report this head. */
async function verdictForHead(
  forge: ForgeKind,
  prRef: string,
  opts: { readonly cwd: string; readonly expectedSha: string },
  poll: {
    readonly state: "green" | "failed";
    readonly summary?: string;
    readonly checks?: string;
    readonly sha?: string;
  },
): Promise<CiWaitResult> {
  const sha = poll.sha ?? (forge === "github" ? await ghHeadSha(prRef, opts.cwd) : undefined);
  if (sha !== undefined && sha !== opts.expectedSha) {
    return {
      outcome: "unavailable",
      detail: `checks report ${sha.slice(0, 8)} but HEAD is ${opts.expectedSha.slice(0, 8)}`,
    };
  }
  return poll.state === "green"
    ? { outcome: "green", detail: onceDetail(poll, "all checks passed") }
    : { outcome: "failed", detail: onceDetail(poll, "a check failed") };
}
