/**
 * The ONLY importer of @anthropic-ai/sandbox-runtime (enforced by
 * packages/repo-tooling/scripts/check-sandbox-imports.ts). Loaded by dynamic import so a run that
 * never sandboxes never loads it.
 *
 * srt's SandboxManager is a process-wide singleton; per-call customConfig
 * carries each story's roots, so parallel worktree stories share it (spike:
 * concurrent roots isolated). The returned `env` of wrapWithSandboxArgv is
 * process.env itself and is DISCARDED here (spec F6).
 */
import { mkdir } from "node:fs/promises";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { realOrRaw } from "#src/internal/realpath";
import type { SandboxConfig } from "../config/schemas-sandbox.ts";
import { SRT_MACOS_TMPDIR } from "./defaults.ts";
import { rootMandatoryDenyGlobs } from "./mandatory-deny-globs.ts";
import { ensurePlaceholderExcludes } from "./placeholder-excludes.ts";
import { type PlaceholderLedger, placeholderLedger } from "./placeholder-ledger.ts";
import { candidatePaths } from "./placeholder-paths.ts";
import { sweepStalePlaceholders } from "./placeholder-sweep.ts";
import type { SandboxBackend, SandboxPolicy, SandboxWrapRequest } from "./types.ts";

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");
type SrtRuntimeConfig = Parameters<SrtModule["SandboxManager"]["initialize"]>[0];
type SrtNetwork = SrtRuntimeConfig["network"];

/**
 * The slice of the srt module this backend calls. Narrowed on purpose: this seam
 * is what a test replaces, and a double for the whole module needs an
 * `as unknown as` cast, which test/ forbids (check-test-as-unknown-as). The real
 * `typeof import(...)` satisfies this structurally, so nothing is lost.
 */
type SrtModuleSlice = {
  SandboxManager: Pick<
    SrtModule["SandboxManager"],
    | "initialize"
    | "updateConfig"
    | "isSupportedPlatform"
    | "wrapWithSandboxArgv"
    | "annotateStderrWithSandboxFailures"
    | "cleanupAfterCommand"
    | "reset"
  >;
};

export const _srtBackendDeps = {
  load: (): Promise<SrtModuleSlice> => import("@anthropic-ai/sandbox-runtime"),
  platform: (): NodeJS.Platform => process.platform,
  mkdir,
  sweep: sweepStalePlaceholders,
  /**
   * US-007: hide the shell-startup placeholders srt holds from a repository's
   * `git status`, once per initialize. Replaced with a no-op for the whole test
   * suite by `test/preload.ts`, so no test writes its checkout's exclude file.
   */
  ensureExcludes: ensurePlaceholderExcludes,
  /**
   * US-003: the directory srt resolves its mandatory write-deny names against,
   * and therefore the directory bwrap creates placeholders in. Process cwd, NOT
   * the request's `cwd`: srt pins these names to `process.cwd()` itself, so a
   * candidacy computed from any other anchor would miss real placeholders.
   */
  // biome-ignore lint/plugin: this seam mirrors srt, which pins its own mandatory denies to process.cwd(); threading nax's resolved root in instead would describe placeholders that never appear. Tests override it.
  cwd: (): string => process.cwd(),
  /**
   * #2986: run `fn` once after `ms` and return a canceller. The timer is unref'd, so
   * a pending poll never keeps the process alive. Tests replace it with a manual queue.
   */
  schedule: (fn: () => void, ms: number): (() => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
  /** #2986: how often `commandStarted` re-reads the ledger while a candidate is still absent. */
  startedPollIntervalMs: 20,
  /** #2986: the longest `commandStarted` keeps polling for bwrap to create its placeholders. */
  startedPollMaxMs: 2000,
};

/**
 * US-003 — the ledger wiring below is Linux-only. Seatbelt creates no
 * placeholders, and every other platform gets srt's own count and cleanup
 * exactly as before.
 */
function linuxLedger(): PlaceholderLedger | undefined {
  return _srtBackendDeps.platform() === "linux" ? placeholderLedger() : undefined;
}

/**
 * Record every path this wrap may create a placeholder at, then identify the
 * ones already on disk. Both happen BEFORE srt wraps: a placeholder that appears
 * later is already recorded as pending, and `observe` is what turns a pending
 * entry into the inode identity the sweep and `prune` compare against.
 */
function recordPlaceholderCandidates(policy: SandboxPolicy): void {
  const ledger = linuxLedger();
  if (ledger === undefined) return;
  ledger.recordAbsent(candidatePaths(_srtBackendDeps.cwd(), policy));
  ledger.observe();
}

/**
 * Open network = `network` WITHOUT `allowedDomains`. srt's type requires the
 * field, but its runtime decides restriction on `allowedDomains !== undefined`
 * (sandbox-manager.js, `hasNetworkConfig`), and `initialize` dereferences
 * `network`, so the object must exist. This is the one cast in the module; the
 * live suite pins the behaviour (open => no proxy variables in the argv), so
 * an srt bump that changes it fails a test rather than silently restricting.
 *
 * US-002 (#2538): `allowLocalBinding` rides along. srt reads it once per process
 * from THIS object (`getAllowLocalBinding`, sandbox-manager.js:1171), never from
 * a per-command `customConfig`, so it is emitted only here. Only `true` is
 * emitted: srt's default is off, so absent and `false` are equivalent, and the
 * policy type (`SandboxNetworkPolicy`) cannot express an explicit `false`.
 */
function srtNetwork(allowedDomains: readonly string[] | undefined, allowLocalBinding?: boolean): SrtNetwork {
  const localBinding = allowLocalBinding === true ? { allowLocalBinding: true as const } : {};
  if (allowedDomains !== undefined) return { allowedDomains: [...allowedDomains], deniedDomains: [], ...localBinding };
  const open: Pick<SrtNetwork, "deniedDomains" | "allowLocalBinding"> = { deniedDomains: [], ...localBinding };
  return open as SrtNetwork;
}

/**
 * #3038: on darwin, srt's nested mandatory denies are cwd-anchored patterns it cannot
 * re-anchor, so the session root's own are added here, where srt's glob dialect is
 * known. Never on Linux: bwrap drops a glob, and the policy carries literals instead.
 */
function nestedRootDenies(root: string | undefined): string[] {
  if (root === undefined || _srtBackendDeps.platform() !== "darwin") return [];
  return rootMandatoryDenyGlobs(realOrRaw(root));
}

function customConfig(policy: SandboxPolicy, root: string | undefined): Partial<SrtRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [...policy.denyRead],
      allowWrite: [...policy.writeRoots],
      denyWrite: [...policy.denyWrite, ...nestedRootDenies(root)],
    },
    // US-002: `allowLocalBinding` is deliberately NOT here. srt applies it
    // process-wide, from the `initialize` config, so a copy on the per-command
    // config would promise a per-command effect it does not have.
    ...(policy.network.allowedDomains !== undefined ? { network: srtNetwork(policy.network.allowedDomains) } : {}),
  };
}

