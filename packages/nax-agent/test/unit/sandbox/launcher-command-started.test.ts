/**
 * #2986 — the launcher tells the backend when the wrapped argv has SPAWNED.
 *
 * bwrap creates its mount-point placeholders at spawn, not inside `wrap`, so the
 * backend can only identify them from a hook that runs after the spawn. The hook
 * rides `runArgv`'s `onSpawn`, and must never fail or delay the command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _launcherDeps, createCommandLauncher, type SandboxBackend, type SandboxPolicy } from "#src/sandbox/index";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-started-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;
const okResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

function backendWith(events: string[], started?: (commandId: string) => void): SandboxBackend {
  return {
    name: "srt",
    async isSupportedPlatform() {
      return true;
    },
    async wrap() {
      events.push("wrap");
      return ["/bin/sh", "-c", "true"];
    },
    annotate() {
      return "";
    },
    ...(started !== undefined ? { commandStarted: started } : {}),
    commandFinished(commandId) {
      events.push(`finished:${commandId}`);
    },
    async reset() {},
  };
}

function runRequest(r: string) {
  return {
    spec: { kind: "shell", shell: "/bin/sh", command: "true" } as const,
    root: r,
    cwd: r,
    timeoutMs: 1000,
    stripEnvVars: [],
  };
}

describe("createCommandLauncher — commandStarted (#2986)", () => {
  withDepsRestore(_launcherDeps);
  beforeEach(() => {
    _launcherDeps.newCommandId = () => "cmd-1";
  });

  test("a run that never spawns still finishes under its own commandId, with no start", async () => {
    _launcherDeps.runArgv = async () => okResult;
    const events: string[] = [];
    await createCommandLauncher({
      state: available,
      backend: backendWith(events, (id) => events.push(`started:${id}`)),
      policyFor: async (p) => policy(p),
    }).run(runRequest(root));
    expect(events).toEqual(["wrap", "finished:cmd-1"]);
  });

  test("the backend hears commandStarted from runArgv's onSpawn, between wrap and finish", async () => {
    const events: string[] = [];
    _launcherDeps.runArgv = async (o) => {
      events.push("spawn");
      o.onSpawn?.();
      events.push("exit");
      return okResult;
    };
    await createCommandLauncher({
      state: available,
      backend: backendWith(events, (id) => events.push(`started:${id}`)),
      policyFor: async (p) => policy(p),
    }).run(runRequest(root));
    expect(events).toEqual(["wrap", "spawn", "started:cmd-1", "exit", "finished:cmd-1"]);
  });

  test("a commandStarted that throws does not fail the command", async () => {
    _launcherDeps.runArgv = async (o) => {
      o.onSpawn?.();
      return okResult;
    };
    const events: string[] = [];
    const r = await createCommandLauncher({
      state: available,
      backend: backendWith(events, () => {
        throw new Error("boom");
      }),
      policyFor: async (p) => policy(p),
    }).run(runRequest(root));
    expect(r.exitCode).toBe(0);
  });

  test("a backend without commandStarted still runs", async () => {
    _launcherDeps.runArgv = async (o) => {
      o.onSpawn?.();
      return okResult;
    };
    const r = await createCommandLauncher({
      state: available,
      backend: backendWith([]),
      policyFor: async (p) => policy(p),
    }).run(runRequest(root));
    expect(r.exitCode).toBe(0);
  });
});
