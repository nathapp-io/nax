import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _launcherDeps, createCommandLauncher, DISABLED_SANDBOX_STATE, type SandboxPolicy } from "@/sandbox";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-launcher-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

describe("createCommandLauncher", () => {
  withDepsRestore(_launcherDeps);

  test("disabled: byte-identical runArgv arguments to today's Bash spawn", async () => {
    const calls: unknown[] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "bun test" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: ["NPM_TOKEN"],
    });
    expect(calls[0]).toEqual({
      argv: ["/bin/sh", "-c", "bun test"],
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: ["NPM_TOKEN"],
    });
    expect(r.executed).toEqual(["/bin/sh", "-c", "bun test"]);
    expect(r.sandbox).toEqual({ backend: "none", wrapped: false });
  });

  test("disabled argv spec passes the caller's env overlay through (Exec's Yarn overlay)", async () => {
    const calls: { env?: unknown }[] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run({
      spec: { kind: "argv", argv: ["yarn", "add", "x"] },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      env: { YARN_ENABLE_SCRIPTS: "false" },
    });
    expect(calls[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });

  test("available: wraps, runs the wrapper argv, records wrapped", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(r.stdout.trim()).toBe("hi");
    expect(r.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(r.sandbox).toEqual({ backend: "srt", wrapped: true, argv: ["/bin/sh", "-c", "echo hi"] });
    expect(backend.finished).toBe(1);
  });

  test("#2198: afterWrapped runs after every wrapped command, even one that fails to wrap", async () => {
    const trail: string[] = [];
    const run = (backend: ReturnType<typeof makeFakeSandboxBackend>) =>
      createCommandLauncher({
        state: available,
        backend,
        policyFor: async (r) => policy(r),
        afterWrapped: async () => {
          trail.push(`after:${backend.calls.length}`);
        },
      }).run({
        spec: { kind: "shell", shell: "/bin/sh", command: "true" },
        root,
        cwd: root,
        timeoutMs: 5000,
        stripEnvVars: [],
      });
    await run(makeFakeSandboxBackend("enforce"));
    await expect(run(makeFakeSandboxBackend("throw"))).rejects.toThrow(/could not wrap/);
    expect(trail).toEqual(["after:1", "after:1"]);
  });

  test("afterWrapped never runs for an unwrapped (disabled) command", async () => {
    let after = 0;
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const launcher = createCommandLauncher({
      state: DISABLED_SANDBOX_STATE,
      afterWrapped: async () => {
        after += 1;
      },
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
    });
    expect(after).toBe(0);
  });

  test("available: an argv spec is quoted into one shell command", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const r = await launcher.run({
      spec: { kind: "argv", argv: ["echo", "a b", "$(id)"] },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(backend.calls[0]?.command).toBe("'echo' 'a b' '$(id)'");
    expect(r.stdout.trim()).toBe("a b $(id)");
  });

  // A regression PIN, not the F6 proof: the fake never returns an env, so it
  // cannot reproduce the original bug. The proof is the argv-only `wrap`
  // return type plus the live test in Task 12.
  test("F6: a stripped variable stays stripped inside a wrapped command", async () => {
    process.env.NAX_P4_LAUNCHER_SECRET = "s3cret";
    try {
      const launcher = createCommandLauncher({
        state: available,
        backend: makeFakeSandboxBackend("enforce"),
        policyFor: async (r) => policy(r),
      });
      const r = await launcher.run({
        spec: { kind: "shell", shell: "/bin/sh", command: 'echo "[$NAX_P4_LAUNCHER_SECRET]"' },
        root,
        cwd: root,
        timeoutMs: 5000,
        stripEnvVars: ["NAX_P4_LAUNCHER_SECRET"],
      });
      expect(r.stdout.trim()).toBe("[]");
    } finally {
      delete process.env.NAX_P4_LAUNCHER_SECRET;
    }
  });

  test("Review Focus 4: a wrap that throws is an error and NOTHING runs unwrapped", async () => {
    let spawned = 0;
    _launcherDeps.runArgv = async () => {
      spawned += 1;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: available,
      backend: makeFakeSandboxBackend("throw"),
      policyFor: async (r) => policy(r),
    });
    await expect(
      launcher.run({
        spec: { kind: "shell", shell: "/bin/sh", command: "touch x" },
        root,
        cwd: root,
        timeoutMs: 1000,
        stripEnvVars: [],
      }),
    ).rejects.toThrow("[sandbox] could not wrap the command: fake wrap failure");
    expect(spawned).toBe(0);
  });

  test("a likely denial appends the hint line and marks the record", async () => {
    const launcher = createCommandLauncher({
      state: available,
      backend: makeFakeSandboxBackend("enforce"),
      policyFor: async (r) => policy(r),
    });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo 'x: Operation not permitted' >&2; exit 1" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(r.stderr).toContain(
      `note: this command ran in the nax sandbox; that failure may be a sandbox denial -- writable roots: ${root}.`,
    );
    expect(r.sandbox).toEqual({
      backend: "srt",
      wrapped: true,
      denialHint: true,
      argv: ["/bin/sh", "-c", "echo 'x: Operation not permitted' >&2; exit 1"],
    });
  });

  test("a failure that is not a denial gets no hint", async () => {
    const launcher = createCommandLauncher({
      state: available,
      backend: makeFakeSandboxBackend("enforce"),
      policyFor: async (r) => policy(r),
    });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "exit 3" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).not.toContain("note: this command ran");
    expect(r.sandbox.denialHint).toBeUndefined();
  });

  test("unavailable: runs unwrapped and records why", async () => {
    const launcher = createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(r.stdout.trim()).toBe("hi");
    expect(r.sandbox).toEqual({ backend: "srt", wrapped: false, reason: "no bwrap" });
  });

  test("Review Focus 5: cwd is honoured separately from root", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const pkg = `${root}/pkg`;
    Bun.spawnSync(["mkdir", "-p", pkg]);
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "pwd" },
      root,
      cwd: pkg,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(backend.calls[0]?.cwd).toBe(pkg);
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(r.stdout.trim().endsWith("/pkg")).toBe(true);
  });

  test("US-001 AC11: disabled path forwards request.signal to runArgv", async () => {
    const signal = new AbortController().signal;
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      signal,
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  test("US-001 AC11: wrapped path forwards request.signal to runArgv", async () => {
    const signal = new AbortController().signal;
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: available,
      backend: makeFakeSandboxBackend("enforce"),
      policyFor: async (r) => policy(r),
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      signal,
    });
    expect(calls[0]?.signal).toBe(signal);
  });
});
