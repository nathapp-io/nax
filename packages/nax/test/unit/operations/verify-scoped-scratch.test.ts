/**
 * nax#1757 — verifyScopedOp: verify-result scratch capture
 *
 * `ScratchEntry`'s `verify-result` kind (src/session/scratch-writer.ts) had
 * full readers (SessionScratchProvider push, query_scratch pull) but no
 * producer anywhere in `src/`. `verifyScopedOp` is the per-story deterministic
 * test-run operation that already computes passCount/failCount/raw output at
 * the right moment, so it is the writer.
 *
 * Capture is gated on BOTH `config.context.v2.enabled` AND a wired scratch
 * dir + append fn — mirroring `src/execution/post-run.ts:172` (v2 gate) and
 * the `lint-check.ts` / `typecheck-check.ts` `tool-diagnostics` precedent
 * (best-effort dep pair). Capture must never block the verify result.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { ConfigSelector } from "@/config";
import type { VerifyScopedDeps } from "@/operations";
import { _verifyScopedDeps, verifyScopedOp } from "@/operations";
import type { CallContext } from "@/operations/types";
import type { PackageView } from "@/runtime";
import type { ScratchEntry, VerifyScratchEntry } from "@/session/scratch-writer";

/**
 * Narrows a `ScratchEntry` to `VerifyScratchEntry` via the discriminant
 * `kind` field — a runtime check, not a cast, so this stays out of the
 * `looseCast` test-ratchet count.
 */
function toVerifyEntry(entry: ScratchEntry): VerifyScratchEntry {
  if (entry.kind !== "verify-result") {
    throw new Error(`expected a verify-result entry, got kind=${entry.kind}`);
  }
  return entry;
}

function ctxWithV2(v2Enabled: boolean, opts: { repoRoot?: string } = {}): CallContext {
  const config = makeNaxConfig({
    quality: { commands: { test: "bun test" } },
    context: { v2: { enabled: v2Enabled } },
  });
  const runtime = makeMockRuntime({ config });
  const packageView: PackageView = {
    packageDir: "packages/agent",
    relativeFromRoot: "packages/agent",
    repoRoot: opts.repoRoot ?? "/repo",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
  return makeMockCallContext({ runtime, packageView, storyId: "US-003", agentName: "claude" });
}

// Snapshot/restore so mutations don't bleed across tests.
const originalVerifyScopedDeps = { ..._verifyScopedDeps };
afterEach(() => Object.assign(_verifyScopedDeps, originalVerifyScopedDeps));

function fakeDeps(overrides: Partial<VerifyScopedDeps> = {}): VerifyScopedDeps {
  return {
    selectScopedTests: async () => ({
      effectiveCommand: "bun test",
      isFullSuite: true,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
    }),
    regression: async () => ({
      status: "SUCCESS" as const,
      success: true,
      countsTowardEscalation: true,
      output: "1 pass\n0 fail",
    }),
    parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    ...overrides,
  };
}

const failingRegression = {
  regression: async () => ({
    status: "TEST_FAILURE" as const,
    success: false,
    countsTowardEscalation: true,
    output: "1 test failed",
  }),
  parseTestOutput: () => ({
    passed: 0,
    failed: 1,
    failures: [
      { file: "test/unit/foo.test.ts", testName: "my test", error: "Expected true to be false", stackTrace: [] },
    ],
  }),
  testSummaryToFindings: () => [
    {
      source: "test-runner" as const,
      severity: "error" as const,
      category: "failed-test",
      message: "Expected true to be false",
    },
  ],
};

describe("verifyScopedOp — nax#1757: verify-result capture on failing verify", () => {
  test("failing scoped verify appends a verify-result entry with kind/counts/tail", async () => {
    const appendSpy: Array<[string, VerifyScratchEntry]> = [];
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/sess/dir" },
      ctxWithV2(true),
      fakeDeps({
        ...failingRegression,
        appendScratchEntry: async (dir, entry) => {
          appendSpy.push([dir, toVerifyEntry(entry)]);
        },
      }),
    );

    expect(out.success).toBe(false);
    expect(appendSpy).toHaveLength(1);
    const [dir, entry] = appendSpy[0];
    expect(dir).toBe("/sess/dir");
    expect(entry.kind).toBe("verify-result");
    expect(entry.storyId).toBe("US-003");
    expect(entry.stage).toBe("verify");
    expect(entry.success).toBe(false);
    expect(entry.status).toBe("failed");
    expect(entry.passCount).toBe(0);
    expect(entry.failCount).toBe(1);
    expect(entry.rawOutputTail).toBe("1 test failed");
    expect(entry.writtenByAgent).toBe("claude");
  });

  test("rawOutputTail is truncated to the last 500 chars of raw output", async () => {
    const longOutput = `${"x".repeat(600)}TAIL_MARKER`;
    const appendSpy: VerifyScratchEntry[] = [];
    await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/sess/dir" },
      ctxWithV2(true),
      fakeDeps({
        ...failingRegression,
        regression: async () => ({
          status: "TEST_FAILURE" as const,
          success: false,
          countsTowardEscalation: true,
          output: longOutput,
        }),
        appendScratchEntry: async (_dir, entry) => {
          appendSpy.push(toVerifyEntry(entry));
        },
      }),
    );

    expect(appendSpy).toHaveLength(1);
    expect(appendSpy[0].rawOutputTail.length).toBe(500);
    expect(appendSpy[0].rawOutputTail.endsWith("TAIL_MARKER")).toBe(true);
    expect(longOutput.endsWith(appendSpy[0].rawOutputTail)).toBe(true);
  });
});

