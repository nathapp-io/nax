# Native Failure Classification and Rate-Limit Wait — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "a rate limit happened, and the provider said to wait N seconds" true end to end on the native transport, and let the cheapest layer that can act on it wait rather than fail.

**Architecture:** Four changes across two repos. In **nax-ai**, `classifyThrown` stops filing every throw as `transport` and reads a status when the throw carries one. In **nax**, `toAdapterFailure` accepts the whole `protocolError` so `retryAfterSeconds` survives; the native turn loop retries `rate-limit` using the provider's own delay (and refuses to retry when that delay exceeds the turn's remaining budget); `defaultRetryStrategy` prefers the provider's delay over computed backoff; and the failure outcome reaches `post-run` through a run-scoped sink so run logs stop reporting `rateLimited: false` on every rate-limited story.

**Tech Stack:** TypeScript. **nax-ai** uses vitest (`bun run test`), tests in `test/protocols/`, relative imports with `.ts` extensions. **nax** uses `bun:test`, tests in `test/unit/...`, `@/` path alias. Both use biome (`bun run lint`) and `tsc --noEmit` (`bun run typecheck`).

**Spec:** `docs/superpowers/specs/2026-09-07-native-failure-classification-design.md` (in the nax repo). Read it before starting — this plan argues from it.

## Global Constraints

- **Two repos, strict order.** nax-ai lands and releases first; nax is inert until the pin moves. Do not start Task 5 before Task 4 completes.
  - nax: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`, branch `feat/native-failure-classification` (already created, spec already committed).
  - nax-ai: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax-ai`, currently on `docs/pi-ai-migration-assessment`. **Branch off `main`, not off that branch.**
- **Branch directly. Do not create git worktrees** — a standing user rule in this project.
- **File-size gate: `SRC_LIMIT = 600` lines, and no grandfathered file may grow.** `src/execution/post-run.ts` is at **598** and `src/operations/call.ts` at **590**. Task 8's post-run change must be net-negative. Check with `bun run check:file-sizes`.
- **Never run `nax run`** without explicit approval at the launch moment. This plan never needs it.
- **nax full suite is `bun run test`, never a bare `bun test`.** A bare `bun test` in the nax repo does not do what you expect.
- **turbo can replay a stale green.** When a nax test result matters, use `bun run test --force`. `Cached: N cached` means the result was not actually computed.
- No emojis in code, comments, or documentation.
- Commit messages use conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). No attribution trailers.
- `src/agents/native/errors.ts` maps from a discriminated kind and **must never parse a message**. Task 5 widens the carrier only; the table stays kind-keyed.
- nax-ai source must not use Bun APIs (`bun run check:no-bun-apis` enforces it). Use `vitest`, not `bun:test`, in nax-ai.

---

## File Structure

**nax-ai (Tasks 1-4):**
- Modify `src/protocols/errors.ts` — `classifyThrown` gains status extraction. The one file that owns HTTP-shaped classification; the new helper belongs beside `classifyHttpError` and `parseRetryAfter`, which it reuses.
- Modify `test/protocols/errors.test.ts` — cases for the widened behaviour and the unchanged one.
- Modify `package.json` — version bump for release.

**nax (Tasks 5-9):**
- Modify `src/agents/native/errors.ts` — `toAdapterFailure` signature widens from `kind` to the protocol error. 92 lines, ample headroom.
- Modify `src/agents/native/adapter.ts` — the two call sites (lines 216, 381).
- Modify `src/agents/native/session/turn-retry.ts` — admit `rate-limit`; add the budget-exceeded refusal. This file already owns the retry predicate and the delay computation, so both changes are local to it.
- Modify `src/agents/native/session/turn-loop.ts` — only if the refusal needs a call-site change; prefer keeping it inside `turn-retry.ts`.
- Modify `src/agents/retry/default-strategy.ts` — prefer `retryAfterSeconds`. 27 lines.
- Modify `src/runtime/index.ts` — add the `lastAdapterFailure` sink beside `agentFallbacks`.
- Modify `src/operations/call-resolvers.ts` — add `recordAdapterFailure` beside `recordAgentFallbacks`. 149 lines.
- Modify `src/operations/call.ts` — call it at the seam (line ~462). At 590/600: keep the addition to two lines or fewer.
- Modify `src/execution/post-run.ts` — read the sink; delete the dead `"will retry"` block. At 598/600: **must be net-negative.**
- Modify `src/operations/build-hop-callback.ts` — `turnResultToAgentResult` derives `rateLimited` instead of hardcoding `false`.
- Tests: `test/protocols/errors.test.ts` (nax-ai); in nax, `test/unit/agents/native/errors.test.ts`, `test/unit/agents/native/turn-retry.test.ts`, `test/unit/agents/retry/` (create if absent), `test/unit/execution/post-run-inspection.test.ts`.

---

### Task 1: nax-ai — branch and confirm the baseline

**Files:** none modified.

**Interfaces:**
- Consumes: nothing.
- Produces: a clean `feat/classify-thrown-status` branch off `main` in the nax-ai repo, with a green baseline.

