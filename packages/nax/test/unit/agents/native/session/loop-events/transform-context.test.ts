import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage as NativeTranscriptMessage } from "@/agents/native/session/compaction";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import { nativeSessionLastUsage, nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { createTurnAccumulator } from "@/agents/native/session/turn-accumulator";
import { completeWithRecovery } from "@/agents/native/session/turn-complete-step";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

let dir: string;
const handle = { id: "sess-transform", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-transform-"));
  nativeTranscriptDirs.set("sess-transform", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-transform");
  // Same hygiene as turn-loop-compaction.test.ts: the anchor is module-level
  // state keyed by session id, and a stale entry would hand a later test a
  // phantom anchor (turn-loop.ts reads it before the first request).
  nativeSessionLastUsage.delete("sess-transform");
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage, costUsd: 0, ...over });

// interactionHandler is SendTurnOpts' only required field, so a Partial override
// composes directly into a real SendTurnOpts — no cast needed (the before-request
// fixture's pattern).
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

/**
 * Seeds the persisted anchor so the loop reads `anchorIndex: 0` before the
 * first request (turn-loop.ts:103). Without a prior round trip the anchor is
 * undefined — which PERMITS a full rewrite (spec 3.5) — so every checker test
 * here needs a real anchor to protect.
 */
function seedAnchor(): void {
  nativeSessionLastUsage.set("sess-transform", { promptTokens: 100, anchorIndex: 0 });
}

/**
 * `transform_context` fires before every provider request attempt from the same
 * `request()` wrapper as `before_request` (spec 6.6). The ruling that gives the
 * event its shape: the patch shapes ONLY the wire copy passed to `deps.complete`
 * — the array `saveTranscript` persists is untouched, so the transcript stays
 * the true record of the conversation.
 */
describe("native turn loop — transform_context event", () => {
  test("an off-boundary prefix rewrite is rejected and the original is SENT", async () => {
    seedAnchor();
    const sent: unknown[][] = [];
    let handlerCalls = 0;
    const registry = createLoopEventRegistry();
    registry.register("transform_context", () => {
      handlerCalls += 1;
      return { messages: [{ role: "user", content: "hijacked" }] };
    });
    // The rejection is a warn (spec 3.7: the patch stops, never the turn), so
    // the log is the dispatch's observable effect on the sent array.
    resetLogger();
    const logCalls: LogEntry[] = [];
    initLogger({ level: "info", suppressConsole: true });
    addSink((entry) => logCalls.push(entry));
    try {
      await runNativeTurn(handle, "hi", opts(), {
        loopEvents: registry,
        complete: async (messages) => {
          // Copied, not aliased: the loop pushes the assistant reply onto the
          // array after this call returns (turn-loop-compaction.test.ts's note).
          sent.push([...messages]);
          return reply();
        },
      });
    } finally {
      resetLogger();
    }
    // The handler ran — the event actually fired on the request attempt.
    expect(handlerCalls).toBe(1);
    // Brief-verbatim: the hijacked array never reached the provider...
    expect(sent[0]).not.toEqual([{ role: "user", content: "hijacked" }]);
    // ...and the original did.
    expect(sent[0]).toEqual([{ role: "user", content: "hi" }]);
    const warnings = logCalls.filter(
      (e) => e.level === "warn" && e.message === "history patch rejected: prefix rewritten off-boundary",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({ event: "transform_context", anchorIndex: 0 });
  });

  test("the persisted transcript never carries a transform_context patch", async () => {
    // spec 6.6: wire copy only. Even an HONOURED patch must not reach saveTranscript.
    seedAnchor();
    const registry = createLoopEventRegistry();
    // Appending past the anchor keeps the prefix element-identical by reference
    // (spec 3.2), so the patch is HONOURED: the provider is sent the appended
    // wire copy while boundary is false.
    registry.register("transform_context", (p) => ({
      messages: [...p.messages, { role: "user", content: "injected-by-transform-handler" }],
    }));
    const sentWire: unknown[][] = [];
    await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      complete: async (messages) => {
        sentWire.push([...messages]);
        return reply();
      },
    });
    // Non-vacuous: the provider REALLY saw the honoured patch on the wire.
    expect(sentWire[0]).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "injected-by-transform-handler" },
    ]);
    // THE assertion: the saved transcript is the true record — the patch
    // message is absent, and the turn's own messages are exactly what remains.
    const saved = await loadTranscript(dir, handle.id);
    expect(saved.find((m) => m.content === "injected-by-transform-handler")).toBeUndefined();
    expect(saved).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });
});

