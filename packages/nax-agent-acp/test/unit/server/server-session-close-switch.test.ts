/**
 * A terminal close() that lands during a mode or model switch (spec §Design 1-3,
 * nax#2654): the switch sets `closed` for its gap, so close() must wait for it,
 * close whichever S3 session the switch left live, and make the interrupted
 * switch reject `session is closed` instead of resolving or rethrowing.
 */
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { createServerSession, TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import type { OldText } from "#src/server/translate/diff";
import { type FakeAgentSession, fakeAgentSession } from "#test/helpers/fake-agent-session";
import { fakePort } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const missing = async (): Promise<OldText> => ({ kind: "missing" });
const text = (t: string) => [{ type: "text" as const, text: t }];

function setup(first: FakeAgentSession) {
  const port = fakePort();
  const { logger, lines } = recordingLogger();
  const session = createServerSession({
    session: first.session,
    port: port.port,
    cwd: "/w",
    readOldText: missing,
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  return { port, lines, session };
}

type Outcome = { readonly kind: "resolved" } | { readonly kind: "rejected"; readonly error: unknown };

/** A promise's fate, so a rejection is never unhandled while a test asserts. */
function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
}

/** Asserts rejection and returns what was thrown. */
function rejected(result: Outcome): unknown {
  expect(result.kind).toBe("rejected");
  return result.kind === "rejected" ? result.error : undefined;
}

function messageOfThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : "";
}

/**
 * Probes a promise's state after a macrotask, racing its fate against an
 * already-settled marker. The macrotask first drains every microtask, so a
 * promise that is already settled reports "settled" instead of riding the tick
 * its observer was attached in.
 */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const marked = promise.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return (await Promise.race([marked, Promise.resolve("pending" as const)])) === "pending";
}

/** Counts every close() the fake receives, whichever caller makes it. */
function countCloses(fake: FakeAgentSession): () => number {
  const close = fake.session.close.bind(fake.session);
  let count = 0;
  fake.session.close = async () => {
    count += 1;
    await close();
  };
  return () => count;
}

/** The old session's second close() never settles: only a close that re-closes it would stall. */
function hangAfterFirstClose(fake: FakeAgentSession): () => number {
  const close = fake.session.close.bind(fake.session);
  let count = 0;
  fake.session.close = async () => {
    count += 1;
    if (count > 1) await new Promise<void>(() => {});
    await close();
  };
  return () => count;
}

interface GatedSwitch {
  readonly s: ReturnType<typeof setup>;
  /** Resolves once open() is running and waiting on the gate. */
  readonly started: Promise<void>;
  readonly release: () => void;
  /** The switch's fate, never unhandled. */
  readonly switching: Promise<Outcome>;
}

/** A switch whose `open` waits on a gate the test releases. */
function gatedSwitch(a: FakeAgentSession, b: FakeAgentSession): GatedSwitch {
  const s = setup(a);
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const switching = outcome(
    s.session.switchTo(
      async () => {
        started.resolve();
        await gate.promise;
        return { session: b.session };
      },
      async () => ({ session: a.session }),
    ),
  );
  return { s, started: started.promise, release: () => gate.resolve(), switching };
}

interface CloseDuringOpen {
  readonly a: FakeAgentSession;
  readonly b: FakeAgentSession;
  readonly g: GatedSwitch;
  readonly raw: Promise<void>;
  readonly closing: Promise<Outcome>;
}

/** A switch whose open is still pending, with close() already called during the gap. */
async function closeDuringGatedOpen(): Promise<CloseDuringOpen> {
  const a = fakeAgentSession("s1", []);
  const b = fakeAgentSession("s1", []);
  const g = gatedSwitch(a, b);
  await g.started;
  const raw = g.s.session.close();
  return { a, b, g, raw, closing: outcome(raw) };
}

describe("isClosing (spec §Design 1)", () => {
  test("AC-1: a new server session is not closing", () => {
    const s = setup(fakeAgentSession("s1", []));
    expect(s.session.isClosing()).toBe(false);
  });
});

