# S1 nax-agent carve-out — PR S1-0 and S1-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first two S1 PRs: S1-0 (move manifest and boundary ratchet) and S1-1 (one usage and pricing vocabulary, nax-ai's), both behaviour-neutral.

**Architecture:** S1-0 adds a JSON manifest that names every file moving into `packages/nax-agent` and a ratchet gate that counts import edges leaving that set. S1-1 deletes nax's duplicate usage and rate types (`TokenUsage`, `TokenPricing`, `TokenPricingTier`, `ResolvedRates`), routes all in-memory code to nax-ai's `TokenUsage`/`Pricing`/`PricingRates`/`PricingTier` through one staging re-export, and keeps every persisted or user-facing shape byte-identical by mapping at its single edge.

**Tech Stack:** TypeScript (ESM), Bun 1.4.0, `bun:test`, Biome, zod. Package commands run from `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md` (sections 3, 5, 6, 8). Read it before starting.

**Scope of this plan.** S1-2..S1-5 each get their own plan, written against the latest `main` right before that PR starts (arc D6: `main` moves fast enough that a line-level plan goes stale within days).

## Global Constraints

- Every PR is behaviour-neutral: no change to `nax run` output, cost rows, `metrics.json`, `nax config` output, or any CLI text.
- Run package commands from `packages/nax`. Never run bare `bun test` (no path); single files run as `bun test <path> --timeout=60000`. Never `bun run nax`.
- Full verification per PR: `bun run test`, `bun run typecheck`, `bun run lint`, and from the repo root `bun run check:all`.
- No test is edited to pass unless its subject was renamed or reshaped by this plan.
- Source files stay at or under 600 lines (`scripts/check-file-sizes.ts`); `src/agents/types.ts` (600) and `src/agents/native/adapter.ts` (599) must not grow.
- Cost rows keep `COST_ROW_SCHEMA_VERSION = 8` and their exact keys: `tokens {input, output, cacheRead, cacheWrite}`, `rates {inputPer1M, outputPer1M, cacheReadPer1M, cacheCreationPer1M}`.
- `metrics.json` keeps `cacheReadInputTokens` / `cacheCreationInputTokens` and omits zero values.
- User config `models.*.pricing` keeps the `inputPer1M` / `outputPer1M` / `cacheReadPer1M?` / `cacheCreationPer1M?` / `tiers?` shape.
- nax is a public repo: commit messages and PR text never name private projects.
- Commits use conventional prefixes (`feat:`, `refactor:`, `test:`, `docs:`, `chore:`), no emojis.

## Review Focus

1. **Catalog entry with a missing cache rate at runtime.** nax-ai types `cacheRead`/`cacheWrite` as required, but the old code defended against `undefined`. Expected: priced at that level's input rate, as today. Pinned by Task 5 step 1 (`priceCall` defensive fallback case).
2. **Tiered config override with no cache rates on a tier.** Expected: the tier's cache rates fall back to the tier's own input rate, not the base cache rate. Pinned by the golden case `tier-missing-cache-rates` in Task 4.
3. **Zero versus absent cache counts through the native turn accumulator.** Expected: absent stays absent in `TurnResult.tokenUsage` and in the cost row; zero stays zero. Pinned by Task 6 step 1.
4. **Cost row `rates` written from an aggregated multi-round-trip turn** (`aggregateRates`). Expected: per-1M key names in the same order as today. Pinned by Task 6 step 3.
5. **A file joining the move set later** (S1-2..S1-4 add split files to the manifest). Expected: the ratchet recounts with the new membership, and its `--list` output names each remaining edge. Pinned by Task 2 step 1 (`membership change` case).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `packages/nax/scripts/s1-move-manifest.json` | 1 | The move set: source path or directory → destination under `packages/nax-agent/src` |
| `packages/nax/scripts/lib/agent-move-manifest.ts` | 1 | Load and validate the manifest; membership and destination lookup |
| `packages/nax/test/unit/scripts/agent-move-manifest.test.ts` | 1 | Manifest loader tests |
| `packages/nax/scripts/check-agent-boundary.ts` | 2 | Ratchet: count edges from the move set to files outside it |
| `packages/nax/scripts/baselines/agent-boundary-baseline.json` | 2 | Ratchet baseline |
| `packages/nax/test/unit/scripts/check-agent-boundary.test.ts` | 2 | Ratchet tests |
| `packages/nax/scripts/check-import-cycles.ts` | 2 | Modify: export `walk` for reuse |
| `packages/nax/src/agents/cost/standard-types.ts` | 3 | Staging re-export of nax-ai's usage and rate types |
| `packages/nax/scripts/check-nax-ai-imports.ts` | 3 | Modify: allow the one staging file |
| `packages/nax/src/config/schema-types.ts` | 4 | Rename `TokenPricing`→`ConfigPricing`, `TokenPricingTier`→`ConfigPricingTier`; add `toPricing` |
| `packages/nax/src/agents/cost/{estimate,calculate,types,index}.ts` | 4, 5 | Pricing math over the standard types |
| `packages/nax/test/unit/agents/cost/price-call-golden.test.ts` | 4 | Golden equivalence with the pre-S1-1 math |
| ~30 consumer files (Task 6 table) | 6 | Rename to the standard vocabulary; serializers keep shapes |
| `packages/nax/src/metrics/{types,tracker,index}.ts` | 7 | `TokenUsage` DTO → `StoryTokenUsage` |
| `packages/nax/scripts/check-usage-vocabulary.ts` + test | 8 | §5.3 gate |

---

# PR S1-0 — Manifest and ratchet

Branch: `feat/s1-0-agent-boundary-ratchet` from the latest `main`. Cherry-pick or rebase the spec commit and this plan onto it, so the spec and plan land with S1-0 (spec §6).

### Task 1: Move manifest and its loader

**Files:**
- Create: `packages/nax/scripts/s1-move-manifest.json`
- Create: `packages/nax/scripts/lib/agent-move-manifest.ts`
- Test: `packages/nax/test/unit/scripts/agent-move-manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MoveEntry { readonly from: string; readonly to: string }
  export interface MoveManifest { readonly entries: readonly MoveEntry[] }
  export function parseMoveManifest(raw: unknown): MoveManifest;      // throws Error on invalid input
  export function loadMoveManifest(path: string): MoveManifest;      // reads JSON then parseMoveManifest
  export function isInMoveSet(manifest: MoveManifest, rel: string): boolean;
  export function destinationOf(manifest: MoveManifest, rel: string): string | undefined;
  ```
  `rel` is a path relative to `packages/nax`, with `/` separators, e.g. `src/tools/git.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/nax/test/unit/scripts/agent-move-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  destinationOf,
  isInMoveSet,
  loadMoveManifest,
  parseMoveManifest,
} from "@scripts/lib/agent-move-manifest";

const SAMPLE = {
  entries: [
    { from: "src/tools/", to: "tools/" },
    { from: "src/agents/session-types.ts", to: "session/session-types.ts" },
  ],
};

describe("parseMoveManifest", () => {
  test("accepts directory and file entries", () => {
    expect(parseMoveManifest(SAMPLE).entries).toHaveLength(2);
  });

  test("rejects an entry outside src/", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "scripts/x.ts", to: "x.ts" }] })).toThrow("must start with src/");
  });

  test("rejects a directory entry whose destination is not a directory", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "src/tools/", to: "tools.ts" }] })).toThrow("directory");
  });

  test("rejects a file entry that is not a .ts file", () => {
    expect(() => parseMoveManifest({ entries: [{ from: "src/a.json", to: "a.json" }] })).toThrow(".ts");
  });

  test("rejects duplicate sources", () => {
    const dup = { entries: [SAMPLE.entries[0], SAMPLE.entries[0]] };
    expect(() => parseMoveManifest(dup)).toThrow("duplicate");
  });

  test("rejects a file entry already covered by a directory entry", () => {
    const covered = { entries: [{ from: "src/tools/", to: "tools/" }, { from: "src/tools/git.ts", to: "tools/git.ts" }] };
    expect(() => parseMoveManifest(covered)).toThrow("already covered");
  });
});

describe("membership and destination", () => {
  const m = parseMoveManifest(SAMPLE);

  test("a file under a directory entry is in the set", () => {
    expect(isInMoveSet(m, "src/tools/git.ts")).toBe(true);
    expect(destinationOf(m, "src/tools/git-flags/index.ts")).toBe("tools/git-flags/index.ts");
  });

  test("a single-file entry maps exactly", () => {
    expect(isInMoveSet(m, "src/agents/session-types.ts")).toBe(true);
    expect(destinationOf(m, "src/agents/session-types.ts")).toBe("session/session-types.ts");
  });

  test("a sibling with a shared prefix is not in the set", () => {
    expect(isInMoveSet(m, "src/tools-extra/a.ts")).toBe(false);
    expect(isInMoveSet(m, "src/agents/session-types-old.ts")).toBe(false);
    expect(destinationOf(m, "src/agents/types.ts")).toBeUndefined();
  });
});

describe("committed manifest", () => {
  test("loads and every entry exists on disk", () => {
    const pkgRoot = join(import.meta.dir, "../../..");
    const m = loadMoveManifest(join(pkgRoot, "scripts/s1-move-manifest.json"));
    const missing = m.entries.map((e) => e.from).filter((from) => !existsSync(join(pkgRoot, from)));
    expect(missing).toEqual([]);
    expect(isInMoveSet(m, "src/agents/native/adapter.ts")).toBe(true);
    expect(isInMoveSet(m, "src/agents/tool-preamble.ts")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/agent-move-manifest.test.ts --timeout=60000`
