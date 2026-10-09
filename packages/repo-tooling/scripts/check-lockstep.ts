#!/usr/bin/env bun
/**
 * Gate: nax-ai, nax-agent, nax-agent-acp and nax share one version, and nax and
 * nax-agent pin @nathapp/nax-ai to exactly that version (lockstep versioning,
 * RELEASING.md). `--expect=X.Y.Z` also requires that version; the release
 * workflow passes the tag's version.
 */
import { resolve } from "node:path";
import { lockstepErrors, readManifests } from "#scripts/lib/lockstep";

const EXPECT = "--expect=";

export function expectedVersion(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(EXPECT))?.slice(EXPECT.length);
}

if (import.meta.main) {
  const errors = lockstepErrors(readManifests(resolve(import.meta.dir, "../../..")), expectedVersion(process.argv));
  for (const error of errors) console.error(`[FAIL] ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log("[OK] the published nax packages share one version");
}
