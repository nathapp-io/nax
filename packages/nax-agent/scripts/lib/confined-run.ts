/**
 * The confined test runner (nax#2523): `bun test <paths>` inside the same OS
 * sandbox a confined agent session gets.
 *
 * Why it exists: nax's own suites must pass inside a confined session, and the
 * only honest way to keep them that way is to run them there. `TMPDIR`/`TMP`/
 * `TEMP` point at the run's own temp root and `NAX_TEST_CONFINED=1` marks the
 * run, so a test writing under a literal `/tmp/...` fails here exactly as it
 * fails in an agent session, while `makeTempDir()` (which resolves through
 * `os.tmpdir()`, and so through `$TMPDIR`) passes.
 *
 * It lives in this package's `scripts/`, not `packages/repo-tooling/scripts/`,
 * because it imports nax-agent's own `src/sandbox` — repo-tooling may not reach
 * into a package's `src/`.
 *
 * The policy is built, never changed: this runner makes the tests fit the
 * confined session's sandbox (the `/tmp` deny, the run temp roots, the network
 * rules), never the reverse.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "#src/config/schemas-sandbox";
import { getGitRoot } from "#src/internal/git-exec";
import { type AgentSpawnOptions, type AgentSpawnResult, runtimeSpawn } from "#src/runtime/index";
import type { ProbeResult, SandboxBackend, SandboxPolicy, SandboxWrapRequest } from "#src/sandbox/index";
import {
  buildSandboxPolicy,
  createSrtBackend,
  listCredentialFiles,
  listGitGuardFiles,
  listNaxEntries,
  probeSandbox,
  quoteArgvForShell,
  resolveGitLayout,
  runTempRoots,
} from "#src/sandbox/index";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";

/** The marker the runner exports so a test can tell it is running confined. */
export const CONFINED_TEST_ENV = "NAX_TEST_CONFINED";

/** No usable sandbox backend: no test ran, and nax never falls back unsandboxed. */
export const SANDBOX_UNAVAILABLE_EXIT = 3;

/** The CLI was called with nothing to run. */
export const USAGE_EXIT = 2;

/** Per-test timeout, matching this package's own `test` script. */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** The shell srt wraps, as the launcher uses for a non-shell spec. */
const CONFINED_RUN_SHELL = "/bin/sh";

/** The project state directory whose entries a confined session cannot write. */
const PROJECT_STATE_DIR = ".nax";

/** nax's global config directory, relative to `$HOME` — where its credential files live. */
const GLOBAL_CONFIG_DIR = ".nax";

/** A byte sink: `process.stdout`, or a recorder in a test. */
export interface ConfinedStream {
  write(chunk: string | Uint8Array): unknown;
}

export interface ConfinedPolicyInput {
  readonly repoRoot: string;
  readonly runTmpRoot: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}

export interface ConfinedCommandInput {
  readonly packageDir: string;
  readonly tmpDir: string;
  readonly paths: readonly string[];
  readonly timeoutMs: number;
}