describe("verifyScopedOp — nax#1757: verify-result capture on passing verify", () => {
  test("passing scoped verify also appends a verify-result entry", async () => {
    const appendSpy: VerifyScratchEntry[] = [];
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/sess/dir" },
      ctxWithV2(true),
      fakeDeps({
        appendScratchEntry: async (_dir, entry) => {
          appendSpy.push(toVerifyEntry(entry));
        },
      }),
    );

    expect(out.success).toBe(true);
    expect(appendSpy).toHaveLength(1);
    expect(appendSpy[0].kind).toBe("verify-result");
    expect(appendSpy[0].success).toBe(true);
    expect(appendSpy[0].status).toBe("passed");
    expect(appendSpy[0].passCount).toBe(1);
    expect(appendSpy[0].failCount).toBe(0);
  });
});

describe("verifyScopedOp — nax#1757: capture is best-effort", () => {
  test("appendScratchEntry throwing does not propagate — op still completes and returns its normal result", async () => {
    let threw = false;
    let out: Awaited<ReturnType<typeof verifyScopedOp.execute>> | undefined;
    try {
      out = await verifyScopedOp.execute(
        { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/sess/dir" },
        ctxWithV2(true),
        fakeDeps({
          ...failingRegression,
          appendScratchEntry: async () => {
            throw new Error("disk full");
          },
        }),
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(out).toBeDefined();
    expect(out?.success).toBe(false);
    expect(out?.findings.length).toBeGreaterThan(0);
  });
});

describe("verifyScopedOp — nax#1757: capture is gated (v2 disabled / no scratch dir)", () => {
  test("v2 disabled — no appendScratchEntry call even with a scratch dir wired", async () => {
    const appendSpy: VerifyScratchEntry[] = [];
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/sess/dir" },
      ctxWithV2(false),
      fakeDeps({
        ...failingRegression,
        appendScratchEntry: async (_dir, entry) => {
          appendSpy.push(toVerifyEntry(entry));
        },
      }),
    );

    expect(out.success).toBe(false);
    expect(appendSpy).toHaveLength(0);
  });

  test("no sessionScratchDir wired (v2 enabled) — no appendScratchEntry call", async () => {
    const appendSpy: VerifyScratchEntry[] = [];
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story" },
      ctxWithV2(true),
      fakeDeps({
        ...failingRegression,
        appendScratchEntry: async (_dir, entry) => {
          appendSpy.push(toVerifyEntry(entry));
        },
      }),
    );

    expect(out.success).toBe(false);
    expect(appendSpy).toHaveLength(0);
  });

  test("input.sessionScratchDir takes precedence over deps.sessionScratchDir", async () => {
    const appendSpy: Array<[string, VerifyScratchEntry]> = [];
    await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story", sessionScratchDir: "/from-input" },
      ctxWithV2(true),
      fakeDeps({
        sessionScratchDir: "/from-deps",
        appendScratchEntry: async (dir, entry) => {
          appendSpy.push([dir, toVerifyEntry(entry)]);
        },
      }),
    );

    expect(appendSpy).toHaveLength(1);
    expect(appendSpy[0][0]).toBe("/from-input");
  });
});
