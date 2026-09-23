/**
 * The ONLY importer of @anthropic-ai/sandbox-runtime (enforced by
 * scripts/check-sandbox-imports.ts). Loaded by dynamic import so a run that
 * never sandboxes never loads it.
 *
 * srt's SandboxManager is a process-wide singleton; per-call customConfig
 * carries each story's roots, so parallel worktree stories share it (spike:
 * concurrent roots isolated). The returned `env` of wrapWithSandboxArgv is
 * process.env itself and is DISCARDED here (spec F6).
 */
import { mkdir } from "node:fs/promises";
import type { SandboxConfig } from "../config/schemas-sandbox";
import { SRT_MACOS_TMPDIR } from "./defaults";
import type { SandboxBackend, SandboxPolicy, SandboxWrapRequest } from "./types";

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");
type SrtRuntimeConfig = Parameters<SrtModule["SandboxManager"]["initialize"]>[0];
type SrtNetwork = SrtRuntimeConfig["network"];

export const _srtBackendDeps = {
  load: (): Promise<SrtModule> => import("@anthropic-ai/sandbox-runtime"),
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
 */
function srtNetwork(allowedDomains: readonly string[] | undefined): SrtNetwork {
  if (allowedDomains !== undefined) return { allowedDomains: [...allowedDomains], deniedDomains: [] };
  const open: Pick<SrtNetwork, "deniedDomains"> = { deniedDomains: [] };
  return open as SrtNetwork;
}

function customConfig(policy: SandboxPolicy): Partial<SrtRuntimeConfig> {
  return {
    filesystem: {
      denyRead: [...policy.denyRead],
      allowWrite: [...policy.writeRoots],
      denyWrite: [...policy.denyWrite],
    },
    ...(policy.network.allowedDomains !== undefined ? { network: srtNetwork(policy.network.allowedDomains) } : {}),
  };
}

export function createSrtBackend(network: SandboxConfig["network"]): SandboxBackend {
  let initialized: Promise<SrtModule> | undefined;
  let loaded: SrtModule | undefined;
  let inFlight = 0;

  function initialize(): Promise<SrtModule> {
    initialized ??= (async () => {
      const mod = await _srtBackendDeps.load();
      if (_srtBackendDeps.platform() === "darwin") await _srtBackendDeps.mkdir(SRT_MACOS_TMPDIR, { recursive: true });
      await mod.SandboxManager.initialize({
        network: srtNetwork(network.allowedDomains),
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
