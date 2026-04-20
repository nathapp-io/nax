#!/usr/bin/env bun
/**
 * PreToolUse guard for Bash — require `bun test` invocations to be wrapped
 * with `timeout` (or to use the canonical wrapper script).
 *
 * Why: Bun's JSC runtime occasionally SIGABRTs under sustained load
 * (`std::span Assertion '__idx < size()' failed`) and can also hang on
 * individual test files. Raw `bun test` invocations have no wall-clock cap,
 * so a hang blocks the agent until its outer shell timeout fires — by which
 * time grandchild processes (acpx, subshells) may have leaked.
 *
 * The rule:
 *   - `bun run test[:*]`           allowed (wrapper already time-boxes)
 *   - `timeout … bun test …`       allowed
 *   - `bun test …`                 BLOCKED with an actionable hint
 *
 * Hook protocol: reads PreToolUse JSON from stdin, exit 2 to block with
 * stderr shown to the agent, exit 0 to allow.
 */

export {}; // ensure module scope — avoids colliding with other `main()` fns in the repo.

type HookInput = {
  tool_name?: string;
  tool_input?: { command?: string };
};

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  let payload: HookInput;
  try {
    payload = JSON.parse(raw) as HookInput;
  } catch {
    process.exit(0); // malformed — don't block
  }

  if (payload.tool_name !== "Bash") process.exit(0);

  const cmd = (payload.tool_input?.command ?? "").trim();
  if (!cmd) process.exit(0);

  // Allow wrapper scripts — they time-box internally.
  //   bun run test, bun run test:bail, bun run test:unit, etc.
  if (/\bbun\s+run\s+test(:[\w-]+)?\b/.test(cmd)) process.exit(0);

  // Allow timeout-wrapped invocations.
  //   timeout 30 bun test …
  //   timeout -k 5s 30s bun test …
  //   gtimeout 30 bun test …   (macOS coreutils)
  if (/\b(g?timeout)\s+(-k\s+\S+\s+)?\S+\s+bun\s+test\b/.test(cmd)) process.exit(0);

  // Anything else with "bun test" is blocked.
  if (/\bbun\s+test\b/.test(cmd)) {
    process.stderr.write(
      [
        "Blocked: bare `bun test` can hang or SIGABRT (Bun JSC instability).",
        "",
        "Use one of:",
        "  timeout 30 bun test <path> --timeout=5000",
        "  bun run test           # full suite (already time-boxed)",
        "  bun run test:bail      # full suite, bail on first failure",
        "",
        "See scripts/run-tests.ts for why this matters.",
      ].join("\n"),
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
