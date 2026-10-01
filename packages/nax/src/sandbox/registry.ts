/**
 * Process-level sandbox state: one backend (srt's manager is a singleton), one
 * probe result, and the once-per-process log lines (spec 5.7). One nax process
 * serves one project, so one network config per process holds.
 */
import type { SandboxConfig } from "../config/schemas-sandbox";
import { getSafeLogger } from "../logger";
import { probeSandbox } from "./probe";
import { createSrtBackend } from "./srt-backend";
import type { ProbeResult, SandboxBackend } from "./types";

export const _sandboxRegistryDeps = {
  createBackend: (network: SandboxConfig["network"]): SandboxBackend => createSrtBackend(network),
  probe: (backend: SandboxBackend): Promise<ProbeResult> => probeSandbox(backend),
};

let backend: SandboxBackend | undefined;
let probed: Promise<ProbeResult> | undefined;
let warnedUnavailable = false;

export function sandboxBackendFor(config: SandboxConfig): SandboxBackend {
  backend ??= _sandboxRegistryDeps.createBackend(config.network);
  return backend;
}

export function probeSandboxOnce(target: SandboxBackend, storyId = "_sandbox"): Promise<ProbeResult> {
  probed ??= _sandboxRegistryDeps.probe(target).then(
    (result) => {
      getSafeLogger()?.info("sandbox", "Sandbox probe", {
        storyId,
        backend: target.name,
        available: result.available,
        ...(result.available ? {} : { reason: result.reason }),
      });
      return result;
    },
    (err: unknown) => {
      const reason = `sandbox probe failed: ${err instanceof Error ? err.message : String(err)}`;
      getSafeLogger()?.warn("sandbox", "Sandbox probe threw; treating as unavailable", { storyId, reason });
      const unavailable: ProbeResult = { available: false, reason };
      return unavailable;
    },
  );
  return probed;
}

export function warnSandboxUnavailableOnce(reason: string, storyId = "_sandbox"): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  getSafeLogger()?.warn("sandbox", "Sandbox unavailable: raw bash is refused; gated/escalate commands run unwrapped", {
    storyId,
    reason,
  });
}

/** Run cleanup. The probe result is kept: the platform does not change. */
export async function resetSandboxBackend(): Promise<void> {
  const current = backend;
  backend = undefined;
  if (current !== undefined) await current.reset();
}

export function _resetSandboxRegistryForTests(): void {
  backend = undefined;
  probed = undefined;
  warnedUnavailable = false;
}
