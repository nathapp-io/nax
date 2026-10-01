# Constitution

Non-negotiables for this package. Everything else is in `.nax/context.md`.

## Compliance

- The Anthropic OAuth flow is never registered, wired, or re-enabled. It is a terms-of-service
  violation, not a broken path, and a gate asserts its absence.

## The seam

- pi-ai is an implementation detail behind three adapter files. If a change needs a fourth,
  the design is wrong — widen the port, not the allowlist.
- This package must run on Node. A Bun-only convenience is never worth the reuse it costs.
- No consumer's domain vocabulary enters this package.

## Evidence

- A gate's green output is the claim; anything else is a guess. Run the command and read it.
- Say plainly when something is unverified. A scripted test proves a mapping, not a provider's
  real behaviour, and reporting the second from the first is how a defect ships.
- Prove a regression test fails against the old code before trusting it.

## Style

- No emojis in code, comments, or documentation.
- Prefer immutability; never mutate a parameter.
- Comments explain why, not what.
- Tests first.
