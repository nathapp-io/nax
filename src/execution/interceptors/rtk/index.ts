import type { CommandInterceptor, InterceptRequest, InterceptResult } from "@/execution/command-interceptor";
import { getSafeLogger } from "@/logger";

export interface InterceptorState {
  enabled: boolean;
  version: string | null;
  verbs: readonly string[];
}

export interface RtkDeps {
  which(bin: string): string | null;
  version(): string | null;
  record(state: InterceptorState): void;
}

export interface RtkInterceptorOptions {
  enabled: boolean;
  verbs: readonly string[];
  _deps?: Partial<RtkDeps>;
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
  });
}

/**
 * A trailing hint line rtk appends to the output it returns, e.g.
 * `[full diff: rtk git diff --no-compact]` or `[+12 hidden: rtk recall …]`.
 * A nax agent has no shell, so these are instructions it cannot follow (R4);
 * strip them before the output reaches the agent.
 *
 * Stripping is hint-shaped, not a trim: output with no trailing hint is
 * returned byte-for-byte, trailing whitespace included — `trimEnd()` at the
 * call site is the only thing allowed to do that.
 */
const RTK_HINT_LINE = /\n?\[(?:full diff: rtk |\+\d+ hidden: rtk )[^\]]*\]\s*$/;

type Mode =
  | { readonly kind: "disabled" }
  | { readonly kind: "active" }
  | { readonly kind: "declined"; readonly reason: string };

export function createRtkInterceptor(opts: RtkInterceptorOptions): CommandInterceptor {
  const { enabled, verbs } = opts;
  const deps: RtkDeps = {
    which: opts._deps?.which ?? defaultWhich,
    version: opts._deps?.version ?? defaultVersion,
    record: opts._deps?.record ?? defaultRecord,
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
  deps.record({ enabled, version, verbs });

  return {
    provider: "rtk",
    async intercept(req: InterceptRequest): Promise<InterceptResult> {
      if (mode.kind === "disabled") return { kind: "unchanged" };
      if (mode.kind === "declined") return { kind: "declined", reason: mode.reason };
      const verb = req.argv[1];
      if (verb === undefined || !verbs.includes(verb)) return { kind: "unchanged" };
      return { kind: "rewritten", argv: ["rtk", ...req.argv], provider: "rtk" };
    },
    postProcess(output: string): { output: string } {
      return { output: output.replace(RTK_HINT_LINE, "") };
    },
  };
}
