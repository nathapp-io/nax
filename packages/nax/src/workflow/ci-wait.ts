/**
 * CI wait (spec §7.1, P4-R4). Polls the branch's PR/MR checks until they are green,
 * one fails, or `timeoutMs` passes. A timeout or a CLI error is `pending`, never
 * `failed` (W-R9). `_ciWaitDeps` is the test seam (spawn, sleep, clock).
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

export type CiWaitOutcome = "green" | "failed" | "pending";

export interface CiWaitResult {
  readonly outcome: CiWaitOutcome;
  readonly detail: string;
}

/** How long the wait may go without an info line before it says it is still waiting (US-005). */
export const CI_WAIT_HEARTBEAT_MS = 60_000;

export const _ciWaitDeps = {
  run: (cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult> => defaultForgeDeps.run(cmd, opts),
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: (): number => Date.now(),
};

/** The run scope, first in every progress line's data (the logger convention; AC-23). */
const RUN_SCOPE = "_run";

/** The heartbeat's stand-in when no summary has been logged yet (a CLI error, no checks reported). */
const NO_SUMMARY = "no CI status yet";

type Poll =
  | { readonly state: "green" | "failed" | "waiting"; readonly summary?: string }
  | { readonly state: "error"; readonly detail: string };

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
  if (checks.some((c) => GH_FAILED.has(c.bucket))) return { state: "failed", summary };
  return checks.every((c) => GH_OK.has(c.bucket)) ? { state: "green", summary } : { state: "waiting", summary };
}

function classifyGlab(r: ForgeRunResult): Poll {
  if (r.exitCode !== 0) return cliError(r);
  const parsed = parseJson(r.stdout.trim());
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { state: "error", detail: `unparseable glab output: ${r.stdout.slice(0, 200)}` };
  }
  const pipeline = parsed.value.head_pipeline ?? parsed.value.pipeline;
  const status = isRecord(pipeline) && typeof pipeline.status === "string" ? pipeline.status : undefined;
  if (status === undefined) return { state: "waiting" };
  const summary = `CI pipeline: ${status}`;
  if (status === "success") return { state: "green", summary };
  return GL_FAILED.has(status) ? { state: "failed", summary } : { state: "waiting", summary };
}

function checksArgv(forge: ForgeKind, prRef: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "checks", prRef, "--json", "name,state,bucket"]
    : ["glab", "mr", "view", prRef, "--output", "json"];
}

async function pollOnce(forge: ForgeKind, prRef: string, cwd: string): Promise<Poll> {
  try {
    const r = await _ciWaitDeps.run(checksArgv(forge, prRef), { cwd });
    return forge === "github" ? classifyGh(r) : classifyGlab(r);
  } catch (err) {
    return { state: "error", detail: errorMessage(err) };
  }
}

interface ProgressLog {
  start(prRef: string, timeoutMs: number, pollMs: number): void;
  /** Logs a changed check summary; an unchanged poll says nothing (AC-10). */
  note(summary: string | undefined): void;
  /** A heartbeat once `CI_WAIT_HEARTBEAT_MS` have passed since the last info line. */
  heartbeatIfDue(startedAt: number): void;
  done(outcome: CiWaitOutcome, startedAt: number): void;
}

/** The wait's voice. Every line is `<message>` at info, stage `workflow`, `storyId` first. */
function progressLog(): ProgressLog {
  let lastInfoAt = _ciWaitDeps.now();
  let lastSummary = "";
  const say = (message: string): void => {
    lastInfoAt = _ciWaitDeps.now();
    getSafeLogger()?.info("workflow", message, { storyId: RUN_SCOPE });
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

export async function waitForChecks(
  forge: ForgeKind,
  prRef: string,
  opts: { readonly cwd: string; readonly timeoutMs: number; readonly pollMs: number; readonly signal?: AbortSignal },
): Promise<CiWaitResult> {
  const startedAt = _ciWaitDeps.now();
  const deadline = startedAt + opts.timeoutMs;
  const progress = progressLog();
  progress.start(prRef, opts.timeoutMs, opts.pollMs);
  /** Every terminal return, and only a terminal return, says how it ended. */
  const end = (outcome: CiWaitOutcome, detail: string): CiWaitResult => {
    progress.done(outcome, startedAt);
    return { outcome, detail };
  };
  for (;;) {
    if (opts.signal?.aborted) return end("pending", "aborted");
    const poll = await pollOnce(forge, prRef, opts.cwd);
    if (poll.state !== "error") progress.note(poll.summary);
    if (poll.state === "green") return end("green", "all checks passed");
    if (poll.state === "failed") return end("failed", "a check failed");
    if (poll.state === "error") {
      getSafeLogger()?.warn("workflow", "CI status unavailable — treated as pending", {
        storyId: RUN_SCOPE,
        forge,
        error: poll.detail,
      });
      return end("pending", `CI status unavailable: ${poll.detail}`);
    }
    if (_ciWaitDeps.now() + opts.pollMs > deadline) {
      return end("pending", `no CI result within ${opts.timeoutMs}ms`);
    }
    // Both sides of the sleep: `_ciWaitDeps.now` may move during a slow forge call or during the
    // wait itself, and the heartbeat has to hold either way (each `say` resets the clock).
    progress.heartbeatIfDue(startedAt);
    await _ciWaitDeps.sleep(opts.pollMs);
    progress.heartbeatIfDue(startedAt);
  }
}
