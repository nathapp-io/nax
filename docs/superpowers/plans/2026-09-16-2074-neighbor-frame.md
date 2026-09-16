# #2074 Neighbour Frame Implementation Plan (path-frame PR 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `CodeNeighborProvider` comparing and emitting file paths across two different roots — compare absolutely, render once in the consuming story's frame, delete the cross-package reverse scan that can only produce false matches, and retire the `crossPackageDepth` knob it was the sole consumer of.

**Architecture:** Every path the provider reasons about becomes absolute at the point of comparison (`join(scanRoot, srcFile)` against `join(consumerRoot, touchedFile)`), so no layer performs frame arithmetic on two mutually-unintelligible relative paths. Paths are re-spelled exactly once, at render time, into the consumer's package frame; anything outside that root keeps a repo-rooted spelling and carries the exported `UNREADABLE_MARKER` already shipped for #2072. The sibling-package scan is removed because `parseImportSpecifiers` never collects bare specifiers, so it cannot find a true cross-package dependent — only false ones.

**Tech Stack:** TypeScript, Bun (`bun run test`), Zod config schemas, biome, the repo's `check:*` gate scripts.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (§"#2074 — sibling-frame neighbours", §Sequencing row 5). Issue: [#2074](https://github.com/nathapp-io/nax/issues/2074).

## Global Constraints

- **Canonical frame.** Every nax-internal path set is repo-rooted. Package-relative spelling is legal only at the agent-prompt boundary. SSOT: `src/utils/path-frame.ts`.
- **`story.workdir` is always a string; `"."` means repo root.** Enforced by `bun run check:story-workdir-access`.
- **Size ratchet** (`scripts/check-file-sizes.ts`): 600 lines for `src/`, 800 for `test/`, with a baseline no recorded file may exceed.
  - `src/context/engine/providers/code-neighbor.ts` — 462 lines, has headroom; this plan removes more than it adds.
  - `test/unit/context/engine/providers/code-neighbor.test.ts` — **794/800**. It may grow by at most a few lines; every new case in this plan goes in a NEW sibling file.
  - `test/unit/config/loader-legacy-shim.test.ts` — **749/800**. New shim tests go in a new sibling file.
  - `src/config/compat-shims.ts` — 508/600, room for one more shim.
- **Commands.** `bun run test` for the full suite; a single file is `bun test ./path/to/file.test.ts --timeout=60000`. **Never bare `bun test`, never `bun run nax`** — both give confident false signals. Use `bun run dev` to invoke the CLI. `bun run test:coverage` is NOT part of `check:all`; this plan adds one new `src/` file (none, in fact — see File Structure), so run it only if a task creates one.
- **`.nax/rules/` is the canonical rules store; `.claude/rules/` is a GENERATED mirror.** Never hand-edit the mirror — regenerate with `bun run dev rules export --agent=claude` and verify with `bun run check:rules-drift`.
- **No emojis in code, comments or docs.** ASCII only in `UNREADABLE_MARKER` (it is asserted byte-for-byte).

---

## File Structure

**Modified:**

| File | Responsibility after this plan |
|---|---|
| `src/context/engine/providers/code-neighbor.ts` | Neighbour discovery with one scan root; absolute-path comparison; consumer-frame rendering at the boundary. Loses `resolveExtraGlobWorkdirs`, the `discoverWorkspacePackages` dep, and `crossPackageDepth`. |
| `src/context/engine/providers/code-neighbor-chunk.ts` | Unchanged responsibility. One-line change: attribute `scopePaths` to the path without the unreadable marker. |
| `src/utils/path-frame.ts` | Gains `stripUnreadableMarker` so the marker is added and removed in exactly one module. |
| `src/config/schemas-context.ts`, `src/config/runtime-types-context.ts`, `src/context/engine/orchestrator-factory.ts` | `crossPackageDepth` removed from the config surface. |
| `src/config/compat-shims.ts` | Gains `_applyRemovedCrossPackageDepthShim` so an existing config carrying the key still loads, with a deprecation warning. |
| Docs: `docs/adr/ADR-010-context-engine.md`, `docs/guides/context-engine.md`, `docs/guides/context-providers.md`, `docs/specs/SPEC-context-engine-v2-compilation.md`, `docs/specs/SPEC-context-engine-v2-amendments.md`, `docs/specs/SPEC-effectiveness-scoring-loop.md`, `.nax/rules/monorepo-awareness.md` (+ regenerated `.claude/rules/` mirror) | State that cross-package reverse-deps are unsupported, and why. |

**Created:**

| File | Responsibility |
|---|---|
| `test/unit/context/engine/providers/code-neighbor-frame.test.ts` | The #2074 regression suite: the issue's worked example, the self-skip case, and cross-package rendering. Exists as its own file because `code-neighbor.test.ts` is at 794/800. |
| `test/unit/config/deprecation-cross-package-depth.test.ts` | The removed-key shim: warns once, drops the key, config still loads. Mirrors `test/unit/config/deprecation-routing-retry.test.ts`. |

**No new `src/` file is created**, so `bun run test:coverage` is not a per-commit obligation here (run it once at the end anyway, Task 5).

---

## Key facts an implementer must not re-derive

