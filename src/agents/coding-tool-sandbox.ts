/**
 * The async half of P4's session wiring (spec 5.2, review finding 7).
 *
 * resolveCodingToolSupport is async and awaits this; buildCodingToolSupport is
 * synchronous and on the hot dispatch path, so it only receives the result as
 * data. Nothing here may be called from the sync path.
 */
import { homedir } from "node:os";
import type { SandboxConfig } from "@/config/schemas-sandbox";
import { NaxError } from "@/errors";
import { approvalsPath } from "@/permissions";
import {
  buildSandboxPolicy,
  type CommandLauncher,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  defaultTempRoots,
  listCredentialFiles,
  listFeaturePrdPaths,
  listGitGuardFiles,
  probeSandboxOnce,
  rawBashRefusalReason,
  resolveGitLayout,
  sandboxBackendFor,
  strayCommonDirTripwire,
  warnSandboxUnavailableOnce,
} from "@/sandbox";

export const _sessionSandboxDeps = {
  backendFor: sandboxBackendFor,
  probe: probeSandboxOnce,
  gitLayout: resolveGitLayout,
  featurePrds: listFeaturePrdPaths,
  gitGuardFiles: listGitGuardFiles,
  commonDirTripwire: strayCommonDirTripwire,
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
      // Per build, like the PRDs: a worktree added mid-run gets its denies too.
      gitGuardFiles: await _sessionSandboxDeps.gitGuardFiles(git),
      featurePrdPaths: await _sessionSandboxDeps.featurePrds(root),
      credentialFiles,
      ...(approvalsFile !== undefined ? { approvalsFile } : {}),
      home: _sessionSandboxDeps.homedir(),
      tempRoots: _sessionSandboxDeps.tempRoots(),
      platform: _sessionSandboxDeps.platform(),
      config,
    });
  // Review #17: literal() refuses a glob character in any policy path, and the
  // probe builds its own policy, so a repo path like `re[x]po` passed the probe
  // and then failed every command. Build the policy once here instead.
  // Residual: a feature directory created mid-run with a glob character still
  // fails per command.
  const policyError = await literalPolicyError(policyFor, args.root);
  if (policyError !== undefined) {
    warnSandboxUnavailableOnce(policyError, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: policyError } });
  }
  const afterWrapped = await _sessionSandboxDeps.commonDirTripwire(git, args.storyId);
  const network = config.network.allowedDomains ?? "open"; // absent = open (spec S2)
  return createCommandLauncher({
    state: { kind: "available", backend: backend.name, network },
    backend,
    policyFor,
    ...(afterWrapped !== undefined ? { afterWrapped } : {}),
  });
}

/** The compile-time policy refusal for `raw` (Task 8), or undefined. */
export function rawRefusalFor(launcher: CommandLauncher | undefined): string | undefined {
  return launcher?.state.kind === "unavailable" ? rawBashRefusalReason(launcher.state.reason) : undefined;
}

async function literalPolicyError(
  policyFor: (root: string) => Promise<unknown>,
  root: string,
): Promise<string | undefined> {
  try {
    await policyFor(root);
    return undefined;
  } catch (err) {
    if (err instanceof NaxError && err.code === "SANDBOX_POLICY_NOT_LITERAL") {
      return `[sandbox] a path in the sandbox policy contains a glob character: ${String(err.context?.path ?? "")}`;
    }
    throw err;
  }
}
