#!/usr/bin/env bun

/**
 * Fails if a story's `workdir` field is read directly.
 *
 * Read it through src/utils/path-frame.ts instead:
 *   storyWorkdir(story)          -> string, "." at the repo root
 *   storyPackageDir(story)       -> string | undefined, undefined at the root
 *   storyAbsWorkdir(root, story) -> absolute working directory
 *
 * Why the rule and not a set of patches (nax#2067): 19 raw reads across 10
 * files used THREE different spellings of "absent" -- `?? ""`, `|| undefined`
 * and `? :` truthiness -- and `workdir` is now always a string where "." means
 * the repo root. "." is truthy and is not "", so every one of those idioms
 * lands differently on it. Patching the known sites leaves the next author
 * free to add a fourth.
 *
 * Known limitation: the detection regex requires `.workdir` immediately after
 * the receiver, so an optional-chained read like `ctx.story?.workdir` is NOT
 * matched. Such reads must be converted by review, not by this gate.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");

/** Files permitted to touch the raw field: it is declared and wrapped here. */
const ALLOWED = [
  join("src", "prd", "types.ts"),
  join("src", "utils", "path-frame.ts"),
  join("src", "prd", "schema-story.ts"),
];

/**
 * Temporary, single-entry, SELF-EXPIRING exemption.
 *
 * This file sits on the per-package-config seam nax#2066/#2069 just fixed, so
 * it converts in its own reviewable PR rather than inside a 9-file sweep. The
 * staleness check below makes the entry impossible to leave behind: once the
 * file is converted, an exemption that matches nothing FAILS the gate. Without
 * that, this list silently becomes the baseline the rule exists to avoid.
 */
const EXEMPT = [join("src", "execution", "iteration-runner.ts")];

const READ = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.workdir\b/g;

/** True when the receiver names a story rather than a context or an options bag. */
export function isStoryReceiver(receiver: string): boolean {
  const last = receiver.split(".").at(-1) ?? receiver;
  return last === "s" || /story$/i.test(last);
}

/**
 * Exemptions that matched no read. A stale exemption fails the gate: it is what
 * keeps the list temporary rather than letting it become a baseline.
 */
export function findStaleExemptions(exempt: readonly string[], used: ReadonlySet<string>): string[] {
  return exempt.filter((entry) => !used.has(entry));
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scan one file's source for raw reads. Exported for tests. */
export function findViolations(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
    for (const match of stripped.matchAll(READ)) {
      const receiver = match[1] ?? "";
      if (isStoryReceiver(receiver)) found.push({ file, line: index + 1, text: stripped });
    }
  });
  return found;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * Scan the tree. Side effects live behind `import.meta.main` so the test can
 * import `findViolations` without the gate running -- and exiting -- on import.
 * Same guard as scripts/check-gate-reachability.ts:147.
 */
async function main(): Promise<void> {
  const violations: Violation[] = [];
  const exemptionsUsed = new Set<string>();

  for await (const file of walk(SCAN)) {
    const rel = relative(ROOT, file);
    if (ALLOWED.includes(rel)) continue;

    const found = findViolations(rel, await readFile(file, "utf8"));
    if (found.length === 0) continue;

    if (EXEMPT.includes(rel)) {
      exemptionsUsed.add(rel);
      continue;
    }
    violations.push(...found);
  }

  const stale = findStaleExemptions(EXEMPT, exemptionsUsed);

  if (violations.length > 0) {
    console.error("Read a story's workdir through src/utils/path-frame.ts, not the raw field:");
    console.error("  storyWorkdir(story) | storyPackageDir(story) | storyAbsWorkdir(root, story)");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }

  if (stale.length > 0) {
    console.error("Stale exemption in check-story-workdir-access.ts -- the file is clean, so remove it:");
    for (const entry of stale) console.error(`  ${entry}`);
  }

  if (violations.length > 0 || stale.length > 0) process.exit(1);

  console.log(`check-story-workdir-access: clean (${EXEMPT.length} exemption(s) still pending)`);
}

if (import.meta.main) {
  await main();
}
