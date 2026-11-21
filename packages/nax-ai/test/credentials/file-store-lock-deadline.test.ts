import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileCredentialStore } from "../../src/credentials/file-store.ts";
import type { StoredCredential } from "../../src/types.ts";

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
