#!/usr/bin/env bun
/**
 * Gate: a spec's machine-extracted sections must actually extract.
 *
 * Thin CLI wrapper. All logic lives in `src/prd/spec-lint.ts`, which explains
 * why this check exists and runs nax's own parsers rather than a second copy of
 * their grammar. This file owns only argv, config lookup, and exit codes —
 * mirroring `check-rules-drift.ts`, which wraps `rulesExportCommand`.
 *
 * Usage:  bun run spec:lint <spec.md> [...]
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lintSpecContent } from "../src/prd";

const DEFAULT_MAX_AC_COUNT = 15;
const MAX_CONFIG_SEARCH_DEPTH = 8;

/**
 * The story-size cap from the nearest `.nax/config.json` above the spec.
 * Root config only — per-package configs override commands, never sizing policy.
 */
function readMaxAcCount(specPath: string): number {
  let dir = dirname(resolve(specPath));
  for (let depth = 0; depth < MAX_CONFIG_SEARCH_DEPTH; depth++) {
    const candidate = join(dir, ".nax", "config.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
          precheck?: { storySizeGate?: { maxAcCount?: number } };
        };
        return raw.precheck?.storySizeGate?.maxAcCount ?? DEFAULT_MAX_AC_COUNT;
      } catch {
        return DEFAULT_MAX_AC_COUNT;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return DEFAULT_MAX_AC_COUNT;
}

async function main(): Promise<void> {
  const specPaths = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  if (specPaths.length === 0) {
    console.error("usage: bun run spec:lint <spec.md> [...]");
    process.exit(2);
  }

  let errors = 0;
  let warns = 0;

  for (const specPath of specPaths) {
    if (!existsSync(specPath)) {
      console.error(`[FAIL] spec not found: ${specPath}`);
      errors++;
      continue;
    }
    const text = await Bun.file(specPath).text();
    const findings = lintSpecContent(text, { maxAcCount: readMaxAcCount(specPath) });
    const errs = findings.filter((f) => f.level === "error");
    const wrns = findings.filter((f) => f.level === "warn");
    errors += errs.length;
    warns += wrns.length;

    if (findings.length === 0) {
      console.log(`[OK] ${specPath} — every machine-extracted section round-trips`);
      continue;
    }
    console.log(`\n${specPath}`);
    for (const f of errs) console.log(`  [ERROR] ${f.code}: ${f.message}`);
    for (const f of wrns) console.log(`  [warn]  ${f.code}: ${f.message}`);
  }

  console.log("");
  if (errors > 0) {
    console.error(`[FAIL] ${errors} error(s), ${warns} warning(s) — fix before running \`nax plan\`.`);
    process.exit(1);
  }
  console.log(`[OK] 0 errors, ${warns} warning(s).`);
}

if (import.meta.main) {
  await main();
}
