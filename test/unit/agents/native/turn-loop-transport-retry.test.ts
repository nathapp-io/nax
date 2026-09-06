import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";
import { createTurnDeadline } from "@/agents/turn-deadline";

let dir: string;
const handle = { id: "sess-retry", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-retry-"));
  nativeTranscriptDirs.set("sess-retry", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-retry");
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

/** Mirrors the fixture used in turn-loop-compaction.test.ts. */
class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string; retryAfter?: number }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * nax#1870: a transport/overloaded fault from deps.complete gets a bounded,
 * backed-off retry in the same catch block that already handles context
 * overflow — one more guarded branch, not a second turn loop.
 */
describe("native turn loop — transport-fault retry (nax#1870)", () => {
  const retryConfig = { maxAttempts: 3, baseDelayMs: 100 };
  const noopSleep = async () => {};

  test("retries a transport error once and completes normally", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: async (ms) => {
        delays.push(ms);
      },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    expect(result.output).toBe("done");
  });

  test("retries an overloaded error", async () => {
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "overloaded", message: "503" });
        return reply();
      },
    });
    expect(calls).toBe(2);
    expect(result.output).toBe("done");
  });

  test("never retries auth, bad-request or rate-limit faults", async () => {
    for (const kind of ["auth", "bad-request", "rate-limit"]) {
      let calls = 0;
      await expect(
        runNativeTurn(handle, "hi", opts(), {
          transportRetry: retryConfig,
          sleep: noopSleep,
          complete: async () => {
            calls += 1;
            throw new ProtocolStreamError({ kind, message: "terminal" });
          },
        }),
      ).rejects.toThrow("terminal");
      expect(calls).toBe(1);
    }
  });

  test("leaves context-overflow on its own existing path, unaffected by transportRetry being set", async () => {
    // No compaction deps supplied, so the overflow backstop cannot engage either —
    // this pins that transportRetry does not accidentally swallow overflow.
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        transportRetry: retryConfig,
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");
    expect(calls).toBe(1);
  });

  test("rethrows the original error unchanged once retries are exhausted", async () => {
    let calls = 0;
    let thrown: unknown;
    const originals: Error[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: { maxAttempts: 2, baseDelayMs: 10 },
      sleep: noopSleep,
      complete: async () => {
        calls += 1;
        const err = new ProtocolStreamError({ kind: "transport", message: `stall ${calls}` });
        originals.push(err);
        throw err;
      },
    }).catch((err: unknown) => {
      thrown = err;
    });
    // maxAttempts: 2 = one retry beyond the triggering failure.
    expect(calls).toBe(2);
    expect(thrown).toBe(originals[1]);
  });

  test("does not retry when the turn deadline has already expired", async () => {
    let now = 0;
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        transportRetry: retryConfig,
        deadline: createTurnDeadline(10, () => now),
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          now += 20_000; // past the 10s budget before the retry check runs
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });

  test("does not retry when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts({ signal: controller.signal }), {
        transportRetry: retryConfig,
        sleep: noopSleep,
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });

  test("honours the provider's retryAfter for the backoff delay", async () => {
    let calls = 0;
    const delays: number[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: async (ms) => {
        delays.push(ms);
      },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "overloaded", message: "429-ish", retryAfter: 4 });
        return reply();
      },
    });
    expect(delays).toEqual([4000]);
  });

  test("fires an onActivity beat per retry so the idle watchdog resets", async () => {
    let calls = 0;
    const activity: unknown[] = [];
    await runNativeTurn(handle, "hi", opts(), {
      transportRetry: retryConfig,
      sleep: noopSleep,
      onActivity: (a) => activity.push(a),
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        return reply();
      },
    });
    // One retry beat plus the successful round trip's own usage beat.
    expect(activity).toContainEqual({ kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  test("is inert when no transportRetry config is supplied — pre-#1870 behaviour", async () => {
    let calls = 0;
    await expect(
      runNativeTurn(handle, "hi", opts(), {
        complete: async () => {
          calls += 1;
          throw new ProtocolStreamError({ kind: "transport", message: "stall" });
        },
      }),
    ).rejects.toThrow("stall");
    expect(calls).toBe(1);
  });
});
