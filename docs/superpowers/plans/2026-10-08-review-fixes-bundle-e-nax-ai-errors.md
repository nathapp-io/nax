# Review Fixes Bundle E — nax-ai Error Classification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** A caller's abort surfaces as an abort on every pi-ai adapter, and a request that cannot succeed as written (unknown model, invalid header or session id) fails at once instead of being retried as a transport fault.

**Architecture:** Two tasks in `packages/nax-ai`. Task 1 makes the protocol's error-EVENT path honour the caller's abort the way its catch path already does. Task 2 introduces one internal error class, `ProtocolSetupError`, thrown by the deterministic setup checks and classified `bad-request` by `classifyThrown`, so the retry layer's existing "transport only" rule leaves it alone.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are ON in this package), vitest. Node APIs only.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #5, #20.

**Branch:** `git fetch origin && git checkout -b fix/review-e-nax-ai-errors origin/main`

## Global Constraints

See the master plan. nax-ai has no file-size gate, but keep additions small. **Release note for the PR body:** nax and nax-agent consume nax-ai through the workspace (`@nathapp/nax-ai` pinned at `0.1.16`), so these fixes reach published nax only after the maintainer releases nax-ai and bumps the pins. Do not do either here.

## Review Focus

See the master plan. This bundle owns Review Focus line 3 (Ctrl+C during a stream), pinned in Task 1.

## Files

- Modify: `packages/nax-ai/src/protocols/pi-client.ts:359-378, 844-849` (Tasks 1, 2)
- Modify: `packages/nax-ai/src/protocols/errors.ts:249-262` (Task 2)
- Modify: `packages/nax-ai/src/protocols/request-headers.ts:36-68` (Task 2)
- Test: `packages/nax-ai/test/protocols/pi-client.test.ts`
- Test: `packages/nax-ai/test/protocols/errors.test.ts`
- Test: `packages/nax-ai/test/protocols/retry.test.ts`
- Test: `packages/nax-ai/test/protocols/pi-protocols.test.ts`

---

### Task 1: A caller abort delivered as an error event is rethrown as the abort (#5)

All four pi-ai adapters nax-ai uses report a caller abort as an `error` EVENT (`stopReason: "aborted"`, `errorMessage: "Request was aborted"`), not a throw. The event path classifies that message with `classifyProviderError`, which returns `transport` — the kind `retryTransportFaults` and nax-agent's turn retry both treat as retryable. The catch path 20 lines below already does the right thing (`if (req.signal?.aborted) throw cause;`); make the event path agree.

**Files:**
- Modify: `packages/nax-ai/src/protocols/pi-client.ts`
- Test: `packages/nax-ai/test/protocols/pi-client.test.ts`

- [ ] **Step 1: Write the failing test**

In `pi-client.test.ts`, inside the describe that holds `"does not dress up the caller's own abort as a transport fault"` (~767), add after it:

```ts
  it("rethrows the caller's abort when pi-ai reports it as an error event, keeping the billed usage", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    controller.abort(abortError);
    const deps = fakePiWithResponse([
      {
        type: "error",
        reason: "aborted",
        error: message({ stopReason: "aborted", errorMessage: "Request was aborted" }),
      },
    ] as AssistantMessageEvent[]);

    const out: ProtocolEvent[] = [];
    const iterate = async () => {
      for await (const event of createPiProtocol("openai-completions", deps).stream({
        ...BASE,
        signal: controller.signal,
      })) {
        out.push(event);
      }
    };

    await expect(iterate()).rejects.toBe(abortError);
    // A failed request that consumed tokens still bills for them; the abort is not an error event.
    expect(out.map((e) => e.type)).toEqual(["usage"]);
  });
```

