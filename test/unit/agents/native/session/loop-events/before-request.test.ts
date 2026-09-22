import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { CompleteCallOptions } from "@/agents/native/session/loop-events/types";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";

let dir: string;
const handle = { id: "sess-before-request", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-before-request-"));
  nativeTranscriptDirs.set("sess-before-request", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-before-request");
  await rm(dir, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };
const reply = (over: Record<string, unknown> = {}) => ({ text: "done", usage, costUsd: 0, ...over });

// interactionHandler is SendTurnOpts' only required field, so a Partial override
// composes directly into a real SendTurnOpts — no cast needed.
const opts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer: "tool said hi" }) },
  ...over,
});

/** Mirrors the fixture used in turn-loop-transport-retry.test.ts. */
class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string; retryAfter?: number; status?: number }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * `before_request` is the first event wired in `completeWithRecovery`: one
 * `request()` wrapper owns the attempt counter and dispatches per provider
 * request ATTEMPT (spec 6.5), so a transport-fault retry is a second event,
 * not a silent re-issue. The patch's `options` is the write target of the
 * per-call options bag Task 4 added to `TurnDeps.complete` (spec 6.3).
 */
describe("native turn loop — before_request event", () => {
  const retryConfig = { maxAttempts: 3, baseDelayMs: 100 };
  const noopSleep = async () => {};

  test("before_request fires per ATTEMPT, with attempt incrementing on retry", async () => {
    const attempts: number[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_request", (p) => {
      attempts.push(p.attempt);
      return {};
    });
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      transportRetry: retryConfig,
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });
    expect(attempts).toEqual([1, 2]);
    expect(result.output).toBe("done");
  });

  test("a handler's options patch reaches deps.complete for that attempt", async () => {
    const seen: (CompleteCallOptions | undefined)[] = [];
    const registry = createLoopEventRegistry();
    registry.register("before_request", (p) => {
      seen.push(p.options);
      return { options: { temperature: 0.2 } };
    });
    await runNativeTurn(handle, "hi", opts(), {
      loopEvents: registry,
      complete: async (_messages, _tools, options) => {
        expect(options).toEqual({ temperature: 0.2 });
        return reply();
      },
    });
    // The payload's options is the pre-patch bag the attempt would send.
    expect(seen).toEqual([{}]);
  });

  test("with no handler, the request still goes out and no options are fabricated", async () => {
    let calls = 0;
    const seen: (CompleteCallOptions | undefined)[] = [];
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async (_messages, _tools, options) => {
        calls += 1;
        seen.push(options);
        return reply();
      },
    });
    expect(calls).toBe(1);
    expect(seen).toEqual([{}]);
    expect(result.output).toBe("done");
  });
});
