#!/usr/bin/env bun
/**
 * Guard: per-package config resolution must inherit the run's --profile chain.
 *
 * `loadConfigForWorkdir(rootConfigPath, packageDir, cliOverrides?)` takes its CLI
 * overrides LAST and OPTIONAL, so omitting them is silent. A config resolved that
 * way carries no profile layer. That is invisible while it only feeds data fields
 * (`acceptance.command`, `project.testFramework`) and fatal once it is handed to
 * `callOp` as `ctx.config`: the model map normally lives in the profile, so every
 * dispatch throws `No model entry found for agent ... at tier ...` (nax#2126).
 *
 * Rule: outside `src/config/`, every CALL to `loadConfigForWorkdir` passes all
 * three arguments. Prefer `loadConfigForPackage(projectDir, packageDir, from)`,
 * whose required `from` makes the omission unrepresentable.
 *
 * A call that genuinely wants the profile-less root config takes an inline
 * `// nax-profile-threading-allow: <reason>` on the line above.
 *
 * Comments and string/template literals are blanked before scanning, so prose
 * mentioning the function never counts. Local aliases (`import { x as y }`) are
 * resolved per file, so renaming the import does not evade the gate.
 *
 * Usage: bun run scripts/check-config-profile-threading.ts [rootDir]
 * `rootDir` exists so the test suite can point it at a fixture tree.
 */

import { join, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
const SCAN_DIRS = ["src", "bin", "scripts"];
/** The config module owns the primitive and the helper that wraps it. */
const EXEMPT_PREFIXES = ["src/config/"];
const FN = "loadConfigForWorkdir";
const ALLOW_MARKER = "nax-profile-threading-allow";
const REQUIRED_ARGS = 3;

interface Violation {
  file: string;
  line: number;
  argCount: number;
  callee: string;
  snippet: string;
}

/**
 * Blank out comments and string/template literals, preserving length and newlines
 * so every index and line number still lines up with the original text.
 */
export function blankNonCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j++;
      }
      blank(i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * Local names that resolve to the guarded function in this file: the import's own
 * binding (aliased or not), plus the bare name, which also covers property access
 * on a `_deps` object (`_someDeps.loadConfigForWorkdir(...)`) — a property name
 * cannot be aliased at the call site.
 */
export function calleeNames(code: string): string[] {
  const names = new Set<string>([FN]);
  const re = new RegExp(`\\b${FN}\\s+as\\s+(\\w+)`, "g");
  for (let m = re.exec(code); m !== null; m = re.exec(code)) names.add(m[1]);
  return [...names];
}

/** Argument list of the call whose "(" sits at `openIdx`, or null if unbalanced. */
function readArgs(code: string, openIdx: number): { args: string; closeIdx: number } | null {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: code.slice(openIdx + 1, i), closeIdx: i };
    }
  }
  return null;
}

/**
 * Top-level argument count. Commas nested in parens/brackets/braces/generics do
 * not split, and a trailing comma does not add a phantom argument.
 */
export function countArgs(args: string): number {
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of args) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((p) => p.trim() !== "").length;
}

/**
 * A signature, not a call: a parameter list is followed by its return type, so the
 * first non-space character after the closing paren is ":". Deciding from the
 * ARGUMENT text instead is what an earlier revision did, and any real call
 * carrying an inline annotation (`(x as { workdir: string }).workdir`) then read
 * as a declaration and was skipped.
 */
function isSignature(code: string, closeIdx: number): boolean {
  for (let i = closeIdx + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    return ch === ":";
  }
  return false;
}

export function findViolations(rel: string, text: string): Violation[] {
  const code = blankNonCode(text);
  if (!code.includes(FN) && !/\bloadConfigForWorkdir\b/.test(code)) return [];
  const lines = text.split("\n");
  const codeLines = code.split("\n");
  const lineOf = (idx: number): number => code.slice(0, idx).split("\n").length;

  const out: Violation[] = [];
  for (const callee of calleeNames(code)) {
    // Require a call position: not part of a longer identifier, and not the
    // `as`-binding itself.
    const re = new RegExp(`(?<![\\w$.])(?:[\\w$]+\\s*\\.\\s*)?${callee}\\s*\\(`, "g");
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const openIdx = m.index + m[0].length - 1;
      const read = readArgs(code, openIdx);
      if (read === null || isSignature(code, read.closeIdx)) continue;
      const count = countArgs(read.args);
      if (count >= REQUIRED_ARGS) continue;
      const line = lineOf(m.index);
      // The marker may sit on the call's own line or the line above it; biome
      // reflows long calls, so both positions have to count.
      if ((codeLines[line - 1] ?? "").includes(ALLOW_MARKER)) continue;
      if ((lines[line - 1] ?? "").includes(ALLOW_MARKER)) continue;
      if ((lines[line - 2] ?? "").includes(ALLOW_MARKER)) continue;
      out.push({ file: rel, line, argCount: count, callee, snippet: (lines[line - 1] ?? "").trim() });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export async function scan(root = ROOT): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    const glob = new Glob("**/*.ts");
    let entries: string[];
    try {
      entries = await Array.fromAsync(glob.scan({ cwd: join(root, dir), absolute: false }));
    } catch {
      continue; // Directory absent (fixture trees need not have all three).
    }
    for (const file of entries) {
      const rel = `${dir}/${file}`;
      if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p)) || rel.endsWith(".d.ts")) continue;
      out.push(...findViolations(rel, await Bun.file(join(root, rel)).text()));
    }
  }
  return out;
}

if (import.meta.main) {
  const violations = await scan();
  if (violations.length > 0) {
    console.error(`ERROR: ${FN} called without its cliOverrides argument:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} (${v.argCount} of ${REQUIRED_ARGS} args, via "${v.callee}")`);
      console.error(`    ${v.snippet}`);
    }
    console.error(
      [
        "",
        "A config resolved without the run's --profile chain has no profile layer.",
        "Handed to callOp as ctx.config it loses `models.<agent>` and dispatch fails",
        "with MODEL_NOT_FOUND (nax#2126).",
        "",
        "Use loadConfigForPackage(projectDir, packageDir, from) from @/config, or pass",
        `profileOverrideFromConfig(<run config>) as ${FN}'s third argument.`,
        `A deliberate profile-less read takes // ${ALLOW_MARKER}: <reason> on or above the line.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`OK: ${FN} profile-threading guard passed.`);
}