1. **`ContextRequest.touchedFiles` is PACKAGE-framed** — both build sites (`src/pipeline/stages/context.ts:127`, `src/context/engine/stage-assembler.ts:236`) re-spell the PRD's repo-rooted `contextFiles` through `toPackageFrameFiles`. It is documented on the field at `src/context/engine/types.ts:329-333`. The consuming root for a touched file is therefore **always `request.packageDir`**, never the scan root.
2. **`workdir` inside `fetch()` today is the SCAN root**, and it is `request.repoRoot` when `neighborScope: "repo"`. Today the touched file is resolved against that same value, which is wrong under `"repo"` scope in a monorepo — `join(repoRoot, "src/index.ts")` names a file that does not exist. Task 1 splits the two roles: `consumerRoot` (always `packageDir`) and `scanRoot`.
3. **Do NOT derive the consumer prefix as `relative(repoRoot, packageDir)`.** Under `storyIsolation: "worktree"` `packageDir` is `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` is the main checkout, so that derivation yields a prefix matching nothing (the #2069 trap; `src/context/fragments/reframe.ts:70-78` documents it). This plan never derives a prefix: it compares and re-spells **absolute** paths with `node:path`'s `relative`, which is correct whether or not the two roots share an ancestor.
4. **`resolveImport` already refuses to escape its root** (`code-neighbor.ts:183-184`), so forward deps and sibling-test hints can never leave `consumerRoot`. Only reverse deps can, and only under `neighborScope: "repo"`.
5. **`query_neighbor` passes `packageDir === repoRoot` deliberately** (`src/context/engine/handlers/query-neighbor.ts:64-73`). Under this plan that path is a no-op re-spelling — do not "fix" it.
6. **Removing the sibling scan is not a behaviour regression to genuine users.** Two independent reasons, both verified in the source: `parseImportSpecifiers` (`code-neighbor.ts:158-169`) keeps only `.`-prefixed specifiers, so `import { x } from "@scope/lib"` is never collected; and even a relative cross-package import (`../../app/src/index`) is rejected by `resolveImport`, which returns null for any candidate escaping its scan root. A true cross-package dependent was findable by neither route. The design records this as ruling 5.
7. **`resolveExtraGlobWorkdirs` treats "no workspace packages found" as "scan the whole repo"** (`code-neighbor.ts:344`). So a repo that merely looks like a monorepo to the detector globs its entire tree on every fetch. Removing the scan removes that too — worth one line in the PR body.

**Accepted consequence, state it in the PR body:** with `neighborScope: "repo"` AND `storyIsolation: "worktree"`, the scan root (main checkout) and the consumer root (worktree) are different trees, so absolute comparison finds no reverse deps where the old relative comparison found accidental ones. The accidental ones were wrong. The default scope is `"package"`, where scan root and consumer root are the same directory and nothing changes.

---

### Task 1: Absolute-frame comparison and consumer-frame rendering

**Files:**
- Modify: `src/utils/path-frame.ts` (append `stripUnreadableMarker`)
- Modify: `src/context/engine/providers/code-neighbor.ts:225-320` (`collectNeighbors`), `:376-440` (`fetch`)
- Modify: `src/context/engine/providers/code-neighbor-chunk.ts:145` (scope attribution)
- Test: `test/unit/context/engine/providers/code-neighbor-frame.test.ts` (new)

**Interfaces:**
- Consumes: `UNREADABLE_MARKER` from `@/utils/path-frame` (already exported).
- Produces:
  - `stripUnreadableMarker(value: string): string` in `src/utils/path-frame.ts`
  - `collectNeighbors(filePath: string, consumerRoot: string, repoRoot: string, scannedDirs: ScannedDir[], contentCacheState: ContentCacheState, siblingTestContext?: {...}): Promise<{ neighbors: string[]; truncated: boolean }>` — the second parameter changes meaning from "scan root" to "the absolute dir `filePath` is relative to", and `repoRoot` is new (it is the fallback spelling for a path outside the consumer). Returned `neighbors` are **display strings**: package-relative when readable, repo-rooted plus `UNREADABLE_MARKER` when not.
  - `spellForConsumer(absPath: string, consumerRoot: string, repoRoot: string): string` — the single rendering seam.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context/engine/providers/code-neighbor-frame.test.ts`:

```ts
/**
 * CodeNeighborProvider — path-frame regression suite (nax#2074).
 *
 * Lives beside code-neighbor.test.ts rather than inside it: that file is at
 * 794/800 lines under scripts/check-file-sizes.ts and may not grow.
 *
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _codeNeighborDeps, CodeNeighborProvider } from "@/context/engine/providers/code-neighbor";
import type { ContextRequest } from "@/context/engine/types";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";
import { UNREADABLE_MARKER } from "@/utils/path-frame";

function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

const TEST_PATTERNS = makePatterns(["test/unit/**/*.test.ts"]);

/** Story in packages/app of a monorepo rooted at /repo. */
function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo/packages/app",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    resolvedTestPatterns: TEST_PATTERNS,
    ...overrides,
  };
}

/**
 * `files` is keyed by ABSOLUTE path, because the whole point of this suite is
 * that two packages have identically-spelled relative paths.
 * `globByCwd` maps a scan root to the repo-relative-to-that-root file list the
 * glob returns, exactly as Bun.Glob would with `absolute: false`.
 */
function setupDeps(files: Record<string, string>, globByCwd: Record<string, string[]>) {
  _codeNeighborDeps.fileExists = async (path: string) => path in files;
  _codeNeighborDeps.readFile = async (path: string) => files[path] ?? "";
  _codeNeighborDeps.glob = (_pattern: string, cwd: string) => ({ files: globByCwd[cwd] ?? [], truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
  _codeNeighborDeps.discoverWorkspacePackages = async () => [];
}

let orig: {
  fileExists: typeof _codeNeighborDeps.fileExists;
  readFile: typeof _codeNeighborDeps.readFile;
  glob: typeof _codeNeighborDeps.glob;
  detectLanguage: typeof _codeNeighborDeps.detectLanguage;
  discoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;
};

beforeEach(() => {
  orig = {
    fileExists: _codeNeighborDeps.fileExists,
    readFile: _codeNeighborDeps.readFile,
    glob: _codeNeighborDeps.glob,
    detectLanguage: _codeNeighborDeps.detectLanguage,
    discoverWorkspacePackages: _codeNeighborDeps.discoverWorkspacePackages,
  };
});

afterEach(() => {
  _codeNeighborDeps.fileExists = orig.fileExists;
  _codeNeighborDeps.readFile = orig.readFile;
  _codeNeighborDeps.glob = orig.glob;
  _codeNeighborDeps.detectLanguage = orig.detectLanguage;
  _codeNeighborDeps.discoverWorkspacePackages = orig.discoverWorkspacePackages;
});

function neighborLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("- "));
}

