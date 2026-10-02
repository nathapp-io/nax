/**
 * US-004 — the launcher's per-session temp directory.
 *
 * `createCommandLauncher` with `tmpDir` set must (a) create it recursively
 * before every run, (b) hand the child `TMPDIR` / `TMP` / `TEMP` pointing at
 * it, and (c) still record the LOGICAL argv so the tool-audit ledger shows
 * what the agent wrote, not the shim nax prepended to the wrapped command.
 *
 * The wrapped case prefixes the shell command rather than the env because srt
 * replaces the child environment — an argv-only `env` overlay would be lost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _launcherDeps,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  type SandboxPolicy,
} from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore, withWarnSpy } from "@test/helpers";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-session-tmp-");
});
afterEach(() => cleanupTempDir(root));

const OK = { exitCode: 0, stdout: "", stderr: "", timedOut: false } as const;
const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

function shellRequest(command: string, env?: Readonly<Record<string, string>>) {
  return {
    spec: { kind: "shell", shell: "/bin/sh", command } as const,
    root,
    cwd: root,
    timeoutMs: 5000,
    stripEnvVars: [] as readonly string[],
    ...(env !== undefined ? { env } : {}),
  };
}

/** A runArgv stub that records every call. */
function recordingRunArgv(calls: Parameters<typeof _launcherDeps.runArgv>[0][]) {
  _launcherDeps.runArgv = async (o) => {
    calls.push(o);
    return OK;
  };
}

describe("createCommandLauncher — per-session TMPDIR (US-004)", () => {
  withDepsRestore(_launcherDeps);

  test("US-004 AC4: a disabled launcher with tmpDir T sets TMPDIR, TMP and TEMP to T", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);
    const tmpDir = join(root, "session-tmp");

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(shellRequest("echo hi"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toEqual({ TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir });
  });

  test("US-004 AC4 boundary: an unavailable launcher also sets TMPDIR", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);
    const tmpDir = join(root, "session-tmp");

    await createCommandLauncher({
      state: { kind: "unavailable", backend: "srt", reason: "no bwrap" },
      tmpDir,
    }).run(shellRequest("echo hi"));

    expect(calls[0]?.env?.TMPDIR).toBe(tmpDir);
  });

  test("US-004 AC5: a request's own TMPDIR wins over the tmpDir overlay", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);
    const tmpDir = join(root, "session-tmp");

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(
      shellRequest("echo hi", { TMPDIR: "X" }),
    );

    // Exec's Yarn overlay must keep winning for the keys it names, or nax would
    // silently overwrite a caller-supplied env var.
    expect(calls[0]?.env?.TMPDIR).toBe("X");
  });

  test("US-004 AC6: an available launcher prefixes the wrapped command with the TMPDIR exports", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);
    const backend = makeFakeSandboxBackend("enforce");
    const tmpDir = join(root, "session-tmp");

    await createCommandLauncher({
      state: available,
      backend,
      policyFor: async (r) => policy(r),
      tmpDir,
    }).run(shellRequest("echo hi"));

    expect(backend.calls[0]?.command).toBe(`export TMPDIR='${tmpDir}' TMP='${tmpDir}' TEMP='${tmpDir}'; echo hi`);
  });

  test("US-004 AC7: executed stays the logical argv of the unprefixed command", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);
    const tmpDir = join(root, "session-tmp");

    const result = await createCommandLauncher({
      state: available,
      backend: makeFakeSandboxBackend("enforce"),
      policyFor: async (r) => policy(r),
      tmpDir,
    }).run(shellRequest("echo hi"));

    // The tool-audit ledger records what the agent wrote, not the shim.
    expect(result.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test("US-004 AC8: a launcher creates its tmpDir recursively before the command runs", async () => {
    const tmpDir = join(root, "deep", "nested", "session-tmp");
    let existedBeforeSpawn: boolean | undefined;
    _launcherDeps.runArgv = async () => {
      existedBeforeSpawn = existsSync(tmpDir);
      return OK;
    };
    expect(existsSync(tmpDir)).toBe(false);

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(shellRequest("echo hi"));

    expect(existedBeforeSpawn).toBe(true);
    expect(existsSync(tmpDir)).toBe(true);
  });

  test("US-004 AC9: an uncreatable tmpDir is warned about and the command runs with no TMPDIR", async () => {
    // A file where a directory would have to be makes the recursive mkdir fail
    // for real, without depending on how the creation call is injected.
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const tmpDir = join(blocker, "session-tmp");
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);

    await withWarnSpy(async (warnSpy) => {
      const result = await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(
        shellRequest("echo hi"),
      );

      // The command still runs — a temp directory must never wedge a command.
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.env?.TMPDIR).toBeUndefined();

      const warned = warnSpy.mock.calls.find(
        (call) =>
          call[0] === "sandbox" && /could not create session temp dir — running without TMPDIR override/.test(call[1]),
      );
      expect(warned).toBeDefined();
    });
  });

  test("US-004 AC10: a launcher with no tmpDir passes no env for a request with no env", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    recordingRunArgv(calls);

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run(shellRequest("echo hi"));

    expect(calls[0]?.env).toBeUndefined();
  });

  test("US-004 AC14: the spawned command really sees TMPDIR set to the session directory", async () => {
    // Real runArgv, real child: the env overlay has to survive to the process.
    const tmpDir = join(root, "session-tmp");

    const result = await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(
      shellRequest('echo "$TMPDIR"'),
    );

    expect(result.stdout.trim()).toBe(tmpDir);
  });
});
