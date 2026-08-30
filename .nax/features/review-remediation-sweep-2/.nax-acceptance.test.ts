import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat as realStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-rrs2-acc-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const { makeSpawn } = require("../../../test/helpers/spawn");
const { withWarnSpy } = require("../../../test/helpers/warn-spy");
const { makeNaxConfig } = require("../../../test/helpers/mock-nax-config");

// ═══════════════════════════════════════════════════════════════════════════
// US-001: Surface swallowed git failures in worktree setup and change detection
// ═══════════════════════════════════════════════════════════════════════════

describe("US-001: worktree manager", () => {
  test("AC-1: remove() rejects with WORKTREE_NOT_FOUND when git reports not a working tree", async () => {
    const { WorktreeManager, _worktreeManagerDeps } = require("../../../src/worktree/manager");
    const orig = _worktreeManagerDeps.gitWithTimeout;
    _worktreeManagerDeps.gitWithTimeout = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: 'x' is not a working tree",
    });
    try {
      const manager = new WorktreeManager();
      await expect(manager.remove("/fake/project", "US-001")).rejects.toMatchObject({
        code: "WORKTREE_NOT_FOUND",
      });
    } finally {
      _worktreeManagerDeps.gitWithTimeout = orig;
    }
  });

  test("AC-2: remove() rejects with WORKTREE_ERROR for a genuine git failure", async () => {
    const { WorktreeManager, _worktreeManagerDeps } = require("../../../src/worktree/manager");
    const orig = _worktreeManagerDeps.gitWithTimeout;
    _worktreeManagerDeps.gitWithTimeout = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: could not lock ref",
    });
    try {
      const manager = new WorktreeManager();
      let caught: any;
      try {
        await manager.remove("/fake/project", "US-001");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe("WORKTREE_ERROR");
      expect(String(caught.message)).toContain("could not lock ref");
    } finally {
      _worktreeManagerDeps.gitWithTimeout = orig;
    }
  });

  test("AC-3: create() warns on a genuine remove() failure during cleanup", async () => {
    const { WorktreeManager, _worktreeManagerDeps } = require("../../../src/worktree/manager");
    const orig = _worktreeManagerDeps.gitWithTimeout;
    _worktreeManagerDeps.gitWithTimeout = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: "fatal: could not lock ref" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      const manager = new WorktreeManager();
      await withWarnSpy(async (warnSpy: any) => {
        await manager.create("/fake/project", "US-001");
        const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "worktree");
        expect(call).toBeDefined();
        const data = JSON.stringify(call[2] ?? {});
        expect(data).toContain("US-001");
        expect(data).toContain("could not lock ref");
      });
    } finally {
      _worktreeManagerDeps.gitWithTimeout = orig;
    }
  });

  test("AC-4: create() does not warn when remove() fails only because there is nothing to remove", async () => {
    const { WorktreeManager, _worktreeManagerDeps } = require("../../../src/worktree/manager");
    const orig = _worktreeManagerDeps.gitWithTimeout;
    _worktreeManagerDeps.gitWithTimeout = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: "fatal: 'x' is not a working tree" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      const manager = new WorktreeManager();
      await withWarnSpy(async (warnSpy: any) => {
        await manager.create("/fake/project", "US-001");
        const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "worktree");
        expect(call).toBeUndefined();
      });
    } finally {
      _worktreeManagerDeps.gitWithTimeout = orig;
    }
  });
});

