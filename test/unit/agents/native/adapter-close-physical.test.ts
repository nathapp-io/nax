// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import * as sessionState from "@/agents/native/session/session";
import { openNativeSession } from "@/agents/native/session/session";
import * as transcriptStore from "@/agents/native/session/transcript-store";
import type { OpenSessionOpts } from "@/agents/session-types";
import { closeStorySessions } from "@/execution/session-manager-runtime";
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "@/runtime/spin-breaker";
import { SessionManager } from "@/session/manager";
import { byCodePoint } from "@/utils/sort";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Every exported Map/Set the session state module owns, discovered rather than
 * named. A tenth collection added later is automatically included, so a map
 * that close forgets fails this test instead of slipping through.
 */
function exportedCollections(): string[] {
  return Object.entries(sessionState)
    .filter(([, value]) => value instanceof Map || value instanceof Set)
    .map(([exportName]) => exportName)
    .sort(byCodePoint);
}

/** Which exported collections currently hold `name`. */
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
  workdir: dir,
  resolvedPermissions: { mode: "approve-all" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: dir,
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
      workdir: dir,
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
      timeoutSeconds: 60,
      storyId: "US-001",
      transcriptDir: dir,
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
