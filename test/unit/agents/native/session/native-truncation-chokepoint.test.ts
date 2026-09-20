/**
 * US-003 — native session truncation chokepoint (AC16, AC17, AC18).
 *
 * The native session's loop event seam is the place `after_tool` runs.
 * This file pins the wiring of the model-facing truncation policy at that
 * seam:
 *
 *  - AC16: when a native Grep call exceeds MODEL_MAX_BYTES, then
 *    `truncateForModel` is invoked once with its body and `head` direction.
 *  - AC17: when native ScratchpadRead receives offset/limit, then
 *    `readFileSlice` is invoked once with those values.
 *  - AC18: when a native tool result is within every cap, then the spill
 *    writer is NOT invoked.
 *
 * In the native session, a coding tool's `run()` method is not called by the
 * loop — the loop delegates to `interactionHandler.onInteraction`, which
 * returns the answer that becomes the tool-result content. So AC16 and AC18
 * install a spy on the shared policy/writer and observe the transcript, and
 * AC17 drives the ScratchpadRead call through the handler a real run uses
 * (`buildRunInteractionHandler` over a real coding-tool runtime), which is
 * what makes the delegation to `readFileSlice` actually happen.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import { buildRunInteractionHandler } from "@/agents/run-interaction-handler";
import type { SendTurnOpts } from "@/agents/session-types";
import type { CodingTool } from "@/tools";
import { _spillDeps, compileToolPolicy, createCodingToolRuntime, MODEL_MAX_BYTES, scratchpadReadTool } from "@/tools";
import * as readFileModule from "@/tools/read-file";
import * as truncatePolicy from "@/tools/truncate";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
/** The workdir whose scratchpad the paging test reads from. */
let root: string;
const handle = { id: "sess-truncation", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-truncation-"));
  root = await mkdtemp(join(tmpdir(), "nax-turn-truncation-root-"));
  nativeTranscriptDirs.set("sess-truncation", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-truncation");
  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** Write one scratchpad file under the workdir's confined scratchpad. */
async function writeScratchpadFile(name: string, body: string): Promise<void> {
  await mkdir(join(root, ".nax", "scratchpad"), { recursive: true });
  await writeFile(join(root, ".nax", "scratchpad", name), body, "utf8");
}

/**
 * The interaction handler a real native run is driven with: the coding-tool
 * runtime reaches the tool, and so reaches the shared read core underneath
 * it. Reimplementing the delegation in the test would test the test.
 */
function realToolHandler() {
  return buildRunInteractionHandler({
    codingToolRuntime: createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "ScratchpadRead", patterns: ["*"] }], root),
    }),
  });
}

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

