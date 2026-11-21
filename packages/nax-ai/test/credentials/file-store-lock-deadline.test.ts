import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileCredentialStore } from "../../src/credentials/file-store.ts";
import type { StoredCredential } from "../../src/types.ts";

/**
 * A `lock()` call is filesystem I/O, so it can settle after the caller's whole
 * budget has gone — a lock released at 80 ms is then acquired by an attempt
 * that started before the deadline. Retry sleeps alone cannot reproduce that,
 * so the acquisition call is slowed here. `io.delayMs` is 0 (its default) for
 * every other test in the file, which then drives the real proper-lockfile.
 */
const io = vi.hoisted(() => ({
  delayMs: 0,
  /** Called when lock() is entered, so a test can await it instead of polling. */
  onLock: undefined as (() => void) | undefined,
  /** When set, lock() hands out this release function instead of taking the real lock. */
  gate: undefined as Promise<() => Promise<void>> | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    default: {
      lock: async (file: string, options?: LockOptions) => {
        io.onLock?.();
        const delay = io.delayMs;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const gate = io.gate;
        if (gate !== undefined) return await gate;
        return actual.lock(file, options);
      },
      unlock: actual.unlock,
      check: actual.check,
    },
  };
});

/**
 * lockTimeoutMs is one acquisition deadline, not a per-attempt maximum. The old
 * options let proper-lockfile retry ten times with a 1.6 backoff capped at
 * lockTimeoutMs, so the real wait could be many multiples of the configured
 * value and a lock released after the deadline could still be acquired.
 */
