#!/usr/bin/env bun
/**
 * Gate: nax's @nathapp/nax-ai dependency is an EXACT version equal to the workspace
 * package's version. `workspace:*` is not allowed: src/agents/catalog/index.ts reads the
 * spec as NAX_AI_VERSION (catalogVersion on cost rows) and accepts only X.Y.Z.
 * Bun links the workspace package when the exact pin matches its version.
 */
import { join } from "node:path";
import { findRepoRoot } from "./lib/repo-root";

const EXACT = /^\d+\.\d+\.\d+$/;

export function checkNaxAiPin(
  naxPkg: { dependencies?: Record<string, string> },
  naxAiPkg: { version: string },
): string | null {
  const spec = naxPkg.dependencies?.["@nathapp/nax-ai"];
  if (spec === undefined) return "@nathapp/nax-ai is missing from packages/nax dependencies";
  if (!EXACT.test(spec)) return `@nathapp/nax-ai must be an exact X.Y.Z pin, found "${spec}"`;
  if (spec !== naxAiPkg.version) {
    return `@nathapp/nax-ai pin ${spec} != packages/nax-ai version ${naxAiPkg.version} (bump both in one PR)`;
  }
  return null;
}

if (import.meta.main) {
  const root = findRepoRoot(import.meta.dir);
  const err = checkNaxAiPin(
    await Bun.file(join(root, "packages/nax/package.json")).json(),
    await Bun.file(join(root, "packages/nax-ai/package.json")).json(),
  );
  if (err) {
    console.error(`[FAIL] ${err}`);
    process.exit(1);
  }
  console.log("[OK] @nathapp/nax-ai pin matches the workspace version");
}
