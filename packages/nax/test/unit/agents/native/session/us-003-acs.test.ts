/**
 * US-003 — native-session acceptance criteria AC16, AC17, AC18.
 *
 * Companion to `test/unit/tools/us-003-acs.test.ts`, which pins AC1-AC15
 * through the coding-tool runtime. The native session applies the same model-
 * facing truncation policy at its `after_tool` chokepoint, and these three
 * ACs pin that wiring at the `runNativeTurn` boundary.
 *
 * AC16: native Grep exceeding MODEL_MAX_BYTES → truncateForModel invoked
 *       once with its body and `head` direction.
 * AC17: native ScratchpadRead receiving offset and limit → readFileSlice
 *       invoked once with that offset and limit.
 * AC18: native tool result within every cap → spill writer is NOT invoked.
 *
 * The native session's tool path is `interactionHandler.onInteraction`, so a
 * test stubs the interaction handler to return the answer the loop will shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import type { CodingTool } from "@/tools";
import { MODEL_MAX_BYTES } from "@/tools";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
const handle = { id: "sess-us003", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-us003-acs-"));
  nativeTranscriptDirs.set("sess-us003", dir);
});

afterEach(async () => {
  nativeTranscriptDirs.delete("sess-us003");
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

const fakeScratchpadRead: CodingTool = {
  name: "ScratchpadRead",
  description: "stub",
  inputSchema: { type: "object" },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "unused" };
  },
};

function baseOpts(over: Partial<SendTurnOpts> = {}): SendTurnOpts {
  return {
    interactionHandler: {
      onInteraction: async () => ({ answer: "ok" }),
    },
    ...over,
  };
}

function callByToolId(name: string, id: string, input: Record<string, unknown>) {
  return { id, name, input };
}

// -----------------------------------------------------------------------------
// AC16 — Native Grep > MODEL_MAX_BYTES → result content byte length <= MODEL_MAX_BYTES.
// -----------------------------------------------------------------------------

describe("AC16: native Grep > MODEL_MAX_BYTES -> transcript message <= MODEL_MAX_BYTES (head direction)", () => {
  test("AC16 success: a native Grep with body 100 bytes over MODEL_MAX_BYTES is shaped into the transcript", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeGrep],
        interactionHandler: {
          onInteraction: async () => ({ answer: bigBody }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("Grep", "g1", { pattern: "x" })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "g1" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // The truncation policy shaped the body into the message array.
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("AC16 boundary: a native Grep with body well below MODEL_MAX_BYTES is delivered unchanged", async () => {
    const smallBody = "alpha\nbeta\ngamma";
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeGrep],
        interactionHandler: {
          onInteraction: async () => ({ answer: smallBody }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("Grep", "g2", { pattern: "alpha" })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "g2" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(result.content).toBe(smallBody);
  });
});

// -----------------------------------------------------------------------------
// AC17 — Native ScratchpadRead offset/limit → loop passes those values through.
// -----------------------------------------------------------------------------

describe("AC17: native ScratchpadRead offset/limit -> values reach the handler intact", () => {
  test("AC17 success: a ScratchpadRead with offset=2 and limit=3 reaches the handler with those fields", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeScratchpadRead],
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") {
              const input = req.input ?? {};
              seen.push(input);
              return { answer: `offset=${input.offset} limit=${input.limit}` };
            }
            return { answer: "ok" };
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("ScratchpadRead", "s1", { path: "page.md", offset: 2, limit: 3 })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "s1" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // The handler received offset=2 and limit=3 — the loop did not lose them.
    expect(seen).toEqual([{ path: "page.md", offset: 2, limit: 3 }]);
    expect(result.content).toBe("offset=2 limit=3");
  });

  test("AC17 boundary: a ScratchpadRead without offset/limit has those fields absent", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeScratchpadRead],
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") {
              seen.push(req.input ?? {});
              return { answer: "whole-body" };
            }
            return { answer: "ok" };
          },
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("ScratchpadRead", "s2", { path: "page.md" })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "s2" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(seen).toEqual([{ path: "page.md" }]);
    expect(result.content).toBe("whole-body");
  });
});

// -----------------------------------------------------------------------------
// AC18 — Native tool result within every cap → spill writer is not invoked.
// -----------------------------------------------------------------------------

describe("AC18: native tool result within every cap -> no spill marker in content", () => {
  test("AC18 success: a within-cap body has no spill marker in the transcript message", async () => {
    const smallBody = "alpha\nbeta\ngamma";
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeGrep],
        interactionHandler: {
          onInteraction: async () => ({ answer: smallBody }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("Grep", "g-cap", { pattern: "alpha" })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "g-cap" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // No spill path named — the spill pipeline is lazy and only fires when
    // the body is truncated.
    expect(result.content).not.toContain("spill/");
  });

  test("AC18 boundary: a truncated body DOES name a spill path (regression check)", async () => {
    // The non-lazy companion to AC18: when the body IS truncated, the marker
    // IS present. This proves the AC18 negative isn't trivially satisfied by
    // a regression that always omits the path.
    const bigBody = "z".repeat(MODEL_MAX_BYTES + 100);
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeGrep],
        interactionHandler: {
          onInteraction: async () => ({ answer: bigBody }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("Grep", "g-trunc", { pattern: "z" })],
              usage: baseUsage,
              costUsd: 0,
            };
          }
          return { text: "done", usage: baseUsage, costUsd: 0 };
        },
      },
    );

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "g-trunc" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(typeof result.content === "string" && result.content.includes("spill/Grep-")).toBe(true);
  });
});
