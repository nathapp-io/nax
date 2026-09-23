/**
 * The async half of P4's session wiring (spec 5.2, review finding 7).
 *
 * resolveCodingToolSupport is async and awaits this; buildCodingToolSupport is
 * synchronous and on the hot dispatch path, so it only receives the result as
 * data. Nothing here may be called from the sync path.
 */
import { homedir } from "node:os";
import type { SandboxConfig } from "@/config/schemas-sandbox";
import { approvalsPath } from "@/permissions";
import {
  buildSandboxPolicy,
  type CommandLauncher,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  defaultTempRoots,
  listCredentialFiles,
  listFeaturePrdPaths,
  probeSandboxOnce,
  rawBashRefusalReason,
  resolveGitLayout,
  sandboxBackendFor,
  warnSandboxUnavailableOnce,
} from "@/sandbox";

export const _sessionSandboxDeps = {
  backendFor: sandboxBackendFor,
  probe: probeSandboxOnce,
  gitLayout: resolveGitLayout,
  featurePrds: listFeaturePrdPaths,
  credentialFiles: listCredentialFiles,
  tempRoots: defaultTempRoots,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
};

export async function resolveSessionSandbox(args: {
  readonly config: SandboxConfig | undefined;
  readonly root: string;
  readonly outputDir?: string;
  readonly needsLauncher: boolean;
  readonly storyId?: string;
}): Promise<CommandLauncher> {
  const config = args.config;
  if (config === undefined || !config.enabled || !args.needsLauncher) {
    return createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
  }
  const backend = _sessionSandboxDeps.backendFor(config);
  const probe = await _sessionSandboxDeps.probe(backend, args.storyId);
  if (!probe.available) {
    warnSandboxUnavailableOnce(probe.reason, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: probe.reason } });
  }
  const git = await _sessionSandboxDeps.gitLayout(args.root);
  const credentialFiles = await _sessionSandboxDeps.credentialFiles();
  const approvalsFile = args.outputDir !== undefined ? approvalsPath(args.outputDir) : undefined;
  const policyFor = async (root: string) =>
    buildSandboxPolicy({
      root,
      git,
      featurePrdPaths: await _sessionSandboxDeps.featurePrds(root),
      credentialFiles,
      ...(approvalsFile !== undefined ? { approvalsFile } : {}),
      home: _sessionSandboxDeps.homedir(),
      tempRoots: _sessionSandboxDeps.tempRoots(),
      platform: _sessionSandboxDeps.platform(),
      config,
    });
  const network = config.network.allowedDomains ?? "open"; // absent = open (spec S2)
  return createCommandLauncher({ state: { kind: "available", backend: backend.name, network }, backend, policyFor });
}

/** The compile-time policy refusal for `raw` (Task 8), or undefined. */
export function rawRefusalFor(launcher: CommandLauncher | undefined): string | undefined {
  return launcher?.state.kind === "unavailable" ? rawBashRefusalReason(launcher.state.reason) : undefined;
}
