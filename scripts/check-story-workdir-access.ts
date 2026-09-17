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
 * nax#2084 shipped a v2 built on a token-level scanner keyed on the
 * receiver's DECLARED-IN-FILE type annotation (a name -> annotation binding
 * map). It missed the dominant real idiom: member chains (`ctx.story.workdir`),
 * indexed access (`stories[0].workdir`), casts (`(s as UserStory).workdir`),
 * and any receiver whose type is INFERRED rather than explicitly annotated
 * in the same file. Its own header claimed cross-file/inferred type
 * resolution "would need a real checker, which TypeScript 7 does not expose
 * to JavaScript" -- that claim was false: the pinned `typescript@7.0.2`
 * exports `typescript/unstable/async`, an out-of-process API (spawns the
 * `tsgo` binary) with a real `Checker` (`getTypeAtLocation`,
 * `typeToString`, ...). This v3 walks the REAL AST (`typescript/unstable/ast`)
 * over the project's real `Program`/`Checker` and resolves the ACTUAL type
 * at each candidate site, not a per-file syntactic guess. That also fixes
 * three false positives the token scanner had no way to avoid: same-name
 * shadowing across scopes (the checker resolves per-position, not per-file),
 * a `/story.workdir/` regex literal (the real parser never sees an
 * identifier inside a regex literal), and a same-shaped local object type
 * with a `workdir` field that ISN'T a story (the checker's type is the
 * literal's OWN object type, e.g. `{ workdir: string }`, never `UserStory`).
 *
 * The walker skips comments (the AST has no comment nodes to visit) and the
 * `ALLOWED` declaration sites. A legitimate wrapper accessor -- code whose
 * whole purpose is reading `.workdir`, e.g. a second SSOT accessor -- takes
 * an inline `// workdir-access-allow: <reason>` marker on the access line or
 * the line directly above, rather than needing the whole file added to
 * `ALLOWED`. The `EXEMPT` list (path-level, silences every hit in a file) is
 * empty by contract: every site is either converted to the accessor,
 * marked with the inline marker, or added to `ALLOWED` with a written reason.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 * Fails CLOSED: an unreadable or missing root is a hard error (exit 1), not
 * a silent "clean". A missing SCAN_DIRS entry (e.g. a fixture root with no
 * `bin/`) is tolerated -- that is a legitimately absent optional directory,
 * not a broken scan root.
 */

import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/async";
import { API } from "typescript/unstable/async";

const ROOT = resolve(process.argv[2] ?? process.cwd());

/** Each entry maps a scanned top-level directory to the tsconfig whose Program contains it. */
const SCAN_DIRS = [
  { dir: "src", tsconfig: "tsconfig.json" },
  { dir: "bin", tsconfig: "tsconfig.json" },
  { dir: "scripts", tsconfig: "tsconfig.test.json" },
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
 * Type names whose declaration includes a `workdir?: string` field.
 *
 * Anchors the gate on the RESOLVED TYPE at the access site, not on any
 * syntactic proxy for it. Mirrors `src/prd/types.ts:245` (UserStory.workdir?)
 * and `src/utils/path-frame.ts:170` (StoryWorkdirLike.workdir?).
 */
const STORY_TYPES: ReadonlySet<string> = new Set(["UserStory", "StoryWorkdirLike"]);

/** Inline escape hatch for a legitimate accessor site outside `ALLOWED`. */
const ALLOW_MARKER = /workdir-access-allow:/;

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

/** A candidate read: the node whose text is reported, and the expression whose TYPE decides it. */
interface CandidateHit {
  readonly reportNode: AstNode;
  readonly receiverExpr: AstNode;
}

// The remote AST node shape is not exported as a public type by
// typescript/unstable/ast (RemoteNode is internal); every access below is
// guarded by a SyntaxKind check first, which is the real type discriminant.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type AstNode = any;

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
 * True when `node` names "workdir" as a plain identifier or a string literal
 * (covers both `.workdir` and `["workdir"]` name positions).
 */
function isWorkdirName(node: AstNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.kind === SyntaxKind.Identifier) return node.text === "workdir";
  if (node.kind === SyntaxKind.StringLiteral) return node.text === "workdir";
  return false;
}

/**
 * The receiver expression a destructured `{ workdir } = EXPR` binds against,
 * or `{ workdir } = EXPR` inside a `for (const { workdir } of EXPR)`. Returns
 * undefined for a shape with no single receiver expression to type-check
 * (e.g. a destructured function parameter -- no site of that shape exists in
 * this repo's `UserStory`/`StoryWorkdirLike` usage today).
 */
