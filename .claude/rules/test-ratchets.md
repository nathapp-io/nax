# Test Debt Ratchets

Issue #1514 ships two ratchets in CI to lock in the test/ typecheck invariant:

- `check:test-typecheck` — counts TypeScript errors in `tsconfig.test.json`; fails if grown.
- `check:test-as-unknown-as` — counts `as unknown as` casts in `test/`; fails if grown.

Both behave like the existing `check:nax-error` / `check:deep-relatives` ratchets: they have a `--update-baseline` to lower the threshold when intentional improvements land, and `--list` to surface offenders.

## Why both exist

A strict `tsconfig.test.json` gate dropped onto 2140+ errors invites the path of least resistance: more casts. The cast ratchet prevents that. Together they enforce "tests are valid instances of the types they claim to be", and that improvement is monotonic.

## When to lower the baseline

Only when a commit reduces the count deliberately. Do NOT lower to hide regression — the ratchet will then do nothing.

```bash
bun run check:test-typecheck:update       # after fixing N typecheck errors
bun run check:test-as-unknown-as:update   # after replacing M casts with factories
```

## Allow-list escape hatch

If a cast is genuinely unavoidable, append `// test-ratchet-allow: as-unknown-as` to the line. The ratchet will skip it.

Avoid these patterns that bypass the ratchet without explicit allowlisting:

- `as typeof X` — passes the regex (single `as`), safer than `as unknown as`. Prefer when the shape is right but TypeScript can't prove it.
- Adding the ratchet's *test files* (containing the literal phrase as fixtures) won't trip because they're in `EXEMPT_FILES`.

## What NOT to do

- Don't add `as unknown as` casts to "fix" typecheck errors. Fix the factory or add the missing field.
- Don't exclude entire files from the check. Fix the file's actual type errors.
- Don't `--update-baseline` to hide a count that grew. That's a regression; revert the change.
