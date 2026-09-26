/**
 * Dispatch ask wiring — the P2 ask resolver and the P5 command shadow that every
 * Bash-dispatching `CallContext` carries (#2201).
 *
 * `bashApproval: gated | escalate` answers an `ask` verdict through
 * `CallContext.askResolver`, and the command-safety shadow classifies commands
 * through `CallContext.commandShadow`. The tool runtime falls back to
 * `headlessAskResolver()` (an empty chain: always deny, no audit row) and to no
 * shadow tap when either is absent, so a call site that omits them turns
 * escalation into a silent always-deny. Building both HERE, in one place, is
 * what keeps the execution stage, the acceptance-fix loop, the deferred
 * regression gate and `nax finish` from drifting apart.
 *
 * Approvals provenance (#2199): building the wiring taints the approvals store
 * when the run is forge-capable (any `raw` stage with the sandbox off) or
 * clears an earlier run's taint when it is not, BEFORE any agent this scope
 * serves starts; `dispose()` re-taints a forge-capable store once they are
 * done. Doing it here gives every Bash-dispatching site the same guarantee.
 *
 * Lifetime: the caller owns the returned wiring and MUST `await dispose()` once
 * the dispatches it serves have settled — it cancels an in-flight prompt,
 * disposes the human link, drains the shadow (bounded by its own timeout) and
 * re-taints a forge-capable store. `dispose()` never throws.
 */

import { join } from "node:path";
import { buildCommandShadow, type CommandShadow } from "@/command-safety";
import { type BashApprovalMode, loadConfigForPackage, type NaxConfig, resolveBashApproval } from "@/config";
import { getSafeLogger } from "@/logger";
import {
  type AskControl,
  type AskRequest,
  type AskResolver,
  appendApproval,
  appendApprovalAudit,
  approvalsPath,
  chainAskLinks,
  createApprovalsLink,
  isForgeCapable,
  prepareApprovalsStore,
} from "@/permissions";
import { NAX_COMMIT } from "@/version";
import { type AskChannel, cancelPendingAsk, createHumanAskLink } from "./ask-link";
import type { InteractionStage } from "./types";

/** Mirrors the `execution.approvalTimeout` schema default (schemas-execution.ts). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/** Directory (under the run output dir) the approval-audit corpus is appended to. */
export const APPROVAL_AUDIT_DIR = "approval-audit";

/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _dispatchAskDeps = {
  createHumanAskLink,
  buildCommandShadow,
  stdinIsTTY: (): boolean => process.stdin.isTTY === true,
  loadConfigForPackage,
  prepareApprovalsStore,
};

export type DispatchAskDeps = typeof _dispatchAskDeps;

export interface DispatchAskOptions {
  /** Effective config for the dispatches this wiring serves (timeout, plugin, sandbox, commandSafety). */
  readonly config: NaxConfig;
  /** The run's interaction chain; null/undefined = no human reachable (headless). */
  readonly interaction: AskChannel | null | undefined;
  /** Run output dir — approvals file, approval-audit and command-safety rows live under it. */
  readonly outputDir: string;
  readonly runId: string;
  /** Repo root the approvals cache is scoped to, and the fallback `root` of a remembered approval. */
  readonly repoRoot: string;
  /** The project root (`ctx.projectDir`); approvals-cache entries must lie within it (#2199). */
  readonly projectRoot: string;
  readonly featureName: string;
  readonly storyId?: string;
  readonly abortSignal?: AbortSignal;
  /**
   * The pipeline stage this scope's approval prompts belong to (US-005).
   * Post-run call sites pass `"review"` / `"merge"`; the execution stage
   * omits it so the human link keeps its `"execution"` default.
   */
  readonly stage?: InteractionStage;
  /** Every stage's resolved `bashApproval` in this run — see `collectEffectiveRunStageModes`. */
  readonly stageModes: readonly BashApprovalMode[];
}

export interface DispatchAskWiring {
  readonly askResolver: AskResolver;
  /** Absent when `execution.commandSafety` is not configured. */
  readonly commandShadow: CommandShadow | undefined;
  /** Cancel any in-flight prompt, dispose the human link, drain the shadow, re-taint. Never throws. */
  dispose(): Promise<void>;
}

/**
 * Build the ask resolver and command shadow for one dispatch scope.
 *
 * Fail-closed: the chain appends its own terminal deny, so an empty or
 * exhausted chain denies rather than runs. Every resolved ask appends a
 * ground-truth corpus row (P2 design 7.2); that append is best-effort, since a
 * full disk must not turn a granted approval into a tool error.
 */
