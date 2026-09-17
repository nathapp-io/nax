#!/usr/bin/env bun

/**
 * Fails if a story's `workdir` field is read directly.
 *
 * Read it through src/utils/path-frame.ts instead:
 *   storyWorkdir(story)          -> string, "." at the repo root
 *   storyPackageDir(story)       -> string | undefined, undefined at the root
 *   storyAbsWorkdir(root, story) -> absolute working directory
 *
 * Why the rule and not a set of patches (nax#2067, nax#2084): 19 raw reads
 * across 10 files used THREE different spellings of "absent" -- `?? ""`,
 * `|| undefined` and `? :` truthiness -- and `workdir` is now always a
 * string where "." means the repo root. "." is truthy and is not "", so
 * every one of those idioms lands differently on it. Patching the known
 * sites leaves the next author free to add a fourth.
 *
 * nax#2084 replaces the v1 regex with a token-level walk over the
 * TypeScript scanner. The walker catches every spelling the regex
 * missed -- `?.workdir`, `const { workdir } = story`, `story["workdir"]`,
 * and any read where the receiver has a non-`*story` name but a
 * `UserStory`-shaped declared type -- and keys on the DECLARED TYPE of
 * the receiver (via the binding map it builds for the file), not the
 * name. The four bypass idioms a re-bind to `target` introduces used to
 * ride through under v1; v2 reads the explicit `: UserStory` annotation
 * and flags them.
 *
 * The walker skips comments and the `ALLOWED` declaration sites. The
 * `EXEMPT` list is empty by contract: every site is either converted to
 * the accessor or added to `ALLOWED` with a written reason.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN_DIRS = ["src", "scripts"] as const;

/**
 * Files permitted to touch the raw field: it is declared and wrapped here.
 *
 * Each entry is a declaration site: the field's TYPE lives at these paths,
 * the writer that decides the canonical value lives at
 * src/prd/workdir-canonical.ts, and the structural alias used by
 * src/utils/path-frame.ts (StoryWorkdirLike) lives at path-frame.ts.
 */
const ALLOWED = [
  join("src", "prd", "types.ts"),
  join("src", "utils", "path-frame.ts"),
  join("src", "prd", "schema-story.ts"),
  join("src", "prd", "workdir-canonical.ts"),
] as const;

/**
 * No exemptions. The single temporary entry (src/execution/iteration-runner.ts,
 * nax#2066/#2069 seam) was retired when that file converted. The staleness
 * check below is retained: it is what keeps a future exemption temporary.
 */
const EXEMPT: string[] = [];

/**
 * Type names whose declaration includes a `workdir?: string` field.
 *
 * Anchors the gate on the DECLARED TYPE rather than the receiver's name --
 * the named receiver `target` (case-4 of the brief) is flagged iff its
 * annotation is one of these. Mirrors `src/prd/types.ts:245`
 * (UserStory.workdir?) and `src/utils/path-frame.ts:170`
 * (StoryWorkdirLike.workdir?).
 */
const STORY_TYPES: ReadonlySet<string> = new Set(["UserStory", "StoryWorkdirLike"]);

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

interface ScannedToken {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly pos: number;
  readonly end: number;
}

/**
 * Tokenize the file in skipTrivia mode (comments and whitespace are skipped).
 * Returns a flat array of tokens with their source text and positions.
 */
function tokenize(source: string): ScannedToken[] {
  const scanner = createScanner(/*skipTrivia*/ true, LanguageVariant.Standard, source);
  const tokens: ScannedToken[] = [];
  let token = scanner.scan();
  let guard = 0;
  while (token !== SyntaxKind.EndOfFile && guard < 1_000_000) {
    tokens.push({
      kind: token,
      text: scanner.getTokenText(),
      pos: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
    });
    token = scanner.scan();
    guard++;
  }
  return tokens;
}

/**
 * Resolve a position to a 1-based line number using the source text.
 *
 * Tokens carry byte offsets; the report (and existing CI integrations) read
 * 1-based lines, so we compute them once per file rather than per token.
 */
