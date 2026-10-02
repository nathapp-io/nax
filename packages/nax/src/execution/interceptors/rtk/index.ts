import type {
  CommandInterceptor,
  InterceptRequest,
  InterceptResult,
  ShellInterceptRequest,
  ShellInterceptResult,
} from "@nathapp/nax-agent/internal";
import { runArgv } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";

export interface InterceptorState {
  enabled: boolean;
  version: string | null;
  verbs: readonly string[];
  /** Opt-in Bash-site interception (US-002). Always present; false when unset. */
  bash: boolean;
}

/** The raw answer of one `rtk rewrite` call, before the interceptor interprets it. */
export interface RtkRewriteResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export interface RtkDeps {
  which(bin: string): string | null;
  version(): string | null;
  record(state: InterceptorState): void;
  rewrite(command: string, cwd: string): Promise<RtkRewriteResult>;
}

export interface RtkInterceptorOptions {
  enabled: boolean;
  verbs: readonly string[];
  /** Opt-in (R7): absent reads as false, so an argv-only caller is unchanged. */
  bash?: boolean;
  _deps?: Partial<RtkDeps>;
}

/** How long one `rtk rewrite` subprocess may run before it is killed. */
export const RTK_REWRITE_TIMEOUT_MS = 2000;

/**
 * The default implementation of `RtkDeps.rewrite`. Runs `["rtk", "rewrite",
 * command]` in `cwd` through the shared argv executor (`runArgv`), which
 * bounds the call with `RTK_REWRITE_TIMEOUT_MS`, SIGKILLs the whole process
 * group on timeout — so a hung `rtk`, or a descendant that inherited the
 * stdout pipe, cannot pin the caller past the bound — and drains
 * stdout/stderr concurrently (MEM-4 / BUG-13).
 *
 * On timeout the answer is `{ exitCode: -1, stdout: "", timedOut: true }`: the
 * raw exit code a signal-killed child reports is normalised away so the
 * provider only branches on `timedOut`. A spawn failure (e.g. ENOENT for
 * `rtk`) rejects; the provider's `interceptShell` maps that rejection to
 * `rtk rewrite failed: <message>`.
 */
export async function defaultRewrite(command: string, cwd: string): Promise<RtkRewriteResult> {
  const result = await runArgv({
    argv: ["rtk", "rewrite", command],
    cwd,
    timeoutMs: RTK_REWRITE_TIMEOUT_MS,
  });
  if (result.timedOut) return { exitCode: -1, stdout: "", timedOut: true };
  return { exitCode: result.exitCode, stdout: result.stdout, timedOut: false };
}

/** Resolve the provider binary via PATH. Exit code 0 + non-empty stdout is "found". */
function defaultWhich(bin: string): string | null {
  const res = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "ignore" });
  if (res.exitCode !== 0) return null;
  const out = res.stdout.toString().trim();
  return out === "" ? null : out;
}

/** Resolve the provider version. Non-zero exit or empty stdout degrades to null. */
function defaultVersion(): string | null {
  const res = Bun.spawnSync(["rtk", "--version"], { stdout: "pipe", stderr: "ignore" });
  if (res.exitCode !== 0) return null;
  const out = res.stdout.toString().trim();
  return out === "" ? null : out;
}

/**
 * One structured log line so a run with interception off is distinguishable
 * in its artifacts from a run that made no git calls, and a version change
 * between arms (spec H6) is visible after the fact rather than inferred.
 */
function defaultRecord(state: InterceptorState): void {
  const logger = getSafeLogger();
  if (logger === null) return;
  logger.info("execution", "rtk interceptor state", {
    enabled: state.enabled,
    version: state.version,
    verbs: state.verbs,
    bash: state.bash,
  });
}

/**
 * A trailing hint line rtk appends to the output it returns, e.g.
 * `[full diff: rtk git diff --no-compact]`, `[full output: rtk recall …]` or
 * `[+12 hidden: rtk recall …]` (spec US-005 item 1 names all three). A nax
 * agent has no shell, so these are instructions it cannot follow (R4); strip
 * them before the output reaches the agent.
 *
 * Stripping is hint-shaped, not a trim: output with no trailing hint is
 * returned byte-for-byte, trailing whitespace included — `trimEnd()` at the
 * call site is the only thing allowed to do that.
 */