Expected: FAIL, `Cannot find module '@scripts/lib/agent-move-manifest'`.

- [ ] **Step 3: Write the loader**

```ts
// packages/nax/scripts/lib/agent-move-manifest.ts
/**
 * The S1 move manifest: which files under packages/nax/src move into
 * packages/nax-agent, and where. One definition shared by the boundary
 * ratchet (check-agent-boundary.ts) and the S1-5 move script, so "what
 * moves" cannot drift between them (spec section 6).
 *
 * Entries are either a directory (`from` and `to` end with "/") or a single
 * .ts file. Paths are relative to packages/nax (`from`) and to
 * packages/nax-agent/src (`to`). A file joins the manifest in the PR that
 * makes it movable, e.g. the half of a split file.
 */
import { readFileSync } from "node:fs";

export interface MoveEntry {
  readonly from: string;
  readonly to: string;
}

export interface MoveManifest {
  readonly entries: readonly MoveEntry[];
}

function fail(message: string): never {
  throw new Error(`s1-move-manifest: ${message}`);
}

function parseEntry(raw: unknown, index: number): MoveEntry {
  if (typeof raw !== "object" || raw === null) fail(`entry ${index} is not an object`);
  const { from, to } = raw as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string") fail(`entry ${index} needs string "from" and "to"`);
  if (!from.startsWith("src/")) fail(`entry ${index} "${from}" must start with src/`);
  const isDir = from.endsWith("/");
  if (isDir && !to.endsWith("/")) fail(`entry ${index} "${from}" is a directory, so "to" must be a directory`);
  if (!isDir && !from.endsWith(".ts")) fail(`entry ${index} "${from}" must be a directory or a .ts file`);
  if (!isDir && !to.endsWith(".ts")) fail(`entry ${index} "${to}" must be a .ts file`);
  return { from, to };
}

export function parseMoveManifest(raw: unknown): MoveManifest {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    fail('expected { "entries": [...] }');
  }
  const entries = ((raw as { entries: unknown[] }).entries).map(parseEntry);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.from)) fail(`duplicate source "${e.from}"`);
    seen.add(e.from);
  }
  const dirs = entries.filter((e) => e.from.endsWith("/"));
  for (const e of entries) {
    if (e.from.endsWith("/")) continue;
    const parent = dirs.find((d) => e.from.startsWith(d.from));
    if (parent) fail(`"${e.from}" is already covered by directory entry "${parent.from}"`);
  }
  return { entries };
}

export function loadMoveManifest(path: string): MoveManifest {
  return parseMoveManifest(JSON.parse(readFileSync(path, "utf8")));
}

function entryFor(manifest: MoveManifest, rel: string): MoveEntry | undefined {
  return manifest.entries.find((e) => (e.from.endsWith("/") ? rel.startsWith(e.from) : rel === e.from));
}

export function isInMoveSet(manifest: MoveManifest, rel: string): boolean {
  return entryFor(manifest, rel) !== undefined;
}

export function destinationOf(manifest: MoveManifest, rel: string): string | undefined {
  const e = entryFor(manifest, rel);
  if (e === undefined) return undefined;
  return e.from.endsWith("/") ? e.to + rel.slice(e.from.length) : e.to;
}
```

- [ ] **Step 4: Write the manifest**

This is the move set at the base commit (spec section 3): the candidate set plus the modules that move whole without a split. `src/errors.ts`, `src/utils/git.ts`, `src/agents/cost/calculate.ts` and the contract leftovers in `src/agents/types.ts` are NOT listed; they join in the PR that splits them.

```json
{
  "entries": [
    { "from": "src/agents/native/", "to": "native/" },
    { "from": "src/tools/", "to": "tools/" },
    { "from": "src/permissions/", "to": "permissions/" },
    { "from": "src/sandbox/", "to": "sandbox/" },
    { "from": "src/command-safety/", "to": "command-safety/" },
    { "from": "src/execution/command-interceptor/", "to": "command-interceptor/" },
    { "from": "src/runtime/spin-breaker/", "to": "infra/spin-breaker/" },
    { "from": "src/agents/coding-tool-bash.ts", "to": "coding-tools/coding-tool-bash.ts" },
    { "from": "src/agents/coding-tool-extras.ts", "to": "coding-tools/coding-tool-extras.ts" },
    { "from": "src/agents/coding-tool-sandbox.ts", "to": "coding-tools/coding-tool-sandbox.ts" },
    { "from": "src/agents/coding-tool-support.ts", "to": "coding-tools/coding-tool-support.ts" },
    { "from": "src/agents/universal-coding-tools.ts", "to": "coding-tools/universal-coding-tools.ts" },
    { "from": "src/agents/session-types.ts", "to": "session/session-types.ts" },
    { "from": "src/agents/interaction-handler.ts", "to": "session/interaction-handler.ts" },
    { "from": "src/runtime/no-op-interaction-handler.ts", "to": "session/no-op-interaction-handler.ts" },
    { "from": "src/agents/turn-deadline.ts", "to": "session/turn-deadline.ts" },
    { "from": "src/agents/model-spec.ts", "to": "cost/model-spec.ts" },
    { "from": "src/agents/cost/estimate.ts", "to": "cost/estimate.ts" },
    { "from": "src/config/bash-approval.ts", "to": "config/bash-approval.ts" },
    { "from": "src/config/schemas-sandbox.ts", "to": "config/schemas-sandbox.ts" },
    { "from": "src/logger/redact.ts", "to": "internal/redact.ts" },
    { "from": "src/verification/shell-quote.ts", "to": "internal/shell-quote.ts" },
    { "from": "src/utils/errors.ts", "to": "infra/errors.ts" },
    { "from": "src/utils/bounded-io.ts", "to": "internal/bounded-io.ts" },
    { "from": "src/utils/exec-framing.ts", "to": "internal/exec-framing.ts" },
    { "from": "src/utils/describe-value-type.ts", "to": "internal/describe-value-type.ts" },
    { "from": "src/utils/realpath.ts", "to": "internal/realpath.ts" },
    { "from": "src/utils/sort.ts", "to": "internal/sort.ts" },
    { "from": "src/utils/path-file-lock.ts", "to": "internal/path-file-lock.ts" },
    { "from": "src/utils/file-lock.ts", "to": "internal/file-lock.ts" },
    { "from": "src/utils/process-alive.ts", "to": "internal/process-alive.ts" },
    { "from": "src/utils/strip-control-chars.ts", "to": "internal/strip-control-chars.ts" },
    { "from": "src/utils/git-add.ts", "to": "internal/git-add.ts" },
    { "from": "src/utils/git-env.ts", "to": "internal/git-env.ts" },
    { "from": "src/utils/thenable.ts", "to": "internal/thenable.ts" },
    { "from": "src/utils/agent-output-env.ts", "to": "internal/agent-output-env.ts" },
    { "from": "src/utils/argv-exec.ts", "to": "internal/argv-exec.ts" },
    { "from": "src/utils/process-kill.ts", "to": "internal/process-kill.ts" },
    { "from": "src/utils/bun-deps.ts", "to": "internal/bun-deps.ts" }
  ]
}
```

The "committed manifest" test fails on any entry that no longer exists. If a file was renamed on `main` since `fff826752`, fix its entry.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/scripts/agent-move-manifest.test.ts --timeout=60000`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add packages/nax/scripts/s1-move-manifest.json packages/nax/scripts/lib/agent-move-manifest.ts packages/nax/test/unit/scripts/agent-move-manifest.test.ts
git commit -m "chore: add S1 nax-agent move manifest"
```

