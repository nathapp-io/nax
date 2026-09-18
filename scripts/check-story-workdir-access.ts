#!/usr/bin/env bun

/**
 * Fails if a story's `workdir` field is read directly.
 *
 * Read it through src/utils/path-frame.ts instead:
 *   storyWorkdir(story)          -> string, "." at the repo root
 *   storyPackageDir(story)       -> string | undefined, undefined at the root
 *   storyAbsWorkdir(root, story) -> absolute working directory
 *   isWithinPackage(path, workdir) -> boolean, is a repo-rooted path inside that package
 *
 * Why the rule and not a set of patches (nax#2067, nax#2084): 19 raw reads
 * across 10 files used THREE different spellings of "absent" -- `?? ""`,
 * `|| undefined` and `? :` truthiness -- and `workdir` is now always a
 * string where "." means the repo root. Patching the known sites leaves the
 * next author free to add a fourth.
 *
 * ## v4 (path-frame follow-up, this file)
 *
 * v3 keyed the STORY_TYPES check on the receiver's RENDERED type string
 * (`typeToString(...)` compared against a literal name list). That is
 * invisible to anything that does not print back exactly as `UserStory` or
 * `StoryWorkdirLike`: `Readonly<UserStory>`, `Pick<UserStory, "workdir">`,
 * `interface X extends UserStory`, an intersection, a union of two
 * story-shaped types, and a destructuring ASSIGNMENT (`({ workdir } = s)`,
 * which v3's binder never even visited -- it only handled the
 * `BindingElement` shape, not the `ShorthandPropertyAssignment` /
 * `PropertyAssignment` a destructuring assignment target actually parses as).
 *
 * v4 drops the name/string proxy and asks the real checker two structural
 * questions instead:
 *   1. Does the receiver's (non-nullable) type have a `workdir` property at
 *      all (`Checker.getPropertyOfType`)?
 *   2. Does that property SYMBOL's declaration live in one of the two files
 *      that declare the field (`src/prd/types.ts` for `UserStory`,
 *      `src/utils/path-frame.ts` for `StoryWorkdirLike`)?
 *
 * Verified empirically against the real checker: `getPropertyOfType` walks
 * through `Readonly<T>`, `Pick<T, K>`, `interface extends`, and intersections
 * to the SAME underlying declaration node as a plain `UserStory` receiver --
 * these are exactly the shapes that only differ from a plain `UserStory` in
 * how they PRINT, not in where the property resolves to. A union of two
 * story-shaped types yields a property whose `.declarations` includes both
 * constituents' declaration sites, so it is caught too. A same-shaped local
 * object type (`{ workdir: string }`, the standing false-positive control)
 * resolves its OWN `workdir` declaration to the fixture file itself, not to
 * either canonical file, and is correctly not flagged. Nullability is
 * stripped with `Checker.getNonNullableType` before the property lookup --
 * safe here (unlike the display-string strip it replaces) because every
 * fixture in this file's suite uses REAL imported types, which do not hit
 * the unresolved-type error-recovery collapse that made the string strip
 * necessary in the first place.
 *
 * The walker also now covers destructuring ASSIGNMENT (`({ workdir } = s)`
 * and its renamed form `({ workdir: w } = s)`, both `ShorthandPropertyAssignment`
 * / `PropertyAssignment` nodes inside an `ObjectLiteralExpression` used as a
 * `BinaryExpression`'s assignment target -- not `BindingElement` at all),
 * function-parameter and nested destructuring (unified with the plain
 * `const { workdir } = story` case: for ANY `BindingElement`, the receiver
 * type is `Checker.getTypeAtLocation` on the ENCLOSING BINDING PATTERN node
 * itself, which resolves correctly whether that pattern's owner is a
 * `VariableDeclaration`, a `Parameter`, an arrow function parameter, or a
 * `ForOfStatement` -- one rule, not the four ad hoc receiver-walk branches
 * v3 had, one of which (`ForOfStatement`) was dead code because the walk
 * never reached it), a computed element-access key that resolves to a
 * `"workdir"` string LITERAL TYPE (`const K = "workdir" as const; s[K]`),
 * and a `` `workdir` `` no-substitution template key.
 *
 * The inline `// workdir-access-allow: <reason>` escape hatch is now
 * resolved from the candidate's ENCLOSING STATEMENT's real leading/trailing
 * comment TRIVIA (`getLeadingCommentRanges` / `getTrailingCommentRanges` from
 * `typescript/unstable/ast/scanner` -- the same primitives the compiler's
 * own emitter uses to attach comments to nodes), not by testing a regex
 * against raw source lines. That closes two spoofs the line-text version
 * had: text that merely LOOKS like the marker inside a string literal (never
 * a comment trivia range, so never matched) and a comment that is textually
 * "the line above" but is actually attached to a DIFFERENT, unrelated
 * statement (trivia is bound to the specific statement node, not a line
 * number). An empty reason (`// workdir-access-allow:` with nothing after
 * the colon) no longer suppresses anything; a marker whose statement turns
 * out not to be a real story-typed read is reported as a STALE MARKER,
 * mirroring the staleness check `EXEMPT` already had.
 *
 * A file on disk under a scanned directory that the tsconfig's Program does
 * not contain (e.g. a `.tsx` file under a dir whose tsconfig `include` only
 * lists `.ts`) is now a hard error naming the file, not a silent skip -- the
 * fail-open this rewrite's v3 header claimed to have closed by relocating it
 * from the root check into `findViolations` instead of removing it.
 *
 * `src/` is now a REQUIRED scan directory: a root with no `src/` at all used
 * to print "clean" (`assertRootReadable` only `stat`s the root itself). Other
 * `SCAN_DIRS` entries (`bin/`, `scripts/`) stay optional -- a fixture root
 * legitimately has neither.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 * Fails CLOSED: an unreadable or missing root, a missing `src/`, or a file
 * the Program cannot see is a hard error (exit 1), never a silent "clean".
 */