const RTK_HINT_LINE = /\n?\[(?:full diff: rtk |full output: rtk |\+\d+ hidden: rtk )[^\]]*\]\s*$/;

type Mode =
  | { readonly kind: "disabled" }
  | { readonly kind: "active" }
  | { readonly kind: "declined"; readonly reason: string };

export function createRtkInterceptor(opts: RtkInterceptorOptions): CommandInterceptor {
  const { enabled, verbs, bash } = opts;
  const deps: RtkDeps = {
    which: opts._deps?.which ?? defaultWhich,
    version: opts._deps?.version ?? defaultVersion,
    record: opts._deps?.record ?? defaultRecord,
    rewrite: opts._deps?.rewrite ?? defaultRewrite,
  };

  let mode: Mode;
  let version: string | null = null;
  if (enabled) {
    try {
      const bin = deps.which("rtk");
      if (bin === null) {
        mode = { kind: "declined", reason: "rtk binary not found on PATH" };
      } else {
        version = deps.version();
        mode = { kind: "active" };
      }
    } catch (err) {
      mode = {
        kind: "declined",
        reason: err instanceof Error ? `rtk probe failed: ${err.message}` : "rtk probe failed",
      };
    }
  } else {
    mode = { kind: "disabled" };
  }
  deps.record({ enabled, version, verbs, bash: bash ?? false });

  return {
    provider: "rtk",
    async intercept(req: InterceptRequest): Promise<InterceptResult> {
      if (mode.kind === "disabled") return { kind: "unchanged" };
      if (mode.kind === "declined") return { kind: "declined", reason: mode.reason };
      const verb = req.argv[1];
      if (verb === undefined || !verbs.includes(verb)) return { kind: "unchanged" };
      return { kind: "rewritten", argv: ["rtk", ...req.argv], provider: "rtk" };
    },
    /**
     * The Bash site's rewrite decision table. Runs the provider's `rewrite`,
     * then interprets its raw answer per the AC7-AC15 contract:
     *
     *   1. timedOut: true → declined "rtk rewrite timed out"
     *   2. exit 0 or 3 with trimmed non-empty stdout that DIFFERS from the
     *      original command → rewritten, command = trimmed stdout, provider = "rtk"
     *   3. exit 0 or 3 with empty/identical/whitespace-only stdout → unchanged
     *   4. exit 1 → unchanged (per AC9; the rest of 1/0/3 stays in (2)/(3))
     *   5. any other exit code (including 2) → declined "rtk rewrite exited <code>"
     *
     * Falls through to "unchanged" before any rewrite happens when the master
     * switch is off (AC17) or the bash site was not opted in (AC16); falls
     * through to "declined" with the probe's reason when the binary was
     * missing (AC18) or the probe threw (AC19). A rejecting `deps.rewrite`
     * (e.g. ENOENT for `rtk`) maps to "rtk rewrite failed: <message>" (AC15).
     *
     * Runs in the nax process on the host, never inside the sandbox: see
     * scope-of-US-002 in the story.
     */
    async interceptShell(req: ShellInterceptRequest): Promise<ShellInterceptResult> {
      if (mode.kind === "disabled") return { kind: "unchanged" };
      if (mode.kind === "declined") return { kind: "declined", reason: mode.reason };
      if (!bash) return { kind: "unchanged" };

      let result: RtkRewriteResult;
      try {
        result = await deps.rewrite(req.command, req.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "declined", reason: `rtk rewrite failed: ${message}` };
      }

      if (result.timedOut) return { kind: "declined", reason: "rtk rewrite timed out" };

      const candidate = result.stdout.trim();
      if ((result.exitCode === 0 || result.exitCode === 3) && candidate !== "" && candidate !== req.command) {
        return { kind: "rewritten", command: candidate, provider: "rtk" };
      }
      if (result.exitCode === 0 || result.exitCode === 3 || result.exitCode === 1) {
        return { kind: "unchanged" };
      }
      return { kind: "declined", reason: `rtk rewrite exited ${result.exitCode}` };
    },
    postProcess(output: string): { output: string } {
      return { output: output.replace(RTK_HINT_LINE, "") };
    },
  };
}