- [ ] **Step 1: Branch off main**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax-ai
git checkout main && git pull --ff-only
git checkout -b feat/classify-thrown-status
git rev-parse --abbrev-ref HEAD   # expect: feat/classify-thrown-status
```

The repo may currently be on `docs/pi-ai-migration-assessment`. That branch is unrelated; do not build on it.

- [ ] **Step 2: Confirm the baseline is green before changing anything**

```bash
bun run typecheck && bun run lint && bun run test
```
Expected: all pass. If anything is red before you start, stop and report it rather than layering changes on a red tree.

---

### Task 2: nax-ai — `classifyThrown` reads a status when the throw carries one

**Files:**
- Modify: `src/protocols/errors.ts:144-155` (the `classifyThrown` function and its doc comment)
- Test: `test/protocols/errors.test.ts`

**Interfaces:**
- Consumes: `classifyProviderError(status, message)` and `parseRetryAfter(headers)`, both already exported from this file.
- Produces: `classifyThrown(cause: unknown): ProtocolError` — same signature, widened behaviour. `ProtocolError` is `{ kind, message, status?, retryAfter?, cause? }` from `./types.ts`.

**Context you need:** today `classifyThrown` returns `kind: "transport"` for any thrown value. Its comment justifies this as "a throw with no HTTP response", but nothing checks that, and provider SDKs routinely throw an object carrying a status. A thrown 429 is therefore retried inside nax-ai at 250ms/500ms and its `retry-after` is lost.

- [ ] **Step 1: Write the failing tests**

Append to `test/protocols/errors.test.ts`:

```ts
describe("classifyThrown", () => {
  it("classifies a throw carrying a 429 status as rate-limit, with its retryAfter", () => {
    const thrown = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    const error = classifyThrown(thrown);
    expect(error.kind).toBe("rate-limit");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(30);
  });

  it("classifies a throw carrying a 401 status as auth", () => {
    const thrown = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(classifyThrown(thrown).kind).toBe("auth");
  });

  it("reads a status from statusCode and from response.status", () => {
    expect(classifyThrown(Object.assign(new Error("x"), { statusCode: 429 })).kind).toBe("rate-limit");
    expect(classifyThrown(Object.assign(new Error("x"), { response: { status: 429 } })).kind).toBe("rate-limit");
  });

  it("reads retryAfter from response.headers", () => {
    const thrown = Object.assign(new Error("x"), {
      response: { status: 429, headers: { "Retry-After": "12" } },
    });
    expect(classifyThrown(thrown).retryAfter).toBe(12);
  });

  it("still classifies a throw with no status as transport", () => {
    expect(classifyThrown(new Error("ECONNRESET")).kind).toBe("transport");
    expect(classifyThrown("boom").kind).toBe("transport");
    expect(classifyThrown(undefined).kind).toBe("transport");
  });

  it("classifies a non-numeric or out-of-range status as transport", () => {
    expect(classifyThrown(Object.assign(new Error("x"), { status: "429" })).kind).toBe("transport");
    expect(classifyThrown(Object.assign(new Error("x"), { status: Number.NaN })).kind).toBe("transport");
  });

  it("preserves the original thrown value as cause", () => {
    const thrown = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(classifyThrown(thrown).cause).toBe(thrown);
  });
});
```

The "no status" case is the regression guard and must stay non-empty: it proves the widening did not swallow the connection-reset case the function was written for.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun run test -- errors
```
Expected: the status-bearing cases FAIL (`expected 'transport' to be 'rate-limit'`). The no-status cases already PASS — that is correct, they are the guard.

- [ ] **Step 3: Implement**

Replace `classifyThrown` in `src/protocols/errors.ts` and add the two helpers above it:

