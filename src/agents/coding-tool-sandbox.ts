/**
 * The async half of P4's session wiring (spec 5.2, review finding 7).
 *
 * resolveCodingToolSupport is async and awaits this; buildCodingToolSupport is
 * synchronous and on the hot dispatch path, so it only receives the result as
 * data. Nothing here may be called from the sync path.
 */
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type { SandboxConfig } from "@/config/schemas-sandbox";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { approvalsPath } from "@/permissions";
import {
  buildSandboxPolicy,
  type CommandLauncher,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  defaultTempRoots,
  listCredentialFiles,
  listGitGuardFiles,
  listNaxEntries,
  probeSandboxOnce,
  rawBashRefusalReason,
  resolveGitLayout,
  runTempRoots,
  sandboxBackendFor,
  strayCommonDirTripwire,
  warnSandboxUnavailableOnce,
} from "@/sandbox";
import { errorMessage } from "@/utils/errors";

export const _sessionSandboxDeps = {
  backendFor: sandboxBackendFor,
  probe: probeSandboxOnce,
  gitLayout: resolveGitLayout,
  naxEntries: listNaxEntries,
  gitGuardFiles: listGitGuardFiles,
  commonDirTripwire: strayCommonDirTripwire,
  credentialFiles: listCredentialFiles,
  tempRoots: defaultTempRoots,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
  /** US-002 — creates the session temp dir before the policy is built. */
  mkdir: (path: string): Promise<unknown> => mkdir(path, { recursive: true }),
  /** US-002 — the host temp dir, kept injectable so the policy choice is testable. */
  tmpdir: (): string => tmpdir(),
  /** US-002 — the temp roots of one confined run, given its own root. */
  runTempRoots,
};

/** The temp roots a session's policy grants, and whether they are run-confined. */
interface SessionTempRoots {
  readonly tempRoots: readonly string[];
  readonly confined: boolean;
}

/**
 * US-002: which temp roots a session's policy grants.
 *
 * Shared roots are today's behaviour and the fallback: the opt-out
 * (`allowSharedTmp`), a session with no run root, and a failed directory
 * creation all land there.
 *
 * Confinement needs both `runTmpRoot` and `tmpDir` — the session temp dir the
 * launcher exports as TMPDIR is no more writable than `/tmp` is, so it has to
 * be created here, BEFORE the policy that grants it. A creation failure fails
 * OPEN to the shared roots: a session must never run with a TMPDIR its own
 * sandbox cannot write.
 */
async function sessionTempRoots(args: {
  readonly config: SandboxConfig;
  readonly storyId?: string;
  readonly runTmpRoot?: string;
  readonly tmpDir?: string;
}): Promise<SessionTempRoots> {
  const { runTmpRoot, tmpDir } = args;
  const shared = (): SessionTempRoots => ({ tempRoots: _sessionSandboxDeps.tempRoots(), confined: false });
  if (args.config.filesystem.allowSharedTmp || runTmpRoot === undefined || tmpDir === undefined) return shared();
  try {
    await _sessionSandboxDeps.mkdir(tmpDir);
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "could not create the session temp dir — granting the shared temp roots", {
      storyId: args.storyId ?? "_dispatch",
      tmpDir,
      error: errorMessage(err),
    });
    return shared();
  }
  return {
    tempRoots: _sessionSandboxDeps.runTempRoots({ runTmpRoot, tmpdir: _sessionSandboxDeps.tmpdir() }),
    confined: true,
  };
}

