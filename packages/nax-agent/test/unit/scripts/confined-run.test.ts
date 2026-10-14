/**
 * The confined test runner (nax#2523): the policy it builds, the command it
 * wraps, and the spawn/cleanup lifecycle `runConfinedTests` drives.
 *
 * Every test here drives the `_confinedRunDeps` seam, so nothing launches a
 * sandbox: the real thing is the integration suite's job, and a unit test that
 * needed a working bwrap could not run inside CI's confined run either.
 *
 * The CLI is exercised through its imported `main`, which takes the same seam
 * shape — plus one real subprocess run for the two exit codes (`--probe`, and
 * the missing-path usage error) that only the process itself can settle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import type { AgentSpawnOptions, AgentSpawnResult } from "#src/runtime/index";
import { SRT_MACOS_TMPDIR_PRIVATE_SPELLING } from "#src/sandbox/defaults";
import type { ProbeResult, SandboxBackend, SandboxWrapRequest } from "#src/sandbox/index";
import { createSrtBackend, probeSandbox } from "#src/sandbox/index";
import { cleanupTempDir, isConfinedTestRun, makeTempDir, waitForCondition, withDepsRestore } from "#test/helpers/index";
import {
  _confinedRunDeps,
  CONFINED_TEST_ENV,
  confinedTestCommand,
  confinedTestPolicy,
  DEFAULT_TEST_TIMEOUT_MS,
  runConfinedTests,
  SANDBOX_UNAVAILABLE_EXIT,
  USAGE_EXIT,
  // biome-ignore lint/style/noRestrictedImports: the confined runner is a script, not part of the package's importable surface; tests reach it by path
} from "../../../scripts/lib/confined-run.ts";
// biome-ignore lint/style/noRestrictedImports: the CLI is a script, not part of the package's importable surface; tests reach it by path
import { main } from "../../../scripts/run-confined-tests.ts";

const PACKAGE_DIR = join(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "../../../scripts/run-confined-tests.ts");
/** Everything `runConfinedTests` creates hangs off this prefix (the session-tmp parent). */
const RUN_ROOT = /^\/tmp\/nax\/confined-\d+-[a-z0-9]+$/;

// ── the seam ────────────────────────────────────────────────────────────────

interface SeamRecord {
  readonly events: string[];
  readonly calls: SandboxWrapRequest[];
  readonly spawned: { argv: readonly string[]; opts: AgentSpawnOptions }[];
  readonly mkdirPaths: string[];
  readonly rmPaths: string[];
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
}