const A: StoredCredential = { kind: "api-key", key: "a" };
const B: StoredCredential = { kind: "api-key", key: "b" };

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-ai-lock-"));
  dirs.push(dir);
  return join(dir, "credentials.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

/** A promise the test settles by hand, standing in for lock() answering. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Drains the promise hand-offs a settled lock starts. Only microtasks are
 * involved, so this needs no event-loop turn — and deliberately does not use
 * one, which on a loaded runner can arrive before the store's file I/O does.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** Resolves after `ms`, so a release can be scheduled without awaiting it. */
function schedule(ms: number, run: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(run, ms);
}

type Outcome = { readonly status: "fulfilled" } | { readonly status: "rejected"; readonly message: string };

async function settle(promise: Promise<unknown>): Promise<Outcome> {
  return await promise.then(
    () => ({ status: "fulfilled" as const }),
    (error: Error) => ({ status: "rejected" as const, message: error.message }),
  );
}

const TIMED_OUT = "Timed out waiting for the credential file lock";

/** An outcome that did not reject has no message; the status assertion catches that. */
function rejectionOf(outcome: Outcome | undefined): string {
  return outcome?.status === "rejected" ? outcome.message : "";
}

/** Holds the lock inside a modify callback until `release` is resolved. */
function holdLock(store: ReturnType<typeof createFileCredentialStore>, entered: () => void, release: Promise<void>) {
  return store.modify("a", async () => {
    entered();
    await release;
    return A;
  });
}

describe("createFileCredentialStore lock acquisition deadline", () => {
  it("gives up at lockTimeoutMs when the holder releases the lock later", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 20 });
    const holding = barrier();
    const release = barrier();
    const first = holdLock(store, holding.resolve, release.promise);
    let outcome: Outcome | undefined;
    let callbackRan = false;
    try {
      await holding.promise;
      // The first writer releases 80 ms after the second call starts, i.e. long
      // after its 20 ms deadline.
      const lateRelease = schedule(80, release.resolve);
      try {
        outcome = await settle(
          store.modify("b", async () => {
            callbackRan = true;
            return B;
          }),
        );
      } finally {
        clearTimeout(lateRelease);
      }
    } finally {
      release.resolve();
      await settle(first);
    }
    expect(outcome?.status).toBe("rejected");
    expect(rejectionOf(outcome)).toContain(TIMED_OUT);
    expect(callbackRan).toBe(false);
  });

  it("gives a lock back when its in-flight acquisition settles after the deadline", async () => {
    // The window the retry sleep cannot cover: every lock() call here takes
    // 80 ms, four times the whole budget, so the attempt that finally sees the
    // released lock FINISHES long after the deadline instead of starting a
    // sleep before it. That attempt must not hand the lock to the caller.
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 20 });
    const holding = barrier();
    const release = barrier();
    const first = holdLock(store, holding.resolve, release.promise);
    let outcome: Outcome | undefined;
    let callbackRan = false;
    try {
      await holding.promise;
      io.delayMs = 80;
      // Released 10 ms in: inside the first attempt's I/O, not after it.
      const lateRelease = schedule(10, release.resolve);
      try {
        outcome = await settle(
          store.modify("b", async () => {
            callbackRan = true;
            return B;
          }),
        );
      } finally {
        clearTimeout(lateRelease);
        io.delayMs = 0;
      }
    } finally {
      release.resolve();
      await settle(first);
    }
    expect(outcome?.status).toBe("rejected");
    expect(rejectionOf(outcome)).toContain(TIMED_OUT);
    expect(callbackRan).toBe(false);
    // Handed back, not leaked: a lock taken after the deadline and never
    // released would block every writer until it went stale.
    await expect(createFileCredentialStore({ path, lockTimeoutMs: 1000 }).modify("c", async () => B)).resolves.toEqual(
      B,
    );
    expect(await createFileCredentialStore({ path }).read("b")).toBeUndefined();
  });

  it("rejects at the deadline instead of waiting for cleanup of a lock acquired past it", async () => {
    // The post-acquisition check runs when lock() answers past the deadline
    // while the deadline timer is still unrun — an event-loop stall delays the
    // timer but not the promise callback. Releasing the lock there used to be
    // awaited, so a slow cleanup held the rejection back for its duration (a
    // 200 ms release turned a 20 ms budget into 254 ms) and a rejecting one
    // replaced the timeout error outright.
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 20 });
    const handed = deferred<() => Promise<void>>();
    const attempted = deferred<void>();
    let releaseCalled = false;
    let cleanupDone = false;
    let callbackRan = false;
    let outcome: Outcome | undefined;
    io.onLock = () => attempted.resolve();
    io.gate = handed.promise;
    try {
      // Only the clock and the deadline timer are faked: the store's real fs
      // I/O still needs the event loop, so that is left alone.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      void settle(
        store.modify("b", async () => {
          callbackRan = true;
          return B;
        }),
      ).then((settled) => {
        outcome = settled;
      });
      // The file is created first, so this waits on the attempt, not on a guess.
      await attempted.promise;

      // The stall: past the deadline with its timer unrun, so lock() answering
      // now is seen by the post-acquisition check, not by the timer.
      vi.setSystemTime(Date.now() + 45);
      handed.resolve(() => {
        releaseCalled = true;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            cleanupDone = true;
            resolve();
          }, 200);
        });
      });
      await flush();

      // Answered at once rather than whenever the cleanup happens to finish.
      expect(outcome?.status).toBe("rejected");
      expect(rejectionOf(outcome)).toContain(TIMED_OUT);
      expect(callbackRan).toBe(false);
      // Started all the same: a lock taken past the deadline and never
      // released would block every writer until it went stale.
      expect(releaseCalled).toBe(true);
      expect(cleanupDone).toBe(false);

      vi.advanceTimersByTime(200);
      await flush();
      expect(cleanupDone).toBe(true);
    } finally {
      io.gate = undefined;
      io.onLock = undefined;
      vi.useRealTimers();
    }
    expect(await createFileCredentialStore({ path }).read("b")).toBeUndefined();
  });

  it("rejects at the deadline rather than when the in-flight lock() call finally answers", async () => {
    // The failure mode a post-hoc deadline check cannot catch: the caller is
    // blocked INSIDE lock(), so a 20 ms budget could only be reported when that
    // call settled — 300 ms here, whatever the option asked for.
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 20 });
    const holding = barrier();
    const release = barrier();
    const first = holdLock(store, holding.resolve, release.promise);
    let outcome: Outcome | undefined;
    let elapsed = Number.POSITIVE_INFINITY;
    try {
      await holding.promise;
      io.delayMs = 300;
      const startedAt = Date.now();
      try {
        outcome = await settle(store.modify("b", async () => B));
      } finally {
        elapsed = Date.now() - startedAt;
        io.delayMs = 0;
      }
    } finally {
      release.resolve();
      await settle(first);
    }
    expect(outcome?.status).toBe("rejected");
    expect(rejectionOf(outcome)).toContain(TIMED_OUT);
    // Well clear of both bounds: the deadline is 20 ms and the attempt's own
    // I/O is 300 ms, so anything near either side is unambiguous.
    expect(elapsed).toBeLessThan(250);
  });

  it("gives up less than twice the deadline after it started, however long the holder keeps the lock", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 200 });
    const holding = barrier();
    const release = barrier();
    const first = holdLock(store, holding.resolve, release.promise);
    let outcome: Outcome | undefined;
    let elapsed = Number.POSITIVE_INFINITY;
    try {
      await holding.promise;
      const startedAt = Date.now();
      outcome = await settle(store.modify("b", async () => B));
      elapsed = Date.now() - startedAt;
    } finally {
      release.resolve();
      await settle(first);
    }
    expect(outcome?.status).toBe("rejected");
    expect(rejectionOf(outcome)).toContain(TIMED_OUT);
    expect(elapsed).toBeLessThan(400);
  });

  it("acquires the lock when the holder releases it within the deadline", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path, lockTimeoutMs: 1000 });
    const holding = barrier();
    const release = barrier();
    const first = holdLock(store, holding.resolve, release.promise);
    let outcome: Outcome | undefined;
    try {
      await holding.promise;
      const earlyRelease = schedule(50, release.resolve);
      try {
        outcome = await settle(store.modify("b", async () => B));
      } finally {
        clearTimeout(earlyRelease);
      }
    } finally {
      release.resolve();
      await settle(first);
    }
    expect(outcome?.status).toBe("fulfilled");
    expect(await createFileCredentialStore({ path }).read("b")).toEqual(B);
  });

  it("acquires an uncontended lock with the default timeout", async () => {
    const path = tempPath();
    const store = createFileCredentialStore({ path });
    await expect(store.modify("a", async () => A)).resolves.toEqual(A);
    expect(await createFileCredentialStore({ path }).read("a")).toEqual(A);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, credentials: { a: A } });
  });
});
