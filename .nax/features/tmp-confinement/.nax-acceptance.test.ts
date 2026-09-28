import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFakeSandboxBackend,
  makeTempDir,
  withDepsRestore,
  withWarnSpy,
} from "@test/helpers";
import { _sessionSandboxDeps, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import { detectTmpWrite } from "@/command-safety";
import { DEFAULT_SANDBOX_CONFIG, SandboxConfigSchema, type SandboxConfig } from "@/config/schemas-sandbox";
import { _runTmpWipeDeps, wipeRunTmp } from "@/execution/lifecycle/run-tmp-wipe";
import { buildScratchpadSection } from "@/prompts/sections/scratchpad";
import {
  _launcherDeps,
  _resetSandboxRegistryForTests,
  createCommandLauncher,
  denialHintLine,
  probeSandboxOnce,
  resetSandboxBackend,
  runTmpRoot,
  sandboxBackendFor,
  sandboxSentence,
  sessionTmpDir,
  type CommandLauncher,
  type SandboxState,
} from "@/sandbox";
import { BASH_TOOL_NAME, createBashTool, createRunCommandTool } from "@/tools";
import { realOrRaw } from "@/utils/realpath";

const OK_RESULT = { exitCode: 0, stdout: "", stderr: "", timedOut: false } as const;

function shellReq(root: string, command: string, timeoutMs = 5_000) {
  return {
    spec: { kind: "shell", shell: "/bin/sh", command } as const,
    root,
    cwd: root,
    timeoutMs,
    stripEnvVars: [] as readonly string[],
  };
}

// ─── Seam loaders for exports this feature adds ──────────────────────────────

/**
 * The `_sessionTmpDeps` seam (lstat / access / uid) behind the confined
 * run-temp-root resolution. Tried on the leaf module first, then the barrel.
 */
async function loadSessionTmpDeps(): Promise<Record<string, unknown>> {
  const leaf = (await import("@/sandbox/session-tmp")) as Record<string, unknown>;
  if (leaf._sessionTmpDeps !== undefined) return leaf._sessionTmpDeps as Record<string, unknown>;
  const barrel = (await import("@/sandbox")) as Record<string, unknown>;
  if (barrel._sessionTmpDeps !== undefined) return barrel._sessionTmpDeps as Record<string, unknown>;
  throw new Error("_sessionTmpDeps is not exported from @/sandbox/session-tmp nor @/sandbox");
}

/** Stub `_sessionTmpDeps` for the duration of `fn`, restoring afterwards. */
async function withSessionTmpDeps<T>(stubs: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T> {
  const deps = await loadSessionTmpDeps();
  const saved = new Map<string, unknown>();
  for (const [key, value] of Object.entries(stubs)) {
    saved.set(key, deps[key]);
    deps[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) deps[key] = value;
  }
}

/** `runTempRoots({ runTmpRoot, tmpdir })` — tried on the barrel, then the policy-inputs leaf. */
type RunTempRoots = (args: { runTmpRoot: string; tmpdir: string }) => string[];
async function loadRunTempRoots(): Promise<RunTempRoots> {
  const barrel = (await import("@/sandbox")) as Record<string, unknown>;
  if (typeof barrel.runTempRoots === "function") return barrel.runTempRoots as RunTempRoots;
  for (const leafPath of ["@/sandbox/policy-inputs", "@/sandbox/policy-builder", "@/sandbox/session-tmp"]) {
    const leaf = (await import(leafPath)) as Record<string, unknown>;
    if (typeof leaf.runTempRoots === "function") return leaf.runTempRoots as RunTempRoots;
  }
  throw new Error(
    "runTempRoots is not exported from @/sandbox, @/sandbox/policy-inputs, @/sandbox/policy-builder nor @/sandbox/session-tmp",
  );
}

// ─── _sessionTmpDeps stub shapes ──────────────────────────────────────────────

const errWithCode = (code: string): Error => Object.assign(new Error(code), { code });

const lstatEnoent = () => {
  throw errWithCode("ENOENT");
};
const lstatEacc = () => {
  throw errWithCode("EACCES");
};
const realDirEntry = { isDirectory: () => true, isSymbolicLink: () => false };
const symlinkEntry = { isDirectory: () => false, isSymbolicLink: () => true };
const plainFileEntry = { isDirectory: () => false, isSymbolicLink: () => false };
const accessOk = (_path: string, _mode: number) => undefined;
const accessEacc = () => {
  throw errWithCode("EACCES");
};
const uid501 = () => 501;

// ─── resolveSessionSandbox fixtures ───────────────────────────────────────────

interface SessionHarness {
  root: string;
  backend: ReturnType<typeof makeFakeSandboxBackend>;
  /** Labels in the order production called them ("mkdir", "buildPolicy"). */
  callOrder: string[];
  /** First argument of every `_sessionSandboxDeps.mkdir` call. */
  mkdirPaths: string[];
}

function setSessionDep(key: string, value: unknown): void {
  (_sessionSandboxDeps as Record<string, unknown>)[key] = value;
}

function makeHarness(root: string): SessionHarness {
  const backend = makeFakeSandboxBackend("enforce");
  const callOrder: string[] = [];
  // Mark the policy build / backend.wrap invocation so a mkdir that must
  // precede it can be compared by index.
  const realWrap = backend.wrap.bind(backend);
  backend.wrap = async (req) => {
    callOrder.push("buildPolicy");
    return realWrap(req);
  };
  return { root, backend, callOrder, mkdirPaths: [] };
}

function stubSessionDeps(
  h: SessionHarness,
  opts: { tempRoots?: readonly string[]; platform?: NodeJS.Platform; mkdirRejects?: boolean } = {},
): void {
  _sessionSandboxDeps.backendFor = () => h.backend;
  _sessionSandboxDeps.probe = async () => ({ available: true });
  _sessionSandboxDeps.gitLayout = async () => ({ kind: "none" });
  _sessionSandboxDeps.naxEntries = async () => [];
  _sessionSandboxDeps.gitGuardFiles = async () => [];
  _sessionSandboxDeps.credentialFiles = async () => [];
  _sessionSandboxDeps.commonDirTripwire = async () => undefined;
  _sessionSandboxDeps.homedir = () => join(h.root, "home");
  _sessionSandboxDeps.tempRoots = () => opts.tempRoots ?? [join(h.root, "tmp")];
  _sessionSandboxDeps.platform = () => opts.platform ?? "linux";
  setSessionDep("tmpdir", () => "/var/folders/x/T");
  setSessionDep("mkdir", async (p: string) => {
    h.callOrder.push("mkdir");
    h.mkdirPaths.push(p);
    if (opts.mkdirRejects === true) throw new Error("mkdir stub rejects");
  });
}

/** Stub the launcher's own spawn/creation seams so nothing touches host /tmp. */
function stubLauncherIo(runCalls: Parameters<typeof _launcherDeps.runArgv>[0][] = []): void {
  _launcherDeps.runArgv = async (o) => {
    runCalls.push(o);
    return { ...OK_RESULT };
  };
  _launcherDeps.mkdir = async () => undefined;
}

const confinedConfig = (): SandboxConfig => SandboxConfigSchema.parse({});
const sharedConfig = (): SandboxConfig => SandboxConfigSchema.parse({ filesystem: { allowSharedTmp: true } });

function confinedArgs(root: string, config: SandboxConfig) {
  return { config, root, needsLauncher: true, runTmpRoot: "/tmp/nax/r1", tmpDir: "/tmp/nax/r1/s" };
}

// ═══ AC-1 … AC-9: the confined run temp root ═════════════════════════════════

describe("tmp-confinement — run temp root (runTmpRoot / sessionTmpDir / wipeRunTmp)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("tmp-confine-");
  });
  afterEach(() => cleanupTempDir(root));

  test("AC-1: an absent /tmp/nax keeps runTmpRoot under the shared nax parent", async () => {
    await withSessionTmpDeps({ lstat: lstatEnoent, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");
    });
  });

  test("AC-2: a real directory /tmp/nax with write+search access keeps the confined root", async () => {
    await withSessionTmpDeps({ lstat: () => realDirEntry, access: accessOk, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax/run-1");
    });
  });

  test("AC-3: a /tmp/nax that denies write/search falls back to /tmp/nax-<uid>", async () => {
    await withSessionTmpDeps({ lstat: () => realDirEntry, access: accessEacc, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
    });
  });

  test("AC-4: a symlinked /tmp/nax is rejected even when access would succeed", async () => {
    await withSessionTmpDeps({ lstat: () => symlinkEntry, access: accessOk, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
    });
  });

  test("AC-5: a regular file at /tmp/nax falls back to /tmp/nax-<uid>", async () => {
    await withSessionTmpDeps({ lstat: () => plainFileEntry, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
    });
  });

  test("AC-6: a non-ENOENT lstat failure falls back to /tmp/nax-<uid>", async () => {
    await withSessionTmpDeps({ lstat: lstatEacc, uid: uid501 }, () => {
      expect(runTmpRoot("run-1")).toBe("/tmp/nax-501/run-1");
    });
  });

  test("AC-7: sessionTmpDir sanitizes spaces and separators under the confined root", async () => {
    await withSessionTmpDeps({ lstat: lstatEnoent, uid: uid501 }, () => {
      expect(sessionTmpDir("run-1", "US 001/impl")).toBe("/tmp/nax/run-1/US_001_impl");
    });
  });

  test("AC-8: a traversal-shaped run id cannot name a path outside /tmp/nax", async () => {
    await withSessionTmpDeps({ lstat: lstatEnoent, uid: uid501 }, () => {
      const result = runTmpRoot("../x");
      expect(result).toBe("/tmp/nax/.._x");
      // The segment following /tmp/nax is one flat, sanitized name: no
      // separator survives, so the result can never escape the parent.
      const segment = result.slice("/tmp/nax/".length);
      expect(segment).toBe(".._x");
      expect(segment.includes("/")).toBe(false);
    });
  });

  test("AC-9: wipeRunTmp removes exactly the run's own root, never the /tmp/nax parent", async () => {
    const removed: string[] = [];
    const savedRemove = _runTmpWipeDeps.remove;
    _runTmpWipeDeps.remove = async (path: string) => {
      removed.push(path);
    };
    try {
      await withSessionTmpDeps({ lstat: lstatEnoent, uid: uid501 }, () => wipeRunTmp("r1"));
      expect(removed).toHaveLength(1);
      expect(removed[0]).toBe("/tmp/nax/r1");
      expect(removed).not.toContain("/tmp/nax");
    } finally {
      _runTmpWipeDeps.remove = savedRemove;
    }
  });
});