### Task 2: Boundary ratchet

**Files:**
- Create: `packages/nax/scripts/check-agent-boundary.ts`
- Create: `packages/nax/scripts/baselines/agent-boundary-baseline.json` (generated)
- Modify: `packages/nax/scripts/check-import-cycles.ts:176` (export `walk`)
- Modify: `packages/nax/package.json` (`check:agent-boundary`, `check:agent-boundary:update`, append to `lint:checks`)
- Test: `packages/nax/test/unit/scripts/check-agent-boundary.test.ts`

**Interfaces:**
- Consumes: `parseMoveManifest`, `loadMoveManifest`, `isInMoveSet` (Task 1); `resolveSpecifier(rootDir, fromFile, spec): string | null`, `stripComments(source): string`, `walk(dir): Generator<string>` from `scripts/check-import-cycles.ts`.
- Produces:
  ```ts
  export interface BoundaryEdge { readonly from: string; readonly to: string } // both relative to packages/nax, "/" separators
  export function specifiersOf(source: string): string[];
  export function findBoundaryEdges(rootDir: string, manifest: MoveManifest): BoundaryEdge[]; // sorted, de-duplicated
  export function formatEdge(e: BoundaryEdge): string; // "from -> to"
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/nax/test/unit/scripts/check-agent-boundary.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBoundaryEdges, formatEdge, specifiersOf } from "@scripts/check-agent-boundary";
import { parseMoveManifest } from "@scripts/lib/agent-move-manifest";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const MANIFEST = parseMoveManifest({
  entries: [
    { from: "src/agent/", to: "agent/" },
    { from: "src/util/moving.ts", to: "internal/moving.ts" },
  ],
});

describe("specifiersOf", () => {
  test("collects static, type-only, re-export, side-effect and dynamic specifiers", () => {
    const src = [
      'import { a } from "./a";',
      'import type { B } from "@/b";',
      'export { c } from "../c";',
      'import "./side";',
      'type D = import("./d").D;',
    ].join("\n");
    expect(specifiersOf(src).sort()).toEqual(["../c", "./a", "./d", "./side", "@/b"]);
  });

  test("ignores specifiers inside comments", () => {
    expect(specifiersOf('// import { x } from "./x";\n/* import("./y") */\n')).toEqual([]);
  });
});

describe("findBoundaryEdges", () => {
  test("counts only edges from the move set to files outside it", () => {
    root = makeTempDir("agent-boundary-");
    write("src/agent/a.ts", 'import { b } from "./b";\nimport { s } from "@/stay/s";\nimport type { M } from "@/util/moving";\n');
    write("src/agent/b.ts", 'export type T = import("../stay/t").T;\nexport const b = 1;\n');
    write("src/util/moving.ts", 'import { s } from "../stay/s";\nexport type M = string;\n');
    write("src/stay/s.ts", 'import { b } from "../agent/b";\nexport const s = b;\n');
    write("src/stay/t.ts", "export type T = number;\n");

    const edges = findBoundaryEdges(root, MANIFEST).map(formatEdge);
    expect(edges).toEqual([
      "src/agent/a.ts -> src/stay/s.ts",
      "src/agent/b.ts -> src/stay/t.ts",
      "src/util/moving.ts -> src/stay/s.ts",
    ]);
  });

  test("bare package imports are not edges", () => {
    root = makeTempDir("agent-boundary-");
    write("src/agent/a.ts", 'import { createClient } from "@nathapp/nax-ai";\nimport { join } from "node:path";\n');
    expect(findBoundaryEdges(root, MANIFEST)).toEqual([]);
  });

  test("membership change: adding a target to the manifest removes its edges", () => {
    root = makeTempDir("agent-boundary-");
    write("src/agent/a.ts", 'import { s } from "@/stay/s";\n');
    write("src/stay/s.ts", "export const s = 1;\n");
    expect(findBoundaryEdges(root, MANIFEST)).toHaveLength(1);
    const widened = parseMoveManifest({
      entries: [...MANIFEST.entries, { from: "src/stay/s.ts", to: "internal/s.ts" }],
    });
    expect(findBoundaryEdges(root, widened)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/check-agent-boundary.test.ts --timeout=60000`
Expected: FAIL, `Cannot find module '@scripts/check-agent-boundary'`.

- [ ] **Step 3: Export `walk` from check-import-cycles**

In `packages/nax/scripts/check-import-cycles.ts`, change line 176:

```ts
function* walk(dir: string): Generator<string> {
```
to
```ts
export function* walk(dir: string): Generator<string> {
```

- [ ] **Step 4: Write the ratchet**

`packages/nax/scripts/check-agent-boundary.ts`:

```ts
#!/usr/bin/env bun
/**
 * S1 ratchet: counts import edges that leave the nax-agent move set.
 *
 * The move set is scripts/s1-move-manifest.json. An edge is a (file, file)
 * pair where the importer is in the move set and the imported src/ file is
 * not. Type-only imports count (a moved file cannot type-import nax either),
 * and so do `import("...")` type references and side-effect imports. Bare
 * package specifiers are not edges.
 *
 * The count may only fall. It must read 0 before the S1-5 move starts
 * (spec section 6); S1-5 then replaces this ratchet with
 * check-package-boundaries.
 *
 * Usage:
 *   bun scripts/check-agent-boundary.ts                   # check (CI mode)
 *   bun scripts/check-agent-boundary.ts --update-baseline # save new baseline
 *   bun scripts/check-agent-boundary.ts --list            # print every edge
 *
 * Exit codes:
 *   0 - count <= baseline
 *   1 - count > baseline, or baseline missing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { resolveSpecifier, stripComments, walk } from "./check-import-cycles";
import { isInMoveSet, loadMoveManifest, type MoveManifest } from "./lib/agent-move-manifest";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "agent-boundary-baseline.json");
const MANIFEST_FILE = join(import.meta.dir, "s1-move-manifest.json");

const STATIC_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?[A-Za-z0-9_$*,{}\s]*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

export interface BoundaryEdge {
  readonly from: string;
  readonly to: string;
}

interface Baseline {
  count: number;
  updatedAt: string;
  edges: string[];
}

export function specifiersOf(source: string): string[] {
  const text = stripComments(source);
  const specs: string[] = [];
  for (const re of [STATIC_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    for (const match of text.matchAll(re)) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

function toRel(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join("/");
}

export function formatEdge(e: BoundaryEdge): string {
  return `${e.from} -> ${e.to}`;
}

export function findBoundaryEdges(rootDir: string, manifest: MoveManifest): BoundaryEdge[] {
  const seen = new Set<string>();
  const edges: BoundaryEdge[] = [];
  for (const file of walk(join(rootDir, "src"))) {
    const from = toRel(rootDir, file);
    if (!isInMoveSet(manifest, from)) continue;
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(rootDir, file, spec);
      if (target === null) continue;
      const to = toRel(rootDir, target);
      if (isInMoveSet(manifest, to)) continue;
      const edge = { from, to };
      const key = formatEdge(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges.sort((a, b) => byCodePoint(formatEdge(a), formatEdge(b)));
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
}

function saveBaseline(edges: readonly BoundaryEdge[]): void {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const baseline: Baseline = { count: edges.length, updatedAt: new Date().toISOString(), edges: edges.map(formatEdge) };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const edges = findBoundaryEdges(ROOT, loadMoveManifest(MANIFEST_FILE));

  if (args.includes("--list")) {
    for (const e of edges) console.log(formatEdge(e));
    console.log(`${edges.length} boundary edge(s)`);
    return;
  }
  if (args.includes("--update-baseline")) {
    saveBaseline(edges);
    console.log(`[OK] agent-boundary baseline saved: ${edges.length} edge(s)`);
    return;
  }

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("[FAIL] agent-boundary baseline missing; run with --update-baseline");
    process.exit(1);
  }
  if (edges.length > baseline.count) {
    const known = new Set(baseline.edges);
    console.error(`[FAIL] agent-boundary edges rose: ${edges.length} > baseline ${baseline.count}. New edges:`);
    for (const e of edges) if (!known.has(formatEdge(e))) console.error(`  ${formatEdge(e)}`);
    process.exit(1);
  }
  if (edges.length < baseline.count) {
    console.log(`[OK] agent-boundary edges fell to ${edges.length} (baseline ${baseline.count}); run --update-baseline to lock it in`);
    return;
  }
  console.log(`[OK] agent-boundary edges: ${edges.length}`);
}

if (import.meta.main) main();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/scripts/check-agent-boundary.test.ts test/unit/scripts/check-import-cycles.test.ts --timeout=60000`
Expected: PASS for both files.

