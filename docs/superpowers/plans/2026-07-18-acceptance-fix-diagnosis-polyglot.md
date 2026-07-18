# Polyglot Acceptance Fix-Diagnosis Source Loader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the acceptance diagnosis LLM real source context for Python/Go/Rust (not just TS/JS) by making the import resolver polyglot.

**Architecture:** A new module `src/acceptance/import-resolution.ts` detects the package language once (test-file extension → `detectLanguage()` → typescript default) and dispatches to a per-language regex parser + best-effort candidate-path generator. `src/acceptance/fix-diagnosis.ts` becomes a thin options-object wrapper that delegates to it. All resolution degrades to `[]` on anything unresolvable — it is context enrichment, not compilation.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome. Bun-native APIs only (`Bun.file`, `Bun.Glob`).

## Global Constraints

- **Bun-native only** — `Bun.file()`, `Bun.Glob().scanSync({ cwd })`; never Node.js `fs`.
- **No `console.log`** in `src/` — not needed here (pure functions), but never add it.
- **Barrel imports across modules** — import `detectLanguage`/`clearLanguageCache` from `../project`, `ProjectProfile` type from `../config`. Sibling files inside `src/acceptance/` may import each other by relative leaf path (existing pattern — `fix-diagnosis.ts` is itself imported by leaf path).
- **Glob must pass `cwd` explicitly** (`monorepo-awareness.md` §6): `new Bun.Glob("*.go").scanSync({ cwd, absolute: false })`.
- **Test placement** mirrors `src/`: `src/acceptance/import-resolution.ts` → `test/unit/acceptance/import-resolution.test.ts`.
- **Test file I/O uses real temp dirs** via `withTempDir` from the `test/helpers` barrel — no `Bun.file` mocking.
- **Bun test wrapper** — never run bare `bun test`; always `timeout 30 bun test <path> --timeout=5000`.
- **Caps preserved:** `MAX_SOURCE_FILES = 5`, `MAX_FILE_LINES = 500`.
- **Behavior contract:** first-level local imports only; no transitive/dynamic/external-dependency resolution; every unresolvable import → filtered out; no throws escape the module.
- **Conventional commits**, one concern per commit. Never include `[run-release]`.

---

### Task 1: Language detection + capped file read primitives

**Files:**
- Create: `src/acceptance/import-resolution.ts`
- Test: `test/unit/acceptance/import-resolution.test.ts`

**Interfaces:**
- Consumes: `detectLanguage(packageDir)` from `../project`; `ProjectProfile` type from `../config`.
- Produces:
  - `MAX_SOURCE_FILES: 5`, `MAX_FILE_LINES: 500` (exported consts)
  - `type ResolvedLanguage = "typescript" | "javascript" | "python" | "go" | "rust"`
  - `languageFromExtension(testFilePath: string | undefined): ProjectProfile["language"] | undefined`
  - `resolveLanguage(opts: { testFilePath?: string; packageDir: string; language?: ProjectProfile["language"] }): Promise<ResolvedLanguage>`
  - `readCapped(relPath: string, packageDir: string): Promise<{ path: string; content: string } | null>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/acceptance/import-resolution.test.ts`:

