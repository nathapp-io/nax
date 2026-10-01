#!/usr/bin/env bun
/**
 * Gate: one usage and rate vocabulary (S1 spec, ruling R3 and section 5.3).
 *
 * Only packages/nax-ai may declare an interface, type alias or class named
 * TokenUsage, NativeUsage, TokenPricing, TokenPricingTier, ResolvedRates,
 * Pricing, PricingRates or PricingTier. Re-exports (`export type { X } from`)
 * are not declarations. Edge shapes that keep historical keys carry their own
 * names (StoryTokenUsage, ConfigPricing, CostRowRates), so none is exempt.
 *
 * Scans every packages/<pkg>/src tree. Test files are not scanned.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { findRepoRoot } from "./lib/repo-root";

const NAMES = [
  "TokenUsage",
  "NativeUsage",
  "TokenPricing",
  "TokenPricingTier",
  "ResolvedRates",
  "Pricing",
  "PricingRates",
  "PricingTier",
];
const DECL = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(interface|type|class)\\s+(${NAMES.join("|")})\\b`);
const OWNER = "packages/nax-ai/";

function* srcFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* srcFiles(full);
    else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts")
    )
      yield full;
  }
}

export function findVocabularyViolations(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  let pkgs: string[];
  try {
    pkgs = readdirSync(packagesDir);
  } catch {
    return [];
  }
  const violations: string[] = [];
  for (const pkg of pkgs) {
    for (const file of srcFiles(join(packagesDir, pkg, "src"))) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      if (rel.startsWith(OWNER)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const match = DECL.exec(line);
          if (match) violations.push(`${rel}:${index + 1}  ${match[1]} ${match[2]}`);
        });
    }
  }
  return violations.sort(byCodePoint);
}

if (import.meta.main) {
  const violations = findVocabularyViolations(findRepoRoot(import.meta.dir));
  if (violations.length > 0) {
    console.error("[FAIL] usage/rate types may only be declared in packages/nax-ai (S1 spec section 5.3):");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("[OK] one usage and rate vocabulary");
}