export async function buildDispatchAskWiring(
  opts: DispatchAskOptions,
  deps: DispatchAskDeps = _dispatchAskDeps,
): Promise<DispatchAskWiring> {
  const approvalsFile = approvalsPath(opts.outputDir);
  const sandboxEnabled = opts.config.execution?.sandbox?.enabled === true;
  // #2199: the store outlives the run. Taint it (forge-capable run) or clear an
  // earlier run's taint (trusted run) BEFORE this scope's agents start.
  const approvalsStore = {
    approvalsFile,
    runId: opts.runId,
    storyId: opts.storyId,
    forgeCapable: isForgeCapable(opts.stageModes, sandboxEnabled),
  };
  await deps.prepareApprovalsStore(approvalsStore);
  const humanLink = deps.createHumanAskLink({
    chain: opts.interaction,
    timeoutMs: opts.config.execution?.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    featureName: opts.featureName,
    ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
    ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    onRemember: async (req) =>
      appendApproval(approvalsFile, {
        stage: req.stage,
        command: req.command ?? "",
        root: req.root ?? opts.repoRoot,
        // #2249: record what actually happened. An ask carries `matchedRule`
        // only when an ask rule matched; otherwise it is an escalated grant
        // miss. The chain holds exactly the configured plugin
        // (interaction/init.ts), so that names the channel that answered.
        origin: req.matchedRule !== undefined ? "askRule" : "escalate",
        matchedRule: req.matchedRule ?? null,
        approvedAt: new Date().toISOString(),
        approvedBy: opts.config.interaction?.plugin ?? "unknown",
        naxCommit: NAX_COMMIT,
      }),
  });
  const baseResolver = chainAskLinks([
    createApprovalsLink({
      approvalsFile,
      repoRoot: opts.repoRoot,
      projectRoot: opts.projectRoot,
      stageModes: [...opts.stageModes],
      sandboxEnabled,
    }),
    // P5's classifier link slots in HERE, between cache and human.
    humanLink,
  ]);
  const auditDir = join(opts.outputDir, APPROVAL_AUDIT_DIR);
  const askResolver: AskResolver = {
    humanReachable: isHumanReachable(opts, deps),
    // US-003: forward the AskControl (turn signal + onWaiting) through the
    // base resolver to every link. The cache link ignores it; the human
    // link uses it to settle a per-waiter cancellation as `deny/cancelled`.
    resolve: async (req: AskRequest, control?: AskControl) => {
      const verdict = await baseResolver.resolve(req, control);
      await appendApprovalAudit(auditDir, opts.runId, {
        // Audit row carries the bare request, not the control — the
        // request is what the agent did, the control is turn plumbing.
        request: req,
        decision: verdict.decision,
        decidedBy: verdict.decidedBy,
        latencyMs: verdict.latencyMs,
        at: new Date().toISOString(),
      }).catch(() => undefined);
      return verdict;
    },
  };
  const commandShadow = deps.buildCommandShadow({
    config: opts.config.execution?.commandSafety,
    outputDir: opts.outputDir,
    runId: opts.runId,
    ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
    env: process.env,
  });
  return {
    askResolver,
    commandShadow,
    dispose: async () => {
      // A prompt in flight when the scope ends is cancelled and denied. The
      // human link races its own pending decision with cancellation, so this
      // settles even when a channel's cancel() only clears transport bookkeeping.
      await cancelPendingAsk(humanLink).catch(() => undefined);
      humanLink.dispose();
      // Bounded by the shadow's own timeout; never throws (spec 4.6).
      await commandShadow?.drain();
      // #2199: re-taint once this scope's agents are done, wiping anything
      // they wrote -- including an agent that stripped the first marker.
      if (approvalsStore.forgeCapable) await deps.prepareApprovalsStore(approvalsStore);
    },
  };
}

/**
 * No chain = every ask resolves `unavailable`, so nothing may promise a human.
 * The cli plugin also needs a TTY stdin: without one its init skips readline
 * and every prompt fails (plugins/cli.ts).
 */
function isHumanReachable(opts: DispatchAskOptions, deps: DispatchAskDeps): boolean {
  if (opts.interaction === undefined || opts.interaction === null) return false;
  return opts.config.interaction?.plugin !== "cli" || deps.stdinIsTTY();
}

/**
 * Every stage's resolved `bashApproval` in this run, plus the global default.
 *
 * The approvals-cache link disables itself when ANY stage resolves to `raw`,
 * because a raw shell can forge the cache file. Precedence lives in
 * `resolveBashApproval` — this helper only enumerates. An unloadable config
 * (`undefined`) is treated as `raw`: fail closed.
 */
export function collectRunStageModes(configs: readonly (NaxConfig | undefined)[]): BashApprovalMode[] {
  const modes = new Set<BashApprovalMode>();
  for (const config of configs) {
    if (config === undefined) return ["raw"];
    const execution = config.execution;
    const global = execution?.bashApproval;
    modes.add(resolveBashApproval(global, undefined));
    for (const block of Object.values(execution?.permissions ?? {})) {
      modes.add(resolveBashApproval(global, block?.bashApproval));
    }
  }
  return [...modes];
}