/**
 * One Linux start-up step, caught on its own: a failed sweep must not suppress
 * the excludes (and the reverse), and neither may fail the wrap that triggered
 * it — a command still runs with stale placeholders or an untracked `.bashrc`.
 */
async function linuxStep(message: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    getSafeLogger()?.warn("sandbox", message, { error: errorMessage(error) });
  }
}

/** US-004 and US-007: the placeholder work that only a Linux start-up does. */
async function runLinuxStartupSteps(): Promise<void> {
  await linuxStep("placeholder sweep initialization failed", () => _srtBackendDeps.sweep());
  await linuxStep("git excludes initialization failed", () => _srtBackendDeps.ensureExcludes(_srtBackendDeps.cwd()));
}

/**
 * #3038: the session root's mandatory names are denied AT the root, so bwrap holds
 * placeholders there even when the process cwd is elsewhere (`nax chat -d <dir>`).
 * Each distinct root gets the same excludes the process cwd got at start-up, once,
 * on the first wrap that names it. The promise is stored before it is awaited, so
 * two wraps racing on a new root share one step.
 */
function createRootExcludes(): { ensure(root: string | undefined): Promise<void>; forget(): void } {
  const handled = new Map<string, Promise<void>>();
  return {
    ensure(root) {
      if (root === undefined || _srtBackendDeps.platform() !== "linux") return Promise.resolve();
      const key = realOrRaw(root);
      // A root equal to the process cwd was handled by start-up (see `rootExcludesStep`).
      if (!handled.has(key)) handled.set(key, rootExcludesStep(root));
      return handled.get(key) ?? Promise.resolve();
    },
    forget() {
      handled.clear();
    },
  };
}

function rootExcludesStep(root: string): Promise<void> {
  if (realOrRaw(root) === realOrRaw(_srtBackendDeps.cwd())) return Promise.resolve();
  return linuxStep("git excludes initialization failed", () => _srtBackendDeps.ensureExcludes(root));
}

/**
 * #2986 — identifies the placeholders bwrap creates when a wrapped process SPAWNS.
 *
 * `wrap` runs before the spawn, so it can only record candidates as pending; a
 * process killed mid-command would leave every entry pending, and the sweep never
 * removes a pending entry. `start` is called once the process has spawned and
 * re-reads the ledger on a short timer until no entry is pending, the cap passes,
 * or every started command has finished. It never throws and never blocks.
 */