// ═══ AC-10 … AC-14: tmpWrite telemetry exclusions ════════════════════════════

describe("tmp-confinement — detectTmpWrite telemetry", () => {
  test("AC-10: writes under /tmp/nax/<runId>/ are excluded from tmpWrite telemetry", () => {
    expect(detectTmpWrite("echo x > /tmp/nax/r1/US-001-implementer/a.txt")).toBe(false);
  });

  test("AC-11: writes under the /private/tmp macOS-resolved nax root are excluded", () => {
    expect(detectTmpWrite("touch /private/tmp/nax/r1/a")).toBe(false);
  });

  test("AC-12: the per-user fallback root /tmp/nax-<uid> is also excluded", async () => {
    await withSessionTmpDeps({ uid: uid501 }, () => {
      expect(detectTmpWrite("echo x > /tmp/nax-501/r1/a.txt")).toBe(false);
    });
  });

  test("AC-13: a path merely sharing the nax prefix is still flagged", () => {
    expect(detectTmpWrite("echo x > /tmp/naxfoo/a.txt")).toBe(true);
  });

  test("AC-14: writes to /tmp outside nax-owned roots are still flagged", () => {
    expect(detectTmpWrite("echo x > /tmp/other/a.txt")).toBe(true);
  });
});

// ═══ AC-15 … AC-20: config default and runTempRoots ══════════════════════════