- [ ] **Step 6: Wire the scripts and generate the baseline**

In `packages/nax/package.json` add, next to the other `check:*` scripts:

```json
"check:agent-boundary": "bun run scripts/check-agent-boundary.ts",
"check:agent-boundary:update": "bun run scripts/check-agent-boundary.ts --update-baseline",
```

and append ` && bun run check:agent-boundary` to the end of the `lint:checks` value.

Run: `bun run check:agent-boundary:update`
Expected: `[OK] agent-boundary baseline saved: N edge(s)`. N was about 104 at `fff826752` (approximate scan); record whatever the script prints.

Run: `bun run check:agent-boundary && bun scripts/check-gate-reachability.ts`
Expected: `[OK] agent-boundary edges: N` and the reachability gate passes (the new script is reached through `lint` → `lint:checks`).

- [ ] **Step 7: Full verification**

Run (in `packages/nax`): `bun run typecheck && bun run lint && bun run test`
Run (repo root): `bun run check:all`
Expected: all green.

- [ ] **Step 8: Commit and open PR S1-0**

```bash
git add packages/nax/scripts/check-agent-boundary.ts packages/nax/scripts/baselines/agent-boundary-baseline.json packages/nax/scripts/check-import-cycles.ts packages/nax/package.json packages/nax/test/unit/scripts/check-agent-boundary.test.ts
git commit -m "chore: add S1 agent-boundary ratchet"
git push -u origin feat/s1-0-agent-boundary-ratchet
```

Open the PR with title `chore: S1-0 nax-agent move manifest and boundary ratchet`. The body links the spec and this plan and states the baseline count. Run a code review before pushing; merge on green.

---

# PR S1-1 — One usage and pricing vocabulary

Branch: `refactor/s1-1-usage-pricing-standard` from `main` after S1-0 merged.

Rename map used throughout S1-1 (apply to source AND test files):

| Old | New |
|---|---|
| `TokenUsage` (from `agents/cost`) | `TokenUsage` from `@/agents/cost/standard-types` (nax-ai's) |
| `.cacheReadInputTokens` (in-memory usage) | `.cacheReadTokens` |
| `.cacheCreationInputTokens` (in-memory usage) | `.cacheWriteTokens` |
| `ResolvedRates` | `PricingRates` |
| `TokenPricing` (rate card in memory) | `Pricing` |
| `TokenPricingTier` | `PricingTier` |
| `.inputPer1M` / `.outputPer1M` / `.cacheReadPer1M` / `.cacheCreationPer1M` (in memory) | `.input` / `.output` / `.cacheRead` / `.cacheWrite` |
| `TokenPricing` / `TokenPricingTier` in user config (`ModelDef.pricing`) | `ConfigPricing` / `ConfigPricingTier` (shape unchanged) |
| `TokenUsage` in `metrics/` | `StoryTokenUsage` (shape unchanged) |

Persisted and user-facing shapes are NOT renamed (Global Constraints).

### Task 3: Staging re-export and nax-ai import gate

**Files:**
- Create: `packages/nax/src/agents/cost/standard-types.ts`
- Modify: `packages/nax/scripts/check-nax-ai-imports.ts:19,38-41,46`
- Modify: `packages/nax/scripts/s1-move-manifest.json` (add the staging file)
- Test: `packages/nax/test/unit/scripts/check-nax-ai-imports.test.ts`

**Interfaces:**
- Produces: `import type { Pricing, PricingRates, PricingTier, TokenUsage } from "@/agents/cost/standard-types";` (type-only re-exports of nax-ai).

- [ ] **Step 1: Write the failing gate tests**

Append to `packages/nax/test/unit/scripts/check-nax-ai-imports.test.ts`, inside the existing `describe`:

```ts
  test("passes for the S1-1 staging re-export file", () => {
    const root = tree({
      "src/agents/cost/standard-types.ts": 'export type { TokenUsage } from "@nathapp/nax-ai";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("still fails for a sibling of the staging file", () => {
    const root = tree({
      "src/agents/cost/estimate.ts": 'import type { Pricing } from "@nathapp/nax-ai";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });
```

- [ ] **Step 2: Run to verify the first new test fails**

Run: `bun test test/unit/scripts/check-nax-ai-imports.test.ts --timeout=60000`
Expected: FAIL on "passes for the S1-1 staging re-export file".

- [ ] **Step 3: Allow the one file**

In `packages/nax/scripts/check-nax-ai-imports.ts`, after the `ALLOWED_PREFIXES` line add:

```ts
// S1-1 staging re-export of nax-ai's usage and rate types (S1 spec section 5.2).
// Removed in S1-5, when the re-export moves into packages/nax-agent.
const ALLOWED_FILES = [join("src", "agents", "cost", "standard-types.ts")];
```

change the skip line to

```ts
  if (ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix)) || ALLOWED_FILES.includes(rel)) continue;
```

and change the failure message to

```ts
  console.error(
    "@nathapp/nax-ai may only be imported from src/agents/native/, src/agents/catalog/ or src/agents/cost/standard-types.ts:",
  );
```

- [ ] **Step 4: Create the staging module**

```ts
// packages/nax/src/agents/cost/standard-types.ts
/**
 * The one usage and rate vocabulary (S1 spec, ruling R3): nax-ai's types.
 *
 * Staging re-export for S1-1. Code outside src/agents/native and
 * src/agents/catalog takes these types from here, so check-nax-ai-imports
 * keeps a single allow-listed file. In S1-5 this becomes a re-export in
 * packages/nax-agent and the allow-list entry is removed.
 */
export type { Pricing, PricingRates, PricingTier, TokenUsage } from "@nathapp/nax-ai";
```

Add to `packages/nax/scripts/s1-move-manifest.json` `entries`:

```json
    { "from": "src/agents/cost/standard-types.ts", "to": "cost/standard-types.ts" },
```

- [ ] **Step 5: Run gate tests and the ratchet**

Run: `bun test test/unit/scripts/check-nax-ai-imports.test.ts test/unit/scripts/agent-move-manifest.test.ts --timeout=60000 && bun run check:nax-ai-imports && bun run check:agent-boundary`
Expected: all PASS; the ratchet count is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/src/agents/cost/standard-types.ts packages/nax/scripts/check-nax-ai-imports.ts packages/nax/scripts/s1-move-manifest.json packages/nax/test/unit/scripts/check-nax-ai-imports.test.ts
git commit -m "refactor: stage nax-ai usage and pricing types for one vocabulary"
```

### Task 4: Config pricing conversion and golden pricing test

**Files:**
- Modify: `packages/nax/src/config/schema-types.ts:20-45` (rename types, add `toPricing`)
- Modify: `packages/nax/src/config/schema.ts:76`, `packages/nax/src/config/types.ts:68` (re-export the new names)
- Modify: `packages/nax/src/agents/cost/estimate.ts` (rewrite over the standard types)
- Test: `packages/nax/test/unit/agents/cost/price-call-golden.test.ts`

**Interfaces:**
- Consumes: `Pricing`, `PricingRates`, `PricingTier`, `TokenUsage` from `@/agents/cost/standard-types` (Task 3).
- Produces:
  ```ts
  // config/schema-types.ts
  export interface ConfigPricing { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; cacheCreationPer1M?: number; tiers?: ConfigPricingTier[] }
  export interface ConfigPricingTier { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; cacheCreationPer1M?: number; inputTokensAbove: number }
  export function toPricing(config: ConfigPricing): Pricing;
  // agents/cost/estimate.ts
  export function priceCall(usage: TokenUsage, rates: Pricing): { costUsd: number; resolvedRates: PricingRates };
  export function estimateCostUsd(usage: TokenUsage, rates: Pricing): number;
  ```

- [ ] **Step 1: Write the golden test**

The expected values were produced by running the pre-S1-1 `priceCall` at `fff826752` on the same inputs expressed in the old vocabulary. Exact float equality holds because the new code adds the four cost terms in the same order.

```ts
// packages/nax/test/unit/agents/cost/price-call-golden.test.ts
/**
 * S1-1 golden equivalence (S1 spec section 8): config pricing converted with
 * toPricing, then priced with the standard-vocabulary priceCall, must equal the
 * pre-S1-1 priceCall on the same inputs. Expected values were captured from the
 * old implementation at main fff826752.
 */
import { describe, expect, test } from "bun:test";
import { priceCall } from "@/agents/cost";
import type { TokenUsage } from "@/agents/cost/standard-types";
import { type ConfigPricing, toPricing } from "@/config/schema-types";

interface GoldenCase {
  readonly name: string;
  readonly config: ConfigPricing;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly resolved: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const TIERED: ConfigPricing = {
  inputPer1M: 1.25,
  outputPer1M: 10,
  cacheReadPer1M: 0.125,
  cacheCreationPer1M: 1.5625,
  tiers: [{ inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25, cacheCreationPer1M: 3.125, inputTokensAbove: 200_000 }],
};
const WITH_CACHE: ConfigPricing = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 };

const CASES: readonly GoldenCase[] = [
  {
    name: "flat-no-cache-rates",
    config: { inputPer1M: 3, outputPer1M: 15 },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
    costUsd: 0.016800000000000002,
    resolved: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
  },
  {
    name: "flat-with-cache-rates",
    config: WITH_CACHE,
    usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 400_000 },
    costUsd: 9,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "tier-above",
    config: TIERED,
    usage: { inputTokens: 150_000, outputTokens: 1000, cacheReadTokens: 60_000, cacheWriteTokens: 0 },
    costUsd: 0.405,
    resolved: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  },
  {
    name: "tier-below",
    config: TIERED,
    usage: { inputTokens: 100_000, outputTokens: 1000 },
    costUsd: 0.135,
    resolved: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
  },
  {
    name: "tier-missing-cache-rates",
    config: { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, tiers: [{ inputPer1M: 4, outputPer1M: 16, inputTokensAbove: 100_000 }] },
    usage: { inputTokens: 90_000, outputTokens: 10, cacheReadTokens: 20_000, cacheWriteTokens: 5000 },
    costUsd: 0.46016,
    resolved: { input: 4, output: 16, cacheRead: 4, cacheWrite: 4 },
  },
  {
    name: "absent-cache-counts",
    config: WITH_CACHE,
    usage: { inputTokens: 10, outputTokens: 10 },
    costUsd: 0.00018,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "zero-cache-counts",
    config: WITH_CACHE,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.00018,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
];

describe("priceCall golden equivalence with pre-S1-1 math", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { costUsd, resolvedRates } = priceCall(c.usage, toPricing(c.config));
      expect(costUsd).toBe(c.costUsd);
      expect(resolvedRates).toEqual(c.resolved);
    });
  }
});