describe("CodeNeighborProvider — path frame (nax#2074)", () => {
  // THE ISSUE'S WORKED EXAMPLE, and the only setup that reproduces the false
  // reverse-dep: it needs the SIBLING scan, where srcFile is relative to
  // packages/lib while filePath is relative to packages/app. Measured against
  // the pre-fix code this returns `- src/helper.ts`.
  //
  // This test is RETIRED in Task 2 Step 4: it pins the behaviour of the scan
  // being deleted. Its durable successor is the "globs only the story's own
  // package" case added there.
  test("a sibling package's same-named import is not a reverse dependency", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/helper.ts": 'import "./index";',
        "/repo/packages/lib/src/index.ts": "export const lib = 1;",
      },
      { "/repo/packages/app": ["src/index.ts"], "/repo/packages/lib": ["src/helper.ts", "src/index.ts"] },
    );
    _codeNeighborDeps.discoverWorkspacePackages = async () => ["packages/app", "packages/lib"];
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).not.toContain("- src/helper.ts");
    expect(lines.some((line) => line.includes("helper.ts"))).toBe(false);
  });

  // The other sign of the same defect. Pre-fix, a repo-rooted scan compares a
  // repo-framed srcFile against a package-framed filePath, so a genuine
  // cross-package dependent matches NOTHING and is silently dropped; the
  // `srcFile === filePath` self-skip would have discarded it anyway had the
  // frames agreed. Measured against the pre-fix code this returns no neighbour
  // at all beyond the sibling-test hint.
  test("a genuine cross-package dependent is found and marked unreadable", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain(`- packages/lib/src/index.ts${UNREADABLE_MARKER}`);
  });

  // A genuine same-package dependent found via a repo-rooted scan must come
  // back package-relative, because the agent's file tools are rooted there.
  test("a dependent inside the consumer's package renders package-relative", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/app/src/user.ts": 'import "./index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/user.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- src/user.ts");
    expect(lines.some((line) => line.includes(UNREADABLE_MARKER))).toBe(false);
  });

  // scopePaths is an attribution key, not prompt text: the marker must not leak
  // into it, or the same file is attributed under two different strings.
  test("scopePaths records the marked neighbour without the marker", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    expect(result.chunks[0]?.scopePaths).toContain("packages/lib/src/index.ts");
    expect(result.chunks[0]?.scopePaths?.some((p) => p.includes(UNREADABLE_MARKER))).toBe(false);
  });

  // The touched file is package-framed by contract (types.ts:329). Under
  // neighborScope "repo" the OLD code resolved it against repoRoot and read
  // nothing, so forward deps silently vanished.
  test("forward deps are resolved against packageDir even when the scan root is the repo", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": 'import "./dep";',
        "/repo/packages/app/src/dep.ts": "export const dep = 1;",
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/dep.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- src/dep.ts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/unit/context/engine/providers/code-neighbor-frame.test.ts --timeout=60000`

Expected: FAIL, 5 of 5. These are the **measured** pre-fix outputs (each list is the `- ` lines of the single chunk), not predictions:

| Test | Pre-fix output | Why it fails |
|---|---|---|
| sibling package's same-named import | `["- src/helper.ts", "- test/unit/index.test.ts"]` | the false reverse-dep the issue reports: `resolveImport` relative to `packages/lib` yields `src/index.ts`, which string-equals the consumer's `filePath` |
| genuine cross-package dependent | `["- test/unit/index.test.ts"]` | repo-framed `srcFile` vs package-framed `filePath` never match, so the real dependent is dropped |
| dependent inside the consumer's package | `["- test/unit/index.test.ts"]` | same frame mismatch under `neighborScope: "repo"` |
| `scopePaths` without the marker | no such neighbour exists yet | same as above |
| forward deps under a repo scan root | `["- test/unit/index.test.ts"]` | `join("/repo", "src/index.ts")` does not exist, so the touched file is never read |

> Note the sibling-test hint `- test/unit/index.test.ts` is present throughout: it is derived from `resolvedTestPatterns` and is unrelated to this fix. Assertions are written so it does not interfere.

- [ ] **Step 3: Add `stripUnreadableMarker` to the path-frame SSOT**

Append to `src/utils/path-frame.ts`, directly beneath the `UNREADABLE_MARKER` declaration:

```ts
/**
 * Remove a trailing UNREADABLE_MARKER from a rendered path.
 *
 * The marker is prompt text, not part of the path. Consumers that use a
 * rendered path as an identity key -- `RawChunk.scopePaths` attribution, for
 * one -- must strip it, or the same file is attributed under two different
 * strings depending on which story rendered it.
 */
export function stripUnreadableMarker(value: string): string {
  return value.endsWith(UNREADABLE_MARKER) ? value.slice(0, -UNREADABLE_MARKER.length) : value;
}
```

- [ ] **Step 4: Split the consumer root from the scan root in `collectNeighbors`**

In `src/context/engine/providers/code-neighbor.ts`, replace the `collectNeighbors` signature and its forward-dep, reverse-dep and sibling-test bodies. The whole function now keeps **absolute** paths in its sets and re-spells once at the end.

Signature and doc comment:

```ts
/**
 * Collect neighbors for a single file: forward deps (JS/TS only), reverse deps
 * (language-aware glob, configurable cap), and sibling tests (ADR-009 SSOT).
 *
 * Two roots, deliberately distinct (nax#2074):
 *   - `consumerRoot` is the absolute dir `filePath` is relative to. It is ALWAYS
 *     `request.packageDir`, because `ContextRequest.touchedFiles` is package-framed
 *     (see src/context/engine/types.ts:329).
 *   - each `ScannedDir.workdir` is the root its `files` are relative to.
 *
 * Under `neighborScope: "repo"` those differ, so no two relative paths here are
 * mutually intelligible. Every comparison is therefore made on absolute paths,
 * and the result is re-spelled for the consumer exactly once, on return.
 *
 * Accepts pre-scanned directory results and a shared content cache so that the
 * glob and file reads are not repeated across touched files in one fetch().
 */
async function collectNeighbors(
  filePath: string,
  consumerRoot: string,
  repoRoot: string,
  scannedDirs: ScannedDir[],
  contentCacheState: ContentCacheState,
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] },
): Promise<{ neighbors: string[]; truncated: boolean }> {
```

Forward deps — store absolute, compare absolute:

```ts
  const forwardNeighbors = new Set<string>();
  let anyTruncated = false;

  const ownAbsPath = join(consumerRoot, filePath);
  if (await _codeNeighborDeps.fileExists(ownAbsPath)) {
    const ownContent = await readCached(ownAbsPath, contentCacheState, _codeNeighborDeps);
    if (ownContent !== null && ownContent.length > 0) {
      for (const spec of parseImportSpecifiers(ownContent)) {
        const resolved = resolveImport(spec, filePath, consumerRoot);
        if (resolved === null) continue;
        const resolvedAbs = join(consumerRoot, resolved);
        if (resolvedAbs !== ownAbsPath) forwardNeighbors.add(resolvedAbs);
      }
    }
  }
```

Reverse deps — both sides absolute, and the emitted value absolute:

```ts
  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const ownAbsNoExt = ownAbsPath.replace(/\.[^./]+$/, "");

  const reverseNeighbors = new Set<string>();
  outer: for (const { workdir: scanWorkdir, files: srcFiles, truncated } of scannedDirs) {
    if (truncated) anyTruncated = true;
    for (const srcFile of srcFiles) {
      if (reverseNeighbors.size >= MAX_NEIGHBORS_PER_FILE) break outer;
      const srcAbs = join(scanWorkdir, srcFile);
      // Absolute self-skip. Comparing `srcFile === filePath` skipped a SIBLING's
      // identically-spelled file and let a sibling's `./index` count as a
      // dependent of ours — nax#2074, both signs of the same defect.
      if (srcAbs === ownAbsPath) continue;
      const content = await readCached(srcAbs, contentCacheState, _codeNeighborDeps);
      if (content?.includes(fileBaseName)) {
        for (const spec of parseImportSpecifiers(content)) {
          const resolved = resolveImport(spec, srcFile, scanWorkdir);
          if (resolved === null) continue;
          const resolvedAbs = join(scanWorkdir, resolved);
          if (resolvedAbs === ownAbsPath || resolvedAbs === ownAbsNoExt) {
            reverseNeighbors.add(srcAbs);
            break;
          }
        }
      }
    }
  }
```

The slot-budget block is unchanged except that the set now holds absolute paths — no edit is needed there.

Sibling test — resolve and store absolute (replace the `join(workdir, candidate)` and the two `neighbors.add`/comparison lines):

```ts
  if (siblingTestContext && !isTestFile(filePath, siblingTestContext.regex)) {
    const candidates = deriveSiblingTestCandidates(filePath, siblingTestContext.globs);
    let chosen: string | null = null;
    for (const candidate of candidates) {
      if (await _codeNeighborDeps.fileExists(join(consumerRoot, candidate))) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) {
      const colocated = candidates[0];
      const mirrored = candidates.find((c, i) => i > 0 && c !== colocated);
      if (mirrored) chosen = mirrored;
    }
    if (chosen !== null && chosen !== filePath) neighbors.add(join(consumerRoot, chosen));
  }
```

Return — re-spell once, here and nowhere else:

```ts
  return {
    neighbors: [...neighbors]
      .slice(0, MAX_NEIGHBORS_PER_FILE)
      .map((abs) => spellForConsumer(abs, consumerRoot, repoRoot)),
    truncated: anyTruncated,
  };
}
```

- [ ] **Step 5: Add the rendering helper**

Add above `collectNeighbors` in the same file, and extend the `node:path` import to include `relative` if it is not already there (it is — `import { join, relative, resolve } from "node:path"`):

```ts
/**
 * Re-spell an absolute neighbour path for the consuming story (nax#2074).
 *
 * Inside the consumer's root -> package-relative, which is what the agent's
 * file tools can open (codingToolRoot, src/agents/types.ts:182-197).
 * Outside it -> repo-rooted and marked: a package-relative spelling would
 * resolve to a real but WRONG file under the consumer's root, so the path
 * carries the same UNREADABLE_MARKER nax#2072 already ships. A path beneath
 * neither root stays absolute -- rare, honest, and still marked.
 *
 * `relative()` on absolute paths is used rather than a derived string prefix:
 * under storyIsolation "worktree" the consumer root and the repo root are
 * different trees, and any prefix derivation silently matches nothing (nax#2069).
 */
