/**
 * Native session teardown: a physical close, reached from the run's story close
 * or from a failing transcript retain, clears every module-level session map
 * and removes a successful session's transcript.
 *
 * Split out of adapter-complete-rates.test.ts (S1-5) by concern; the cases are
 * unchanged.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import * as sessionState from "@/agents/native/session/session";
import { openNativeSession } from "@/agents/native/session/session";
import * as transcriptStore from "@/agents/native/session/transcript-store";
import { NativeAgentAdapter } from "@/agents/native-agent";
import type { OpenSessionOpts } from "@/agents/session-types";
import { closeStorySessions } from "@/execution/session-manager-runtime";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import { SessionManager } from "@/session/manager";
import { byCodePoint } from "@/utils/sort";

// RE-ARCH: keep
let closeDir: string;
beforeEach(async () => {
  closeDir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
});
afterEach(async () => {
  await rm(closeDir, { recursive: true, force: true });
});

function exportedCollections(): string[] {
  return Object.entries(sessionState)
    .filter(([, value]) => value instanceof Map || value instanceof Set)
    .map(([exportName]) => exportName)
    .sort(byCodePoint);
}

function collectionsHolding(name: string): string[] {
  const holding: string[] = [];
  for (const [exportName, value] of Object.entries(sessionState)) {
    if (value instanceof Map && value.has(name)) holding.push(exportName);
    else if (value instanceof Set && value.has(name)) holding.push(exportName);
  }
  return holding.sort(byCodePoint);
}

const openOpts = (over: Partial<OpenSessionOpts> = {}): OpenSessionOpts => ({
  agentName: "native",
  workdir: closeDir,
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: closeDir,
  transcriptOwner: "call-1",
  compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
  transportRetry: { maxAttempts: 3, baseDelayMs: 2000 },
  spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
  ...over,
});

describe("native closePhysicalSession — run teardown reaches the session maps", () => {
  test("a keepOpen session's story close clears every native map", async () => {
    const adapter = new NativeAgentAdapter();
    const sm = new SessionManager({
      getAdapter: () => adapter,
      config: makeNaxConfig({
        execution: { compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 } },
      }),
    });
    const name = "nax-teardown-us-001-implementer";
    await sm.openSession(name, {
      agentName: "native",
      workdir: closeDir,
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
      timeoutSeconds: 60,
      storyId: "US-001",
      transcriptDir: closeDir,
      transcriptOwner: "call-1",
    });
    // keepOpen: session-run-hop skips closeSession, so the descriptor stays
    // RUNNING and every map keeps its entry. The per-turn entries `open` does
    // not set are added here so the test covers all nine, not only the five the
    // open path happens to populate.
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    await closeStorySessions(sm, "US-001", () => adapter);
    expect(sm.getForStory("US-001")).toHaveLength(0);
    expect(collectionsHolding(name)).toEqual([]);
  });
  test("physical close removes a successful session's transcript", async () => {
    const adapter = new NativeAgentAdapter();
    const name = "nax-teardown-us-003-success";
    await openNativeSession(name, openOpts());
    await transcriptStore.saveTranscript(closeDir, name, []);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(true);
    await adapter.closePhysicalSession(name, closeDir);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(false);
  });
  test("a throwing transcript retain still clears every native map", async () => {
    const adapter = new NativeAgentAdapter();
    const name = "nax-throw-us-002-implementer";
    const handle = await openNativeSession(name, openOpts());
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    const retainSpy = spyOn(transcriptStore, "retainTranscript").mockRejectedValue(new Error("retain boom"));
    try {
      await expect(adapter.closeSession(handle)).rejects.toThrow("retain boom");
    } finally {
      retainSpy.mockRestore();
    }
    expect(collectionsHolding(name)).toEqual([]);
  });
});
