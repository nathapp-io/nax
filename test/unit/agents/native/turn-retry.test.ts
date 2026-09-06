import { describe, expect, test } from "bun:test";
import {
  abortableSleep,
  canAttemptTurnRetry,
  isRetryableTransportFault,
  retryTransportFault,
  turnRetryDelayMs,
} from "@/agents/native/session/turn-retry";

/** Mirrors the fixture ProtocolStreamError used in turn-loop-compaction.test.ts. */
class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string; retryAfter?: number }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

const config = { maxAttempts: 3, baseDelayMs: 1000 };

describe("isRetryableTransportFault", () => {
  test("accepts transport and overloaded", () => {
    expect(isRetryableTransportFault(new ProtocolStreamError({ kind: "transport", message: "x" }))).toBe(true);
    expect(isRetryableTransportFault(new ProtocolStreamError({ kind: "overloaded", message: "x" }))).toBe(true);
  });

  test("rejects auth, bad-request, rate-limit and context-overflow", () => {
    for (const kind of ["auth", "bad-request", "rate-limit", "context-overflow"]) {
      expect(isRetryableTransportFault(new ProtocolStreamError({ kind, message: "x" }))).toBe(false);
    }
  });

  test("rejects a plain error with no protocolError", () => {
    expect(isRetryableTransportFault(new Error("plain"))).toBe(false);
  });

  test("rejects non-object throws", () => {
    expect(isRetryableTransportFault("boom")).toBe(false);
    expect(isRetryableTransportFault(undefined)).toBe(false);
  });
});

describe("canAttemptTurnRetry", () => {
  test("allows attempts up to maxAttempts - 1 retries", () => {
    expect(canAttemptTurnRetry(0, config)).toBe(true);
    expect(canAttemptTurnRetry(1, config)).toBe(true);
    expect(canAttemptTurnRetry(2, config)).toBe(false);
  });
});

describe("turnRetryDelayMs", () => {
  test("honours the provider's retryAfter (seconds) over backoff", () => {
    const err = new ProtocolStreamError({ kind: "overloaded", message: "x", retryAfter: 7 });
    expect(turnRetryDelayMs(err, 0, config, () => 0.999)).toBe(7000);
  });

  test("falls back to equal-jitter exponential backoff when retryAfter is absent", () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "x" });
    // ceiling = baseDelayMs * 2^retryIndex, half of it fixed and half jittered,
    // so the delay is never below ceiling/2. random is injected for determinism.
    expect(turnRetryDelayMs(err, 0, config, () => 0.5)).toBe(750);
    expect(turnRetryDelayMs(err, 1, config, () => 0.5)).toBe(1500);
    expect(turnRetryDelayMs(err, 0, config, () => 1)).toBe(1000);
  });

  test("never returns a zero delay, so a just-stalled provider is not hit instantly", () => {
    const err = new ProtocolStreamError({ kind: "overloaded", message: "x" });
    expect(turnRetryDelayMs(err, 0, config, () => 0)).toBe(500);
  });

  test("clamps the backoff to the turn's remaining budget", () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "x" });
    expect(turnRetryDelayMs(err, 1, config, () => 1, 300)).toBe(300);
  });

  test("clamps the provider's retryAfter to the turn's remaining budget", () => {
    // A 503 may advertise a recovery window far longer than the turn has left.
    // Sleeping it out would spend wall clock the budget already declared gone,
    // and the attempt after it aborts at once (remainingMs clamps to 0).
    const err = new ProtocolStreamError({ kind: "overloaded", message: "x", retryAfter: 600 });
    expect(turnRetryDelayMs(err, 0, config, () => 0.5, 30_000)).toBe(30_000);
  });

  test("leaves the delay alone when the turn is unbounded", () => {
    const err = new ProtocolStreamError({ kind: "overloaded", message: "x", retryAfter: 600 });
    expect(turnRetryDelayMs(err, 0, config, () => 0.5, undefined)).toBe(600_000);
  });
});