describe("tmp-confinement — SandboxConfigSchema default and runTempRoots", () => {
  test("AC-15: allowSharedTmp defaults to false when filesystem is omitted", () => {
    const parsed = SandboxConfigSchema.parse({});
    expect(parsed.filesystem.allowSharedTmp).toBe(false);
  });

  test("AC-16: allowSharedTmp true parses and the allowWrite default is preserved", () => {
    const parsed = SandboxConfigSchema.parse({ filesystem: { allowSharedTmp: true } });
    expect(parsed.filesystem.allowSharedTmp).toBe(true);
    expect(parsed.filesystem.allowWrite).toEqual([]);
  });

  test("AC-17: a tmpdir outside /tmp is kept and the run root is appended", async () => {
    const runTempRoots = await loadRunTempRoots();
    const result = runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/var/folders/x/T" });
    expect(result).toEqual(["/var/folders/x/T", "/tmp/nax/r1"]);
  });

  test("AC-18: a tmpdir equal to /tmp is dropped", async () => {
    const runTempRoots = await loadRunTempRoots();
    const result = runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp" });
    expect(result).toEqual(["/tmp/nax/r1"]);
  });

  test("AC-19: a tmpdir under /tmp is dropped", async () => {
    const runTempRoots = await loadRunTempRoots();
    const result = runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/tmp/user-tmp" });
    expect(result).toEqual(["/tmp/nax/r1"]);
  });

  test("AC-20: a tmpdir equal to /private/tmp is dropped", async () => {
    const runTempRoots = await loadRunTempRoots();
    const result = runTempRoots({ runTmpRoot: "/tmp/nax/r1", tmpdir: "/private/tmp" });
    expect(result).toEqual(["/tmp/nax/r1"]);
  });
});