(`message()` defaults to a non-zero usage, `pi-client.test.ts:310-325`, so the usage event is expected. The existing test `"reports an aborted stream as an error rather than a clean stop"` sends NO signal and must keep passing: an `aborted` stop the caller did not ask for is still an error event.)

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-ai`): `bun x vitest --run test/protocols/pi-client.test.ts`
Expected: FAIL — the promise resolves; `out` is `["usage", "error"]`.

- [ ] **Step 3: Implement**

In `pi-client.ts`, inside `case "error": {`, right after the line `if (totalTokens(usage) > 0) yield { type: "usage", usage };`, add:

```ts
              // pi-ai delivers the CALLER's abort as an error event ("Request was aborted"), not a
              // throw; classifying that message would file it as a retryable transport fault (#5).
              // Throw the abort instead — the catch below rethrows it untouched, like a raw abort.
              if (req.signal?.aborted) throw req.signal.reason ?? new DOMException("Aborted", "AbortError");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun x vitest --run test/protocols/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-ai/src/protocols/pi-client.ts packages/nax-ai/test/protocols/pi-client.test.ts
git commit -m "fix(nax-ai): a caller abort reported as an error event surfaces as the abort (review #5)"
```

---

### Task 2: Deterministic setup failures are `bad-request`, never retried (#20)

`classifyThrown` files every status-less throw as `transport`. Three setup checks throw plain status-less `Error`s for conditions a retry cannot change: the unknown-model lookup in `createPiDeps().resolveModel` (`pi-client.ts:844-849`, called at the top of the stream generator, outside its try), and `assertValidHeaders` / `assertValidSessionId` (`request-headers.ts`, called inside the stream). The model lookup reaches `retryTransportFaults`' catch and is re-issued `transportRetries` times; the header checks become `transport` error events, which `isRetryableErrorEvent` also retries.

**Files:**
- Modify: `packages/nax-ai/src/protocols/errors.ts`
- Modify: `packages/nax-ai/src/protocols/pi-client.ts`
- Modify: `packages/nax-ai/src/protocols/request-headers.ts`
- Test: `packages/nax-ai/test/protocols/errors.test.ts`
- Test: `packages/nax-ai/test/protocols/retry.test.ts`
- Test: `packages/nax-ai/test/protocols/pi-protocols.test.ts`

**Interfaces:**
- Produces: `export class ProtocolSetupError extends Error` in `src/protocols/errors.ts` (internal; not added to the package's public entry).

- [ ] **Step 1: Write the failing tests**

In `errors.test.ts`, add `ProtocolSetupError` to the `../../src/protocols/errors.ts` import, and append inside `describe("classifyThrown", ...)`:

```ts
  it("classifies a setup error as bad-request: a retry cannot change it", () => {
    const cause = new ProtocolSetupError('Unknown model "x" in the pi-ai catalog.');
    expect(classifyThrown(cause)).toEqual({ kind: "bad-request", message: cause.message, cause });
  });
```

In `retry.test.ts`, add `import { ProtocolSetupError } from "../../src/protocols/errors.ts";` and append inside `describe("retryTransportFaults", ...)`:

```ts
  it("does not retry a setup error thrown before any event", async () => {
    let calls = 0;
    const { sleep, calls: delays } = noopSleep();
    const setup = new ProtocolSetupError('Unknown model "deepseek-chat-typo" for provider "deepseek".');
    await expect(
      collect(
        retryTransportFaults(
          () => {
            calls += 1;
            return throwingStream(setup);
          },
          { retries: 2, sleep },
        ),
      ),
    ).rejects.toBe(setup);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
```

In `pi-client.test.ts`, inside `describe("createPiProtocol error path", ...)`, add a case pinning the header path (an invalid header is detected inside the stream, so it becomes an error EVENT):

```ts
  it("an invalid request header is a bad-request event, which the retry layer leaves alone", async () => {
    const events: ProtocolEvent[] = [];
    for await (const event of createPiProtocol("openai-completions", createPiDeps({}, stubStream().streamSimple)).stream({
      ...BASE,
      // BASE's "deepseek-chat" is not in the real pi-ai catalog (resolveModel would throw before
      // the header check); "gpt-5.5" resolves via the global first-match fallback (pi-protocols.test.ts:55).
      model: "gpt-5.5",
      headers: { "x-a": "a\nb" },
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
  });
```

(Copy the `stubStream()` helper from `pi-client-overrides.test.ts:47` into this file — test helpers are file-local there — and add `createPiDeps` to the `../../src/protocols/pi-client.ts` import. `ProtocolRequest.headers` is `Readonly<Record<string, string>>`, `src/protocols/types.ts:180`. Before the fix this event's kind is `transport`.)

In `pi-protocols.test.ts`, add `import { ProtocolSetupError } from "../../src/protocols/errors.ts";` above the `pi-client.ts` import and, next to `"throws naming both the model and the provider for an unknown pairing"`, add:

```ts
  it("throws the unknown pairing as a setup error, which the retry layer leaves alone", async () => {
    await expect(createPiDeps().resolveModel("gpt-5.5", "deepseek")).rejects.toBeInstanceOf(ProtocolSetupError);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun x vitest --run test/protocols/errors.test.ts test/protocols/retry.test.ts test/protocols/pi-protocols.test.ts`
Expected: FAIL — `ProtocolSetupError` is not exported.

- [ ] **Step 3: Implement**

In `errors.ts`, add above `classifyThrown`'s doc comment:

```ts
/**
 * A request that cannot succeed as written: an unknown model, an invalid header
 * or session id. Deterministic, so retrying only re-sends the same failure.
 * `classifyThrown` maps it to `bad-request`, which the transport retry never
 * touches (retry.ts: "nax-ai retries transport faults only").
 */
export class ProtocolSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolSetupError";
  }
}
```

and make it the first check in `classifyThrown`:

```ts
export function classifyThrown(cause: unknown): ProtocolError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof ProtocolSetupError) return { kind: "bad-request", message, cause };
  const status = thrownStatus(cause);
```

Add one line to `classifyThrown`'s doc comment: "A `ProtocolSetupError` is `bad-request`: it names a request that cannot succeed."

In `pi-client.ts`, extend the existing import on line 36 to `import { classifyProviderError, classifyThrown, parseRetryAfter, ProtocolSetupError } from "./errors.ts";` and change both throws in `resolveModel` (~846, ~848) from `throw new Error(` to `throw new ProtocolSetupError(` — messages unchanged.

In `request-headers.ts`, add `import { ProtocolSetupError } from "./errors.ts";` and change every `throw new Error(` in `assertHeaderValue` and `assertValidHeaders` to `throw new ProtocolSetupError(` — messages unchanged. (`errors.ts` imports only `./types.ts`, so this adds no cycle.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun x vitest --run`
Expected: PASS for the whole nax-ai suite. Existing `rejects.toThrow("<message>")` assertions keep passing (same messages; `ProtocolSetupError` is an `Error`). If a test asserted that an invalid header produced an error EVENT of kind `transport`, it pinned #20: change it to `bad-request`.

Then, because nax-agent consumes these kinds (from `packages/nax-agent`): `timeout 60 bun test test/unit/native/ --timeout=5000`. Expected: PASS (`bad-request` is not in `RETRYABLE_KINDS = {transport, overloaded, rate-limit}`, `native/session/turn-retry.ts:66`, so it is already terminal there).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-ai/src/protocols/errors.ts packages/nax-ai/src/protocols/pi-client.ts packages/nax-ai/src/protocols/request-headers.ts packages/nax-ai/test/protocols/errors.test.ts packages/nax-ai/test/protocols/retry.test.ts packages/nax-ai/test/protocols/pi-protocols.test.ts
git commit -m "fix(nax-ai): setup errors are bad-request and never retried as transport (review #20)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `nax-ai`. Gates: nax-ai (`bun run typecheck && bun run check:all && bun run test`) plus nax-agent's `bun run test` (it consumes the error kinds). Put the release note from Global Constraints in the PR body.
