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
import { getFinishAutoFlowConfig, telegramCreds } from "./config";
import { sendTelegramNotify } from "./telegram";

interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string;
  escalationReason?: string;
}

type RunFn = (
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const PLUGIN_NAME = "nax-finish";
const PLUGIN_VERSION = "0.1.0";

/**
 * Default subprocess runner — wraps Bun.spawn with concurrent stdout/stderr
 * reads so non-trivial output does not deadlock. Tests override `_naxFinishDeps.run`.
 */
async function defaultRun(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
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
export const _naxFinishDeps: { run: RunFn; readResult: (workdir: string) => Promise<FinishResult | null> } = {
  run: defaultRun,
  readResult: defaultReadResult,
};

function isFeatureBranch(b: string): boolean {
  return b !== "main" && b !== "master" && b.length > 0;
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
      const flowPath = path.resolve(ctx.workdir, cfg.flowPath);

      // No `reviewers` field on the flow input — it was removed; profiles flow
      // to the flow module via env vars instead (see module header comment).
      const input = {
        feature: ctx.feature,
        workdir: ctx.workdir,
        branch: ctx.branch,
        prdPath: ctx.prdPath,
        escalateTelegram: cfg.escalate.telegram,
      };

      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (cfg.reviewers.spec) env.NAX_FINISH_SPEC_PROFILE = cfg.reviewers.spec;
      if (cfg.reviewers.quality) env.NAX_FINISH_QUALITY_PROFILE = cfg.reviewers.quality;

      const cmd = [
        "acpx",
        "--approve-all",
        ...(cfg.defaultAgent ? ["--default-agent", cfg.defaultAgent] : []),
        "flow",
        "run",
        flowPath,
        "--input-json",
        JSON.stringify(input),
      ];

      const res = await _naxFinishDeps.run(cmd, { cwd: ctx.workdir, env });
      const result = await _naxFinishDeps.readResult(ctx.workdir);
      if (!result) {
        return { success: res.exitCode === 0, message: `nax-finish flow exited ${res.exitCode} (no result file)` };
      }

      const creds = telegramCreds(ctx.config);
      if (result.status === "escalated" && cfg.escalate.telegram && creds) {
        await sendTelegramNotify(creds, `nax-finish escalated *${result.feature}*: ${result.escalationReason ?? ""}`);
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