interface SeamOptions {
  readonly probe?: () => Promise<ProbeResult>;
  readonly gitRoot?: (dir: string) => Promise<string | null>;
  /** When given, the child's exit is resolved by the test, never before. */
  readonly exitPromise?: Promise<number>;
  readonly chunks?: readonly string[];
  readonly rmRejects?: boolean;
  readonly spawnThrows?: boolean;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function fakeSpawnResult(chunks: readonly string[], exited: Promise<number>): AgentSpawnResult {
  return {
    stdout: streamOf(chunks),
    stderr: streamOf([]),
    exited,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => {},
  };
}

/** A backend that records its wrap requests and renders argv the way srt does: `sh -c <command>`. */
function makeFakeBackend(events: string[], calls: SandboxWrapRequest[]): SandboxBackend {
  return {
    name: "srt",
    async isSupportedPlatform() {
      return true;
    },
    async wrap(req: SandboxWrapRequest): Promise<readonly string[]> {
      events.push("wrap");
      calls.push(req);
      return [req.shell, "-c", req.command];
    },
    annotate() {
      return "";
    },
    commandFinished() {
      events.push("commandFinished");
    },
    async reset() {
      events.push("reset");
    },
  };
}

function text(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

/** Point every `_confinedRunDeps` member at a recorder; nothing here touches a real sandbox. */
function installSeam(options: SeamOptions = {}): SeamRecord {
  const record: SeamRecord = {
    events: [],
    calls: [],
    spawned: [],
    mkdirPaths: [],
    rmPaths: [],
    stdoutChunks: [],
    stderrChunks: [],
  };
  const backend = makeFakeBackend(record.events, record.calls);
  const exited = options.exitPromise ?? Promise.resolve(0);
  _confinedRunDeps.backend = () => backend;
  _confinedRunDeps.probe = options.probe ?? ((): Promise<ProbeResult> => Promise.resolve({ available: true }));
  _confinedRunDeps.gitRoot = options.gitRoot ?? ((): Promise<string | null> => Promise.resolve(null));
  _confinedRunDeps.homedir = () => "/nonexistent-nax-confined-home";
  _confinedRunDeps.mkdir = async (path: string) => {
    record.events.push("mkdir");
    record.mkdirPaths.push(path);
  };
  _confinedRunDeps.rm = async (path: string) => {
    record.events.push("rm");
    record.rmPaths.push(path);
    if (options.rmRejects === true) throw new Error("EACCES: the run root could not be removed");
  };
  _confinedRunDeps.spawn = (argv: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult => {
    record.events.push("spawn");
    record.spawned.push({ argv, opts });
    if (options.spawnThrows === true) throw new Error("ENOENT: could not spawn the wrapped command");
    return fakeSpawnResult(options.chunks ?? [], exited);
  };
  _confinedRunDeps.stdout = { write: (chunk) => record.stdoutChunks.push(text(chunk)) };
  _confinedRunDeps.stderr = { write: (chunk) => record.stderrChunks.push(text(chunk)) };
  return record;
}

/** The run root the seam recorded: the session dir's parent. */
function runRootOf(record: SeamRecord): string {
  return (record.mkdirPaths[0] ?? "").replace(/\/s$/, "");
}

// ── confinedTestPolicy ──────────────────────────────────────────────────────

describe("confinedTestPolicy", () => {
  withDepsRestore(_confinedRunDeps);

  test("AC-1: writeRoots include the run temp root", async () => {
    const repoRoot = makeTempDir("nax-confined-repo-");
    const runTmpRoot = makeTempDir("nax-confined-run-");
    const home = makeTempDir("nax-confined-home-");
    try {
      const policy = await confinedTestPolicy({ repoRoot, runTmpRoot, home, platform: "linux" });
      expect(policy.writeRoots).toContain(realOrRaw(runTmpRoot));
    } finally {
      cleanupTempDir(repoRoot);
      cleanupTempDir(runTmpRoot);
      cleanupTempDir(home);
    }
  });

  test("AC-2: a linux policy grants neither shared /tmp spelling, even when os.tmpdir() is /tmp", async () => {
    // The host tmpdir a Linux CI runner reports; granting it would re-grant the
    // whole shared directory the confinement exists to remove.
    _confinedRunDeps.tmpdir = () => "/tmp";
    const repoRoot = makeTempDir("nax-confined-repo-");
    const runTmpRoot = makeTempDir("nax-confined-run-");
    try {
      const policy = await confinedTestPolicy({ repoRoot, runTmpRoot, home: "/nonexistent-home", platform: "linux" });
      expect(policy.writeRoots).not.toContain("/tmp");
      expect(policy.writeRoots).not.toContain("/private/tmp");
      // ...while the run's own root is granted, so the assertion above is not vacuous.
      expect(policy.writeRoots).toContain(realOrRaw(runTmpRoot));
    } finally {
      cleanupTempDir(repoRoot);
      cleanupTempDir(runTmpRoot);
    }
  });

  test("AC-3: denyWrite carries the Claude settings deny a confined session gets", async () => {
    const repoRoot = makeTempDir("nax-confined-repo-");
    try {
      const policy = await confinedTestPolicy({
        repoRoot,
        runTmpRoot: join(repoRoot, "run"),
        home: "/nonexistent-home",
        platform: "linux",
      });
      expect(policy.denyWrite).toContain(realOrRaw(join(repoRoot, ".claude/settings.json")));
    } finally {
      cleanupTempDir(repoRoot);
    }
  });

  test("on darwin it denies srt's forced /tmp/claude instead of granting it", async () => {
    const repoRoot = makeTempDir("nax-confined-repo-");
    try {
      const policy = await confinedTestPolicy({
        repoRoot,
        runTmpRoot: join(repoRoot, "run"),
        home: "/nonexistent-home",
        platform: "darwin",
      });
      expect(policy.denyWrite).toContain(SRT_MACOS_TMPDIR_PRIVATE_SPELLING);
      expect(policy.writeRoots).not.toContain("/tmp/claude");
    } finally {
      cleanupTempDir(repoRoot);
    }
  });
});

// ── confinedTestCommand ─────────────────────────────────────────────────────

describe("confinedTestCommand", () => {
  const command = confinedTestCommand({
    packageDir: "/r/packages/x",
    tmpDir: "/tmp/nax/t/s",
    paths: ["./test/unit/"],
    timeoutMs: 5000,
  });

  test("AC-4: exports TMPDIR/TMP/TEMP and the confined marker first", () => {
    expect(command).toStartWith(
      "export TMPDIR='/tmp/nax/t/s' TMP='/tmp/nax/t/s' TEMP='/tmp/nax/t/s' NAX_TEST_CONFINED=1; ",
    );
  });

  test("AC-5: changes into the package and runs bun test over the paths", () => {
    expect(command.endsWith("cd '/r/packages/x' && bun test './test/unit/' --timeout=5000")).toBe(true);
  });

  test("quotes a path with spaces and a quote as one shell argument", () => {
    const quoted = confinedTestCommand({
      packageDir: "/r/p",
      tmpDir: "/t",
      paths: ["./a b'c/", "./d/"],
      timeoutMs: 10,
    });
    expect(quoted).toContain("bun test './a b'\\''c/' './d/' --timeout=10");
  });
});

// ── runConfinedTests ────────────────────────────────────────────────────────

describe("runConfinedTests", () => {
  withDepsRestore(_confinedRunDeps);

  let packageDir: string;

  beforeEach(() => {
    packageDir = makeTempDir("nax-confined-pkg-");
  });

  afterEach(() => {
    cleanupTempDir(packageDir);
  });

  const unavailable = (): Promise<ProbeResult> => Promise.resolve({ available: false, reason: "no bwrap" });

  test("AC-7 / AC-8 / AC-9: an unavailable sandbox exits 3, spawns nothing and says why", async () => {
    const record = installSeam({ probe: unavailable });
    const code = await runConfinedTests({ packageDir, paths: ["./test/unit/"] });

    expect(code).toBe(SANDBOX_UNAVAILABLE_EXIT);
    expect(record.spawned.length).toBe(0);
    expect(record.events).toEqual([]);
    expect(record.stderrChunks.join("")).toBe("sandbox unavailable: no bwrap\n");
  });

  test("AC-10: the wrapped run's own exit code is returned", async () => {
    const record = installSeam({ exitPromise: Promise.resolve(1) });
    expect(await runConfinedTests({ packageDir, paths: ["./test/unit/"] })).toBe(1);
    expect(record.spawned.length).toBe(1);
  });

  test("AC-11: every stdout chunk reaches the sink", async () => {
    const record = installSeam({ chunks: ["first\n", "second\n"] });
    await runConfinedTests({ packageDir, paths: ["./test/unit/"] });
    expect(record.stdoutChunks).toEqual(["first\n", "second\n"]);
  });

  test("AC-12: spawns exactly the argv the backend rendered, for the confined command string", async () => {
    const record = installSeam();
    await runConfinedTests({ packageDir, paths: ["./test/unit/"] });

    const tmpDir = record.mkdirPaths[0] ?? "";
    const request = record.calls[0];
    expect(runRootOf(record)).toMatch(RUN_ROOT);
    expect(request?.command).toBe(
      confinedTestCommand({ packageDir, tmpDir, paths: ["./test/unit/"], timeoutMs: DEFAULT_TEST_TIMEOUT_MS }),
    );
    expect(request?.cwd).toBe(packageDir);
    expect(record.spawned[0]?.argv).toEqual(["/bin/sh", "-c", request?.command ?? ""]);
    expect(record.spawned[0]?.opts).toMatchObject({
      cwd: packageDir,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    });
  });

  test("AC-13: creates the session temp dir before the backend wraps the command", async () => {
    const record = installSeam();
    await runConfinedTests({ packageDir, paths: ["./test/unit/"] });

    expect(record.mkdirPaths).toEqual([`${runRootOf(record)}/s`]);
    expect(record.events.indexOf("mkdir")).toBeLessThan(record.events.indexOf("wrap"));
  });

  test("AC-14: removes the run root only after the run's non-zero exit", async () => {
    const exit = deferred<number>();
    const record = installSeam({ exitPromise: exit.promise });
    const started = runConfinedTests({ packageDir, paths: ["./test/unit/"] });

    await waitForCondition(() => record.events.includes("spawn"));
    expect(record.events).not.toContain("rm");

    exit.resolve(1);
    expect(await started).toBe(1);
    expect(record.rmPaths).toEqual([runRootOf(record)]);
  });

  test("AC-15: the run's exit code survives a failing run-root removal", async () => {
    const record = installSeam({ exitPromise: Promise.resolve(7), rmRejects: true });
    expect(await runConfinedTests({ packageDir, paths: ["./test/unit/"] })).toBe(7);
    expect(record.rmPaths.length).toBe(1);
  });

  test("AC-16: releases the backend (commandFinished, then reset) after the exit, then removes the root", async () => {
    const record = installSeam({ exitPromise: Promise.resolve(1) });
    await runConfinedTests({ packageDir, paths: ["./test/unit/"] });
    expect(record.events).toEqual(["mkdir", "wrap", "spawn", "commandFinished", "reset", "rm"]);
  });

  test("AC-17: outside a git work tree the policy is built on packageDir", async () => {
    const record = installSeam();
    await runConfinedTests({ packageDir, paths: ["./test/unit/"] });
    expect(record.calls[0]?.policy.writeRoots[0]).toBe(realOrRaw(packageDir));
  });

  test("AC-17: inside a work tree the policy is built on the git root", async () => {
    const repoRoot = makeTempDir("nax-confined-repo-");
    const record = installSeam({ gitRoot: async () => repoRoot });
    try {
      await runConfinedTests({ packageDir, paths: ["./test/unit/"] });
      expect(record.calls[0]?.policy.writeRoots[0]).toBe(realOrRaw(repoRoot));
    } finally {
      cleanupTempDir(repoRoot);
    }
  });

  test("a failing spawn still releases the backend and removes the run root", async () => {
    const record = installSeam({ spawnThrows: true });
    await expect(runConfinedTests({ packageDir, paths: ["./test/unit/"] })).rejects.toThrow(/could not spawn/);
    expect(record.events).toContain("commandFinished");
    expect(record.events).toContain("reset");
    expect(record.rmPaths).toEqual([runRootOf(record)]);
  });
});

// ── isConfinedTestRun ───────────────────────────────────────────────────────

describe("isConfinedTestRun", () => {
  const saved = process.env[CONFINED_TEST_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[CONFINED_TEST_ENV];
    else process.env[CONFINED_TEST_ENV] = saved;
  });

  test("AC-18: true when NAX_TEST_CONFINED is '1'", () => {
    process.env[CONFINED_TEST_ENV] = "1";
    expect(isConfinedTestRun()).toBe(true);
  });

  test("false when it is unset or holds anything else", () => {
    delete process.env[CONFINED_TEST_ENV];
    expect(isConfinedTestRun()).toBe(false);
    process.env[CONFINED_TEST_ENV] = "true";
    expect(isConfinedTestRun()).toBe(false);
  });
});

// ── the CLI ────────────────────────────────────────────────────────────────

describe("run-confined-tests CLI", () => {
  const seen: { packageDir: string; paths: readonly string[]; timeoutMs?: number }[] = [];

  beforeEach(() => {
    seen.length = 0;
  });

  function recordRun(): { run: typeof runConfinedTests } {
    return {
      run: async (input) => {
        seen.push(input);
        return 0;
      },
    };
  }

  test("AC-6: --timeout reaches runConfinedTests, and the default is 60000", async () => {
    const deps = recordRun();
    expect(await main(["--timeout=5000", "./test/unit/"], deps)).toBe(0);
    expect(await main(["./test/unit/"], deps)).toBe(0);

    expect(seen.map((input) => input.timeoutMs)).toEqual([5000, DEFAULT_TEST_TIMEOUT_MS]);
    expect(seen[0]?.paths).toEqual(["./test/unit/"]);
  });

  test("AC-6: --package=<dir> resolves against the working directory", async () => {
    expect(await main(["--package=.", "./test/unit/"], recordRun())).toBe(0);
    expect(seen[0]?.packageDir).toBe(process.cwd());
  });

  test("AC-19: no test path exits 2 with usage on stderr, before any probe", async () => {
    let probed = false;
    const stderrChunks: string[] = [];
    const code = await main([], {
      probe: async () => {
        probed = true;
        return { available: true };
      },
      stderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(code).toBe(USAGE_EXIT);
    expect(stderrChunks.join("")).toStartWith("usage: run-confined-tests");
    expect(probed).toBe(false);
  });

  test("AC-19: the real process exits 2 and prints usage", () => {
    const proc = Bun.spawnSync(["bun", "run", CLI], { cwd: PACKAGE_DIR, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(USAGE_EXIT);
    expect(proc.stderr.toString()).toStartWith("usage: run-confined-tests");
  });

  test("AC-20: --probe exits 0 when available and 3 with the reason when not", async () => {
    const stderrChunks: string[] = [];
    expect(await main(["--probe"], { probe: async () => ({ available: true }), stderr: () => {} })).toBe(0);
    const code = await main(["--probe"], {
      probe: async () => ({ available: false, reason: "no bwrap" }),
      stderr: (chunk) => stderrChunks.push(chunk),
    });
    expect(code).toBe(SANDBOX_UNAVAILABLE_EXIT);
    expect(stderrChunks.join("")).toBe("sandbox unavailable: no bwrap\n");
  });

  test("AC-20: the real --probe agrees with this host's sandbox", async () => {
    const backend = createSrtBackend(DEFAULT_SANDBOX_CONFIG.network);
    let available: boolean;
    try {
      available = (await probeSandbox(backend)).available;
    } finally {
      await backend.reset();
    }
    const proc = Bun.spawnSync(["bun", "run", CLI, "--probe"], {
      cwd: PACKAGE_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(available ? 0 : SANDBOX_UNAVAILABLE_EXIT);
    if (!available) expect(proc.stderr.toString()).toStartWith("sandbox unavailable: ");
  }, 30_000);
});