/**
 * The `honoured` flag (spec 3.6): a step-level pin, because turn-loop.ts
 * re-anchors from the response (turn-loop.ts:198-199) before the cleared
 * locals are read again — the same dormancy the existing `compacted` clear
 * has. What the loop does with the flag (`step.compacted || step.honoured` →
 * clear) is the two-line mirror of the compacted mechanism; the flag itself is
 * the observable contract the clear consumes.
 */
describe("completeWithRecovery — the honoured flag", () => {
  const input: NativeTranscriptMessage[] = [{ role: "user", content: "hi" }];

  test("an honoured rewrite reports honoured and returns the caller's array untouched", async () => {
    const registry = createLoopEventRegistry();
    registry.register("transform_context", (p) => ({
      messages: [...p.messages, { role: "user", content: "wire-only" }],
    }));
    const seen: unknown[][] = [];
    const result = await completeWithRecovery({
      messages: input,
      tools: [],
      usage: createTurnAccumulator(),
      summarizeFailed: false,
      sessionName: "sess-transform",
      lastUsage: { promptTokens: 100 },
      anchorIndex: 0,
      loopEvents: registry,
      roundTrip: 1,
      deps: {
        complete: async (messages) => {
          seen.push([...messages]);
          return reply();
        },
      },
    });
    expect(result.honoured).toBe(true);
    // Prefix-stable and off-boundary: the anchor stays valid (spec 6.6), so
    // turn-loop.ts's clear (`honoured && boundary`) must NOT fire.
    expect(result.boundary).toBe(false);
    // spec 6.6: the kept array is the caller's — the patch never rebinds it.
    expect(result.messages).toBe(input);
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
    // The wire copy is what carried the patch.
    expect(seen[0]).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "wire-only" },
    ]);
  });

  test("with no handler, honoured is false and the wire is the caller's array by reference", async () => {
    let wireRef: unknown;
    const result = await completeWithRecovery({
      messages: input,
      tools: [],
      usage: createTurnAccumulator(),
      summarizeFailed: false,
      sessionName: "sess-transform",
      lastUsage: { promptTokens: 100 },
      anchorIndex: 0,
      loopEvents: createLoopEventRegistry(),
      roundTrip: 1,
      deps: {
        complete: async (messages) => {
          wireRef = messages; // the reference itself, not a copy — the identity pin
          return reply();
        },
      },
    });
    expect(result.honoured).toBe(false);
    expect(result.messages).toBe(input);
    // Dormancy is free: no clone between the caller's array and the provider.
    expect(wireRef).toBe(input);
  });

  test("a honoured rewrite riding the overflow boundary reports BOTH honoured and boundary", async () => {
    // The boundary fact is the post-compaction retry (`compacted`): attempt 1
    // throws context-overflow, the backstop compacts, attempt 2 re-requests at
    // boundary=true — where the appended rewrite is honoured by the exemption,
    // and the anchor clear MUST fire (spec 3.6).
    class ProtocolStreamError extends Error {
      constructor(readonly protocolError: { kind: string; message: string }) {
        super(protocolError.message);
        this.name = "ProtocolStreamError";
      }
    }
    // Sizing borrowed from before-compaction.test.ts: at a 20000-token window
    // the aggressive keep budget is 3000 and this transcript is ~8006 tokens,
    // so the overflow backstop finds a cut and compacts.
    const messages: NativeTranscriptMessage[] = [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(16_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(16_000) },
    ];
    const registry = createLoopEventRegistry();
    registry.register("transform_context", (p) => ({
      messages: [...p.messages, { role: "user", content: "wire-only" }],
    }));
    let attempts = 0;
    const result = await completeWithRecovery({
      messages,
      tools: [],
      usage: createTurnAccumulator(),
      summarizeFailed: false,
      sessionName: "sess-transform",
      lastUsage: { promptTokens: 100 },
      anchorIndex: 0,
      loopEvents: registry,
      roundTrip: 1,
      deps: {
        complete: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
          }
          return reply();
        },
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        contextWindow: 20_000,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
      },
    });
    // Non-vacuous: the overflow backstop actually ran, so the retry that was
    // honoured really did ride the boundary.
    expect(attempts).toBe(2);
    expect(result.compacted).toBe(true);
    expect(result.honoured).toBe(true);
    expect(result.boundary).toBe(true);
  });
});