describe("toPricing", () => {
  test("fills each level's missing cache rates from that level's own input rate", () => {
    expect(toPricing({ inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, tiers: [{ inputPer1M: 4, outputPer1M: 16, inputTokensAbove: 100_000 }] })).toEqual({
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 2,
      tiers: [{ input: 4, output: 16, cacheRead: 4, cacheWrite: 4, inputTokensAbove: 100_000 }],
    });
  });

  test("omits tiers when the config has none", () => {
    expect(toPricing({ inputPer1M: 3, outputPer1M: 15 })).toEqual({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/agents/cost/price-call-golden.test.ts --timeout=60000`
Expected: FAIL, `toPricing` / `ConfigPricing` not exported from `@/config/schema-types`.

- [ ] **Step 3: Rename config types and add `toPricing`**

In `packages/nax/src/config/schema-types.ts`, rename `interface TokenPricing` to `ConfigPricing` and `interface TokenPricingTier` to `ConfigPricingTier` (keep their fields and doc comments; update the comment's reference from `TokenPricingTier` to `ConfigPricingTier`). Add to the imports:

```ts
import type { Pricing, PricingTier } from "../agents/cost/standard-types";
```

and add after `ConfigPricingTier`:

```ts
/**
 * Convert the user-config rate card (per-1M field names, optional cache rates)
 * to the standard `Pricing` (S1 spec section 5.1). An absent cache rate takes the
 * input rate of the same level: base from base, each tier from its own input
 * rate. That is exactly the fallback the pre-S1-1 `priceCall` applied.
 */
export function toPricing(config: ConfigPricing): Pricing {
  return {
    input: config.inputPer1M,
    output: config.outputPer1M,
    cacheRead: config.cacheReadPer1M ?? config.inputPer1M,
    cacheWrite: config.cacheCreationPer1M ?? config.inputPer1M,
    ...(config.tiers !== undefined ? { tiers: config.tiers.map(toPricingTier) } : {}),
  };
}

function toPricingTier(tier: ConfigPricingTier): PricingTier {
  return {
    input: tier.inputPer1M,
    output: tier.outputPer1M,
    cacheRead: tier.cacheReadPer1M ?? tier.inputPer1M,
    cacheWrite: tier.cacheCreationPer1M ?? tier.inputPer1M,
    inputTokensAbove: tier.inputTokensAbove,
  };
}
```

Inside the same file, replace every remaining `TokenPricing` reference (the `ModelDef.pricing` field type) with `ConfigPricing`. In `config/schema.ts:76` and `config/types.ts:68`, replace the re-exported `TokenPricing` with `ConfigPricing, ConfigPricingTier`. In `config/schemas-model.ts`, rename the zod constants `TokenPricingTierSchema`→`ConfigPricingTierSchema` and `TokenPricingSchema`→`ConfigPricingSchema` (both are module-local; update their two uses).

- [ ] **Step 4: Rewrite `estimate.ts` over the standard types**

Replace the body of `packages/nax/src/agents/cost/estimate.ts` below its file doc comment (keep the comment, replace `ResolvedRates`/`TokenPricing` wording with `PricingRates`/`Pricing`):

```ts
import type { Pricing, PricingRates, TokenUsage } from "./standard-types";
import { inputClassTokens } from "./calculate";

/**
 * `inputClassTokens` is re-exported from here so callers using
 * `estimateCostUsd` can size the prompt with the same definition tier
 * selection uses.
 */
export { inputClassTokens };

/**
 * One rate level after tier selection. Cache rates stay optional here: the
 * types say a catalog level always carries them, but the pre-S1-1 code
 * defended against a level without them and priced those tokens at the same
 * level's input rate. Keeping the fallback keeps that behaviour.
 */
interface EffectiveRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** The greatest `inputTokensAbove` the request's input-class total exceeds wins, for the whole request. */
function selectRates(rates: Pricing, totalInputClassTokens: number): EffectiveRates {
  let winner: EffectiveRates = rates;
  if (rates.tiers !== undefined) {
    let bestThreshold = Number.NEGATIVE_INFINITY;
    for (const tier of rates.tiers) {
      if (totalInputClassTokens > tier.inputTokensAbove && tier.inputTokensAbove > bestThreshold) {
        winner = tier;
        bestThreshold = tier.inputTokensAbove;
      }
    }
  }
  return winner;
}

function resolveRates(rates: Pricing, totalInputClassTokens: number): PricingRates {
  const effective = selectRates(rates, totalInputClassTokens);
  return {
    input: effective.input,
    output: effective.output,
    cacheRead: effective.cacheRead ?? effective.input,
    cacheWrite: effective.cacheWrite ?? effective.input,
  };
}

/**
 * Price one call. `costUsd` and `resolvedRates` come from one tier selection,
 * so recorded rates always reproduce the recorded cost.
 */
export function priceCall(usage: TokenUsage, rates: Pricing): { costUsd: number; resolvedRates: PricingRates } {
  const resolvedRates = resolveRates(rates, inputClassTokens(usage));

  const inputCost = (usage.inputTokens / 1_000_000) * resolvedRates.input;
  const outputCost = (usage.outputTokens / 1_000_000) * resolvedRates.output;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * resolvedRates.cacheRead;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * resolvedRates.cacheWrite;

  return {
    costUsd: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    resolvedRates,
  };
}

export function estimateCostUsd(usage: TokenUsage, rates: Pricing): number {
  return priceCall(usage, rates).costUsd;
}
```

Task 5 updates `calculate.ts` (`inputClassTokens`) in the same commit series; until then `typecheck` is red, which is expected between Task 4 and Task 6. Do not commit Task 4 alone; commit Tasks 4-6 together at the end of Task 6.

### Task 5: Cost core helpers over the standard types

**Files:**
- Modify: `packages/nax/src/agents/cost/calculate.ts` (`addTokenUsage`, `inputClassTokens`)
- Modify: `packages/nax/src/agents/cost/types.ts` (delete nax `TokenUsage`)
- Modify: `packages/nax/src/agents/cost/index.ts` (re-exports)
- Modify: `packages/nax/src/agents/cost/rate-card.ts` (`FALLBACK_RATES`, `LookupPricing`, `RateCard`)
- Modify: `packages/nax/src/agents/catalog/index.ts` (delete `toTokenPricing`)
- Test: `packages/nax/test/unit/agents/cost/{calculate,price-call,estimate,rate-card}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage;
  export function inputClassTokens(usage: TokenUsage): number;
  export const FALLBACK_RATES: Pricing; // { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 }
  export type LookupPricing = (provider: string, model: string) => Promise<Pricing | undefined>;
  export interface RateCard { readonly rates: Pricing; readonly source: RateCardSource }
  export async function lookupPricing(provider: string, model: string): Promise<Pricing | undefined>; // agents/catalog
  // agents/cost/index.ts re-exports: TokenUsage, Pricing, PricingRates, PricingTier (from ./standard-types)
  ```

- [ ] **Step 1: Write the new-behaviour tests**

Append to `packages/nax/test/unit/agents/cost/price-call.test.ts`:

```ts
describe("priceCall defensive cache fallback (S1-1)", () => {
  test("a level whose cache rates are missing at runtime prices cache tokens at that level's input rate", () => {
    // A catalog Pricing that, despite its type, arrived without cache rates.
    // JSON.parse keeps the fixture untyped without an `as unknown as` cast.
    const rates: import("@/agents/cost/standard-types").Pricing = JSON.parse('{"input":2,"output":8}');
    const { costUsd, resolvedRates } = priceCall(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      rates,
    );
    expect(resolvedRates).toEqual({ input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
    expect(costUsd).toBe(6);
  });
});
```

Append to `packages/nax/test/unit/agents/cost/calculate.test.ts`:

```ts
describe("addTokenUsage key presence (S1-1)", () => {
  test("keeps absent cache fields absent and present zeroes present, in input/output/cacheRead/cacheWrite order", () => {
    expect(JSON.stringify(addTokenUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }))).toBe(
      '{"inputTokens":4,"outputTokens":6}',
    );
    expect(
      JSON.stringify(addTokenUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 }, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 5 })),
    ).toBe('{"inputTokens":1,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":5}');
  });
});
```

The existing `price-call.test.ts` passes `rates` in the old `TokenPricing` shape. If its other cases fail in step 2, convert their rate literals with the Task 6 rename map (`inputPer1M`→`input`, and so on). Rate literals with missing cache rates become `toPricing({...})` calls with the old literal unchanged. Do not change any expected cost number.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/unit/agents/cost/ --timeout=60000`
Expected: FAIL (type errors and mismatched field names).

- [ ] **Step 3: Update `calculate.ts`**

Replace the import line and `addTokenUsage` / `inputClassTokens` in `packages/nax/src/agents/cost/calculate.ts`:

```ts
import type { TokenUsage } from "./standard-types";
import type { CostEstimate } from "./types";
```

```ts
/** Sum two TokenUsage values. Pure.
 * A cache field is present on the result when either operand carries it or the
 * sum is positive, preserving the zero-versus-absent distinction producers set. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheRead = toFiniteTokenCount(a.cacheReadTokens ?? 0) + toFiniteTokenCount(b.cacheReadTokens ?? 0);
  const cacheWrite = toFiniteTokenCount(a.cacheWriteTokens ?? 0) + toFiniteTokenCount(b.cacheWriteTokens ?? 0);
  return {
    inputTokens: toFiniteTokenCount(a.inputTokens) + toFiniteTokenCount(b.inputTokens),
    outputTokens: toFiniteTokenCount(a.outputTokens) + toFiniteTokenCount(b.outputTokens),
    ...(cacheRead > 0 || a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 || a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
```

```ts
export function inputClassTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
```

Keep the BUG-10 / BUG-58 comments that explain `toFiniteTokenCount`; update their field names.

- [ ] **Step 4: Update `types.ts` and `index.ts`**

In `packages/nax/src/agents/cost/types.ts`, delete the nax `TokenUsage` interface and its doc comment. Keep `ModelCostRates`, `CostEstimate`, `TokenUsageWithConfidence` (reporting types, spec section 5.2) and the `ModelTier` re-export.

In `packages/nax/src/agents/cost/index.ts`, replace

```ts
export type { ResolvedRates } from "./estimate";
```
with
```ts
export type { Pricing, PricingRates, PricingTier, TokenUsage } from "./standard-types";
```
and drop `TokenUsage` from the `./types` re-export line, leaving
```ts
export type { CostEstimate, ModelCostRates, TokenUsageWithConfidence } from "./types";
```

- [ ] **Step 5: Update `rate-card.ts` and `catalog/index.ts`**

In `packages/nax/src/agents/cost/rate-card.ts`: import `Pricing` from `./standard-types` instead of `TokenPricing`; change `RateCard.rates`, `LookupPricing` and `resolveRateCard`'s local `rates` to `Pricing`; and replace `FALLBACK_RATES` with

```ts
/**
 * The generic fallback card used when neither the alias file nor the catalog
 * resolves a model. Stamped `fallback-rates`, never `catalog-rates`. Cache rates
 * equal the input rate, which is what pricing resolved them to before S1-1.
 */
export const FALLBACK_RATES: Pricing = Object.freeze({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
```

In `packages/nax/src/agents/catalog/index.ts`: delete `toTokenPricing`, import `type Pricing` from `@nathapp/nax-ai` alongside the existing imports, remove the `TokenPricing` import and re-export, and make `lookupPricing` return the catalog's own `Pricing`, keeping the old defensive cache fill:

```ts
export async function lookupPricing(provider: string, model: string): Promise<Pricing | undefined> {
  const catalog = await loadCatalog(_catalogDeps.loadProviders);
  if (catalog === null) return undefined;
  try {
    const resolved = catalog.model(provider, model);
    if (resolved === undefined) return undefined;
    const p = resolved.pricing;
    // Fail-open fill kept from the pre-S1-1 mapping: a level the catalog shipped
    // without cache rates prices cache tokens at its input rate.
    return { ...p, cacheRead: p.cacheRead ?? p.input, cacheWrite: p.cacheWrite ?? p.input };
  } catch {
    return undefined;
  }
}
```

Keep the doc comments, updating `TokenPricing` mentions to `Pricing`.

- [ ] **Step 6: Run the cost tests**

Run: `bun test test/unit/agents/cost/ --timeout=60000`
Expected: PASS once `rate-card.test.ts` and `estimate.test.ts` literals use the rename map (they are subjects of this task). `typecheck` for the whole package is still red until Task 6.

### Task 6: Consumers and serializers

**Files (modify):**
- Native: `src/agents/native/models.ts` (delete `NativeUsage`, `toNaxTokenUsage`; `buildRateCard`), `src/agents/native/adapter.ts` (3 call sites, net line count must not grow), `src/agents/native/session/{turn-accumulator,rate-provenance,turn-types,turn-loop-round-trip,loop-events/types}.ts`
- Contract: `src/agents/{session-types,types,index}.ts`
- ACP: `src/agents/acp/{token-mapper,adapter-output,adapter-send-turn}.ts`
- Runtime: `src/runtime/{cost-aggregator,dispatch-events}.ts`, `src/runtime/middleware/{cost,usage-audit}.ts`
- Other: `src/agents/manager-dispatch.ts`, `src/execution/{types,post-run}.ts`, `src/execution/lifecycle/post-run-scratch-entries.ts`, `src/pipeline/stages/execution.ts`, `src/tdd/types.ts`, `src/session/session-runner.ts`
- NOT modified: `src/plugins/builtin/curator/collect.ts` (it reads persisted `metrics.json`, whose names do not change)
- Tests: every test file `bun run typecheck` flags after the rename, plus the new tests below.

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces:
  ```ts
  // native/models.ts
  export function buildRateCard(catalog: Pricing, override: ConfigPricing | undefined): { rates: Pricing; source: "config-override" | "catalog-rates" };
  // runtime/cost-aggregator.ts — persisted row shape, unchanged keys
  export interface CostRowRates { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number; cacheCreationPer1M: number }
  // runtime/middleware/cost.ts
  export function toCostRowRates(rates: PricingRates): CostRowRates;
  ```

- [ ] **Step 1: Write the zero-versus-absent accumulator test**

Append to the existing turn-accumulator test file (find it with `ls test/unit/agents/native/session/ | grep accumulator`):

```ts
describe("createTurnAccumulator cache presence (S1-1)", () => {
  test("absent cache fields stay absent; a reported zero stays zero", () => {
    const absent = createTurnAccumulator();
    absent.add({ inputTokens: 5, outputTokens: 1 }, 0);
    expect(JSON.stringify(absent.tokens())).toBe('{"inputTokens":5,"outputTokens":1}');

    const zero = createTurnAccumulator();
    zero.add({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0);
    expect(JSON.stringify(zero.tokens())).toBe('{"inputTokens":5,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}');
  });
});
```

- [ ] **Step 2: Write the cost-row shape tests**

Append to `packages/nax/test/unit/runtime/middleware/cost-rate-provenance.test.ts`:

```ts
describe("attachCostSubscriber — persisted key names (S1-1)", () => {
  test("standard-vocabulary usage and rates serialize to the schema-8 row keys", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "catalog-rates",
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
        rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      }),
    );

    const row = agg.recordedCost[0];
    expect(JSON.stringify(row.tokens)).toBe('{"input":100,"output":50,"cacheRead":10,"cacheWrite":5}');
    expect(JSON.stringify(row.rates)).toBe('{"inputPer1M":3,"outputPer1M":15,"cacheReadPer1M":0.3,"cacheCreationPer1M":3.75}');
    expect(row.schemaVersion).toBe(COST_ROW_SCHEMA_VERSION);
    expect(COST_ROW_SCHEMA_VERSION).toBe(8);
  });
});
```

In the same file, update the existing fixtures that are now the old vocabulary: `makeSessionTurnEvent`'s default `tokenUsage` becomes `{ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 }`. Where a test emits `rates: RATES_4` and asserts `row.rates` equals `RATES_4`, emit the standard form and assert the per-1M form:

```ts
const RATES_STD = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;
const RATES_ROW = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 } as const;
```

(Use the actual numbers of the file's existing `RATES_4`; the point is event = standard keys, row = per-1M keys.)

- [ ] **Step 3: Write the aggregated-rates row test**

Append to the rate-provenance test file (`ls test/unit/agents/native/session/ | grep rate-provenance`):

```ts
describe("aggregateRates key order (S1-1)", () => {
  test("weighted rates come back in input/output/cacheRead/cacheWrite order", () => {
    const totals = createRateTotals();
    addRateTotals(totals, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    addRateTotals(totals, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 0 }, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    const rates = aggregateRates(totals);
    expect(Object.keys(rates ?? {})).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect(rates?.input).toBe(1.5);
    expect(rates?.cacheWrite).toBe(1.25);
  });
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `bun test test/unit/runtime/middleware/cost-rate-provenance.test.ts test/unit/agents/native/session/ --timeout=60000`
Expected: FAIL (old field names in the implementation).

- [ ] **Step 5: Native path**

`src/agents/native/models.ts`:
- Delete `NativeUsage` and `toNaxTokenUsage`. Their callers use nax-ai's usage directly: nax-ai's `toTokenUsage` already produces `TokenUsage` with the same omit-only-undefined rule.
- Replace `buildRateCard` with:

```ts
export function buildRateCard(
  catalog: Pricing,
  override: ConfigPricing | undefined,
): { rates: Pricing; source: "config-override" | "catalog-rates" } {
  if (override !== undefined) return { rates: toPricing(override), source: "config-override" };
  return { rates: catalog, source: "catalog-rates" };
}
```

  Import `toPricing` and `type ConfigPricing` from `@/config/schema-types` (the file already imports from there, so the ratchet edge count is unchanged). Keep the doc comment and update it: the override still wins wholesale, and `toPricing` fills its missing cache rates.

`src/agents/native/adapter.ts`: replace `const tokenUsage = toNaxTokenUsage(result.usage);` with `const tokenUsage = result.usage;` (and the same at the other `toNaxTokenUsage` call sites); drop the import. Check the file stays at or under 599 lines: `wc -l src/agents/native/adapter.ts`.

`src/agents/native/session/turn-accumulator.ts`: rename `cacheReadInputTokens`→`cacheReadTokens` and `cacheCreationInputTokens`→`cacheWriteTokens` throughout (interface `TurnTokenTotals`, locals, spreads); `ResolvedRates`→`PricingRates`; import types from `@/agents/cost`.

`src/agents/native/session/rate-provenance.ts`: apply the rename map: `ResolvedRates`→`PricingRates`, usage fields, and `rates.inputPer1M`→`rates.input` and so on; `aggregateRates` returns `{ input, output, cacheRead, cacheWrite }` in that order. `RateTotals` field names (`cacheReadTokens`, `cacheCreationTokens`, `*CostPerMillionTokens`) are private accumulator names and may stay.

`src/agents/native/session/turn-types.ts`: `ResolvedRates`→`PricingRates` (both the import and the inline `import("../../cost").ResolvedRates`); in `cacheUsageFields` read `usage.cacheReadTokens` / `usage.cacheWriteTokens`.

`src/agents/native/session/{turn-loop-round-trip,loop-events/types}.ts`: type renames only.

- [ ] **Step 6: Contract, ACP and orchestrator renames**

Apply the rename map, type renames only unless noted:
- `src/agents/session-types.ts`, `src/agents/types.ts`: `ResolvedRates`→`PricingRates`. Check `wc -l src/agents/types.ts` is still 600 or less.
- `src/agents/index.ts:30`: re-export `TokenUsage` from `./cost` as before (it now resolves to the standard type).
- `src/agents/acp/token-mapper.ts`: return `cacheReadTokens: toFiniteOrUndefined(wire.cache_read_input_tokens)` and `cacheWriteTokens: toFiniteOrUndefined(wire.cache_creation_input_tokens)`.
- `src/agents/acp/adapter-output.ts`, `adapter-send-turn.ts`: type renames; `{ inputTokens: 0, outputTokens: 0 }` literals stay valid.
- `src/runtime/dispatch-events.ts`, `src/agents/manager-dispatch.ts`, `src/execution/types.ts`, `src/execution/post-run.ts`, `src/execution/lifecycle/post-run-scratch-entries.ts`, `src/pipeline/stages/execution.ts`: type renames.
- `src/tdd/types.ts`: rename the aggregate's fields to `cacheReadTokens` / `cacheWriteTokens`; keep the omit-zero spreads (`total.cacheReadTokens > 0 && {...}`).
- `src/session/session-runner.ts:32-37`: replace the inline shape with `totalTokenUsage?: TokenUsage;` importing `type TokenUsage` from `../agents/cost`.

- [ ] **Step 7: Serializers keep the persisted names**

`src/runtime/cost-aggregator.ts`: add the row DTO and use it for the row's `rates` field (the field at line ~132 currently typed `import("../agents/cost").ResolvedRates`):

```ts
/**
 * Rates as persisted on a cost row (schema 8). The keys predate the S1-1
 * vocabulary change and stay as they are; `toCostRowRates` maps the standard
 * `PricingRates` onto them.
 */
export interface CostRowRates {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cacheReadPer1M: number;
  readonly cacheCreationPer1M: number;
}
```

If `DispatchEvent.rates` and the row's `rates` share one declaration today, split them: the event carries `PricingRates`, the row carries `CostRowRates`.

`src/runtime/middleware/cost.ts`: add

```ts
/** Map the standard rates onto the persisted schema-8 row keys, in their historical order. */
export function toCostRowRates(rates: PricingRates): CostRowRates {
  return {
    inputPer1M: rates.input,
    outputPer1M: rates.output,
    cacheReadPer1M: rates.cacheRead,
    cacheCreationPer1M: rates.cacheWrite,
  };
}
```

and change line ~227 to `...(event.rates !== undefined ? { rates: toCostRowRates(event.rates) } : {}),`. In both `tokens` blocks (lines ~198 and ~293) read `tu.cacheReadTokens` and `tu.cacheWriteTokens`.

`src/runtime/middleware/usage-audit.ts:52-53`: read `tu?.cacheReadTokens` and `tu?.cacheWriteTokens`.

- [ ] **Step 8: Fix the remaining type errors, tests included**

Run: `bun run typecheck`
For every error: if it is a rename of this task's subject (usage fields, rate fields, type names), apply the rename map. If it is anything else, stop and report it; it means the inventory missed a consumer.

- [ ] **Step 9: Run the suite**

Run: `bun run test`
Expected: PASS. Pay attention to `test/unit/runtime/middleware/{cost,cost-rate-provenance,usage-audit}.test.ts`, `test/unit/metrics/`, and the native adapter tests: their expected JSON must not change. If an expected persisted value changed, the serializer mapping is wrong; fix the code, not the expectation.

- [ ] **Step 10: Commit Tasks 4-6**

```bash
git add -A packages/nax/src packages/nax/test
git commit -m "refactor: price and account usage in nax-ai's vocabulary"
```

### Task 7: Rename the metrics DTO

**Files:**
- Modify: `packages/nax/src/metrics/types.ts:9-55,187`, `packages/nax/src/metrics/tracker.ts:22-31,527`, `packages/nax/src/metrics/index.ts:32`
- Test: `packages/nax/test/unit/metrics/` (existing)

- [ ] **Step 1: Write the persisted-shape test**

Add to the metrics types test file (`ls test/unit/metrics/ | grep -i types`; create `test/unit/metrics/story-token-usage.test.ts` if none fits):

```ts
import { describe, expect, test } from "bun:test";
import { StoryTokenUsage } from "@/metrics";

describe("StoryTokenUsage persisted shape", () => {
  test("keeps the metrics.json key names and omits zero cache counts", () => {
    expect(JSON.stringify(new StoryTokenUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 3 }))).toBe(
      '{"inputTokens":1,"outputTokens":2,"cacheCreationInputTokens":3}',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/metrics/ --timeout=60000`
Expected: FAIL, `StoryTokenUsage` not exported.

- [ ] **Step 3: Rename**

In `metrics/types.ts` rename the `TokenUsage` interface and class to `StoryTokenUsage` (both declarations, the `biome-ignore` comment text, and the `tokens?: TokenUsage` field at line 187). Field names and `toJSON` stay byte-for-byte. Update `metrics/tracker.ts` (`import { StoryTokenUsage } from "./types"`, both `new TokenUsage(` sites, the `tokensFromSnapshot` return type) and the re-export in `metrics/index.ts`.

- [ ] **Step 4: Run tests**

Run: `bun run typecheck && bun test test/unit/metrics/ --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/metrics packages/nax/test/unit/metrics
git commit -m "refactor: rename metrics TokenUsage DTO to StoryTokenUsage"
```

### Task 8: Usage-vocabulary gate

**Files:**
- Create: `packages/nax/scripts/check-usage-vocabulary.ts`
- Modify: `packages/nax/package.json` (`check:usage-vocabulary`, append to `lint:checks`)
- Test: `packages/nax/test/unit/scripts/check-usage-vocabulary.test.ts`

**Interfaces:**
- Produces: `export function findVocabularyViolations(repoRoot: string): string[]` returning `"<repo-relative path>:<line>  <declaration>"` entries.

- [ ] **Step 1: Write the failing test**

```ts
// packages/nax/test/unit/scripts/check-usage-vocabulary.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findVocabularyViolations } from "@scripts/check-usage-vocabulary";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("check-usage-vocabulary", () => {
  test("nax-ai may declare the standard types", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax-ai/src/types.ts", "export interface TokenUsage { inputTokens: number }\n");
    write("packages/nax-ai/src/providers/types.ts", "export interface Pricing { input: number }\nexport interface PricingRates { input: number }\n");
    expect(findVocabularyViolations(root)).toEqual([]);
  });

  test("a second declaration anywhere else fails", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax/src/metrics/types.ts", "export interface TokenUsage { inputTokens: number }\nexport class TokenUsage {}\n");
    write("packages/nax/src/agents/cost/estimate.ts", "export interface ResolvedRates { inputPer1M: number }\n");
    write("packages/nax/src/x.ts", "export type TokenPricing = { a: number };\n");
    expect(findVocabularyViolations(root)).toEqual([
      "packages/nax/src/agents/cost/estimate.ts:1  interface ResolvedRates",
      "packages/nax/src/metrics/types.ts:1  interface TokenUsage",
      "packages/nax/src/metrics/types.ts:2  class TokenUsage",
      "packages/nax/src/x.ts:1  type TokenPricing",
    ]);
  });

  test("re-exports and similarly named types do not count", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax/src/agents/cost/standard-types.ts", 'export type { TokenUsage, Pricing } from "@nathapp/nax-ai";\n');
    write("packages/nax/src/metrics/types.ts", "export interface StoryTokenUsage { inputTokens: number }\nexport interface ConfigPricing { inputPer1M: number }\n");
    expect(findVocabularyViolations(root)).toEqual([]);
  });

  test("test files are not scanned", () => {
    root = makeTempDir("usage-vocab-");
    write("packages/nax/test/unit/x.test.ts", "interface TokenUsage { inputTokens: number }\n");
    expect(findVocabularyViolations(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/scripts/check-usage-vocabulary.test.ts --timeout=60000`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the gate**

```ts
#!/usr/bin/env bun
/**
 * Gate: one usage and rate vocabulary (S1 spec, ruling R3 and section 5.3).
 *
 * Only packages/nax-ai may declare an interface, type alias or class named
 * TokenUsage, NativeUsage, TokenPricing, TokenPricingTier, ResolvedRates,
 * Pricing, PricingRates or PricingTier. Re-exports (`export type { X } from`)
 * are not declarations. Edge shapes that keep historical keys carry their own
 * names (StoryTokenUsage, ConfigPricing, CostRowRates), so none is exempt.
 *
 * Scans every packages/<pkg>/src tree. Test files are not scanned.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { findRepoRoot } from "./lib/repo-root";

const NAMES = ["TokenUsage", "NativeUsage", "TokenPricing", "TokenPricingTier", "ResolvedRates", "Pricing", "PricingRates", "PricingTier"];
const DECL = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(interface|type|class)\\s+(${NAMES.join("|")})\\b`);
const OWNER = "packages/nax-ai/";

function* srcFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* srcFiles(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) yield full;
  }
}

export function findVocabularyViolations(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  let pkgs: string[];
  try {
    pkgs = readdirSync(packagesDir);
  } catch {
    return [];
  }
  const violations: string[] = [];
  for (const pkg of pkgs) {
    for (const file of srcFiles(join(packagesDir, pkg, "src"))) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      if (rel.startsWith(OWNER)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const match = DECL.exec(line);
          if (match) violations.push(`${rel}:${index + 1}  ${match[1]} ${match[2]}`);
        });
    }
  }
  return violations.sort(byCodePoint);
}

if (import.meta.main) {
  const violations = findVocabularyViolations(findRepoRoot(import.meta.dir));
  if (violations.length > 0) {
    console.error("[FAIL] usage/rate types may only be declared in packages/nax-ai (S1 spec section 5.3):");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("[OK] one usage and rate vocabulary");
}
```

The `type` keyword in `export type { X } from` is followed by `{`, not a name, so re-exports never match `DECL`.

- [ ] **Step 4: Run tests and wire the gate**

Run: `bun test test/unit/scripts/check-usage-vocabulary.test.ts --timeout=60000`
Expected: PASS.

In `packages/nax/package.json` add `"check:usage-vocabulary": "bun run scripts/check-usage-vocabulary.ts",` and append ` && bun run check:usage-vocabulary` to `lint:checks`.

Run: `bun run check:usage-vocabulary && bun scripts/check-gate-reachability.ts`
Expected: `[OK] one usage and rate vocabulary` (Tasks 4-7 removed every old declaration) and reachability passes. If the gate lists a file, that declaration was missed in Tasks 4-7: rename it, do not allow-list it.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/scripts/check-usage-vocabulary.ts packages/nax/test/unit/scripts/check-usage-vocabulary.test.ts packages/nax/package.json
git commit -m "chore: gate a single usage and rate vocabulary"
```

### Task 9: Verify and open PR S1-1

- [ ] **Step 1: Full verification**

Run (in `packages/nax`): `bun run typecheck && bun run lint && bun run test && bun run test:coverage`
Run (repo root): `bun run check:all`
Expected: all green. `check:agent-boundary` reports a count at or below the S1-0 baseline; if it fell, run `bun run check:agent-boundary:update` and commit the baseline.

- [ ] **Step 2: Confirm the at-limit files did not grow**

Run: `wc -l src/agents/types.ts src/agents/native/adapter.ts`
Expected: at most 600 and 599.

- [ ] **Step 3: Confirm no old names remain in source**

Run: `grep -rnE "\b(ResolvedRates|TokenPricing|TokenPricingTier|NativeUsage|toNaxTokenUsage|toTokenPricing)\b" src`
Expected: no output.

Run: `grep -rnE "cacheReadInputTokens|cacheCreationInputTokens" src`
Expected: matches only in `src/metrics/` and `src/plugins/builtin/curator/collect.ts` (persisted `metrics.json` names).

- [ ] **Step 4: Code review, then push and open the PR**

Run a code review of the branch diff against `main` before pushing. Then:

```bash
git push -u origin refactor/s1-1-usage-pricing-standard
```

PR title: `refactor: S1-1 one usage and pricing vocabulary (nax-ai's)`. The body lists the persisted shapes kept (cost row `tokens`/`rates`, `metrics.json`, user config `pricing`), the golden test, and the ratchet count before and after. Merge on green.

- [ ] **Step 5: Record status**

After merge, the maintainer records the S1-0 and S1-1 PR numbers and merge commits in the arc SSOT (master plan §5). Then write the S1-2 plan against the new `main`.
