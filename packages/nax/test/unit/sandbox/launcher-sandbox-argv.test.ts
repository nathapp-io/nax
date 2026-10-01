/**
 * US-002 — the wrapped sandbox argv is recorded on `LaunchResult.sandbox.argv`,
 * alongside the unchanged logical `executed`.
 *
 * Kept out of launcher.test.ts so the wrapped-argv concern has its own home;
 * the exact-equality assertions in launcher.test.ts were updated in the same
 * change to carry the new field.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import {
  _launcherDeps,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  type SandboxBackend,
  type SandboxPolicy,
  type SandboxWrapRequest,
} from "@/sandbox";

/** The wrapper a macOS srt backend produces for the shell request `echo hi`. */
const WRAPPED_ARGV = ["sandbox-exec", "-p", "PROFILE", "/bin/sh", "-c", "echo hi"] as const;

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-argv-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

/** A backend whose `wrap` resolves `argv` verbatim and records every request. */
function recordingBackend(argv: readonly string[]): SandboxBackend & { calls: SandboxWrapRequest[] } {
  const calls: SandboxWrapRequest[] = [];
  return {
    name: "srt",
    calls,
    async isSupportedPlatform() {
      return true;
    },
    async wrap(req) {
      calls.push(req);
      return argv;
    },
    annotate() {
      return "";
    },
    commandFinished() {},
    async reset() {},
  };
}

const okResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

describe("createCommandLauncher — wrapped sandbox argv (US-002)", () => {
  withDepsRestore(_launcherDeps);

  test("AC1: an available launcher records the argv the backend wrapped", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const r = await createCommandLauncher({
      state: available,
      backend: recordingBackend(WRAPPED_ARGV),
      policyFor: async (p) => policy(p),
    }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(r.sandbox.argv).toEqual([...WRAPPED_ARGV]);
  });

  test("AC2: the recording runArgv receives the wrapped argv", async () => {
    const seen: { argv: readonly string[] }[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return okResult;
    };
    await createCommandLauncher({
      state: available,
      backend: recordingBackend(WRAPPED_ARGV),
      policyFor: async (p) => policy(p),
    }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(seen[0]?.argv).toEqual([...WRAPPED_ARGV]);
  });

  test("AC3: executed stays the logical argv on the wrapped path", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const r = await createCommandLauncher({
      state: available,
      backend: recordingBackend(WRAPPED_ARGV),
      policyFor: async (p) => policy(p),
    }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(r.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test("AC4: an argv request keeps executed logical and records the wrapped argv", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const r = await createCommandLauncher({
      state: available,
      backend: recordingBackend(WRAPPED_ARGV),
      policyFor: async (p) => policy(p),
    }).run({
      spec: { kind: "argv", argv: ["bun", "test"] },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(r.executed).toEqual(["bun", "test"]);
    expect(r.sandbox.argv).toEqual([...WRAPPED_ARGV]);
  });

  test("AC5: a disabled launcher's sandbox record has no argv key", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const r = await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(r.sandbox).toEqual({ backend: "none", wrapped: false });
    expect("argv" in r.sandbox).toBe(false);
  });

  test("AC6: an unavailable launcher's sandbox record has no argv key", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const r = await createCommandLauncher({
      state: { kind: "unavailable", backend: "srt", reason: "no bwrap" },
    }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect("argv" in r.sandbox).toBe(false);
  });

  test("AC7: a sandbox-denial exit keeps denialHint and still records the wrapped argv", async () => {
    _launcherDeps.runArgv = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "bwrap: Can't mount proc on /proc: Operation not permitted",
      timedOut: false,
    });
    const r = await createCommandLauncher({
      state: available,
      backend: recordingBackend(WRAPPED_ARGV),
      policyFor: async (p) => policy(p),
    }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(r.sandbox.denialHint).toBe(true);
    expect(r.sandbox.argv).toEqual([...WRAPPED_ARGV]);
  });

  test("AC9: a wrap that throws rejects with SANDBOX_WRAP_FAILED and runs nothing", async () => {
    let runArgvCalls = 0;
    _launcherDeps.runArgv = async () => {
      runArgvCalls += 1;
      return okResult;
    };
    let caught: unknown;
    try {
      await createCommandLauncher({
        state: available,
        backend: makeFakeSandboxBackend("throw"),
        policyFor: async (p) => policy(p),
      }).run({
        spec: { kind: "shell", shell: "/bin/sh", command: "touch x" },
        root,
        cwd: root,
        timeoutMs: 1000,
        stripEnvVars: [],
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("SANDBOX_WRAP_FAILED");
    expect(runArgvCalls).toBe(0);
  });
});