```ts
/**
 * A status carried by a thrown value, when it has one.
 *
 * Provider SDKs are inconsistent about where they put it: some set `status`,
 * some `statusCode`, some hang a whole `response` off the error. Anything
 * else -- a bare Error, a string, undefined -- has no status, which is the
 * case classifyThrown was originally written for.
 */
function thrownStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const it = cause as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = it.status ?? it.statusCode ?? it.response?.status;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Headers carried by a thrown value, in the same two shapes as the status. */
function thrownHeaders(cause: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const it = cause as { headers?: unknown; response?: { headers?: unknown } };
  const raw = it.headers ?? it.response?.headers;
  return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : undefined;
}

/**
 * Normalises an arbitrary thrown value into a `ProtocolError`.
 *
 * A throw carrying an HTTP status is classified from it, exactly as an error
 * event would be, and keeps its `retry-after`. Section 10.1 assigns rate
 * limits and overload capacity to the consumer, and filing a thrown 429 as
 * `transport` handed it to this module's own retry instead -- against that
 * policy, and discarding the provider's recovery time on the way.
 *
 * A throw with NO status stays `transport`: that is the connection reset, DNS
 * failure and immediate socket error this function was written for, where
 * classifyHttpError(undefined) would return "unknown" and the fault genuinely
 * is ours to retry. `cause` is preserved either way.
 */
export function classifyThrown(cause: unknown): ProtocolError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = thrownStatus(cause);
  if (status === undefined) return { kind: "transport", message, cause };

  const retryAfter = parseRetryAfter(thrownHeaders(cause));
  return {
    kind: classifyProviderError(status, message),
    message,
    status,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    cause,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun run test -- errors
```
Expected: PASS, including the pre-existing `classifyHttpError`, `classifyProviderError` and `parseRetryAfter` suites in the same file.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/protocols/errors.ts test/protocols/errors.test.ts
git commit -m "fix(errors): classify a thrown value from its HTTP status when it carries one"
```

---

### Task 3: nax-ai — confirm a thrown 429 is no longer retried internally

**Files:**
- Test: `test/protocols/retry.test.ts`

**Interfaces:**
- Consumes: `classifyThrown` from Task 2; `retryTransportFaults(makeStream, {retries, sleep, signal})` from `src/protocols/retry.ts`.
- Produces: no source change. This task proves Task 2 actually closed the hole.

**Context you need:** `retryTransportFaults` retries an attempt only when it yields a `transport` error event before any other event, OR when it throws before emitting anything. The throw branch is the leak: it presumes transport because a throw carries no `kind` to gate on. Task 2 fixed the classification; this task pins the consequence at the retry layer, which is where the observable damage was.

Read `test/protocols/retry.test.ts` first — it has `throwingStream(cause)`, `emit(...)`, `collect(...)` and `errorOf(kind)` helpers you should reuse rather than rewrite.

- [ ] **Step 1: Write the failing test**

Append to `test/protocols/retry.test.ts`:

```ts
describe("a thrown value carrying an HTTP status", () => {
  it("does not retry a thrown 429 -- rate limits are consumer policy", async () => {
    const thrown = Object.assign(new Error("Too Many Requests"), { status: 429 });
    let attempts = 0;
    const sleep = () => Promise.resolve();

    await expect(
      collect(
        retryTransportFaults(
          () => {
            attempts += 1;
            return throwingStream(thrown);
          },
          { retries: 2, sleep },
        ),
      ),
    ).rejects.toBe(thrown);

    expect(attempts).toBe(1);
  });

  it("does not retry a thrown 401 -- auth is terminal", async () => {
    const thrown = Object.assign(new Error("Unauthorized"), { status: 401 });
    let attempts = 0;
    const sleep = () => Promise.resolve();

    await expect(
      collect(
        retryTransportFaults(
          () => {
            attempts += 1;
            return throwingStream(thrown);
          },
          { retries: 2, sleep },
        ),
      ),
    ).rejects.toBe(thrown);

    expect(attempts).toBe(1);
  });

  it("still retries a thrown value with no status", async () => {
    const thrown = new Error("ECONNRESET");
    let attempts = 0;
    const sleep = () => Promise.resolve();

    await expect(
      collect(
        retryTransportFaults(
          () => {
            attempts += 1;
            return throwingStream(thrown);
          },
          { retries: 2, sleep },
        ),
      ),
    ).rejects.toBe(thrown);

    expect(attempts).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and read the result carefully**

```bash
bun run test -- retry
```

The first test will FAIL with `attempts` of 3 rather than 1, because `retryTransportFaults` currently presumes any pre-first-event throw is transport — it does not consult `classifyThrown` at all.

- [ ] **Step 3: Make the retry loop consult the classification**

In `src/protocols/retry.ts`, the `catch (cause)` branch currently reads:

```ts
if (emitted || retryIndex >= retries) throw cause;
```

It must also decline a throw that classifies as something other than `transport`. Import `classifyThrown` and gate on it:

```ts
import { classifyThrown } from "./errors.ts";
```

```ts
      } catch (cause) {
        // A throw carries no `kind` of its own, so classify it the same way an
        // error event is classified. Section 10.1 reserves rate-limit, overload,
        // auth and bad-request for the consumer; only a genuine transport fault
        // -- typically a throw with no HTTP status at all -- is ours to retry.
        if (emitted || retryIndex >= retries) throw cause;
        if (classifyThrown(cause).kind !== "transport") throw cause;
        await abortableSleep(backoffMs(retryIndex), sleep, signal);
        retryIndex += 1;
        continue;
      }
```

Update this file's header comment, which currently says a pre-first-event throw "is presumed transport-shaped" — that is no longer true.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun run test -- retry
```
Expected: PASS. `attempts` is 1 for the thrown 429 and 3 for the connection reset.

- [ ] **Step 5: Full check and commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/protocols/retry.ts test/protocols/retry.test.ts
git commit -m "fix(retry): stop retrying a thrown fault that classifies as consumer policy"
```

---

### Task 4: nax-ai — release, and bump the nax pin

**Files:**
- Modify: `package.json` (nax-ai) — version
- Modify: `package.json` (nax) — the `@nathapp/nax-ai` dependency pin

**Interfaces:**
- Consumes: Tasks 2 and 3, merged.
- Produces: a published `@nathapp/nax-ai` version above `0.1.9`, and a nax tree pinned to it. Tasks 5-9 are inert until this lands.

- [ ] **Step 1: Open the nax-ai PR and get it merged**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax-ai
git push -u origin feat/classify-thrown-status
gh pr create --fill
```

**STOP here and confirm with the user before releasing.** A release is outward-facing and is not covered by approval of this plan.

- [ ] **Step 2: Release, following the repo's own release process**

Do not invent a release command. Check `package.json` scripts and any `RELEASING.md` / changeset config in nax-ai, and follow what is there. Version `0.1.9` was released as `chore: release v0.1.9 (#32)` — mirror that shape.

- [ ] **Step 3: Bump the pin in nax and confirm the fix is in the installed dist**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
# update the @nathapp/nax-ai version in package.json to the newly released one, then:
bun install
grep -rn "thrownStatus" node_modules/@nathapp/nax-ai/dist/ | head -3
```
Expected: the grep finds the new helper. If it does not, the installed dist predates the fix and Tasks 5-9 will produce green tests over a broken path — stop and resolve it.

- [ ] **Step 4: Commit the pin**

```bash
git add package.json bun.lock
git commit -m "chore(deps): bump @nathapp/nax-ai for thrown-status classification"
```

---

### Task 5: nax — `toAdapterFailure` carries `retryAfterSeconds`

**Files:**
- Modify: `src/agents/native/errors.ts` (the `toAdapterFailure` function, and the stale note at lines 9-12)
- Modify: `src/agents/native/adapter.ts:216` and `src/agents/native/adapter.ts:381` (the two call sites)
- Test: `test/unit/agents/native/errors.test.ts`

**Interfaces:**
- Consumes: nothing from earlier nax tasks.
- Produces: `toAdapterFailure(protocolError: { kind: string; retryAfter?: number }): AdapterFailure`. Callers pass `err.protocolError`, not `err.protocolError.kind`. `AdapterFailure` is from `@/context/engine` and already has an optional `retryAfterSeconds?: number`.

**Context you need:** `toAdapterFailure` is a lookup into a frozen, kind-keyed table. It has no parameter through which a `retryAfter` could arrive, so `AdapterFailure.retryAfterSeconds` is `undefined` for every native failure — even though both call sites hold the whole `err.protocolError`, which carries it. The acpx path populates the field correctly already.

The table itself must not change, and this file must never parse a message. Only the carrier widens.

- [ ] **Step 1: Write the failing test**

The existing `test/unit/agents/native/errors.test.ts` drives a `CASES` table with `toAdapterFailure(kind)`. Update those call sites to pass an object, and add the new behaviour:

```ts
// existing table driver becomes:
const failure = toAdapterFailure({ kind });
```

Then append:

```ts
describe("retryAfterSeconds", () => {
  test("carries the provider's retryAfter onto the failure", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
  });

  test("omits the field when the provider supplied none", () => {
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });

  test("carries it for any kind, not just rate-limit", () => {
    expect(toAdapterFailure({ kind: "overloaded", retryAfter: 5 }).retryAfterSeconds).toBe(5);
  });

  test("an unrecognised kind still degrades to unknown, and still carries retryAfter", () => {
    const failure = toAdapterFailure({ kind: "brand-new-kind", retryAfter: 9 });
    expect(failure.outcome).toBe("fail-unknown");
    expect(failure.retryAfterSeconds).toBe(9);
  });

  test("the shared table entries are not mutated across calls", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });
});
```

That last case matters: the table is a frozen shared object, so the implementation must return a copy rather than assign onto the entry.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/agents/native/errors.test.ts
```
Expected: FAIL — a type error on the object argument, and `retryAfterSeconds` undefined.

- [ ] **Step 3: Implement**

In `src/agents/native/errors.ts`, replace the function and delete the stale note:

```ts
/** The shape this module reads off a nax-ai protocol fault. Structural, never the class. */
export interface NativeProtocolError {
  readonly kind: string;
  /** Seconds, when the provider signalled one. */
  readonly retryAfter?: number;
}

/**
 * An unrecognised kind degrades to unknown rather than throwing: a new nax-ai
 * kind should downgrade one call, not crash the run.
 *
 * Takes the whole protocol error, not the bare kind: `retryAfter` is the
 * provider's own recovery time and the retry layers need it. FAILURES is a
 * frozen shared table, so the entry is copied rather than assigned onto.
 */
export function toAdapterFailure(protocolError: NativeProtocolError): AdapterFailure {
  const base = FAILURES[protocolError.kind] ?? UNKNOWN;
  return protocolError.retryAfter === undefined
    ? base
    : { ...base, retryAfterSeconds: protocolError.retryAfter };
}
```

Delete the paragraph at lines 9-12 beginning "Reached from `complete()` only" — it is stale. nax#1838 and nax#1840 made this table govern the session turn too, via `adapter.ts:381`.

Then update both call sites in `src/agents/native/adapter.ts` from `toAdapterFailure(err.protocolError.kind)` to `toAdapterFailure(err.protocolError)` (lines 216 and 381).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/agents/native/errors.test.ts test/unit/agents/native/adapter-turn-classification.test.ts
bun run typecheck
```
Expected: PASS. `adapter-turn-classification.test.ts` covers the session-turn path and must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/errors.ts src/agents/native/adapter.ts test/unit/agents/native/errors.test.ts
git commit -m "fix(native): carry the provider's retryAfter onto the adapter failure"
```

---

### Task 6: nax — the turn loop waits out a rate limit

**Files:**
- Modify: `src/agents/native/session/turn-retry.ts` (`RETRYABLE_KINDS`, its doc comment, and `retryTransportFault`'s loop)
- Test: `test/unit/agents/native/turn-retry.test.ts`

**Interfaces:**
- Consumes: Task 5's populated `retryAfter` (though this module reads `err.protocolError.retryAfter` directly, so it is independent of Task 5 at the type level).
- Produces: `isRetryableTransportFault` now accepts `"rate-limit"`. `retryTransportFault<T>(firstError, deps)` gains one refusal: it rethrows rather than retrying when the computed delay exceeds `deps.deadline.remainingMs()`.

**Context you need:** `turnRetryDelayMs` already prefers `retryAfter` over computed backoff and already caps by `remainingMs`. Rate limit is merely excluded from the kind set. The cap is the wrong behaviour on its own: a provider advertising 300s against 30s of remaining budget sleeps 30s, re-issues, and aborts immediately — 30 seconds spent to learn nothing. When the provider's delay exceeds the remaining budget, do not retry at all.

Waiting belongs here rather than at the manager because on a throw from `deps.complete` the `messages` array is unchanged and no tool from that round trip has executed, so a re-issue costs one round trip. `"context-overflow"` keeps its dedicated compaction path in `turn-loop.ts` and must still never be handled here. `"auth"` and `"bad-request"` stay terminal.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agents/native/turn-retry.test.ts`, the existing test `"rejects auth, bad-request, rate-limit and context-overflow"` now asserts the opposite of what we want for one kind. Change it to:

```ts
  test("rejects auth, bad-request and context-overflow", () => {
    for (const kind of ["auth", "bad-request", "context-overflow"]) {
      expect(isRetryableTransportFault(new ProtocolStreamError({ kind, message: "x" }))).toBe(false);
    }
  });

  test("accepts rate-limit -- the provider's own delay is honoured here", () => {
    expect(isRetryableTransportFault(new ProtocolStreamError({ kind: "rate-limit", message: "x" }))).toBe(true);
  });
```

Then append:

```ts
describe("retryTransportFault budget refusal", () => {
  const rateLimit = (retryAfter: number) =>
    new ProtocolStreamError({ kind: "rate-limit", message: "429", retryAfter });

  test("waits the provider's retryAfter and re-issues when budget allows", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const result = await retryTransportFault(rateLimit(30), {
      attempt: () => {
        attempts += 1;
        return Promise.resolve("ok");
      },
      config: { maxAttempts: 3, baseDelayMs: 1000 },
      deadline: { expired: () => false, remainingMs: () => 300_000 },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    expect(slept).toEqual([30_000]);
  });

  test("refuses to retry when the provider's delay exceeds the remaining budget", async () => {
    const err = rateLimit(30);
    let attempts = 0;
    const slept: number[] = [];

    await expect(
      retryTransportFault(err, {
        attempt: () => {
          attempts += 1;
          return Promise.resolve("ok");
        },
        config: { maxAttempts: 3, baseDelayMs: 1000 },
        deadline: { expired: () => false, remainingMs: () => 10_000 },
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(err);

    expect(attempts).toBe(0);
    expect(slept).toEqual([]);
  });

  test("an unbounded turn waits the full retryAfter", async () => {
    const slept: number[] = [];
    await retryTransportFault(rateLimit(45), {
      attempt: () => Promise.resolve("ok"),
      config: { maxAttempts: 3, baseDelayMs: 1000 },
      deadline: { expired: () => false, remainingMs: () => undefined },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([45_000]);
  });

  test("an overloaded fault with no retryAfter still uses jittered backoff", async () => {
    const slept: number[] = [];
    await retryTransportFault(new ProtocolStreamError({ kind: "overloaded", message: "503" }), {
      attempt: () => Promise.resolve("ok"),
      config: { maxAttempts: 3, baseDelayMs: 1000 },
      deadline: { expired: () => false, remainingMs: () => 300_000 },
      random: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([500]);
  });
});
```

The last two are the regression guards: the unbounded path and the existing no-retryAfter path must both keep working.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/agents/native/turn-retry.test.ts
```
Expected: the rate-limit acceptance test FAILS (`expected false to be true`) and the refusal test FAILS (it retries instead of rejecting).

- [ ] **Step 3: Implement**

In `src/agents/native/session/turn-retry.ts`, replace the kind set and its comment:

```ts
/**
 * Kinds this module retries. "auth" and "bad-request" are terminal --
 * retrying cannot help. "context-overflow" keeps its existing, dedicated
 * compaction-retry path in turn-loop.ts and must never be handled here.
 *
 * "rate-limit" belongs here, not at the manager. It was previously excluded
 * and deferred to the manager-tier defaultRetryStrategy, but that handler sits
 * inside runWithFallback's "swap declined" branch, and on the native transport
 * the swap gate accepts rather than declines -- so control left the branch
 * before reaching it. The wait is also cheapest here: on a throw from
 * deps.complete the messages array is unchanged and no tool has executed, so a
 * re-issue costs one round trip rather than a whole hop and a fresh session.
 */
const RETRYABLE_KINDS = new Set(["transport", "overloaded", "rate-limit"]);
```

Add a predicate beside `turnRetryDelayMs`:

```ts
/**
 * Whether the wait is worth taking at all.
 *
 * turnRetryDelayMs clamps to `remainingMs`, which alone produces the worst
 * outcome available: a provider advertising 300s against 30s of budget sleeps
 * the 30s, re-issues, and aborts immediately, having spent the remaining
 * wall clock to learn nothing. Refusing outright surfaces the failure while
 * budget remains for the layer above to act on it.
 *
 * An absent `remainingMs` means the turn is unbounded (TurnDeadline's
 * UNBOUNDED), so there is no budget to exceed and the wait is always allowed.
 */
export function turnRetryFitsBudget(delayMs: number, remainingMs: number | undefined): boolean {
  return remainingMs === undefined || delayMs <= remainingMs;
}
```

In `retryTransportFault`'s loop (`turn-retry.ts:179-181`), replace these three lines:

```ts
    const fault = err;
    const delayMs = turnRetryDelayMs(fault, retryIndex, deps.config, random, deps.deadline?.remainingMs());
    deps.onRetry?.(retryIndex + 1, delayMs, fault);
```

with:

```ts
    const fault = err;
    // Computed WITHOUT the remainingMs clamp: the value that decides whether the
    // wait is affordable must be the provider's own, not one already reduced to
    // fit. Clamping alone spends the whole remaining budget on a wait that cannot
    // succeed, and the attempt after it aborts immediately.
    const remainingMs = deps.deadline?.remainingMs();
    const delayMs = turnRetryDelayMs(fault, retryIndex, deps.config, random);
    if (!turnRetryFitsBudget(delayMs, remainingMs)) throw fault;
    deps.onRetry?.(retryIndex + 1, delayMs, fault);
```

Leave `turnRetryDelayMs`'s signature and its existing tests alone — the `remainingMs` parameter stays, it is simply not passed on this call site any more.

Preserve the existing contract that exhaustion and non-retryable errors rethrow the triggering error **exactly as thrown**, never wrapped — `readNativeTurnFailureUsage` keys a WeakMap on the error's identity and `isProtocolStreamError` depends on its shape.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/agents/native/turn-retry.test.ts test/unit/agents/native/turn-events.test.ts
bun run typecheck
```
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-retry.ts test/unit/agents/native/turn-retry.test.ts
git commit -m "feat(native): wait out a rate limit in the turn loop, and refuse a wait the budget cannot afford"
```

---

### Task 7: nax — `defaultRetryStrategy` prefers the provider's delay

**Files:**
- Modify: `src/agents/retry/default-strategy.ts`
- Test: `test/unit/agents/retry/default-strategy.test.ts` (create if it does not exist; check with `ls test/unit/agents/retry/` first)

**Interfaces:**
- Consumes: `AdapterFailure.retryAfterSeconds`, populated by Task 5 on native and already populated on acpx by `acp/adapter.ts:272`.
- Produces: no signature change. `shouldRetry(failure, attempt, ctx)` returns `{ retry: true, delayMs }` where `delayMs` is `retryAfterSeconds * 1000` when present.

**Context you need:** this strategy governs the rate-limit backoff in `AgentManager.runWithFallback` when no swap candidate is available. It computes `2 ** (attempt + 1) * 1000` and ignores `retryAfterSeconds` even on acpx, where the field is correctly populated. This is a small change that fixes both transports.

Do **not** change which outcomes the strategy accepts, and do **not** try to make it reachable on the native swap path. That cliff is deliberately left for spec 2 — see the spec's "Accepted residue" section.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { defaultRetryStrategy } from "@/agents/retry/default-strategy";
import type { RetryContext } from "@/agents/retry/types";
import type { AdapterFailure } from "@/context/engine";

const ctx: RetryContext = { site: "run", agentName: "native", stage: "run", storyId: "US-001" };

function rateLimit(retryAfterSeconds?: number): AdapterFailure {
  return {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "429",
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

describe("defaultRetryStrategy", () => {
  test("prefers the provider's retryAfterSeconds over computed backoff", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(45), 0, ctx)).toEqual({ retry: true, delayMs: 45_000 });
  });

  test("falls back to exponential backoff when the provider gave none", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(), 0, ctx)).toEqual({ retry: true, delayMs: 2_000 });
    expect(defaultRetryStrategy.shouldRetry(rateLimit(), 1, ctx)).toEqual({ retry: true, delayMs: 4_000 });
  });

  test("the provider's delay does not extend the attempt budget", () => {
    expect(defaultRetryStrategy.shouldRetry(rateLimit(45), 3, ctx)).toEqual({ retry: false });
  });

  test("still declines outcomes it never accepted", () => {
    const quality: AdapterFailure = {
      category: "quality",
      outcome: "fail-quality",
      retriable: true,
      message: "x",
      retryAfterSeconds: 45,
    };
    expect(defaultRetryStrategy.shouldRetry(quality, 0, ctx)).toEqual({ retry: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test test/unit/agents/retry/default-strategy.test.ts
```
Expected: the first test FAILS with `delayMs: 2000` instead of `45000`.

- [ ] **Step 3: Implement**

In `src/agents/retry/default-strategy.ts`, replace the delay computation:

```ts
    // The provider's own recovery time beats a guess. Populated by acpx
    // (parse-agent-error) and, since the native errors table takes the whole
    // protocol error, by native too. The attempt cap is unchanged -- a long
    // retryAfter buys a longer wait, never an extra attempt.
    const delayMs =
      af.retryAfterSeconds !== undefined ? af.retryAfterSeconds * 1000 : 2 ** (attempt + 1) * 1000;
    return { retry: true, delayMs };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/agents/retry/ && bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/retry/default-strategy.ts test/unit/agents/retry/default-strategy.test.ts
git commit -m "fix(retry): honour the provider's retryAfterSeconds in the manager backoff"
```

---

### Task 8: nax — the failure outcome reaches the run log (#1897)

**Files:**
- Modify: `src/runtime/index.ts` (the runtime interface near line 171, and the factory near lines 335 and 368)
- Modify: `src/operations/call-resolvers.ts` (add `recordAdapterFailure` beside `recordAgentFallbacks` at line 140)
- Modify: `src/operations/call.ts` (call it beside `recordAgentFallbacks` at line ~462; **file is at 590/600**)
- Modify: `src/execution/post-run.ts:141-150` and `:572-583` (**file is at 598/600 — this change must be net-negative**)
- Modify: `src/operations/build-hop-callback.ts:107` (`turnResultToAgentResult`)
- Test: `test/unit/execution/post-run-inspection.test.ts`

**Interfaces:**
- Consumes: `AgentRunOutcome.result.adapterFailure` at the callOp seam; `CallContext.runtime` and `CallContext.storyId`.
- Produces: `runtime.lastAdapterFailure: Map<string, AdapterFailure>` and `recordAdapterFailure(ctx: CallContext, failure: AdapterFailure | undefined): void`.

**Context you need:** `applyPostRunInspection` rebuilds `ctx.agentResult` from the implementer's phase output with `rateLimited: false` hardcoded, so every story that died to a 429 logs `"rateLimited": false`. The comment at `call.ts:456-462` already names this defect.

`.claude/rules/adapter-wiring.md` Rule 6 forbids routing result-side data back through `CallContext`, and nax#1707 settled the shape for exactly this problem: a run-scoped sink on `ctx.runtime`, written at the `callOp` seam. `recordAgentFallbacks` is the precedent — **model the new helper on it, including its no-storyId no-op.**

- [ ] **Step 1: Write the failing test**

Add to `test/unit/execution/post-run-inspection.test.ts`. Do **not** use
`post-run-decide-action.test.ts` — that file exercises `decideStageAction`, which
is handed an `AgentResult` directly by its `makeAgentResult` helper, so it never
runs the rebuild this task changes.

`post-run-inspection.test.ts` already imports `makeTestContext` from
`@test/helpers` and `makeInspectionOpts` / `makePlanResult` from
`./_post-run-fixtures`. Read all three before writing, and reuse them:

```ts
test("a story whose op failed with fail-rate-limit reports rateLimited on the rebuilt result", async () => {
  const ctx = makeTestContext();
  ctx.runtime.lastAdapterFailure.set(ctx.story.id, {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "429",
  });

  await applyPostRunInspection(ctx, makePlanResult(), makeInspectionOpts());

  expect(ctx.agentResult?.rateLimited).toBe(true);
});

test("a story with no recorded failure still reports rateLimited false", async () => {
  const ctx = makeTestContext();
  await applyPostRunInspection(ctx, makePlanResult(), makeInspectionOpts());
  expect(ctx.agentResult?.rateLimited).toBe(false);
});

test("a non-rate-limit failure does not set rateLimited", async () => {
  const ctx = makeTestContext();
  ctx.runtime.lastAdapterFailure.set(ctx.story.id, {
    category: "availability",
    outcome: "fail-service-down",
    retriable: true,
    message: "503",
  });

  await applyPostRunInspection(ctx, makePlanResult(), makeInspectionOpts());

  expect(ctx.agentResult?.rateLimited).toBe(false);
});
```

If `makePlanResult()` needs an argument to produce a failed implementer phase,
read `_post-run-fixtures.ts` and pass what it actually takes. The second and
third cases are the regression guards.

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test test/unit/execution/post-run-inspection.test.ts
```
Expected: FAIL — `lastAdapterFailure` does not exist on the runtime, and `rateLimited` is hardcoded `false`.

- [ ] **Step 3: Add the sink**

In `src/runtime/index.ts`, beside `readonly agentFallbacks: Map<string, AgentFallbackRecord[]>;`:

```ts
  /**
   * The most recent adapter failure per story, written by callOp.
   *
   * post-run.ts rebuilds ctx.agentResult from the implementer's phase output,
   * which drops everything the AgentResult carried -- including whether the
   * failure was a rate limit, which the run log then reported as false on every
   * rate-limited story (nax#1897). Result-side data may not travel back through
   * CallContext (adapter-wiring.md Rule 6), so it travels here, exactly as
   * agent-swap hops do (nax#1707). Last write wins: post-run runs immediately
   * after its story's plan, so the last recorded failure is the failing op's.
   */
  readonly lastAdapterFailure: Map<string, AdapterFailure>;
```

Declare `const lastAdapterFailure = new Map<string, AdapterFailure>();` beside `const agentFallbacks = ...` (near line 335) and add `lastAdapterFailure,` to the returned object (near line 368).

In `src/operations/call-resolvers.ts`, beside `recordAgentFallbacks`:

```ts
/**
 * Record the failure a dispatch reported, for the run-scoped per-story store.
 *
 * No-ops for a success and for ad-hoc calls with no storyId, matching
 * recordAgentFallbacks: an unattributable failure has nowhere to go.
 */
export function recordAdapterFailure(ctx: CallContext, failure: AdapterFailure | undefined): void {
  if (!failure || !ctx.storyId) return;
  ctx.runtime.lastAdapterFailure.set(ctx.storyId, failure);
}
```

In `src/operations/call.ts`, beside the existing `recordAgentFallbacks(ctx, outcome.fallbacks);` (line ~462), add:

```ts
  recordAdapterFailure(ctx, outcome.result.adapterFailure);
```

and add it to the import from `./call-resolvers` at line 19. **Keep this to two added lines — the file is at 590 of 600.**

- [ ] **Step 4: Read the sink in post-run, and delete the dead branch**

In `src/execution/post-run.ts`, in `applyPostRunInspection`, replace `rateLimited: false,` with a value derived from the sink:

```ts
  const lastFailure = ctx.runtime.lastAdapterFailure.get(ctx.story.id);

  const agentResult: AgentResult = {
    success: implementerOutput?.success ?? false,
    estimatedCostUsd: capturedCostUsd || planResult.phaseCosts[implementerOp.name] || 0,
    rateLimited: lastFailure?.outcome === "fail-rate-limit",
    // ... rest unchanged
```

Then delete the dead branch at `:572-574` entirely:

```ts
    if (agentResult.rateLimited) {
      logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
    }
```

Nothing at that layer retries — the next statement is `cleanupSessionOnFailure(ctx)` and the function returns `{ action: "escalate" }`. Leave the `rateLimited` field in the `Agent session failed` log at `:568` and the `reasonParts.push("rate-limited")` at `:582` in place; those are the diagnostics this task exists to make true.

Net line change must be zero or negative. Verify:

```bash
wc -l src/execution/post-run.ts   # must be <= 598
```

- [ ] **Step 5: Fix the other hardcoded write**

In `src/operations/build-hop-callback.ts`, `turnResultToAgentResult` (line ~107) also hardcodes `rateLimited: false` on the non-throwing path, so the field is inconsistently populated even before it is discarded. Derive it from the `adapterFailure` the function already forwards:

```ts
    rateLimited: r.adapterFailure?.outcome === "fail-rate-limit",
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test test/unit/execution/post-run-inspection.test.ts test/unit/operations/
bun run typecheck && bun run check:file-sizes
```
Expected: PASS, and the file-size gate reports its usual 16 grandfathered files with no new entries.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/index.ts src/operations/call-resolvers.ts src/operations/call.ts \
        src/execution/post-run.ts src/operations/build-hop-callback.ts \
        test/unit/execution/post-run-inspection.test.ts
git commit -m "fix(execution): report the real rate-limit outcome instead of a hardcoded false"
```

---

### Task 9: nax — full verification and PR

**Files:** none modified.

**Interfaces:**
- Consumes: Tasks 5-8.
- Produces: a green tree and an open PR.

- [ ] **Step 1: Run the full suite, forcing past the turbo cache**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run test --force
```

`--force` is required. Turbo can replay a stale green: a `Cached: N cached` line means the result was not recomputed and is not evidence of anything.

- [ ] **Step 2: Run the gates**

```bash
bun run typecheck && bun run lint
```
Expected: all green, including `check:file-sizes`, `check:import-cycles` and `check:nax-ai-imports`.

- [ ] **Step 3: Confirm every spec verification anchor has a home**

Walk the spec's section 6 table and confirm each of the nine cases is covered by a test written in Tasks 2, 3, 5, 6, 7 or 8. Case 9 ("a story failing to a 429 reports `rateLimited: true`") is Task 8's. Report any case with no test rather than quietly skipping it.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/native-failure-classification
gh pr create --fill
```

State in the PR body that this is spec 1 of two, that it closes a re-scoped #1893 and #1897, and that #1883, #1884 and #1892 are deliberately left for spec 2.

- [ ] **Step 5: Report what spec 2 now needs**

Spec 1 exists so spec 2 can be designed on measurements rather than reasoning. After one real run on the native global profile passes through the fixed path, three numbers should be pulled from the artifacts and handed to whoever writes spec 2:

1. The distribution of `retryAfterSeconds` on native rate limits.
2. How often an op dies at the exhaustion cliff (`onSwapExhausted` with `hops: 0`).
3. How many 429s the turn-loop wait absorbed outright.

Do **not** launch a `nax run` to collect these. That needs explicit approval from the user at the launch moment.