export interface ConfinedRunInput {
  readonly packageDir: string;
  readonly paths: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * A type alias, not an interface: `withDepsRestore` takes a `Record<string, unknown>`,
 * and only an aliased/anonymous object type carries the implicit index signature
 * that satisfies it (an interface does not).
 *
 * The members are deliberately mutable — that is what a `_deps` seam is for.
 */
export type ConfinedRunDeps = {
  backend: (network: SandboxConfig["network"]) => SandboxBackend;
  probe: (backend: SandboxBackend) => Promise<ProbeResult>;
  gitRoot: (dir: string) => Promise<string | null>;
  spawn: (cmd: readonly string[], opts: AgentSpawnOptions) => AgentSpawnResult;
  mkdir: (path: string) => Promise<unknown>;
  rm: (path: string) => Promise<unknown>;
  tmpdir: () => string;
  homedir: () => string;
  platform: () => NodeJS.Platform;
  stdout: ConfinedStream;
  stderr: ConfinedStream;
};

export const _confinedRunDeps: ConfinedRunDeps = {
  backend: (network: SandboxConfig["network"]): SandboxBackend => createSrtBackend(network),
  probe: (backend: SandboxBackend): Promise<ProbeResult> => probeSandbox(backend),
  gitRoot: (dir: string): Promise<string | null> => getGitRoot(dir),
  spawn: (cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult => runtimeSpawn(cmd, opts),
  mkdir: (path: string): Promise<unknown> => mkdir(path, { recursive: true }),
  rm: (path: string): Promise<unknown> => rm(path, { recursive: true, force: true }),
  tmpdir,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * The confined policy for one test run: `buildSandboxPolicy` with the same
 * `confined: true` a confined agent session resolves, so a test that fails
 * here fails there.
 *
 * Two inputs differ from a session's, both deliberately. The git layout,
 * guard files, project-state entries and credential files are read here
 * rather than passed in — this is a standalone script, not a dispatch. And
 * `repoRoot` is the work tree the package lives in, so the `.nax/` denies and
 * the git guards cover the tree a test run could otherwise write.
 */
export async function confinedTestPolicy(input: ConfinedPolicyInput): Promise<SandboxPolicy> {
  const git = await resolveGitLayout(input.repoRoot);
  return buildSandboxPolicy({
    root: input.repoRoot,
    git,
    gitGuardFiles: await listGitGuardFiles(git),
    naxEntries: await listNaxEntries(input.repoRoot, PROJECT_STATE_DIR),
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    projectStateDir: PROJECT_STATE_DIR,
    credentialFiles: await listCredentialFiles(join(input.home, GLOBAL_CONFIG_DIR)),
    home: input.home,
    // runTempRoots drops the host tmpdir when it IS the shared one, so the run
    // root is all a confined test may write to.
    tempRoots: runTempRoots({ runTmpRoot: input.runTmpRoot, tmpdir: _confinedRunDeps.tmpdir() }),
    confined: true,
    platform: input.platform,
    config: DEFAULT_SANDBOX_CONFIG,
  });
}

/**
 * The command the sandbox runs: the run's `TMPDIR`/`TMP`/`TEMP`, the confined
 * marker, then `bun test` from the package directory.
 *
 * The temp exports ride the command rather than an env overlay because srt
 * replaces the child's environment wholesale (the launcher's own reason for
 * its `export TMPDIR=…` prefix).
 */
export function confinedTestCommand(input: ConfinedCommandInput): string {
  const tmpDir = quoteArgvForShell([input.tmpDir]);
  const paths = quoteArgvForShell(input.paths);
  const cd = quoteArgvForShell([input.packageDir]);
  return (
    `export TMPDIR=${tmpDir} TMP=${tmpDir} TEMP=${tmpDir} ${CONFINED_TEST_ENV}=1; ` +
    `cd ${cd} && bun test ${paths} --timeout=${input.timeoutMs}`
  );
}

/** Is the srt backend built from the default config usable on this host? */
export function probeConfinedSandbox(): Promise<ProbeResult> {
  return _confinedRunDeps.probe(_confinedRunDeps.backend(DEFAULT_SANDBOX_CONFIG.network));
}

/** `/tmp/nax/confined-<pid>-<random>`, under the shared temp parent the session temp dirs use. */
function newRunIds(): { runTmpRoot: string; commandId: string } {
  const random = randomUUID().replaceAll("-", "").slice(0, 8);
  return { runTmpRoot: `/tmp/nax/confined-${process.pid}-${random}`, commandId: `nax-confined-tests-${random}` };
}

/** Copy the child's stdout through to the sink, chunk by chunk, as it arrives. */
async function pumpStdout(stream: ReadableStream<Uint8Array>, sink: ConfinedStream): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) return;
      if (value !== undefined) sink.write(value);
    }
  } catch {
    // A closed or errored display pipe must not change the run's exit code;
    // whatever was copied before the error is already in the sink.
  }
}

/** Remove the run root; a failure here is ignored (the exit code is the test run's). */
async function removeRunRoot(runTmpRoot: string): Promise<void> {
  try {
    await _confinedRunDeps.rm(runTmpRoot);
  } catch {
    // Deliberate, and the spec's ruling: nothing a caller could do with the
    // failure improves the run, and the tests' own result still stands.
  }
}

/**
 * Run `bun test <paths>` for `packageDir` inside the confined sandbox and
 * return the run's exit code.
 *
 * The session temp dir is created before the policy that grants it (as
 * `resolveSessionSandbox` does), the backend is released with
 * `commandFinished` then `reset`, and the run root is removed on every path —
 * including a non-zero exit, a failing spawn, and a backend whose release path
 * throws (the removal is nested inside the release's own `finally`).
 */
export async function runConfinedTests(input: ConfinedRunInput): Promise<number> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const backend = _confinedRunDeps.backend(DEFAULT_SANDBOX_CONFIG.network);
  const probe = await _confinedRunDeps.probe(backend);
  if (!probe.available) {
    _confinedRunDeps.stderr.write(`sandbox unavailable: ${probe.reason}\n`);
    return SANDBOX_UNAVAILABLE_EXIT;
  }
  // A package outside a git work tree is still runnable: the policy is then
  // built on the package directory itself.
  const repoRoot = (await _confinedRunDeps.gitRoot(input.packageDir)) ?? input.packageDir;
  const { runTmpRoot, commandId } = newRunIds();
  const tmpDir = `${runTmpRoot}/s`;
  await _confinedRunDeps.mkdir(tmpDir);
  try {
    const policy = await confinedTestPolicy({
      repoRoot,
      runTmpRoot,
      home: _confinedRunDeps.homedir(),
      platform: _confinedRunDeps.platform(),
    });
    const request: SandboxWrapRequest = {
      command: confinedTestCommand({ packageDir: input.packageDir, tmpDir, paths: input.paths, timeoutMs }),
      shell: CONFINED_RUN_SHELL,
      policy,
      cwd: input.packageDir,
      commandId,
    };
    const argv = await backend.wrap(request);
    const child = _confinedRunDeps.spawn(argv, {
      cwd: input.packageDir,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    });
    const [exitCode] = await Promise.all([child.exited, pumpStdout(child.stdout, _confinedRunDeps.stdout)]);
    return exitCode;
  } finally {
    try {
      backend.commandFinished();
      await backend.reset();
    } finally {
      // Nested (F3): the run root is this runner's OWN temp data, so a backend
      // whose release path throws must not be able to leave it behind. The
      // release error still propagates — a backend that cannot reset is a
      // malfunction worth surfacing — but only after the root is gone.
      await removeRunRoot(runTmpRoot);
    }
  }
}