describe("close during a switch whose open succeeds", () => {
  test("AC-2: isClosing is true right after close() is called while the open is pending", async () => {
    const a = fakeAgentSession("s1", []);
    const b = fakeAgentSession("s1", []);
    const g = gatedSwitch(a, b);
    await g.started;
    const closing = outcome(g.s.session.close());
    expect(g.s.session.isClosing()).toBe(true);
    g.release();
    await Promise.all([closing, g.switching]);
  });

  test("AC-3: that close() stays unresolved after the old session is observed closed", async () => {
    const { a, g, raw, closing } = await closeDuringGatedOpen();
    await waitForCondition(() => a.closed());
    expect(await stillPending(raw)).toBe(true);
    expect(await stillPending(closing)).toBe(true);
    g.release();
    await Promise.all([closing, g.switching]);
  });

  test("AC-4: it resolves once the gated open settles with session b", async () => {
    const { g, raw, closing } = await closeDuringGatedOpen();
    g.release();
    await expect(raw).resolves.toBeUndefined();
    await Promise.all([closing, g.switching]);
  });

  test("AC-5: the replacement session b is closed once close() settles", async () => {
    const { b, g, raw, closing } = await closeDuringGatedOpen();
    g.release();
    await raw;
    await Promise.all([closing, g.switching]);
    expect(b.closed()).toBe(true);
  });

  test("AC-6: the interrupted switch rejects with a RequestError saying session is closed", async () => {
    const { g, raw, closing } = await closeDuringGatedOpen();
    g.release();
    await raw;
    const thrown = rejected(await g.switching);
    expect(thrown).toBeInstanceOf(RequestError);
    expect(messageOfThrown(thrown)).toContain("session is closed");
    await closing;
  });

  test("AC-7: a prompt after both settle rejects with session is closed", async () => {
    const { g, raw, closing } = await closeDuringGatedOpen();
    g.release();
    await raw;
    await Promise.all([closing, g.switching]);
    const thrown = await g.s.session.prompt(text("after")).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(RequestError);
    expect(messageOfThrown(thrown)).toContain("session is closed");
  });

  test("AC-8: isClosed() stays true after both settle", async () => {
    const { g, raw, closing } = await closeDuringGatedOpen();
    g.release();
    await raw;
    await Promise.all([closing, g.switching]);
    expect(g.s.session.isClosed()).toBe(true);
  });
});

describe("close during a switch whose open fails and whose restore succeeds", () => {
  interface GatedRestore {
    readonly a: FakeAgentSession;
    readonly c: FakeAgentSession;
    readonly s: ReturnType<typeof setup>;
    readonly switching: Promise<Outcome>;
  }

  async function closeDuringGatedRestore(): Promise<GatedRestore> {
    const a = fakeAgentSession("s1", []);
    const c = fakeAgentSession("s1", []);
    const s = setup(a);
    const restoreStarted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const switching = outcome(
      s.session.switchTo(
        async () => {
          throw new Error("bad model");
        },
        async () => {
          restoreStarted.resolve();
          await gate.promise;
          return { session: c.session };
        },
      ),
    );
    await restoreStarted.promise;
    const closing = outcome(s.session.close());
    gate.resolve();
    await closing;
    return { a, c, s, switching };
  }

  test("AC-9: the restored session c is closed once close() settles", async () => {
    const { c, switching } = await closeDuringGatedRestore();
    await switching;
    expect(c.closed()).toBe(true);
  });

  test("AC-10: the switch rejects session is closed, not the open error", async () => {
    const { switching } = await closeDuringGatedRestore();
    const thrown = rejected(await switching);
    expect(messageOfThrown(thrown)).toContain("session is closed");
    expect(messageOfThrown(thrown)).not.toContain("bad model");
  });
});

describe("close during a switch whose open and restore both fail", () => {
  interface BothFail {
    readonly s: ReturnType<typeof setup>;
    readonly closes: () => number;
    readonly raw: Promise<void>;
    readonly closing: Promise<Outcome>;
    readonly switching: Promise<Outcome>;
  }

  async function closeDuringBothFail(): Promise<BothFail> {
    const a = fakeAgentSession("s1", []);
    const closes = countCloses(a);
    const s = setup(a);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const switching = outcome(
      s.session.switchTo(
        async () => {
          started.resolve();
          await gate.promise;
          throw new Error("open failed");
        },
        async () => {
          throw new Error("restore failed");
        },
      ),
    );
    await started.promise;
    const raw = s.session.close();
    gate.resolve();
    return { s, closes, raw, closing: outcome(raw), switching };
  }

  test("AC-11: close() resolves", async () => {
    const { closing } = await closeDuringBothFail();
    expect((await closing).kind).toBe("resolved");
  });

  test("AC-12: the switch rejects session is closed, not the open error", async () => {
    const { switching } = await closeDuringBothFail();
    const thrown = rejected(await switching);
    expect(messageOfThrown(thrown)).toContain("session is closed");
    expect(messageOfThrown(thrown)).not.toContain("open failed");
  });

  test("AC-13: the old session's close is called exactly once, by the switch", async () => {
    const { closes, raw, switching } = await closeDuringBothFail();
    await raw;
    await switching;
    expect(closes()).toBe(1);
  });
});

