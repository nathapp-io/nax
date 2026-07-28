# Telegram inbound chat authorization + fetch deps seam

Date: 2026-07-28
Issues: [#1365](https://github.com/nathapp-io/nax/issues/1365) (security), [#1366](https://github.com/nathapp-io/nax/issues/1366) (refactor)
Branch: `fix/telegram-chat-authorization`

## Problem

`TelegramInteractionPlugin.parseUpdate()` never compares an inbound update's
`chat.id` against the configured `chatId`. `getUpdates` returns updates from
**every** chat the bot participates in, so any third party who can message the
bot can:

- Answer a pending `input` interaction with arbitrary text, which the ACP
  interaction bridge (`src/interaction/bridge-builder.ts`) injects straight into
  the coding agent's turn.
- Forge a `callback_query` to approve, reject, or abort a run. Interaction
  request ids are deterministic and guessable for some flows — e.g.
  `ix-<storyId>-paused-resume` from
  `src/execution/lifecycle/paused-story-prompts.ts`.

That is an authentication bypass on a human-approval gate that is supposed to be
scoped to one configured chat.

Separately, the plugin calls the global `fetch` directly in five places instead
of routing through an injectable `_deps` object. Every test that exercises it
monkey-patches `globalThis.fetch`. There is no seam at which to write the
regression test the security fix needs.

The two issues are coupled: #1366 is the seam that makes #1365 testable.

## Constraint discovered before design

`src/interaction/plugins/telegram.ts` is **596 lines against the 600-line
`SRC_LIMIT`** enforced by `bun run check:file-sizes` (part of `bun run lint`),
and it is **not** grandfathered in `scripts/baselines/file-sizes-baseline.json`.
Four lines of headroom. `test/unit/interaction/interaction-plugins.test.ts` is
at **790 against the 800-line `TEST_LIMIT`**.

Both issues add code to exactly those two files. A split is therefore part of
this work, not an optional tidy-up.

## Decisions

### Authorization scope: `chat.id` only

No new config key, no migration. In a group chat this means every member of the
configured group remains a valid approver — accepted deliberately. A per-user
allowlist (`from.id`) was considered and rejected as YAGNI: it adds config
surface for a threat (a hostile member of a chat you deliberately added the bot
to) that is not the one being fixed.

### Enforcement point: ingestion, not `parseUpdate()`

The check is applied in `fetchUpdates()`, not in `parseUpdate()` as the issue
sketched. `receive()` calls `answerCallbackQuery()` on **every** inbound
`callback_query` before `parseUpdate()` runs (`telegram.ts:180-184`). Guarding
only in `parseUpdate()` would still acknowledge a stranger's forged tap, leaking
a liveness signal, and would leave every future consumer of `getUpdates()`
responsible for remembering the check.

Filtering at ingestion is one chokepoint. `receive()` needs no change at all.

### Split: pure formatting helpers only

The presentation helpers are pure — no I/O, no instance state, no `this`. They
move verbatim to a sibling module. The transport calls stay in the plugin,
because extracting a `TelegramApiClient` would diverge from the shape
`webhook.ts` already establishes and would force `lastUpdateId` / `backoffMs` to
be re-homed. Rejected as a larger blast radius riding along with a security fix.

## Architecture

| File | Lines | Responsibility |
|:---|---:|:---|
| `src/interaction/plugins/telegram.ts` | ~440 | Policy: lifecycle, pending map, poll loop, `parseUpdate`, transport |
| `src/interaction/plugins/telegram-format.ts` | ~160 | Pure presentation |
| `src/interaction/plugins/webhook.ts` | 491 | Untouched |

`telegram-format.ts` exports free functions rather than methods — each takes its
inputs explicitly and uses no `this`:

| Function | Signature |
|:---|:---|
| `buildHeader` | `(request: InteractionRequest) => string` |
| `buildBody` | `(request: InteractionRequest) => string` |
| `buildKeyboard` | `(request: InteractionRequest) => InlineKeyboard \| null` |
| `sanitizeMarkdown` | `(text: string) => string` |
| `splitText` | `(text: string, maxChars: number) => string[]` |
| `getStageEmoji` | `(stage: string) => string` |

Bodies move verbatim. `MAX_MESSAGE_CHARS` moves with them; the inline keyboard
row type is named and exported so `telegram.ts` can still type the
`reply_markup` payload it sends.

These helpers have **no direct test coverage today** — they are private methods,
exercised only indirectly through `send()`'s assertions on message text and
keyboard contents. `sanitizeMarkdown` and `splitText` are barely covered even
incidentally. Direct unit tests are therefore written *before* the move, so the
relocation is verified rather than assumed.

The deps seam is a module-level object in `telegram.ts`, mirroring
`_webhookPluginDeps`:

```typescript
export const _telegramPluginDeps = {
  fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
};
```

All five call sites route through it: `send`, `fetchUpdates`,
`answerCallbackQuery`, `clearInlineKeyboard`, `sendTimeoutMessage`.
`telegram-format.ts` gets no deps object — it makes no external calls.

## The check

```typescript
private isFromConfiguredChat(update: TelegramUpdate): boolean {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  return chatId !== undefined && String(chatId) === this.chatId;
}
```

Applied in `fetchUpdates()` after `lastUpdateId` is advanced from the **raw**
result and before the array is returned:

```typescript
const raw = data.result;
if (raw.length > 0) {
  this.lastUpdateId = Math.max(...raw.map((u) => u.update_id));
}
const updates = raw.filter((u) => this.isFromConfiguredChat(u));
return { ok: true, updates };
```

The ordering is load-bearing. Advancing `lastUpdateId` from the raw result — not
the filtered one — is what consumes foreign updates. Filtering first would leave
the offset parked behind them and Telegram would re-serve the same updates on
every poll forever.

### Consequences, both intended

- `receive()` never sees a foreign update, so `answerCallbackQuery()` is never
  called for a stranger's forged tap.
- `drainBacklog()` counts pages via `result.updates.length === 0`. Post-filter, a
  page of purely foreign updates reads as empty and stops the drain early. This
  is correct: those updates *are* drained, because the offset moved past them.
  The loop's job is advancing the offset, which happened.

An update carrying neither `callback_query.message` nor `message` (Telegram also
sends `edited_message`, `poll`, `my_chat_member`, …) has no chat and is dropped.
`parseUpdate` already returned `null` for those, so this is not a behaviour
change.

## Testing

New regression tests, all stubbing `_telegramPluginDeps.fetch`:

1. A `callback_query` with a **correct** `requestId:approve` payload but the
   wrong `chat.id` does not resolve the pending `receive()` — it times out.
   This is the issue's named acceptance case and the one that proves the bypass
   is closed.
2. Same case, and `answerCallbackQuery` is never called for it.
3. A text message from a foreign chat does not answer a pending `input` request.
4. `lastUpdateId` still advances past foreign updates: across two polls, the
   second sends an `offset` greater than the foreign update's `update_id`.
5. Matching-chat callback and input flows still resolve — the guard against
   over-blocking.

Existing tests migrate from `globalThis.fetch` monkey-patching to stubbing
`_telegramPluginDeps.fetch`. `interaction-network-failures.test.ts` already
stubs `_webhookPluginDeps.sleep`, so the pattern is in the file.

### Test file split

The two Telegram `describe` blocks in
`test/unit/interaction/interaction-plugins.test.ts` (lines 15-72 and 196-664,
~527 lines) move to `test/unit/interaction/plugins/telegram.test.ts`. That
directory already exists and holds `cli.test.ts`, so the destination follows the
established convention. `interaction-plugins.test.ts` drops to ~263 lines for
the Webhook and Auto blocks. `telegram-timeout.test.ts` (128 lines) stays as is.

## Sequencing

Four commits, each independently reviewable and each leaving the suite green:

1. **`refactor:`** — extract `telegram-format.ts` plus its new unit tests. Makes
   source headroom.
2. **`test:`** — move the Telegram suites to
   `test/unit/interaction/plugins/telegram.test.ts`. Makes test headroom.
3. **`refactor:`** — `_telegramPluginDeps` and the five call sites, tests
   migrated to the seam. No behaviour change. Closes #1366.
4. **`fix:`** — `isFromConfiguredChat` plus its regression tests. Closes #1365.

The two headroom commits come first because the 600-line source limit and the
800-line test limit both bite before any functional line can be added. Ordering
this way keeps the security commit's diff to the guard and its tests:
reviewable in isolation, and revertable without losing the refactor.

## Out of scope

- Per-user (`from.id`) allowlists — see Decisions.
- Any change to `webhook.ts`, `auto.ts`, or `cli.ts`.
- Extracting a `TelegramApiClient` transport class — considered and rejected.
- Telegram webhook-mode ingestion (nax polls; it does not run a webhook
  receiver for Telegram).