function spellForConsumer(absPath: string, consumerRoot: string, repoRoot: string): string {
  const fromConsumer = relative(consumerRoot, absPath);
  if (fromConsumer !== "" && !fromConsumer.startsWith("..")) return fromConsumer;
  const fromRepo = relative(repoRoot, absPath);
  const spelled = fromRepo !== "" && !fromRepo.startsWith("..") ? fromRepo : absPath;
  return `${spelled}${UNREADABLE_MARKER}`;
}
```

Import the marker at the top of the file:

```ts
import { UNREADABLE_MARKER } from "@/utils/path-frame";
```

> One seam, not two. An earlier draft marked the path in `collectNeighbors` and re-spelled it repo-rooted in `fetch()`, which meant parsing a marker off a string the same change had just built. Pass `repoRoot` down instead.

- [ ] **Step 6: Thread the two roots through `fetch()`**

In `CodeNeighborProvider.fetch`, `workdir` is now unambiguously the SCAN root. Rename it and pass `request.packageDir` as the consumer root. Replace the `collectNeighbors` call and add the repo-rooted re-spelling of marked paths:

```ts
    // The scan root: where the reverse-dep glob runs. NOT the frame the touched
    // files are in — those are package-framed (types.ts:329) and resolved
    // against request.packageDir inside collectNeighbors (nax#2074).
    const scanRoot = this.neighborScope === "package" ? request.packageDir : request.repoRoot;
```

Every other use of the old `workdir` local in `fetch()` (`request.naxIgnoreIndex?.getMatchers(workdir)` and the `scanDirectory(...)` call) becomes `scanRoot`. Then, at the call site:

```ts
      const { neighbors, truncated } = await collectNeighbors(
        file,
        request.packageDir,
        request.repoRoot,
        scannedDirs,
        contentCacheState,
        siblingTestContext,
      );
      if (truncated) anyTruncated = true;
      if (neighbors.length > 0) {
        sections.push({ file, neighbors });
      }
```

The `sections.push` line is unchanged from today: `file` stays the package-framed touched file (that is what the consumer can open), and `neighbors` arrive already rendered.

- [ ] **Step 7: Keep the marker out of `scopePaths`**

In `src/context/engine/providers/code-neighbor-chunk.ts`, import the stripper and use it for attribution only (the rendered length must stay the rendered length):

```ts
import { stripUnreadableMarker } from "@/utils/path-frame";
```

and in the neighbour loop of `assembleCodeNeighborChunk`:

```ts
      // Attribution uses the bare path: the marker is prompt text, and a
      // scopePaths key carrying it would split one file into two identities.
      // `end` still measures the RENDERED length, marker included.
      renderedPaths.push({ path: stripUnreadableMarker(neighbor), end: cursor + neighbor.length });
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `bun test ./test/unit/context/engine/providers/code-neighbor-frame.test.ts --timeout=60000`

Expected: PASS, 5 tests.

- [ ] **Step 9: Run the existing neighbour suites for regressions**

Run:
```bash
bun test ./test/unit/context/engine/providers/code-neighbor.test.ts ./test/unit/context/engine/providers/code-neighbor-chunk.test.ts ./test/unit/context/engine/providers/code-neighbor-cap.test.ts ./test/unit/context/engine/providers/code-neighbor-cache-budget.test.ts ./test/unit/context/engine/providers/code-neighbor-scan-cost.test.ts ./test/unit/context/engine/providers/code-neighbor-size-cap.test.ts --timeout=60000
```

Expected: PASS. These fixtures all use `packageDir === repoRoot` or a package-scoped provider, so the re-spelling is an identity and their assertions on `- src/x.ts` lines are unchanged. If one fails on a path spelling, the fixture is asserting a cross-root collision — read it before changing it, and record which in the commit message.

