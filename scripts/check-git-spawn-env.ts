#!/usr/bin/env bun
/**
 * Every git nax spawns carries the hardened environment (#2198).
 *
 * `hardenedGitEnv` / `gitSpawnEnv` (`src/utils/git-env.ts`) turn off
 * `core.fsmonitor`, a config key naming a program git runs on every
 * status/diff/add. It only protects the spawns that pass it: the fix first
 * landed inside `gitWithTimeout` alone, while more than twenty sites spawned
 * git directly and skipped it. This gate makes the rule structural.
 *
 * Rule: a `["git", ...]` argv literal in `src/` must sit directly inside a
 * `spawn(...)` / `spawnSync(...)` call (any receiver: `Bun.spawn`,
 * `_deps.spawn`) whose arguments call `gitSpawnEnv(` or `hardenedGitEnv(`.
 * An argv handed to a runner that hardens it itself (the forge runner, the
 * `interceptArgv` → `gitWithTimeout` path) carries
 * `// nax-git-env-allow: <reason>` on its own line or the line above.
 *
 * #2210: an argv that runs `status` / `diff` -- a literal one, or `["git",
 * ...args]` whose verb is unknown here -- must also pass through
 * `hardenedGitArgv(...)` (inside the spawn call), which adds the
 * `--ignore-submodules=dirty` that a `.gitmodules` entry cannot override.
 *
 * US-003 closes the textual gate's blind spot: a `spawn(...)` /
 * `spawnSync(...)` call whose first argument is not an array literal headed by
 * a string literal (`Bun.spawn(argv, ...)`, `[gitBin, ...]`) is flagged too,
 * unless the call hardens its own env (`gitSpawnEnv(` / `hardenedGitEnv(`) or
 * its line -- or the line above -- carries a reasoned
 * `// nax-git-env-allow: <reason>`.
 *
 * Comments are masked before matching.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ALLOW_MARKER = /nax-git-env-allow:\s*\S/;
const GIT_ARGV = /\[\s*(["'])git\1\s*[,\]]/g;
const SPAWN_CALLEE = /\bspawn(?:Sync)?\s*$/;
const HARDENED_ENV = /\b(?:gitSpawnEnv|hardenedGitEnv)\s*\(/;
const HARDENED_ARGV_CALLEE = /\bhardenedGitArgv\s*$/;
/** What follows `["git",`: a status / diff verb, or a spread whose verb is unknown. */
const NEEDS_ARGV_HARDENING = /^\s*(?:(["'])(?:status|diff)\1|\.\.\.)/;
/** A first argument that is an array literal headed by a string literal. */
const ARRAY_LITERAL_HEAD = /^\s*\[\s*["']/;
const NON_LITERAL_WHY =
  "spawn argv is not a literal: pass env: gitSpawnEnv(...) or mark // nax-git-env-allow: <reason>";

export interface GitSpawnViolation {
  line: number;
  text: string;
  why: string;
}

/**
 * Two same-length views of `source`: `code` has comments blanked, `shape` also
 * blanks string/template contents so brackets inside them cannot unbalance a
 * scan. Newlines survive in both, so offsets map to the same line.
 */
function mask(source: string): { code: string; shape: string } {
  const code = source.split("");
  const shape = source.split("");
  let i = 0;
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(code, i, stop);
      blank(shape, i, stop);
      i = stop;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(code, i, stop);
      blank(shape, i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      blank(shape, i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return { code: code.join(""), shape: shape.join("") };
}

const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function prevNonSpace(text: string, before: number): string {
  let k = before - 1;
  while (k >= 0 && /\s/.test(text[k] as string)) k--;
  return k >= 0 ? (text[k] as string) : "";
}

/** Offset of the `(` of the call enclosing `at`, or -1 when a statement boundary comes first. */
function enclosingCallOpen(shape: string, at: number): number {
  const stack: string[] = [];
  for (let k = at - 1; k >= 0; k--) {
    const c = shape[k] as string;
    if (c in OPEN) stack.push(OPEN[c] as string);
    else if (c === "(" || c === "[" || c === "{") {
      if (stack.length > 0) stack.pop();
      else if (c === "(") return k;
      // An object literal in argument position (`spawn({ cmd: [...] })`) is
      // crossed; any other open brace (a block, `= {`) ends the expression.
      else if (c === "{" && !"(,:[".includes(prevNonSpace(shape, k))) return -1;
    } else if (c === ";" && stack.length === 0) return -1;
  }
  return -1;
}

function matchingClose(shape: string, open: number): number {
  let depth = 0;
  for (let k = open; k < shape.length; k++) {
    if (shape[k] === "(") depth++;
    else if (shape[k] === ")" && --depth === 0) return k;
  }
  return shape.length;
}

/** The call's first argument as a `shape` slice (string contents blanked). */
function firstArgSlice(shape: string, open: number, close: number): string {
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const c = shape[k] as string;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return shape.slice(open + 1, k);
  }
  return shape.slice(open + 1, close);
}

export function findGitSpawnViolations(source: string): GitSpawnViolation[] {
  const { code, shape } = mask(source);
  const lines = source.split("\n");
  const violations: GitSpawnViolation[] = [];
  for (const m of code.matchAll(GIT_ARGV)) {
    const at = m.index ?? 0;
    const line = code.slice(0, at).split("\n").length;
    if (ALLOW_MARKER.test(lines[line - 1] ?? "") || ALLOW_MARKER.test(lines[line - 2] ?? "")) continue;
    const text = (lines[line - 1] ?? "").trim();
    let open = enclosingCallOpen(shape, at);
    let argvHardened = false;
    // A grouping paren (`[...(override ?? ["git", ...args])]`) is not a call, and
    // `hardenedGitArgv(...)` returns the argv it wraps: climb past both.
    for (;;) {
      if (open === -1) break;
      if (HARDENED_ARGV_CALLEE.test(code.slice(Math.max(0, open - 40), open))) argvHardened = true;
      else if (/[\w$]/.test(prevNonSpace(shape, open))) break;
      open = enclosingCallOpen(shape, open);
    }
    if (open === -1 || !SPAWN_CALLEE.test(code.slice(Math.max(0, open - 40), open))) {
      violations.push({
        line,
        text,
        why: "git argv not passed straight to spawn(...) — spawn it inline, or mark the runner",
      });
      continue;
    }
    if (!HARDENED_ENV.test(code.slice(open, matchingClose(shape, open) + 1))) {
      violations.push({ line, text, why: "git spawn without env: gitSpawnEnv(...)" });
    }
    if (!argvHardened && NEEDS_ARGV_HARDENING.test(code.slice(at + m[0].length))) {
      violations.push({ line, text, why: "git status/diff argv not wrapped in hardenedGitArgv(...)" });
    }
  }
  // US-003: a spawn whose argv is not a literal array headed by a string literal
  // is invisible to the `["git", ...]` rule, so flag the call site itself.
  for (let open = 0; open < shape.length; open++) {
    if (shape[open] !== "(") continue;
    if (!SPAWN_CALLEE.test(shape.slice(Math.max(0, open - 40), open))) continue;
    const close = matchingClose(shape, open);
    const line = shape.slice(0, open).split("\n").length;
    if (ALLOW_MARKER.test(lines[line - 1] ?? "") || ALLOW_MARKER.test(lines[line - 2] ?? "")) continue;
    if (HARDENED_ENV.test(code.slice(open + 1, close))) continue;
    if (ARRAY_LITERAL_HEAD.test(firstArgSlice(shape, open, close))) continue;
    violations.push({ line, text: (lines[line - 1] ?? "").trim(), why: NON_LITERAL_WHY });
  }
  return violations;
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
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) yield full;
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const found: string[] = [];
  for await (const file of walk(join(root, "src"))) {
    for (const v of findGitSpawnViolations(await readFile(file, "utf8"))) {
      found.push(`  ${relative(root, file)}:${v.line}  ${v.text}  (${v.why})`);
    }
  }
  if (found.length > 0) {
    console.error("git spawned without the hardened environment (src/utils/git-env.ts):");
    for (const f of found) console.error(f);
    console.error(
      "Pass `env: gitSpawnEnv(overlay?)` and wrap a status/diff argv in `hardenedGitArgv(...)`, or mark `// nax-git-env-allow: <reason>`.",
    );
    process.exit(1);
  }
  console.log("check-git-spawn-env: clean");
}
