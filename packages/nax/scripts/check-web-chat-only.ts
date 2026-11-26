#!/usr/bin/env bun
/**
 * CI gate: the web tool factories are `nax chat`'s alone.
 *
 * `createWebToolProvider`, `createWebExposureGuard`, `createWebExposure` and `createSearchBackend`
 * are the four pieces of a session that may read the web. They are only coherent together, and
 * only inside a chat session: the provider records what the session read into the exposure, the
 * guard decides what an exposed session may then do, and `openChatSession` is the one place that
 * persist that state, publishes it to the footer and hands the guard to chat subagents.
 *
 * A second import site is therefore a defect even when it compiles — a run, story, bot or workflow
 * session would construct a provider whose exposure nothing persists, whose guard nothing consults,
 * and whose network swap would be process-wide. So the factories are fenced to the one file that
 * wires a chat session: `src/chat/web/wiring.ts` (US-020).
 *
 * What counts as a violation: a named import (or re-export) of one of the four factories from
 * `@nathapp/nax-agent/internal`, anywhere under `src/` other than the wiring file. Multi-line
 * import lists and aliased imports match; a factory named only in a comment does not — comments are
 * stripped before scanning, so the prose in a dozen modules explaining what it deliberately does
 * not do stays legal.
 *
 * Takes an optional root so the gate can be run against a fixture tree:
 *
 *   bun scripts/check-web-chat-only.ts [root]     # root defaults to the current package
 *
 * Exit codes: 0 clean, 1 a violation or no `src/` under the root (a root that scans nothing must
 * not read as clean).
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The one file allowed to import the web factories. Repo-relative, POSIX separators. */
export const ALLOWED_WEB_FILE = "src/chat/web/wiring.ts";

/** The factories fenced to `ALLOWED_WEB_FILE`, as they are named in the import clause. */
export const WEB_FACTORY_NAMES = [
  "createWebExposure",
  "createSearchBackend",
  "createWebToolProvider",
  "createWebExposureGuard",
] as const;

/**
 * The entry the factories come from. A deeper path under it is matched too: `internal/web` would
 * otherwise be an unguarded way to reach the same barrel.
 */
const INTERNAL_ENTRY = String.raw`@nathapp\/nax-agent\/internal(?:\/[^"']*)?`;

/**
 * One `import … from "@nathapp/nax-agent/internal"` or `export … from` statement, with its clause
 * in group 1. The clause may span lines (a formatted named-import list) but never a `;`, so a match
 * cannot run past the end of its own statement into the next import. The lookbehind keeps a match
 * from starting inside a longer identifier.
 */
const INTERNAL_IMPORT_RE = new RegExp(
  String.raw`(?<![\w$.])(?:import|export)\s+(?:type\s+)?([^;]*?)\s*from\s*["']${INTERNAL_ENTRY}["']`,
  "g",
);

/** Any of the four factory names, on word boundaries so `createWebExposureGuard` is not read as `createWebExposure`. */
const FACTORY_NAME_RE = new RegExp(String.raw`\b(?:${WEB_FACTORY_NAMES.join("|")})\b`, "g");

/** One file importing a fenced factory, with the names it takes and where the statement starts. */
export interface WebChatOnlyViolation {
  /** Repo-relative, POSIX separators — the frame the violation is reported in. */
  readonly file: string;
  /** 1-based line of the import statement's `import`/`export` keyword. */
  readonly line: number;
  /** The fenced factory names this statement imports. */
  readonly names: readonly string[];
}

/** Everything the caller needs to report: the exit code, and the text that names the problem. */
export interface WebChatOnlyGateResult {
  readonly exitCode: 0 | 1;
  readonly report: string;
}

/**
 * One scan of a tree: what it found, and what it could not read.
 *
 * `unreadable` is a first-class result rather than a swallowed error: a directory or file the scan
 * could not open leaves part of `src/` unchecked, and an incomplete scan must never be reported as
 * a clean tree (F1). Any entry here fails the gate exactly as a violation does.
 */
export interface WebChatOnlyScan {
  readonly violations: readonly WebChatOnlyViolation[];
  /** Repo-relative paths the walk could not read, in discovery order. */
  readonly unreadable: readonly string[];
}

/** True for the three characters that open a literal whose contents are not code. */
function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/**
 * The offset just past the string or template literal that starts at `start`.
 *
 * Only a template literal may span lines, so a `"` or `'` that never closes on its own line is not
 * treated as a literal at all: the scan resumes one character later. That keeps a regex literal
 * holding a quote (`/["']/`) from swallowing the rest of a line — and, worse, the next import.
 */
function literalEnd(source: string, start: number): number {
  const quote = source[start];
  const newline = source.indexOf("\n", start);
  const limit = quote === "`" || newline === -1 ? source.length : newline;
  let i = start + 1;
  while (i < limit) {
    // An escaped character is consumed with its backslash, so `\"` does not close the literal.
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return quote === "`" ? source.length : start + 1;
}

/** The offset just past the comment that starts at `start` — a line comment ends before its newline. */
function commentEnd(source: string, start: number): number {
  if (source[start + 1] === "/") {
    const newline = source.indexOf("\n", start);
    return newline === -1 ? source.length : newline;
  }
  const close = source.indexOf("*/", start + 2);
  return close === -1 ? source.length : close + 2;
}

/** Blank out `[from, to)`, keeping newlines so the caller's line numbers stay valid. */
function blankRange(chars: string[], from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i++) {
    if (chars[i] !== "\n") chars[i] = " ";
  }
}

/**
 * The source with every comment blanked out, byte count and newlines preserved.
 *
 * Blanking rather than deleting keeps line numbers valid for the caller's report. String and
 * template literals are copied verbatim, so a `//` inside one (a URL, a glob) does not start a
 * comment — the only comments this has to find are the ones around code.
 */
