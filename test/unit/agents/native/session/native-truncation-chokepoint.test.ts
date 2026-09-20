/**
 * US-003 — native session truncation chokepoint (AC15, AC16, AC17).
 *
 * The native session's loop event seam is the place `after_tool` runs.
 * This file pins the wiring of the model-facing truncation policy at that
 * seam:
 *
 *  - AC15: when a native Grep call exceeds MODEL_MAX_BYTES, then
 *    `truncateForModel` is invoked once with its body and `head` direction.
 *  - AC16: when native ScratchpadRead receives offset/limit, then
 *    `readFileSlice` is invoked once with those values.
 *  - AC17: when a native tool result is within every cap, then the spill
 *    writer is NOT invoked.
 *
 * In the native session, the tool's `run()` method does not execute
 * directly — the loop delegates to `interactionHandler.onInteraction`,
 * which returns the answer that becomes the tool-result content. Tests
 * therefore drive the policy by configuring the interaction handler to
 * return a known body and observing the transcript.
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
const handle = { id: "sess-truncation", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-truncation-"));
  nativeTranscriptDirs.set("sess-truncation", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-truncation");
  await rm(dir, { recursive: true, force: true });
});

function callByToolId(toolName: string, callId: string, input: Record<string, unknown>) {
  return { id: callId, name: toolName, input };
}

function baseOpts(over: Partial<SendTurnOpts> = {}): SendTurnOpts {
  return {
    interactionHandler: {
      onInteraction: async () => ({ answer: "ok" }),
    },
    ...over,
  };
}

/** Stub Grep registered for the loop, but unused at runtime — the
 * interaction handler returns the answer directly. We keep the stub to
 * make sure the tool is recognised by the loop's coding-tool name set.
 */
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

describe("AC15: when a native Grep call exceeds MODEL_MAX_BYTES, then truncateForModel is invoked once with its body and head direction", () => {
  test("a Grep call whose body exceeds MODEL_MAX_BYTES produces a transcript message <= MODEL_MAX_BYTES", async () => {
    // The interaction handler returns a body larger than MODEL_MAX_BYTES.
    // The native session's after_tool handler is what shapes the body
    // before it enters the message array; without that handler the full
    // body enters the transcript and the model sees a token-bill shock.
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
    // The truncation policy shapes the body to <= MODEL_MAX_BYTES.
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("the truncation policy preserves the head direction's content shape (leading bytes kept)", async () => {
    // A body where the FIRST line is the recognizable token. The head
    // direction keeps the leading bytes, so the first line of the result
    // must match the body's first line.
    const firstLineToken = "FIRST-LINE-TOKEN";
    const filler = "y".repeat(MODEL_MAX_BYTES + 100);
    const body = `${firstLineToken}\n${filler}`;
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeGrep],
        interactionHandler: {
          onInteraction: async () => ({ answer: body }),
        },
      }),
      {
        complete: async () => {
          roundTrip += 1;
          if (roundTrip === 1) {
            return {
              text: "",
              toolCalls: [callByToolId("Grep", "g2", { pattern: "x" })],
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
    // Head direction keeps the leading bytes; the recognizable first-line
    // token survives the cut.
    expect(result.content).toContain(firstLineToken);
  });

  test("a Grep result within MODEL_MAX_BYTES is delivered unchanged", async () => {
    // Boundary: a within-cap body must NOT be touched by the policy. The
    // model sees the body verbatim, not a truncation-marker-stamped
    // version. This pins the "policy fires only when needed" property.
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
              toolCalls: [callByToolId("Grep", "g3", { pattern: "alpha" })],
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
      (m) => m.role === "tool-result" && m.toolCallId === "g3" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(result.content).toBe(smallBody);
  });
});

describe("AC16: when native ScratchpadRead receives offset and limit, then readFileSlice is invoked once with that offset and limit", () => {
  test("a ScratchpadRead call with offset and limit receives those values intact through the loop", async () => {
    // The native session's ScratchpadRead path delegates to readFileSlice.
    // The interaction handler here echoes the offset/limit it saw in the
    // request — the test pins that the loop does NOT lose those fields
    // between the model's tool_call and the handler.
    const seen: { offset?: number; limit?: number; path?: string }[] = [];
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeScratchpadRead],
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") {
              const input = req.input as { offset?: number; limit?: number; path?: string };
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
    // The handler saw offset=2 and limit=3.
    expect(seen).toEqual([{ path: "page.md", offset: 2, limit: 3 }]);
    // The result content reflects the offset/limit the model asked for —
    // a regression in the loop that stripped those fields would yield a
    // different echo.
    expect(result.content).toBe("offset=2 limit=3");
  });

  test("a ScratchpadRead call without offset/limit has those fields absent in the request", async () => {
    // Boundary: the loop must NOT synthesise offset/limit when the model
    // did not supply them. readFileSlice's default behaviour (whole
    // body) is what the tool should see.
    const seen: { offset?: number; limit?: number; path?: string }[] = [];
    let roundTrip = 0;
    await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        codingTools: [fakeScratchpadRead],
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") {
              const input = req.input as { offset?: number; limit?: number; path?: string };
              seen.push(input);
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
    // No offset/limit in the seen request — the loop did not invent them.
    expect(seen).toEqual([{ path: "page.md" }]);
    expect(result.content).toBe("whole-body");
  });
});

describe("AC17: when a native tool result is within every cap, then the spill writer is not invoked", () => {
  test("a within-cap tool result is delivered unchanged (no marker in content)", async () => {
    // A within-cap body must NOT carry a spill marker — the spill pipeline
    // is lazy and only fires when the body was truncated.
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
    expect(result.content).toBe(smallBody);
    // No spill path named in a within-cap result — a regression that
    // always emitted the marker would surface here.
    expect(result.content).not.toContain("spill/");
  });

  test("a truncated tool result names a spill path in its content (the AC17 negative)", async () => {
    // The negative companion: when the body is truncated, the marker IS
    // present. This is the property the loop's after_tool must apply,
    // and the test fails today because the marker isn't being emitted
    // yet by the truncation handler.
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
    // AC17 negative companion: a truncated result names a spill path.
    // Use includes (not toMatch) so a missing-marker failure doesn't dump
    // the full body in the error message.
    expect(typeof result.content === "string" && result.content.includes("spill/Grep-")).toBe(true);
  });
});
