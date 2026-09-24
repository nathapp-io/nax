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
import {
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
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    onRemember: async (req) =>
      appendApproval(approvalsFile, {
        stage: req.stage,
        command: req.command ?? "",
        root: req.root ?? opts.repoRoot,
        origin: "escalate",
        matchedRule: null,
        approvedAt: new Date().toISOString(),
        approvedBy: "telegram",
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
    resolve: async (req: AskRequest) => {
      const verdict = await baseResolver.resolve(req);
      await appendApprovalAudit(auditDir, opts.runId, {
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