- [ ] **Step 10: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. If `check:file-sizes` complains, the growth is in `code-neighbor.ts`; Task 2 removes more than this task added, so temporarily verify with `bun run check:file-sizes` after Task 2 as well.

- [ ] **Step 11: Commit**

```bash
git add src/utils/path-frame.ts src/context/engine/providers/code-neighbor.ts src/context/engine/providers/code-neighbor-chunk.ts test/unit/context/engine/providers/code-neighbor-frame.test.ts
git commit -m "fix(context): compare neighbour paths absolutely and render in the consumer frame (#2074)"
```

---

### Task 2: Remove the cross-package reverse scan

**Files:**
- Modify: `src/context/engine/providers/code-neighbor.ts` — delete `resolveExtraGlobWorkdirs` (`:326-352`), the `discoverWorkspacePackages` dep (`:105`) and its import (`:12`), the `crossPackageDepth` option (`:36-41`), field and constructor line, and the `extraGlobWorkdirs` block in `fetch()`
- Modify: `test/unit/context/engine/providers/code-neighbor.test.ts` — delete the AC-62 cases in the `AC-56/AC-62` describe block (`:391-475`), retitle the block, drop the `discoverWorkspacePackages` save/restore
- Modify: `test/unit/context/engine/providers/code-neighbor-cache-budget.test.ts:93`, `code-neighbor-scan-cost.test.ts:96,122,125`, `code-neighbor-size-cap.test.ts:100,122,146,166,186,221` — drop the now-invalid `crossPackageDepth: 0` constructor option
- Modify: `test/unit/context/engine/providers/code-neighbor-cap.test.ts` — it also saves/restores and stubs `_codeNeighborDeps.discoverWorkspacePackages`; remove those lines (grep it: `grep -n discoverWorkspacePackages test/unit/context/engine/providers/*.ts`)
- Modify: `test/unit/context/engine/providers/code-neighbor-frame.test.ts` — **retire** Task 1's first case (see Step 4); its `setupDeps` sibling fixture and the `discoverWorkspacePackages` stub go with it

