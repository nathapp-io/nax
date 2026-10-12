import { describe, expect, test } from "bun:test";
import { INTERRUPT_RETRY_MS, withInterrupt } from "@/operations/send-interrupt";

describe("withInterrupt (finish A)", () => {
  test("no interrupt: runs and never calls onInterrupt", async () => {
    let calls = 0;
    const out = await withInterrupt(
      undefined,
      async () => {
        calls += 1;
        return true;
      },
      async () => 7,
    );
    expect(out).toBe(7);
    expect(calls).toBe(0);
  });

  test("aborting the interrupt while the turn runs calls onInterrupt once", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    let release: () => void = () => {};
    const run = withInterrupt(
      interrupt.signal,
      async () => {
        calls += 1;
        release();
        return true;
      },
      () =>
        new Promise<string>((r) => {
          release = () => r("done");
        }),
    );
    interrupt.abort();
    expect(await run).toBe("done");
    expect(calls).toBe(1);
  });

  test("the listener is removed after the turn settles", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    await withInterrupt(
      interrupt.signal,
      async () => {
        calls += 1;
        return true;
      },
      async () => "x",
    );
    interrupt.abort();
    expect(calls).toBe(0);
  });

  test("already aborted on entry: interrupts without waiting for an abort event", async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    let release: () => void = () => {};
    let calls = 0;
    const run = withInterrupt(
      interrupt.signal,
      async () => {
        calls += 1;
        release();
        return true;
      },
      () =>
        new Promise<string>((r) => {
          release = () => r("ok");
        }),
    );
    expect(await run).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries until a call registers (false, then true)", async () => {
    const interrupt = new AbortController();
    let release: () => void = () => {};
    let calls = 0;
    const run = withInterrupt(
      interrupt.signal,
      async () => {
        calls += 1;
        if (calls < 2) return false;
        release();
        return true;
      },
      () =>
        new Promise<string>((r) => {
          release = () => r("ok");
        }),
    );
    interrupt.abort();
    expect(await run).toBe("ok");
    expect(calls).toBe(2);
    expect(INTERRUPT_RETRY_MS).toBe(250);
  });

  test("a rejecting onInterrupt never rejects the turn", async () => {
    const interrupt = new AbortController();
    let release: () => void = () => {};
    const run = withInterrupt(
      interrupt.signal,
      async () => {
        release();
        throw new Error("boom");
      },
      () =>
        new Promise<string>((r) => {
          release = () => r("ok");
        }),
    );
    interrupt.abort();
    expect(await run).toBe("ok");
  });
});
