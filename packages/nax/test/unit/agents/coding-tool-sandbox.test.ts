import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  type ConfinedSessionSeam,
  cleanupTempDir,
  makeFakeSandboxBackend,
  makeTempDir,
  NON_SHARED_TMPDIR,
  POLICY_BUILT,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
  withWarnSpy,
} from "@test/helpers";
import { _sessionSandboxDeps, rawRefusalFor, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { naxProtectedPaths } from "@/agents/nax-protected-paths";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "@/config/schemas-sandbox";
import { _launcherDeps, _resetSandboxRegistryForTests, type LaunchRequest, type SandboxPolicy } from "@/sandbox";
import { trustStorePath } from "@/trust";
import { realOrRaw } from "@/utils/realpath";

let root: string;
beforeEach(() => {
  root = makeTempDir("session-sbx-");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const enabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
const disabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: false };

describe("resolveSessionSandbox", () => {
  withDepsRestore(_sessionSandboxDeps);
  // US-004: the launcher the resolver builds is exercised through its own seam.
  withDepsRestore(_launcherDeps);

  test("US-004 AC11: a disabled config with tmpDir T makes its launcher run with TMPDIR T", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const tmpDir = join(root, "session-tmp");

    const launcher = await resolveSessionSandbox({
      config: disabled,
      root,
      needsLauncher: true,
      tmpDir,
      protectedPaths: naxProtectedPaths(),
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });

    expect(launcher.state).toEqual({ kind: "disabled" });
    expect(calls[0]?.env?.TMPDIR).toBe(tmpDir);
  });

  test("US-004 AC11 boundary: without tmpDir the resolved launcher sets no TMPDIR", async () => {
    const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const launcher = await resolveSessionSandbox({
      config: disabled,
      root,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });

    expect(calls[0]?.env?.TMPDIR).toBeUndefined();
  });

  test("disabled config: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({
      config: disabled,
      root,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    expect(l.state).toEqual({ kind: "disabled" });
    expect(probes).toBe(0);
  });

  test("enabled but no Bash/Exec declared: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: false,
      protectedPaths: naxProtectedPaths(),
    });
    expect(l.state.kind).toBe("disabled");
    expect(probes).toBe(0);
  });

  test("enabled + available: policy carries the approvals file and the story root", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    const outputDir = `${root}/out`;
    const l = await resolveSessionSandbox({
      config: enabled,
      root,
      outputDir,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    expect(l.state).toEqual({ kind: "available", backend: "srt", network: "open" });
    await l.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    const policy = backend.calls[0]?.policy;
    expect(policy?.denyWrite.some((p) => p.endsWith("/out/approvals.json"))).toBe(true);
    expect(policy?.writeRoots).toContain(realOrRaw(root));
  });

  test("#2198: every policy carries the git guard files, and the commondir tripwire runs after each command", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${root}/.git` });
    const sibling = `${root}/.git/worktrees/US-002/commondir`;
    _sessionSandboxDeps.gitGuardFiles = async () => [sibling];
    let tripped = 0;
    _sessionSandboxDeps.commonDirTripwire = async () => async () => {
      tripped += 1;
    };
    const l = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    const req = {
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    } as const;
    await l.run(req);
    await l.run(req);
    expect(backend.calls[0]?.policy.denyWrite).toContain(realOrRaw(sibling));
    expect(tripped).toBe(2);
  });

  test("US-006 AC15: the enabled session launcher denies the trust store in its backend policy", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    const launcher = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(backend.calls[0]?.policy.denyWrite).toContain(realOrRaw(trustStorePath()));
  });

  test("enabled + unavailable: unavailable launcher and a raw refusal", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no bwrap" });
    const l = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    expect(l.state).toEqual({ kind: "unavailable", backend: "srt", reason: "no bwrap" });
    expect(rawRefusalFor(l)).toContain("sandbox unavailable (no bwrap)");
  });

  test("#17: a glob character in the root makes the sandbox unavailable at session start", async () => {
    const globRoot = join(root, "re[x]po");
    mkdirSync(globRoot);
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${globRoot}/.git` });
    _sessionSandboxDeps.gitGuardFiles = async () => [];
    const l = await resolveSessionSandbox({
      config: enabled,
      root: globRoot,
      needsLauncher: true,
      protectedPaths: naxProtectedPaths(),
    });
    expect(l.state.kind).toBe("unavailable");
    expect(l.state.kind === "unavailable" ? l.state.reason : "").toContain("re[x]po");
    expect(rawRefusalFor(l)).toBeDefined();
  });

  test("#17: a policy error that is not a glob still propagates", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${root}/.git` });
    _sessionSandboxDeps.naxEntries = async () => {
      throw new Error("boom");
    };
    await expect(
      resolveSessionSandbox({ config: enabled, root, needsLauncher: true, protectedPaths: naxProtectedPaths() }),
    ).rejects.toThrow("boom");
  });

  test("rawRefusalFor is undefined unless unavailable", () => {
    expect(rawRefusalFor(undefined)).toBeUndefined();
  });
});

describe("resolveSessionSandbox — US-002 confined run temp roots", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_launcherDeps);

  beforeEach(() => {
    // The launcher's own seams: nothing here may spawn a process or create a
    // directory under the real /tmp.
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    _launcherDeps.mkdir = async () => undefined;
  });

  const RUN_TMP_ROOT = "/tmp/nax/r1";
  const SESSION_TMP_DIR = "/tmp/nax/r1/s";

  function sandboxConfig(allowSharedTmp: boolean): SandboxConfig {
    return {
      ...DEFAULT_SANDBOX_CONFIG,
      enabled: true,
      filesystem: { ...DEFAULT_SANDBOX_CONFIG.filesystem, allowSharedTmp },
    };
  }

  /** The confined-session setup: an enabled sandbox and a run root plus session dir. */
  const confinedArgs = () => ({
    config: sandboxConfig(false),
    root,
    needsLauncher: true,
    runTmpRoot: RUN_TMP_ROOT,
    tmpDir: SESSION_TMP_DIR,
    protectedPaths: naxProtectedPaths(),
  });

  /** The same setup with neither a run root nor a session dir supplied. */
  const sharedArgs = () => ({
    config: sandboxConfig(false),
    root,
    needsLauncher: true,
    protectedPaths: naxProtectedPaths(),
  });

  function launchRequest(): LaunchRequest {
    return {
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    };
  }

  /** The policy the fake backend was handed on its first wrap. */
  function wrappedPolicy(seam: ConfinedSessionSeam): SandboxPolicy {
    const call = seam.backend.calls[0];
    assertDefined(call, "the request backend.wrap received");
    return call.policy;
  }

  test("US-002 AC7: the confined launcher is available and its temp roots are not shared", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);

    const launcher = await resolveSessionSandbox(confinedArgs());

    expect(launcher.state).toEqual({ kind: "available", backend: "srt", network: "open", sharedTmp: false });
  });

  test("US-002 AC8: the session temp dir is created before the policy is built", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);

    await resolveSessionSandbox(confinedArgs());

    expect(seam.mkdirCalls).toContain(SESSION_TMP_DIR);
    expect(seam.events.indexOf(`mkdir:${SESSION_TMP_DIR}`)).toBeLessThan(seam.events.indexOf(POLICY_BUILT));
  });

  test("US-002 AC9: the policy grants the run temp root, asked for with the host tmpdir", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    expect(wrappedPolicy(seam).writeRoots).toContain(realOrRaw(RUN_TMP_ROOT));
    expect(seam.runTempRootCalls).toContainEqual({ runTmpRoot: RUN_TMP_ROOT, tmpdir: NON_SHARED_TMPDIR });
  });

  test("US-002 AC10: the policy no longer grants the shared /tmp root", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    expect(wrappedPolicy(seam).writeRoots).not.toContain(realOrRaw("/tmp"));
  });

  test("US-002 AC13: allowSharedTmp true keeps the shared temp roots", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionSandbox({ ...confinedArgs(), config: sandboxConfig(true) });

    await launcher.run(launchRequest());

    expect(wrappedPolicy(seam).writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("US-002 AC13 boundary: allowSharedTmp true creates no confined session dir", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);

    await resolveSessionSandbox({ ...confinedArgs(), config: sandboxConfig(true) });

    expect(seam.mkdirCalls).toEqual([]);
  });

  test("US-002 AC14: allowSharedTmp true leaves the launcher state without a sharedTmp field", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);

    const launcher = await resolveSessionSandbox({ ...confinedArgs(), config: sandboxConfig(true) });

    expect("sharedTmp" in launcher.state).toBe(false);
  });

  test("US-002 AC15: with no runTmpRoot the shared temp roots stay granted", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionSandbox(sharedArgs());

    await launcher.run(launchRequest());

    expect(wrappedPolicy(seam).writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("US-002 AC15 boundary: no runTmpRoot means no run root is resolved and nothing is created", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);

    await resolveSessionSandbox(sharedArgs());

    expect(seam.runTempRootCalls).toEqual([]);
    expect(seam.mkdirCalls).toEqual([]);
  });

  test("US-002 AC16: with no runTmpRoot the launcher state has no sharedTmp field", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);

    const launcher = await resolveSessionSandbox(sharedArgs());

    expect(launcher.state.kind).toBe("available");
    expect("sharedTmp" in launcher.state).toBe(false);
  });

  test("US-002 AC17: a failing mkdir falls back to the shared temp roots", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { mkdir: "fails" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    expect(wrappedPolicy(seam).writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("US-002 AC18: a failing mkdir leaves the launcher available without a sharedTmp field", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps, { mkdir: "fails" });

    const launcher = await resolveSessionSandbox(confinedArgs());

    expect(launcher.state.kind).toBe("available");
    expect("sharedTmp" in launcher.state).toBe(false);
  });

  test("US-002 AC19: a failing mkdir warns exactly once at stage sandbox", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps, { mkdir: "fails" });

    await withWarnSpy(async (warnSpy) => {
      await resolveSessionSandbox(confinedArgs());
      expect(warnSpy.mock.calls.filter((call) => call[0] === "sandbox")).toHaveLength(1);
    });
  });

  test("US-002 AC19 boundary: a successful mkdir warns about nothing", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);

    await withWarnSpy(async (warnSpy) => {
      await resolveSessionSandbox(confinedArgs());
      expect(warnSpy.mock.calls).toEqual([]);
    });
  });

  test("#2301: a confined darwin session denies both spellings and drops the write root", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    for (const spelling of ["/tmp/claude", "/private/tmp/claude"])
      expect(policy.denyWrite).toContain(realOrRaw(spelling));
    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301 boundary: a confined linux session denies neither spelling", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "linux" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/private/tmp/claude"));
  });

  test("#2301 boundary: a SHARED darwin session still gets the /tmp/claude write root", async () => {
    // No run root, no session dir: the session runs on the shared roots, srt's
    // TMPDIR is still the directory it advertises, and the deny must not fire.
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    const launcher = await resolveSessionSandbox(sharedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.writeRoots).toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301 boundary: a FAILED mkdir leaves the shared roots and denies nothing", async () => {
    // `allowSharedTmp` is false here too, so a policy that read the config flag
    // instead of the resolved decision would deny a session that is not confined.
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin", mkdir: "fails" });
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.writeRoots).toContain(realOrRaw("/tmp"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301: a command whose session dir cannot be re-created stops carrying the /tmp/claude deny", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform: "darwin" });
    // The resolve-time mkdir succeeds (so the session IS confined), but the
    // per-launch one fails, so no `export TMPDIR=` prefix is applied.
    _launcherDeps.mkdir = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const launcher = await resolveSessionSandbox(confinedArgs());

    await launcher.run(launchRequest());

    const policy = wrappedPolicy(seam);
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    // The rest of the confinement is untouched: the run's own temp root is
    // still granted, and the shared /tmp still is not.
    expect(policy.writeRoots).toContain(realOrRaw(RUN_TMP_ROOT));
    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp"));
  });
});
