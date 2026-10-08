# Review Fixes Bundle F — Config and Parsers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** and the **#6 ruling** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** `tdd.strategy: "simple"` (and its `"tdd-simple"` alias) loads and routes; four small parsers stop misreading their input; rule truncation order is locale-independent.

**Architecture:** Five independent tasks, all in `packages/nax`. Each is a local fix to one function plus its test.

**Tech Stack:** TypeScript, Zod 4, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #6, #12, #21, #26, #30.

**Branch:** `git fetch origin && git checkout -b fix/review-f-config-parsers origin/main`

## Global Constraints

See the master plan. `packages/nax/src/config/compat-shims.ts` is 569 lines (budget +31); this bundle adds ~16. Everything else is well under its cap.

## Review Focus

See the master plan. This bundle owns Review Focus line 5 (`tdd.strategy: "tdd-simple"`), pinned in Task 1.

## Files

- Modify: `packages/nax/src/config/schemas-execution.ts:493` (Task 1)
- Modify: `packages/nax/src/config/compat-shims.ts` (Task 1)
- Modify: `packages/nax/src/cli/config-descriptions.ts:173` (Task 1)
- Modify: `docs/guides/configuration.md:347-355` (Task 1)
- Test: `packages/nax/test/unit/config/tdd-simple-strategy.test.ts` (92 lines)
- Modify: `packages/nax/src/precheck/story-size-gate.ts:33-39` (Task 2)
- Test: `packages/nax/test/unit/precheck/precheck-story-size-gate.test.ts` (364 lines)
- Modify: `packages/nax/src/context/rules/rule-budget/index.ts:134-139`, `packages/nax/src/context/rules/canonical-loader/index.ts:522-526` (Task 3)
- Test: `packages/nax/test/unit/context/rules/rule-budget.test.ts` (396), `packages/nax/test/unit/context/rules/canonical-loader.test.ts` (625)
- Modify: `packages/nax/src/prd/spec-structure.ts:79-103` (Task 4)
- Test: `packages/nax/test/unit/prd/spec-structure.test.ts` (523)
- Modify: `packages/nax/src/utils/diff-files.ts` (Task 5)
- Test: `packages/nax/test/unit/utils/diff-files.test.ts` (308)

---

### Task 1: `tdd.strategy` accepts `"simple"` and the `"tdd-simple"` alias (#6)

`TddStrategy` (`config/schema-types.ts:13`) and the router (`routing/classify.ts:137`) handle `"simple"`, but `TddConfigSchema` rejects it. Ruling: add `"simple"` to the schema, and normalise `"tdd-simple"` to `"simple"` in the compat-shim chain (every config layer runs through it before Zod) with no warning.

**Files:** see the list above.

**Interfaces:**
- Produces: `export function _applyTddStrategyAliasShim(conf: Record<string, unknown>): Record<string, unknown>` in `config/compat-shims.ts`.

- [ ] **Step 1: Write the failing tests**

