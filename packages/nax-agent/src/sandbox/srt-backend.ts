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
import type { SandboxConfig } from "../config/schemas-sandbox.ts";
import { SRT_MACOS_TMPDIR } from "./defaults.ts";
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
   * US-003: the directory srt resolves its mandatory write-deny names against,
   * and therefore the directory bwrap creates placeholders in. Process cwd, NOT
   * the request's `cwd`: srt pins these names to `process.cwd()` itself, so a
   * candidacy computed from any other anchor would miss real placeholders.
   */
  // biome-ignore lint/plugin: this seam mirrors srt, which pins its own mandatory denies to process.cwd(); threading nax's resolved root in instead would describe placeholders that never appear. Tests override it.
  cwd: (): string => process.cwd(),
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

function customConfig(policy: SandboxPolicy): Partial<SrtRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [...policy.denyRead],
      allowWrite: [...policy.writeRoots],
      denyWrite: [...policy.denyWrite],
    },
    // US-002: `allowLocalBinding` is deliberately NOT here. srt applies it
    // process-wide, from the `initialize` config, so a copy on the per-command
    // config would promise a per-command effect it does not have.
    ...(policy.network.allowedDomains !== undefined ? { network: srtNetwork(policy.network.allowedDomains) } : {}),
  };
}

export function createSrtBackend(network: SandboxConfig["network"]): SandboxBackend {
  let initialized: Promise<SrtModuleSlice> | undefined;
  let loaded: SrtModuleSlice | undefined;

  function initialize(): Promise<SrtModuleSlice> {
    initialized ??= (async () => {
      const mod = await _srtBackendDeps.load();
      if (_srtBackendDeps.platform() === "darwin") await _srtBackendDeps.mkdir(SRT_MACOS_TMPDIR, { recursive: true });
      if (_srtBackendDeps.platform() === "linux") {
        try {
          await _srtBackendDeps.sweep();
        } catch (error) {
          getSafeLogger()?.warn("sandbox", "placeholder sweep initialization failed", { error: errorMessage(error) });
        }
      }
      await mod.SandboxManager.initialize({
        network: srtNetwork(network.allowedDomains, network.allowLocalBinding),
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      } as SrtRuntimeConfig);
      loaded = mod;
      return mod;
    })();
    return initialized;
  }

  return {
    name: "srt",
    async isSupportedPlatform() {
      const mod = await _srtBackendDeps.load();
      return mod.SandboxManager.isSupportedPlatform();
    },
    async wrap(req: SandboxWrapRequest) {
      const mod = await initialize();
      // Linux: the ledger records what this wrap may create before it creates it.
      recordPlaceholderCandidates(req.policy);
      // A wrap that throws undoes srt's own count, so it needs no cleanup call.
      const { argv } = await mod.SandboxManager.wrapWithSandboxArgv(
        req.command,
        req.shell,
        customConfig(req.policy),
        undefined,
        req.cwd,
        { commandId: req.commandId },
      );
      return argv;
    },
    annotate(commandId: string, stderr: string) {
      if (loaded === undefined) return "";
      const annotated = loaded.SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
      return annotated.startsWith(stderr) ? annotated.slice(stderr.length).trim() : "";
    },
    commandFinished() {
      // Removes bwrap mount placeholders (Linux: `.bashrc`, `.profile`,
      // `.claude/commands`, ...). srt counts every wrap itself and defers the
      // deletion while another wrapped command still runs, so it must hear about
      // EVERY finished command. A second, nax-side gate here leaked srt's count
      // after any overlap and left the placeholders in the user's directory.
      //
      // US-003: the ledger must hold the placeholder's identity BEFORE that
      // deletion happens (`observe`), so a placeholder srt removes is still known
      // by inode; `prune` afterwards is what then drops the entries srt removed.
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
      initialized = undefined;
      loaded = undefined;
    },
  };
}
