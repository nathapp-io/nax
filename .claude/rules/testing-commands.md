# Testing Commands — Mandatory `timeout` Wrapper

> nax tests run on Bun. Bun's JSC runtime occasionally SIGABRTs under sustained load (`std::span ... Assertion '__idx < size()' failed`) and individual test files can hang. Bare `bun test` has no wall-clock cap, so a hang blocks the agent until its outer shell timeout fires — by which time grandchild processes (acpx, subshells) may have leaked.

This rule is enforced by a PreToolUse hook: `.claude/hooks/guard-bun-test.ts`. Bare `bun test` is blocked with an actionable hint.

## Commands

| Goal | Use |
|:---|:---|
| Full suite | `bun run test` |
| Full suite, bail on first failure | `bun run test:bail` |
| One file / directory (iteration) | `timeout 30 bun test <path> --timeout=5000` |
| Long-running targeted test | `timeout -k 5s 60s bun test <path> --timeout=60000` |

## Rules

- **Never** run bare `bun test …` — the hook will block it.
- **Always** cap a scoped `bun test` with `timeout <seconds>` so hangs become exit 124 instead of indefinite blocks.
- **Prefer** `bun run test` (or `test:bail`) for the full suite — the wrapper script already time-boxes each phase and runs them in a process group so descendants are reaped on hang. See [`scripts/run-tests.ts`](../../scripts/run-tests.ts).
- **Exit codes** — agents should treat `exit 124` (timeout), `exit 134` (SIGABRT from Bun JSC), and `exit 132` (SIGILL from Bun JSC) as terminal. Do not retry — investigate the test or split the work.

## Why not rely on `--timeout` flag alone?

`bun test --timeout=5000` only bounds *per-test* wall clock. It does not cap the whole invocation, and it does not help when Bun's runtime itself crashes or hangs before reaching a test. The `timeout` shell wrapper covers both cases.

## Iteration workflow

During iteration, run only the tests touching the code you're changing. Full `bun run test` is a final gate, not an inner-loop command.

```bash
# iterating on src/agents/acp/
timeout 30 bun test test/unit/agents/acp/ --timeout=5000

# iterating on a single file
timeout 15 bun test test/unit/agents/acp/adapter-abort.test.ts --timeout=5000
```
