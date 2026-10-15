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
import type { SandboxConfig } from "../config/schemas-sandbox.ts";
import { SRT_MACOS_TMPDIR } from "./defaults.ts";
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
};

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
  let inFlight = 0;

  function initialize(): Promise<SrtModuleSlice> {
    initialized ??= (async () => {
      const mod = await _srtBackendDeps.load();
      if (_srtBackendDeps.platform() === "darwin") await _srtBackendDeps.mkdir(SRT_MACOS_TMPDIR, { recursive: true });
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
      inFlight += 1;
      try {
        const { argv } = await mod.SandboxManager.wrapWithSandboxArgv(
          req.command,
          req.shell,
          customConfig(req.policy),
          undefined,
          req.cwd,
          { commandId: req.commandId },
        );
        return argv;
      } catch (err) {
        inFlight -= 1;
        throw err;
      }
    },
    annotate(commandId: string, stderr: string) {
      if (loaded === undefined) return "";
      const annotated = loaded.SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
      return annotated.startsWith(stderr) ? annotated.slice(stderr.length).trim() : "";
    },
    commandFinished() {
      inFlight = Math.max(0, inFlight - 1);
      // Removes bwrap mount placeholders (Linux). Never while another wrapped
      // command runs: a running sandbox may still depend on them.
      if (inFlight === 0) loaded?.SandboxManager.cleanupAfterCommand();
    },
    async reset() {
      if (loaded !== undefined) await loaded.SandboxManager.reset();
      initialized = undefined;
      loaded = undefined;
      inFlight = 0;
    },
  };
}