import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { getLeadingCommentRanges, getTrailingCommentRanges } from "typescript/unstable/ast/scanner";
import type { Project } from "typescript/unstable/async";
import { API } from "typescript/unstable/async";

const ROOT = resolve(process.argv[2] ?? process.cwd());

/** Each entry maps a scanned top-level directory to the tsconfig whose Program contains it. */
const SCAN_DIRS = [
  { dir: "src", tsconfig: "tsconfig.json", required: true },
  { dir: "bin", tsconfig: "tsconfig.json", required: false },
  { dir: "scripts", tsconfig: "tsconfig.test.json", required: false },
] as const;

const SCAN_EXTENSIONS = [".ts", ".tsx"] as const;

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
 * The two files that DECLARE a `workdir?: string` field: `UserStory`
 * (src/prd/types.ts) and its structural alias `StoryWorkdirLike`
 * (src/utils/path-frame.ts). A candidate is a violation iff the property
 * SYMBOL the checker resolves for its `.workdir` access has a declaration
 * in one of these files -- not iff the receiver's rendered type NAME
 * matches a literal list (see the v4 header comment for why that is a
 * strictly weaker check).
 */
const DECLARATION_FILE_PATHS: ReadonlySet<string> = new Set([
  resolve(ROOT, "src", "prd", "types.ts"),
  resolve(ROOT, "src", "utils", "path-frame.ts"),
]);

/** Inline escape hatch for a legitimate accessor site outside `ALLOWED`. Requires a non-empty reason. */
const ALLOW_MARKER_RE = /workdir-access-allow:\s*(.*)/;

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

// The remote AST node shape is not exported as a public type by
// typescript/unstable/ast (RemoteNode is internal); every access below is
// guarded by a SyntaxKind check first, which is the real type discriminant.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type AstNode = any;

/** A candidate read: the node to report, and the node whose TYPE decides it. */
interface CandidateHit {
  readonly reportNode: AstNode;
  /** Expression (property/element access receiver, destructuring-assignment RHS) or binding-pattern node. */
  readonly typeSite: AstNode;
  readonly nameNode: AstNode;
  /** True only for a computed element-access key (`s[K]`) whose literal-ness needs a checker round trip. */
  readonly nameNeedsTypeCheck: boolean;
}

/**
 * Resolve a position to a 1-based line number using the source text.
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
 * True when `node` names "workdir" as a plain identifier, a string literal,
 * or a no-substitution template literal (covers `.workdir`, `["workdir"]`
 * and `` [`workdir`] `` name positions).
 */
function isWorkdirName(node: AstNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.kind === SyntaxKind.Identifier) return node.text === "workdir";
  if (node.kind === SyntaxKind.StringLiteral) return node.text === "workdir";
  if (node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) return node.text === "workdir";
  return false;
}

/**
 * Walk the file's real AST for every shape a `.workdir` read can take:
 *   - property access:        EXPR (. | ?.) workdir
 *   - element access:         EXPR [ "workdir" | `workdir` | computed const ]
 *   - binding element:        { workdir } from a VariableDeclaration,
 *     Parameter, arrow Parameter, ForOfStatement, or nested pattern owner --
 *     one rule, since the receiver type is `getTypeAtLocation` on the
 *     ENCLOSING PATTERN NODE itself in every case
 *   - destructuring ASSIGNMENT: ({ workdir } = EXPR) / ({ workdir: w } = EXPR)
 *
 * Each candidate carries the node whose TYPE the caller resolves via the
 * real checker, never a syntactic proxy for it.
 */