function createStartedPoll(): { start(commandId?: string): void; finish(commandId?: string): void } {
  // Only STARTED commands count: a command that finishes without ever spawning (an
  // aborted signal, a spawn that threw) must not stop another live command's poll.
  const startedIds = new Set<string>();
  let startedAnonymous = 0;
  const running = (): number => startedIds.size + startedAnonymous;
  let cancel: (() => void) | undefined;
  let elapsedMs = 0;

  function stop(): void {
    cancel?.();
    cancel = undefined;
  }

  function tick(): void {
    cancel = undefined;
    const pending = linuxLedger()?.observe() ?? 0;
    elapsedMs += _srtBackendDeps.startedPollIntervalMs;
    if (pending === 0 || running() === 0 || elapsedMs >= _srtBackendDeps.startedPollMaxMs) return;
    cancel = _srtBackendDeps.schedule(guardedTick, _srtBackendDeps.startedPollIntervalMs);
  }

  function guardedTick(): void {
    try {
      tick();
    } catch (error) {
      getSafeLogger()?.warn("sandbox", "placeholder identification after spawn failed", { error: errorMessage(error) });
    }
  }

  return {
    start(commandId?: string): void {
      if (linuxLedger() === undefined) return;
      if (commandId === undefined) startedAnonymous += 1;
      else startedIds.add(commandId);
      // A new command opens a new window: its own bwrap has yet to create its mounts.
      elapsedMs = 0;
      if (cancel !== undefined) return;
      try {
        cancel = _srtBackendDeps.schedule(guardedTick, _srtBackendDeps.startedPollIntervalMs);
      } catch (error) {
        getSafeLogger()?.warn("sandbox", "placeholder identification after spawn failed", {
          error: errorMessage(error),
        });
      }
    },
    finish(commandId?: string): void {
      if (commandId === undefined) startedAnonymous = Math.max(0, startedAnonymous - 1);
      else startedIds.delete(commandId);
      if (running() === 0) stop();
    },
  };
}

export function createSrtBackend(network: SandboxConfig["network"]): SandboxBackend {
  let initialized: Promise<SrtModuleSlice> | undefined;
  let loaded: SrtModuleSlice | undefined;
  const startedPoll = createStartedPoll();
  const rootExcludes = createRootExcludes();
  let runtimeConfig = {
    network: srtNetwork(network.allowedDomains, network.allowLocalBinding),
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  } as SrtRuntimeConfig;

  function initialize(): Promise<SrtModuleSlice> {
    initialized ??= (async () => {
      const mod = await _srtBackendDeps.load();
      if (_srtBackendDeps.platform() === "darwin") await _srtBackendDeps.mkdir(SRT_MACOS_TMPDIR, { recursive: true });
      if (_srtBackendDeps.platform() === "linux") await runLinuxStartupSteps();
      await mod.SandboxManager.initialize(runtimeConfig);
      loaded = mod;
      return mod;
    })();
    return initialized;
  }

  return {
    name: "srt",
    async updateNetwork(allowedDomains) {
      runtimeConfig = {
        ...runtimeConfig,
        network: { ...runtimeConfig.network, allowedDomains: [...allowedDomains] },
      };
      // Do not load srt just to set a pre-init ceiling. If initialization is in
      // flight, wait for it before replacing the singleton's live config.
      if (initialized === undefined) return;
      const mod = await initialized;
      mod.SandboxManager.updateConfig(runtimeConfig);
    },
    async isSupportedPlatform() {
      const mod = await _srtBackendDeps.load();
      return mod.SandboxManager.isSupportedPlatform();
    },
    async wrap(req: SandboxWrapRequest) {
      const mod = await initialize();
      await rootExcludes.ensure(req.root);
      // Linux: the ledger records what this wrap may create before it creates it.
      recordPlaceholderCandidates(req.policy);
      // A wrap that throws undoes srt's own count, so it needs no cleanup call.
      const { argv } = await mod.SandboxManager.wrapWithSandboxArgv(
        req.command,
        req.shell,
        customConfig(req.policy, req.root),
        undefined,
        req.cwd,
        { commandId: req.commandId },
      );
      return argv;
    },
    commandStarted(commandId?: string) {
      startedPoll.start(commandId);
    },
    annotate(commandId: string, stderr: string) {
      if (loaded === undefined) return "";
      const annotated = loaded.SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
      return annotated.startsWith(stderr) ? annotated.slice(stderr.length).trim() : "";
    },
    commandFinished(commandId?: string) {
      // Removes bwrap mount placeholders (Linux: `.bashrc`, `.profile`,
      // `.claude/commands`, ...). srt counts every wrap itself and defers the
      // deletion while another wrapped command still runs, so it must hear about
      // EVERY finished command. A second, nax-side gate here leaked srt's count
      // after any overlap and left the placeholders in the user's directory.
      //
      // US-003: the ledger must hold the placeholder's identity BEFORE that
      // deletion happens (`observe`), so a placeholder srt removes is still known
      // by inode; `prune` afterwards is what then drops the entries srt removed.
      startedPoll.finish(commandId);
      const ledger = linuxLedger();
      ledger?.observe();
      loaded?.SandboxManager.cleanupAfterCommand();
      ledger?.prune();
    },
    async reset() {
      if (loaded !== undefined) await loaded.SandboxManager.reset();
      // US-003: srt has dropped its placeholders by now, so the entries whose
      // inode is gone are exactly the ones this prune drops.
      linuxLedger()?.prune();
      rootExcludes.forget();
      initialized = undefined;
      loaded = undefined;
    },
  };
}
