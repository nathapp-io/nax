/**
 * US-001 (item-publish-pacing): the publish-scoped forge-write pacer.
 *
 * Every wait goes through `_itemPublishPacerDeps.sleep`, so these tests record the waits instead
 * of spending them; the only real time here is the logger's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitForCondition } from "@test/helpers";
import { NaxError } from "@/errors";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { ItemPublishConfig } from "@/workflow/item-publish-pacer";
import { _itemPublishPacerDeps, createItemPublishPacer, isRetryableRejection } from "@/workflow/item-publish-pacer";

const RATE_LIMIT =
  "gh: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.";
const BUDGET_SPENT = "ITEM_PUBLISH_BUDGET_SPENT";
const RETRY_WARN = "[item-threads] Write rejected; retrying after back-off";

const rejection = (stderr: string): NaxError =>
  new NaxError(`[forge] Cannot write o/r#7: ${stderr}`, "FORGE_COMMENT_WRITE_FAILED", { stage: "forge", stderr });

const config = (over: Partial<ItemPublishConfig> = {}): ItemPublishConfig => ({
  writeGapMs: 1000,
  retryBackoffMs: 60_000,
  maxRetries: 2,
  maxWaitMs: 300_000,
  ...over,
});

/** `writeGapMs: 10`, `retryBackoffMs: 100`, `maxWaitMs: 100`: one 100 ms back-off fits, a second does not. */
const TIGHT = { writeGapMs: 10, retryBackoffMs: 100, maxWaitMs: 100, maxRetries: 2 };

const realSleep = _itemPublishPacerDeps.sleep;
let sleeps: number[];
let logs: LogEntry[];
let removeSink: () => void;

beforeEach(() => {
  sleeps = [];
  logs = [];
  _itemPublishPacerDeps.sleep = async (ms) => {
    sleeps.push(ms);
  };
  initLogger({ level: "silent", suppressConsole: true });
  removeSink = addSink((entry) => {
    logs.push(entry);
  });
});

afterEach(() => {
  _itemPublishPacerDeps.sleep = realSleep;
  removeSink();
  resetLogger();
});

describe("isRetryableRejection", () => {
  test.each([
    ["a secondary rate limit message", RATE_LIMIT],
    ["an HTTP 422 validation failure", "gh: Validation Failed (HTTP 422)"],
    ["an HTTP 429", "gh: HTTP 429"],
    ["a lower-case http 422", "gh: validation failed (http 422)"],
  ])("AC-4..AC-6: returns true for %s", (_label, stderr) => {
    expect(isRetryableRejection(rejection(stderr))).toBe(true);
  });

  test("AC-7: returns false for an HTTP 502 — the write may already have landed", () => {
    expect(isRetryableRejection(rejection("gh: HTTP 502: Bad Gateway"))).toBe(false);
  });

  test("AC-8: returns false for a FORGE_RESPONSE_UNPARSEABLE reply and for a plain Error", () => {
    const unparseable = new NaxError("[forge] Invalid write response", "FORGE_RESPONSE_UNPARSEABLE", {
      stage: "forge",
      stderr: RATE_LIMIT,
    });
    expect(isRetryableRejection(unparseable)).toBe(false);
    expect(isRetryableRejection(new Error(RATE_LIMIT))).toBe(false);
  });

  test("returns false for a forge write failure whose context carries no stderr", () => {
    expect(
      isRetryableRejection(new NaxError("[forge] Cannot write", "FORGE_COMMENT_WRITE_FAILED", { stage: "forge" })),
    ).toBe(false);
  });
});

describe("createItemPublishPacer — the gap", () => {
  test("AC-9: the first write takes no gap, the second waits writeGapMs", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 1000 }));
    const order: string[] = [];
    const first = await pacer.write(async () => {
      order.push(`first after ${sleeps.join(",")}`);
      return "a";
    });
    expect(sleeps).toEqual([]);
    const second = await pacer.write(async () => {
      order.push(`second after ${sleeps.join(",")}`);
      return "b";
    });
    expect(sleeps).toEqual([1000]);
    expect(first).toBe("a");
    expect(second).toBe("b");
    expect(order).toEqual(["first after ", "second after 1000"]);
  });

  test("a reserved write counts as the publish's first write, so the next write pays the gap", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 500 }));
    await pacer.writeReserved(async () => "index");
    await pacer.write(async () => "thread");
    expect(sleeps).toEqual([500]);
  });
});

