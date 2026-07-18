/**
 * Polyglot import resolution for acceptance fix-diagnosis.
 *
 * Best-effort source-context loader: parse the failing test's imports, map them
 * to candidate local source files, load what exists (capped). NOT a compiler —
 * every unresolvable/unreadable import degrades to a filtered-out null. Scope is
 * first-level LOCAL imports only; language-specific parsing is gated by
 * detected language per monorepo-awareness.md §B.
 */
import type { ProjectProfile } from "../config";
import { detectLanguage } from "../project";

export const MAX_SOURCE_FILES = 5;
export const MAX_FILE_LINES = 500;

export type ResolvedLanguage = "typescript" | "javascript" | "python" | "go" | "rust";

const SUPPORTED = new Set<string>(["typescript", "javascript", "python", "go", "rust"]);

const EXT_LANGUAGE = new Map<string, ProjectProfile["language"]>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
]);

export function languageFromExtension(testFilePath: string | undefined): ProjectProfile["language"] | undefined {
  if (!testFilePath) return undefined;
  const dot = testFilePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_LANGUAGE.get(testFilePath.slice(dot).toLowerCase());
}

export async function resolveLanguage(opts: {
  testFilePath?: string;
  packageDir: string;
  language?: ProjectProfile["language"];
}): Promise<ResolvedLanguage> {
  const explicit = opts.language ?? languageFromExtension(opts.testFilePath);
  if (explicit && SUPPORTED.has(explicit)) return explicit as ResolvedLanguage;
  const detected = await detectLanguage(opts.packageDir);
  if (detected && SUPPORTED.has(detected)) return detected as ResolvedLanguage;
  return "typescript"; // historical default — preserves pre-polyglot behavior
}

export async function readCapped(
  relPath: string,
  packageDir: string,
): Promise<{ path: string; content: string } | null> {
  try {
    const text = await Bun.file(`${packageDir}/${relPath}`).text();
    const content = text.split("\n").slice(0, MAX_FILE_LINES).join("\n");
    return { path: relPath, content };
  } catch {
    return null;
  }
}

export interface ResolveSourceFilesOptions {
  testFileContent: string;
  packageDir: string;
  testFilePath?: string;
  language?: ProjectProfile["language"];
}

const TS_IMPORT_RE = /import\s+(?:{[^}]+}|[^;'"]+)\s+from\s+["']([^"']+)["']/g;
const TS_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;

export function parseTsImports(content: string): string[] {
  const specs: string[] = [];
  for (const m of content.matchAll(TS_IMPORT_RE)) {
    if (m[1].startsWith(".")) specs.push(m[1]);
  }
  return specs;
}

export function tsCandidates(spec: string): string[] {
  if (TS_EXTS.some((e) => spec.endsWith(e))) return [spec];
  const out: string[] = [];
  for (const e of TS_EXTS) out.push(`${spec}${e}`);
  for (const e of TS_EXTS) out.push(`${spec}/index${e}`);
  return out;
}

// Python: `from a.b import x` and `import a.b`. Leading dots (relative imports)
// are best-effort — stripped and mapped relative to packageDir. Matched as a
// single alternation pass so results preserve source order (from/import lines
// can be interleaved in the file).
const PY_IMPORT_LINE_RE = /^\s*(?:from\s+\.*([\w.]*)\s+import\s+|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/gm;

export function parsePythonImports(content: string): string[] {
  const modules: string[] = [];
  for (const m of content.matchAll(PY_IMPORT_LINE_RE)) {
    const fromModule = m[1];
    const importList = m[2];
    if (fromModule !== undefined) {
      if (fromModule) modules.push(fromModule); // empty for `from . import x` — skipped (ambiguous)
    } else if (importList) {
      for (const part of importList.split(",")) {
        const mod = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (mod) modules.push(mod);
      }
    }
  }
  return modules;
}

export function pythonCandidates(module: string): string[] {
  const base = module.replace(/\./g, "/");
  return [`${base}.py`, `${base}/__init__.py`];
}

// Rust: only crate-local `use` (crate/super/self roots). External crates skipped.
// Captures the path prefix before any `{group}`. `crate::` paths are absolute from
// the crate root so the full segment chain is kept (candidate generation drops the
// trailing item/module split later). `super::`/`self::` are relative and handled
// best-effort — no parent-dir traversal — so only one segment past the root is
// captured to avoid resolving to the wrong file.
const RUST_USE_RE = /^\s*use\s+(crate(?:::\w+)*|(?:super|self)(?:::\w+)?)/gm;

export function parseRustUses(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(RUST_USE_RE)) paths.push(m[1]);
  return paths;
}

export function rustCandidates(usePath: string): string[] {
  const rest = usePath.split("::").slice(1); // drop crate/super/self
  if (rest.length === 0) return [];
  const base = `src/${rest.join("/")}`;
  const candidates = [`${base}.rs`, `${base}/mod.rs`];
  // The trailing segment may be an item (fn/struct) rather than a module, so also
  // try the path one level up as both a file-style and dir-style module.
  if (rest.length > 1) {
    const parent = `src/${rest.slice(0, -1).join("/")}`;
    candidates.push(`${parent}.rs`, `${parent}/mod.rs`);
  } else {
    candidates.push("src/lib.rs");
  }
  return candidates;
}

// Go: an import is a package path; resolving to files needs the go.mod module
// prefix stripped, then the local directory's non-test .go files.
const GO_SINGLE_IMPORT_RE = /^\s*import\s+"([^"]+)"/gm;
const GO_IMPORT_BLOCK_RE = /import\s*\(([\s\S]*?)\)/g;
const GO_BLOCK_LINE_RE = /"([^"]+)"/g;

