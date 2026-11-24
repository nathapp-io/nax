/**
 * US-005 — the policy denies the placeholder ledger directory, and only when a
 * ledger actually exists (`src/coding-tools/coding-tool-sandbox.ts` →
 * `src/sandbox/placeholder-ledger.ts` → `src/sandbox/policy-builder.ts`).
 *
 * Split out of `coding-tool-sandbox.test.ts` by concern when that file reached
 * the size limit, per `.nax/rules/test-architecture.md` §2.
 *
 * Every case keeps the sandbox enabled and available and varies ONE ledger
 * prerequisite: the platform, or a reader that throws. The ledger directory is a
 * real temp directory, so a `realOrRaw` assertion is a real resolution, and the
 * host facts that would read `/proc` are injected so the case behaves the same
 * on macOS and Linux.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  _launcherDeps,
  _sessionSandboxDeps,
  DEFAULT_SANDBOX_CONFIG,
  EMPTY_OWNED_PATHS_POLICY,
  realOrRaw,
  resolveSessionSandbox,
  type SandboxPolicy,
} from "@nathapp/nax-agent/internal";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { _resetPlaceholderLedgerForTests } from "#src/sandbox/placeholder-ledger";
import {
  assertDefined,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  testProtectedPaths,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const enabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };

describe("resolveSessionSandbox — US-005 placeholder ledger deny", () => {
  withDepsRestore(_sessionSandboxDeps);
  withDepsRestore(_launcherDeps);
  withDepsRestore(_placeholderDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  let root: string;
  let base: string;
  let ledgerDir: string;
  let exitListeners: Array<() => void>;

  beforeEach(() => {
    root = makeTempDir("session-sbx-ledger-");
    base = makeTempDir("session-ledger-");
    ledgerDir = join(base, "ledgers");
    exitListeners = [];
    _resetPlaceholderLedgerForTests();
    // Nothing here may spawn a process: the launcher is reached through its seam.
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });
  afterEach(() => {
    // The ledger is a process-wide singleton; a case's host facts must not leak
    // into the next file this worker runs.
    _resetPlaceholderLedgerForTests();
    cleanupTempDir(root);
    cleanupTempDir(base);
  });

  /** The one ledger prerequisite a case varies. */
  interface LedgerHostCase {
    readonly platform?: NodeJS.Platform;
    readonly bootId?: "throws";
    readonly ledgerDir?: "throws";
    readonly startTicks?: "throws";
  }

  /** The host facts a ledger needs, injected so no case touches `/proc`. */
  function stubLedgerHost(host: LedgerHostCase = {}): void {
    _placeholderDeps.platform = () => host.platform ?? "linux";
    // The ledger directory is read twice when a ledger is kept: once to create
    // it, once to deny it. The throwing case fails only the CREATION read, so
    // the directory is still a real path afterwards — an implementation that
    // read it without checking for a ledger would then deny it, and fail.
    let dirReads = 0;
    _placeholderDeps.ledgerDir = () => {
      dirReads += 1;
      if (host.ledgerDir === "throws" && dirReads === 1) throw new Error("CREDENTIALS_NOT_CONFIGURED");
      return ledgerDir;
    };
    _placeholderDeps.bootId = () => {
      if (host.bootId === "throws") throw new Error("ENOENT: /proc/sys/kernel/random/boot_id");
      return "boot-A";
    };
    _placeholderDeps.startTicks = () => {
      if (host.startTicks === "throws") throw new Error("ENOENT: /proc/self/stat");
      return 100;
    };
    _placeholderDeps.uid = () => process.getuid?.() ?? 0;
    _placeholderDeps.onExit = (listener: () => void) => {
      exitListeners.push(listener);
    };
  }

  /** Resolve an available session sandbox, run one command and return what it wrapped. */
  async function wrappedPolicyFor(
    host: LedgerHostCase = {},
  ): Promise<{ policy: SandboxPolicy; launcherState: string }> {
    stubLedgerHost(host);
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: testProtectedPaths(),
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    const call = seam.backend.calls[0];
    assertDefined(call, "the request backend.wrap received");
    return { policy: call.policy, launcherState: launcher.state.kind };
  }

  /**
   * The POSITIVE CONTROL every omission case below opens with: with this same
   * fixture and a live ledger, the directory really is denied. Without it an
   * "omits" assertion is satisfied by an implementation that denies nothing at
   * all, so it could never fail — and a security deny whose absence is never
   * contrasted with its presence is not a test.
   */
  async function expectLedgerDeniedWhileLive(): Promise<void> {
    const { policy } = await wrappedPolicyFor();
    expect(policy.denyWrite).toContain(realOrRaw(ledgerDir));
    // Fresh ledger for the variation: the singleton caches the first host facts.
    _resetPlaceholderLedgerForTests();
  }

  test("AC-1: an available linux ledger puts the real ledger directory into denyWrite", async () => {
    const { policy, launcherState } = await wrappedPolicyFor();

    expect(launcherState).toBe("available");
    // The ledger creates its 0700 directory before the policy denies it, so the
    // deny names a path that exists and needs no ancestor walk.
    expect(existsSync(ledgerDir)).toBe(true);
    expect(policy.denyWrite).toContain(realOrRaw(ledgerDir));
  });

  test("AC-1 boundary: the ledger deny is one entry, not one per wrap", async () => {
    const { policy } = await wrappedPolicyFor();

    expect(policy.denyWrite.filter((p) => p === realOrRaw(ledgerDir))).toEqual([realOrRaw(ledgerDir)]);
  });

  test("AC-2: on darwin there is no ledger, so its directory is not denied", async () => {
    await expectLedgerDeniedWhileLive();

    const { policy, launcherState } = await wrappedPolicyFor({ platform: "darwin" });

    expect(launcherState).toBe("available");
    expect(policy.denyWrite).not.toContain(realOrRaw(ledgerDir));
  });

  test("AC-3: a throwing bootId() disables the ledger, and the policy is built without the deny", async () => {
    await expectLedgerDeniedWhileLive();

    const { policy, launcherState } = await wrappedPolicyFor({ bootId: "throws" });

    expect(launcherState).toBe("available");
    expect(policy.denyWrite).not.toContain(realOrRaw(ledgerDir));
    // Wrapping proceeded: the rest of the policy is intact.
    expect(policy.denyWrite).toContain(realOrRaw(join(root, ".claude", "settings.json")));
  });

  test("AC-5: a throwing ledgerDir() disables the ledger, and the policy omits the directory", async () => {
    await expectLedgerDeniedWhileLive();

    const { policy, launcherState } = await wrappedPolicyFor({ ledgerDir: "throws" });

    expect(launcherState).toBe("available");
    expect(policy.denyWrite).not.toContain(realOrRaw(ledgerDir));
    expect(policy.denyWrite).toContain(realOrRaw(join(root, ".claude", "settings.json")));
  });

  test("AC-5: a throwing startTicks(process.pid) disables the ledger, and the policy omits the directory", async () => {
    await expectLedgerDeniedWhileLive();

    const { policy, launcherState } = await wrappedPolicyFor({ startTicks: "throws" });

    expect(launcherState).toBe("available");
    expect(policy.denyWrite).not.toContain(realOrRaw(ledgerDir));
    expect(policy.denyWrite).toContain(realOrRaw(join(root, ".claude", "settings.json")));
  });

  test("AC-5 boundary: no ledger is kept, so no exit hook is registered either", async () => {
    await wrappedPolicyFor({ startTicks: "throws" });

    expect(exitListeners).toEqual([]);
  });

  test("AC-5 boundary: a kept ledger registers exactly one exit hook across repeated builds", async () => {
    await wrappedPolicyFor();

    expect(exitListeners).toHaveLength(1);
  });
});
