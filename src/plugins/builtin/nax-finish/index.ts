/**
 * nax-finish Plugin — Built-in Post-Run Action
 *
 * After a successful run on a feature branch, shells out to `acpx flow run`
 * to drive the nax-finish flow (acceptance -> review -> gates -> PR) to
 * completion. Reads `ctx.config.finish.autoFlow` for opt-in config, forwards
 * spec/quality reviewer profiles to the flow module via env vars (the flow
 * module reloads fresh on every `acpx flow run` invocation, so profiles are
 * read at module-load time rather than passed as flow input), and notifies
 * via Telegram when the flow escalates.
 *
 * Note: the flow contract types below (`FinishResult`, `RunFn`) are declared
 * locally rather than imported from `flows/nax-finish/` — `src/` must never
 * import from `flows/`, which is a separate, non-source-tree module.
 *
 * Fail-open: a failed finish flow never fails the run. The post-run driver
 * swallows thrown exceptions and logs `{ success: false }` as a non-blocking
 * warning.
 */

import * as path from "node:path";
import type { IPostRunAction, NaxPlugin, PluginLogger, PostRunActionResult, PostRunContext } from "@/plugins/types";
import { type FinishAutoFlowSettings, getFinishAutoFlowConfig, telegramCreds } from "./config";
import { sendTelegramNotify } from "./telegram";

interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string;
  escalationReason?: string;
}

type RunFn = (
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const PLUGIN_NAME = "nax-finish";
const PLUGIN_VERSION = "0.1.0";

/** How far up from this module to look for the nax package root (`src/…` in dev, `dist/` when built). */
const PACKAGE_ROOT_SEARCH_DEPTH = 6;

/**
 * How much of the flow's stderr to inline in the failure message.
 *
 * The message goes to the run's exit summary, so it has to stay short — but it
 * must carry *something*. Reporting only the exit code (the previous behaviour)
 * made a hard flow crash indistinguishable from a clean failure: a
 * `ReferenceError: Bun is not defined` on the flow's first node was reported as
 * a bare "exited 1 (no result file)" with the real cause discarded. The full
 * output still goes to the logger below.
 */
const STDERR_TAIL_CHARS = 400;

/** Last `STDERR_TAIL_CHARS` of the flow's stderr, whitespace-collapsed for one-line log output. */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const tail = trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
  return tail.replace(/\s+/g, " ");
}

/**
 * Default subprocess runner — wraps Bun.spawn with concurrent stdout/stderr
 * reads so non-trivial output does not deadlock, under a wall-clock cap so a
 * wedged flow cannot hang the run's completion phase forever.
 * Tests override `_naxFinishDeps.run`.
 */
