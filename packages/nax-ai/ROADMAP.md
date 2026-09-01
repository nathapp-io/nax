# nax-ai roadmap

**Last updated:** 2026-09-01 · **Current milestone:** M4 — hardening. M3 — recorded fixtures is done. M2 — real transport is done, publish pending. M1 merged to `main` in [#1](https://github.com/nathapp-io/nax-ai/pull/1) (`d3a3968`).

This file records where the project is and what comes next. It is the entry point for anyone — human or agent — picking the work up cold.

> **Keep this current.** A stale roadmap is worse than none: it is confidently wrong. Update the position table when a milestone opens or closes, in the same commit as the work.

## Where the documents live

Four documents, each answering a different question. Start here, then follow the one you need.

| Question | Document |
|---|---|
| **Why** does this package exist, and why pi-ai rather than the Vercel AI SDK or hand-rolling? | [Feasibility analysis](https://claude.ai/code/artifact/3f52e26b-9614-411f-ba38-31dd6393f804) (Claude artifact) — strategy, evidence, and the corrections made along the way |
| **Where** are we, and what is next? | This file |
| **What** is nax-ai, and what was decided about its internals? | [`docs/superpowers/specs/2026-08-31-nax-ai-protocol-architecture-design.md`](docs/superpowers/specs/2026-08-31-nax-ai-protocol-architecture-design.md) |
| **How** do I build the current milestone? | [`docs/superpowers/plans/2026-08-31-nax-ai-m2-real-transport.md`](docs/superpowers/plans/2026-08-31-nax-ai-m2-real-transport.md) — 11 tasks. The M1 plan, now finished, is [here](docs/superpowers/plans/2026-08-31-protocol-architecture.md). |
| **What** was decided for M2 specifically? | [`docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md`](docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md) |

The artifact is a point-in-time analysis and does not track progress — it is the reasoning, not the state. The spec records decisions; **read it before designing anything new**, because several questions that look open are already settled there (see the warning below).

## Position

| Milestone | State | Delivers | Can it call a provider? |
|---|---|---|---|
| **M0 — scaffold** | ✅ done | Package, toolchain, two working gates | no |
| **M1 — protocol architecture** | ✅ done | `Protocol`, registry, catalog, client, 4 protocol backends | **no** |
| **M2 — real transport** | ✅ done (publish pending) | `createPiClient`, auth wiring, first real LLM call | yes |
| **M3 — recorded fixtures** | ✅ done | The suite that gates merges | yes |
| **M4 — hardening** | 🚧 in progress | Transport retry ✅ done, thinking-block round-trip ✅ done, `CredentialStore`, live canary | yes |

## Milestones

### M0 — scaffold ✅

Package skeleton, toolchain decisions, and two gates that fail on real violations rather than existing decoratively:

- `src/auth/oauth-policy.ts` — OAuth allowlist. Anthropic is prohibited and the reason is recorded in the code.
- `scripts/check-no-bun-apis.ts` — rejects `Bun.*` in `src/`, because the primary consumer runs on Bun and would never notice the breakage.

### M1 — protocol architecture ✅

The seam that lets a wire protocol be replaced later without consumers noticing. Eleven tasks; see the plan.

Merged in #1 (`d3a3968`), all eleven tasks complete and the plan's Definition of Done passing. Note that the definition covers *verification*, not *capability* — see the warning above.

### M2 — real transport ✅ (publish pending)

The critical path to a usable package, and the piece the M1 plan explicitly defers because it needs knowledge no document currently holds.

- **`createPiClient`** — map pi-ai's `AssistantMessageEventStream` onto the `PiStreamEvent` port. Requires reading `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts` and `dist/types.d.ts`. This mapping is the one part of M1's design that was never verified against pi-ai's real event union.
- **Auth wiring** — `CredentialStore` reaching pi-ai's auth resolution; Codex OAuth end to end.
- **Catalog source** — replace hand-written `RawProvider[]` fixtures with pi-ai's bundled catalog (~42 providers, 652 KB of model and pricing data).
- First real completion against a cheap provider (`deepseek`, `groq`).
- Publish `0.1.0`. Done: it is on npm under both `next` and `latest`. The original rule was `next` and never `latest` before 1.0.0; npm points `latest` at a package's first publish whatever `--tag` says, so that was unachievable from the first release. Since `latest` exists either way, a 0.x stable now updates both rather than leaving `latest` frozen on 0.1.0.

**Executed via [`docs/superpowers/plans/2026-08-31-nax-ai-m2-real-transport.md`](docs/superpowers/plans/2026-08-31-nax-ai-m2-real-transport.md), 11 tasks in dependency order — all complete. `0.1.0` is published to npm (79 files, MIT), by hand for the first release because npm trusted publishing cannot be configured until the package exists. The live probe used a `DEEPSEEK_API_KEY`; the Codex OAuth check used a pre-existing pi credential, since M2 does not implement login.**

**M2's design is written and approved: [`docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md`](docs/superpowers/specs/2026-08-31-nax-ai-m2-real-transport-design.md).** It was designed against pi-ai's actual types rather than sketched, and it supersedes the three mismatches listed below with a fuller set.

#### Three mismatches already visible in pi-ai's types

Found by reading `dist/types.d.ts` against `PiStreamEvent` (`src/protocols/anthropic-messages/backend-pi.ts:17`). Each one is a design decision the M2 note must make, not a detail the implementer can resolve while typing:

1. **There is no usage event.** `AssistantMessageEvent` has thirteen kinds and none of them carry `Usage` — usage rides on `AssistantMessage.usage` (`types.d.ts:316`), reachable via every event's `partial` and via `done.message`. But `PiStreamEvent` has a discrete `usage` kind, and the conformance suite requires usage to *precede* `done`. The adapter must synthesise it, and the note must say from where.
2. **Tool-call deltas have no id or name.** `toolcall_delta` carries only `contentIndex` and `delta`; the `ToolCall` with its id and name arrives at `toolcall_end`. `PiStreamEvent`'s `tool-partial` requires both up front, so they must be read out of `partial`'s content at that index — or the partial event's contract has to change.
3. **`PiClientPort.stream(request: unknown)` is not pi-ai's call shape.** pi-ai takes `stream(model, context, options)` (`types.d.ts:192`); the backends build a single flat wire-request object. The translation belongs in `createPiClient`, which is also the reason the port's parameter is `unknown` today.

#### Carried from M1's final review

Rulings and follow-ups made during M1 that land in M2, recorded here because they otherwise live only in `.superpowers/sdd/2026-08-31-protocol-architecture/progress.md`:

- Per-event-kind tests for the real `createPiClient`, and `classify()` branch tests per backend.
- Extend the pi-ai import gate's ALLOWED list to cover `src/providers/catalog.ts` (deferred from Task 9 when the catalog moves onto pi-ai's bundled data).
- Decide the export surface for protocol registration — `src/index.ts` exports no registration factories today.
- Move `PiClientPort` ownership out of `anthropic-messages/backend-pi.ts` and into `pi-client.ts`, where the sole implementation will live.
- Smoke the OAuth gate through `normaliseCatalog`.
- The catalog key uses `/` as a separator; either constrain provider ids to exclude slashes or switch to nested maps.
- `toolChoice` and `cacheRetention` have no wire mapping yet — plan-level gap, needs the real client.
- Optional: the four `classify()` implementations are near-duplicates; the seam permits a shared interior helper.
- Parked minor: the comment at `test/protocols/thinking.test.ts:25` misstates the rank distance ("low" is 1 rank from each neighbour, not 3). Comment-only; correct at first touch.

### M3 — recorded fixtures ✅

**Designed and planned:** [design](docs/superpowers/specs/2026-08-31-nax-ai-m3-recorded-fixtures-design.md) · [plan](docs/superpowers/plans/2026-08-31-nax-ai-m3-recorded-fixtures.md), 8 tasks, all complete (`55ca89c` through `83ac4d2`). Planning found that M2's recorder captured the mapper's *output* rather than its input, so replaying it could not catch a mapping regression — the two fixtures it produced are superseded, not extended.

Captured real provider responses and turned them into the fixture suite that gates merges, replayed by `test/protocols/replay.test.ts`. All four protocols now have at least one real recorded fixture:

- **`anthropic-messages`** — three real fixtures (text, tool, thinking), recorded from `opencode-go`, a gateway provider rather than first-party Anthropic.
- **`openai-completions`** — one real fixture (text), recorded from `opencode-go` (gateway), plus a synthetic example fixture from Task 1 and the synthetic error fixture from Task 7.
- **`openai-responses`** — one real fixture (text), recorded from `opencode-go` (gateway).
- **`openai-codex-responses`** — one real fixture (text), recorded from `openai-codex`, which is a first-party provider (OpenAI's own Codex/ChatGPT-Plus OAuth), not a gateway.

**The thinking-signature round-trip was observed** — this is not an open gap. `opencode-go-anthropic-messages-thinking.json`'s `thinking_end` event carries a real, non-empty `thinkingSignature`, recorded through the gateway. The M3 plan anticipated this might be absent and require a first-party Anthropic API key as a follow-up; that did not happen.

**The error fixture is synthetic.** `test/fixtures/recorded/error-rate-limit.json` is hand-written, not recorded from a live 429 (one cannot be provoked on demand). It shows the error-classification path maps status and retry-after correctly; it is not evidence of any real provider's actual 429 response shape. Its `note` field says this explicitly.

Two follow-ups surfaced while executing this plan, out of M3's evidence-only scope and left open:

1. **`openai-codex-responses`'s error-classification path may be blind in production.** pi-ai's `openai-codex-responses` backend defaults to WebSocket transport, not HTTP/SSE, unless a caller explicitly requests `transport: "sse"`. WebSocket has no HTTP response for `onResponse` to observe, so `classifyHttpError`/`parseRetryAfter` (`src/protocols/errors.ts`, called from `src/protocols/pi-client.ts`) would receive `status: 0` and no headers for any `openai-codex` call made over the default transport — error classification for that provider may not work correctly in production today. `src/protocols/pi-client.ts`'s `toPiOptions` has no pass-through for pi-ai's `transport` option, so a nax-ai consumer currently has no way to request `"sse"`. Recording the `openai-codex-responses-text` fixture had to bypass `createPiProtocol`/`toPiOptions` and drive `PiDeps.stream` directly with `transport: "sse"` forced — see the dedicated test in `test/live/complete.live.test.ts`. Needs a `src/` change (transport pass-through) in a future milestone; M3 does not touch `src/`.
2. **The replay suite's tool-call excusal branch is exercised but not load-bearing.** `test/protocols/replay.test.ts` excuses "emitted no text delta" when a fixture contains a tool call, since a pure tool-call turn legitimately has no prose. The `opencode-go-anthropic-messages-thinking.json` fixture does contain a tool-call event, so the excusal runs and is exercised during every test run; however, that same fixture also emits 28 text-delta events, so it would pass the "must emit text" check regardless of whether the excusal applies. The real gap is a pure tool-call-only turn (no prose at all) — no fixture in the current corpus exercises the excusal in a load-bearing way (one where the excusal actually changes the pass/fail outcome). Not a bug; closing it needs a future re-recording that successfully elicits a tool call with no accompanying prose.

### M4 — hardening 🚧

- ✅ Transport retry (`transportRetries`) — `src/protocols/retry.ts` retries transport faults only, and only before the first event is emitted. Threaded through `src/client.ts`; `src/protocols/pi-client.ts` normalises a raw stream throw (connection reset, DNS failure) into a transport `error` event via `classifyThrown`, without relabelling the caller's own abort. Spec §10.1.
- ✅ Thinking-block round-trip — `ConversationMessage`'s assistant variant had nowhere to carry a thinking block, so extended thinking combined with tool use could not round-trip: the next request must replay the thinking block (text plus opaque signature) or the tool call cannot be verified server-side. Fixed by a new `ThinkingBlock` type (`src/protocols/types.ts`), a `"thinking"` `ProtocolEvent` durable-complete-block counterpart to the existing display-only `"thinking-delta"`, `pi-client.ts` emitting it from `thinking_end` (signature/redacted read defensively off `partial.content[contentIndex]`, the same shape trap `toolCallAt` already handles), `toPiMessages` placing thinking blocks first in the assistant content array (Anthropic's wire ordering requirement), and `CompleteResult.thinking` accumulated by `collectStream` so a `complete()` caller can construct the following turn.
- `CredentialStore` cross-process locking via `modify()`. pi-ai's in-process serialisation covers a single nax process; concurrent `nax` invocations sharing `~/.nax/credentials` can still race.
- Scheduled live-provider canary — a **detector**, never a merge gate. Spec §10.3.

## Deferred items and where they land

Carried from the M1 plan so they are not lost when it is merged:

| Item | Milestone | Spec § |
|---|---|---|
| Real `createPiClient` | M2 | §5 |
| `CredentialStore` wiring | M2 | §5 |
| Recorded-fixture tests | M3 — ✅ done | §9 |
| Transport retry | M4 — ✅ done | §10.1 |
| Live-provider canary | M4 | §10.3 |

## How this maps onto nax

nax's own phasing lives in the artifact (§9). The dependency runs one way — nax consumes nax-ai, never the reverse.

| nax phase | Needs from nax-ai | Earliest |
|---|---|---|
| **Phase A** — 9 one-shot `complete` ops | A working client with exact usage | after **M2** |
| **Phase B** — read-only agentic ops, native pull tools | Streaming + native tool calls | after **M2** (tools ship in M1's design) |
| **Phase C** — full native coding agent | Nothing further; the work is nax-side | — |

**The nax-side spec and plan are deliberately unwritten.** Writing them now would target an API that does not exist and will shift during M2 — the same reason the M1 plan defers `createPiClient`. The moment to write them is when M2 publishes and the surface is real.

When that time comes, nax's side involves: `NativeAgentAdapter` implementing nax's `AgentAdapter` and mapping to its 7 `AgentStreamEvent` kinds; changing `src/agents/registry.ts` (which currently hard-codes `new AcpAgentAdapter(name)`); deleting `src/agents/cost/pricing.ts` in favour of nax-ai's rates; and a fence gate for `src/agents/native/`.

## Before you design anything new

The spec's §10 records three questions that were resolved against evidence, not preference. They read like open questions and are not:

1. **Retry** is split by fault class — nax-ai retries transport faults only, and only before the first event. Rate limits are the consumer's, because backoff interacts with concurrency and cost budget.
2. **`ThinkingLevel` has seven values**, matching pi-ai's scale. A narrower enum would remove expressiveness nax already has, since nax forwards effort opaquely today.
3. **The live-provider job is a detector, not a gate.** The first outage that turns it red must not read as "the branch is broken".

Likewise settled in the spec, and easy to re-derive differently by accident: the swap unit is the **protocol** (not the provider); `Protocol` exposes **only** `stream` with `complete` derived once at the client; an unregistered backend **throws rather than falling back**; and nax-ai supplies pricing **rates** while the consumer computes cost.