export function parseGoImports(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(GO_SINGLE_IMPORT_RE)) paths.push(m[1]);
  for (const block of content.matchAll(GO_IMPORT_BLOCK_RE)) {
    for (const line of block[1].matchAll(GO_BLOCK_LINE_RE)) paths.push(line[1]);
  }
  return paths;
}

async function readGoModulePrefix(packageDir: string): Promise<string | null> {
  try {
    const text = await Bun.file(`${packageDir}/go.mod`).text();
    const m = text.match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function resolveGoCandidates(content: string, packageDir: string): Promise<string[]> {
  const prefix = await readGoModulePrefix(packageDir);
  if (!prefix) return [];
  const candidates: string[] = [];
  for (const imp of parseGoImports(content)) {
    if (imp !== prefix && !imp.startsWith(`${prefix}/`)) continue;
    const relDir = imp === prefix ? "." : imp.slice(prefix.length + 1);
    try {
      for (const file of new Bun.Glob("*.go").scanSync({ cwd: `${packageDir}/${relDir}`, absolute: false })) {
        if (file.endsWith("_test.go")) continue;
        candidates.push(relDir === "." ? file : `${relDir}/${file}`);
      }
    } catch {
      // directory missing — skip this import
    }
  }
  return candidates;
}

async function collectCandidates(lang: ResolvedLanguage, opts: ResolveSourceFilesOptions): Promise<string[]> {
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseTsImports(opts.testFileContent).flatMap(tsCandidates);
    case "python":
      return parsePythonImports(opts.testFileContent).flatMap(pythonCandidates);
    case "rust":
      return parseRustUses(opts.testFileContent).flatMap(rustCandidates);
    case "go":
      return resolveGoCandidates(opts.testFileContent, opts.packageDir);
    default:
      return [];
  }
}

async function readCandidates(
  candidates: string[],
  packageDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const seen = new Set<string>();
  const results: Array<{ path: string; content: string }> = [];
  for (const rel of candidates) {
    if (results.length >= MAX_SOURCE_FILES) break;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = await readCapped(rel, packageDir);
    if (file) results.push(file);
  }
  return results;
}

export async function resolveSourceFiles(
  opts: ResolveSourceFilesOptions,
): Promise<Array<{ path: string; content: string }>> {
  const lang = await resolveLanguage(opts);
  const candidates = await collectCandidates(lang, opts);
  return readCandidates(candidates, opts.packageDir);
}
