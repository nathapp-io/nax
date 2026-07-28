# Telegram Chat Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject inbound Telegram updates that did not originate from the configured chat, closing an authentication bypass on nax's human-approval gate, and route the plugin's five `fetch` call sites through an injectable deps seam so the fix is testable.

**Architecture:** Pure presentation helpers split out of `telegram.ts` into a new `telegram-format.ts` to create file-size headroom. A module-level `_telegramPluginDeps` object mirrors the sibling `_webhookPluginDeps`. The authorization check is applied once at the ingestion boundary inside `fetchUpdates()`, after `lastUpdateId` advances from the raw result and before the array is returned to callers.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome.

Spec: `docs/superpowers/specs/2026-07-28-telegram-chat-authorization-design.md`
Issues: #1365 (security), #1366 (refactor)
Branch: `fix/telegram-chat-authorization` (already created, off `d0c30e33`)

## Global Constraints

- **Source files: 600-line hard limit.** `src/interaction/plugins/telegram.ts` is currently at **596** and is **not** grandfathered in `scripts/baselines/file-sizes-baseline.json`. Enforced by `bun run check:file-sizes`, which runs as part of `bun run lint`. Task 1 must land before any task adds a line to it.
- **Test files: 800-line hard limit.** `test/unit/interaction/interaction-plugins.test.ts` is currently at **790**. Task 2 must land before any task adds a test to it.
- **Bun-native APIs only.** `Bun.file()`, `Bun.write()`, `Bun.sleep()`. Never `fs.readFileSync`, `child_process`, or `setTimeout` for delays. `setTimeout` is permitted only where the handle is cancelled via `clearTimeout` — the existing `AbortController` timers in this file are that permitted case.
- **`mock.module()` is forbidden** — it leaks globally in Bun 1.x and poisons other test files. Use the `_deps` pattern.
- **No `console.log` / `console.error` in `src/`.** Use the project logger (`src/logger`).
- **Never run bare `bun test`** — a PreToolUse hook blocks it. Scoped runs must be wrapped: `timeout 30 bun test <path> --timeout=5000`.
- **Conventional commits**, one logical change per commit. Never include `[run-release]`.
- **No `any` in public APIs.**

## File Structure

| File | Action | Responsibility |
|:---|:---|:---|
| `src/interaction/plugins/telegram-format.ts` | Create | Pure presentation: header, body, keyboard, markdown escaping, chunk splitting, stage emoji. No I/O, no state. |
| `src/interaction/plugins/telegram.ts` | Modify | Policy: lifecycle, pending map, poll loop, `parseUpdate`, transport, deps seam, authorization check. |
| `test/unit/interaction/plugins/telegram-format.test.ts` | Create | Direct unit tests for the extracted pure functions. |
| `test/unit/interaction/plugins/telegram.test.ts` | Create | The Telegram plugin suites, moved out of `interaction-plugins.test.ts`, plus the new authorization tests. |
| `test/unit/interaction/interaction-plugins.test.ts` | Modify | Retains only the Webhook and Auto suites. |

`src/interaction/plugins/` has no barrel `index.ts` (consumers import plugins by leaf path), so `telegram.ts` importing `./telegram-format` is consistent with the existing layout.

---

### Task 1: Extract pure formatting helpers

Moves six private methods out of the plugin class into a new module as free functions. Behaviour-preserving: the bodies are copied verbatim, only `this.` call sites and the `private` keyword change.

**Files:**
- Create: `src/interaction/plugins/telegram-format.ts`
- Create: `test/unit/interaction/plugins/telegram-format.test.ts`
- Modify: `src/interaction/plugins/telegram.ts` (remove lines 12-13, 239-397; update call sites at 120-126, 197-199 unaffected)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces — imported by Task 3 and Task 4 via `telegram.ts`:
  - `MAX_MESSAGE_CHARS: number` (= 4000)
  - `type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>`
  - `buildHeader(request: InteractionRequest): string`
  - `buildBody(request: InteractionRequest): string`
  - `buildKeyboard(request: InteractionRequest): InlineKeyboard | null`
  - `sanitizeMarkdown(text: string): string`
  - `splitText(text: string, maxChars: number): string[]`
  - `getStageEmoji(stage: string): string`