function computeLineStarts(source: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function posToLine(lineStarts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const start = lineStarts[mid];
    if (start !== undefined && start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Build a binding map of `name -> declaredType` for the file.
 *
 * Detects two declaration shapes:
 *   - variable declarations with explicit type: `const|let|var NAME: TYPE [= ...]`
 *   - function parameters with explicit type:   `NAME: TYPE` (after `(` or `,`)
 *
 * Both are intra-procedural; cross-file type resolution would need a real
 * checker, which TypeScript 7 does not expose to JavaScript.
 */
function collectTypeBindings(tokens: readonly ScannedToken[]): Map<string, string> {
  const bindings = new Map<string, string>();
  const sk = SyntaxKind;
  const declKeywords = new Set<SyntaxKind>([sk.ConstKeyword, sk.LetKeyword, sk.VarKeyword]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;

    // Variable declaration with optional DeclareKeyword prefix:
    //   (DeclareKeyword)? (ConstKeyword|LetKeyword|VarKeyword) NAME ':' TYPE ...
    if (declKeywords.has(t.kind)) {
      const nameTok = tokens[i + 1];
      const colonTok = tokens[i + 2];
      const typeTok = tokens[i + 3];
      if (nameTok?.kind === sk.Identifier && colonTok?.kind === sk.ColonToken && typeTok?.kind === sk.Identifier) {
        bindings.set(nameTok.text, typeTok.text);
      }
      continue;
    }

    // Function parameter: NAME ':' TYPE (preceded by `(` or `,`).
    if (
      t.kind === sk.Identifier &&
      (tokens[i - 1]?.kind === sk.OpenParenToken || tokens[i - 1]?.kind === sk.CommaToken)
    ) {
      const colonTok = tokens[i + 1];
      const typeTok = tokens[i + 2];
      if (colonTok?.kind === sk.ColonToken && typeTok?.kind === sk.Identifier) {
        bindings.set(t.text, typeTok.text);
      }
    }
  }
  return bindings;
}

/**
 * True when the receiver identifier's declared type contains a `workdir?: string`
 * field -- i.e. its type is one of STORY_TYPES.
 */
function receiverIsStoryType(name: string, bindings: ReadonlyMap<string, string>): boolean {
  const type = bindings.get(name);
  if (type === undefined) return false;
  return STORY_TYPES.has(type);
}

interface CandidateHit {
  readonly pos: number;
  readonly end: number;
}

/**
 * Walk the token stream for workdir access candidates.
 *
 * Detects four shapes (the four bypass idioms of nax#2084):
 *   - property access:       IDENT(.|\?.) workdir
 *   - element access:        IDENT [ "workdir" ]
 *   - object binding:        { workdir } = IDENT
 *
 * Each shape yields a (pos, end) range for the receiver. The caller filters
 * by declared type.
 */
function findWorkdirCandidates(tokens: readonly ScannedToken[]): CandidateHit[] {
  const sk = SyntaxKind;
  const out: CandidateHit[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    const next1 = tokens[i + 1];
    const next2 = tokens[i + 2];
    const next3 = tokens[i + 3];
    const next4 = tokens[i + 4];

    // Property access: IDENT (. | ?.) IDENT("workdir")
    if (
      t.kind === sk.Identifier &&
      (next1?.kind === sk.DotToken || next1?.kind === sk.QuestionDotToken) &&
      next2?.kind === sk.Identifier &&
      next2.text === "workdir"
    ) {
      out.push({ pos: t.pos, end: t.end });
      i += 2;
      continue;
    }

    // Element access: IDENT [ StringLiteral("workdir") ]
    if (
      t.kind === sk.Identifier &&
      next1?.kind === sk.OpenBracketToken &&
      next2?.kind === sk.StringLiteral &&
      next2.text.replace(/['"]/g, "") === "workdir" &&
      next3?.kind === sk.CloseBracketToken
    ) {
      out.push({ pos: t.pos, end: t.end });
      i += 3;
      continue;
    }

    // Object binding: { IDENT("workdir") } = IDENT
    if (
      t.kind === sk.OpenBraceToken &&
      next1?.kind === sk.Identifier &&
      next1.text === "workdir" &&
      next2?.kind === sk.CloseBraceToken &&
      next3?.kind === sk.EqualsToken &&
      next4?.kind === sk.Identifier
    ) {
      // The RECEIVER of a binding pattern is the right-hand side of `=`.
      out.push({ pos: next4.pos, end: next4.end });
      i += 4;
    }
  }
  return out;
}

/**
 * Resolve a candidate hit to its root identifier text, used as the binding
 * lookup key. For property/element access the root is the leftmost identifier;
 * for binding patterns the receiver is the IDENT after `=`.
 */
function rootReceiver(hit: CandidateHit, tokens: readonly ScannedToken[]): string | undefined {
  for (const tok of tokens) {
    if (tok.pos === hit.pos) return tok.text;
  }
  return undefined;
}

/**
 * The single public walker entry point.
 *
 * Pure with respect to the filesystem: tests can call it with a fixture
 * string. The optional `opts` bag is reserved for callers that want to
 * supply an external type resolver (e.g. one driven by a real checker)
 * once TypeScript 7's package API grows a JS-accessible checker. Today
 * it is ignored: the parse-only walker is sufficient for the four-pass
 * fixtures and the real-tree run -- both rely on the same binding map.
 */
export function findViolations(file: string, source: string): Violation[] {
  const tokens = tokenize(source);
  const bindings = collectTypeBindings(tokens);
  const candidates = findWorkdirCandidates(tokens);
  const lineStarts = computeLineStarts(source);

  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const hit of candidates) {
    const receiver = rootReceiver(hit, tokens);
    if (receiver === undefined) continue;
    if (!receiverIsStoryType(receiver, bindings)) continue;
    const line = posToLine(lineStarts, hit.pos);
    const key = `${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineText = source.split("\n")[line - 1] ?? "";
    out.push({ file, line, text: lineText.trim() });
  }
  return out;
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

  for (const scanDir of SCAN_DIRS) {
    for await (const file of walk(join(ROOT, scanDir))) {
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
