# M3 — recorded fixtures: design

**Status:** approved, not implemented. Plan: [`../plans/2026-08-31-nax-ai-m3-recorded-fixtures.md`](../plans/2026-08-31-nax-ai-m3-recorded-fixtures.md).

## The problem M3 actually solves

Protocol correctness currently rests on scripted events that assert the mapping is
*self-consistent* rather than *right*. Every test in `test/protocols/` hand-writes the pi
events it then asserts on, so a wrong belief about what pi emits produces a green suite.

## The defect in what M2 left behind

`test/live/support/record.ts` writes nax-ai's own `ProtocolEvent[]` — the mapper's
**output**. Replaying that asserts nothing about the mapping: a regression in
`pi-client.ts` would simply be re-recorded as the new expectation. The two existing
fixtures (`deepseek-text.json`, `deepseek-tool.json`) are at this level and must be
re-recorded rather than extended.

**Fixtures must capture the input side**: pi's `AssistantMessageEvent` stream plus the
observed HTTP response, replayed through `createPiProtocol` with a stubbed `deps.stream`,
asserting the `ProtocolEvent`s that come out.

`PiDeps` is already exactly that seam — M1 built it, and `createPiProtocol(name, deps)`
takes it injected. M3 uses the seam rather than adding one.

## Coverage

Four registry keys, all reachable from credentials already present in `~/.pi/agent/auth.json`:

| Protocol | Recorded via | Auth |
|:---|:---|:---|
| `anthropic-messages` | `opencode-go` | api-key |
| `openai-completions` | `opencode-go` | api-key |
| `openai-responses` | `opencode-go` | api-key |
| `openai-codex-responses` | `openai-codex` | oauth |

Plus one **error-path** fixture, which no test has ever covered: the `onResponse` capture
that `classifyHttpError` and `parseRetryAfter` depend on has never met a real failure.

## Ruling: the thinking-signature gap stays open, and stays stated

`opencode-go` and `minimax` speak `anthropic-messages` but are **gateways implementing
Anthropic's wire format**, not Anthropic. For event-shape mapping that is equivalent. For
the thinking-block `signature` specifically — the field PR #4 added and nothing has
verified live — a gateway may not emit one at all.

M3 records whatever the gateway emits. **If no real signature appears, the fixture says so
and the roadmap says so.** Recording a signature-less thinking block and describing the
result as "thinking blocks covered" would be the same error M2 made: reporting evidence of
a shape as evidence of a behaviour.

Closing it properly needs a first-party Anthropic API key (billing, not subscription OAuth,
which is prohibited — see the OAuth policy). That is a follow-up, not M3.

## Credentials

`createPiDeps({})` passes pi no credential store, so pi resolves from ambient environment
variables only. That is enough for an api-key provider whose variable the operator exports,
and **not** enough for `openai-codex`, whose OAuth credential lives in `~/.pi/agent/auth.json`
and which no environment variable can carry. nax-ai ships no `CredentialStore` implementation
— it is a bare port — so the live suite supplies a read-only one that reads pi's own file.

That store refuses `modify` and `delete` rather than no-oping them. pi runs OAuth refresh
inside `modify`, and silently discarding a rotated refresh token can invalidate the operator's
pi login rather than merely failing the run. Failing loudly says: refresh through pi first.

Note that nax-ai's `StoredCredential` oauth variant is a closed three-field shape while pi's
carries an index signature for provider extras such as `accountId`. Those extras are dropped
in translation. For `openai-codex` that is harmless — pi re-derives the account id from the
access token's JWT claim rather than reading the stored field — but it is a latent limitation
for any future provider that needs a stored extra.

## Redaction

Fixtures are committed to a public repository. Recorded response headers are filtered to an
allowlist — `retry-after`, `content-type`, `x-request-id` — because `parseRetryAfter` reads
only the first and the rest are provenance. Everything else, including anything
cookie-shaped or authorization-shaped, is dropped rather than trusted to be harmless.

Recorded events contain model output text, which is the point of the fixture.

## Non-goals

- No change to `src/`. M3 is evidence, not behaviour.
- No re-recording on every run. Fixtures are committed artifacts, refreshed deliberately.
- The live suite stays opt-in and excluded from `bun run test`.