async function defaultRun(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  // setTimeout (not Bun.sleep) because the handle must be cancelled the moment
  // the process exits — the documented exception in forbidden-patterns.md.
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return timedOut
      ? {
          exitCode: exitCode === 0 ? 124 : exitCode,
          stdout,
          stderr: `${stderr}\n[nax-finish] flow killed after ${opts.timeoutMs}ms timeout`,
        }
      : { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default result reader — reads the flow's terminal result off disk. */
async function defaultReadResult(workdir: string): Promise<FinishResult | null> {
  const f = Bun.file(path.join(workdir, ".nax", "nax-finish-result.json"));
  if (!(await f.exists())) return null;
  return JSON.parse(await f.text()) as FinishResult;
}

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on the
 * exported object to inject fakes without `mock.module()`.
 */
export const _naxFinishDeps: {
  run: RunFn;
  readResult: (workdir: string) => Promise<FinishResult | null>;
  /** Path-existence probe — used to resolve the flow module and the nax package root. */
  exists: (p: string) => Promise<boolean>;
  /** Directory this module was loaded from; overridable so package-root walking is testable. */
  moduleDir: string;
  /**
   * Escalation notifier. Routed through `_deps` (rather than called as a direct
   * import) because `telegramCreds` falls back to ambient `TELEGRAM_BOT_TOKEN` /
   * `NAX_TELEGRAM_CHAT_ID` env vars — so a test that stubs only `run`/`readResult`
   * and returns an "escalated" status would otherwise send a REAL Telegram
   * message to whoever is running the suite. Tests must override this.
   */
  notify: typeof sendTelegramNotify;
} = {
  run: defaultRun,
  readResult: defaultReadResult,
  exists: (p) => Bun.file(p).exists(),
  moduleDir: import.meta.dir,
  notify: sendTelegramNotify,
};

function isFeatureBranch(b: string): boolean {
  return b !== "main" && b !== "master" && b.length > 0;
}

/**
 * Resolve the flow module.
 *
 * `flows/` ships with nax, not with the user's repo, so a relative `flowPath`
 * resolves against the **nax package root** first (walking up from this module:
 * `src/plugins/builtin/nax-finish` in dev, `dist/` when bundled) and only then
 * against the repo, which lets a repo vendor its own variant. Absolute paths
 * are taken as-is. Returns null when nothing exists — the caller reports that
 * rather than handing acpx a path it will fail to open.
 */
export async function resolveFlowPath(
  workdir: string,
  flowPath: string,
  deps: Pick<typeof _naxFinishDeps, "exists" | "moduleDir"> = _naxFinishDeps,
): Promise<string | null> {
  if (path.isAbsolute(flowPath)) {
    return (await deps.exists(flowPath)) ? flowPath : null;
  }
  const candidates: string[] = [];
  let dir = deps.moduleDir;
  for (let i = 0; i < PACKAGE_ROOT_SEARCH_DEPTH; i += 1) {
    dir = path.dirname(dir);
    if (await deps.exists(path.join(dir, "package.json"))) candidates.push(path.resolve(dir, flowPath));
  }
  candidates.push(path.resolve(workdir, flowPath));
  for (const candidate of candidates) {
    if (await deps.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the `acpx flow run` argv.
 *
 * Flag placement is not interchangeable:
 * - `--approve-all` and `--timeout` are **top-level** flags and must precede
 *   `flow`. The flow declares `requireExplicitGrant`, so acpx rejects the run
 *   unless the grant is an explicit CLI flag (config alone does not satisfy it).
 * - `--default-agent` is an option of the `flow run` **subcommand**, so it must
 *   come after the flow file; placing it before `flow` makes acpx exit with
 *   "unknown option '--default-agent'".
 */
export function buildFlowArgv(
  flowPath: string,
  inputJson: string,
  defaultAgent: string | null,
  stepMs?: number | null,
): string[] {
  const stepTimeout = stepMs && stepMs > 0 ? ["--timeout", String(Math.ceil(stepMs / 1000))] : [];
  return [
    "acpx",
    "--approve-all",
    ...stepTimeout,
    "flow",
    "run",
    flowPath,
    "--input-json",
    inputJson,
    ...(defaultAgent ? ["--default-agent", defaultAgent] : []),
  ];
}

function buildFlowEnv(cfg: FinishAutoFlowSettings): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (cfg.reviewers.spec) env.NAX_FINISH_SPEC_PROFILE = cfg.reviewers.spec;
  if (cfg.reviewers.quality) env.NAX_FINISH_QUALITY_PROFILE = cfg.reviewers.quality;
  return env;
}

const naxFinishAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description:
    "Autonomously finishes a feature (acceptance -> review -> gates -> PR) via an acpx flow after a successful run",

  async shouldRun(ctx: PostRunContext): Promise<boolean> {
    const cfg = getFinishAutoFlowConfig(ctx);
    if (!cfg.enabled) return false;

    const s = ctx.storySummary;
    if (s.completed === 0 || s.failed > 0 || s.paused > 0) return false;

    return isFeatureBranch(ctx.branch);
  },

  async execute(ctx: PostRunContext): Promise<PostRunActionResult> {
    try {
      const cfg = getFinishAutoFlowConfig(ctx);
      const flowPath = await resolveFlowPath(ctx.workdir, cfg.flowPath);
      if (!flowPath) {
        return {
          success: false,
          message: `nax-finish: flow module "${cfg.flowPath}" not found in the nax install or ${ctx.workdir}`,
        };
      }

      const creds = telegramCreds(ctx.config);
      // Telegram is the escalation channel only when it is both enabled AND
      // credentialed; otherwise the flow falls back to a PR/MR comment. It has
      // to know which, so it doesn't do both (or open a draft it won't need).
      const escalateTelegram = cfg.escalate.telegram && creds !== null;

      // No `reviewers` field on the flow input — profiles flow to the flow
      // module via env vars instead (see module header comment).
      const input = {
        feature: ctx.feature,
        workdir: ctx.workdir,
        branch: ctx.branch,
        prdPath: ctx.prdPath,
        escalateTelegram,
        timeouts: { acceptanceMs: cfg.timeouts.acceptanceMs, gateMs: cfg.timeouts.gateMs },
      };

      const cmd = buildFlowArgv(flowPath, JSON.stringify(input), cfg.defaultAgent, cfg.timeouts.stepMs);
      const res = await _naxFinishDeps.run(cmd, {
        cwd: ctx.workdir,
        env: buildFlowEnv(cfg),
        timeoutMs: cfg.timeouts.flowMs,
      });
      const result = await _naxFinishDeps.readResult(ctx.workdir);
      if (!result) {
        // The flow produced no result file, so its stdout/stderr is the only
        // evidence of what went wrong — log it in full before it is dropped.
        ctx.logger.warn("nax-finish flow produced no result file", {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        });
        const tail = stderrTail(res.stderr);
        return {
          success: res.exitCode === 0,
          message: `nax-finish flow exited ${res.exitCode} (no result file)${tail ? `: ${tail}` : ""}`,
        };
      }

      if (result.status === "escalated" && escalateTelegram && creds) {
        await _naxFinishDeps.notify(
          creds,
          `nax-finish escalated *${result.feature}*: ${result.escalationReason ?? ""}`,
        );
      }

      return { success: true, message: `nax-finish: ${result.status}`, url: result.url };
    } catch (err) {
      ctx.logger.warn("nax-finish execute failed", { error: String(err) });
      return { success: false, message: `nax-finish failed: ${String(err)}` };
    }
  },
};

/**
 * Built-in nax-finish plugin.
 */
export const naxFinishPlugin: NaxPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  provides: ["post-run-action"],

  async setup(_config: Record<string, unknown>, _logger: PluginLogger): Promise<void> {
    // No initialization required
  },

  async teardown(): Promise<void> {
    // No cleanup required
  },

  extensions: {
    postRunAction: naxFinishAction,
  },
};
