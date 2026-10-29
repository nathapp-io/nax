import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as packageRoot from "#src/index";
import * as sandboxBarrel from "#src/sandbox/index";
import { _launcherDeps, createCommandLauncher, DISABLED_SANDBOX_STATE, type SandboxPolicy } from "#src/sandbox/index";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "#test/helpers/index";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-launcher-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

describe("createCommandLauncher", () => {
  withDepsRestore(_launcherDeps);

  test.each([false, true])(
    "AC-9/10: forwards deadline release and output observer (unwrapped=%s)",
    async (unwrapped) => {
      const releaseDeadline = new AbortController().signal;
      const onOutput = (_stream: "stdout" | "stderr", _chunk: Uint8Array): void => {};
      const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
      _launcherDeps.runArgv = async (options) => {
        calls.push(options);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      };
      const launcher = createCommandLauncher({
        state: available,
        backend: makeFakeSandboxBackend("enforce"),
        policyFor: async (r) => policy(r),
      });
      const request = {
        spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" } as const,
        root,
        cwd: root,
        timeoutMs: 1000,
        stripEnvVars: [],
        releaseDeadline,
        onOutput,
        ...(unwrapped ? { unwrapped: true as const } : {}),
      };
      const result = await launcher.run(request);
      expect(result.sandbox.wrapped).toBe(!unwrapped);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({ releaseDeadline, onOutput }));
    },
  );

  test("marker AC-8/9: public exports agree", () => {
    expect("SANDBOXED_ENV" in packageRoot).toBe(true);
    expect("SANDBOXED_ENV" in sandboxBarrel).toBe(true);
    expect(Reflect.get(packageRoot, "SANDBOXED_ENV")).toBe("NAX_SANDBOXED");
    expect(Reflect.get(sandboxBarrel, "SANDBOXED_ENV")).toBe(Reflect.get(packageRoot, "SANDBOXED_ENV"));
  });

  test.each([available, DISABLED_SANDBOX_STATE, { kind: "unavailable", backend: "srt", reason: "no bwrap" } as const])(
    "marker AC-4/5/6: %j only wrapped children are marked",
    async (state) => {
      const saved = process.env.NAX_SANDBOXED;
      const confined = process.env.NAX_TEST_CONFINED;
      delete process.env.NAX_SANDBOXED;
      delete process.env.NAX_TEST_CONFINED;
      try {
        const result = await createCommandLauncher({
          state,
          backend: makeFakeSandboxBackend("enforce"),
          policyFor: async (r) => policy(r),
        }).run({
          spec: { kind: "shell", shell: "/bin/sh", command: "printenv NAX_SANDBOXED" },
          root,
          cwd: root,
          timeoutMs: 5000,
          stripEnvVars: [],
        });
        expect(result.stdout.trim()).toBe(state.kind === "available" ? "1" : "");
        expect(result.sandbox.wrapped).toBe(state.kind === "available");
      } finally {
        if (saved === undefined) delete process.env.NAX_SANDBOXED;
        else process.env.NAX_SANDBOXED = saved;
        if (confined === undefined) delete process.env.NAX_TEST_CONFINED;
        else process.env.NAX_TEST_CONFINED = confined;
      }
    },
  );

  test("marker AC-3/7: quoted argv output and logical shell identity", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const wrapped = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const request = {
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" } as const,
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    };
    const a = await wrapped.run(request);
    const b = await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run(request);
    expect(a.executed).toEqual(b.executed);
    const result = await wrapped.run({ ...request, spec: { kind: "argv", argv: ["echo", "a b"] } });
    expect(backend.calls[1]?.command).toBe("export NAX_SANDBOXED=1; 'echo' 'a b'");
    expect(result.stdout.trim()).toBe("a b");
  });

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

  test("US-002: explicit unwrapped request bypasses wrapping and callbacks with temp overlay", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    let policies = 0;
    let after = 0;
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const backend = makeFakeSandboxBackend("enforce");
    const tmpDir = `${root}/session-tmp`;
    const launcher = createCommandLauncher({
      state: available,
      backend,
      tmpDir,
      policyFor: async (r) => {
        policies += 1;
        return policy(r);
      },
      afterWrapped: async () => {
        after += 1;
      },
    });
    const request = {
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" } as const,
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      unwrapped: true as const,
    };
    const result = await launcher.run(request);
    expect(calls[0]?.argv).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(calls[0]?.env).toEqual({ TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir });
    expect(result.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(result.sandbox).toEqual({ backend: "none", wrapped: false, reason: "requested" });
    expect(backend.calls).toHaveLength(0);
    expect(policies).toBe(0);
    expect(after).toBe(0);
  });

  test.each([
    [DISABLED_SANDBOX_STATE, { backend: "none", wrapped: false, reason: "requested" }],
    [
      { kind: "unavailable", backend: "srt", reason: "no bwrap" } as const,
      { backend: "none", wrapped: false, reason: "requested" },
    ],
  ] as const)("US-002: requested unwrapped record takes precedence for %j state", async (state, expected) => {
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const result = await createCommandLauncher({ state }).run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      unwrapped: true,
    });
    expect(result.sandbox).toEqual(expected);
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
    expect(r.sandbox).toEqual({
      backend: "srt",
      wrapped: true,
      argv: ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo hi"],
    });
    expect(backend.calls[0]?.command).toBe("export NAX_SANDBOXED=1; echo hi");
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
    expect(backend.calls[0]?.command).toBe("export NAX_SANDBOXED=1; 'echo' 'a b' '$(id)'");
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
      argv: ["/bin/sh", "-c", "export NAX_SANDBOXED=1; echo 'x: Operation not permitted' >&2; exit 1"],
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