**Interfaces:**
- Consumes: Task 1's `collectNeighbors(filePath, consumerRoot, scannedDirs, ...)`.
- Produces: `CodeNeighborProviderOptions` without `crossPackageDepth`; `scannedDirs` is always a one-element array (kept an array so `ScannedDir` and the loop shape are untouched, and so `neighborScope: "repo"` still carries its own root).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/context/engine/providers/code-neighbor-frame.test.ts`, inside a new describe:

```ts
describe("CodeNeighborProvider — cross-package scan removal (nax#2074)", () => {
  // parseImportSpecifiers keeps only "."-prefixed specifiers, so a real
  // cross-package import is never collected and the sibling scan could only
  // ever produce false matches. It must not run, and must not be paid for.
  test("package scope globs only the story's own package, never a sibling", async () => {
    const globbedRoots: string[] = [];
    const globByCwd: Record<string, string[]> = {
      "/repo/packages/app": ["src/index.ts"],
      "/repo/packages/lib": ["src/helper.ts"],
      "/repo": ["packages/app/src/index.ts", "packages/lib/src/helper.ts"],
    };
    setupDeps({ "/repo/packages/app/src/index.ts": "export const app = 1;" }, globByCwd);
    // Record the scan roots instead of delegating: setupDeps' stub takes two
    // parameters while the real dep takes five, so a pass-through wrapper only
    // adds a typing problem.
    _codeNeighborDeps.glob = (_pattern: string, cwd: string) => {
      globbedRoots.push(cwd);
      return { files: globByCwd[cwd] ?? [], truncated: false };
    };

    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    expect(globbedRoots).toEqual(["/repo/packages/app"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/context/engine/providers/code-neighbor-frame.test.ts --timeout=60000`
Expected: FAIL — `setupDeps` stubs `discoverWorkspacePackages` to `[]`, and `resolveExtraGlobWorkdirs` treats an empty workspace as "scan the whole repo" (`code-neighbor.ts:344`), so `globbedRoots` is `["/repo/packages/app", "/repo"]`. That fallback is itself worth noting in the PR body: today a single-package repo misdetected as a monorepo globs the entire tree on every fetch.

- [ ] **Step 3: Delete the sibling scan**

In `src/context/engine/providers/code-neighbor.ts`:

1. Delete the whole `AC-62 workspace detection helper` section — the banner comment and `resolveExtraGlobWorkdirs` (`:322-352`).
2. Delete `discoverWorkspacePackages` from `_codeNeighborDeps` and the `import { discoverWorkspacePackages } from "@/test-runners/detect";` line.
3. Delete the `crossPackageDepth` entry from `CodeNeighborProviderOptions`, the `private readonly crossPackageDepth: number;` field, and `this.crossPackageDepth = options.crossPackageDepth ?? 1;`.
4. In `fetch()`, delete the `const extraGlobWorkdirs = await resolveExtraGlobWorkdirs(...)` block and the `if (extraGlobWorkdirs) { ... }` loop, leaving:

```ts
    // One scan root. A sibling-package scan was removed in nax#2074: bare
    // specifiers are never parsed (parseImportSpecifiers, above), so a true
    // cross-package dependent was never findable, and the only cross-package
    // matches the scan could produce were false ones.
    const scannedDirs: ScannedDir[] = [scanDirectory(sourceGlob, scanRoot, ignoreMatchers, this.maxGlobFiles, globCtx)];
```

5. Fix the stale sentence in the `maxGlobFiles` doc comment (`:47-51`), which describes the removed multiplication:

```ts
  /**
   * Maximum files scanned per directory during reverse-dep glob (#895).
   * Default: 500 (raised from 200; language-aware glob reduces noise).
   * One scan root per fetch since nax#2074, so this is also the per-fetch cap.
   */
```

- [ ] **Step 4: Update the affected test fixtures**

In `test/unit/context/engine/providers/code-neighbor.test.ts`:
- delete the `origDiscoverWorkspacePackages` declaration, its two save/restore lines and the `_codeNeighborDeps.discoverWorkspacePackages = async () => [];` default in `beforeEach`
- in the `AC-56/AC-62` describe: retitle to `describe("CodeNeighborProvider — AC-56 neighborScope", ...)`, keep the case asserting `neighborScope` selects `packageDir` vs `repoRoot`, and delete the three cases that exercise `crossPackageDepth` (`:417-475`), since the behaviour they pin no longer exists

In `code-neighbor-cache-budget.test.ts`, `code-neighbor-scan-cost.test.ts` and `code-neighbor-size-cap.test.ts`: replace `new CodeNeighborProvider({ crossPackageDepth: 0 })` with `new CodeNeighborProvider()` — `0` was the way to ask for what is now the only behaviour. In `code-neighbor-scan-cost.test.ts:125`, update the comment `With 5 touched files but crossPackageDepth=0, the glob must be called...` to `With 5 touched files, the single scan root is globbed once...`.

In `code-neighbor-cap.test.ts`, `code-neighbor-cache-budget.test.ts`, `code-neighbor-scan-cost.test.ts` and `code-neighbor-size-cap.test.ts`: delete every save/restore/stub of `_codeNeighborDeps.discoverWorkspacePackages`. The dep no longer exists, so those lines are type errors, not dead code.

In `code-neighbor-frame.test.ts`, also delete `_codeNeighborDeps.discoverWorkspacePackages` from `setupDeps`, from the `orig` capture and from the `afterEach` restore — the dep is gone, so those are type errors.

In `code-neighbor-frame.test.ts`, **delete Task 1's first case** (`a sibling package's same-named import is not a reverse dependency`). It pins the sibling scan, which this task removes; keeping it would assert that a code path that no longer runs behaves correctly. The case added in Step 1 above is its successor and is strictly stronger — the scan cannot false-positive if it never runs. Say so in the commit message so the deletion is not read as a dropped guard.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
bun test ./test/unit/context/engine/providers/ --timeout=60000
```
Expected: PASS, including the new scan-removal case.

- [ ] **Step 6: Verify the file shrank**

Run: `bun run check:file-sizes && bun run typecheck && bun run lint`
Expected: clean; `code-neighbor.ts` is below its Task 1 size.

- [ ] **Step 7: Commit**

```bash
git add src/context/engine/providers/code-neighbor.ts test/unit/context/engine/providers/
git commit -m "refactor(context): drop the cross-package reverse scan that can only match falsely (#2074)"
```

---

### Task 3: Retire the `crossPackageDepth` config key

**Files:**
- Modify: `src/config/schemas-context.ts:239-244,259`, `src/config/runtime-types-context.ts:156`, `src/context/engine/orchestrator-factory.ts:95`
- Modify: `src/config/compat-shims.ts` (new `_applyRemovedCrossPackageDepthShim`, wired into `applyConfigCompatShims`)
- Modify: `test/unit/context/engine/orchestrator-factory.test.ts:57,67,135,253`, `test/unit/context/engine/prior-run-failure-factory.test.ts:56`, `test/unit/context/engine/lint-config-factory.test.ts:40`, `test/unit/config/context-manifest-retention.test.ts:41`
- Test: `test/unit/config/deprecation-cross-package-depth.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks (the provider option is already gone).
- Produces: `_applyRemovedCrossPackageDepthShim(conf: Record<string, unknown>, warn?: (msg: string) => void): Record<string, unknown>` in `src/config/compat-shims.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/deprecation-cross-package-depth.test.ts`:

```ts
/**
 * context.v2.providers.crossPackageDepth removal (nax#2074).
 *
 * Zod runs in .strip() mode, so an unknown key would load SILENTLY. A removed
 * knob that vanishes without a word is the declared-but-inert class this
 * change exists to close, so the shim warns and drops it explicitly.
 */

import { describe, expect, test } from "bun:test";
import { _applyRemovedCrossPackageDepthShim } from "@/config/compat-shims";

describe("_applyRemovedCrossPackageDepthShim", () => {
  test("warns once and drops the key, leaving sibling provider keys intact", () => {
    const warnings: string[] = [];
    const conf = {
      context: { v2: { providers: { neighborScope: "package", crossPackageDepth: 2, maxGlobFiles: 500 } } },
    };

    const out = _applyRemovedCrossPackageDepthShim(conf, (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("context.v2.providers.crossPackageDepth");
    const providers = (out.context as { v2: { providers: Record<string, unknown> } }).v2.providers;
    expect("crossPackageDepth" in providers).toBe(false);
    expect(providers.neighborScope).toBe("package");
    expect(providers.maxGlobFiles).toBe(500);
  });

  test("is a no-op — same object, no warning — when the key is absent", () => {
    const warnings: string[] = [];
    const conf = { context: { v2: { providers: { neighborScope: "repo" } } } };

    const out = _applyRemovedCrossPackageDepthShim(conf, (m) => warnings.push(m));

    expect(out).toBe(conf);
    expect(warnings).toHaveLength(0);
  });

  test("does not mutate the input config", () => {
    const conf = { context: { v2: { providers: { crossPackageDepth: 1 } } } };

    _applyRemovedCrossPackageDepthShim(conf, () => {});

    expect((conf.context.v2.providers as Record<string, unknown>).crossPackageDepth).toBe(1);
  });

  test("leaves a config with no context block alone", () => {
    const conf = { review: {} };
    expect(_applyRemovedCrossPackageDepthShim(conf, () => {})).toBe(conf);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/config/deprecation-cross-package-depth.test.ts --timeout=60000`
Expected: FAIL — `_applyRemovedCrossPackageDepthShim` is not exported from `@/config/compat-shims`.

- [ ] **Step 3: Add the shim**

In `src/config/compat-shims.ts`, add beside `_applyRemovedOptimizerKeysShim` (same shape, same immutability contract):

```ts
/**
 * @internal Drop the removed `context.v2.providers.crossPackageDepth` (nax#2074).
 *
 * Its only consumer was CodeNeighborProvider's sibling reverse scan, which was
 * removed because `parseImportSpecifiers` never collects bare specifiers: the
 * scan could not find a true cross-package dependent, only false ones. The key
 * now controls nothing.
 *
 * Dropped with a warning rather than rejected so an existing config keeps
 * loading. Returns a new object (immutable -- does not mutate the input).
 */
export function _applyRemovedCrossPackageDepthShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const context = conf.context as Record<string, unknown> | undefined;
  const v2 = context?.v2 as Record<string, unknown> | undefined;
  const providers = v2?.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== "object" || !("crossPackageDepth" in providers)) return conf;

  warn(
    "context.v2.providers.crossPackageDepth was removed (nax#2074) and has no effect. " +
      "Cross-package reverse-dependency scanning is unsupported: only relative import specifiers are parsed, " +
      "so the scan could never find a true cross-package dependent. Remove the key; use neighborScope to widen the scan root.",
  );

  const { crossPackageDepth: _removed, ...restProviders } = providers;
  return {
    ...conf,
    context: { ...context, v2: { ...v2, providers: restProviders } },
  };
}
```

Wire it into `applyConfigCompatShims`, after `_applyRemovedOptimizerKeysShim`:

```ts
  out = _applyRemovedCrossPackageDepthShim(out, warn);
```

- [ ] **Step 4: Run the shim test to verify it passes**

Run: `bun test ./test/unit/config/deprecation-cross-package-depth.test.ts --timeout=60000`
Expected: PASS, 4 tests.

- [ ] **Step 5: Remove the key from the config surface**

- `src/config/schemas-context.ts`: delete the `crossPackageDepth` field and its doc comment (`:239-244`), and remove it from the block `.default({ historyScope: "package", neighborScope: "package", maxGlobFiles: 500 })` (`:259`).
- `src/config/runtime-types-context.ts:155-156`: delete the `crossPackageDepth: number;` member and its comment.
- `src/context/engine/orchestrator-factory.ts:95`: delete the `crossPackageDepth: providerConfig?.crossPackageDepth ?? 1,` line.
- Test fixtures: delete the `crossPackageDepth` entries at `test/unit/context/engine/orchestrator-factory.test.ts:57,67,135,253`, `test/unit/context/engine/prior-run-failure-factory.test.ts:56`, `test/unit/context/engine/lint-config-factory.test.ts:40`, `test/unit/config/context-manifest-retention.test.ts:41`. At `orchestrator-factory.test.ts:2` the header comment names the key — amend it to `#507 — historyScope / neighborScope not in config schema.`

- [ ] **Step 6: Run the config and factory suites**

Run:
```bash
bun test ./test/unit/config/ ./test/unit/context/engine/ --timeout=60000
```
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: clean, all green. A failure naming `crossPackageDepth` is a missed call site — grep for it: `grep -rn "crossPackageDepth" src test`.

- [ ] **Step 8: Commit**

```bash
git add src/config src/context/engine/orchestrator-factory.ts test/unit/config test/unit/context/engine
git commit -m "feat(config)!: remove context.v2.providers.crossPackageDepth (#2074)"
```

---

### Task 4: Amend the ADR, guides, specs and rules

**Files:**
- Modify: `docs/adr/ADR-010-context-engine.md:190`
- Modify: `docs/guides/context-engine.md:416,427,475`
- Modify: `docs/guides/context-providers.md:11`
- Modify: `docs/specs/SPEC-context-engine-v2-compilation.md:306`
- Modify: `docs/specs/SPEC-context-engine-v2-amendments.md:470,492`
- Modify: `docs/specs/SPEC-effectiveness-scoring-loop.md:242`
- Modify: `.nax/rules/monorepo-awareness.md:140` (+ regenerated `.claude/rules/` mirror)

**Interfaces:**
- Consumes: the behaviour shipped in Tasks 1-3. Produces no code.

- [ ] **Step 1: Amend ADR-010**

Replace `docs/adr/ADR-010-context-engine.md:190`:

```markdown
- `CodeNeighborProvider.neighborScope: "package" | "repo"` (default `package`). Cross-package reverse-dependency scanning is NOT supported: only relative (`.`-prefixed) import specifiers are parsed, so a bare `@scope/pkg` import is never seen and a true cross-package dependent cannot be found. The `crossPackageDepth` knob that once configured it was removed in nax#2074 — it scanned every sibling package on every fetch and could only return false matches.
```

- [ ] **Step 2: Amend the context-engine guide**

- `:410-419` — delete the `"crossPackageDepth": 1` line from the JSON example (and the trailing comma on the preceding line).
- `:427` — delete the `providers.crossPackageDepth` table row and add, beneath the table:

```markdown
> Cross-package reverse-dependency scanning is unsupported. `CodeNeighborProvider` parses only relative import specifiers, so a dependent in another package that imports by package name is invisible to it. The `providers.crossPackageDepth` key was removed in nax#2074; a config that still sets it loads with a deprecation warning and the key is ignored. To widen the scan root, set `providers.neighborScope: "repo"`.
```

- `:475` — delete the `providers.crossPackageDepth` row from the key reference table.

- [ ] **Step 3: Amend the providers guide**

`docs/guides/context-providers.md:11` — delete the `crossPackageDepth` row and, if the table has a following note section, add the same one-line statement: cross-package reverse-deps are unsupported (relative specifiers only), removed in nax#2074.

- [ ] **Step 4: Amend the three specs**

- `docs/specs/SPEC-context-engine-v2-compilation.md:306` — in the CodeNeighbor row, replace the `crossPackageDepth: 0 | 1 | 2 (default 1)` cell with `cross-package scan: unsupported (removed, nax#2074)`.
- `docs/specs/SPEC-context-engine-v2-amendments.md:470` — append to the mitigation paragraph: `**Superseded (nax#2074):** the cross-package scan was removed. Only relative import specifiers are parsed, so cross-package reverse-deps were never findable and the scan produced only false matches. Widen with neighborScope: "repo" instead.`
- `docs/specs/SPEC-context-engine-v2-amendments.md:492` (AC-62) — mark it: `62. **Cross-package neighbor resolution.** ~~...~~ **Withdrawn (nax#2074)** — unimplementable as written: bare package-name specifiers are never parsed.`
- `docs/specs/SPEC-effectiveness-scoring-loop.md:242` — the out-of-scope line references `crossPackageDepth > 0`; restate it as `US-002 only: scope is recorded for the paths the chunk renders. (The cross-package scan this line anticipated was removed in nax#2074.)`

- [ ] **Step 5: Amend the canonical rule and regenerate the mirror**

`.nax/rules/monorepo-awareness.md:140` — delete the `cross-package` row from the provider-scope table and add beneath it:

```markdown
There is no `cross-package` scope. `CodeNeighborProvider`'s sibling scan was removed in nax#2074: it parsed only relative import specifiers, so it could not find a true cross-package dependent, and it compared paths across two roots. A provider that must see another package sets its scan root to `repoRoot` and re-spells every emitted path for the consumer (`src/utils/path-frame.ts`).
```

Then regenerate and verify:

```bash
bun run dev rules export --agent=claude
bun run check:rules-drift
```

Expected: `check:rules-drift` exits 0. **Never hand-edit `.claude/rules/`.**

- [ ] **Step 6: Verify no stale references remain**

Run: `grep -rn "crossPackageDepth\|resolveExtraGlobWorkdirs\|extraGlobWorkdirs" src test docs .nax .claude`

Expected matches, and nothing else:
- `docs/superpowers/` — this plan, the design spec, the two earlier plans. Historical; leave them.
- `src/config/compat-shims.ts` + `test/unit/config/deprecation-cross-package-depth.test.ts` — the shim names the key on purpose.
- the docs sentences written in Steps 1-5, which name the removed key deliberately.
- **`.nax/features/effectiveness-scoring-loop/prd.json` (2 hits) — DO NOT EDIT.** It is a completed run's stored PRD, an artifact of what was planned in the past, not a description of current behaviour. Editing it would falsify a record.

Anything else is a missed site.

- [ ] **Step 7: Commit**

```bash
git add docs .nax/rules .claude/rules
git commit -m "docs: record that cross-package reverse-deps are unsupported (#2074)"
```

---

### Task 5: Full verification and PR

**Files:** none modified; this task produces evidence and the PR.

- [ ] **Step 1: Run the full gate**

Run:
```bash
bun run check:all && bun run test && bun run typecheck
```
Expected: all green. Paste the real tail of each into the PR body — no summarising a run you did not read.

- [ ] **Step 2: Run coverage**

Run: `bun run test:coverage`
Expected: passes. It is not part of `check:all`; this plan adds no `src/` file, but Task 1 adds exported functions, so run it once.

- [ ] **Step 3: Code review BEFORE pushing**

Dispatch the repo's post-implementation review against the design spec (`docs/superpowers/specs/2026-09-16-path-frame-convention-design.md`, the `#2074` section) — `nax-toolkit:post-impl-review`. Address CRITICAL and HIGH findings, then re-run Step 1. Do not push first and review after.

- [ ] **Step 4: Push and open the PR**

```bash
git log origin/main..HEAD --oneline
git push -u origin fix/2074-neighbor-frame
```

Check `git log origin/main..HEAD` first: a worktree branches from the current local HEAD, not `origin/main`, so confirm the commit list is exactly this plan's four commits.

PR body must state, in its own section:

- **Closes #2074.** Final row of the path-frame arc (PRs 1-4 merged: #2071 via #2078, #2067 via #2081).
- **Breaking config change:** `context.v2.providers.crossPackageDepth` removed. Existing configs load; the key warns once and is ignored.
- **Behaviour removed on purpose:** the sibling-package reverse scan. It could only produce false matches (bare specifiers are never parsed) and globbed every sibling package on every fetch.
- **Accepted consequence:** with `neighborScope: "repo"` AND `storyIsolation: "worktree"`, scan root and consumer root are different trees, so no reverse deps are reported where the old code reported accidental ones. Default scope is `"package"`, where the two roots are identical and nothing changes.
- **Verification is unit-level.** No live `nax` run, no `monorepo-tiny` fixture — consistent with the 09-16 ruling on PR 4. The end-to-end "zero failed `Read` calls" metric in the design spec's Testing section is therefore **not** measured here; say so plainly rather than implying it was.

---

## Self-Review

**Spec coverage** (design spec §"#2074 — sibling-frame neighbours"):

| Spec requirement | Task |
|---|---|
| Absolute comparison, both sides (`:257`, `:262`) | 1 |
| Rendering via package frame + exported `UNREADABLE_MARKER` | 1 (Steps 5-6) |
| Remove `resolveExtraGlobWorkdirs`; restrict `scannedDirs` | 2 |
| Retire `crossPackageDepth` from options, factory, runtime types, schemas | 2 (option) + 3 (config) |
| Existing config with the key keeps loading, with a deprecation warning | 3 |
| ADR-010 + `context-engine.md` amendments | 4 |
| `SPEC-context-engine-v2-compilation.md:306`, `-amendments.md:470,492`, `SPEC-effectiveness-scoring-loop.md:242` | 4 |
| Regression test from the issue's worked example, incl. the self-skip | 1 (Steps 1-2), superseded in 2 (Step 4) |

**Pre-fix outputs in Task 1 Step 2 are measured, not predicted.** The five fixtures were run against `main` @ `503ebd3d1` while this plan was being reviewed. That run corrected a real defect in an earlier draft: the worked-example test had been written with `neighborScope: "repo"`, where it **passes vacuously** — the false reverse-dep needs the sibling scan, because only there do `srcFile` and `filePath` share a spelling. A repo-rooted scan produces the opposite failure (the genuine dependent is dropped), which is now its own case. If you rewrite these fixtures, re-measure; do not trust the reasoning.

**The self-skip defect is not independently observable through the public API.** With the sibling scan, a sibling that genuinely imports the consumer's file cannot be resolved at all — `resolveImport` refuses to return an escaping path (`code-neighbor.ts:183-184`) — so the skip has nothing to hide. It is observable only under a repo-rooted scan, which is what the second Task 1 case exercises. Do not add a test claiming to prove more than that.

Two additions beyond the spec's letter, both required for the letter to be correct:
1. **The touched file is resolved against `packageDir`, not the scan root.** Absolute comparison is only sound if each side is joined to the root its spelling belongs to, and `touchedFiles` is package-framed by contract. Without this the `"repo"`-scope case compares a correct absolute path against a fabricated one.
2. **`stripUnreadableMarker` for `scopePaths`.** Rendering the marker into the neighbour string would otherwise put prompt text into an attribution key. Design seam #10 (frame-dependent `scopePaths`) stays out of scope; this only prevents the plan from making it worse.

One deliberate deviation: rendering uses `relative()` on absolute paths rather than `toPackageFrame(path, prefix)`. `toPackageFrame` needs a repo-relative prefix, and deriving one as `relative(repoRoot, packageDir)` is exactly the #2069 worktree trap `reframe.ts:70-78` warns against. The marker and its semantics are unchanged, which is what "byte-identical to #2072" was protecting.

**Placeholder scan:** none — every code step carries the literal code, every test step the literal assertions, every run step the exact command and its expected outcome.

**Type consistency:** `collectNeighbors(filePath, consumerRoot, repoRoot, scannedDirs, contentCacheState, siblingTestContext?)` is used with that arity in Task 1 Step 6 and unchanged by Task 2; `spellForConsumer(absPath, consumerRoot, repoRoot)` is defined in Task 1 Step 5 and called only from `collectNeighbors`' return; `stripUnreadableMarker` is defined in Task 1 Step 3 and consumed in Step 7; `_applyRemovedCrossPackageDepthShim(conf, warn?)` is defined and wired in Task 3 Step 3 with the signature its test imports in Step 1.

**Read Tasks 1 and 2 as one PR.** Task 1 adds a test that Task 2 deletes, deliberately (it pins the scan being removed). A reviewer reading Task 1's commit alone will see a guard disappear one commit later; the commit messages say why.
