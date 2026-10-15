#!/usr/bin/env bun
/**
 * The confined test runner's CLI (nax#2523).
 *
 * `bun scripts/run-confined-tests.ts [--package=<dir>] [--timeout=<ms>] [--parallel=<n>] [--probe] <test paths...>`
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
  "usage: run-confined-tests [--package=<dir>] [--timeout=<ms>] [--parallel=<n>] [--probe] <test paths...>\n" +
  "  <test paths...>  test paths passed to `bun test` inside the confined sandbox\n" +
  "  --package=<dir>  package directory to run in (default: the working directory)\n" +
  "  --timeout=<ms>   per-test timeout (default: 60000)\n" +
  "  --parallel=<n>   run the files over n workers (bun test --parallel=<n> --no-isolate)\n" +
  "  --probe          report whether this host has a usable sandbox, then exit\n";

export interface ConfinedCliDeps {
  readonly run: (input: ConfinedRunInput) => Promise<number>;
  readonly probe: typeof probeConfinedSandbox;
  readonly stderr: (text: string) => void;
}

export interface ConfinedCliArgs {
  readonly packageDir?: string;
  readonly timeoutMs?: number;
  readonly parallel?: number;
  readonly probe: boolean;
  readonly paths: readonly string[];
}

type NumericFlag = "timeoutMs" | "parallel";

/**
 * The `--<flag>=<n>` options and how each reads its value (null = invalid).
 * `--timeout` keeps its original lenient `parseInt` reading; `--parallel` is
 * a worker count, so anything but a plain positive integer is refused.
 */
const NUMERIC_FLAGS: readonly { prefix: string; key: NumericFlag; parse: (value: string) => number | null }[] = [
  {
    prefix: "--timeout=",
    key: "timeoutMs",
    parse: (value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
  },
  {
    prefix: "--parallel=",
    key: "parallel",
    parse: (value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : null;
    },
  },
];

/** The numeric flag `arg` sets, with its parsed value; undefined when `arg` is not one. */
function parseNumericFlag(arg: string): { key: NumericFlag; value: number | null } | undefined {
  const flag = NUMERIC_FLAGS.find((candidate) => arg.startsWith(candidate.prefix));
  return flag === undefined ? undefined : { key: flag.key, value: flag.parse(arg.slice(flag.prefix.length)) };
}

/** Parse the argv, or null when it is not a usable command line. */
export function parseConfinedCliArgs(argv: readonly string[]): ConfinedCliArgs | null {
  const paths: string[] = [];
  const numbers: Partial<Record<NumericFlag, number>> = {};
  let packageDir: string | undefined;
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
    const numeric = parseNumericFlag(arg);
    if (numeric !== undefined) {
      if (numeric.value === null) return null;
      numbers[numeric.key] = numeric.value;
      continue;
    }
    // An unknown flag is a usage error, never a test path `bun test` would
    // read as a file name.
    if (arg.startsWith("--")) return null;
    paths.push(arg);
  }
  return {
    ...(packageDir !== undefined ? { packageDir } : {}),
    ...numbers,
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
    ...(args.parallel !== undefined ? { parallel: args.parallel } : {}),
  });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
