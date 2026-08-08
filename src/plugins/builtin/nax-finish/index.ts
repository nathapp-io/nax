/**
 * nax-finish Plugin — Built-in Post-Run Action
 *
 * After a successful run on a feature branch, shells out to `acpx flow run`
 * to drive the nax-finish flow (acceptance -> review -> gates -> PR) to
 * completion. Reads `ctx.config.finish.autoFlow` for opt-in config, forwards
 * spec/quality reviewer profiles to the flow module via env vars (the flow
 * module reloads fresh on every `acpx flow run` invocation, so profiles are
 * read at module-load time rather than passed as flow input), and notifies
 * terminal outcomes according to `finish.autoFlow.notify.mode`.
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
import { errorMessage } from "@/utils/errors";
import { type FinishAutoFlowSettings, getFinishAutoFlowConfig, telegramCreds } from "./config";
import { logTail, stderrTail } from "./output";
import { buildEscalationMessage, buildTerminalMessage, sendTelegramNotify } from "./telegram";

interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string;
  escalationReason?: string;
  /** Findings behind an escalation — named in the notification, not just counted. */
  findings?: { severity: string; title: string }[];
  /** Set by the flow when it could not deliver the escalation to its channel. */
  deliveryError?: string;
  /** Every fix round the flow ran — recorded on all terminal statuses, not just escalations. */
  rounds?: { phase: string; attempt: number; committed: boolean }[];
}

type TelegramCreds = NonNullable<ReturnType<typeof telegramCreds>>;