describe("abortableSleep", () => {
  test("resolves via the injected sleep when no signal is given", async () => {
    let sleptMs: number | undefined;
    await abortableSleep(250, async (ms) => {
      sleptMs = ms;
    });
    expect(sleptMs).toBe(250);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let slept = false;
    await expect(
      abortableSleep(
        100,
        async () => {
          slept = true;
        },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(slept).toBe(false);
  });

  test("rejects if the signal fires while sleeping", async () => {
    const controller = new AbortController();
    const pending = abortableSleep(
      100,
      () => new Promise(() => {}), // never resolves on its own
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe("retryTransportFault", () => {
  const noopSleep = async () => {};

  test("retries a transport error once and returns the successful result", async () => {
    const first = new ProtocolStreamError({ kind: "transport", message: "stall" });
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryTransportFault(first, {
      attempt: async () => {
        attempts += 1;
        return "ok";
      },
      config,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    // random() === 0 lands on the equal-jitter floor (ceiling / 2), never zero.
    expect(delays).toEqual([500]);
  });

  test("retries an overloaded error", async () => {
    const first = new ProtocolStreamError({ kind: "overloaded", message: "503" });
    const result = await retryTransportFault(first, {
      attempt: async () => "recovered",
      config,
      sleep: noopSleep,
      random: () => 0,
    });
    expect(result).toBe("recovered");
  });

  test("does not retry auth, bad-request or rate-limit", async () => {
    for (const kind of ["auth", "bad-request", "rate-limit"]) {
      const err = new ProtocolStreamError({ kind, message: "no" });
      let attempted = false;
      await expect(
        retryTransportFault(err, {
          attempt: async () => {
            attempted = true;
            return "never";
          },
          config,
          sleep: noopSleep,
        }),
      ).rejects.toBe(err);
      expect(attempted).toBe(false);
    }
  });

  test("leaves context-overflow alone (its own dedicated path in turn-loop.ts)", async () => {
    const err = new ProtocolStreamError({ kind: "context-overflow", message: "too long" });
    let attempted = false;
    await expect(
      retryTransportFault(err, {
        attempt: async () => {
          attempted = true;
          return "never";
        },
        config,
        sleep: noopSleep,
      }),
    ).rejects.toBe(err);
    expect(attempted).toBe(false);
  });

  test("rethrows the original error unchanged once retries are exhausted", async () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "still down" });
    let attempts = 0;

    await expect(
      retryTransportFault(err, {
        attempt: async () => {
          attempts += 1;
          throw err;
        },
        config: { maxAttempts: 2, baseDelayMs: 10 },
        sleep: noopSleep,
        random: () => 0,
      }),
    ).rejects.toBe(err);
    // maxAttempts: 2 = one retry beyond the triggering failure.
    expect(attempts).toBe(1);
  });

  test("never retries once the deadline has expired", async () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "stall" });
    let attempted = false;
    await expect(
      retryTransportFault(err, {
        attempt: async () => {
          attempted = true;
          return "never";
        },
        config,
        deadline: { expired: () => true, remainingMs: () => 0 },
        sleep: noopSleep,
      }),
    ).rejects.toBe(err);
    expect(attempted).toBe(false);
  });

  test("never retries once the signal is aborted", async () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "stall" });
    const controller = new AbortController();
    controller.abort();
    let attempted = false;
    await expect(
      retryTransportFault(err, {
        attempt: async () => {
          attempted = true;
          return "never";
        },
        config,
        signal: controller.signal,
        sleep: noopSleep,
      }),
    ).rejects.toBe(err);
    expect(attempted).toBe(false);
  });

  test("honours retryAfter for the sleep duration", async () => {
    const err = new ProtocolStreamError({ kind: "overloaded", message: "429-ish", retryAfter: 3 });
    const delays: number[] = [];
    await retryTransportFault(err, {
      attempt: async () => "ok",
      config,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([3000]);
  });

  test("clamps its sleep to the deadline's remaining budget", async () => {
    const err = new ProtocolStreamError({ kind: "overloaded", message: "x", retryAfter: 600 });
    const delays: number[] = [];
    await retryTransportFault(err, {
      attempt: async () => "ok",
      config,
      deadline: { expired: () => false, remainingMs: () => 5_000 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([5_000]);
  });

  test("fires onRetry once per retry with the retry number, delay and fault", async () => {
    const err = new ProtocolStreamError({ kind: "transport", message: "stall" });
    const beats: Array<{ retryNumber: number; delayMs: number }> = [];
    await retryTransportFault(err, {
      attempt: async () => "ok",
      config,
      sleep: async () => {},
      random: () => 0,
      onRetry: (retryNumber, delayMs) => {
        beats.push({ retryNumber, delayMs });
      },
    });
    expect(beats).toEqual([{ retryNumber: 1, delayMs: 500 }]);
  });
});
