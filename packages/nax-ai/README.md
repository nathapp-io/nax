# @nathapp/nax-ai

Provider-agnostic LLM client: completions, streaming, tool calls, usage accounting and auth across API-key and OAuth providers.

> **Pre-1.0 — the API is unstable and will change without deprecation cycles.**
> Published under the `next` dist-tag. Pin an exact version; do not use a caret range.
>
> ```
> npm install @nathapp/nax-ai@next
> ```

## Where to start

New to this repository, or picking the work up cold? **[`ROADMAP.md`](ROADMAP.md)** records the current milestone, what is next, and links to the design spec and the feasibility analysis behind it.

One thing worth knowing before reading further: the package **cannot make a network call yet** — see the milestone table.

## Scope

This package speaks a generic LLM vocabulary — models, messages, tool calls, usage, credentials. It knows nothing about any consumer's domain concepts, and that direction is one-way by design: consumers map onto their own types at their own boundary.

That constraint is what lets the implementation underneath this surface be replaced, provider by provider, without consumers noticing. It is also why domain-specific abstractions do not belong here, however convenient they would be for the first consumer.

## Requirements

- **Node >= 22.19** — the compatibility target. Runs unmodified on Bun and Deno.
- ESM only. There is no CommonJS build.

The package must not use runtime-specific APIs. `Bun.*` and `bun:` imports are rejected by a build gate (`scripts/check-no-bun-apis.ts`) because the primary consumer runs on Bun, so nothing would fail there — the breakage would surface only for someone else, on install.

## OAuth policy

OAuth flows are governed by an explicit allowlist in `src/auth/oauth-policy.ts`, enforced by tests rather than convention.

**Anthropic subscription OAuth is prohibited and must never be added.** Using Pro/Max tokens outside the official Claude CLI is server-blocked and a Consumer ToS violation. This is not a broken path awaiting repair — route Claude subscription traffic through the official CLI instead.

The underlying client bundles Anthropic's flow beside permitted ones behind a shared lazy loader, which is precisely why the prohibition is a gate: "we simply won't call it" is not enforceable, and the environment that would notice the mistake is not the one running the tests.

## Development

```bash
bun install
bun run test         # vitest
bun run typecheck    # tsc --noEmit
bun run lint         # biome + no-bun-apis gate
bun run build        # tsc -p tsconfig.build.json → dist/
```

**Vitest does not type-check.** It transpiles via esbuild, which strips types without verifying them, so a green suite proves nothing about compilation. `test` and `typecheck` cover disjoint ground and CI runs both.

Tests run on Node (the compatibility target) and the built package is smoke-tested on Bun (the primary consumer's runtime). Testing only on Bun would hide exactly the class of breakage the Node target exists to prevent.

## Licence

MIT
