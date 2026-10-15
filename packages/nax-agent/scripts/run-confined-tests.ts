#!/usr/bin/env bun
/**
 * The confined test runner's CLI (nax#2523).
 *
 * `bun scripts/run-confined-tests.ts [--package=<dir>] [--timeout=<ms>] [--probe] <test paths...>`
 *
 * Argument checks come first: without `--probe` and with no test path there is
 * nothing to do, so the process exits `USAGE_EXIT` (2) before it probes the
 * sandbox or spawns anything. `--probe` reports whether this host has a usable
 * sandbox (exit 0, or `SANDBOX_UNAVAILABLE_EXIT` (3) with the reason on
 * stderr) — `packages/nax`'s test helper uses that shape.
 *
 * `main` returns the exit code and takes its effects as an optional seam, so a
 * test can drive every path without launching a sandbox or a subprocess.
 */
import { resolve } from "node:path";
import {
  type ConfinedRunInput,
  DEFAULT_TEST_TIMEOUT_MS,
  probeConfinedSandbox,
  runConfinedTests,
  SANDBOX_UNAVAILABLE_EXIT,
  USAGE_EXIT,
} from "./lib/confined-run.ts";

const USAGE =
  "usage: run-confined-tests [--package=<dir>] [--timeout=<ms>] [--probe] <test paths...>\n" +
  "  <test paths...>  test paths passed to `bun test` inside the confined sandbox\n" +
  "  --package=<dir>  package directory to run in (default: the working directory)\n" +
  "  --timeout=<ms>   per-test timeout (default: 60000)\n" +
  "  --probe          report whether this host has a usable sandbox, then exit\n";

export interface ConfinedCliDeps {
  readonly run: (input: ConfinedRunInput) => Promise<number>;
  readonly probe: typeof probeConfinedSandbox;
  readonly stderr: (text: string) => void;
}

export interface ConfinedCliArgs {
  readonly packageDir?: string;
  readonly timeoutMs?: number;
  readonly probe: boolean;
  readonly paths: readonly string[];
}

/** Parse the argv, or null when it is not a usable command line. */
export function parseConfinedCliArgs(argv: readonly string[]): ConfinedCliArgs | null {
  const paths: string[] = [];
  let packageDir: string | undefined;
  let timeoutMs: number | undefined;
  let probe = false;
  for (const arg of argv) {
    if (arg === "--probe") {
      probe = true;
      continue;
    }
    if (arg.startsWith("--package=")) {
      packageDir = arg.slice("--package=".length);
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const value = Number.parseInt(arg.slice("--timeout=".length), 10);
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      timeoutMs = value;
      continue;
    }
    // An unknown flag is a usage error, never a test path `bun test` would
    // read as a file name.
    if (arg.startsWith("--")) return null;
    paths.push(arg);
  }
  return {
    ...(packageDir !== undefined ? { packageDir } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    probe,
    paths,
  };
}

/** Run the CLI and return its exit code. */
export async function main(argv: readonly string[], overrides: Partial<ConfinedCliDeps> = {}): Promise<number> {
  const deps: ConfinedCliDeps = {
    run: runConfinedTests,
    probe: probeConfinedSandbox,
    stderr: (text) => {
      process.stderr.write(text);
    },
    ...overrides,
  };
  const args = parseConfinedCliArgs(argv);
  if (args === null || (!args.probe && args.paths.length === 0)) {
    deps.stderr(USAGE);
    return USAGE_EXIT;
  }
  if (args.probe) {
    const probe = await deps.probe();
    if (probe.available) return 0;
    deps.stderr(`sandbox unavailable: ${probe.reason}\n`);
    return SANDBOX_UNAVAILABLE_EXIT;
  }
  return deps.run({
    packageDir: resolve(args.packageDir ?? process.cwd()),
    paths: args.paths,
    timeoutMs: args.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
