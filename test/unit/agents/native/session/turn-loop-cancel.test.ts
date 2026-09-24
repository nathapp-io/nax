/**
 * US-002 — a single per-turn signal threaded into the native turn loop.
 *
 * AC1–AC5 pin one scenario end to end: a two-call batch [a, b] where a's
 * interaction aborts `deps.signal`. The loop must stop dispatching b, answer
 * b synthetically, keep the transcript one-result-per-call, reject with the
 * abort reason, and never issue another `complete()` round trip. AC6 pins the
 * no-reason case (rejects with error name `AbortError`). AC9 is the
 * no-signal regression guard: without `deps.signal` both interactions run and
 * the turn completes normally, exactly as before this feature.
 *
 * The batch-level contract (AC7/AC8: an already-aborted signal, no
 * interactions, `after_tool` bypassed) is pinned in `turn-tool-batch.test.ts`.
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

const CANCELLED_CONTENT = "Not run: the turn was cancelled.";
const REASON = "operator pressed stop";

const baseUsage = { inputTokens: 1, outputTokens: 1 };

let dir: string;
const handle = { id: "sess-turn-cancel", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-cancel-"));
  nativeTranscriptDirs.set(handle.id, dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete(handle.id);
  await rm(dir, { recursive: true, force: true });
});

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "raw-body" };
  },
};

const call = (id: string, path: string) => ({ id, name: "Read", input: { path } });
const pathOf = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path : "";
};

/**
 * An interaction handler that records the coding-tool paths it saw and aborts
 * the controller while handling `a` — the scenario every AC1–AC6 test shares.
 */
function abortOnA(controller: AbortController, seen: string[]) {
  return async (req: { kind: string; input?: unknown }) => {
    if (req.kind === "coding-tool") {
      seen.push(pathOf(req.input));
      if (pathOf(req.input) === "a.ts") controller.abort(REASON);
    }
    return { answer: "ok" };
  };
}

function baseOpts(over: Partial<SendTurnOpts> = {}): SendTurnOpts {
  return {
    interactionHandler: {
      onInteraction: async () => ({ answer: "ok" }),
    },
    codingTools: [fakeRead],
    ...over,
  };
}

/** Two-call complete: round 1 returns batch [a, b]; round 2 closes the turn. */
function twoCallComplete(counter: { calls: number }) {
  return async () => {
    counter.calls += 1;
    if (counter.calls === 1) {
      return { text: "", toolCalls: [call("a", "a.ts"), call("b", "b.ts")], usage: baseUsage, costUsd: 0 };
    }
    return { text: "done", usage: baseUsage, costUsd: 0 };
  };
}

describe("runNativeTurn — turn signal cancellation (US-002)", () => {
  test("AC1: aborting deps.signal while handling a of batch [a,b] never calls onInteraction for b", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    await runNativeTurn(handle, "hi", baseOpts({ interactionHandler: { onInteraction: abortOnA(controller, seen) } }), {
      complete: twoCallComplete({ calls: 0 }),
      signal: controller.signal,
    }).catch(() => {});

    expect(seen).toEqual(["a.ts"]);
  });

  test("AC2: the saved transcript result for b is exactly the cancelled notice with isError true", async () => {
    const controller = new AbortController();
    await runNativeTurn(handle, "hi", baseOpts({ interactionHandler: { onInteraction: abortOnA(controller, []) } }), {
      complete: twoCallComplete({ calls: 0 }),
      signal: controller.signal,
    }).catch(() => {});

    const saved = await loadTranscript(dir, handle.id);
    const b = saved.find((m) => m.role === "tool-result" && m.toolCallId === "b");
    expect(b).toBeDefined();
    if (b === undefined || b.role !== "tool-result") throw new Error("unreachable");
    expect(b.content).toBe(CANCELLED_CONTENT);
    expect(b.isError).toBe(true);
  });

  test("AC3: cancellation leaves exactly one result per assistant tool-call id in the saved transcript", async () => {
    const controller = new AbortController();
    await runNativeTurn(handle, "hi", baseOpts({ interactionHandler: { onInteraction: abortOnA(controller, []) } }), {
      complete: twoCallComplete({ calls: 0 }),
      signal: controller.signal,
    }).catch(() => {});

    const saved = await loadTranscript(dir, handle.id);
    for (const id of ["a", "b"]) {
      const results = saved.filter((m) => m.role === "tool-result" && m.toolCallId === id);
      expect(results).toHaveLength(1);
    }
  });

  test("AC4: runNativeTurn rejects with the abort reason when the turn is cancelled", async () => {
    const controller = new AbortController();
    const caught = await runNativeTurn(
      handle,
      "hi",
      baseOpts({ interactionHandler: { onInteraction: abortOnA(controller, []) } }),
      {
        complete: twoCallComplete({ calls: 0 }),
        signal: controller.signal,
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).not.toBeNull();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(REASON);
  });

  test("AC5: fake complete is called exactly once, with no round trip after cancel", async () => {
    const controller = new AbortController();
    const counter = { calls: 0 };
    await runNativeTurn(handle, "hi", baseOpts({ interactionHandler: { onInteraction: abortOnA(controller, []) } }), {
      complete: twoCallComplete(counter),
      signal: controller.signal,
    }).catch(() => {});

    expect(counter.calls).toBe(1);
  });

  test("AC6: an abort with no reason rejects with error name AbortError", async () => {
    const controller = new AbortController();
    const caught = await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool" && pathOf(req.input) === "a.ts") controller.abort();
            return { answer: "ok" };
          },
        },
      }),
      {
        complete: twoCallComplete({ calls: 0 }),
        signal: controller.signal,
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).not.toBeNull();
    expect((caught as { name?: unknown } | undefined)?.name).toBe("AbortError");
  });
});

describe("runNativeTurn — no-signal preservation (US-002)", () => {
  test("AC9: without deps.signal a two-call batch runs both interactions and completes normally", async () => {
    const seen: string[] = [];
    const counter = { calls: 0 };
    const result = await runNativeTurn(
      handle,
      "hi",
      baseOpts({
        interactionHandler: {
          onInteraction: async (req) => {
            if (req.kind === "coding-tool") seen.push(pathOf(req.input));
            return { answer: "ok" };
          },
        },
      }),
      {
        complete: twoCallComplete(counter),
      },
    );

    expect(seen).toEqual(["a.ts", "b.ts"]);
    expect(counter.calls).toBe(2);
    expect(result.output).toBe("done");
    expect(result.turnIncomplete).toBeUndefined();
  });
});
