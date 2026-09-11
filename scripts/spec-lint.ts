#!/usr/bin/env bun
/**
 * Gate: a spec's machine-extracted sections must actually extract.
 *
 * Thin CLI wrapper over `nax spec lint`. All logic lives in
 * `src/cli/spec-lint-command.ts` (resolution, presentation, exit code) and
 * `src/prd/spec-lint.ts` (the checks); this file owns only argv and the process
 * exit — mirroring `check-rules-drift.ts`, which wraps `rulesExportCommand`.
 *
 * `--strict` by default, unlike the shipped command. The shipped default answers
 * "would `nax plan` refuse this?", which is the right question for an author
 * about to spend. This repo's own gate wants the stricter bar: `ac-untagged` and
 * the other non-blocking errors are debt we have chosen to hold at zero on new
 * specs, and CI is where that is enforced. Pass `--no-strict` for the shipped
 * default.
 *
 * Usage:  bun run spec:lint <spec.md> [...] [--no-strict]
 */

import { specLintCommand } from "../src/cli";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const specPaths = args.filter((arg) => !arg.startsWith("-"));
  if (specPaths.length === 0) {
    console.error("usage: bun run spec:lint <spec.md> [...]");
    process.exit(2);
  }

  const result = await specLintCommand({
    dir: process.cwd(),
    paths: specPaths,
    strict: !args.includes("--no-strict"),
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (import.meta.main) {
  await main();
}
