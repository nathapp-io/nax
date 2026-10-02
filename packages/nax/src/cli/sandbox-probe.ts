import {
  createSrtBackend,
  type ProbeResult,
  probeSandbox,
  type SandboxBackend,
  type SandboxBackendName,
} from "@nathapp/nax-agent";
import type { SandboxConfig } from "@/config";
import { DEFAULT_SANDBOX_CONFIG } from "@/config";

export interface SandboxProbeReport {
  backend: SandboxBackendName;
  platform: string;
  available: boolean;
  reason?: string;
}

export interface SandboxProbeOptions {
  json?: boolean;
}

export const _sandboxProbeCmdDeps: {
  log: (text: string) => void;
  platform: () => string;
  createBackend: (network: SandboxConfig["network"]) => SandboxBackend;
  probe: (backend: SandboxBackend) => Promise<ProbeResult>;
} = {
  log: (text) => console.log(text),
  platform: () => process.platform,
  createBackend: createSrtBackend,
  probe: probeSandbox,
};

export async function sandboxProbeCommand(options: SandboxProbeOptions = {}): Promise<number> {
  const backend = _sandboxProbeCmdDeps.createBackend(DEFAULT_SANDBOX_CONFIG.network);
  let result: ProbeResult;
  try {
    try {
      result = await _sandboxProbeCmdDeps.probe(backend);
    } catch (error) {
      result = {
        available: false,
        reason: `sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } finally {
    try {
      await backend.reset();
    } catch {
      // Probe verdict is final; teardown failure must not replace it.
    }
  }

  const report: SandboxProbeReport = {
    backend: backend.name,
    platform: _sandboxProbeCmdDeps.platform(),
    available: result.available,
    ...(!result.available ? { reason: result.reason } : {}),
  };
  _sandboxProbeCmdDeps.log(
    options.json
      ? JSON.stringify(report, null, 2)
      : `Sandbox (${report.backend}, ${report.platform}): ${report.available ? "available" : `unavailable: ${report.reason}`}`,
  );
  return report.available ? 0 : 1;
}