describe("AC16: when a native Grep call exceeds MODEL_MAX_BYTES, then truncateForModel is invoked once with its body and head direction", () => {
  test("a Grep call whose body exceeds MODEL_MAX_BYTES invokes truncateForModel once with that body and head direction", async () => {
    // The interaction handler returns a body larger than MODEL_MAX_BYTES.
    // The native session's after_tool handler is what shapes the body
    // before it enters the message array; without that handler the full
    // body enters the transcript and the model sees a token-bill shock.
    //
    // The criterion is an INVOCATION contract, so the spy below pins it:
    // one call, with the tool's whole untruncated body, and with the
    // direction `Grep` resolves to (`head`). The transcript assertion
    // alone would stay green if the chokepoint stopped consulting the
    // shared policy and grew its own slicer.
    //
    // The spy's calls are read BEFORE `mockRestore()`: restoring also
    // resets the mock's record, so a count read afterwards is always zero
    // and the assertion would pass without proving anything.
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const policySpy = spyOn(truncatePolicy, "truncateForModel");
    try {
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

      // Exactly once, with the body the tool returned (not a pre-truncated
      // or sanitised stand-in) and `head` as the direction.
      expect(policySpy.mock.calls.length).toBe(1);
      const policyCall = policySpy.mock.calls[0];
      if (policyCall === undefined) throw new Error("truncateForModel was never invoked");
      expect(policyCall[0]).toBe(bigBody);
      expect(policyCall[1]).toEqual({ direction: "head" });
    } finally {
      policySpy.mockRestore();
    }

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

describe("AC17: when native ScratchpadRead receives offset and limit, then readFileSlice is invoked once with that offset and limit", () => {
  test("a ScratchpadRead call with offset and limit delegates to readFileSlice once with those values", async () => {
    // The criterion is a delegation contract, so the call has to reach the
    // real read core: the loop hands the model's arguments to the
    // interaction handler, the handler a real run uses hands them to the
    // coding-tool runtime, and that runtime invokes `scratchpadReadTool.run`
    // — which is what reaches `readFileSlice`. The spy sits at the bottom of
    // that chain, where the criterion puts it. An echoed offset/limit from a
    // stub handler would pin the request shape and nothing about the
    // delegation: the tool could stop calling the shared read core entirely
    // and an echo would not notice.
    await writeScratchpadFile("page.md", "L1\nL2\nL3\nL4\nL5\n");
    // Read the spy's record BEFORE `mockRestore()` — restoring resets it, so
    // a count read afterwards would be zero regardless of what ran.
    const readSpy = spyOn(readFileModule, "readFileSlice");
    try {
      let roundTrip = 0;
      await runNativeTurn(
        handle,
        "hi",
        baseOpts({
          codingTools: [scratchpadReadTool],
          interactionHandler: realToolHandler(),
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

      // Exactly one read core invocation, on the resolved scratchpad file,
      // with the offset and limit the model asked for. `readCeiling` rides
      // along — the tool-layer I/O bound is the tool's own business — so the
      // range is asserted as a subset rather than the whole options object.
      expect(readSpy.mock.calls.length).toBe(1);
      const readCall = readSpy.mock.calls[0];
      if (readCall === undefined) throw new Error("readFileSlice was never invoked");
      expect(readCall[0].endsWith(join(".nax", "scratchpad", "page.md"))).toBe(true);
      expect(readCall[1]).toEqual(expect.objectContaining({ offset: 2, limit: 3 }));
    } finally {
      readSpy.mockRestore();
    }

    // And the page it produced really reached the message array: lines 2-4
    // under the file's own line-count header.
    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "s1" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    expect(result.content).toBe("[5 lines]\nL2\nL3\nL4");
  });

  test("a ScratchpadRead call without offset/limit invokes readFileSlice with neither field", async () => {
    // Boundary: the loop must NOT synthesise offset/limit when the model did
    // not supply them, so the read core's own whole-file behaviour is what
    // runs. Asserted on the same delegation the success case pins — the
    // options `readFileSlice` really received.
    await writeScratchpadFile("whole.md", "L1\nL2\nL3\n");
    const readSpy = spyOn(readFileModule, "readFileSlice");
    try {
      let roundTrip = 0;
      await runNativeTurn(
        handle,
        "hi",
        baseOpts({
          codingTools: [scratchpadReadTool],
          interactionHandler: realToolHandler(),
        }),
        {
          complete: async () => {
            roundTrip += 1;
            if (roundTrip === 1) {
              return {
                text: "",
                toolCalls: [callByToolId("ScratchpadRead", "s2", { path: "whole.md" })],
                usage: baseUsage,
                costUsd: 0,
              };
            }
            return { text: "done", usage: baseUsage, costUsd: 0 };
          },
        },
      );

      // Read before `mockRestore()`, which resets the record.
      expect(readSpy.mock.calls.length).toBe(1);
      const readCall = readSpy.mock.calls[0];
      if (readCall === undefined) throw new Error("readFileSlice was never invoked");
      const readOpts = readCall[1] ?? {};
      expect("offset" in readOpts).toBe(false);
      expect("limit" in readOpts).toBe(false);
    } finally {
      readSpy.mockRestore();
    }

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "s2" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // The whole body, not a first page: the read really was unbounded.
    expect(result.content).toContain("[3 lines]");
    expect(result.content).toContain("L1");
    expect(result.content).toContain("L3");
  });
});

describe("AC18: when a native tool result is within every cap, then the spill writer is not invoked", () => {
  test("a within-cap tool result is delivered unchanged and the spill writer is never called", async () => {
    // A within-cap body must NOT carry a spill marker — the spill pipeline
    // is lazy and only fires when the body was truncated. The criterion is
    // the writer's non-invocation, so the spy pins that directly: a
    // regression that spilled unconditionally and then failed to name the
    // path in the marker would still leave the content marker-free.
    const smallBody = "alpha\nbeta\ngamma";
    const writeSpy = spyOn(_spillDeps, "writeFile");
    try {
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

      // The spill writer never ran: nothing was written anywhere for a
      // within-cap result. Read before `mockRestore()`, which resets the
      // record.
      expect(writeSpy.mock.calls.length).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }

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

  test("a truncated tool result names a spill path in its content (the AC18 negative)", async () => {
    // The negative companion: when the body is truncated, the marker IS
    // present and the spill writer really runs. That second half is also the
    // positive control for the within-cap case above: the same seam records
    // a write here, so the zero it asserts there is a real absence rather
    // than a spy that never fires.
    const bigBody = "z".repeat(MODEL_MAX_BYTES + 100);
    const writeSpy = spyOn(_spillDeps, "writeFile");
    try {
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

      // Read before `mockRestore()`, which resets the record.
      expect(writeSpy.mock.calls.length).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }

    const saved = await loadTranscript(dir, handle.id);
    const result = saved.find(
      (m) => m.role === "tool-result" && m.toolCallId === "g-trunc" && typeof m.content === "string",
    );
    expect(result).toBeDefined();
    if (result === undefined || result.role !== "tool-result") throw new Error("unreachable");
    // AC18 negative companion: a truncated result names a spill path.
    // Use includes (not toMatch) so a missing-marker failure doesn't dump
    // the full body in the error message.
    expect(typeof result.content === "string" && result.content.includes("spill/Grep-")).toBe(true);
  });
});
