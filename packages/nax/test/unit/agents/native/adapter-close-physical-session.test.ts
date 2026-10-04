/**
 * Native session teardown: a physical close, reached from the run's story close
 * or from a failing transcript retain, clears every module-level session map
 * and removes a successful session's transcript.
 *
 * Split out of adapter-complete-rates.test.ts (S1-5) by concern; the cases are
 * unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionAdapter } from "@nathapp/nax-agent";
import { byCodePoint, type NativeSessionState, nativeSessionStateOf } from "@nathapp/nax-agent/internal";
import { makeNaxConfig } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native-agent";
import { closeStorySessions } from "@/execution/session-manager-runtime";
import { SessionManager } from "@/session/manager";

// RE-ARCH: keep
let closeDir: string;
let state: NativeSessionState;
beforeEach(async () => {
  closeDir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
});
afterEach(async () => {
  await rm(closeDir, { recursive: true, force: true });
});

function exportedCollections(): string[] {
  return Object.entries(state)
    .filter(([, value]) => value instanceof Map || value instanceof Set)
    .map(([exportName]) => exportName)
    .sort(byCodePoint);
}

function collectionsHolding(name: string): string[] {
  const holding: string[] = [];
  for (const [exportName, value] of Object.entries(state)) {
    if (value instanceof Map && value.has(name)) holding.push(exportName);
    else if (value instanceof Set && value.has(name)) holding.push(exportName);
  }
  return holding.sort(byCodePoint);
}

describe("native closePhysicalSession — run teardown reaches the session maps", () => {
  test("a keepOpen session's story close clears every native map", async () => {
    const sessions = new NativeSessionAdapter();
    state = nativeSessionStateOf(sessions);
    const adapter = new NativeAgentAdapter(undefined, [], sessions);
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
    // not set are added here so the test covers all twelve, not only the five
    // the open path happens to populate.
    state.failed.add(name);
    state.lastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    state.systemPrompts.set(name, "close-test prompt");
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    await closeStorySessions(sm, "US-001", () => adapter);
    expect(sm.getForStory("US-001")).toHaveLength(0);
    expect(collectionsHolding(name)).toEqual([]);
  });
});
