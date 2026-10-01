import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForCondition } from "@test/helpers";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { AfterResponsePatch } from "@/agents/native/session/loop-events/types";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import type { CodingTool } from "@/tools";

let dir: string;
const handle = { id: "sess-turn-lifecycle", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-lifecycle-"));
  nativeTranscriptDirs.set(handle.id, dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete(handle.id);
  // Same hygiene as transform-context.test.ts: the anchor is module-level
  // state keyed by session id, and a stale entry would hand a later test a
  // phantom anchor (turn-loop.ts reads it before the first request).
  nativeSessionLastUsage.delete(handle.id);
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage, costUsd: 0, ...over });

// Copied from before-turn-end.test.ts: declaring Read as a coding tool makes
// the model's tool call a genuine coding-tool dispatch, the same shape a real
// permission ask rides on (a call for an undeclared tool never reaches one).
const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "body" };
  },
};

// interactionHandler is SendTurnOpts' only required field, so a Partial override
// composes directly into a real SendTurnOpts — no cast needed (the before-request
// fixture's pattern).
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

/**
 * Seeds the persisted anchor so the loop reads a defined `anchorIndex` before
 * the first request. Without a prior round trip the anchor is undefined —
 * which PERMITS a full history rewrite (spec 3.5) — so the off-boundary
 * rejection test needs a real anchor to protect.
 */
function seedAnchor(anchorIndex: number): void {
  nativeSessionLastUsage.set(handle.id, { promptTokens: 100, anchorIndex });
}

/** The warn entries a turn logs, captured through a fresh sink (the transform-context fixture). */
async function captureWarnings(run: () => Promise<unknown>): Promise<LogEntry[]> {
  const logCalls: LogEntry[] = [];
  resetLogger();
  initLogger({ level: "info", suppressConsole: true });
  addSink((entry) => logCalls.push(entry));
  try {
    await run();
  } finally {
    resetLogger();
  }
  return logCalls.filter((e) => e.level === "warn");
}

/**
 * The two turn-lifecycle events of the seam (spec 6.1): `before_turn` fires
 * ONCE as the turn starts — after the transcript loads, before the seed push —
 * and `after_response` fires per round trip on the settled assistant message,
 * before it enters the array. `after_response` is safe by construction: it
 * shapes the message, never the array. `before_turn`'s history channel exists
 * but is closed: the boundary is dispatcher-computed and always false — the
 * transcript store refuses another model's history (spec 8.3) — so every
 * off-boundary history patch is rejected; the channel is pinned shut, not
 * stubbed away.
 */