function collectCandidates(sourceFile: AstNode): CandidateHit[] {
  const hits: CandidateHit[] = [];

  function walk(node: AstNode): void {
    if (node.kind === SyntaxKind.PropertyAccessExpression) {
      if (isWorkdirName(node.name)) {
        hits.push({ reportNode: node, typeSite: node.expression, nameNode: node.name, nameNeedsTypeCheck: false });
      }
    } else if (node.kind === SyntaxKind.ElementAccessExpression) {
      const arg = node.argumentExpression;
      if (arg?.kind === SyntaxKind.StringLiteral || arg?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
        if (isWorkdirName(arg)) {
          hits.push({ reportNode: node, typeSite: node.expression, nameNode: arg, nameNeedsTypeCheck: false });
        }
      } else if (arg?.kind === SyntaxKind.Identifier) {
        // Could be a `const K = "workdir" as const` literal-typed key -- confirmed
        // via the checker at resolution time, not here (M1).
        hits.push({ reportNode: node, typeSite: node.expression, nameNode: arg, nameNeedsTypeCheck: true });
      }
    } else if (node.kind === SyntaxKind.BindingElement) {
      const nameNode = node.propertyName ?? node.name;
      if (isWorkdirName(nameNode)) {
        hits.push({ reportNode: node, typeSite: node.parent, nameNode, nameNeedsTypeCheck: false });
      }
    } else if (
      (node.kind === SyntaxKind.ShorthandPropertyAssignment || node.kind === SyntaxKind.PropertyAssignment) &&
      isWorkdirName(node.name)
    ) {
      const objLit = node.parent;
      const bin = objLit?.parent;
      if (
        objLit?.kind === SyntaxKind.ObjectLiteralExpression &&
        bin?.kind === SyntaxKind.BinaryExpression &&
        bin.left === objLit &&
        bin.operatorToken?.kind === SyntaxKind.EqualsToken
      ) {
        hits.push({ reportNode: node, typeSite: bin.right, nameNode: node.name, nameNeedsTypeCheck: false });
      }
    }
    node.forEachChild(walk);
  }

  walk(sourceFile);
  return hits;
}

/**
 * Walk up from `node` to the nearest ancestor that is itself an element of
 * some parent's `.statements` array -- the unit comment trivia attaches to.
 */
function enclosingStatement(node: AstNode): AstNode {
  let cur = node;
  while (cur.parent !== undefined) {
    const parent = cur.parent;
    const statements = parent.statements;
    if (Array.isArray(statements) && statements.includes(cur)) return cur;
    cur = parent;
  }
  return cur;
}

/** The non-empty reason on an inline marker line, or undefined if absent/empty. */
function markerReason(commentText: string): string | undefined {
  for (const line of commentText.split("\n")) {
    const match = ALLOW_MARKER_RE.exec(line);
    if (match !== null) {
      const reason = (match[1] ?? "").trim();
      if (reason.length > 0) return reason;
    }
  }
  return undefined;
}

/**
 * Whether `statement`'s own leading or trailing comment trivia carries a
 * valid (non-empty-reason) `workdir-access-allow:` marker.
 */