export async function resolveSessionSandbox(args: {
  readonly config: SandboxConfig | undefined;
  readonly root: string;
  readonly outputDir?: string;
  readonly needsLauncher: boolean;
  readonly storyId?: string;
  /** US-004 — per-session temp directory the launcher creates and exports as TMPDIR/TMP/TEMP. */
  readonly tmpDir?: string;
  /** US-002 — the run's own temp root, present whenever `tmpDir` is (dispatch-supplied). */
  readonly runTmpRoot?: string;
}): Promise<CommandLauncher> {
  const config = args.config;
  if (config === undefined || !config.enabled || !args.needsLauncher) {
    return createCommandLauncher({
      state: DISABLED_SANDBOX_STATE,
      ...(args.tmpDir !== undefined ? { tmpDir: args.tmpDir } : {}),
    });
  }
  const backend = _sessionSandboxDeps.backendFor(config);
  const probe = await _sessionSandboxDeps.probe(backend, args.storyId);
  if (!probe.available) {
    warnSandboxUnavailableOnce(probe.reason, args.storyId);
    return createCommandLauncher({
      state: { kind: "unavailable", backend: backend.name, reason: probe.reason },
      ...(args.tmpDir !== undefined ? { tmpDir: args.tmpDir } : {}),
    });
  }
  const git = await _sessionSandboxDeps.gitLayout(args.root);
  const credentialFiles = await _sessionSandboxDeps.credentialFiles();
  const approvalsFile = args.outputDir !== undefined ? approvalsPath(args.outputDir) : undefined;
  // Before the policy: the confined roots include the session temp dir itself.
  const { tempRoots, confined } = await sessionTempRoots({
    config,
    storyId: args.storyId,
    runTmpRoot: args.runTmpRoot,
    tmpDir: args.tmpDir,
  });
  const policyFor = async (root: string, tmpDirInForce: boolean) =>
    buildSandboxPolicy({
      root,
      git,
      // Per build, like the .nax entries: a worktree added mid-run gets its denies too.
      gitGuardFiles: await _sessionSandboxDeps.gitGuardFiles(git),
      naxEntries: await _sessionSandboxDeps.naxEntries(root),
      credentialFiles,
      ...(approvalsFile !== undefined ? { approvalsFile } : {}),
      home: _sessionSandboxDeps.homedir(),
      tempRoots,
      // #2301: the RESOLVED confinement, not `config.filesystem.allowSharedTmp`.
      // A session confines only when that opt-out is off, a run root AND a
      // session dir were both supplied, and the dir was actually created; the
      // config flag is false in the fail-open and no-run-root cases too, so
      // reading it here would deny a session that is running on the shared roots.
      //
      // Narrowed by whether THIS command will actually get the session's
      // `TMPDIR`. `createCommandLauncher` recreates the session dir before every
      // run and drops the `export TMPDIR=…` prefix when that creation fails
      // (src/sandbox/launcher.ts), and then srt's own `/tmp/claude` is the
      // child's TMPDIR — denying it would leave the session with a TMPDIR its
      // own sandbox refuses to write, the one posture
      // SPEC-tmp-confinement.md:132 rules out.
      confined: confined && tmpDirInForce,
      platform: _sessionSandboxDeps.platform(),
      config,
    });
  // Review #17: literal() refuses a glob character in any policy path, and the
  // probe builds its own policy, so a repo path like `re[x]po` passed the probe
  // and then failed every command. Build the policy once here instead.
  // The old residual (a glob-named feature dir created mid-run failing every
  // command) is gone: listNaxEntries skips glob-named `.nax` entries (nax#2260).
  const policyError = await literalPolicyError(policyFor, args.root, confined);
  if (policyError !== undefined) {
    warnSandboxUnavailableOnce(policyError, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: policyError } });
  }
  const afterWrapped = await _sessionSandboxDeps.commonDirTripwire(git, args.storyId);
  const network = config.network.allowedDomains ?? "open"; // absent = open (spec S2)
  return createCommandLauncher({
    // `sharedTmp` is present only when confined: absent means the shared temp
    // roots are writable, which is what every pre-US-002 launcher says.
    state: { kind: "available", backend: backend.name, network, ...(confined ? { sharedTmp: false } : {}) },
    backend,
    policyFor,
    ...(afterWrapped !== undefined ? { afterWrapped } : {}),
    ...(args.tmpDir !== undefined ? { tmpDir: args.tmpDir } : {}),
  });
}

/** The compile-time policy refusal for `raw` (Task 8), or undefined. */
export function rawRefusalFor(launcher: CommandLauncher | undefined): string | undefined {
  return launcher?.state.kind === "unavailable" ? rawBashRefusalReason(launcher.state.reason) : undefined;
}

/**
 * US-004: whether the session's sandbox confines temp writes to this run's own
 * temp root.
 *
 * True exactly when the launcher is available AND says `sharedTmp: false` —
 * the only state under which the command guard may skip the classifier for a
 * temp-only command. An available launcher without `sharedTmp`, an unavailable
 * or disabled one, and no launcher at all all read as NOT confined.
 */
export function isTempConfined(launcher: CommandLauncher | undefined): boolean {
  return launcher?.state.kind === "available" && launcher.state.sharedTmp === false;
}

/**
 * US-002: the raw-screen options `compileToolPolicy` consumes, derived from the
 * launcher's state.
 *
 * `rawBashRefusal` is exactly what `rawRefusalFor` returns (an unavailable
 * launcher refuses every call). `sandboxWrapped: true` is added for an available
 * launcher: the command really does run inside the OS sandbox, so the raw screen
 * stops refusing a feature PRD the command only READS. A disabled launcher
 * yields neither key.
 */
export function rawScreenOptionsFor(launcher: CommandLauncher | undefined): {
  rawBashRefusal?: string;
  sandboxWrapped?: true;
} {
  if (launcher?.state.kind === "available") return { sandboxWrapped: true };
  const rawBashRefusal = rawRefusalFor(launcher);
  return rawBashRefusal !== undefined ? { rawBashRefusal } : {};
}

/**
 * The compile-time policy refusal for `raw` (Task 8), or undefined.
 *
 * Builds the policy the session confines with, i.e. the one every launch gets
 * while its `TMPDIR` override holds; the denial list it adds under a narrower
 * confinement (#2301) is two fixed literals that can never fail `literal()`.
 */
async function literalPolicyError(
  policyFor: (root: string, tmpDirInForce: boolean) => Promise<unknown>,
  root: string,
  tmpDirInForce: boolean,
): Promise<string | undefined> {
  try {
    await policyFor(root, tmpDirInForce);
    return undefined;
  } catch (err) {
    if (err instanceof NaxError && err.code === "SANDBOX_POLICY_NOT_LITERAL") {
      return `[sandbox] a path in the sandbox policy contains a glob character: ${String(err.context?.path ?? "")}`;
    }
    throw err;
  }
}