describe("two close() calls during one switch", () => {
  interface TwoCloses {
    readonly g: GatedSwitch;
    readonly replacementCloses: () => number;
    readonly first: Promise<void>;
    readonly second: Promise<void>;
  }

  function twoCloses(): TwoCloses {
    const a = fakeAgentSession("s1", []);
    const b = fakeAgentSession("s1", []);
    const replacementCloses = countCloses(b);
    const g = gatedSwitch(a, b);
    return { g, replacementCloses, first: g.s.session.close(), second: g.s.session.close() };
  }

  test("AC-14: both stay unresolved while the open is pending", async () => {
    const { g, first, second } = twoCloses();
    await g.started;
    expect(await stillPending(first)).toBe(true);
    expect(await stillPending(second)).toBe(true);
    g.release();
    await Promise.all([outcome(first), outcome(second), g.switching]);
  });

  test("AC-15: both resolve once the open settles", async () => {
    const { g, first, second } = twoCloses();
    await g.started;
    g.release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await g.switching;
  });

  test("AC-16: the second call returns the first call's promise", async () => {
    const { g, first, second } = twoCloses();
    expect(second).toBe(first);
    await g.started;
    g.release();
    await Promise.all([outcome(first), g.switching]);
  });

  test("AC-17: the replacement session's close is called exactly once", async () => {
    const { g, replacementCloses, first, second } = twoCloses();
    await g.started;
    g.release();
    await Promise.all([outcome(first), outcome(second), g.switching]);
    expect(replacementCloses()).toBe(1);
  });
});

describe("switchTo after close()", () => {
  function closedSession() {
    const a = fakeAgentSession("s1", []);
    const b = fakeAgentSession("s1", []);
    const s = setup(a);
    const closing = outcome(s.session.close());
    return { a, b, s, closing };
  }

  test("AC-18: switchTo rejects with session is closed", async () => {
    const { a, b, s, closing } = closedSession();
    await closing;
    const thrown = rejected(
      await outcome(
        s.session.switchTo(
          async () => ({ session: b.session }),
          async () => ({ session: a.session }),
        ),
      ),
    );
    expect(messageOfThrown(thrown)).toContain("session is closed");
  });

  test("AC-19: switchTo never calls its open callback", async () => {
    const { a, b, s, closing } = closedSession();
    await closing;
    let opened = false;
    await outcome(
      s.session.switchTo(
        async () => {
          opened = true;
          return { session: b.session };
        },
        async () => ({ session: a.session }),
      ),
    );
    expect(opened).toBe(false);
  });
});

describe("close() on a session a failed switch left dead", () => {
  interface DeadSession {
    readonly s: ReturnType<typeof setup>;
    readonly closes: () => number;
  }

  /** Both open and restore fail, and nothing asks the session to close during the switch. */
  async function deadSession(): Promise<DeadSession> {
    const a = fakeAgentSession("s1", []);
    const closes = hangAfterFirstClose(a);
    const s = setup(a);
    await outcome(
      s.session.switchTo(
        async () => {
          throw new Error("open failed");
        },
        async () => {
          throw new Error("restore failed");
        },
      ),
    );
    expect(s.session.isClosed()).toBe(true);
    return { s, closes };
  }

  test("AC-20: close() resolves at once, without re-closing the dead session", async () => {
    const { s, closes } = await deadSession();
    const closing = s.session.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("pending"), 100);
    });
    try {
      expect(await Promise.race([closing.then(() => "closed" as const), late])).toBe("closed");
    } finally {
      clearTimeout(timer);
    }
    expect(closes()).toBe(1);
  });

  test("AC-21: isClosing() is true immediately", async () => {
    const { s } = await deadSession();
    const closing = s.session.close();
    expect(s.session.isClosing()).toBe(true);
    await closing;
  });
});

describe("close() with no switch in flight", () => {
  test("AC-22: it still closes the live S3 session", async () => {
    const a = fakeAgentSession("s1", []);
    const s = setup(a);
    await s.session.close();
    expect(a.closed()).toBe(true);
  });

  test("AC-23: it resolves", async () => {
    const s = setup(fakeAgentSession("s1", []));
    await expect(s.session.close()).resolves.toBeUndefined();
  });
});