**Note on existing coverage:** the moved code has **no direct test coverage today** — these are private methods, exercised only indirectly through `send()` assertions on message text and keyboard contents. Step 1 adds direct tests *before* the move so the relocation is verifiable rather than assumed.

- [ ] **Step 1: Write the failing test for the new module**

Create `test/unit/interaction/plugins/telegram-format.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { InteractionRequest } from "../../../../src/interaction";
import {
  MAX_MESSAGE_CHARS,
  buildBody,
  buildHeader,
  buildKeyboard,
  getStageEmoji,
  sanitizeMarkdown,
  splitText,
} from "../../../../src/interaction/plugins/telegram-format";

function makeRequest(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "req-1",
    type: "confirm",
    featureName: "my-feature",
    stage: "review",
    summary: "Proceed with merge?",
    fallback: "abort",
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as InteractionRequest;
}

describe("sanitizeMarkdown", () => {
  test("escapes each Telegram Markdown delimiter", () => {
    expect(sanitizeMarkdown("a_b")).toBe("a\\_b");
    expect(sanitizeMarkdown("a`b")).toBe("a\\`b");
    expect(sanitizeMarkdown("a*b")).toBe("a\\*b");
    expect(sanitizeMarkdown("a[b")).toBe("a\\[b");
  });

  test("escapes a pre-existing backslash that precedes a delimiter", () => {
    expect(sanitizeMarkdown("a\\_b")).toBe("a\\\\\\_b");
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeMarkdown("hello world")).toBe("hello world");
  });
});

describe("splitText", () => {
  test("returns a single chunk when the text fits", () => {
    expect(splitText("short", 100)).toEqual(["short"]);
  });

  test("prefers a newline as the split point when one sits past the halfway mark", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    const chunks = splitText(text, 100);
    expect(chunks).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  test("hard-breaks at maxChars when no newline is late enough", () => {
    const chunks = splitText("a".repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });

  test("every chunk respects maxChars", () => {
    const chunks = splitText("word ".repeat(500), 100);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("getStageEmoji", () => {
  test.each([
    ["pre-flight", "🚀"],
    ["execution", "⚙️"],
    ["review", "🔍"],
    ["merge", "🔀"],
    ["cost", "💰"],
    ["anything-else", "📌"],
  ])("maps %s", (stage, emoji) => {
    expect(getStageEmoji(stage)).toBe(emoji);
  });
});

describe("buildHeader", () => {
  test("includes stage, feature and story", () => {
    const header = buildHeader(makeRequest({ storyId: "US-001" }));
    expect(header).toContain("🔍");
    expect(header).toContain("*REVIEW*");
    expect(header).toContain("*Feature:* my-feature");
    expect(header).toContain("*Story:* US-001");
  });

  test("omits the story line when there is no storyId", () => {
    expect(buildHeader(makeRequest())).not.toContain("*Story:*");
  });
});

describe("buildBody", () => {
  test("sanitizes the summary", () => {
    expect(buildBody(makeRequest({ summary: "a_b" }))).toContain("a\\_b");
  });

  test("renders options and the timeout footer", () => {
    const body = buildBody(
      makeRequest({
        type: "choose",
        options: [{ key: "a", label: "Alpha", description: "first" }],
        timeout: 30_000,
      }),
    );
    expect(body).toContain("*Options:*");
    expect(body).toContain("Alpha");
    expect(body).toContain("first");
    expect(body).toContain("Timeout: 30s");
    expect(body).toContain("Fallback: abort");
  });
});

describe("buildKeyboard", () => {
  test("confirm produces approve/reject/skip/abort", () => {
    const keyboard = buildKeyboard(makeRequest({ id: "k-1" }));
    const data = (keyboard ?? []).flat().map((b) => b.callback_data);
    expect(data).toEqual(["k-1:approve", "k-1:reject", "k-1:skip", "k-1:abort"]);
  });

  test("choose produces one row per option plus the skip/abort row", () => {
    const keyboard = buildKeyboard(
      makeRequest({
        id: "k-2",
        type: "choose",
        options: [
          { key: "a", label: "Alpha" },
          { key: "b", label: "Beta" },
        ],
      }),
    );
    expect(keyboard).toHaveLength(3);
    expect(keyboard?.[0][0].callback_data).toBe("k-2:choose:a");
    expect(keyboard?.[1][0].callback_data).toBe("k-2:choose:b");
  });

  test("choose with no options produces no keyboard", () => {
    expect(buildKeyboard(makeRequest({ type: "choose", options: [] }))).toBeNull();
  });

  test("input and notify are button-free", () => {
    expect(buildKeyboard(makeRequest({ type: "input" }))).toBeNull();
    expect(buildKeyboard(makeRequest({ type: "notify" }))).toBeNull();
  });
});

describe("MAX_MESSAGE_CHARS", () => {
  test("stays under the Telegram 4096 ceiling", () => {
    expect(MAX_MESSAGE_CHARS).toBe(4000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram-format.test.ts --timeout=5000`