function statementMarker(source: string, statement: AstNode): string | undefined {
  const leading = getLeadingCommentRanges(source, statement.pos) ?? [];
  const trailing = getTrailingCommentRanges(source, statement.end) ?? [];
  for (const range of [...leading, ...trailing]) {
    const reason = markerReason(source.slice(range.pos, range.end));
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * The single public walker entry point.
 *
 * Resolves the REAL type of each candidate's type site via the project's
 * checker, and flags it iff the resolved `workdir` property's declaration
 * lives in one of `DECLARATION_FILE_PATHS`.
 */
export async function findViolations(project: Project, filePath: string, relPath: string): Promise<Violation[]> {
  const sourceFile = await project.program.getSourceFile(filePath);
  if (sourceFile === undefined) {
    throw new Error(
      `check-story-workdir-access: ${relPath} is on disk under a scanned directory but the TypeScript ` +
        "Program does not contain it -- check the tsconfig `include` globs for this extension/directory.",
    );
  }

  const source: string = sourceFile.text;
  const lines = source.split("\n");
  const lineStarts = computeLineStarts(source);
  const candidates = collectCandidates(sourceFile);

  const out: Violation[] = [];
  const seenViolationLines = new Set<number>();
  const seenStaleLines = new Set<number>();

  for (const hit of candidates) {
    if (hit.nameNeedsTypeCheck) {
      const nameType = await project.checker.getTypeAtLocation(hit.nameNode);
      if (nameType === undefined || !nameType.isStringLiteralType() || nameType.value !== "workdir") continue;
    }

    const line = posToLine(lineStarts, hit.reportNode.getStart());
    const statement = enclosingStatement(hit.reportNode);
    const reason = statementMarker(source, statement);

    const type = await project.checker.getTypeAtLocation(hit.typeSite);
    if (type === undefined) continue;
    const nonNullable = (await project.checker.getNonNullableType(type)) ?? type;
    const propSymbol = await project.checker.getPropertyOfType(nonNullable, "workdir");

    let isStoryRead = false;
    if (propSymbol !== undefined) {
      for (const decl of propSymbol.declarations) {
        const declNode = await decl.resolve(project);
        const declFile = (declNode as AstNode | undefined)?.getSourceFile?.()?.fileName;
        if (declFile !== undefined && DECLARATION_FILE_PATHS.has(resolve(declFile))) {
          isStoryRead = true;
          break;
        }
      }
    }

    if (!isStoryRead) {
      if (reason !== undefined && !seenStaleLines.has(line)) {
        seenStaleLines.add(line);
        out.push({
          file: relPath,
          line,
          text: `STALE MARKER (${reason}): no story-typed workdir read here -- remove the marker`,
        });
      }
      continue;
    }

    if (reason !== undefined) continue;
    if (seenViolationLines.has(line)) continue;
    seenViolationLines.add(line);
    out.push({ file: relPath, line, text: (lines[line - 1] ?? "").trim() });
  }

  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const { readdir } = await import("node:fs/promises");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT: a legitimately absent optional directory (e.g. a fixture root
    // with no bin/). Anything else -- EACCES, ELOOP, ... -- is a broken scan
    // and must fail the gate closed, not read as "nothing here".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) yield full;
  }
}

/**
 * Verify the scan root itself is readable. Distinct from a missing SCAN_DIRS
 * entry (tolerated, see `walk`): a missing or unreadable ROOT means the gate
 * was invoked against nothing, and printing "clean" for that is the exact
 * fail-open bug this rewrite closes (M3).
 */
async function assertRootReadable(root: string): Promise<void> {
  try {
    await stat(root);
  } catch (err) {
    throw new Error(`check-story-workdir-access: scan root is unreadable: ${root} (${(err as Error).message})`);
  }
}

/**
 * Verify every REQUIRED SCAN_DIRS entry exists. Unlike the ENOENT tolerance
 * in `walk` (for legitimately optional dirs like `bin/`), a root with no
 * `src/` at all is a broken scan root, not a clean tree with nothing in it
 * (M2).
 */
async function assertRequiredDirsExist(root: string): Promise<void> {
  for (const { dir, required } of SCAN_DIRS) {
    if (!required) continue;
    try {
      await stat(join(root, dir));
    } catch (err) {
      throw new Error(
        `check-story-workdir-access: required scan directory missing: ${join(root, dir)} (${(err as Error).message})`,
      );
    }
  }
}

/**
 * Scan the tree. Side effects live behind `import.meta.main` so the test can
 * import `findViolations` without the gate running -- and exiting -- on import.
 * Same guard as scripts/check-gate-reachability.ts:147.
 */
async function main(): Promise<void> {
  await assertRootReadable(ROOT);
  await assertRequiredDirsExist(ROOT);

  const api = new API({ cwd: ROOT });
  const tsconfigs = [...new Set(SCAN_DIRS.map((d) => d.tsconfig))];
  const snapshot = await api.updateSnapshot({ openProjects: [...tsconfigs] });

  const projectByConfig = new Map<string, Project>();
  for (const tsconfig of tsconfigs) {
    const project = snapshot.getProject(tsconfig);
    if (project === undefined) {
      await api.close();
      throw new Error(`check-story-workdir-access: failed to load project ${tsconfig}`);
    }
    projectByConfig.set(tsconfig, project);
  }

  const violations: Violation[] = [];
  const exemptionsUsed = new Set<string>();

  try {
    for (const { dir, tsconfig } of SCAN_DIRS) {
      const project = projectByConfig.get(tsconfig);
      if (project === undefined) continue;

      for await (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if ((ALLOWED as readonly string[]).includes(rel)) continue;

        const found = await findViolations(project, file, rel);
        if (found.length === 0) continue;

        if (EXEMPT.includes(rel)) {
          exemptionsUsed.add(rel);
          continue;
        }
        violations.push(...found);
      }
    }
  } finally {
    await api.close();
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
