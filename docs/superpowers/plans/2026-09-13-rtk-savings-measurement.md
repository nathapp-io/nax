# rtk Savings Measurement Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the per-verb evidence table that decides whether — and where — nax should route commands through rtk, before any interception code is written.

**Architecture:** A standalone analysis script under `scripts/`. It builds a corpus of real commands, executes each raw and through rtk, and reports bytes saved *after* nax's 40 KB slice, exit-code parity, and wall-clock cost. Its output populates `sites` and `git.verbs` in the rtk spec's config.

**Tech Stack:** TypeScript, Bun, `Bun.spawn`, existing `buildGitArgv` from `src/tools/git.ts`.

**Spec:** `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md` (US-001)

## Before you start (fresh-session handover)

You have no context from the session that wrote this. Read, in order:

1. `CLAUDE.md` at the repo root — Bun-native APIs only, TypeScript strict, `bun:test`, Biome.
2. `docs/architecture/ARCHITECTURE.md` and `.nax/rules/` (`project-conventions.md`,
   `test-writing.md`). Never edit `.claude/rules/` — it is generated from `.nax/rules/`.
3. The spec named above, especially §2.5 (why rtk's git wins are narrow) and US-001.

Conventions this plan depends on, verified against the tree at `8b65247dd`:

| Thing | Correct form | Easy mistake |
|---|---|---|
| Script importing `src/` | relative: `../src/tools/git` | the `@/` alias — scripts do not use it |
| Test importing a script | `@scripts/analyze-rtk-savings` | a relative `../../../scripts/...` path |
| `NaxError` | `new NaxError(message, code)` | arguments reversed |
| Script naming | `analyze-*` | `check-*` — that name makes it a CI-gated check script |

**Note on `_deps`:** the repo's DI convention wants external calls (spawn, fs) behind an
injectable `_deps` seam. This script deliberately spawns directly: executing the real
commands *is* the measurement, and a mocked spawn would measure nothing. If a reviewer
asks for the seam, push back with this reason rather than adding indirection that the
tests would then have to defeat.

Run `bun run check:all` before every commit.

## Global Constraints

- **Name the script `analyze-rtk-savings.ts`, not `check-*`.** `scripts/check-gate-reachability.ts:31-35` discovers only `check-*.ts|sh` and requires each to be reachable from `ci.yml`. Analysis scripts (`analyze-coverage-gap.ts`, `find-memory-leak.ts`, `concurrency-check.ts`) are deliberately outside that gate.
- **Must run without rtk installed** — skip with a clear message, never fail.
- **Never execute a mutating command.** The corpus is read-only verbs plus project quality commands. No `git add`, `commit`, `push`, `checkout`, `stash`, no `npm install`.
- Exit-code parity is a **correctness gate**, not a savings metric: any divergence disqualifies that verb regardless of how much it saves.
- Errors use `NaxError` (`@/errors`). Conventional commits, no attribution.

## Baseline already measured

Run before writing this plan, over every `~/.nax/nax/features/*/runs/*.jsonl` — **22,411 real tool calls, 81.6 MB of tool output**:

| Tool | Calls | Total KB | Share of bytes | % at 40 KB cap |
|---|---|---|---|---|
| Read | 7,405 | 55,672 | **66.6%** | 0.5% |
| Git | 1,065 | 9,201 | 11.0% | **10.0%** |
| Grep | 4,380 | 8,793 | 10.5% | 1.3% |
| RunCommand | 5,468 | 7,721 | 9.2% | 0.4% |
| Glob | 1,124 | 1,622 | 1.9% | — |

Two conclusions this plan must carry forward, because they bound the achievable result:

1. **rtk's addressable surface is `RunCommand` + `Git` ≈ 20% of tool output bytes** (~14.6% once the portion already above the cap is excluded). `Read` alone is 66.6% and rtk cannot touch it — it is nax's own in-process file read, not a command. Any claim that rtk cuts nax's context cost by a large fraction is false before measurement starts.
2. **The 40 KB cap is not usually binding** (0.4% of `RunCommand`, 10% of `Git` calls), so reduction below the cap *does* convert into real savings. This was the open question in the spec's "bytes after nax's slice" metric; for most calls, pre-slice and post-slice savings coincide. `Git` is the exception and the one to watch.

---

### Task 1: Corpus builder

**Files:**
- Create: `scripts/analyze-rtk-savings.ts`
- Test: `test/unit/scripts/analyze-rtk-savings.test.ts`

**Interfaces:**
- Consumes: `buildGitArgv` from `../src/tools/git` (scripts use relative imports, not the `@/` alias).
- Produces: `type CorpusEntry = { id: string; kind: "shell" | "argv"; command?: string; argv?: string[]; verb: string }`, `buildGitCorpus(): CorpusEntry[]`, `buildQualityCorpus(configPath): CorpusEntry[]`.

**The spec assumed argv could be mined from tool-audit ledgers. It cannot.** Run JSONL `coding-tool` lines carry `tool`, `outcome` and `resultBytes` but **no `input`**, and no tool-audit sink files exist locally. So git argv is *synthesized* through the real `buildGitArgv`, which is arguably better: it guarantees per-verb coverage and reproduces the always-emitted `--relative`, `--` and `.` that the spec identifies as what defeats rtk's compact paths.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildGitCorpus } from "@scripts/analyze-rtk-savings";

describe("buildGitCorpus", () => {
  test("covers every read verb the Git tool supports", () => {
    const verbs = new Set(buildGitCorpus().map((e) => e.verb));
    for (const v of ["diff", "log", "show", "status", "blame"]) expect(verbs).toContain(v);
  });

  test("entries carry the flags buildGitArgv always emits", () => {
    const diff = buildGitCorpus().find((e) => e.verb === "diff");
    expect(diff?.argv).toContain("--relative");
    expect(diff?.argv).toContain("--");
  });

  test("includes the log + nameOnly shape the spec calls out", () => {
    const entry = buildGitCorpus().find((e) => e.id === "log-nameonly");
    expect(entry?.argv).toContain("--name-only");
  });

  test("contains no mutating verb", () => {
    const verbs = buildGitCorpus().map((e) => e.verb);
    for (const bad of ["add", "commit", "push", "checkout", "stash"]) expect(verbs).not.toContain(bad);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: FAIL — cannot resolve `scripts/analyze-rtk-savings`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Measures what routing nax's commands through rtk would actually save.
 *
 * Gate on the rtk interception spec (US-001): its `sites` and `git.verbs`
 * ship empty and are opened by this script's output, not by assertion.
 *
 * Corpus note: run JSONLs record tool NAME and resultBytes but not INPUT, and
 * the tool-audit sink is not retained locally, so git argv cannot be replayed
 * from history. It is synthesised through the real `buildGitArgv` instead,
 * which guarantees verb coverage and reproduces the `--relative` / `--` / `.`
 * that defeat rtk's compact paths.
 */
import { buildGitArgv } from "../src/tools/git";

export interface CorpusEntry {
  readonly id: string;
  readonly kind: "shell" | "argv";
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly verb: string;
}

const GIT_SHAPES: readonly { id: string; input: Record<string, unknown> }[] = [
  { id: "diff-plain", input: { subcommand: "diff" } },
  { id: "diff-nameonly", input: { subcommand: "diff", nameOnly: true } },
  { id: "diff-ref", input: { subcommand: "diff", refs: ["HEAD~1", "HEAD"] } },
  { id: "log-plain", input: { subcommand: "log" } },
  { id: "log-oneline", input: { subcommand: "log", oneline: true } },
  { id: "log-nameonly", input: { subcommand: "log", nameOnly: true, maxCount: 7 } },
  { id: "show-plain", input: { subcommand: "show", refs: ["HEAD"] } },
  { id: "show-nameonly", input: { subcommand: "show", refs: ["HEAD"], nameOnly: true } },
  { id: "status-plain", input: { subcommand: "status" } },
  { id: "blame-file", input: { subcommand: "blame", paths: ["README.md"] } },
];

export function buildGitCorpus(): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const shape of GIT_SHAPES) {
    const argv = buildGitArgv(shape.input);
    if (!Array.isArray(argv)) continue;
    out.push({
      id: shape.id,
      kind: "argv",
      argv: ["git", ...argv],
      verb: String(shape.input.subcommand),
    });
  }
  return out;
}

export function buildQualityCorpus(commands: Record<string, unknown>): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const [name, spec] of Object.entries(commands)) {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const [i, cmd] of list.entries()) {
      if (typeof cmd !== "string" || cmd.includes("{{")) continue; // skip placeholder templates
      out.push({ id: list.length > 1 ? `${name}[${i}]` : name, kind: "shell", command: cmd, verb: name });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze-rtk-savings.ts test/unit/scripts/analyze-rtk-savings.test.ts
git commit -m "feat(scripts): build the rtk measurement corpus"
```

---

### Task 2: Paired execution with exit-code parity

**Files:**
- Modify: `scripts/analyze-rtk-savings.ts`
- Test: `test/unit/scripts/analyze-rtk-savings.test.ts`

**Interfaces:**
- Consumes: `CorpusEntry` (Task 1).
- Produces: `type Measurement = { id: string; verb: string; rawBytes: number; rtkBytes: number; rawExit: number; rtkExit: number; parity: boolean; rawMs: number; rtkMs: number; sliced: { raw: number; rtk: number } }`, `measure(entry, cwd): Promise<Measurement>`, `TOOL_MAX_BYTES = 40_000`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { measure, TOOL_MAX_BYTES, slice } from "@scripts/analyze-rtk-savings";

describe("slice", () => {
  test("models nax's post-truncation delivered size", () => {
    expect(slice(10)).toBe(10);
    expect(slice(TOOL_MAX_BYTES + 5_000)).toBe(TOOL_MAX_BYTES);
  });
});

describe("measure", () => {
  test("reports parity when both runs exit the same", async () => {
    const m = await measure({ id: "t", kind: "shell", command: "echo hi", verb: "echo" }, process.cwd());
    expect(m.rawExit).toBe(0);
    expect(m.parity).toBe(m.rawExit === m.rtkExit);
    expect(m.rawBytes).toBeGreaterThan(0);
  });

  test("a non-zero exit is preserved, not swallowed", async () => {
    const m = await measure({ id: "f", kind: "shell", command: "exit 3", verb: "exit" }, process.cwd());
    expect(m.rawExit).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: FAIL — `measure` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/analyze-rtk-savings.ts`:

```ts
/** nax's per-tool output ceiling; see DEFAULT_TOOL_MAX_BYTES in src/tools/runtime.ts. */
export const TOOL_MAX_BYTES = 40_000;

/** What the model is actually told, after nax truncates. The number that matters. */
export function slice(bytes: number): number {
  return Math.min(bytes, TOOL_MAX_BYTES);
}

export interface Measurement {
  readonly id: string;
  readonly verb: string;
  readonly rawBytes: number;
  readonly rtkBytes: number;
  readonly rawExit: number;
  readonly rtkExit: number;
  readonly parity: boolean;
  readonly rawMs: number;
  readonly rtkMs: number;
  readonly sliced: { readonly raw: number; readonly rtk: number };
}

async function run(argv: readonly string[], cwd: string): Promise<{ bytes: number; exit: number; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  // nax merges the two streams (src/quality/runner.ts:241), so measure the merge.
  return { bytes: [out, err].filter(Boolean).join("\n").length, exit, ms: Date.now() - started };
}

export async function measure(entry: CorpusEntry, cwd: string): Promise<Measurement> {
  const rawArgv = entry.kind === "shell" ? ["/bin/sh", "-c", entry.command ?? ""] : [...(entry.argv ?? [])];
  const rtkArgv =
    entry.kind === "shell" ? ["/bin/sh", "-c", `rtk ${entry.command ?? ""}`] : ["rtk", ...(entry.argv ?? [])];

  const raw = await run(rawArgv, cwd);
  const rtk = await run(rtkArgv, cwd);

  return {
    id: entry.id,
    verb: entry.verb,
    rawBytes: raw.bytes,
    rtkBytes: rtk.bytes,
    rawExit: raw.exit,
    rtkExit: rtk.exit,
    parity: raw.exit === rtk.exit,
    rawMs: raw.ms,
    rtkMs: rtk.ms,
    sliced: { raw: slice(raw.bytes), rtk: slice(rtk.bytes) },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: PASS, 6 tests. (The `measure` tests exercise the raw path; the rtk path degrades to a non-zero exit when rtk is absent, which is what Task 3 reports as "skipped".)

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze-rtk-savings.ts test/unit/scripts/analyze-rtk-savings.test.ts
git commit -m "feat(scripts): measure raw vs rtk bytes, exit parity and wall-clock"
```

---

### Task 3: Report and the disqualification gate

**Files:**
- Modify: `scripts/analyze-rtk-savings.ts`
- Test: `test/unit/scripts/analyze-rtk-savings.test.ts`

**Interfaces:**
- Consumes: `Measurement` (Task 2).
- Produces: `summarize(measurements): VerbRow[]` where `VerbRow = { verb: string; n: number; rawKB: number; rtkKB: number; savedPct: number; slicedSavedPct: number; disqualified: boolean; reason?: string }`, `formatReport(rows): string`, and a `main()` guarded by `import.meta.main`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { summarize } from "@scripts/analyze-rtk-savings";
import type { Measurement } from "@scripts/analyze-rtk-savings";

function m(over: Partial<Measurement>): Measurement {
  return {
    id: "x", verb: "diff", rawBytes: 1000, rtkBytes: 400, rawExit: 0, rtkExit: 0,
    parity: true, rawMs: 10, rtkMs: 12, sliced: { raw: 1000, rtk: 400 }, ...over,
  };
}

describe("summarize", () => {
  test("reports percentage saved before and after the slice", () => {
    const [row] = summarize([m({})]);
    expect(row.savedPct).toBeCloseTo(60, 1);
    expect(row.slicedSavedPct).toBeCloseTo(60, 1);
  });

  test("a verb with any exit divergence is disqualified regardless of savings", () => {
    const [row] = summarize([m({ rawExit: 0, rtkExit: 1, parity: false, rtkBytes: 1 })]);
    expect(row.disqualified).toBe(true);
    expect(row.reason).toContain("exit");
  });

  test("savings above the cap do not count as delivered savings", () => {
    // Both saturate the 40 KB slice: full output shrank, what the model sees did not.
    const [row] = summarize([
      m({ rawBytes: 2_000_000, rtkBytes: 200_000, sliced: { raw: 40_000, rtk: 40_000 } }),
    ]);
    expect(row.savedPct).toBeCloseTo(90, 1);
    expect(row.slicedSavedPct).toBeCloseTo(0, 1);
  });

  test("one disqualified sample disqualifies the whole verb", () => {
    const [row] = summarize([m({}), m({ parity: false, rawExit: 0, rtkExit: 2 })]);
    expect(row.disqualified).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: FAIL — `summarize` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/analyze-rtk-savings.ts`:

```ts
export interface VerbRow {
  readonly verb: string;
  readonly n: number;
  readonly rawKB: number;
  readonly rtkKB: number;
  /** Reduction in FULL output. The headline, and the misleading one. */
  readonly savedPct: number;
  /** Reduction in what the model is actually told. The number that matters. */
  readonly slicedSavedPct: number;
  readonly disqualified: boolean;
  readonly reason?: string;
}

export function summarize(measurements: readonly Measurement[]): VerbRow[] {
  const byVerb = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const list = byVerb.get(m.verb) ?? [];
    list.push(m);
    byVerb.set(m.verb, list);
  }

  const rows: VerbRow[] = [];
  for (const [verb, list] of byVerb) {
    const raw = list.reduce((s, m) => s + m.rawBytes, 0);
    const rtk = list.reduce((s, m) => s + m.rtkBytes, 0);
    const slicedRaw = list.reduce((s, m) => s + m.sliced.raw, 0);
    const slicedRtk = list.reduce((s, m) => s + m.sliced.rtk, 0);
    const diverged = list.filter((m) => !m.parity);

    rows.push({
      verb,
      n: list.length,
      rawKB: raw / 1024,
      rtkKB: rtk / 1024,
      savedPct: raw === 0 ? 0 : (100 * (raw - rtk)) / raw,
      slicedSavedPct: slicedRaw === 0 ? 0 : (100 * (slicedRaw - slicedRtk)) / slicedRaw,
      disqualified: diverged.length > 0,
      // Exit-code parity is a CORRECTNESS gate: a verb that changes a command's
      // exit code is unusable no matter how much output it saves, because nax
      // computes `success: exitCode === 0` from it.
      reason:
        diverged.length > 0
          ? `exit-code divergence on ${diverged.length}/${list.length} (e.g. ${diverged[0].id}: raw ${diverged[0].rawExit} vs rtk ${diverged[0].rtkExit})`
          : undefined,
    });
  }
  return rows.sort((a, b) => b.rawKB - a.rawKB);
}

export function formatReport(rows: readonly VerbRow[]): string {
  const lines = ["verb\tn\trawKB\trtkKB\tsaved%\tdelivered-saved%\tverdict"];
  for (const r of rows) {
    lines.push(
      [
        r.verb, r.n, r.rawKB.toFixed(0), r.rtkKB.toFixed(0),
        r.savedPct.toFixed(1), r.slicedSavedPct.toFixed(1),
        r.disqualified ? `DISQUALIFIED — ${r.reason}` : "ok",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const hasRtk = Bun.spawnSync(["rtk", "--version"]).exitCode === 0;
  if (!hasRtk) {
    console.log("rtk not on PATH — skipping. Install rtk to produce the measurement table.");
    process.exit(0);
  }
  const cwd = process.cwd();
  const configPath = `${cwd}/.nax/config.json`;
  const commands = (await Bun.file(configPath).json().catch(() => ({}))).quality?.commands ?? {};
  const corpus = [...buildGitCorpus(), ...buildQualityCorpus(commands)];
  const measurements: Measurement[] = [];
  for (const entry of corpus) measurements.push(await measure(entry, cwd));
  console.log(formatReport(summarize(measurements)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/scripts/analyze-rtk-savings.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run it for real**

Run: `bun run scripts/analyze-rtk-savings.ts`
Expected: either the skip message, or a tab-separated table. Record the output in the PR body — that table is this plan's actual deliverable.

- [ ] **Step 6: Commit**

```bash
git add scripts/analyze-rtk-savings.ts test/unit/scripts/analyze-rtk-savings.test.ts
git commit -m "feat(scripts): report per-verb rtk savings with an exit-parity gate"
```

---

### Task 4: Feed the result back into the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md`

- [ ] **Step 1: Record the measured table**

Replace the spec's "Stated expectation, so the data can falsify it" paragraph in US-001 with the measured table, keeping the original prediction alongside it so the prediction can be judged.

- [ ] **Step 2: Set the config defaults from evidence**

Update US-007's example config so `sites` and `git.verbs` carry the measured values. A verb marked `DISQUALIFIED` must not appear in `git.verbs` regardless of its savings.

- [ ] **Step 3: Record the addressable-surface ceiling**

Add to §2.5 the baseline from this plan's header: `RunCommand` + `Git` are ~20% of tool output bytes and `Read` alone is 66.6%, so rtk's ceiling is bounded well below any figure rtk's own README reports for bash output generally.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md
git commit -m "docs: replace rtk spec predictions with measured savings"
```

---

## Self-Review

**Spec coverage (US-001):**

| Spec metric | Task |
|---|---|
| bytes before/after | 2 (`rawBytes`/`rtkBytes`), 3 (`savedPct`) |
| bytes after nax's 40 KB slice | 2 (`sliced`), 3 (`slicedSavedPct`) |
| exit-code parity as correctness gate | 2 (`parity`), 3 (`disqualified`) |
| wall-clock delta | 2 (`rawMs`/`rtkMs`) |
| corpus from real commands | 1 |
| runs without rtk installed | 3 Step 3 (`import.meta.main` guard) |
| output decides `sites` / `git.verbs` | 4 |

**Deliberately not implemented:** the spec's "output-equivalence class" (identical / reduced-but-faithful / restructured) and the SQLite-contention probe. The first needs a human judgment call per verb that a script cannot make honestly — the table gives the reviewer byte counts and exit codes to make it from. The second is only worth building if the table shows enough savings to proceed at all; building it now would be work ahead of the decision it informs. Both are called out here rather than silently dropped.

**Type consistency:** `CorpusEntry` (Task 1) is consumed unchanged by `measure` (Task 2). `Measurement` (Task 2) is consumed unchanged by `summarize` (Task 3). `slice`/`TOOL_MAX_BYTES` are defined once in Task 2 and used in Tasks 2 and 3.