function bindingReceiver(bindingElement: AstNode): AstNode | undefined {
  const pattern = bindingElement.parent;
  const owner = pattern?.parent;
  if (owner === undefined) return undefined;
  if (owner.kind === SyntaxKind.VariableDeclaration && owner.initializer !== undefined) {
    return owner.initializer;
  }
  if (owner.kind === SyntaxKind.ForOfStatement && owner.expression !== undefined) {
    return owner.expression;
  }
  return undefined;
}

/**
 * Walk the file's real AST for the three shapes a `.workdir` read can take:
 *   - property access:   EXPR (. | ?.) workdir
 *   - element access:    EXPR [ "workdir" ]
 *   - object binding:    { workdir } = EXPR   (destructuring assignment/declaration)
 *
 * Each candidate carries the RECEIVER EXPRESSION node; the caller resolves
 * its type via the real checker rather than any syntactic proxy for it.
 */
function collectCandidates(sourceFile: AstNode): CandidateHit[] {
  const hits: CandidateHit[] = [];

  function walk(node: AstNode): void {
    if (node.kind === SyntaxKind.PropertyAccessExpression && isWorkdirName(node.name)) {
      hits.push({ reportNode: node, receiverExpr: node.expression });
    } else if (node.kind === SyntaxKind.ElementAccessExpression && isWorkdirName(node.argumentExpression)) {
      hits.push({ reportNode: node, receiverExpr: node.expression });
    } else if (node.kind === SyntaxKind.BindingElement) {
      const nameNode = node.propertyName ?? node.name;
      if (isWorkdirName(nameNode)) {
        const receiver = bindingReceiver(node);
        if (receiver !== undefined) hits.push({ reportNode: node, receiverExpr: receiver });
      }
    }
    node.forEachChild(walk);
  }

  walk(sourceFile);
  return hits;
}

/**
 * The single public walker entry point.
 *
 * Resolves the REAL type of each candidate's receiver expression via the
 * project's checker, and flags it iff that type is one of STORY_TYPES.
 */
export async function findViolations(project: Project, filePath: string, relPath: string): Promise<Violation[]> {
  const sourceFile = await project.program.getSourceFile(filePath);
  if (sourceFile === undefined) return [];

  const source: string = sourceFile.text;
  const lines = source.split("\n");
  const lineStarts = computeLineStarts(source);
  const candidates = collectCandidates(sourceFile);

  const out: Violation[] = [];
  const seen = new Set<number>();
  for (const hit of candidates) {
    const line = posToLine(lineStarts, hit.reportNode.getStart());
    if (seen.has(line)) continue;

    // Inline escape hatch: the marker may sit on the access line itself or
    // the line directly above it (mirrors the repo's other `-allow:` markers,
    // which tolerate the formatter moving a trailing comment).
    const ownLine = lines[line - 1] ?? "";
    const priorLine = lines[line - 2] ?? "";
    if (ALLOW_MARKER.test(ownLine) || ALLOW_MARKER.test(priorLine)) continue;

    // An optional-chained `story?.workdir` types its receiver as
    // `UserStory | undefined`; strip the nullable members from the DISPLAY
    // STRING before the STORY_TYPES check. (checker.getNonNullableType()
    // looks like the principled way to do this, but it collapses to "any"
    // for a fixture's deliberately-unresolved bare type reference -- a real
    // op on an error type, not a string trick -- so it corrupts every
    // fixture in this file's suite; a display-string strip has no such
    // failure mode and matches exactly what a human reads at the site.)
    const type = await project.checker.getTypeAtLocation(hit.receiverExpr);
    if (type === undefined) continue;
    const rawTypeName = await project.checker.typeToString(type);
    const typeName = rawTypeName
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part !== "undefined" && part !== "null")
      .join(" | ");
    if (!STORY_TYPES.has(typeName)) continue;

    seen.add(line);
    out.push({ file: relPath, line, text: ownLine.trim() });
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
 * Scan the tree. Side effects live behind `import.meta.main` so the test can
 * import `findViolations` without the gate running -- and exiting -- on import.
 * Same guard as scripts/check-gate-reachability.ts:147.
 */
async function main(): Promise<void> {
  await assertRootReadable(ROOT);

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