describe("US-001: smart-runner change detection", () => {
  let getGitRootOrig: any;
  let gitWithTimeoutOrig: any;
  let smartRunner: any;

  beforeEach(() => {
    smartRunner = require("../../../src/verification/smart-runner");
    smartRunner.clearGitRootCache();
    getGitRootOrig = smartRunner._gitUtilDeps.getGitRoot;
    gitWithTimeoutOrig = smartRunner._gitUtilDeps.gitWithTimeout;
    smartRunner._gitUtilDeps.getGitRoot = async () => null;
  });

  afterEach(() => {
    smartRunner._gitUtilDeps.getGitRoot = getGitRootOrig;
    smartRunner._gitUtilDeps.gitWithTimeout = gitWithTimeoutOrig;
    smartRunner.clearGitRootCache();
  });

  test("AC-5: getChangedNonTestFiles warns and fails open on a non-zero git exit", async () => {
    smartRunner._gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });
    await withWarnSpy(async (warnSpy: any) => {
      const result = await smartRunner.getChangedNonTestFiles("/fake/repo-ac5", "HEAD~1");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call[2] ?? {})).toContain("bad revision");
    });
  });

  test("AC-6: getChangedTestFiles warns and fails open on a non-zero git exit", async () => {
    smartRunner._gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD~1'",
    });
    await withWarnSpy(async (warnSpy: any) => {
      const result = await smartRunner.getChangedTestFiles(
        "/fake/repo-ac6",
        "/fake/repo-ac6",
        "HEAD~1",
        undefined,
        [/\.test\.ts$/],
      );
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "verification");
      expect(call).toBeDefined();
    });
  });

  test("AC-7: getChangedNonTestFiles warns and fails open when the spawn throws", async () => {
    smartRunner._gitUtilDeps.gitWithTimeout = async () => {
      throw new Error("spawn EACCES");
    };
    await withWarnSpy(async (warnSpy: any) => {
      const result = await smartRunner.getChangedNonTestFiles("/fake/repo-ac7");
      expect(result).toEqual([]);
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "verification");
      expect(call).toBeDefined();
      expect(JSON.stringify(call[2] ?? {})).toContain("spawn EACCES");
    });
  });

  test("AC-8: getChangedNonTestFiles returns real files and stays quiet on success", async () => {
    smartRunner._gitUtilDeps.gitWithTimeout = async () => ({
      exitCode: 0,
      stdout: "src/a.ts\nsrc/b.ts\n",
      stderr: "",
    });
    await withWarnSpy(async (warnSpy: any) => {
      const result = await smartRunner.getChangedNonTestFiles("/fake/repo-ac8");
      expect(result).toContain("src/a.ts");
      expect(result).toContain("src/b.ts");
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "verification");
      expect(call).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// US-002: Honour git exit codes and stop over-waiting in the TDD subsystem
// ═══════════════════════════════════════════════════════════════════════════

describe("US-002: isolation numstat failures", () => {
  let isolation: any;
  let origSpawn: any;

  beforeEach(() => {
    isolation = require("../../../src/tdd/isolation");
    origSpawn = isolation._isolationDeps.spawn;
  });

  afterEach(() => {
    isolation._isolationDeps.spawn = origSpawn;
  });

  test("AC-9: getAddedLinesPerFile rejects with GIT_ERROR on a non-zero numstat exit", async () => {
    isolation._isolationDeps.spawn = makeSpawn((call: any) => {
      if (call.cmd.includes("--numstat")) {
        return { exitCode: 1, stdout: "", stderr: "fatal: bad revision 'HEAD'" };
      }
      return { exitCode: 0, stdout: "" };
    }).spawn;

    let caught: any;
    try {
      await isolation.getAddedLinesPerFile("/fake/wd", "HEAD");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("GIT_ERROR");
    expect(String(caught.message)).toContain("bad revision");
  });

  test("AC-10: getAddedLinesPerFile resolves added-line counts on a successful numstat", async () => {
    isolation._isolationDeps.spawn = makeSpawn((call: any) => {
      if (call.cmd.includes("--numstat")) {
        return { exitCode: 0, stdout: "3\t0\tsrc/a.ts\n" };
      }
      return { exitCode: 0, stdout: "" };
    }).spawn;

    const result = await isolation.getAddedLinesPerFile("/fake/wd", "HEAD");
    expect(result.get("src/a.ts")).toBe(3);
  });

  function stubNameOnlyWithFailingNumstat() {
    isolation._isolationDeps.spawn = makeSpawn((call: any) => {
      if (call.cmd.includes("--name-only")) return { exitCode: 0, stdout: "src/a.ts\n" };
      if (call.cmd.includes("--numstat")) return { exitCode: 1, stdout: "", stderr: "fatal: numstat failed" };
      return { exitCode: 0, stdout: "" };
    }).spawn;
  }

  test("AC-11: lite isolation resolves with the numstat-affected file as a violation, not a rejection", async () => {
    stubNameOnlyWithFailingNumstat();
    const check = await isolation.verifyTestWriterIsolation("/fake/wd", "HEAD", [], [], "lite");
    expect(check.violations).toContain("src/a.ts");
  });

  test("AC-12: lite isolation logs a tdd-isolation warning on the numstat failure", async () => {
    stubNameOnlyWithFailingNumstat();
    await withWarnSpy(async (warnSpy: any) => {
      await isolation.verifyTestWriterIsolation("/fake/wd", "HEAD", [], [], "lite");
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "tdd-isolation");
      expect(call).toBeDefined();
    });
  });

  test("AC-13: strict isolation never requests numstat and logs no tdd-isolation warning", async () => {
    stubNameOnlyWithFailingNumstat();
    await withWarnSpy(async (warnSpy: any) => {
      const check = await isolation.verifyTestWriterIsolation("/fake/wd", "HEAD", [], [], "strict");
      expect(check).toBeDefined();
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "tdd-isolation");
      expect(call).toBeUndefined();
    });
  });
});

describe("US-002: cleanup grace poll", () => {
  test("AC-14: CLEANUP_GRACE_POLL_INTERVAL_MS is a small positive interval", () => {
    const { CLEANUP_GRACE_POLL_INTERVAL_MS } = require("../../../src/tdd/cleanup");
    expect(typeof CLEANUP_GRACE_POLL_INTERVAL_MS).toBe("number");
    expect(CLEANUP_GRACE_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(CLEANUP_GRACE_POLL_INTERVAL_MS).toBeLessThan(3000);
  });

  test("AC-15: cleanupProcessTree sends one SIGTERM and returns early once the group is empty", async () => {
    const { cleanupProcessTree, _cleanupDeps } = require("../../../src/tdd/cleanup");
    const origSpawn = _cleanupDeps.spawn;
    const origKill = _cleanupDeps.killProcessGroupFn;
    const origSleep = _cleanupDeps.sleep;
    const killCalls: string[] = [];
    const sleepArgs: number[] = [];
    try {
      _cleanupDeps.spawn = makeSpawn((call: any) => {
        if (call.cmd.includes("-p")) return { exitCode: 0, stdout: "12345\n" };
        return { exitCode: 1, stdout: "" }; // group probe: always empty
      }).spawn;
      _cleanupDeps.killProcessGroupFn = (_pgid: number, signal: string) => {
        killCalls.push(String(signal));
        return true;
      };
      _cleanupDeps.sleep = async (ms: number) => {
        sleepArgs.push(ms);
      };

      await cleanupProcessTree(12345, 3000);

      expect(killCalls).toEqual(["SIGTERM"]);
      const { CLEANUP_GRACE_POLL_INTERVAL_MS } = require("../../../src/tdd/cleanup");
      expect(sleepArgs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CLEANUP_GRACE_POLL_INTERVAL_MS);
    } finally {
      _cleanupDeps.spawn = origSpawn;
      _cleanupDeps.killProcessGroupFn = origKill;
      _cleanupDeps.sleep = origSleep;
    }
  });

  test("AC-16: cleanupProcessTree escalates to SIGKILL when the group stays populated, bounded polling", async () => {
    const { cleanupProcessTree, _cleanupDeps, CLEANUP_GRACE_POLL_INTERVAL_MS } = require("../../../src/tdd/cleanup");
    const origSpawn = _cleanupDeps.spawn;
    const origKill = _cleanupDeps.killProcessGroupFn;
    const origSleep = _cleanupDeps.sleep;
    const killCalls: string[] = [];
    let sleepCalls = 0;
    try {
      _cleanupDeps.spawn = makeSpawn((call: any) => {
        if (call.cmd.includes("-p")) return { exitCode: 0, stdout: "12345\n" };
        return { exitCode: 0, stdout: "12345\n" }; // group probe: always populated
      }).spawn;
      _cleanupDeps.killProcessGroupFn = (_pgid: number, signal: string) => {
        killCalls.push(String(signal));
        return true;
      };
      _cleanupDeps.sleep = async () => {
        sleepCalls += 1;
      };

      await cleanupProcessTree(12345, 3000);

      expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(sleepCalls).toBeLessThanOrEqual(Math.ceil(3000 / CLEANUP_GRACE_POLL_INTERVAL_MS));
    } finally {
      _cleanupDeps.spawn = origSpawn;
      _cleanupDeps.killProcessGroupFn = origKill;
      _cleanupDeps.sleep = origSleep;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// US-003: Replace filesystem shell-outs with Bun-native calls
// ═══════════════════════════════════════════════════════════════════════════

describe("US-003: native filesystem scanning", () => {
  test("AC-17: scanProject returns a clean repo-relative nested file path", async () => {
    const { scanProject } = require("../../../src/cli/init-context");
    mkdirSync(join(tmpDir, "nested", "deep"), { recursive: true });
    writeFileSync(join(tmpDir, "nested", "deep", "a.ts"), "export {};\n");

    const scan = await scanProject(tmpDir);
    expect(scan.fileTree).toContain("nested/deep/a.ts");
    for (const entry of scan.fileTree) {
      expect(entry.startsWith("/")).toBe(false);
      expect(entry.startsWith("./")).toBe(false);
      expect(entry.startsWith(tmpDir)).toBe(false);
    }
  });

  test("AC-18: initContext rejects with INIT_ERROR when .nax already exists as a regular file", async () => {
    const { initContext } = require("../../../src/cli/init-context");
    writeFileSync(join(tmpDir, ".nax"), "not a directory\n");

    let caught: any;
    try {
      await initContext(tmpDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("INIT_ERROR");
  });

  test("AC-19: scanTestFiles returns nothing when the stat seam rejects for every path", async () => {
    const testScanner = require("../../../src/context/test-scanner");
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "foo.test.ts"), "test('x', () => {});\n");

    const orig = testScanner._testScannerDeps.stat;
    testScanner._testScannerDeps.stat = async () => {
      throw new Error("stat rejected");
    };
    try {
      const files = await testScanner.scanTestFiles({ workdir: tmpDir });
      expect(files.length).toBe(0);
    } finally {
      testScanner._testScannerDeps.stat = orig;
    }
  });

  test("AC-20: scanTestFiles finds the real test file and probes the test subdirectory via the stat seam", async () => {
    const testScanner = require("../../../src/context/test-scanner");
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "foo.test.ts"), "test('x', () => {});\n");

    const orig = testScanner._testScannerDeps.stat;
    const recorded: string[] = [];
    testScanner._testScannerDeps.stat = async (path: string) => {
      recorded.push(String(path));
      return realStat(path);
    };
    try {
      const files = await testScanner.scanTestFiles({ workdir: tmpDir });
      expect(files.some((f: any) => f.relativePath === join("test", "foo.test.ts"))).toBe(true);
      expect(recorded.some((p) => p.endsWith(join(tmpDir, "test")) || p.endsWith("/test"))).toBe(true);
    } finally {
      testScanner._testScannerDeps.stat = orig;
    }
  });

  test("AC-21: scanTestFiles returns nothing when 'test' is a regular file, not a directory", async () => {
    const testScanner = require("../../../src/context/test-scanner");
    writeFileSync(join(tmpDir, "test"), "not a directory\n");

    const files = await testScanner.scanTestFiles({ workdir: tmpDir });
    expect(files.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// US-004: Resolve at call time and make the global patch reversible
// ═══════════════════════════════════════════════════════════════════════════

describe("US-004: Telegram logger resolved at call time", () => {
  test("AC-22: warns via the logger installed after construction when chatId is not numeric", async () => {
    const { resetLogger, initLogger } = require("../../../src/logger");
    const { TelegramInteractionPlugin } = require("../../../src/interaction/plugins/telegram");

    resetLogger();
    const plugin = new TelegramInteractionPlugin();
    const freshLogger = initLogger({ level: "silent" });
    const warnSpy = spyOn(freshLogger, "warn");
    try {
      await plugin.init({ botToken: "t", chatId: "@channelname" });
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "interaction");
      expect(call).toBeDefined();
      expect(String(call?.[1])).toMatch(/not numeric/i);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });

  test("AC-23: records no warning via the logger installed after construction when chatId is numeric", async () => {
    const { resetLogger, initLogger } = require("../../../src/logger");
    const { TelegramInteractionPlugin } = require("../../../src/interaction/plugins/telegram");

    resetLogger();
    const plugin = new TelegramInteractionPlugin();
    const freshLogger = initLogger({ level: "silent" });
    const warnSpy = spyOn(freshLogger, "warn");
    try {
      await plugin.init({ botToken: "t", chatId: "12345" });
      const call = warnSpy.mock.calls.find((c: any[]) => c[0] === "interaction");
      expect(call).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });
});

describe("US-004: webhook port-zero compat is reversible", () => {
  test("AC-24: the returned restore reinstates the exact pre-install fetch", () => {
    const { installServePortZeroCompat } = require("../../../src/interaction/plugins/webhook-serve-compat");
    const preInstallFetch = globalThis.fetch;
    const restore = installServePortZeroCompat();
    expect(typeof restore).toBe("function");
    restore();
    expect(globalThis.fetch).toBe(preInstallFetch);
  });

  test("AC-25: the returned restore reinstates the exact pre-install Bun.serve", () => {
    const { installServePortZeroCompat } = require("../../../src/interaction/plugins/webhook-serve-compat");
    const preInstallBunServe = Bun.serve;
    const restore = installServePortZeroCompat();
    restore();
    expect(Bun.serve).toBe(preInstallBunServe);
  });

  test("AC-26: a re-entrant install's restore is a no-op that cannot undo the first install", () => {
    const { installServePortZeroCompat } = require("../../../src/interaction/plugins/webhook-serve-compat");
    const restore1 = installServePortZeroCompat();
    const patchedFetch = globalThis.fetch;
    const restore2 = installServePortZeroCompat();
    expect(restore2).not.toBe(restore1);
    restore2();
    expect(globalThis.fetch).toBe(patchedFetch);
    restore1();
  });

  test("AC-27: webhook plugin destroy() leaves the process-wide fetch patch intact for other owners", async () => {
    const { installServePortZeroCompat } = require("../../../src/interaction/plugins/webhook-serve-compat");
    const { WebhookInteractionPlugin } = require("../../../src/interaction/plugins/webhook");

    const restoreBaseline = installServePortZeroCompat();
    const baselineFetch = globalThis.fetch;
    try {
      const plugin = new WebhookInteractionPlugin();
      await plugin.init({ url: "http://127.0.0.1:1/unused", requireSecret: false, callbackPort: 0 });
      await plugin.receive("req-1", 1);
      await plugin.destroy();
      expect(globalThis.fetch).toBe(baselineFetch);
    } finally {
      restoreBaseline();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// US-005: One source of truth for the idle-watchdog defaults
// ═══════════════════════════════════════════════════════════════════════════

describe("US-005: resolveIdleWatchdogSettings", () => {
  function resolve() {
    const { resolveIdleWatchdogSettings } = require("../../../src/runtime/middleware/idle-watchdog");
    return resolveIdleWatchdogSettings({ agent: { idleWatchdog: { enabled: true, mode: "warn-then-cancel" } } });
  }

  test("AC-28: idleTimeoutMs defaults to the SSOT's 900 seconds", () => {
    expect(resolve().idleTimeoutMs).toBe(900000);
  });

  test("AC-29: toolCallOnlyTimeoutMs defaults to the SSOT's 1800 seconds", () => {
    expect(resolve().toolCallOnlyTimeoutMs).toBe(1800000);
  });

  test("AC-30: graceMs defaults to the SSOT's 10 seconds", () => {
    expect(resolve().graceMs).toBe(10000);
  });

  test("AC-31: maxRetryAttempts defaults to the SSOT's 3", () => {
    expect(resolve().maxRetryAttempts).toBe(3);
  });

  test("AC-32: an explicit cancelGraceSeconds of 0 is preserved, not replaced by the default", () => {
    const { resolveIdleWatchdogSettings } = require("../../../src/runtime/middleware/idle-watchdog");
    const settings = resolveIdleWatchdogSettings({
      enabled: true,
      mode: "warn-then-cancel",
      cancelGraceSeconds: 0,
    });
    expect(settings.graceMs).toBe(0);
  });
});

describe("US-005: trySameAgentRetry reads the shared maxRetryAttempts cap", () => {
  const { agentManagerConfigSelector } = require("../../../src/config/selectors");

  function makeResult() {
    return {
      success: false,
      exitCode: 1,
      output: "",
      rateLimited: false,
      durationMs: 10,
      estimatedCostUsd: 0,
      adapterFailure: {
        category: "availability" as const,
        outcome: "fail-stale" as const,
        retriable: true,
        message: "idle watchdog cancelled prompt",
      },
    };
  }

  function makeDeps() {
    const config = agentManagerConfigSelector.select(makeNaxConfig({}));
    const requestRunOptions = {
      prompt: "p",
      workdir: "/tmp",
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      timeoutSeconds: 60,
    };
    return { config, requestRunOptions };
  }

  test("AC-33: staleRetryAttempts below the cap returns outcome stale-retry", () => {
    const { trySameAgentRetry } = require("../../../src/agents/retry/hop-retry-policy");
    const state = {
      staleRetryAttempts: 2,
      timeoutRetryAttempts: 0,
      adapterErrorRetries: 0,
      currentRunOptions: makeDeps().requestRunOptions,
    };
    const result = trySameAgentRetry(makeResult() as any, state as any, makeDeps() as any);
    expect(result?.outcome).toBe("stale-retry");
  });

  test("AC-34: staleRetryAttempts at the shared cap returns null", () => {
    const { trySameAgentRetry } = require("../../../src/agents/retry/hop-retry-policy");
    const state = {
      staleRetryAttempts: 3,
      timeoutRetryAttempts: 0,
      adapterErrorRetries: 0,
      currentRunOptions: makeDeps().requestRunOptions,
    };
    const result = trySameAgentRetry(makeResult() as any, state as any, makeDeps() as any);
    expect(result).toBeNull();
  });
});

describe("US-005: SpawnAcpClient timeout default", () => {
  test("AC-35: an explicit 0 survives; an omitted argument falls back to DEFAULT_ACP_TIMEOUT_SECONDS", () => {
    const { SpawnAcpClient, DEFAULT_ACP_TIMEOUT_SECONDS } = require("../../../src/agents/acp/spawn-client");

    const zeroClient = new SpawnAcpClient("acpx claude", "/tmp", 0);
    expect(zeroClient.timeoutSeconds).toBe(0);

    const defaultClient = new SpawnAcpClient("acpx claude", "/tmp");
    expect(defaultClient.timeoutSeconds).toBe(DEFAULT_ACP_TIMEOUT_SECONDS);
  });
});