In `tdd-simple-strategy.test.ts`, add these imports:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { TddConfigSchema } from "@/config";
import { _applyTddStrategyAliasShim } from "@/config/compat-shims";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
```

(`afterEach`, `beforeEach`, `describe`, `expect`, `test` are already imported from `bun:test`; `determineTestStrategy` from `@/routing/classify`.) Append:

```ts
describe("tdd.strategy 'simple' and its 'tdd-simple' alias", () => {
  test("the schema accepts 'simple'", () => {
    expect(TddConfigSchema.parse({ maxRetries: 0, strategy: "simple" }).strategy).toBe("simple");
  });

  test("'simple' routes every story to tdd-simple, whatever its complexity", () => {
    expect(determineTestStrategy("expert", "Auth login", "", [], "simple")).toBe("tdd-simple");
  });

  test("the alias shim rewrites 'tdd-simple' to 'simple' without touching other keys", () => {
    const input = { tdd: { strategy: "tdd-simple", maxRetries: 2 }, other: 1 };
    expect(_applyTddStrategyAliasShim(input)).toEqual({ tdd: { strategy: "simple", maxRetries: 2 }, other: 1 });
    expect(input.tdd.strategy).toBe("tdd-simple"); // immutable
  });

  test("the alias shim leaves every other value alone", () => {
    const input = { tdd: { strategy: "lite" } };
    expect(_applyTddStrategyAliasShim(input)).toBe(input);
  });

  describe("end to end through loadConfig", () => {
    let tempDir = "";
    let originalGlobalDir: string | undefined;
    beforeEach(() => {
      _clearRootConfigCache();
      tempDir = makeTempDir("nax-tdd-simple-alias-");
      mkdirSync(join(tempDir, ".nax"), { recursive: true });
      originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    });
    afterEach(() => {
      cleanupTempDir(tempDir);
      if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    });

    test.each(["simple", "tdd-simple"])("a project config with tdd.strategy '%s' loads as 'simple'", async (value) => {
      await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify({ tdd: { strategy: value } }));
      const config = await loadConfig(tempDir);
      expect(config.tdd.strategy).toBe("simple");
    });
  });
});
```

(Mirror `loader-legacy-shim.test.ts:155-177` if `loadConfig` needs anything more in the temp project. If `config.tdd` is optional in the type, use `config.tdd?.strategy`.)

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax`): `timeout 30 bun test test/unit/config/tdd-simple-strategy.test.ts --timeout=5000`
Expected: FAIL — `_applyTddStrategyAliasShim` is not exported; once stubbed, the schema rejects `"simple"` with `Invalid option`.

- [ ] **Step 3: Implement**

`schemas-execution.ts:493`:

```ts
  strategy: z.enum(["auto", "strict", "lite", "simple", "off"]).default("auto"),
```

`compat-shims.ts` — add before `applyConfigCompatShims`:

```ts
/**
 * @internal Normalise `tdd.strategy: "tdd-simple"` to `"simple"` (#6).
 *
 * `"simple"` routes every story to the `tdd-simple` test strategy, and that is the
 * spelling users meet in prd.json and the docs, so both are accepted. No warning:
 * the alias is supported, not deprecated. Returns a new object (immutable).
 */
export function _applyTddStrategyAliasShim(conf: Record<string, unknown>): Record<string, unknown> {
  const tdd = conf.tdd as Record<string, unknown> | undefined;
  if (!tdd || typeof tdd !== "object" || tdd.strategy !== "tdd-simple") return conf;
  return { ...conf, tdd: { ...tdd, strategy: "simple" } };
}
```

and add `out = _applyTddStrategyAliasShim(out);` as the last step of `applyConfigCompatShims`, after `out = _applyRemovedCrossPackageDepthShim(out, warn);`.

`cli/config-descriptions.ts:173`:

```ts
  "tdd.strategy": 'TDD strategy: auto | strict | lite | simple | off ("tdd-simple" is accepted for simple)',
```

`docs/guides/configuration.md`, in the **TDD strategy options** table, add a row after `lite`:

