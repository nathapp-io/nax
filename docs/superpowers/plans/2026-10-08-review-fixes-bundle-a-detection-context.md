# Review Fixes Bundle A — Test-File Detection + Plan Digest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** Stop review from silently dropping implementation files (Rust, Python, colocated-test layouts) and stop the plan digest from being rendered and billed twice.

**Architecture:** Four tasks in `packages/nax`. Task 1 makes the orchestrator choose ONE carrier for the prior-stage digest. Task 2 fixes the shared glob→review-exclusion translation that turns any test glob into "exclude every file with this extension" or "exclude this whole directory" — the root cause behind finding #2, which also hits pytest and vitest-colocated projects. Task 3 removes the wrong Cargo default. Task 4 makes the Tier-3 file scan see `test_*.py`.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #1, #2, #28.

**Branch:** `git fetch origin && git checkout -b fix/review-a-detection-context origin/main`

## Global Constraints

See the master plan. Bundle-specific: `packages/nax/src/context/engine/orchestrator.ts` is 573 lines (cap 600, budget +27). Every other src file here is well under the cap.

## Review Focus

See the master plan. This bundle owns Review Focus line 1 (polyglot repo), pinned in Task 2.

## Files

- Modify: `packages/nax/src/context/engine/orchestrator.ts` (Task 1)
- Modify: `packages/nax/src/test-runners/conventions.ts` (Task 2)
- Modify: `packages/nax/src/test-runners/resolver.ts` (Task 2)
- Modify: `packages/nax/src/test-runners/detect/framework-defaults.ts:132-139` (Task 3)
- Modify: `packages/nax/src/test-runners/detect/file-scan.ts:68-99, 197-212` (Task 4)
- Test: `packages/nax/test/unit/context/engine/orchestrator.test.ts` (749 lines; +~20)
- Test: `packages/nax/test/unit/test-runners/conventions.test.ts` (142 lines)
- Test: `packages/nax/test/unit/test-runners/resolver.test.ts` (411 lines)
- Test: `packages/nax/test/unit/test-runners/detect.test.ts` (588 lines)

---

### Task 1: The prior-stage digest has exactly one carrier (#1)

When `planDigestBoost > 1` the orchestrator injects the digest as a scored `plan-digest` chunk (AC-51) AND every renderer still prepends `## Prior Stage Summary`, AND the budget reserves the digest's tokens up front, AND `buildManifest` adds them to `usedTokens` again. When the digest travels as a chunk, the chunk is the only carrier: no preamble, no up-front reserve, no extra manifest tokens.

**Files:**
- Modify: `packages/nax/src/context/engine/orchestrator.ts:243-248, 360, 448, 477-481`
- Test: `packages/nax/test/unit/context/engine/orchestrator.test.ts`

**Interfaces:**
- Consumes: `ContextRequest.priorStageDigest?: string`, `ContextRequest.planDigestBoost?: number` (`context/engine/types.ts`).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("ContextOrchestrator.assemble()", ...)` block in `orchestrator.test.ts` (it is the block that already holds the "AC-6" tests; put this right after `"AC-6: whitespace-only priorStageDigest does not inflate manifest.usedTokens"`):

```ts
  test("a boosted plan digest is carried once: one copy in the prompt, one count in usedTokens", async () => {
    const digest = "Plan digest: edit src/a.ts, then wire it into src/b.ts.";
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "c:1", tokens: 300, content: "alpha content" })),
    ]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, priorStageDigest: digest, planDigestBoost: 1.5 });

    // The digest competes as a packed chunk (AC-51) ...
    expect(bundle.manifest.includedChunks.some((id) => id.startsWith("plan-digest:"))).toBe(true);
    // ... so it must not ALSO be prepended as the legacy preamble.
    expect(bundle.pushMarkdown).not.toContain("## Prior Stage Summary");
    expect(bundle.pushMarkdown.split(digest).length - 1).toBe(1);
    // usedTokens is exactly the packed chunks (the digest chunk included), with no second digest count.
    const tokenMap = bundle.manifest.chunkTokens ?? {};
    const includedSum = bundle.manifest.includedChunks.reduce((sum, id) => sum + (tokenMap[id] ?? 0), 0);
    expect(bundle.manifest.usedTokens).toBe(includedSum);
  });

  test("an unboosted prior-stage digest keeps the legacy preamble", async () => {
    const digest = "Prior stage found X.";
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "c:1", tokens: 300, content: "alpha content" })),
    ]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, priorStageDigest: digest, planDigestBoost: 1.0 });

    expect(bundle.pushMarkdown).toContain("## Prior Stage Summary");
    expect(bundle.manifest.includedChunks.some((id) => id.startsWith("plan-digest:"))).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify the first test fails**