function withoutComments(source: string): string {
  const chars = source.split("");
  let i = 0;
  while (i < source.length) {
    if (isQuote(source[i])) {
      i = literalEnd(source, i);
    } else if (source[i] === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const end = commentEnd(source, i);
      blankRange(chars, i, end);
      i = end;
    } else {
      i++;
    }
  }
  return chars.join("");
}

/** The 1-based line of a character offset. */
function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * The violation in one file's source, or `null` — the scan without the walk, so a single file can
 * be inspected directly.
 */
export function scanFileForWebFactories(relFile: string, source: string): WebChatOnlyViolation | null {
  if (relFile === ALLOWED_WEB_FILE) return null;
  const stripped = withoutComments(source);
  let first: { line: number; names: string[] } | null = null;
  for (const match of stripped.matchAll(INTERNAL_IMPORT_RE)) {
    const clause = match[1] ?? "";
    const names = [...new Set([...clause.matchAll(FACTORY_NAME_RE)].map((name) => name[0]))];
    if (names.length === 0) continue;
    // One entry per file, at its first offending statement: the remedy is per file, not per line.
    first ??= { line: lineAt(stripped, match.index ?? 0), names };
  }
  return first === null ? null : { file: relFile, line: first.line, names: first.names };
}

/**
 * Every `.ts`/`.tsx` file under `dir`, skipping dependencies, build output and symlinks (following
 * one could walk out of the tree being checked).
 *
 * A directory that cannot be listed is pushed onto `unreadable` and the walk continues: the gate
 * reports the gap and fails, while still naming every violation it did see (F1).
 */
function* walk(root: string, dir: string, unreadable: string[]): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    unreadable.push(posixRelative(root, dir));
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      yield* walk(root, full, unreadable);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield full;
    }
  }
}

/** A path in the frame the gate reports in: repo-relative, POSIX separators. */
function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** True when `root` holds the `src/` tree this gate scans. */
function hasSourceRoot(root: string): boolean {
  return statSync(join(root, "src"), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** One file's source, or `null` when it cannot be read (recorded, so the scan cannot pass). */
function readSource(root: string, file: string, unreadable: string[]): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    unreadable.push(posixRelative(root, file));
    return null;
  }
}

/**
 * Scan `root`'s `src/` for imports of a fenced factory, and record every path the scan could not
 * read. Violations come back in path order; `unreadable` is empty for a complete scan.
 */
export function scanWebChatBoundary(root: string): WebChatOnlyScan {
  if (!hasSourceRoot(root)) return { violations: [], unreadable: [] };
  const unreadable: string[] = [];
  const violations: WebChatOnlyViolation[] = [];
  for (const file of walk(root, join(root, "src"), unreadable)) {
    const relFile = posixRelative(root, file);
    const source = readSource(root, file, unreadable);
    if (source === null) continue;
    const violation = scanFileForWebFactories(relFile, source);
    if (violation !== null) violations.push(violation);
  }
  return {
    violations: violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    unreadable,
  };
}

/** Every file under `root`'s `src/` that imports a fenced web factory, in path order. */
export function findWebChatOnlyViolations(root: string): WebChatOnlyViolation[] {
  return [...scanWebChatBoundary(root).violations];
}

/**
 * The text a failing gate prints: what could not be read, then every offending statement. A clean
 * tree gets one line, so the gate is quiet in a passing pipeline and specific in a failing one.
 */
export function formatWebChatOnlyReport(scan: WebChatOnlyScan): string {
  const lines: string[] = [];
  if (scan.unreadable.length > 0) {
    lines.push(
      `[FAIL] ${scan.unreadable.length} path(s) under src/ could not be read, so this scan is incomplete:`,
      "an unchecked file is not a clean file. Fix the permissions and re-run.",
      "",
      ...scan.unreadable.map((path) => `  ${path}  (unreadable)`),
      "",
    );
  }
  if (scan.violations.length > 0) {
    lines.push(
      `[FAIL] ${scan.violations.length} file(s) import a chat-only web factory from @nathapp/nax-agent/internal.`,
      `${ALLOWED_WEB_FILE} is the only permitted import site: every other session`,
      "(nax run, story, bot, workflow, subagent) opens without these tools and without the",
      "exposure state they record into. Call createChatWeb from the chat session instead.",
      "",
      ...scan.violations.map((violation) => `  ${violation.file}:${violation.line}  ${violation.names.join(", ")}`),
    );
  }
  return lines.length === 0 ? `[OK] the web factories are imported by ${ALLOWED_WEB_FILE} only` : lines.join("\n");
}

/**
 * The gate itself: scan `root`, and say what a caller should print and exit with. Kept free of
 * `process.exit` so the fixture-root ACs can assert the outcome instead of a process's fate.
 */
export function runWebChatOnlyGate(root: string): WebChatOnlyGateResult {
  if (!hasSourceRoot(root)) {
    return {
      exitCode: 1,
      report: `[FAIL] no src/ directory under ${root}: the web-factory scan would check nothing.`,
    };
  }
  const scan = scanWebChatBoundary(root);
  const complete = scan.unreadable.length === 0 && scan.violations.length === 0;
  return { exitCode: complete ? 0 : 1, report: formatWebChatOnlyReport(scan) };
}

/** CLI entry: the root from argv, else the current package. */
function main(): void {
  const { exitCode, report } = runWebChatOnlyGate(process.argv[2] ?? process.cwd());
  if (exitCode === 0) {
    console.log(report);
    return;
  }
  console.error(report);
  process.exit(1);
}

if (import.meta.main) {
  main();
}
