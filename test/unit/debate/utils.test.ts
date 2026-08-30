/**
 * Unit tests for src/debate/utils.ts — the turn-concurrency semaphore and the
 * abort-race helper shared by the stateful debate orchestrator.
 */

import { describe, expect, test } from "bun:test";
import { waitForCondition } from "@test/helpers";
import { raceAgainstAbort } from "@/debate";
import { createTurnSemaphore } from "@/debate/utils";

describe("createTurnSemaphore", () => {
  test("runs a single task and returns its result", async () => {
    const sem = createTurnSemaphore(1);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  test("clamps a limit below 1 up to 1 (Math.max(1, limit))", async () => {
    const sem = createTurnSemaphore(0);
    const order: number[] = [];
    let resolveFirst: (() => void) | undefined;
    // `run()` is an async function: calling it executes synchronously up to
    // its own first `await`, and the task closure it invokes does the same —
    // so `order.push(1)` below has already happened by the time this line
    // returns. No sleep or poll is needed to observe it.
    const first = sem.run(async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return "first";
    });
    const second = sem.run(async () => {
      order.push(2);
      return "second";
    });

    // With concurrency clamped to 1, the second task must not start until the
    // first releases — `run()`'s queuing await happens synchronously too, so
    // this is observable immediately, with no timing dependency either way.
    expect(order).toEqual([1]);

    resolveFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  test("runs up to `limit` tasks concurrently, queuing the rest", async () => {
    const sem = createTurnSemaphore(2);
    const started: number[] = [];
    const releasers: Array<() => void> = [];

    const makeTask = (id: number) => () =>
      sem.run(async () => {
        started.push(id);
        await new Promise<void>((resolve) => releasers.push(resolve));
        return id;
      });

    // Same synchronous-start-to-first-suspension property as above: by the
    // time this line returns, tasks 1 and 2 have already pushed into
    // `started`, and task 3 has already queued (without running its body,
    // since it awaits its queue slot before invoking the closure).
    const tasks = [makeTask(1)(), makeTask(2)(), makeTask(3)()];
    expect([...started].sort((a, b) => a - b)).toEqual([1, 2]);

    // Releasing one slot lets the queued task 3 start, but the handoff runs
    // through several microtask hops (task 1's continuation -> run()'s
    // finally -> the queued task's continuation), so poll for it rather than
    // assuming a single synchronous step.
    releasers[0]();
    await waitForCondition(() => started.includes(3));
    expect([...started].sort((a, b) => a - b)).toEqual([1, 2, 3]);

    releasers[1]();
    releasers[2]();
    await Promise.all(tasks);
  });

  test("releases the slot even when the task throws", async () => {
    const sem = createTurnSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The slot must have been released — a second task should run immediately.
    const result = await sem.run(async () => "after-failure");
    expect(result).toBe("after-failure");
  });

  test("serves queued tasks in FIFO order", async () => {
    const sem = createTurnSemaphore(1);
    const order: number[] = [];
    let releaseFirst: (() => void) | undefined;

    // `run()` synchronously reserves the single slot before this call
    // returns, so the immediately-following `sem.run()` calls below are
    // guaranteed to queue rather than race for the slot.
    const first = sem.run(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push(1);
    });

    const second = sem.run(async () => {
      order.push(2);
    });
    const third = sem.run(async () => {
      order.push(3);
    });

    releaseFirst?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("raceAgainstAbort", () => {
  test("resolves with the promise's value when it settles before abort", async () => {
    const controller = new AbortController();
    const result = await raceAgainstAbort(Promise.resolve("done"), controller.signal, "story-1");
    expect(result).toBe("done");
  });

  test("throws immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(raceAgainstAbort(new Promise(() => {}), controller.signal, "story-1")).rejects.toMatchObject({
      code: "CALL_OP_ABORTED",
    });
  });

  test("rejects with a NaxError when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});

    const racePromise = raceAgainstAbort(never, controller.signal, "story-2");
    controller.abort();

    await expect(racePromise).rejects.toMatchObject({ code: "CALL_OP_ABORTED", context: { storyId: "story-2" } });
  });

  test("removes the abort listener once the promise settles first", async () => {
    const controller = new AbortController();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    let addCalls = 0;
    let removeCalls = 0;
    controller.signal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
      addCalls += 1;
      return originalAdd(...args);
    }) as typeof originalAdd;
    controller.signal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
      removeCalls += 1;
      return originalRemove(...args);
    }) as typeof originalRemove;

    await raceAgainstAbort(Promise.resolve("fast"), controller.signal, undefined);

    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
  });

  test("propagates the underlying promise's rejection when it rejects before abort", async () => {
    const controller = new AbortController();
    await expect(
      raceAgainstAbort(Promise.reject(new Error("underlying failure")), controller.signal, "story-3"),
    ).rejects.toThrow("underlying failure");
  });
});