```ts
/**
 * Tests for src/acceptance/import-resolution.ts — polyglot import resolution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearLanguageCache } from "../../../src/project";
import {
  languageFromExtension,
  MAX_FILE_LINES,
  readCapped,
  resolveLanguage,
} from "../../../src/acceptance/import-resolution";
import { withTempDir } from "../../helpers";

afterEach(() => clearLanguageCache());

describe("languageFromExtension", () => {
  test("maps known extensions", () => {
    expect(languageFromExtension("foo.test.ts")).toBe("typescript");
    expect(languageFromExtension("foo_test.go")).toBe("go");
    expect(languageFromExtension("test_foo.py")).toBe("python");
    expect(languageFromExtension("foo_test.rs")).toBe("rust");
    expect(languageFromExtension("foo.spec.jsx")).toBe("javascript");
  });

  test("returns undefined for no/unknown extension", () => {
    expect(languageFromExtension(undefined)).toBeUndefined();
    expect(languageFromExtension("Makefile")).toBeUndefined();
    expect(languageFromExtension("foo.txt")).toBeUndefined();
  });
});

describe("resolveLanguage", () => {
  test("explicit language wins", async () => {
    const lang = await resolveLanguage({ packageDir: "/tmp", language: "rust", testFilePath: "x.py" });
    expect(lang).toBe("rust");
  });

  test("falls back to test-file extension", async () => {
    const lang = await resolveLanguage({ packageDir: "/tmp", testFilePath: "x_test.go" });
    expect(lang).toBe("go");
  });

  test("defaults to typescript when nothing detectable", async () => {
    await withTempDir(async (dir) => {
      const lang = await resolveLanguage({ packageDir: dir });
      expect(lang).toBe("typescript");
    });
  });
});

describe("readCapped", () => {
  test("reads a real file relative to packageDir", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/a.ts`, "export const a = 1;");
      const result = await readCapped("src/a.ts", dir);
      expect(result).toEqual({ path: "src/a.ts", content: "export const a = 1;" });
    });
  });

  test("truncates to MAX_FILE_LINES", async () => {
    await withTempDir(async (dir) => {
      const body = Array.from({ length: MAX_FILE_LINES + 50 }, (_, i) => `line${i}`).join("\n");
      await Bun.write(`${dir}/big.ts`, body);
      const result = await readCapped("big.ts", dir);
      expect(result?.content.split("\n").length).toBe(MAX_FILE_LINES);
    });
  });

  test("returns null for a missing file", async () => {
    await withTempDir(async (dir) => {
      expect(await readCapped("nope.ts", dir)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: FAIL — cannot resolve module `src/acceptance/import-resolution` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `src/acceptance/import-resolution.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS (all `languageFromExtension` / `resolveLanguage` / `readCapped` cases green).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/acceptance/import-resolution.ts test/unit/acceptance/import-resolution.test.ts
git commit -m "feat(acceptance): language detection + capped read primitives for import resolution"
```

---

### Task 2: `resolveSourceFiles` dispatch + TS/JS resolver

**Files:**
- Modify: `src/acceptance/import-resolution.ts`
- Test: `test/unit/acceptance/import-resolution.test.ts`

**Interfaces:**
- Consumes: `resolveLanguage`, `readCapped`, `MAX_SOURCE_FILES` (Task 1).
- Produces:
  - `interface ResolveSourceFilesOptions { testFileContent: string; packageDir: string; testFilePath?: string; language?: ProjectProfile["language"] }`
  - `resolveSourceFiles(opts: ResolveSourceFilesOptions): Promise<Array<{ path: string; content: string }>>`
  - `parseTsImports(content: string): string[]`
  - `tsCandidates(spec: string): string[]`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/acceptance/import-resolution.test.ts` (add `parseTsImports`, `resolveSourceFiles` to the import from `../../../src/acceptance/import-resolution`):

```ts
describe("parseTsImports", () => {
  test("keeps relative imports, drops bare specifiers", () => {
    const content = `
import { add } from "./math";
import { z } from "zod";
import { b } from "../lib/b.ts";
`;
    expect(parseTsImports(content)).toEqual(["./math", "../lib/b.ts"]);
  });
});

describe("resolveSourceFiles — typescript", () => {
  test("resolves an extensionless relative import", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/math.ts`, "export const add = (a: number, b: number) => a + b;");
      const files = await resolveSourceFiles({
        testFileContent: `import { add } from "./math";`,
        packageDir: dir,
        language: "typescript",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("./math.ts");
    });
  });

  test("caps at 5 files even when 6 resolve", async () => {
    await withTempDir(async (dir) => {
      let content = "";
      for (let i = 1; i <= 6; i++) {
        await Bun.write(`${dir}/f${i}.ts`, `export const v${i} = ${i};`);
        content += `import { v${i} } from "./f${i}.ts";\n`;
      }
      const files = await resolveSourceFiles({ testFileContent: content, packageDir: dir, language: "typescript" });
      expect(files).toHaveLength(5);
    });
  });

  test("degrades to [] when nothing resolves", async () => {
    await withTempDir(async (dir) => {
      const files = await resolveSourceFiles({
        testFileContent: `import { x } from "./missing";`,
        packageDir: dir,
        language: "typescript",
      });
      expect(files).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: FAIL — `parseTsImports` / `resolveSourceFiles` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/acceptance/import-resolution.ts`:

```ts
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

async function collectCandidates(lang: ResolvedLanguage, opts: ResolveSourceFilesOptions): Promise<string[]> {
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseTsImports(opts.testFileContent).flatMap(tsCandidates);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/acceptance/import-resolution.ts test/unit/acceptance/import-resolution.test.ts
git commit -m "feat(acceptance): resolveSourceFiles dispatch + TS/JS import resolver"
```

---

### Task 3: Python resolver

**Files:**
- Modify: `src/acceptance/import-resolution.ts`
- Test: `test/unit/acceptance/import-resolution.test.ts`

**Interfaces:**
- Consumes: `collectCandidates` switch (Task 2).
- Produces: `parsePythonImports(content: string): string[]`, `pythonCandidates(module: string): string[]`.

- [ ] **Step 1: Write the failing test**

Append (add `parsePythonImports` to the module import):

```ts
describe("parsePythonImports", () => {
  test("captures from/import/as/relative forms", () => {
    const content = `
from foo.bar import baz
import pkg.mod
import other as o
from .local import thing
`;
    expect(parsePythonImports(content)).toEqual(["foo.bar", "pkg.mod", "other", "local"]);
  });
});

describe("resolveSourceFiles — python", () => {
  test("resolves dotted module to a .py file", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/foo/bar.py`, "def baz():\n    return 1\n");
      const files = await resolveSourceFiles({
        testFileContent: `from foo.bar import baz`,
        packageDir: dir,
        language: "python",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("foo/bar.py");
    });
  });

  test("resolves a package __init__.py", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/pkg/__init__.py`, "VALUE = 1\n");
      const files = await resolveSourceFiles({
        testFileContent: `import pkg`,
        packageDir: dir,
        language: "python",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("pkg/__init__.py");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: FAIL — `parsePythonImports` not exported; python `resolveSourceFiles` returns `[]`.

- [ ] **Step 3: Write minimal implementation**

Append the parser/candidates to `src/acceptance/import-resolution.ts`:

```ts
// Python: `from a.b import x` and `import a.b`. Leading dots (relative imports)
// are best-effort — stripped and mapped relative to packageDir.
const PY_FROM_RE = /^\s*from\s+\.*([\w.]*)\s+import\s+/gm;
const PY_IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

export function parsePythonImports(content: string): string[] {
  const modules: string[] = [];
  for (const m of content.matchAll(PY_FROM_RE)) {
    if (m[1]) modules.push(m[1]); // empty for `from . import x` — skipped (ambiguous)
  }
  for (const m of content.matchAll(PY_IMPORT_RE)) {
    for (const part of m[1].split(",")) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (mod) modules.push(mod);
    }
  }
  return modules;
}

export function pythonCandidates(module: string): string[] {
  const base = module.replace(/\./g, "/");
  return [`${base}.py`, `${base}/__init__.py`];
}
```

Then add a `python` case to `collectCandidates`, before `default`:

```ts
    case "python":
      return parsePythonImports(opts.testFileContent).flatMap(pythonCandidates);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/acceptance/import-resolution.ts test/unit/acceptance/import-resolution.test.ts
git commit -m "feat(acceptance): Python import resolver"
```

---

### Task 4: Rust resolver

**Files:**
- Modify: `src/acceptance/import-resolution.ts`
- Test: `test/unit/acceptance/import-resolution.test.ts`

**Interfaces:**
- Consumes: `collectCandidates` switch (Task 2).
- Produces: `parseRustUses(content: string): string[]`, `rustCandidates(usePath: string): string[]`.

- [ ] **Step 1: Write the failing test**

Append (add `parseRustUses` to the module import):

```ts
describe("parseRustUses", () => {
  test("captures crate/super/self paths, skips external crates", () => {
    const content = `
use crate::math::add;
use crate::util::{a, b};
use super::helpers::x;
use std::collections::HashMap;
`;
    expect(parseRustUses(content)).toEqual(["crate::math::add", "crate::util", "super::helpers"]);
  });
});

describe("resolveSourceFiles — rust", () => {
  test("resolves crate path to src/<path>.rs", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/math.rs`, "pub fn add(a: i32, b: i32) -> i32 { a + b }");
      const files = await resolveSourceFiles({
        testFileContent: `use crate::math::add;`,
        packageDir: dir,
        language: "rust",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/math.rs");
    });
  });

  test("resolves a module directory to mod.rs", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/util/mod.rs`, "pub fn a() {}");
      const files = await resolveSourceFiles({
        testFileContent: `use crate::util::{a, b};`,
        packageDir: dir,
        language: "rust",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/util/mod.rs");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: FAIL — `parseRustUses` not exported; rust `resolveSourceFiles` returns `[]`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/acceptance/import-resolution.ts`:

```ts
// Rust: only crate-local `use` (crate/super/self roots). External crates skipped.
// Captures the path prefix before any `{group}`. super/self are mapped like crate
// (best-effort — no parent-dir traversal).
const RUST_USE_RE = /^\s*use\s+((?:crate|super|self)(?:::\w+)*)/gm;

export function parseRustUses(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(RUST_USE_RE)) paths.push(m[1]);
  return paths;
}

export function rustCandidates(usePath: string): string[] {
  const rest = usePath.split("::").slice(1); // drop crate/super/self
  if (rest.length === 0) return [];
  const base = `src/${rest.join("/")}`;
  const parentMod = rest.length > 1 ? `src/${rest.slice(0, -1).join("/")}/mod.rs` : "src/lib.rs";
  return [`${base}.rs`, `${base}/mod.rs`, parentMod];
}
```

Then add a `rust` case to `collectCandidates`, before `default`:

```ts
    case "rust":
      return parseRustUses(opts.testFileContent).flatMap(rustCandidates);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/acceptance/import-resolution.ts test/unit/acceptance/import-resolution.test.ts
git commit -m "feat(acceptance): Rust import resolver"
```

---

### Task 5: Go resolver (go.mod prefix + package directory)

**Files:**
- Modify: `src/acceptance/import-resolution.ts`
- Test: `test/unit/acceptance/import-resolution.test.ts`

**Interfaces:**
- Consumes: `collectCandidates` switch (Task 2).
- Produces: `parseGoImports(content: string): string[]`, `resolveGoCandidates(content: string, packageDir: string): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Append (add `parseGoImports` to the module import):

```ts
describe("parseGoImports", () => {
  test("captures single and grouped imports", () => {
    const content = `
import "example.com/proj/pkg/math"
import (
  "fmt"
  "example.com/proj/pkg/util"
)
`;
    expect(parseGoImports(content)).toEqual([
      "example.com/proj/pkg/math",
      "fmt",
      "example.com/proj/pkg/util",
    ]);
  });
});

describe("resolveSourceFiles — go", () => {
  test("loads local package .go files, excludes _test.go and external imports", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/go.mod`, "module example.com/proj\n\ngo 1.22\n");
      await Bun.write(`${dir}/pkg/math/add.go`, "package math\n\nfunc Add(a, b int) int { return a + b }");
      await Bun.write(`${dir}/pkg/math/add_test.go`, "package math\n\n// test file");
      const files = await resolveSourceFiles({
        testFileContent: `import (\n  "fmt"\n  "example.com/proj/pkg/math"\n)`,
        packageDir: dir,
        language: "go",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("pkg/math/add.go");
    });
  });

  test("returns [] when go.mod is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/pkg/math/add.go`, "package math");
      const files = await resolveSourceFiles({
        testFileContent: `import "example.com/proj/pkg/math"`,
        packageDir: dir,
        language: "go",
      });
      expect(files).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: FAIL — `parseGoImports` not exported; go `resolveSourceFiles` returns `[]`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/acceptance/import-resolution.ts`:

```ts
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
```

Then add a `go` case to `collectCandidates`, before `default`:

```ts
    case "go":
      return resolveGoCandidates(opts.testFileContent, opts.packageDir);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/acceptance/import-resolution.ts test/unit/acceptance/import-resolution.test.ts
git commit -m "feat(acceptance): Go import resolver (go.mod prefix + package dir)"
```

---

### Task 6: Integrate into `fix-diagnosis.ts` + caller + migrate existing test

**Files:**
- Modify: `src/acceptance/fix-diagnosis.ts` (full rewrite — see Step 3)
- Modify: `src/execution/lifecycle/acceptance-fix.ts:117`
- Modify: `test/unit/acceptance/fix-diagnosis.test.ts:19,30,45`

**Interfaces:**
- Consumes: `resolveSourceFiles`, `ResolveSourceFilesOptions` (Task 2); `ProjectProfile` type from `../config`.
- Produces:
  - `interface LoadSourceFilesOptions { testFileContent: string; packageDir: string; testFilePath?: string; language?: ProjectProfile["language"] }`
  - `loadSourceFilesForDiagnosis(opts: LoadSourceFilesOptions): Promise<Array<{ path: string; content: string }>>` (signature CHANGED from positional `(testFileContent, workdir)` to options object)

- [ ] **Step 1: Update the existing test to the new options-object signature**

In `test/unit/acceptance/fix-diagnosis.test.ts`, replace the three `loadSourceFilesForDiagnosis` call sites (lines ~19, ~30, ~45) with options-object calls carrying `language: "typescript"` for deterministic behavior:

```ts
// line ~19
const result = await loadSourceFilesForDiagnosis({
  testFileContent: 'test("x", () => {});',
  packageDir: "/tmp",
  language: "typescript",
});
expect(result).toEqual([]);
```

```ts
// line ~30 (testContent already defined above)
const result = await loadSourceFilesForDiagnosis({
  testFileContent: testContent,
  packageDir: "/tmp",
  language: "typescript",
});
expect(result).toEqual([]);
```

```ts
// line ~45 (testContent already defined above)
const result = await loadSourceFilesForDiagnosis({
  testFileContent: testContent,
  packageDir: "/tmp",
  language: "typescript",
});
expect(result).toEqual([]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 30 bun test test/unit/acceptance/fix-diagnosis.test.ts --timeout=5000`
Expected: FAIL — `loadSourceFilesForDiagnosis` still expects positional args / type error on object argument.

- [ ] **Step 3: Rewrite `fix-diagnosis.ts` to delegate**

Replace the entire contents of `src/acceptance/fix-diagnosis.ts` with:

```ts
/**
 * Acceptance Fix Diagnosis — source-file loading for the diagnosis flow.
 *
 * Thin wrapper over the polyglot resolver in ./import-resolution. Kept as a
 * named seam because the acceptance diagnosis lifecycle imports it directly.
 */
import type { ProjectProfile } from "../config";
import { resolveSourceFiles } from "./import-resolution";

export interface LoadSourceFilesOptions {
  testFileContent: string;
  packageDir: string;
  testFilePath?: string;
  language?: ProjectProfile["language"];
}

export async function loadSourceFilesForDiagnosis(
  opts: LoadSourceFilesOptions,
): Promise<Array<{ path: string; content: string }>> {
  return resolveSourceFiles(opts);
}
```

- [ ] **Step 4: Update the caller**

In `src/execution/lifecycle/acceptance-fix.ts`, replace the line 117 call:

```ts
  const sourceFiles = await loadSourceFilesForDiagnosis({
    testFileContent: diagnosisOpts.testFileContent,
    packageDir: diagnosisOpts.workdir,
    testFilePath: diagnosisOpts.acceptanceTestPath,
  });
```

- [ ] **Step 5: Run both acceptance test files to verify they pass**

Run: `timeout 30 bun test test/unit/acceptance/fix-diagnosis.test.ts test/unit/acceptance/import-resolution.test.ts --timeout=5000`
Expected: PASS (both files green).

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors (file-size, alias, biome all pass).

- [ ] **Step 7: Run the broader acceptance + lifecycle unit suites**

Run: `timeout 60 bun test test/unit/acceptance/ test/unit/execution/lifecycle/ --timeout=10000`
Expected: PASS — no regressions from the signature change.

- [ ] **Step 8: Commit**

```bash
git add src/acceptance/fix-diagnosis.ts src/execution/lifecycle/acceptance-fix.ts test/unit/acceptance/fix-diagnosis.test.ts
git commit -m "feat(acceptance): wire polyglot import resolution into fix-diagnosis"
```

---

## Self-Review

**1. Spec coverage** (design doc §Approach):
- New `import-resolution.ts` module → Tasks 1–5. ✓
- Per-language table (ts/js, python, rust, go) → Tasks 2/3/4/5. ✓
- Options-object signature + `testFilePath`/`packageDir`/`language` → Task 2 (`ResolveSourceFilesOptions`) + Task 6 (`LoadSourceFilesOptions`). ✓
- Language detection: extension → `detectLanguage` → typescript default → Task 1 (`resolveLanguage`). ✓
- Caller update passes `acceptanceTestPath` → Task 6 Step 4. ✓
- Error handling: wrapped reads → null → filtered; go.mod missing → []; unknown → typescript → Tasks 1/5. ✓
- Testing: new `import-resolution.test.ts` with real fixtures; existing `fix-diagnosis.test.ts` migrated + green → all tasks + Task 6. ✓
- Caps 5/500 preserved → Task 1 consts, Task 2 cap test. ✓
- Non-goals (no transitive/dynamic/external) → honored; only first-level local candidates generated. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**3. Type consistency:** `ResolvedLanguage`, `ResolveSourceFilesOptions`, `LoadSourceFilesOptions`, `resolveSourceFiles`, `resolveLanguage`, `readCapped`, `parseTsImports`/`tsCandidates`, `parsePythonImports`/`pythonCandidates`, `parseRustUses`/`rustCandidates`, `parseGoImports`/`resolveGoCandidates` are named identically at definition and use sites. `collectCandidates` switch grows one case per task (Tasks 2→5), each inserted before `default`. `loadSourceFilesForDiagnosis` options object matches between Task 6 definition and caller. ✓