describe("createItemPublishPacer — retries", () => {
  test("AC-10: a write rejected once and then accepted resolves after one back-off sleep", async () => {
    const pacer = createItemPublishPacer(config({ retryBackoffMs: 60_000 }));
    let calls = 0;
    const result = await pacer.write(async () => {
      calls++;
      if (calls === 1) throw rejection("gh: HTTP 429");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60_000]);
    expect(pacer.spent).toBe(false);
  });

  test("AC-11: an always-rejected write rejects with its own rejection after maxRetries retries", async () => {
    const pacer = createItemPublishPacer(config({ maxRetries: 2, retryBackoffMs: 100 }));
    const failure = rejection(RATE_LIMIT);
    let calls = 0;
    await expect(
      pacer.write(async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 100]);
  });

  test("AC-12: a non-retryable rejection propagates after one call with no back-off", async () => {
    const pacer = createItemPublishPacer(config());
    const failure = new NaxError("[forge] Invalid write response", "FORGE_RESPONSE_UNPARSEABLE", { stage: "forge" });
    let calls = 0;
    await expect(
      pacer.write(async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("AC-18: a per-write retries option overrides the pacer's maxRetries", async () => {
    const pacer = createItemPublishPacer(config({ maxRetries: 2 }));
    const failure = rejection("gh: Validation Failed (HTTP 422)");
    let calls = 0;
    await expect(
      pacer.write(
        async () => {
          calls++;
          throw failure;
        },
        { retries: 0 },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("writeReserved is still bounded by maxRetries", async () => {
    const pacer = createItemPublishPacer(config({ maxRetries: 1, retryBackoffMs: 100 }));
    const failure = rejection(RATE_LIMIT);
    let calls = 0;
    await expect(
      pacer.writeReserved(async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([100]);
  });
});

describe("createItemPublishPacer — the wait budget", () => {
  test("AC-13: a back-off that would exceed the budget is not taken, and the rejection is rethrown", async () => {
    const pacer = createItemPublishPacer(config(TIGHT));
    const failure = rejection("gh: HTTP 429");
    let calls = 0;
    await expect(
      pacer.write(async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([100]);
    expect(pacer.spent).toBe(true);
  });

  test("AC-14: a gap that would exceed the spent budget refuses the write unrun", async () => {
    const pacer = createItemPublishPacer(config(TIGHT));
    const failure = rejection("gh: HTTP 429");
    await expect(pacer.write(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(pacer.spent).toBe(true);
    sleeps.length = 0;
    let ran = false;
    let refusal: unknown;
    try {
      await pacer.write(async () => {
        ran = true;
        return "ok";
      });
    } catch (error) {
      refusal = error;
    }
    if (!(refusal instanceof NaxError))
      throw new Error(`expected an ITEM_PUBLISH_BUDGET_SPENT NaxError, got ${refusal}`);
    expect(refusal.code).toBe(BUDGET_SPENT);
    expect(ran).toBe(false);
    expect(sleeps).toEqual([]);
  });

  test("AC-15: maxWaitMs: 0 still runs a write that needs no wait", async () => {
    const pacer = createItemPublishPacer(config({ maxWaitMs: 0 }));
    const result = await pacer.write(async () => "ok");
    expect(result).toBe("ok");
    expect(sleeps).toEqual([]);
    expect(pacer.spent).toBe(false);
  });

  test("a gap of 0 ms needs no wait, so every write runs even with a spent budget", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 0, maxWaitMs: 0 }));
    expect(await pacer.write(async () => "first")).toBe("first");
    expect(await pacer.write(async () => "second")).toBe("second");
    expect(sleeps).toEqual([]);
    expect(pacer.spent).toBe(false);
  });

  test("a reserved write may carry the total past the budget; a later gap-free write still runs", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 0, retryBackoffMs: 100, maxWaitMs: 50 }));
    let calls = 0;
    await pacer.writeReserved(async () => {
      calls++;
      if (calls === 1) throw rejection("gh: HTTP 429");
      return "index";
    });
    expect(sleeps).toEqual([100]);
    expect(pacer.spent).toBe(false);
    expect(await pacer.write(async () => "thread")).toBe("thread");
  });

  test("with maxWaitMs: 0 the publish's second write is refused rather than waiting its gap", async () => {
    const pacer = createItemPublishPacer(config({ maxWaitMs: 0 }));
    await pacer.write(async () => "first");
    const refusal = await pacer.write(async () => "second").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NaxError);
    expect(pacer.spent).toBe(true);
    expect(sleeps).toEqual([]);
  });

  test("AC-16: writeReserved runs after the budget is spent, still backs off, and leaves spent true", async () => {
    const pacer = createItemPublishPacer(config(TIGHT));
    const failure = rejection("gh: HTTP 429");
    await expect(pacer.write(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(pacer.spent).toBe(true);
    sleeps.length = 0;
    let calls = 0;
    const result = await pacer.writeReserved(async () => {
      calls++;
      if (calls === 1) throw failure;
      return "index";
    });
    expect(result).toBe("index");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10, 100]);
    expect(pacer.spent).toBe(true);
  });
});

describe("createItemPublishPacer — logging", () => {
  test("AC-17: a retry logs a warn line with the write's itemId and the retry number", async () => {
    const pacer = createItemPublishPacer(config({ retryBackoffMs: 100 }));
    let calls = 0;
    await pacer.write(
      async () => {
        calls++;
        if (calls === 1) throw rejection("gh: HTTP 429");
        return "ok";
      },
      { itemId: "_run:cv1" },
    );
    const warns = logs.filter((entry) => entry.level === "warn" && entry.message === RETRY_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0].stage).toBe("item-threads");
    expect(warns[0].data?.itemId).toBe("_run:cv1");
    expect(warns[0].data?.attempt).toBe(1);
  });

  test("each retry's attempt field is its retry number", async () => {
    const pacer = createItemPublishPacer(config({ retryBackoffMs: 100, maxRetries: 2 }));
    const failure = rejection("gh: HTTP 429");
    await expect(pacer.write(async () => Promise.reject(failure), { itemId: "b2" })).rejects.toBe(failure);
    const attempts = logs
      .filter((entry) => entry.level === "warn" && entry.message === RETRY_WARN)
      .map((entry) => entry.data?.attempt);
    expect(attempts).toEqual([1, 2]);
  });

  test("a write with no itemId logs no itemId field", async () => {
    const pacer = createItemPublishPacer(config({ retryBackoffMs: 100 }));
    let calls = 0;
    await pacer.write(async () => {
      calls++;
      if (calls === 1) throw rejection("gh: HTTP 429");
      return "ok";
    });
    const warns = logs.filter((entry) => entry.level === "warn" && entry.message === RETRY_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0].data).not.toHaveProperty("itemId");
  });
});

// F1: a gap only spaces writes if the previous one has finished, so one pacer runs its writes
// one at a time even when its caller does not await them.
describe("createItemPublishPacer — concurrent writes are serialized", () => {
  test("F1: one action at a time, each still paying its gap, in call order", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 25, maxWaitMs: 300 }));
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const run = (label: string, block: boolean) =>
      pacer.write(async () => {
        events.push(`start:${label}`);
        if (block) await gate.promise;
        events.push(`end:${label}`);
        return label;
      });

    const writes = [run("1", true), run("2", false), run("3", false)];
    await waitForCondition(() => events.includes("start:1"));
    // The first write holds the pacer until its action settles; the other two are queued.
    expect(events).toEqual(["start:1"]);

    gate.resolve();
    expect(await Promise.all(writes)).toEqual(["1", "2", "3"]);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    // One gap before each write after the first, paid in order.
    expect(sleeps).toEqual([25, 25]);
  });

  test("F1: concurrent writes account the budget in order, so a later gap is refused", async () => {
    const pacer = createItemPublishPacer(config({ writeGapMs: 25, maxWaitMs: 30 }));
    const write = (label: string) =>
      pacer.write(async () => {
        return label;
      });

    const results = await Promise.allSettled([write("a"), write("b"), write("c")]);
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : result.status))).toEqual([
      "a",
      "b",
      "rejected",
    ]);
    expect(sleeps).toEqual([25]);
    expect(pacer.spent).toBe(true);

    const refused = results[2];
    if (refused.status !== "rejected") throw new Error("the third concurrent write should have been refused");
    if (!(refused.reason instanceof NaxError)) throw new Error(`expected a NaxError, got ${refused.reason}`);
    expect(refused.reason.code).toBe(BUDGET_SPENT);
  });
});