describe("native turn loop — before_turn and after_response", () => {
  test("before_turn may shape the seed", async () => {
    const payloads: unknown[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn", (p) => {
      payloads.push(p);
      return { seed: [{ role: "user", content: "shaped seed" }] };
    });
    const sent: unknown[][] = [];
    const result = await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      complete: async (messages) => {
        // Copied, not aliased: the loop pushes the assistant reply onto the
        // array after this call returns (turn-loop-compaction.test.ts's note).
        sent.push([...messages]);
        return reply();
      },
    });
    // The event fired once, with the turn-start payload.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      prompt: "hi",
      sessionName: handle.id,
      boundary: false,
      history: [],
    });
    // previousModel/currentModel were removed (spec 8.3(f)): cross-model
    // history never reaches before_turn. These assertions pin the removal.
    expect(payloads[0]).not.toHaveProperty("previousModel");
    expect(payloads[0]).not.toHaveProperty("currentModel");
    // THE assertion: the provider saw the SHAPED seed, not the prompt.
    expect(sent[0]).toEqual([{ role: "user", content: "shaped seed" }]);
    // And the transcript records it in place of the prompt — before_turn is
    // the conversation-rewriting event, unlike transform_context's wire copy.
    const saved = await loadTranscript(dir, handle.id);
    expect(saved).toEqual([
      { role: "user", content: "shaped seed" },
      { role: "assistant", content: "done" },
    ]);
    expect(result.output).toBe("done");
  });

  test("before_turn may NOT rewrite loaded history off-boundary", async () => {
    // A prior turn left a loaded transcript and a live cache anchor on it.
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    // The anchor sits on the last loaded message: rewriting the prefix breaks it.
    seedAnchor(1);
    const sent: unknown[][] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_turn", () => ({
      history: [{ role: "user", content: "hijacked" }],
    }));
    // The rejection is a warn (spec 3.7: the patch stops, never the turn), so
    // the log is the dispatch's observable effect on the sent array.
    const warnings = await captureWarnings(() =>
      runNativeTurn(handle, "hi", opts(), {
        loopEvents: registry,
        complete: async (messages) => {
          sent.push([...messages]);
          return reply();
        },
      }),
    );
    // The provider saw the LOADED history plus the prompt-seed — not the rewrite.
    expect(sent[0]).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "hi" },
    ]);
    const rejections = warnings.filter((e) => e.message === "history patch rejected: prefix rewritten off-boundary");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.data).toMatchObject({ event: "before_turn", anchorIndex: 1 });
    // And the persisted transcript preserved the loaded history.
    const saved = await loadTranscript(dir, handle.id);
    expect(saved[0]).toEqual({ role: "user", content: "earlier" });
    expect(saved[1]).toEqual({ role: "assistant", content: "earlier reply" });
    expect(saved).toHaveLength(4);
  });

  test("before_turn rejects a seed that is empty or speaks with another role", async () => {
    // Spec 6.1's stop rule: "Seed must be a non-empty user-role array." A
    // handler returning either is rejected the way a bad history patch is —
    // warn + the original prompt-seed — because a seed the model cannot
    // answer as itself is worse than no patch.
    let calls = 0;
    const registry = createLoopEventRegistry();
    registry.register("before_turn", () => {
      calls += 1;
      return calls === 1 ? { seed: [] } : { seed: [{ role: "assistant", content: "the model's own voice" }] };
    });
    const sent: unknown[][] = [];
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < 2; i += 1) {
        await runNativeTurn(handle, "hi", opts(), {
          loopEvents: registry,
          complete: async (messages) => {
            sent.push([...messages]);
            return reply();
          },
        });
      }
    });
    // Turn 1 (empty seed): the prompt went out instead.
    expect(sent[0]).toEqual([{ role: "user", content: "hi" }]);
    // Turn 2 (assistant-role seed): loaded history + the prompt, still no patch.
    expect(sent[1]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "hi" },
    ]);
    const rejections = warnings.filter(
      (e) => e.message === "before_turn seed patch rejected: seed must be a non-empty user-role array",
    );
    expect(rejections).toHaveLength(2);
  });

  test("after_response may rewrite text before it enters the array", async () => {
    const payloads: unknown[] = [];
    const registry = createLoopEventRegistry();
    registry.register("after_response", (p) => {
      payloads.push(p);
      return { text: "patched" };
    });
    const result = await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      complete: async () => reply({ text: "raw reply" }),
    });
    // The payload carries the response as the provider settled it, with the
    // 1-based round trip the usage beat already uses.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      text: "raw reply",
      usage,
      costUsd: 0,
      roundTrip: 1,
    });
    // THE assertion: the transcript records the PATCHED text, and the array
    // length is untouched — one user message, one assistant message.
    const saved = await loadTranscript(dir, handle.id);
    expect(saved).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "patched" },
    ]);
    // The result's output is the response the provider returned: the patch
    // shapes the transcript message, not the response itself.
    expect(result.output).toBe("raw reply");
  });

  test("after_response CANNOT patch usage or costUsd", async () => {
    // Billing truth is not a handler's to rewrite — the same rule as `denied`
    // on after_tool. The handler's declared return type smuggles `usage` and
    // `costUsd` past AfterResponsePatch (the registry.test.ts intersection
    // annotation, since a bare object shares no property with the all-optional
    // patch type): the dispatcher reads ONLY the patchable fields off a
    // return, so the billing fields must be dropped before they reach anything.
    const payloads: unknown[] = [];
    const registry = createLoopEventRegistry();
    registry.register(
      "after_response",
      (): AfterResponsePatch & {
        usage?: { inputTokens: number; outputTokens: number };
        costUsd?: number;
      } => {
        payloads.push(1);
        return { usage: { inputTokens: 999_999, outputTokens: 999_999 }, costUsd: 4.2 };
      },
    );
    const result = await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      complete: async () => reply(),
    });
    // The event actually fired — the pin below is load-bearing, not vacuous.
    expect(payloads).toHaveLength(1);
    // The returned TurnResult carries the REAL usage — billing truth survived.
    expect(result.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(result.estimatedCostUsd).toBe(0);
    // And the assistant message entered the array unpatched.
    const saved = await loadTranscript(dir, handle.id);
    expect(saved).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });
});

describe("native turn loop — tool events around a permission ask", () => {
  test("review test gap 4: before_tool fires before the ask, after_tool only after it settles", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => {
      order.push("before_tool");
      return { kind: "allow" };
    });
    registry.register("after_tool", () => {
      order.push("after_tool");
      return {};
    });
    let calls = 0;
    const turn = runNativeTurn(
      handle,
      "hi",
      opts({
        codingTools: [fakeRead],
        interactionHandler: {
          onInteraction: async () => {
            order.push("ask-open");
            await held;
            order.push("ask-settled");
            return { answer: "ok" };
          },
        },
      }),
      {
        loopEvents: registry,
        complete: async () => {
          calls += 1;
          return calls === 1
            ? { text: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }], usage, costUsd: 0 }
            : reply();
        },
      },
    );
    // Once the ask is open, before_tool has ALREADY fired -- a handler observes
    // (or rewrites) the call before any human is consulted about it.
    await waitForCondition(() => order.includes("ask-open"));
    expect(order).toEqual(["before_tool", "ask-open"]);
    release();
    await turn;
    // And after_tool fired only after the ask settled: no handler sees a tool
    // result before the interaction that gated it has been answered.
    expect(order).toEqual(["before_tool", "ask-open", "ask-settled", "after_tool"]);
  });
});
