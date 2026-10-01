# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/nax-ai`

**Language:** TypeScript

**Key dependencies:** typescript, vitest

**Commands:** test: `bun run test` | lint: `bun run lint` | typecheck: `bun run typecheck`

---
# nax-ai — a replaceable seam for talking to LLM providers

`@nathapp/nax-ai` is a provider-agnostic LLM client: completions, streaming, native
tool calls, usage and auth across API-key and OAuth providers. It exists so the wire
implementation underneath can be replaced, provider by provider, without consumers
noticing.

> Edit this file to update AI agent context — do not edit `CLAUDE.md`, `AGENTS.md`,
> `.cursorrules`, `GEMINI.md` or other generated agent files directly.
> Run `nax generate` after changing it.

## Tech Stack

| Layer | Choice |
|:------|:-------|
| Runtime target | Node >= 22.19, ESM-only. Bun is used to build and run scripts, never assumed at runtime |
| Language | TypeScript 7 (exact pin), `strict`, `exactOptionalPropertyTypes`, `nodenext` |
| Upstream client | `@earendil-works/pi-ai` (exact pin) |
| Test | Vitest |
| Lint/Format | Biome, plus two repo-specific gate scripts |

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run test` | Full suite (live tests are excluded by config) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome, then both custom gates |
| `bun run build` | Declaration + JS emit for publishing |
| `bun run test:live` | Opt-in, hits real providers, needs API keys and spends money |

## Architecture

A consumer constructs one `Client` and never names a protocol: the client picks one
from `ResolvedModel.protocol`. That indirection is what makes replacing a protocol's
backend invisible to callers.

```text
src/
├── client.ts        # the only thing a consumer constructs
├── protocols/       # the wire seam: registry, the pi-backed protocol, retry, errors
├── providers/       # catalog normalisation and pi-ai's bundled provider data
├── auth/            # the credential port, its pi adapter, and the OAuth allowlist
└── usage.ts         # token accounting; rates only, never cost
```

## Engineering Rules

- **Only three files may import pi-ai**: `protocols/pi-client.ts`, `providers/pi-catalog.ts`
  and `auth/pi-auth.ts`. `bun run check:pi-ai-imports` enforces this. Everything else
  speaks nax-ai's own vocabulary — that allowlist is the whole reason the seam holds.
- **No `Bun.*` and no `bun:` imports anywhere in `src/`.** The package must run on Node;
  `bun run check:no-bun-apis` enforces it. The release script is Node-only for the same
  reason, even though it is outside the gate's scope.
- **Never register the Anthropic OAuth flow.** Subscription OAuth outside the official
  CLI is a ToS violation and server-blocked. `auth/oauth-policy.ts` holds the allowlist
  and a test asserts the prohibition. pi-ai bundles that flow one call away from a
  permitted one, which is why this is a gate rather than a convention.
- **The unit of replacement is the protocol, not the provider.** `Protocol` exposes only
  `stream`; `complete` is derived once in the client so a request path can never drift
  from the streaming path.
- **An unregistered backend throws.** It never silently falls back to another one.
- **This package supplies pricing rates; the consumer computes cost.** Do not call pi's
  cost helpers.
- **Scope boundary**: nax-ai speaks models, messages, tool calls, usage and credentials.
  It knows nothing about any consumer's domain — no sessions, no permission policy, no
  stories or operations. Keeping that one-way is what allows the implementation beneath
  it to be replaced.
- **Opaque values stay opaque.** A credential `key` and a thinking-block `signature` are
  never inspected, compared, logged, or synthesised. If a provider sent no signature,
  omit the property — never substitute `""`, which is a different thing on the wire.
- **`exactOptionalPropertyTypes` is on.** Build optional properties conditionally
  (`...(x !== undefined ? { x } : {})`) rather than assigning `undefined`.
- **Imports carry explicit `.ts` extensions** — `nodenext` resolution, not bundler.

## Protocol Rules

- **Retry covers transport faults only, and only before the first event.** Rate limits
  (429) and overload (503, 529) belong to the consumer, whose concurrency and cost
  budget the decision depends on. Note 503 classifies as `overloaded`, not `transport`.
- **Any emitted event ends retry for that call**, including `usage` — a retry after a
  usage event would silently discard the failed attempt's billed tokens.
- **Thinking blocks lead the assistant message.** Anthropic requires it; wrong order is
  a wire error, not a style choice.
- **Terminal events can be missing fields the partial carries.** `toolcall_delta` has no
  id or name and `thinking_end` has no signature: both must be read out of `partial`
  at the content index. Read the existing helpers before adding a third.

## Testing Rules

- Tests live under `test/`, mirroring `src/`, named `*.test.ts`.
- `test/live/*.live.test.ts` hit real providers and are excluded from the default run.
  They record fixtures into `test/fixtures/recorded/`.
- Scripted-event tests prove the mapping is self-consistent, not that it matches a real
  provider. When a change depends on a provider's actual behaviour, say so plainly
  rather than treating a green suite as evidence.
- A regression test must be shown to fail against the old code before it counts.
