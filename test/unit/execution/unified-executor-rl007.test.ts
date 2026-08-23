/**
 * RL-007: Fix duplicate stopHeartbeat/writeExitSummary in unified-executor.ts (BUG-060)
 *
 * Acceptance Criteria Tested:
 * - AC #1: Exit summary is written once (unified-executor does NOT call writeExitSummary)
 * - AC #2: Heartbeat protection remains active after executeUnified returns so
 *          runner.ts regression gate runs with heartbeat still ticking
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _isHeartbeatActive, resetCrashHandlers, startHeartbeat, stopHeartbeat } from "@/execution/crash-recovery";
import { type SequentialExecutionContext, executeUnified } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";
import { makeDispatchContext, makePRD, makePluginRegistry, makeStatusWriter, makeTestRuntime } from "@test/helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"] = "passed"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makeCompletePRD(stories: UserStory[] = [makeStory("US-001", "passed")]): PRD {
  return makePRD({
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: stories,
  });
}

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };
const RL007_WORKDIR = `/tmp/nax-rl007-test-workdir-${randomUUID()}`;
const RL007_PRD_PATH = `/tmp/nax-rl007-test-prd-${randomUUID()}.json`;

function makeMinimalContext(): SequentialExecutionContext {
  const config = {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      iterationDelayMs: 0,
    },
  };
  return {
    prdPath: RL007_PRD_PATH,
    workdir: RL007_WORKDIR,
    config,
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-rl007-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    logFilePath: undefined,
    // Real cost aggregator via a real runtime — a fresh instance already reports
    // an all-zero snapshot, which is all this test needs.
    ...makeDispatchContext({ runtime: makeTestRuntime({ config }) }),
  };
}

afterEach(() => {
  stopHeartbeat();
  resetCrashHandlers();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers: source inspection
// ---------------------------------------------------------------------------

function extractFinallyBlocks(src: string): string[] {
  // Collect text inside all `finally { ... }` blocks. Brace-aware: walks the
  // body tracking brace depth so nested if/for blocks don't truncate the match
  // (a naive `[^{}]*` regex would stop at the first inner `{`, forcing the
  // production code into an unnatural brace-free shape).
  const blocks: string[] = [];
  const opener = /finally\s*\{/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = opener.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    // i points one past the closing brace; exclude it from the captured body.
    blocks.push(src.slice(start, i - 1));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// AC #1: Exit summary written once — unified-executor must NOT call it
// ---------------------------------------------------------------------------

describe("RL-007 AC#1: unified-executor.ts does not call writeExitSummary", () => {
  test("finally block does not contain writeExitSummary call", async () => {
    const srcPath = join(__dirname, "../../../src/execution/unified-executor.ts");
    const src = await Bun.file(srcPath).text();

    const finallyBlocks = extractFinallyBlocks(src);
    expect(finallyBlocks.length).toBeGreaterThan(0);

    for (const block of finallyBlocks) {
      // AC #1: no finally block should call writeExitSummary — runner.ts owns that call
      expect(block).not.toContain("writeExitSummary(");
    }
  });

  test("does not import writeExitSummary from crash-recovery", async () => {
    const srcPath = join(__dirname, "../../../src/execution/unified-executor.ts");
    const src = await Bun.file(srcPath).text();

    // writeExitSummary should not be imported at all in unified-executor.ts
    const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']\.\/crash-recovery["']/s;
    const importMatch = src.match(importPattern);
    if (importMatch) {
      expect(importMatch[1]).not.toContain("writeExitSummary");
    }
    // No crash-recovery import at all is also acceptable
  });
});

// ---------------------------------------------------------------------------
// AC #2: Heartbeat active during regression gate
// unified-executor must NOT stop the heartbeat — runner.ts owns that
// ---------------------------------------------------------------------------

describe("RL-007 AC#2: heartbeat remains active after executeUnified returns", () => {
  test("heartbeat is still running after executeUnified completes normally", async () => {
    const statusWriter = makeStatusWriter();
    // Simulate what runner.ts does: start heartbeat before delegating to executor
    startHeartbeat(
      statusWriter,
      () => 0,
      () => 0,
    );

    expect(_isHeartbeatActive()).toBe(true);

    const prd = makeCompletePRD([makeStory("US-001", "passed")]);
    const ctx = makeMinimalContext();

    await executeUnified(ctx, prd);

    // AC #2: heartbeat must still be active so runner.ts regression gate is protected.
    expect(_isHeartbeatActive()).toBe(true);
  });

  test("heartbeat is still running when all stories are skipped", async () => {
    const statusWriter = makeStatusWriter();
    startHeartbeat(
      statusWriter,
      () => 0,
      () => 0,
    );

    const prd = makeCompletePRD([makeStory("US-001", "skipped"), makeStory("US-002", "skipped")]);
    const ctx = makeMinimalContext();

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("completed");
    expect(_isHeartbeatActive()).toBe(true);
  });

  test("finally block does not call stopHeartbeat", async () => {
    const srcPath = join(__dirname, "../../../src/execution/unified-executor.ts");
    const src = await Bun.file(srcPath).text();

    const finallyBlocks = extractFinallyBlocks(src);
    expect(finallyBlocks.length).toBeGreaterThan(0);

    for (const block of finallyBlocks) {
      // Strip single-line comments before checking — the comment may mention
      // stopHeartbeat() to explain why it is NOT called, which is intentional.
      const blockCode = block.replace(/\/\/[^\n]*/g, "");
      // AC #2: no finally block should actually call stopHeartbeat — runner.ts owns lifecycle
      expect(blockCode).not.toContain("stopHeartbeat()");
    }
  });
});
