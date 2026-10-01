/**
 * The model-facing byte ceiling must hold when a spin-breaker nudge fires.
 *
 * `truncateNativeToolResult` enforces MODEL_MAX_BYTES, and the loop then
 * prepends the nudge to what it returned. Prepending after the ceiling has
 * been enforced puts the final content over it — the one guarantee the
 * truncation chokepoint exists to give (US-003 AC1). The nudge's own bytes
 * have to come out of the same budget, not be added on top of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import { buildRunInteractionHandler } from "@/agents/run-interaction-handler";
import type { CodingTool } from "@/tools";
import { compileToolPolicy, createCodingToolRuntime, MODEL_MAX_BYTES } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

const baseUsage = { inputTokens: 1, outputTokens: 1 };
const handle = { id: "sess-nudge-truncation", agentName: "native" } as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-nudge-truncation-"));
  nativeTranscriptDirs.set(handle.id, dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete(handle.id);
  await rm(dir, { recursive: true, force: true });
});

const fakeGrep: CodingTool = {
  name: "Grep",
  description: "stub Grep",
  inputSchema: { type: "object" },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "unused" };
  },
};

/**
 * A breaker that nudges on every call. The real breaker's thresholds are not
 * what is under test — the composition of `withNudge` with the ceiling is.
 */
function alwaysNudging(text: string): NonNullable<TurnDeps["spinBreaker"]> {
  return {
    observe: () => ({ action: "nudge", nudgeNumber: 1, repeats: 3, text }),
    noteResult: () => {},
    summary: () => ({
      totalCalls: 1,
      newKeyEvents: 1,
      maxRepeatRun: 1,
      maxSameKeyRepeats: 3,
      nudges: 1,
    }),
  };
}

describe("the model-facing byte ceiling holds when a nudge is prepended", () => {
  test("an over-ceiling Grep result carrying a spin-breaker nudge stays within MODEL_MAX_BYTES", async () => {
    const nudgeText = `NUDGE: ${"n".repeat(500)}`;
    // Many moderate lines, not one huge one: a single 45 KB line is cut to
    // MODEL_MAX_LINE_CHARS by the per-line cap long before the byte ceiling
    // binds, which would leave nothing for the nudge to push over.
    const bigBody = Array.from({ length: 600 }, (_, i) => `line-${i}-${"x".repeat(80)}`).join("\n");

    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      {
        codingTools: [fakeGrep],
        interactionHandler: { onInteraction: async () => ({ answer: bigBody }) },
      },
      {
        spinBreaker: alwaysNudging(nudgeText),
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "g1", name: "Grep", input: { pattern: "x" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((m) => m.role === "tool-result" && m.toolCallId === "g1");
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // The nudge must be present — the ceiling is not to be held by dropping it.
    expect(result.content).toContain("NUDGE:");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("a nudged runtime result spills the complete body once under the provider call id", async () => {
    const nudgeText = `NUDGE: ${"n".repeat(500)}`;
    const bigBody = Array.from({ length: 600 }, (_, i) => `line-${i}-${"x".repeat(80)}`).join("\n");
    const runtimeTool: CodingTool = {
      ...fakeGrep,
      async run() {
        return { content: bigBody };
      },
    };
    const auditRecords: ToolCallRecord[] = [];
    const interactionHandler = buildRunInteractionHandler({
      codingToolRuntime: createCodingToolRuntime({
        policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], dir),
        extraTools: [runtimeTool],
        sink: { record: (record) => void auditRecords.push(record), flush: async () => {} },
      }),
    });

    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      { codingTools: [runtimeTool], interactionHandler },
      {
        spinBreaker: alwaysNudging(nudgeText),
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [{ id: "provider-call-1", name: "Grep", input: { pattern: "x" } }],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const spillDir = join(dir, ".nax", "scratchpad", "spill");
    expect(await readdir(spillDir)).toEqual(["Grep-provider-call-1.txt"]);
    expect(await readFile(join(spillDir, "Grep-provider-call-1.txt"), "utf8")).toBe(bigBody);
    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find((message) => message.role === "tool-result" && message.toolCallId === "provider-call-1");
    if (result === undefined || result.role !== "tool-result") throw new Error("tool result not found");
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.resultBytes).toBe(result.content.length);
  });
});
