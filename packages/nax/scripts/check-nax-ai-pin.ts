#!/usr/bin/env bun
/**
 * Gate: nax's and nax-agent's @nathapp/nax-ai dependency is an EXACT version equal
 * to the workspace package's version (nax bundles nax-agent, so the two must agree).
 * `workspace:*` is not allowed: src/agents/catalog/index.ts reads the
 * spec as NAX_AI_VERSION (catalogVersion on cost rows) and accepts only X.Y.Z.
 * Bun links the workspace package when the exact pin matches its version.
 */
import { join } from "node:path";
import { findRepoRoot } from "./lib/repo-root";

const EXACT = /^\d+\.\d+\.\d+$/;

export function checkNaxAiPin(
  naxPkg: { dependencies?: Record<string, string> },
  naxAiPkg: { version: string },
  label = "packages/nax",
): string | null {
  const spec = naxPkg.dependencies?.["@nathapp/nax-ai"];
  if (spec === undefined) return `@nathapp/nax-ai is missing from ${label} dependencies`;
  if (!EXACT.test(spec)) return `${label}: @nathapp/nax-ai must be an exact X.Y.Z pin, found "${spec}"`;
  if (spec !== naxAiPkg.version) {
    return `${label}: @nathapp/nax-ai pin ${spec} != packages/nax-ai version ${naxAiPkg.version} (bump all in one PR)`;
  }
  return null;
}

if (import.meta.main) {
  const root = findRepoRoot(import.meta.dir);
  const naxAi = await Bun.file(join(root, "packages/nax-ai/package.json")).json();
  const errors: string[] = [];
  for (const label of ["packages/nax", "packages/nax-agent"]) {
    const err = checkNaxAiPin(await Bun.file(join(root, label, "package.json")).json(), naxAi, label);
    if (err) errors.push(err);
  }
  if (errors.length > 0) {
    for (const err of errors) console.error(`[FAIL] ${err}`);
    process.exit(1);
  }
  console.log("[OK] @nathapp/nax-ai pin matches the workspace version");
}
