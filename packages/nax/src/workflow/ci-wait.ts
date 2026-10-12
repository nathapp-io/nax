/**
 * CI wait (spec §7.1, P4-R4). Polls the branch's PR/MR checks until they are green,
 * one fails, or `timeoutMs` passes. A timeout or a CLI error is `pending`, never
 * `failed` (W-R9). `_ciWaitDeps` is the test seam (spawn, sleep, clock).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { defaultForgeDeps, type ForgeKind, type ForgeRunResult } from "@/forge";
import { getSafeLogger } from "@/logger";

export type CiWaitOutcome = "green" | "failed" | "pending";

export interface CiWaitResult {
  readonly outcome: CiWaitOutcome;
  readonly detail: string;
}

export const _ciWaitDeps = {
  run: (cmd: string[], opts: { cwd: string }): Promise<ForgeRunResult> => defaultForgeDeps.run(cmd, opts),
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: (): number => Date.now(),
};

type Poll = { readonly state: "green" | "failed" | "waiting" } | { readonly state: "error"; readonly detail: string };

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

function classifyGh(r: ForgeRunResult): Poll {
  const out = r.stdout.trim();
  if (out === "") return NO_CHECKS.test(r.stderr) ? { state: "waiting" } : cliError(r);
  const parsed = parseJson(out);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return { state: "error", detail: `unparseable gh output: ${out.slice(0, 200)}` };
  }
  const buckets = parsed.value.map((c) => (isRecord(c) && typeof c.bucket === "string" ? c.bucket : "pending"));
  if (buckets.length === 0) return { state: "waiting" };
  if (buckets.some((b) => GH_FAILED.has(b))) return { state: "failed" };
  return buckets.every((b) => GH_OK.has(b)) ? { state: "green" } : { state: "waiting" };
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
  if (status === "success") return { state: "green" };
  return GL_FAILED.has(status) ? { state: "failed" } : { state: "waiting" };
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

export async function waitForChecks(
  forge: ForgeKind,
  prRef: string,
  opts: { readonly cwd: string; readonly timeoutMs: number; readonly pollMs: number; readonly signal?: AbortSignal },
): Promise<CiWaitResult> {
  const deadline = _ciWaitDeps.now() + opts.timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return { outcome: "pending", detail: "aborted" };
    const poll = await pollOnce(forge, prRef, opts.cwd);
    if (poll.state === "green") return { outcome: "green", detail: "all checks passed" };
    if (poll.state === "failed") return { outcome: "failed", detail: "a check failed" };
    if (poll.state === "error") {
      getSafeLogger()?.warn("workflow", "CI status unavailable — treated as pending", {
        storyId: "_run",
        forge,
        error: poll.detail,
      });
      return { outcome: "pending", detail: `CI status unavailable: ${poll.detail}` };
    }
    if (_ciWaitDeps.now() + opts.pollMs > deadline) {
      return { outcome: "pending", detail: `no CI result within ${opts.timeoutMs}ms` };
    }
    await _ciWaitDeps.sleep(opts.pollMs);
  }
}
