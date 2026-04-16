/**
 * Context Engine v2 — CodeNeighborProvider
 *
 * Surfaces import-graph neighbors for files this story touches:
 *   - Forward deps:  files imported by the touched file (import/require parse)
 *   - Reverse deps:  files that import the touched file (Bun.Glob scan, capped at 200 files)
 *   - Sibling test:  mirrored test file (src/foo/bar.ts → test/unit/foo/bar.test.ts)
 *
 * Language scope:
 *   Forward dep parsing is JavaScript/TypeScript-only (import/require syntax).
 *   For other languages (Python, Go, Rust, etc.), forward deps return empty;
 *   reverse deps and sibling tests are still attempted where applicable.
 *   The reverse-dep glob covers common source extensions across languages.
 *
 * The combined result is collapsed into a single "neighbor" kind chunk.
 * Files are capped at MAX_FILES; neighbors per file capped at MAX_NEIGHBORS_PER_FILE.
 * Chunk is capped at MAX_CHUNK_TOKENS to avoid budget overrun.
 *
 * Phase 3.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of files to process */
const MAX_FILES = 10;

/** Maximum number of neighbors (forward + reverse combined) per file */
const MAX_NEIGHBORS_PER_FILE = 8;

/** Maximum files scanned during reverse-dep glob */
const MAX_GLOB_FILES = 200;

/** Token ceiling for the combined neighbor chunk */
const MAX_CHUNK_TOKENS = 500;

/**
 * Source file extensions to scan for reverse deps.
 * Covers common languages nax may be run against.
 */
const SOURCE_GLOB = "src/**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,php,cs,cpp,c,h}";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _codeNeighborDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  glob: (pattern: string, cwd: string): string[] => {
    const g = new Bun.Glob(pattern);
    const results: string[] = [];
    let count = 0;
    for (const file of g.scanSync({ cwd, absolute: false })) {
      if (count >= MAX_GLOB_FILES) break;
      results.push(file);
      count++;
    }
    return results;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** Patterns that match JS/TS import/require statements — used with matchAll() */
const FROM_PATTERN = /from\s+['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_SIDE_EFFECT_PATTERN = /import\s+['"]([^'"]+)['"]/g;

/**
 * Parse JS/TS import specifiers from file content.
 * Returns only relative paths (starts with ".") — ignores node_modules.
 * Returns empty for non-JS/TS files (no import syntax match).
 */
function parseImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(FROM_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(REQUIRE_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(IMPORT_SIDE_EFFECT_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/**
 * Resolve a relative import specifier to a workdir-relative path.
 * Extension candidates are checked in order — with-extension first so the
 * returned path always carries the extension (avoids bare "src/utils/helper").
 * Returns null if all candidates fall outside workdir.
 */
function resolveImport(specifier: string, fromFile: string, workdir: string): string | null {
  const base = resolve(workdir, fromFile, "..", specifier);
  // Extension-first ordering ensures the returned path includes the extension.
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base];
  for (const candidate of candidates) {
    const rel = relative(workdir, candidate);
    if (!rel.startsWith("..")) return rel;
  }
  return null;
}

/**
 * Derive the sibling test file path for a source file.
 * Preserves the source extension for JSX/TSX files.
 *   src/foo/bar.ts  → test/unit/foo/bar.test.ts
 *   src/foo/bar.tsx → test/unit/foo/bar.test.tsx
 */
function siblingTestPath(filePath: string): string | null {
  const srcMatch = filePath.match(/^src\/(.+)\.(ts|tsx|js|jsx)$/);
  if (!srcMatch) return null;
  const ext = srcMatch[2] ?? "ts";
  return `test/unit/${srcMatch[1]}.test.${ext}`;
}

/**
 * Collect neighbors for a single file:
 * - forward deps (JS/TS import parse only — empty for other languages)
 * - reverse deps (all common source extensions)
 * - sibling test file (JS/TS/JSX/TSX only)
 */
async function collectNeighbors(filePath: string, workdir: string): Promise<string[]> {
  const neighbors = new Set<string>();

  // Forward deps (JS/TS only)
  if (await _codeNeighborDeps.fileExists(join(workdir, filePath))) {
    const content = await _codeNeighborDeps.readFile(join(workdir, filePath));
    for (const spec of parseImportSpecifiers(content)) {
      const resolved = resolveImport(spec, filePath, workdir);
      if (resolved && resolved !== filePath) neighbors.add(resolved);
    }
  }

  // Reverse deps — scan for files that import this file.
  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const fileNoExt = filePath.replace(/\.[^.]+$/, "");
  const srcFiles = _codeNeighborDeps.glob(SOURCE_GLOB, workdir);
  for (const srcFile of srcFiles) {
    if (neighbors.size >= MAX_NEIGHBORS_PER_FILE) break;
    if (srcFile === filePath) continue; // skip self — must be continue, not break
    try {
      const content = await _codeNeighborDeps.readFile(join(workdir, srcFile));
      // Quick string check using base name before full JS/TS parse
      if (content.includes(fileBaseName)) {
        for (const spec of parseImportSpecifiers(content)) {
          const resolved = resolveImport(spec, srcFile, workdir);
          if (resolved === filePath || resolved === fileNoExt) {
            neighbors.add(srcFile);
            break;
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sibling test (JS/TS/JSX/TSX only)
  const testPath = siblingTestPath(filePath);
  if (testPath) neighbors.add(testPath);

  return [...neighbors].slice(0, MAX_NEIGHBORS_PER_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces import-graph neighbors for files touched by the story.
 * Returns a single combined chunk with kind "neighbor".
 */
export class CodeNeighborProvider implements IContextProvider {
  readonly id = "code-neighbor";
  readonly kind = "neighbor" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const { touchedFiles, workdir } = request;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const filesToProcess = touchedFiles.slice(0, MAX_FILES);

    const sections: string[] = [];
    for (const file of filesToProcess) {
      const neighbors = await collectNeighbors(file, workdir);
      if (neighbors.length > 0) {
        sections.push(`### ${file}\n${neighbors.map((n) => `- ${n}`).join("\n")}`);
      }
    }

    if (sections.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const header = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";
    const rawContent = `${header}\n\n${sections.join("\n\n")}`;

    // Cap content to avoid overrunning token budget
    const maxChars = MAX_CHUNK_TOKENS * 4;
    const content = rawContent.length > maxChars ? rawContent.slice(0, maxChars) : rawContent;
    const tokens = Math.ceil(content.length / 4);

    const chunk: RawChunk = {
      id: `code-neighbor:${contentHash8(content)}`,
      kind: "neighbor",
      scope: "story",
      role: ["implementer", "tdd"],
      content,
      tokens,
      rawScore: 0.65,
    };

    return { chunks: [chunk], pullTools: [] };
  }
}