export interface EffectiveRunStageModesOptions {
  readonly projectDir: string;
  /** The run's root config — the `from` of every package load (nax#2126). */
  readonly rootConfig: NaxConfig;
  /** Additional already-loaded configs to include (e.g. the story's effective config). */
  readonly extraConfigs?: readonly NaxConfig[];
  /** Every story's package dir (`prd.userStories.map(storyPackageDir)`). */
  readonly packageDirs: readonly (string | undefined)[];
}

/** `collectRunStageModes` over the root config and every package config in the run. */
export async function collectEffectiveRunStageModes(
  opts: EffectiveRunStageModesOptions,
  deps: Pick<DispatchAskDeps, "loadConfigForPackage"> = _dispatchAskDeps,
): Promise<BashApprovalMode[]> {
  const packageDirs = [...new Set(opts.packageDirs)];
  const packageConfigs = await Promise.all(
    packageDirs.map((packageDir) =>
      deps.loadConfigForPackage(opts.projectDir, packageDir, opts.rootConfig).catch(() => undefined),
    ),
  );
  return collectRunStageModes([opts.rootConfig, ...(opts.extraConfigs ?? []), ...packageConfigs]);
}

export interface ApprovalsSealOptions {
  readonly projectDir: string;
  /** The run's root config. `execution.sandbox` is a root-only key (ROOT_ONLY_EXECUTION_KEYS). */
  readonly rootConfig: NaxConfig;
  /** Every story's package dir (`prd.userStories.map(storyPackageDir)`). */
  readonly packageDirs: readonly (string | undefined)[];
  /** Run output dir; the approvals file is `approvalsPath(outputDir)`. */
  readonly outputDir: string;
  readonly runId: string;
}

/**
 * Decide once whether this run is forge-capable; return the end-of-run seal.
 *
 * The per-scope taint in `buildDispatchAskWiring` only covers agents dispatched
 * inside a dispatch-ask scope. A final seal at run end closes the window in
 * which an agent that ran outside any scope could strip the marker and forge
 * entries a later trusted run would honour.
 *
 * Forge-capability is decided HERE, at setup: the signal-time teardown that
 * awaits the seal runs under `FATAL_TEARDOWN_DEADLINE_MS`, so it must not load
 * configs. A trusted run's seal does nothing at all. Never rejects —
 * `prepareApprovalsStore` logs a failed taint and resolves.
 */
export async function buildApprovalsSeal(
  opts: ApprovalsSealOptions,
  deps: DispatchAskDeps = _dispatchAskDeps,
): Promise<() => Promise<void>> {
  const stageModes = await collectEffectiveRunStageModes(
    { projectDir: opts.projectDir, rootConfig: opts.rootConfig, packageDirs: opts.packageDirs },
    deps,
  );
  const forgeCapable = isForgeCapable(stageModes, opts.rootConfig.execution?.sandbox?.enabled === true);
  if (!forgeCapable) return async () => {};
  const approvalsFile = approvalsPath(opts.outputDir);
  const runId = opts.runId;
  return async () => {
    try {
      await deps.prepareApprovalsStore({ approvalsFile, runId, forgeCapable: true });
    } catch (error) {
      // The real `prepareApprovalsStore` never throws — it logs a failed taint —
      // but `deps` is injectable, so an injected one can. Swallow here so the
      // "never rejects" contract above holds for the signal path too, where a
      // rejection would otherwise be discarded silently.
      getSafeLogger()?.warn("permissions", "[approvals] could not update the store's taint marker", {
        approvalsFile,
        forgeCapable: true,
        error,
      });
    }
  };
}

export interface RunDispatchAskOptions extends Omit<DispatchAskOptions, "stageModes" | "projectRoot"> {
  readonly projectDir: string;
  /** The run's root config — the `from` of every package load (nax#2126). */
  readonly rootConfig: NaxConfig;
  /** Every story's package dir (`prd.userStories.map(storyPackageDir)`). */
  readonly packageDirs: readonly (string | undefined)[];
}

/**
 * `buildDispatchAskWiring` for a run-scoped (post-run) call site: resolves the
 * run's stage modes from the root and package configs first. Used by the
 * acceptance-fix loop, the deferred regression gate and the finish phase.
 */
export async function buildRunDispatchAskWiring(
  opts: RunDispatchAskOptions,
  deps: DispatchAskDeps = _dispatchAskDeps,
): Promise<DispatchAskWiring> {
  const stageModes = await collectEffectiveRunStageModes(
    {
      projectDir: opts.projectDir,
      rootConfig: opts.rootConfig,
      extraConfigs: [opts.config],
      packageDirs: opts.packageDirs,
    },
    deps,
  );
  return buildDispatchAskWiring({ ...opts, projectRoot: opts.projectDir, stageModes }, deps);
}