// ═══ AC-21 … AC-34: the confined session sandbox ═════════════════════════════

describe("tmp-confinement — resolveSessionSandbox confinement", () => {
  withDepsRestore(_sessionSandboxDeps);
  withDepsRestore(_launcherDeps);

  let root: string;
  beforeEach(() => {
    root = makeTempDir("tmp-confine-session-");
  });
  afterEach(() => cleanupTempDir(root));

  test("AC-21: a confined session resolves to an available launcher whose state carries sharedTmp false", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));

    expect(launcher.state).toEqual({ kind: "available", backend: "srt", network: "open", sharedTmp: false });
  });

  test("AC-22: the session temp dir is created once, before the policy build/wrap", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
    await launcher.run(shellReq(h.root, "echo hi"));

    expect(h.mkdirPaths).toEqual(["/tmp/nax/r1/s"]);
    const mkdirIdx = h.callOrder.indexOf("mkdir");
    const buildIdx = h.callOrder.indexOf("buildPolicy");
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(mkdirIdx).toBeLessThan(buildIdx);
  });

  test("AC-23: the wrapped policy can write the confined run temp root", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
    await launcher.run(shellReq(h.root, "echo hi"));

    const wrapPolicy = h.backend.calls[0]?.policy;
    expect(wrapPolicy).toBeDefined();
    expect(wrapPolicy?.writeRoots).toContain(realOrRaw("/tmp/nax/r1"));
  });

  test("AC-24: the wrapped policy does not open the whole /tmp", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
    await launcher.run(shellReq(h.root, "echo hi"));

    const wrapPolicy = h.backend.calls[0]?.policy;
    expect(wrapPolicy).toBeDefined();
    expect(wrapPolicy?.writeRoots).not.toContain(realOrRaw("/tmp"));
  });

  test("AC-25: a dispatch launcher with a runId wraps with the confined run temp root", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    await withSessionTmpDeps({ lstat: lstatEnoent, access: accessOk, uid: uid501 }, async () => {
      const options = {
        runId: "r1",
        codingToolRoot: h.root,
        storyId: "US-001",
        config: { execution: { sandbox: confinedConfig() } },
      } as Parameters<typeof resolveDispatchLauncher>[0];

      const launcher = await resolveDispatchLauncher(options, [BASH_TOOL_NAME], "US-001-implementer");
      expect(launcher).toBeDefined();
      await launcher?.run(shellReq(h.root, "echo hi"));

      const wrapPolicy = h.backend.calls[0]?.policy;
      expect(wrapPolicy).toBeDefined();
      expect(wrapPolicy?.writeRoots).toContain(realOrRaw(runTmpRoot("r1")));
    });
  });

  test("AC-26: a dispatch launcher with a runId does not wrap with the whole /tmp", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h);
    stubLauncherIo();

    await withSessionTmpDeps({ lstat: lstatEnoent, access: accessOk, uid: uid501 }, async () => {
      const options = {
        runId: "r1",
        codingToolRoot: h.root,
        storyId: "US-001",
        config: { execution: { sandbox: confinedConfig() } },
      } as Parameters<typeof resolveDispatchLauncher>[0];

      const launcher = await resolveDispatchLauncher(options, [BASH_TOOL_NAME], "US-001-implementer");
      await launcher?.run(shellReq(h.root, "echo hi"));

      const wrapPolicy = h.backend.calls[0]?.policy;
      expect(wrapPolicy).toBeDefined();
      expect(wrapPolicy?.writeRoots).not.toContain(realOrRaw("/tmp"));
    });
  });

  test("AC-27: allowSharedTmp true keeps the system temp root in the policy", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"] });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, sharedConfig()));
    await launcher.run(shellReq(h.root, "echo hi"));

    const wrapPolicy = h.backend.calls[0]?.policy;
    expect(wrapPolicy).toBeDefined();
    expect(wrapPolicy?.writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("AC-28: the shared opt-out state carries no sharedTmp property at all", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"] });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, sharedConfig()));
    const state: SandboxState = launcher.state;

    expect(Object.hasOwn(state, "sharedTmp")).toBe(false);
    expect(Object.keys(state)).not.toContain("sharedTmp");
  });

  test("AC-29: no run temp roots falls back to the shared system temp root", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"] });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox({ config: confinedConfig(), root: h.root, needsLauncher: true });
    await launcher.run(shellReq(h.root, "echo hi"));

    const wrapPolicy = h.backend.calls[0]?.policy;
    expect(wrapPolicy).toBeDefined();
    expect(wrapPolicy?.writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("AC-30: the no-run fallback state carries no sharedTmp property at all", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"] });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox({ config: confinedConfig(), root: h.root, needsLauncher: true });
    const state: SandboxState = launcher.state;

    expect(Object.hasOwn(state, "sharedTmp")).toBe(false);
    expect(Object.keys(state)).not.toContain("sharedTmp");
  });

  test("AC-31: a failing session-dir mkdir still resolves and falls back to the shared root", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"], mkdirRejects: true });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
    await launcher.run(shellReq(h.root, "echo hi"));

    const wrapPolicy = h.backend.calls[0]?.policy;
    expect(wrapPolicy).toBeDefined();
    expect(wrapPolicy?.writeRoots).toContain(realOrRaw("/tmp"));
  });

  test("AC-32: the mkdir-failure fallback state carries no sharedTmp property at all", async () => {
    const h = makeHarness(root);
    stubSessionDeps(h, { tempRoots: ["/tmp"], mkdirRejects: true });
    stubLauncherIo();

    const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
    const state: SandboxState = launcher.state;

    expect(Object.hasOwn(state, "sharedTmp")).toBe(false);
    expect(Object.keys(state)).not.toContain("sharedTmp");
  });

  test("AC-33: a failing session-dir mkdir warns exactly once, on the sandbox stage", async () => {
    await withWarnSpy(async (warnSpy) => {
      // Reset the registry's once-per-process warn flag so this test sees the
      // mkdir-failure warning even if an earlier test in this file consumed it.
      _resetSandboxRegistryForTests();
      const h = makeHarness(root);
      stubSessionDeps(h, { tempRoots: ["/tmp"], mkdirRejects: true });
      stubLauncherIo();

      const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
      await launcher.run(shellReq(h.root, "echo hi"));

      expect(launcher.state.kind).toBe("available");
      expect(warnSpy.mock.calls.length).toBe(1);
      expect(warnSpy.mock.calls[0]?.[0]).toBe("sandbox");
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "AC-34: the darwin srt tmp root stays writable alongside the confined root",
    async () => {
      const h = makeHarness(root);
      stubSessionDeps(h, { platform: "darwin" });
      stubLauncherIo();

      const launcher = await resolveSessionSandbox(confinedArgs(root, confinedConfig()));
      await launcher.run(shellReq(h.root, "echo hi"));

      const wrapPolicy = h.backend.calls[0]?.policy;
      expect(wrapPolicy).toBeDefined();
      expect(wrapPolicy?.writeRoots).toContain(realOrRaw("/tmp/claude"));
    },
    15_000,
  );
});

// ═══ AC-35 … AC-38: live srt confinement ═════════════════════════════════════
// Same guard as test/integration/sandbox/sandbox-live.test.ts: skipped, with
// the probe reason in the title, unless the srt backend is available here.

const LIVE_CONFIG = DEFAULT_SANDBOX_CONFIG;
const liveProbe = await probeSandboxOnce(sandboxBackendFor(LIVE_CONFIG));
const liveLabel = liveProbe.available ? "available" : `SKIPPED: ${liveProbe.reason}`;

describe.skipIf(!liveProbe.available)(`tmp-confinement — live srt confinement (${liveLabel})`, () => {
  withDepsRestore(_sessionSandboxDeps);

  let base: string;
  let root: string;
  const createdRunDirs: string[] = [];
  const attemptedConfineFiles: string[] = [];

  beforeEach(() => {
    base = makeTempDir("tmp-confine-live-");
    root = join(base, "repo");
    mkdirSync(join(base, "tmp"), { recursive: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(join(base, "home"), { recursive: true });
    _sessionSandboxDeps.homedir = () => join(base, "home");
    _sessionSandboxDeps.tempRoots = () => [join(base, "tmp")];
    _sessionSandboxDeps.commonDirTripwire = async () => undefined;
  });

  afterEach(() => {
    for (const dir of createdRunDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const file of attemptedConfineFiles.splice(0)) rmSync(file, { force: true });
    cleanupTempDir(base);
  });

  afterAll(async () => {
    await resetSandboxBackend();
    _resetSandboxRegistryForTests();
  });

  /** Resolve a confined launcher under a unique run id; records it for cleanup. */
  async function confinedLauncher(): Promise<{ launcher: CommandLauncher; tmpDir: string }> {
    const runId = `confine-${randomUUID()}`;
    const tmpDir = sessionTmpDir(runId, "s");
    createdRunDirs.push(runTmpRoot(runId));
    const launcher = await resolveSessionSandbox({
      config: LIVE_CONFIG,
      root,
      needsLauncher: true,
      runTmpRoot: runTmpRoot(runId),
      tmpDir,
    });
    return { launcher, tmpDir };
  }

  function runShell(launcher: CommandLauncher, command: string) {
    return launcher.run(shellReq(root, command, 20_000));
  }

  test("AC-35: a write into the exported TMPDIR succeeds inside the sandbox", async () => {
    const { launcher } = await confinedLauncher();
    const result = await runShell(launcher, 'echo x > "$TMPDIR/ok.txt"');
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("AC-36: the written file lands under the run's unique temp directory", async () => {
    const { launcher, tmpDir } = await confinedLauncher();
    await runShell(launcher, 'echo x > "$TMPDIR/ok.txt"');
    const expectedRunTmpDir = tmpDir;
    expect(existsSync(join(expectedRunTmpDir, "ok.txt"))).toBe(true);
    expect(readFileSync(join(expectedRunTmpDir, "ok.txt"), "utf8")).toBe("x\n");
  }, 30_000);

  test("AC-37: a write directly under /tmp outside /tmp/nax/ is denied", async () => {
    const uuid = randomUUID();
    attemptedConfineFiles.push(`/tmp/nax-confine-${uuid}.txt`);
    const { launcher } = await confinedLauncher();
    const result = await runShell(launcher, `echo x > /tmp/nax-confine-${uuid}.txt`);
    expect(result.exitCode !== 0).toBe(true);
  }, 30_000);

  test("AC-38: the denied /tmp write never reached the disk", async () => {
    const uuid = randomUUID();
    const target = `/tmp/nax-confine-${uuid}.txt`;
    attemptedConfineFiles.push(target);
    const { launcher } = await confinedLauncher();
    await runShell(launcher, `echo x > ${target}`);
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});

// ═══ AC-39 … AC-44: sentences and tool descriptions ══════════════════════════

describe("tmp-confinement — sandbox sentences and tool descriptions", () => {
  /** Byte-exact pre-change snapshot of sandboxSentence("open") (shared wording). */
  const LEGACY_OPEN_SNAPSHOT =
    `inside an OS sandbox: writes are allowed only under the repository root, the system temp directories and ` +
    `package-manager caches -- and nothing under .nax/ except .nax/scratchpad/, since .nax/ is nax's own state ` +
    `(change a feature's acceptance test with the Edit tool); credential files (~/.ssh, ~/.aws, ~/.npmrc, nax credentials and similar) are unreadable; ` +
    `network access is unrestricted. A write anywhere else fails with "Operation not permitted" or "Read-only file system" ` +
    `-- that is the sandbox, not a bug in your command.`;

  test("AC-39: the confined sentence names this run's temp directory, not the system temp directories", () => {
    const sentence = sandboxSentence("open", false);
    expect(sentence).toContain("this run's temp directory ($TMPDIR)");
    expect(sentence).not.toContain("the system temp directories");
  });

  test("AC-40: the shared sentence is byte-identical to the recorded pre-change snapshot", () => {
    const sentence = sandboxSentence("open", true);
    expect(sentence).toBe(LEGACY_OPEN_SNAPSHOT);
    expect(sentence).toContain("the system temp directories");
    expect(sentence).not.toContain("this run's temp directory ($TMPDIR)");
  });

  test("AC-41: the default parameter preserves the legacy shared wording", () => {
    expect(sandboxSentence("open")).toBe(sandboxSentence("open", true));
  });

  test("AC-42: the denial hint ends with the temp-directory guidance", () => {
    expect(denialHintLine(["/repo"]).endsWith("For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp.")).toBe(
      true,
    );
  });

  test("AC-43: the Bash description uses the confined temp-directory wording", () => {
    const state = {
      kind: "available",
      backend: "srt",
      network: "open",
      sharedTmp: false,
    } as SandboxState;
    const tool = createBashTool({ launcher: createCommandLauncher({ state }) });
    expect(tool.description).toContain("this run's temp directory ($TMPDIR)");
    expect(tool.description).not.toContain("the system temp directories");
  });

  test("AC-44: the run-command description uses the confined temp-directory wording", () => {
    const state = { kind: "available", sharedTmp: false } as SandboxState;
    const tool = createRunCommandTool(new Map(), {
      exec: {
        repoRoot: "/repo",
        packageWorkdir: "/repo",
        allowScripts: false,
        patterns: ["bun test *"],
        launcher: createCommandLauncher({ state }),
      },
    });
    expect(tool.description).toContain("this run's temp directory ($TMPDIR)");
  });
});

// ═══ AC-45 … AC-48: the scratchpad section ═══════════════════════════════════

describe("tmp-confinement — scratchpad section wording", () => {
  test("AC-45: the scratchpad-as-temp-folder sentence appears exactly once", () => {
    const section = buildScratchpadSection();
    const occurrences = section.split("Use the scratchpad as your temp folder.").length - 1;
    expect(occurrences).toBe(1);
  });

  test("AC-46: the section forbids writing to /tmp directly", () => {
    expect(buildScratchpadSection()).toContain("Never write to `/tmp` directly");
  });

  test("AC-47: the section names $TMPDIR at least once", () => {
    const section = buildScratchpadSection();
    expect(section.split("$TMPDIR").length - 1).toBeGreaterThanOrEqual(1);
  });

  test("AC-48: the old 'Put temporary files there' phrasing is gone", () => {
    expect(buildScratchpadSection().indexOf("Put temporary files there")).toBe(-1);
  });
});