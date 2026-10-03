#!/usr/bin/env bun
/**
 * Gate: the built public API of a package equals its committed snapshot, and
 * the public entry exports no `_` name.
 *
 *   bun ../repo-tooling/scripts/check-api-snapshot.ts --package=.            # check
 *   bun ../repo-tooling/scripts/check-api-snapshot.ts --package=. --update   # rewrite the snapshot
 *
 * One tool for both rules: the `_` check reads the same resolved exports as
 * the snapshot, so it sees a seam that leaks through `export *`, and `--update`
 * cannot write a snapshot that contains one.
 */
import { checkApiSnapshot } from "#scripts/lib/api-surface";
import { gatePackageRoot } from "#scripts/lib/package-root";

async function main(): Promise<void> {
  const result = await checkApiSnapshot(gatePackageRoot(), { update: process.argv.includes("--update") });
  for (const message of result.messages) (result.ok ? console.log : console.error)(message);
  if (!result.ok) process.exit(1);
}

if (import.meta.main) await main();