Expected: FAIL — module `src/interaction/plugins/telegram-format` cannot be resolved.

- [ ] **Step 3: Create the new module**

Create `src/interaction/plugins/telegram-format.ts`. Copy the six method bodies verbatim from `telegram.ts` lines 239-397 — do not rewrite them. Drop `private`, drop `this.`, add `export`, and carry each method's existing doc comment across unchanged.

```typescript
/**
 * Telegram message formatting — pure presentation helpers.
 *
 * Extracted from telegram.ts so the plugin stays under the 600-line source
 * limit. No I/O, no instance state: every function here is a pure function of
 * its arguments.
 */

import type { InteractionRequest } from "../types";

/** Telegram message length limit (4096 max, keep buffer) */
export const MAX_MESSAGE_CHARS = 4000;

/** A Telegram inline keyboard: rows of buttons. */
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;
```

Then, in this order, paste the bodies of `buildHeader`, `buildBody`, `sanitizeMarkdown`, `splitText`, `buildKeyboard`, and `getStageEmoji`, converting each signature:

- `private buildHeader(request: InteractionRequest): string {` → `export function buildHeader(request: InteractionRequest): string {`
- `private buildBody(request: InteractionRequest): string {` → `export function buildBody(request: InteractionRequest): string {`
- `private sanitizeMarkdown(text: string): string {` → `export function sanitizeMarkdown(text: string): string {`
- `private splitText(text: string, maxChars: number): string[] {` → `export function splitText(text: string, maxChars: number): string[] {`
- `private buildKeyboard(request: InteractionRequest): Array<Array<{ text: string; callback_data: string }>> | null {` → `export function buildKeyboard(request: InteractionRequest): InlineKeyboard | null {`
- `private getStageEmoji(stage: string): string {` → `export function getStageEmoji(stage: string): string {`