```markdown
| `simple` | Always use `tdd-simple` (one session writes the tests, then the code). `"tdd-simple"` is accepted as an alias |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/config/ test/unit/routing/ test/unit/cli/ --timeout=5000`
Expected: PASS. If a `config-descriptions` snapshot test pins the old description text, update it.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/config/schemas-execution.ts packages/nax/src/config/compat-shims.ts packages/nax/src/cli/config-descriptions.ts docs/guides/configuration.md packages/nax/test/unit/config/tdd-simple-strategy.test.ts
git commit -m "fix(config): accept tdd.strategy 'simple' and its 'tdd-simple' alias (review #6)"
```

---

### Task 2: Only real list items count as bullets (#12)

`/^\s*[-*•]|\d+\./` alternates at the top level, so its second branch matches `\d+\.` ANYWHERE in a line: decimals, versions, section numbers and dates all count as bullets, and under `precheck.storySizeGate.action: "block"` that can block a run.

**Files:**
- Modify: `packages/nax/src/precheck/story-size-gate.ts:33-39`
- Test: `packages/nax/test/unit/precheck/precheck-story-size-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Append next to `"flags story when bullet point count exceeds threshold"` (reuse that file's `createMockConfig`, `createMockStory`, `createMockPRD`, `makeStorySizeGateConfig`):

```ts
  test("counts only list items as bullets, never a number that happens to contain a dot", async () => {
    const config = createMockConfig({
      storySizeGate: makeStorySizeGateConfig({
        enabled: true,
        maxAcCount: 6,
        maxDescriptionLength: 2000,
        maxBulletPoints: 2,
      }),
    });
    const description = [
      "- a dash item",
      "* a star item",
      "1. a numbered item",
      "Estimate: 2.5 hours, see section 2.3.",
      "Ships with v1.2 over HTTP/1.1 on 2026.10.08.",
      "**Bold lead-in** and --- a rule are not items either.",
    ].join("\n");
    const prd = createMockPRD([createMockStory({ id: "US-004", acceptanceCriteria: ["AC1"], description })]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.flaggedStories).toHaveLength(1);
    expect(result.flaggedStories[0]?.signals.bulletPoints.value).toBe(3);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/precheck/precheck-story-size-gate.test.ts --timeout=5000`
Expected: FAIL — value is 6 (the two prose lines match the unanchored `\d+\.` branch, and `**Bold` matches `^\s*[-*•]`).

- [ ] **Step 3: Implement**

```ts
/**
 * Count bullet points in text: lines whose first non-blank token is `-`, `*`, `•`
 * or `N.` followed by whitespace (a markdown list item). Both branches are anchored,
 * so "2.5 hours" or "v1.2" mid-line is not a bullet (#12), and `**bold**` / `---` are not items.
 */
function countBulletPoints(text: string): number {
  const lines = text.split("\n");
  const bulletPattern = /^\s*(?:[-*•]|\d+\.)\s/;
  return lines.filter((line) => bulletPattern.test(line)).length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/precheck/ --timeout=5000`
Expected: PASS, including the existing `- Item N` threshold test.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/precheck/story-size-gate.ts packages/nax/test/unit/precheck/precheck-story-size-gate.test.ts
git commit -m "fix(precheck): count only anchored list items as story-size bullets (review #12)"
```

---

### Task 3: Rule ordering uses code-point comparison everywhere (#21)

CTX-5 requires code-point ordering (locale collation varies by ICU/locale); `StaticRulesProvider` complies, but the budget walk (`rule-budget/index.ts:137`) and the canonical loader's load sort (`canonical-loader/index.ts:525`) still use `localeCompare`, so equal-priority rules can truncate in a machine-dependent order.

**Files:**
- Modify: `packages/nax/src/context/rules/rule-budget/index.ts`
- Modify: `packages/nax/src/context/rules/canonical-loader/index.ts`
- Test: `packages/nax/test/unit/context/rules/rule-budget.test.ts`
- Test: `packages/nax/test/unit/context/rules/canonical-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

In `rule-budget.test.ts`, append (uses the file's `makeSection` helper):

```ts
describe("applySectionBudget — CTX-5 code-point owner order", () => {
  test("equal-priority rules are walked in code-point order, not locale order", () => {
    // Code point: "A" (65) < "a" (97), so "Auth-Rules" precedes "api". Locale collation puts "api" first.
    const sections: RuleSection[] = [
      makeSection({ ruleId: "api", rulePath: "api.md", slug: "api-only", ordinal: 0, tokens: 100, priority: 5 }),
      makeSection({
        ruleId: "Auth-Rules",
        rulePath: "Auth-Rules.md",
        slug: "auth-only",
        ordinal: 0,
        tokens: 100,
        priority: 5,
      }),
    ];
    const result = applySectionBudget(sections, 100);
    expect(result.retainedSections.map((s) => s.ruleId)).toEqual(["Auth-Rules"]);
  });
});
```

In `canonical-loader.test.ts`, append inside the describe that holds `"parses frontmatter priority, paths, and appliesTo"`:

```ts
  test("equal-priority rules load in code-point order (CTX-5), not locale order", async () => {
    setupFiles({
      "/project/.nax/rules/api.md": "Api rule.",
      "/project/.nax/rules/Auth-Rules.md": "Auth rule.",
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules.map((r) => r.fileName)).toEqual(["Auth-Rules.md", "api.md"]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 30 bun test test/unit/context/rules/rule-budget.test.ts test/unit/context/rules/canonical-loader.test.ts --timeout=5000`
Expected: FAIL — `["api"]` and `["api.md", "Auth-Rules.md"]` under ICU collation. (If your machine's collation happens to agree with code-point order for this pair and the tests pass before the fix, swap in a pair that differs on your ICU, e.g. `"b"` vs `"C"`, and note it in the commit.)

- [ ] **Step 3: Implement**

In both files, add `import { byCodePoint } from "@nathapp/nax-agent/internal";` (the comparator other nax modules already use, e.g. `context/engine/manifest-store.ts:12`).

`rule-budget/index.ts`:

```ts
      ownerIdentifier(a).localeCompare(ownerIdentifier(b)) ||
```

→

```ts
      byCodePoint(ownerIdentifier(a), ownerIdentifier(b)) || // CTX-5: code-point, not localeCompare
```

`canonical-loader/index.ts`:

```ts
      (a.id ?? a.fileName).localeCompare(b.id ?? b.fileName),
```

→

```ts
      byCodePoint(a.id ?? a.fileName, b.id ?? b.fileName), // CTX-5: code-point, not localeCompare
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/context/ --timeout=5000`
Expected: PASS. Any existing test that relied on locale order for mixed-case ids pinned the bug: update its expected order and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/context/rules/rule-budget/index.ts packages/nax/src/context/rules/canonical-loader/index.ts packages/nax/test/unit/context/rules/rule-budget.test.ts packages/nax/test/unit/context/rules/canonical-loader.test.ts
git commit -m "fix(rules): order equal-priority rules by code point, per CTX-5 (review #21)"
```

---

### Task 4: A deeper heading does not end a grouped-path subsection's skip (#26)

`declaredStoryIds` skips `### Modifies` / `### Context Files` / `### Creates` / `### Seams` so their `US-00N` lead-ins are validated rather than counted as declarations. But ANY `#{3,6}` heading recomputes the flag, so `#### US-009` inside `### Modifies` turns the skip off and US-009 becomes "declared" — the unknown-story lint then validates Modifies against itself. Track the skipped subsection's heading level; only a heading at that level or shallower ends it.

**Files:**
- Modify: `packages/nax/src/prd/spec-structure.ts:79-103`
- Test: `packages/nax/test/unit/prd/spec-structure.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe("declaredStoryIds (US-002)", ...)`:

```ts
  test("a deeper heading inside a grouped-path subsection keeps the skip on", () => {
    const spec = `# SPEC: fixture

## Stories

### US-001 — Core

### Modifies

#### US-009

- \`src/a.ts\` — touched

#### Notes

**US-010**

### US-002 — API

## Acceptance Criteria
`;
    expect(declaredStoryIds(spec.split("\n"))).toEqual(["US-001", "US-002"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/prd/spec-structure.test.ts --timeout=5000`
Expected: FAIL — received `["US-001", "US-009", "US-010", "US-002"]`.

- [ ] **Step 3: Implement**

Replace the body of `declaredStoryIds`:

```ts
export function declaredStoryIds(lines: readonly string[]): string[] {
  const ids = new Set<string>();
  let inScope = false;
  // Heading level of the grouped-path subsection being skipped; 0 = not skipping.
  // Only a heading at that level or shallower ends it: `#### US-009` inside
  // `### Modifies` is still Modifies content (#26).
  let skipLevel = 0;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inScope = /^##\s+(Stories|Acceptance Criteria)\b/i.test(line);
      skipLevel = 0;
      continue;
    }
    if (!inScope) continue;
    const level = /^(#{3,6})\s/.exec(line)?.[1]?.length;
    if (level !== undefined && (skipLevel === 0 || level <= skipLevel)) {
      skipLevel = GROUPED_PATH_SUBSECTION.test(line) ? level : 0;
    }
    if (skipLevel > 0) continue;

    const heading = /^#{1,6}\s+(US-\d+)\b/i.exec(line);
    if (heading?.[1]) {
      ids.add(heading[1].toUpperCase());
      continue;
    }
    const bold = /^\s*\*\*\s*(US-\d+)\b/i.exec(line);
    if (bold?.[1]) ids.add(bold[1].toUpperCase());
  }
  return [...ids];
}
```

Keep the existing doc comment above it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/prd/ --timeout=5000`
Expected: PASS, including the existing `"reads both id sections and skips the **US-00N** lead-ins of grouped-path subsections"` and the `spec-structure-*` suites.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/prd/spec-structure.ts packages/nax/test/unit/prd/spec-structure.test.ts
git commit -m "fix(prd): a deeper heading inside Modifies does not end the declaration skip (review #26)"
```

---

### Task 5: The diff parser never reads hunk content as a file header (#30)

An added content line whose text starts `++ b/<path>` renders as `+++ b/<path>`, identical to a prefixed header; the `b/` branch has no gate, so the parser records a phantom file and re-targets every later hunk to it (the mutation spot-check then bounds mutations to the wrong file). The robust fix is to know when we are INSIDE a hunk body: a hunk header `@@ -a,b +c,d @@` says exactly how many old/new lines follow, and no line in that span is a header.

**Files:**
- Modify: `packages/nax/src/utils/diff-files.ts`
- Test: `packages/nax/test/unit/utils/diff-files.test.ts`

**Interfaces:**
- `extractDiffFiles(diff: string): Set<string>` and `extractDiffLineRanges(diff: string): Map<string, LineRange[]>` keep their signatures.

- [ ] **Step 1: Write the failing tests**

Append to `diff-files.test.ts`:

```ts
describe("hunk bodies are content, never headers", () => {
  const diff = [
    "diff --git a/src/real.ts b/src/real.ts",
    "--- a/src/real.ts",
    "+++ b/src/real.ts",
    "@@ -1,2 +1,4 @@",
    " keep",
    "+++ b/src/phantom.ts",
    "--- removed line that looks like a header",
    "+tail",
    "+more",
    "diff --git a/src/next.ts b/src/next.ts",
    "--- a/src/next.ts",
    "+++ b/src/next.ts",
    "@@ -10 +10 @@",
    "-x",
    "+y",
    "",
  ].join("\n");

  test("an added line reading '++ b/<path>' is not a file", () => {
    expect(extractDiffFiles(diff)).toEqual(new Set(["src/real.ts", "src/next.ts"]));
  });

  test("its hunk's lines stay attributed to the real file", () => {
    expect(extractDiffLineRanges(diff)).toEqual(
      new Map([
        ["src/real.ts", [{ start: 1, end: 4 }]],
        ["src/next.ts", [{ start: 10, end: 10 }]],
      ]),
    );
  });
});
```

(The first hunk is `-1,2 +1,4`: old side = ` keep` + the removed line = 2; new side = ` keep` + three added lines = 4.)

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 30 bun test test/unit/utils/diff-files.test.ts --timeout=5000`
Expected: FAIL — `src/phantom.ts` appears in the file set, and the ranges map is keyed wrong.

- [ ] **Step 3: Implement**

Replace everything in `diff-files.ts` from `export function extractDiffFiles` to the end of the file with a single scanner both public functions consume. Keep the module doc, `HEADER_PREFIX*`, `HUNK_REGEX`, `parseHeaderPath`, `isMinusHeader` and `LineRange` as they are, and add one paragraph to the module doc: "Inside a hunk body (the old/new line counts its `@@` header announces) every line is content, so an added line that reads `++ b/<path>` is never mistaken for a header (#30)."

```ts
type DiffEvent =
  | { readonly kind: "header"; readonly path: string | null }
  | { readonly kind: "hunk"; readonly start: number; readonly count: number };

/** Old/new line counts a hunk-body line consumes, or null when the line ends the body. */
function bodyLineCost(line: string): { readonly old: number; readonly new: number } | null {
  // "" covers a context line whose single leading space was stripped by a tool.
  if (line === "" || line.startsWith(" ")) return { old: 1, new: 1 };
  if (line.startsWith("-")) return { old: 1, new: 0 };
  if (line.startsWith("+")) return { old: 0, new: 1 };
  if (line.startsWith("\\")) return { old: 0, new: 0 }; // "\ No newline at end of file"
  return null;
}

/** Headers and hunks in order, with hunk-body lines consumed by count so content is never a header. */
function* scanDiff(diff: string): Generator<DiffEvent> {
  let oldLeft = 0;
  let newLeft = 0;
  let prevWasMinusHeader = false;
  for (const rawLine of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const cost = bodyLineCost(rawLine);
      if (cost !== null) {
        oldLeft = Math.max(0, oldLeft - cost.old);
        newLeft = Math.max(0, newLeft - cost.new);
        continue;
      }
      // A line no hunk body can hold (e.g. "diff --git"): the counts over-stated the body.
      oldLeft = 0;
      newLeft = 0;
    }
    const wasMinusHeader = prevWasMinusHeader;
    prevWasMinusHeader = isMinusHeader(rawLine);
    if (rawLine.startsWith(HEADER_PREFIX_NOPREFIX)) {
      const path = parseHeaderPath(rawLine, wasMinusHeader);
      if (path !== null || rawLine.startsWith(HEADER_PREFIX) || wasMinusHeader) yield { kind: "header", path };
      continue;
    }
    const match = HUNK_REGEX.exec(rawLine);
    if (!match) continue;
    oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    newLeft = match[4] === undefined ? 1 : Number(match[4]);
    yield { kind: "hunk", start: Number(match[3]), count: newLeft };
  }
}

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;
  for (const event of scanDiff(diff)) {
    if (event.kind === "header" && event.path) files.add(event.path);
  }
  return files;
}

export function extractDiffLineRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  if (!diff) return ranges;
  let currentPath: string | null = null;
  for (const event of scanDiff(diff)) {
    if (event.kind === "header") {
      currentPath = event.path;
      continue;
    }
    if (!currentPath || event.count <= 0) continue;
    const entry = ranges.get(currentPath) ?? [];
    ranges.set(currentPath, [...entry, { start: event.start, end: event.start + event.count - 1 }]);
  }
  return ranges;
}
```

(The `[...entry, …]` replaces the old in-place `push`, per the immutability rule.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/utils/diff-files.test.ts test/unit/review/ test/unit/operations/ --timeout=5000`
Expected: PASS. If an existing fixture fails because its `@@` header announces MORE lines than the fixture actually contains and the next line is a `+++ b/...` header with no `diff --git` / `---` line before it, the fixture is not a real git diff: correct its counts to match its body and say so in the commit body. Do not weaken the scanner.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/utils/diff-files.ts packages/nax/test/unit/utils/diff-files.test.ts
git commit -m "fix(utils): track hunk bodies so content lines are never parsed as diff headers (review #30)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `config,precheck,rules,prd,utils`.