interface FinishTerminalOutcome {
  actionResult: PostRunActionResult;
  result?: FinishResult;
  escalateTelegram: boolean;
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

/**
 * Where this feature's finish-audit artifacts live.
 *
 * `<outputDir>/finish-audit/<feature>/`, i.e. `~/.nax/<project>/finish-audit/`
 * — the same per-project, per-feature shape as `prompt-audit/` and
 * `review-audit/`, resolved from the run's own `outputDir` so a configured
 * `config.outputDir` override is honoured. The artifact records a *run*, not
 * the source tree, so the repo was never the right home for it.
 *
 * `outputDir` is optional on `PostRunContext` for backward compatibility; a
 * context without it falls back to the repo, which is where the artifact used
 * to live. The flow applies the same fallback, so both sides agree.
 */
export function finishAuditDir(ctx: Pick<PostRunContext, "outputDir" | "workdir" | "feature">): string {
  const root = ctx.outputDir ?? path.join(ctx.workdir, ".nax");
  return path.join(root, "finish-audit", ctx.feature);
}

/** The terminal result file for one run, named the way prompt-audit names its runs. */
export function finishResultPath(
  ctx: Pick<PostRunContext, "outputDir" | "workdir" | "feature">,
  runId: string,
): string {
  return path.join(finishAuditDir(ctx), `${runId}.result.json`);
}

/** Default result reader — reads the flow's terminal result off disk. */
async function defaultReadResult(resultPath: string): Promise<FinishResult | null> {
  const f = Bun.file(resultPath);
  if (!(await f.exists())) return null;
  return JSON.parse(await f.text()) as FinishResult;
}

/**
 * Remove any terminal artifact left at this run's path before starting a flow.
 *
 * The path is run-scoped, so a stale file can only exist when the same run id
 * is finished twice (a resume). Clearing keeps the "no result file" branch
 * honest in that case — without it, a flow that died before writing would be
 * reported using the previous attempt's outcome.
 */
async function defaultClearResult(resultPath: string): Promise<void> {
  const file = Bun.file(resultPath);
  if (await file.exists()) await file.delete();
}

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on the
 * exported object to inject fakes without `mock.module()`.
 */
export const _naxFinishDeps: {
  run: RunFn;
  readResult: (resultPath: string) => Promise<FinishResult | null>;
  clearResult: (resultPath: string) => Promise<void>;
  /** Path-existence probe — used to resolve the flow module and the nax package root. */
  exists: (p: string) => Promise<boolean>;
  /** Directory this module was loaded from; overridable so package-root walking is testable. */
  moduleDir: string;
  /**
   * Terminal-outcome notifier. Routed through `_deps` (rather than called as a direct
   * import) because `telegramCreds` falls back to ambient `TELEGRAM_BOT_TOKEN` /
   * `NAX_TELEGRAM_CHAT_ID` env vars — so a test that stubs only `run`/`readResult`
   * and returns an "escalated" status would otherwise send a REAL Telegram
   * message to whoever is running the suite. Tests must override this.
   */
  notify: typeof sendTelegramNotify;
} = {
  run: defaultRun,
  readResult: defaultReadResult,
  clearResult: defaultClearResult,
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
 * - `--approve-all`, `--timeout` and `--model` are **top-level** flags and must
 *   precede `flow`. The flow declares `requireExplicitGrant`, so acpx rejects
 *   the run unless the grant is an explicit CLI flag (config alone does not
 *   satisfy it).
 * - `--default-agent` is an option of the `flow run` **subcommand**, so it must
 *   come after the flow file; placing it before `flow` makes acpx exit with
 *   "unknown option '--default-agent'".
 *
 * `--model` is a *floor*, not an override: acpx resolves each node's model as
 * `node.model ?? agent.model ?? --model`, so it reaches only nodes whose agent
 * entry pins no model — the `fix_*` nodes, never a profile-pinned reviewer.
 */
export function buildFlowArgv(
  flowPath: string,
  inputJson: string,
  opts: { defaultAgent?: string | null; stepMs?: number | null; model?: string | null } = {},
): string[] {
  const stepTimeout = opts.stepMs && opts.stepMs > 0 ? ["--timeout", String(Math.ceil(opts.stepMs / 1000))] : [];
  return [
    "acpx",
    "--approve-all",
    ...stepTimeout,
    ...(opts.model ? ["--model", opts.model] : []),
    "flow",
    "run",
    flowPath,
    "--input-json",
    inputJson,
    ...(opts.defaultAgent ? ["--default-agent", opts.defaultAgent] : []),
  ];
}

function buildFlowEnv(cfg: FinishAutoFlowSettings): Record<string, string> {
  // Strip these before spreading the rest of `process.env`: this very process
  // may itself have been launched by an outer nax-finish flow, and an
  // unconfigured reviewer must not let that ambient value leak into the child.
  const {
    NAX_FINISH_SPEC_PROFILE: _spec,
    NAX_FINISH_QUALITY_PROFILE: _quality,
    NAX_FINISH_NARRATIVE_PROFILE: _narrative,
    ...rest
  } = process.env;
  const env: Record<string, string> = { ...rest } as Record<string, string>;
  if (cfg.reviewers.spec) env.NAX_FINISH_SPEC_PROFILE = cfg.reviewers.spec;
  if (cfg.reviewers.quality) env.NAX_FINISH_QUALITY_PROFILE = cfg.reviewers.quality;
  if (cfg.reviewers.narrative) env.NAX_FINISH_NARRATIVE_PROFILE = cfg.reviewers.narrative;
  // Only the disabled case is signalled. An unset var means enabled, so a flow
  // invoked directly by `acpx flow run` still narrates.
  if (!cfg.narrative) env.NAX_FINISH_NARRATIVE = "0";
  return env;
}

interface ExecuteFinishOptions {
  ctx: PostRunContext;
  cfg: FinishAutoFlowSettings;
  creds: TelegramCreds | null;
  escalateTelegram: boolean;
}

function missingResultOutcome(
  ctx: PostRunContext,
  res: { exitCode: number; stdout: string; stderr: string },
  escalateTelegram: boolean,
): FinishTerminalOutcome {
  ctx.logger.warn("nax-finish flow produced no result file", {
    exitCode: res.exitCode,
    stdout: logTail(res.stdout),
    stderr: logTail(res.stderr),
  });
  const tail = stderrTail(res.stderr);
  return {
    actionResult: {
      success: false,
      message: `nax-finish flow exited ${res.exitCode} (no result file)${tail ? `: ${tail}` : ""}`,
    },
    escalateTelegram,
  };
}

async function executeFinishFlow(options: ExecuteFinishOptions): Promise<FinishTerminalOutcome> {
  const { ctx, cfg, escalateTelegram } = options;
  const flowPath = await resolveFlowPath(ctx.workdir, cfg.flowPath);
  if (!flowPath) {
    return {
      actionResult: {
        success: false,
        message: `nax-finish: flow module "${cfg.flowPath}" not found in the nax install or ${ctx.workdir}`,
      },
      escalateTelegram,
    };
  }

  const resultPath = finishResultPath(ctx, ctx.runId);
  await _naxFinishDeps.clearResult(resultPath);
  const input = {
    feature: ctx.feature,
    workdir: ctx.workdir,
    branch: ctx.branch,
    prdPath: ctx.prdPath,
    // The flow cannot import nax's path SSOT (`src/runtime/paths.ts`) — it runs
    // inside acpx's process — so the audit location is resolved here and passed in.
    auditDir: finishAuditDir(ctx),
    runId: ctx.runId,
    escalateTelegram,
    timeouts: { acceptanceMs: cfg.timeouts.acceptanceMs, gateMs: cfg.timeouts.gateMs },
    prBody: { template: cfg.prBody.template, sectionMap: cfg.prBody.sectionMap },
  };
  const cmd = buildFlowArgv(flowPath, JSON.stringify(input), {
    defaultAgent: cfg.defaultAgent,
    stepMs: cfg.timeouts.stepMs,
    model: cfg.model,
  });
  const res = await _naxFinishDeps.run(cmd, {
    cwd: ctx.workdir,
    env: buildFlowEnv(cfg),
    timeoutMs: cfg.timeouts.flowMs,
  });
  const result = await _naxFinishDeps.readResult(resultPath);
  if (!result) return missingResultOutcome(ctx, res, escalateTelegram);
  return {
    actionResult: { success: true, message: `nax-finish: ${result.status}`, url: result.url },
    result,
    escalateTelegram,
  };
}

async function settleFinishFlow(
  options: Omit<ExecuteFinishOptions, "escalateTelegram">,
): Promise<FinishTerminalOutcome> {
  const escalateTelegram = options.cfg.notify.mode !== "off" && options.cfg.escalate.telegram && options.creds !== null;
  try {
    return await executeFinishFlow({ ...options, escalateTelegram });
  } catch (error) {
    options.ctx.logger.warn("nax-finish execute failed", { error: errorMessage(error) });
    return {
      actionResult: { success: false, message: `nax-finish failed: ${errorMessage(error)}` },
      escalateTelegram,
    };
  }
}

async function notifyBestEffort(ctx: PostRunContext, creds: TelegramCreds | null, message: string): Promise<void> {
  if (!creds) {
    ctx.logger.warn("nax-finish terminal notification skipped: Telegram credentials are unavailable");
    return;
  }
  try {
    if (!(await _naxFinishDeps.notify(creds, message))) {
      ctx.logger.warn("nax-finish terminal notification was rejected", { feature: ctx.feature });
    }
  } catch (error) {
    ctx.logger.warn("nax-finish terminal notification failed", { feature: ctx.feature, error: errorMessage(error) });
  }
}

async function finalizeEscalation(
  ctx: PostRunContext,
  outcome: FinishTerminalOutcome,
  creds: TelegramCreds | null,
): Promise<PostRunActionResult> {
  const result = outcome.result;
  if (!result) return outcome.actionResult;
  const problems: string[] = [];
  let delivered = !outcome.escalateTelegram && !result.deliveryError;
  if (outcome.escalateTelegram && creds) {
    try {
      delivered = await _naxFinishDeps.notify(
        creds,
        buildEscalationMessage(result.feature, result.escalationReason ?? "", result.findings ?? []),
      );
      if (!delivered) problems.push("Telegram rejected the message");
    } catch (error) {
      problems.push(`Telegram failed: ${errorMessage(error)}`);
    }
  }
  if (delivered) return outcome.actionResult;
  if (result.deliveryError) problems.push(`the flow could not post it: ${result.deliveryError}`);
  if (problems.length === 0) problems.push("no escalation channel was reachable");
  ctx.logger.warn("nax-finish escalation was not delivered", {
    feature: result.feature,
    reasons: problems,
    escalationReason: result.escalationReason,
  });
  return {
    success: false,
    message: `nax-finish: escalated but undelivered — ${problems.join("; ")}`,
    url: result.url,
  };
}

async function finalizeFinishOutcome(
  options: Omit<ExecuteFinishOptions, "escalateTelegram"> & { outcome: FinishTerminalOutcome },
): Promise<PostRunActionResult> {
  const { ctx, cfg, creds, outcome } = options;
  if (outcome.result?.status === "escalated") return finalizeEscalation(ctx, outcome, creds);
  if (cfg.notify.mode === "always") {
    const status = outcome.result?.status ?? "failed";
    const detail = outcome.result ? undefined : outcome.actionResult.message;
    await notifyBestEffort(
      ctx,
      creds,
      buildTerminalMessage({ feature: ctx.feature, status, detail, url: outcome.actionResult.url }),
    );
  }
  return outcome.actionResult;
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
    const cfg = getFinishAutoFlowConfig(ctx);
    const creds = telegramCreds(ctx.config);
    const outcome = await settleFinishFlow({ ctx, cfg, creds });
    return finalizeFinishOutcome({ ctx, cfg, creds, outcome });
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