Inside the bodies, three internal call sites lose their `this.`:
- in `buildHeader`: `this.getStageEmoji(request.stage)` → `getStageEmoji(request.stage)`
- in `buildBody`: all four `this.sanitizeMarkdown(...)` → `sanitizeMarkdown(...)`
- in `buildKeyboard`: the local `rows` type annotation becomes `InlineKeyboard`

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram-format.test.ts --timeout=5000`
Expected: PASS, 20 tests.

If `sanitizeMarkdown`'s backslash test fails, you rewrote the regex instead of copying it. The original is a four-step chain starting with `.replace(/\\(?=[_*`\[])/g, "\\\\")`. Restore it verbatim.

- [ ] **Step 5: Delete the moved methods from telegram.ts and wire the imports**

In `src/interaction/plugins/telegram.ts`:

1. Delete lines 12-13 (the `MAX_MESSAGE_CHARS` constant and its comment). Keep `CALLBACK_API_TIMEOUT_MS`.
2. Delete the six method definitions (lines 239-397 in the original file).
3. Add the import below the existing `getSafeLogger` import:

```typescript
import {
  MAX_MESSAGE_CHARS,
  buildBody,
  buildHeader,
  buildKeyboard,
  splitText,
} from "./telegram-format";
```

`sanitizeMarkdown` and `getStageEmoji` are not imported — they are only called from inside `buildBody` and `buildHeader`.

4. In `send()`, drop the `this.` prefixes:

```typescript
const header = buildHeader(request);
const keyboard = buildKeyboard(request);
const body = buildBody(request);

// Split body into chunks that fit within Telegram's 4000-char limit.
// Header is prepended to the first chunk; subsequent chunks get a part label.
const chunks = splitText(body, MAX_MESSAGE_CHARS - header.length - 10); // 10 = buffer for part label
```

- [ ] **Step 6: Verify nothing regressed and the limit is cleared**

```bash
timeout 60 bun test test/unit/interaction/ --timeout=10000
bun run typecheck
bun run lint
wc -l src/interaction/plugins/telegram.ts src/interaction/plugins/telegram-format.ts
```

Expected: all interaction tests PASS, typecheck and lint clean, `telegram.ts` at roughly 440 lines and `telegram-format.ts` at roughly 180. Both comfortably under 600.

If `bun run lint` reports a `check:deep-relatives` baseline increase, the new import is a sibling (`./telegram-format`) and cannot be the cause — re-read the error before changing anything.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/plugins/telegram.ts src/interaction/plugins/telegram-format.ts test/unit/interaction/plugins/telegram-format.test.ts
git commit -m "refactor(interaction): extract Telegram message formatting into telegram-format.ts

telegram.ts sat at 596 lines against an ungrandfathered 600-line limit, so
neither the chat_id authorization fix (#1365) nor the fetch deps seam (#1366)
could add a line to it.

The six presentation helpers are pure -- no I/O, no instance state -- so they
move out as free functions with their bodies unchanged. They had no direct
coverage before (private methods, exercised only through send()), so this adds
unit tests for them at the same time, which is what makes the relocation
verifiable rather than assumed."
```

---

### Task 2: Split the Telegram suites into their own test file

`interaction-plugins.test.ts` is at 790 of 800 lines. Tasks 3 and 4 both add tests to the Telegram suites. This is a pure file move — no test bodies change.

**Files:**
- Create: `test/unit/interaction/plugins/telegram.test.ts`
- Modify: `test/unit/interaction/interaction-plugins.test.ts` (remove lines 15-71 and 192-664)

**Interfaces:**
- Consumes: nothing.
- Produces: `test/unit/interaction/plugins/telegram.test.ts` — the file Tasks 3 and 4 add their tests to.

- [ ] **Step 1: Create the new test file with the moved suites**

Create `test/unit/interaction/plugins/telegram.test.ts`. Move two `describe` blocks verbatim out of `interaction-plugins.test.ts`:

- `describe("TelegramInteractionPlugin", ...)` — original lines 15-71
- the `// ---` banner comment at lines 192-194 plus `describe("TelegramInteractionPlugin - send() and poll()", ...)` — original lines 196-664

Header for the new file:

```typescript
/**
 * Telegram Interaction Plugin Unit Tests
 *
 * Split out of interaction-plugins.test.ts, which was at the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InteractionRequest } from "../../../../src/interaction";
import { TelegramInteractionPlugin } from "../../../../src/interaction/plugins/telegram";
```

Note the import depth is `../../../../` here — one level deeper than the file the suites came from. Verify against the sibling `test/unit/interaction/plugins/cli.test.ts`, which uses the same depth.

- [ ] **Step 2: Trim the source file**

In `test/unit/interaction/interaction-plugins.test.ts`:

1. Delete both moved `describe` blocks and the banner comment.
2. Delete the now-unused imports: `TelegramInteractionPlugin`, and `InteractionRequest` **only if** no remaining suite references it — check before deleting; the Webhook suite may use it.
3. Update the file's header comment from "Tests for Telegram, Webhook, and Auto plugins." to "Tests for Webhook and Auto plugins."

- [ ] **Step 3: Verify both files pass and neither is over the limit**

```bash
timeout 60 bun test test/unit/interaction/ --timeout=10000
bun run typecheck
bun run lint
wc -l test/unit/interaction/interaction-plugins.test.ts test/unit/interaction/plugins/telegram.test.ts
```

Expected: the same total test count as before the split — no test lost in the move. `interaction-plugins.test.ts` at roughly 263 lines, `telegram.test.ts` at roughly 540.

Record the pre-split total first so you can compare:
```bash
git stash && timeout 60 bun test test/unit/interaction/ --timeout=10000 2>&1 | tail -3 && git stash pop
```

- [ ] **Step 4: Commit**

```bash
git add test/unit/interaction/interaction-plugins.test.ts test/unit/interaction/plugins/telegram.test.ts
git commit -m "test(interaction): split Telegram suites into test/unit/interaction/plugins/telegram.test.ts

interaction-plugins.test.ts was at 790 of the 800-line test limit, leaving no
room for the authorization regression tests. Pure move -- no test body changes.
Destination follows the existing test/unit/interaction/plugins/ convention
already established by cli.test.ts."
```

---

### Task 3: Introduce the `_telegramPluginDeps` fetch seam

Closes #1366. Pure DI refactor, no behaviour change.

**Files:**
- Modify: `src/interaction/plugins/telegram.ts` (5 call sites)
- Modify: `test/unit/interaction/plugins/telegram.test.ts`
- Modify: `test/unit/interaction/telegram-timeout.test.ts`

**Interfaces:**
- Consumes: `telegram.ts` as left by Task 1.
- Produces — used by Task 4's tests:
  - `_telegramPluginDeps: { fetch: typeof fetch }` exported from `src/interaction/plugins/telegram.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/interaction/plugins/telegram.test.ts`. Import `_telegramPluginDeps` alongside the existing plugin import:

```typescript
describe("TelegramInteractionPlugin - fetch deps seam", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("send() routes through _telegramPluginDeps.fetch, not the global", async () => {
    const urls: string[] = [];
    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      urls.push(urlStr);
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 99999 } } }), {
        status: 200,
      });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "deps-1",
      type: "confirm",
      featureName: "f",
      stage: "review",
      summary: "s",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    expect(urls.some((u) => u.includes("sendMessage"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram.test.ts --timeout=5000`
Expected: FAIL — `_telegramPluginDeps` is not exported from the module.

- [ ] **Step 3: Add the deps object and route all five call sites**

In `src/interaction/plugins/telegram.ts`, immediately below the imports:

```typescript
/**
 * Injectable dependencies for testing.
 * Mirrors _webhookPluginDeps in the sibling webhook plugin — tests stub this
 * rather than monkey-patching globalThis.fetch, which leaks across test files.
 */
export const _telegramPluginDeps = {
  fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
};
```

Then replace every bare `fetch(` call with `_telegramPluginDeps.fetch(`. There are exactly five, one in each of:

| Method | Endpoint |
|:---|:---|
| `send` | `sendMessage` |
| `fetchUpdates` | `getUpdates` |
| `answerCallbackQuery` | `answerCallbackQuery` |
| `clearInlineKeyboard` | `editMessageReplyMarkup` |
| `sendTimeoutMessage` | `editMessageText` |

Verify none were missed:
```bash
grep -n "[^.]fetch(" src/interaction/plugins/telegram.ts
```
Expected: no matches. `.bind(globalThis)` on the deps line is not a call and will not match.

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Migrate the existing tests off `globalThis.fetch`**

In `test/unit/interaction/plugins/telegram.test.ts` and `test/unit/interaction/telegram-timeout.test.ts`, replace the monkey-patch idiom throughout:

```typescript
// Before
const originalFetch = globalThis.fetch;
afterEach(() => { mock.restore(); globalThis.fetch = originalFetch; });
globalThis.fetch = mock(async (url) => { ... }) as typeof fetch;

// After
const originalFetch = _telegramPluginDeps.fetch;
afterEach(() => { mock.restore(); _telegramPluginDeps.fetch = originalFetch; });
_telegramPluginDeps.fetch = mock(async (url) => { ... }) as typeof fetch;
```

`telegram-timeout.test.ts` uses `savedFetch` rather than `originalFetch` for the same purpose — rename its target, not its variable.

Leave `test/unit/interaction/interaction-network-failures.test.ts` alone: after Task 2 its `globalThis.fetch` patches belong to the **webhook** suites, which have their own `_webhookPluginDeps` and are out of scope here.

- [ ] **Step 6: Verify the whole interaction suite**

```bash
timeout 60 bun test test/unit/interaction/ --timeout=10000
bun run typecheck
bun run lint
```
Expected: all PASS, clean.

Then confirm the seam is real — with the global untouched, a stubbed deps object must fully control the plugin:
```bash
grep -rn "globalThis.fetch" test/unit/interaction/plugins/telegram.test.ts test/unit/interaction/telegram-timeout.test.ts
```
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/plugins/telegram.ts test/unit/interaction/plugins/telegram.test.ts test/unit/interaction/telegram-timeout.test.ts
git commit -m "refactor(interaction): route Telegram plugin fetch through an injectable deps seam

Closes #1366.

All five call sites (send, fetchUpdates, answerCallbackQuery,
clearInlineKeyboard, sendTimeoutMessage) now go through
_telegramPluginDeps.fetch, mirroring _webhookPluginDeps in the sibling webhook
plugin. Tests stub the seam instead of monkey-patching globalThis.fetch, which
leaks across test files in Bun 1.x.

No behaviour change."
```

---

### Task 4: Reject inbound updates from unconfigured chats

Closes #1365. This is the security fix.

**Files:**
- Modify: `src/interaction/plugins/telegram.ts` (`fetchUpdates`, plus one new private method)
- Modify: `test/unit/interaction/plugins/telegram.test.ts`

**Interfaces:**
- Consumes: `_telegramPluginDeps` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/interaction/plugins/telegram.test.ts`:

```typescript
describe("TelegramInteractionPlugin - inbound chat authorization", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  /**
   * Stubs the Telegram API.
   *
   * Two behaviours here are load-bearing, and getting either wrong produces a
   * test that passes for the wrong reason:
   *
   * 1. Updates stay INVISIBLE until sendMessage has been called. send() calls
   *    drainBacklog() before posting the prompt, so an update that is visible
   *    from the start is consumed by the drain and never reaches receive() at
   *    all — the assertion would then pass even with the security fix reverted.
   *    Gating on `posted` models what actually happens: the attacker taps the
   *    button after the prompt appears.
   *
   * 2. getUpdates honours the offset, so an update is served once and not
   *    re-served. That is what makes the lastUpdateId test meaningful.
   */
  function stubTelegram(updates: Array<Record<string, unknown>>) {
    const acked: string[] = [];
    const offsets: number[] = [];
    let posted = false;

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = JSON.parse((init?.body as string) ?? "{}");

      if (urlStr.includes("sendMessage")) {
        posted = true;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
        });
      }
      if (urlStr.includes("answerCallbackQuery")) {
        acked.push(body.callback_query_id as string);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes("getUpdates")) {
        const offset = body.offset as number;
        offsets.push(offset);
        const visible = posted ? updates.filter((u) => (u.update_id as number) >= offset) : [];
        return new Response(JSON.stringify({ ok: true, result: visible }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    return { acked, offsets };
  }

  function makeConfirmRequest(id: string): InteractionRequest {
    return {
      id,
      type: "confirm",
      featureName: "my-feature",
      stage: "review",
      summary: "Proceed with merge?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest;
  }

  test("a correctly-formed callback_query from a foreign chat does not resolve the request", async () => {
    stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-foreign",
          // Payload is exactly what a legitimate approval looks like.
          data: "auth-1:approve",
          message: { message_id: 10, chat: { id: 424242 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-1"));

    const response = await plugin.receive("auth-1", 300);

    expect(response.respondedBy).toBe("timeout");
    expect(response.action).not.toBe("approve");
  });

  test("a foreign callback_query is never acknowledged", async () => {
    const { acked } = stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-foreign",
          data: "auth-2:approve",
          message: { message_id: 10, chat: { id: 424242 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-2"));
    await plugin.receive("auth-2", 300);

    expect(acked).not.toContain("cq-foreign");
  });

  test("a text message from a foreign chat does not answer a pending input request", async () => {
    stubTelegram([
      {
        update_id: 1,
        message: { message_id: 77, chat: { id: 424242 }, text: "rm -rf /" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "auth-3",
      type: "input",
      featureName: "my-feature",
      stage: "review",
      summary: "What should I do?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("auth-3", 300);

    expect(response.respondedBy).toBe("timeout");
    expect(response.value).toBeUndefined();
  });

  test("lastUpdateId still advances past foreign updates so they are not re-served forever", async () => {
    const { offsets } = stubTelegram([
      {
        update_id: 7,
        message: { message_id: 77, chat: { id: 424242 }, text: "noise" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-4"));
    // 2500ms, not 300ms: the poll loop backs off 1000ms between attempts, so a
    // short timeout yields a single poll and never demonstrates the offset moving.
    await plugin.receive("auth-4", 2500);

    // Reaching offset 8 is the discriminating assertion. If the filter ran
    // before lastUpdateId advanced, the offset would stay parked at 1 forever
    // and 8 would never appear.
    expect(offsets).toContain(8);
    expect(offsets.at(-1)).toBe(8);
  });

  test("a callback_query from the configured chat still resolves", async () => {
    stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-ok",
          data: "auth-5:approve",
          message: { message_id: 10, chat: { id: 99999 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-5"));

    const response = await plugin.receive("auth-5", 5000);

    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("telegram");
  });

  test("a text reply from the configured chat still answers an input request", async () => {
    stubTelegram([
      {
        update_id: 1,
        message: { message_id: 78, chat: { id: 99999 }, text: "ship it" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "auth-6",
      type: "input",
      featureName: "my-feature",
      stage: "review",
      summary: "What should I do?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("auth-6", 5000);

    expect(response.action).toBe("input");
    expect(response.value).toBe("ship it");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram.test.ts --timeout=5000`

Expected: the four foreign-chat tests FAIL, the two configured-chat tests PASS. Specifically the first should report `expect(received).toBe("timeout")` with received `"telegram"` — that failure **is** the vulnerability, reproduced. Do not proceed until you have seen it.

- [ ] **Step 3: Implement the check**

In `src/interaction/plugins/telegram.ts`, add the predicate directly above `parseUpdate`:

```typescript
/**
 * True when an update originates from the configured chat.
 *
 * getUpdates returns updates from EVERY chat the bot participates in, so
 * without this any third party who can message the bot could answer an input
 * prompt (injected straight into the agent's turn by the ACP interaction
 * bridge) or forge a callback_query to approve, reject, or abort a run.
 * Request ids are deterministic and guessable for some flows. See #1365.
 *
 * An update carrying neither a callback_query message nor a message has no
 * chat (edited_message, poll, my_chat_member, ...) and is rejected; parseUpdate
 * already returned null for those, so this is not a behaviour change.
 */
private isFromConfiguredChat(update: TelegramUpdate): boolean {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  return chatId !== undefined && String(chatId) === this.chatId;
}
```

Then, in `fetchUpdates()`, replace this block:

```typescript
const updates = data.result;
if (updates.length > 0) {
  this.lastUpdateId = Math.max(...updates.map((u: TelegramUpdate) => u.update_id));
}
```

with:

```typescript
const raw = data.result;
// Advance the offset from the RAW result, before filtering. Foreign updates
// must still be consumed — filtering first would park the offset behind them
// and Telegram would re-serve the same updates on every poll forever.
if (raw.length > 0) {
  this.lastUpdateId = Math.max(...raw.map((u: TelegramUpdate) => u.update_id));
}
const updates = raw.filter((u: TelegramUpdate) => this.isFromConfiguredChat(u));
if (updates.length !== raw.length) {
  this.logger?.debug("interaction", "Telegram updates rejected — not from the configured chat", {
    rejected: raw.length - updates.length,
  });
}
```

Leave `receive()` untouched. Because the filter runs at ingestion, `receive()` never sees a foreign update and therefore never reaches its `answerCallbackQuery()` call for one — which is what the second test asserts.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/interaction/plugins/telegram.test.ts --timeout=5000`
Expected: all PASS.

If the "lastUpdateId still advances" test fails with every offset stuck at 1, you filtered before advancing the offset. Re-read Step 3 — the ordering is the whole point.

- [ ] **Step 5: Verify the full suite**

```bash
timeout 60 bun test test/unit/interaction/ --timeout=10000
bun run typecheck
bun run lint
```
Expected: all PASS, clean.

Then run the full suite, since `drainBacklog()`'s page-counting behaviour changes subtly (a page of purely foreign updates now reads as empty and stops the drain early — correct, because the offset moved past them):

```bash
bun run test
```
Expected: PASS. Any failure in `test/unit/interaction/` or `test/integration/` that mentions drain or backlog is a real interaction with this change — investigate, do not retry.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/plugins/telegram.ts test/unit/interaction/plugins/telegram.test.ts
git commit -m "fix(interaction): reject inbound Telegram updates from unconfigured chats

Closes #1365.

parseUpdate never compared an inbound update's chat.id against the configured
chatId, and getUpdates returns updates from every chat the bot participates in.
Any third party who could message the bot could answer a pending input
interaction -- injected straight into the coding agent's turn by the ACP
interaction bridge -- or forge a callback_query to approve, reject, or abort a
run, since request ids are deterministic and guessable for some flows.

The check runs at ingestion in fetchUpdates() rather than in parseUpdate() as
the issue sketched: receive() acks every inbound callback_query before
parseUpdate() runs, so a parseUpdate-only guard would still acknowledge a
stranger's forged tap and leak a liveness signal. Filtering at ingestion is one
chokepoint that every present and future consumer of getUpdates() inherits.

lastUpdateId advances from the raw result before filtering. Foreign updates must
still be consumed -- filtering first would park the offset behind them and
Telegram would re-serve the same updates on every poll forever."
```

---

## Post-Implementation

- [ ] Push the branch and open a PR referencing both issues:

```bash
git push -u origin fix/telegram-chat-authorization
gh pr create --title "fix(interaction): reject Telegram updates from unconfigured chats" --body "Closes #1365
Closes #1366

Design: \`docs/superpowers/specs/2026-07-28-telegram-chat-authorization-design.md\`"
```

- [ ] Note for the reviewer, and consider filing as a follow-up issue: authorization is `chat.id` only, by design. Anyone in the configured **group** chat can still approve, reject, or abort a run. A per-user (`from.id`) allowlist was considered and rejected as YAGNI — see the spec's Decisions section. This matters if the bot is deployed into a shared team group rather than a private 1:1 chat.