Run (from `packages/nax`): `timeout 30 bun test test/unit/context/engine/orchestrator.test.ts --timeout=5000`
Expected: the first new test FAILS on `not.toContain("## Prior Stage Summary")` (the preamble is still rendered). The second new test passes (it pins today's unboosted behaviour).

- [ ] **Step 3: Implement**

In `orchestrator.ts`, inside `assemble()`:

1. Replace the two lines at 243-244:

```ts
    const trimmedPriorDigest = request.priorStageDigest?.trim();
    const priorDigestTokens = trimmedPriorDigest ? Math.ceil(trimmedPriorDigest.length / 4) : 0;
```

with:

```ts
    const trimmedPriorDigest = request.priorStageDigest?.trim();
    // AC-51: a boosted digest travels as a packed `plan-digest` chunk, which pays for itself
    // inside the packer; the preamble, its up-front reserve and its manifest count are the
    // OTHER carrier and must all be off, or the digest is rendered and billed twice.
    const digestAsChunk = Boolean(request.priorStageDigest) && (request.planDigestBoost ?? 1.0) > 1.0;
    const priorDigestTokens = trimmedPriorDigest && !digestAsChunk ? Math.ceil(trimmedPriorDigest.length / 4) : 0;
```

2. Change the AC-51 condition at line ~360 (now shifted by +3) from:

```ts
    if (request.priorStageDigest && (request.planDigestBoost ?? 1.0) > 1.0) {
```

to:

```ts
    if (digestAsChunk && request.priorStageDigest) {
```

(The `&& request.priorStageDigest` keeps TypeScript's narrowing for the `createHash(...).update(request.priorStageDigest)` line below.)

3. Change the render options line (~448) from:

```ts
    const renderOptions = { priorStageDigest: request.priorStageDigest };
```

to:

```ts
    const renderOptions = { priorStageDigest: digestAsChunk ? undefined : request.priorStageDigest };
```

4. In the `buildManifest({ ... })` call (~477), change the `request,` property to:

```ts
      request: digestAsChunk ? { ...request, priorStageDigest: undefined } : request,
```

`buildManifest` counts `request.priorStageDigest` as rendered preamble tokens (`manifest-builder.ts:152-164`); with the digest carried as a chunk its tokens are already in the packer's `usedTokens`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/context/engine/ --timeout=5000`
Expected: PASS, including every existing AC-6 / AC-7 / rebuild test (`rebuildForAgent` is untouched: production callers pass no `priorStageDigest`, `operations/build-hop-callback.ts:56`, and the digest chunk is already in `prior.chunks`).

Run: `wc -l src/context/engine/orchestrator.ts` — expect ≤ 600.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/context/engine/orchestrator.ts packages/nax/test/unit/context/engine/orchestrator.test.ts
git commit -m "fix(context): carry a boosted plan digest once, not as chunk + preamble (review #1)"
```

---

### Task 2: Test globs never exclude implementation files from review (#2 root cause)

`globsToPathspec` keeps only the text after the LAST `*`, so `src/**/*.rs`, `tests/**/*.py` and `test_*.py` all become `:!*.rs` / `:!*.py` — every file of that language leaves the review diff. Separately, `resolveReviewExcludePatterns` turns every literal first glob segment into a whole-directory exclusion, so a vitest include of `src/**/*.test.ts` produces `:!src/`. Fix both translations; keep `extractTestDirs` unchanged because its other two consumers (`verification/smart-runner.ts:224`, `context/test-scanner/index.ts:229`) use it as "where tests may live", where `src` is correct.

New rules:
- `globsToPathspec`: look at the LAST path segment (the filename glob).
  - No `*` in it → skip (unchanged behaviour).
  - Starts with `*` → suffix = text after its last `*`. Skip when the suffix is empty or a bare extension (`/^\.[A-Za-z0-9]+$/`), because "every `.py` file" is not a test-file rule (any directory part is handled by the directory exclusion). Otherwise emit `:!*<suffix>` (unchanged for `*.test.ts`, `*_test.go`, `*.spec.ts`, `*_test.py`).
  - Has a literal prefix before its first `*` (e.g. `test_*.py`) → emit `:!<segment>` AND `:!*/<segment>` (root level and any depth; in git's default pathspec matching `*` crosses `/`).
- New `extractWholeTestDirs(globs)`: a literal first segment counts only when the pattern's filename glob is `*`, `**`, or `*<bare extension>` — i.e. the directory holds nothing but tests (`tests/**/*.py` → `tests`; `src/**/*.test.ts` → nothing).
- `resolveReviewExcludePatterns` uses `extractWholeTestDirs(resolved.globs)` instead of `resolved.testDirs`.

Accepted behaviour change (call it out in the PR body): a directory named only by marker-carrying globs (e.g. `e2e/**/*.spec.ts`) no longer excludes its non-test helper files from review. The well-known test dirs (`test/`, `tests/`, `__tests__/`) are still excluded wholesale by `WELL_KNOWN_TEST_DIRS`, so the default layouts are unaffected.

**Files:**
- Modify: `packages/nax/src/test-runners/conventions.ts:137-189`
- Modify: `packages/nax/src/test-runners/resolver.ts:24, 236-237`
- Test: `packages/nax/test/unit/test-runners/conventions.test.ts`
- Test: `packages/nax/test/unit/test-runners/resolver.test.ts`

**Interfaces:**
- Produces: `export function extractWholeTestDirs(globs: readonly string[]): string[]` in `test-runners/conventions.ts`.
- `globsToPathspec(patterns: readonly string[]): string[]` keeps its signature.

- [ ] **Step 1: Write the failing tests**

In `conventions.test.ts`, add `extractWholeTestDirs` and `globsToPathspec` to the existing import from `"@/test-runners/conventions"`, then append:

```ts
describe("globsToPathspec", () => {
  test.each([
    [["test/**/*.test.ts"], [":!*.test.ts"]],
    [["**/*_test.go"], [":!*_test.go"]],
    [["*_test.py"], [":!*_test.py"]],
    [["test_*.py"], [":!test_*.py", ":!*/test_*.py"]],
    [["tests/**/test_*.py"], [":!test_*.py", ":!*/test_*.py"]],
  ])("keeps a test-file marker: %j", (globs, expected) => {
    expect(globsToPathspec(globs)).toEqual(expected);
  });

  test.each([[["tests/**/*.py"]], [["tests/**/*.rs"]], [["src/**/*.rs"]], [["test/**/*.ts"]], [["tests/**"]]])(
    "never turns a bare extension into a language-wide exclusion: %j",
    (globs) => {
      expect(globsToPathspec(globs)).toEqual([]);
    },
  );

  test("a polyglot pattern set excludes only test files", () => {
    expect(
      globsToPathspec(["test/**/*.test.ts", "test_*.py", "*_test.py", "tests/**/*.py", "tests/**/*.rs", "**/*_test.go"]),
    ).toEqual([":!*.test.ts", ":!test_*.py", ":!*/test_*.py", ":!*_test.py", ":!*_test.go"]);
  });
});

describe("extractWholeTestDirs", () => {
  test("claims a directory only when every file under it is a test", () => {
    expect(extractWholeTestDirs(["tests/**/*.py", "tests/**/*.rs", "spec/**"])).toEqual(["tests", "spec"]);
  });

  test("a marker-carrying pattern does not claim its directory", () => {
    expect(extractWholeTestDirs(["src/**/*.test.ts", "test/**/*.test.ts", "**/*.spec.ts"])).toEqual([]);
  });
});
```

In `resolver.test.ts`, append inside `describe("resolveReviewExcludePatterns", ...)`:

```ts
  test("colocated test patterns never exclude the source directory itself", async () => {
    const config = makeNaxConfig({
      execution: {
        smartTestRunner: {
          enabled: true,
          fallback: "import-grep",
          maxScanFiles: 200,
          testFilePatterns: ["src/**/*.test.ts", "tests/**/*.py", "test_*.py"],
        },
      },
    });
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    const derived = resolveReviewExcludePatterns(undefined, resolved);

    expect(derived).not.toContain(":!src/");
    expect(derived).not.toContain(":!*.py");
    expect(derived).toContain(":!*.test.ts");
    expect(derived).toContain(":!tests/");
    expect(derived).toContain(":!test_*.py");
    expect(derived).toContain(":!*/test_*.py");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax`): `timeout 30 bun test test/unit/test-runners/conventions.test.ts test/unit/test-runners/resolver.test.ts --timeout=5000`
Expected: FAIL — `extractWholeTestDirs` is not exported (import error), and once that is stubbed the pathspec cases fail with `:!*.py` / `:!*.rs` / `:!src/` present.

- [ ] **Step 3: Implement**

In `conventions.ts`, replace the body of `globsToPathspec` (keep its doc comment, and add the two new rules to it) with:

```ts
/** A filename glob's suffix that names only an extension (`.py`, `.rs`): it marks a language, not a test. */
const BARE_EXTENSION = /^\.[A-Za-z0-9]+$/;

export function globsToPathspec(patterns: readonly string[]): string[] {
  const result: string[] = [];
  const add = (pathspec: string): void => {
    if (!result.includes(pathspec)) result.push(pathspec);
  };
  for (const pattern of patterns) {
    const segment = pattern.slice(pattern.lastIndexOf("/") + 1);
    const firstStar = segment.indexOf("*");
    if (firstStar === -1) continue;
    if (firstStar > 0) {
      // `test_*.py`: the marker is a PREFIX, so the suffix alone would match every `.py`.
      add(`:!${segment}`);
      add(`:!*/${segment}`);
      continue;
    }
    const suffix = segment.slice(segment.lastIndexOf("*") + 1);
    if (suffix.length === 0 || BARE_EXTENSION.test(suffix)) continue;
    add(`:!*${suffix}`);
  }
  return result;
}
```

Add `extractWholeTestDirs` right after `extractTestDirs` (leave `extractTestDirs` exactly as it is):

```ts
/**
 * Leading directories whose glob covers EVERY file under them (`tests/**\/*.py`, `spec/**`),
 * so excluding the whole directory from review loses no implementation code.
 *
 * Narrower than {@link extractTestDirs}: `src/**\/*.test.ts` declares where tests live
 * (smart-runner and the test scanner probe it) but `src/` itself is implementation, so it
 * must never become a `:!src/` review exclusion.
 */
export function extractWholeTestDirs(globs: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const glob of globs) {
    const segments = glob.split("/");
    const first = segments[0];
    if (!first || first.includes("*") || segments.length < 2) continue;
    const filename = segments[segments.length - 1] ?? "";
    const coversEverything =
      filename === "*" || filename === "**" || (filename.startsWith("*") && BARE_EXTENSION.test(filename.slice(1)));
    if (coversEverything) dirs.add(first);
  }
  return [...dirs];
}
```

In `resolver.ts`, add `extractWholeTestDirs` to the import on line 24, and change line 237:

```ts
  for (const d of resolved.testDirs) result.add(`:!${d}/`);
```

to:

```ts
  // Only directories that hold nothing but tests: `src/**/*.test.ts` must not exclude `src/`.
  for (const d of extractWholeTestDirs(resolved.globs)) result.add(`:!${d}/`);
```

Update the `resolveReviewExcludePatterns` doc comment's step 1 to say the same in one line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/test-runners/ test/unit/review/ test/unit/verification/ --timeout=5000`
Expected: PASS. If an existing test pinned `:!*.py`, `:!*.rs` or `:!src/` as an expected review exclusion, it pinned the bug: update that expectation to the new rule and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/test-runners/conventions.ts packages/nax/src/test-runners/resolver.ts packages/nax/test/unit/test-runners/conventions.test.ts packages/nax/test/unit/test-runners/resolver.test.ts
git commit -m "fix(test-runners): test globs exclude only test files from review, never a language or src/ (review #2)"
```

---

### Task 3: Cargo detection claims only `tests/` (#2)

Rust unit tests live inline in `src/*.rs` (`#[cfg(test)] mod tests`), so no file-level pattern can separate them; `src/**/*.rs` classifies every implementation file as a test. The correct file-level default is the integration-test directory only.

**Files:**
- Modify: `packages/nax/src/test-runners/detect/framework-defaults.ts:132-139`
- Test: `packages/nax/test/unit/test-runners/detect.test.ts`

- [ ] **Step 1: Write the failing test**

In `detect.test.ts`, inside the describe block that holds `"detects Go project from go.mod and returns **/*_test.go at medium confidence"`, add after it:

```ts
  test("detects Rust from Cargo.toml and claims only the integration-test directory", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.fileExists = mock(async (path: string) => path.endsWith("Cargo.toml"));
    _fileScanDeps.spawn = makeSpawn(() => "").spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toEqual(["tests/**/*.rs"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/test-runners/detect.test.ts --timeout=5000`
Expected: FAIL — received `["tests/**/*.rs", "src/**/*.rs"]`.

- [ ] **Step 3: Implement**

In `framework-defaults.ts`, replace `detectFromCargoToml`'s doc comment and return:

```ts
/**
 * Detect Rust projects from Cargo.toml presence.
 *
 * Only `tests/` is a file-level test location in Rust. Unit tests live inline in
 * `src/*.rs` (`#[cfg(test)] mod tests`), so `src/**\/*.rs` would classify every
 * implementation file as a test and hide it from review.
 */
async function detectFromCargoToml(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/Cargo.toml`;
  if (!(await _frameworkDefaultsDeps.fileExists(path))) return null;
  return { type: "manifest", framework: "rust", path, patterns: ["tests/**/*.rs"] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/test-runners/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/test-runners/detect/framework-defaults.ts packages/nax/test/unit/test-runners/detect.test.ts
git commit -m "fix(test-runners): Cargo default claims tests/ only, not every src/*.rs (review #2)"
```

---

### Task 4: Tier-3 file scan recognises pytest's `test_*.py` (#28)

Every candidate is matched with `file.endsWith(suffix)`, so the `"test_.py"` entry only matches a file literally named `test_.py`. Replace the suffix list with candidates that each carry their own matcher.

**Files:**
- Modify: `packages/nax/src/test-runners/detect/file-scan.ts:68-99` (the two tables) and `:197-212` (the counting loop)
- Test: `packages/nax/test/unit/test-runners/detect.test.ts`

- [ ] **Step 1: Write the failing test**

In `detect.test.ts`, inside `describe("Tier 3 — file scan", ...)`, add:

```ts
  test("detects pytest's test_*.py prefix convention in a flat layout", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);

    const testFiles = Array.from({ length: 6 }, (_, i) => `pkg/test_module${i}.py`).join("\n");
    const allFiles = `${testFiles}\npkg/module.py\npkg/latest_news.py\n`;
    _fileScanDeps.spawn = makeSpawn(() => allFiles).spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.sources[0]?.type).toBe("file-scan");
    expect(result.patterns).toEqual(["**/test_*.py"]);
  });
```

(`pkg/latest_news.py` contains `test_` mid-name and must not count: the match is on the basename prefix.)

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/test-runners/detect.test.ts --timeout=5000`
Expected: FAIL — no file-scan source (the scan finds no candidate).

- [ ] **Step 3: Implement**

In `file-scan.ts`, replace `CANDIDATE_SUFFIXES` and `SUFFIX_TO_GLOB` with one table:

```ts
/** A test-file naming convention the scan counts, and the glob it reports when it wins. */
interface Candidate {
  readonly glob: string;
  readonly matches: (path: string) => boolean;
}

const bySuffix = (suffix: string): Candidate => ({
  glob: `**/*${suffix}`,
  matches: (path) => path.endsWith(suffix),
});

/** pytest's default: the marker is a basename PREFIX, so a suffix test can never see it. */
const byBasenamePrefix = (prefix: string, extension: string): Candidate => ({
  glob: `**/${prefix}*${extension}`,
  matches: (path) => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.startsWith(prefix) && base.endsWith(extension) && base.length > prefix.length + extension.length;
  },
});

/** Common test-file conventions, in report order. */
const CANDIDATES: readonly Candidate[] = [
  bySuffix(".test.ts"),
  bySuffix(".test.tsx"),
  bySuffix(".test.js"),
  bySuffix(".test.jsx"),
  bySuffix(".spec.ts"),
  bySuffix(".spec.tsx"),
  bySuffix(".spec.js"),
  bySuffix(".spec.jsx"),
  bySuffix(".e2e-spec.ts"),
  bySuffix(".e2e-spec.js"),
  bySuffix("_test.go"),
  bySuffix("_test.py"),
  byBasenamePrefix("test_", ".py"),
];
```

Replace the body of `detectFromFileScan` from `const counts` to the end of the threshold loop with:

```ts
  const totalFiles = filtered.length;
  const patterns = CANDIDATES.filter((candidate) => {
    const count = filtered.filter((file) => candidate.matches(file)).length;
    return count > 0 && (count >= MIN_COUNT_THRESHOLD || count / totalFiles >= MIN_FRACTION_THRESHOLD);
  }).map((candidate) => candidate.glob);
```

Keep the `if (patterns.length === 0) return null;` and the return object that follow. Delete any now-unused locals.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/test-runners/ --timeout=5000`
Expected: PASS, including the existing `.test.ts` Tier-3 tests (`bySuffix(".test.ts").glob === "**/*.test.ts"`).

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/test-runners/detect/file-scan.ts packages/nax/test/unit/test-runners/detect.test.ts
git commit -m "fix(test-runners): file scan recognises pytest's test_*.py prefix (review #28)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `test-runners,context`.
