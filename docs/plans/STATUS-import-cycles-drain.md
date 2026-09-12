# Import-cycle drain - status

The live doc for draining `scripts/baselines/import-cycles-baseline.json` toward empty.
Successor in style to `STATUS-coverage-drain.md` and `STATUS-test-debt-drain.md`:
**section 0 is the live state and is re-measured, never carried forward. Section 8 is
append-only** - each entry records what was true when written and is not edited afterwards.

**Written for handover to an implementer with no prior context on this analysis.** Every
task below names the exact file, the exact import line, the symbols involved, the legal
technique, and the command that proves it worked. You do not need to re-derive the
analysis. You *do* need to re-measure after every task.

---

## 0. Current state - measured 2026-09-13 at `2cf791a6a`

```
bun run scripts/check-import-cycles.ts
[OK] 132 modules in runtime import cycles (baseline: 135) (down 3 since last baseline).
```

| Reading | Value |
|:--|--:|
| Baseline file `count` | **135** |
| Actual cyclic modules in `src/` | **132** |
| Strongly-connected components (SCCs) that are cyclic | **5** |
| Largest SCC | **92 modules** |

The five components:

| # | Size | Territory |
|--:|--:|:--|
| 1 | **92** | `operations/` + `findings/` + `review/` + `context/engine/` + `agents/` + `debate/selectors/` + `prompts/` + `routing/` + `metrics/` |
| 2 | **31** | `execution/` + `pipeline/` |
| 3 | **5** | `cli/{index,plan,plan-command}` + `plan/strategies/` |
| 4 | **2** | `test-runners/{index,scoped-selection}` |
| 5 | **2** | `cli/{rules,rules-migrate}` |

**The baseline is 3 stale (135 recorded, 132 actual).** Task 0 fixes that before any real work.

**Simulated end state of this plan: 132 -> 20.** The 17 edge cuts across the 12 tasks in
section 3 were chosen by greedy search over every internal edge of every component (remove
edge, recompute Tarjan SCCs, keep the edge whose removal frees the most modules), then
**simulated again as the exact task sequence below** - so the per-task expected counts are
measured against this plan's ordering, not a generic ranking. The residue is one 20-module
`execution/` + `pipeline/` knot described in section 5.

The unconstrained greedy optimum is 15, not 20. The difference is one cut this plan
deliberately refuses: `src/execution/index.ts -> ./lifecycle` (frees 5) would mean deleting a
public barrel re-export, which section 1.4 forbids. Those 5 modules stay in the residue.

---

## 1. Rules of engagement - read this before touching anything

### 1.1 Why cycles matter here

ESM evaluates modules in dependency order. Inside a cycle one participant observes a
partially-initialised binding of another - `undefined` at module scope - which crashes on
first *use* rather than at import time. This is not theoretical in this repo: see
`docs/specs/2026-08-20-deep-relatives-migration-runbook.md` section 7.2, where the old
(broken) version of this check reported 0 while a genuine cycle crashed the test suite at
module-init time.

### 1.2 Two gates pull against each other

| Gate | Demands |
|:--|:--|
| `bun run check:alias-internals` | In `src/`, `bin/`, `scripts/`: a **value** import spelled `@/<dir>/<internal>` is **forbidden** when `src/<dir>/index.ts` exists. Go through the barrel. |
| `bun run check:import-cycles` | Routing an import through a barrel **adds an edge to that barrel**, which can close a loop. |

So "just import the leaf directly with `@/`" is **not** available to you. The four legal
techniques are in 1.3. All four have existing precedent in this repo.

### 1.3 The four legal techniques

Ranked cheapest-first. Prefer the earliest one that applies.

**(A) Convert the value import to `import type`.** Type-only imports are erased by
TypeScript, so both gates exempt them. `check-import-cycles.ts` skips any specifier whose
prelude matches `/^\s*(?:import|export)\s+type\b/`.

- Applies when every symbol in the statement is used only in type position.
- **Trap:** a statement like `import { type Foo, bar } from "x"` is *still a value edge* -
  the prelude is not `import type`. You must split it into two statements, one `import type
  { Foo }` and one `import { bar }`, and only the first stops counting.

**(B) Import the defining leaf via a *relative* path.** `check-alias-internals` only
inspects `@/` and `@test/` specifiers - relative paths are unchecked, and
`project-conventions.md` says explicitly "Aliases are not mandatory - relative paths are
still fine."

- **Hard limit:** biome's `noRestrictedImports` bans the patterns `../../*` and `../../**`.
  So `./sibling` and `../one-level-up` are legal; `../../two-levels-up` is **not**.
- This is the fix for every *self-barrel* edge (a leaf importing its own directory's
  `index.ts`).

**(C) Promote the target leaf to its own nested barrel.** Move `x.ts` to `x/index.ts`, then
`@/<dir>/x` is an **exact** barrel match and legal under `check-alias-internals`, while
reaching the leaf without loading the parent barrel.

- This is the documented remedy in `.nax/rules/project-conventions.md` ("When a conversion
  is rejected... promote the target to its own nested barrel").
- Precedent: `src/review/{runner,semantic-categories}`, `src/execution/{helpers,story-context}`.
- **Trap:** never leave both `x.ts` and `x/index.ts` on disk. Resolution prefers the file,
  so `@/dir/x` never reaches the barrel; `check:alias-internals` fails on that collision
  (#1648).

**(D) Defer the import to call time with `await import(...)`.** `check-import-cycles.ts`
only matches *static* `import/export ... from "..."` statements, and a dynamic import
genuinely defers evaluation past module init - so this removes the edge from the ratchet
*and* from the real initialisation order. Not a loophole; it is the honest fix.

- Precedent: **84 existing uses** in `src/`, e.g. `src/pipeline/stages/acceptance.ts:50`,
  `src/operations/full-suite-gate.ts:165`, `src/cli/plan-command.ts:156`.
- Only usable inside an `async` function, and only when the symbol is consumed at call
  time rather than at module scope.

### 1.4 What you may NOT do without escalating

- **Do not delete or relocate a public re-export from a barrel** to break a cycle (e.g.
  removing `export ... from "./engine"` in `src/context/index.ts`). That changes the public
  API of `@/context`. If a task looks like it needs this, stop and escalate - section 3
  marks the two tasks where this temptation arises and gives the correct alternative.
  **Section 2.3 is the mechanical test for this case** - read it before acting on any edge
  the ranker suggests.
- **Do not run `check:import-cycles:update` to raise the baseline.** The baseline only ever
  goes down in this drain.
- **Do not weaken `scripts/check-import-cycles.ts` or `scripts/check-alias-internals.ts`.**
  The gates are not the problem. (Correcting a demonstrated *false positive* is not weakening
  - that happened once, in `bf3ad94b5`, with a before/after diff of the whole graph as
  evidence and the reported count unchanged. Hold any further gate change to that bar, and
  escalate rather than doing it inline.)

### 1.5 Known traps in this repo

- `bun run test:coverage` is **not** part of `bun run check:all`. Technique (C) creates a
  new file under `src/`, so run `bun run test:coverage` for any task that uses it.
- The file-size gate (`check:file-sizes`) is a per-file ratchet. Technique (B) and (D) can
  grow a file; if the gate fires, that is a signal to split the file, not to raise the
  baseline.
- `git checkout <file>` restores from the **index**, not from HEAD. After any restore,
  re-grep for your change before assuming it is gone or still there.
- **Every line number in this document is a snapshot taken 2026-09-13 against the
  pre-edit file.** Deleting a line shifts everything below it up; splitting one import
  statement into two shifts everything below it down. Always match on the **quoted text**,
  and if a task touches several lines in one file, re-grep between steps rather than trusting
  the second number. The line numbers are navigation aids, not edit addresses.

---

## 2. The measurement loop

### 2.1 After every single task

```bash
cd <repo root>
bun run scripts/check-import-cycles.ts          # must print [OK], count must have DROPPED
bun x tsc --noEmit                              # types still sound
bun run check:alias-internals                   # you did not launder a barrel violation
```

Then lower the baseline and commit:

```bash
bun run check:import-cycles:update
bun run scripts/check-import-cycles.ts          # confirm [OK] against the NEW baseline
```

**The check fails if any module becomes *newly* cyclic even when the total drops.** That is
deliberate (`formatReport` diffs against `baseline.modules`, not just `baseline.count`), and
it is your safety net: if a "fix" trades one cycle for another you will be told.

### 2.2 Before each wave: re-rank the edges

The section 3 ordering and its expected counts come from a simulation that assumed the cuts
happen exactly in that order. If you deviate, the numbers drift. Re-rank with this script:

```bash
mkdir -p /tmp/cycle-analysis && cat > /tmp/cycle-analysis/rank.ts <<'SCRIPT'
import { buildImportGraph } from "<REPO>/scripts/check-import-cycles.ts";
import { relative, dirname } from "node:path";
const ROOT = "<REPO>";
const graph = buildImportGraph(ROOT);

function sccs(g: Map<string, string[]>, nodes: Set<string>): string[][] {
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>();
  const st: string[] = []; let c = 0; const out: string[][] = [];
  for (const root of [...nodes].sort()) {
    if (idx.has(root)) continue;
    const stack = [{ n: root, i: 0 }];
    idx.set(root, c); low.set(root, c); c++; st.push(root); on.add(root);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      const deps = (g.get(f.n) ?? []).filter((d) => nodes.has(d));
      if (f.i < deps.length) {
        const w = deps[f.i]!; f.i++;
        if (!idx.has(w)) { idx.set(w, c); low.set(w, c); c++; st.push(w); on.add(w); stack.push({ n: w, i: 0 }); }
        else if (on.has(w)) low.set(f.n, Math.min(low.get(f.n)!, idx.get(w)!));
        continue;
      }
      stack.pop();
      const p = stack[stack.length - 1];
      if (p) low.set(p.n, Math.min(low.get(p.n)!, low.get(f.n)!));
      if (low.get(f.n) === idx.get(f.n)) {
        const comp: string[] = []; let w: string | undefined;
        do { w = st.pop()!; on.delete(w); comp.push(w); } while (w !== f.n);
        out.push(comp);
      }
    }
  }
  return out.filter((cp) => cp.length > 1 || (g.get(cp[0]!) ?? []).includes(cp[0]!));
}
const ALL = new Set(graph.keys());
const total = (g: Map<string, string[]>) => sccs(g, ALL).reduce((s, c) => s + c.length, 0);
const base = total(graph);
console.log(`cyclic modules: ${base}`);
const rows: { e: string; freed: number; kind: string }[] = [];
for (const comp of sccs(graph, ALL)) {
  const set = new Set(comp);
  for (const v of comp) for (const w of new Set(graph.get(v) ?? [])) {
    if (!set.has(w)) continue;
    const g2 = new Map(graph); g2.set(v, (graph.get(v) ?? []).filter((d) => d !== w));
    const dv = dirname(v), dw = dirname(w);
    const kind = !w.endsWith("/index.ts") ? "leaf"
      : dw === dv ? "self-barrel"                      // own directory's barrel
      : dw.startsWith(`${dv}/`) ? "child-barrel"       // barrel of a subdirectory of mine
      : v.startsWith(`${dw}/`) ? "parent-barrel"       // an ancestor barrel
      : "cross-barrel";                                // an unrelated directory's barrel
    rows.push({ e: `${relative(ROOT, v)} -> ${relative(ROOT, w)}`, freed: base - total(g2), kind });
  }
}
rows.sort((a, b) => b.freed - a.freed);
for (const r of rows.slice(0, 20)) console.log(`  frees=${String(r.freed).padStart(3)}  [${r.kind}]  ${r.e}`);
SCRIPT
perl -pi -e "s|<REPO>|$(pwd)|g" /tmp/cycle-analysis/rank.ts   # portable; `sed -i ''` is BSD-only
bun /tmp/cycle-analysis/rank.ts
```

Reading the `kind` column tells you which technique to reach for:

| kind | meaning | usual technique |
|:--|:--|:--|
| `self-barrel` | file imports its **own** directory's `index.ts` | **(B)** - import the defining sibling as `./leaf` |
| `child-barrel` | file imports the barrel of a **subdirectory of its own** directory | **(B)** - `./subdir/leaf` is one level down, always legal |
| `parent-barrel` | nested file imports an **ancestor** barrel | **(C)** or **(A)** |
| `cross-barrel` | file imports an **unrelated** directory's barrel | **(C)** or **(D)** |
| `leaf` | direct file-to-file | **(A)** or **(D)** |

`self-barrel` and `child-barrel` are the cheap ones: the defining leaf is always reachable
with a single-segment relative path, so technique (B) applies and biome's `../../` ban never
bites. `parent-barrel` and `cross-barrel` are where you have to think.

### 2.3 The single most important rule for reading the ranker

**If the left-hand side of an edge ends in `/index.ts`, do not cut that edge.** A barrel
importing something is a barrel **re-exporting its own public surface**. Cutting it deletes a
public export - an API change, forbidden by section 1.4. Cut a **back-edge into** the barrel
instead: same loop, no API change.

The ranker does not know this, and its top rows are full of the trap. Every pair below is the
*same loop* reported twice, once per direction - and in each pair the cheap-looking row is the
forbidden one:

| Ranker row | `frees` | Verdict |
|:--|--:|:--|
| `src/findings/cycle.ts -> src/operations/index.ts` | 55 | **cut this** - it is Task 4 |
| `src/findings/index.ts -> src/findings/cycle.ts` | 55 | **refuse** - barrel re-exporting its own leaf |
| `src/review/review-iteration-store.ts -> src/findings/index.ts` | 43 | legal to cut |
| `src/review/index.ts -> src/review/review-iteration-store.ts` | 43 | **refuse** - barrel re-exporting its own leaf |
| `src/context/index.ts -> src/context/engine/index.ts` | 9 | **refuse** - parent barrel re-exporting its child; this is the Task 6 trap |

So: read the ranker for *which loop* to attack and how much it is worth, then pick the
direction yourself using this rule. Never take the edge the ranker happens to list first.

---

## 3. The task queue

Expected counts are the simulation's, assuming this exact order. **Re-measure; trust the
tool over this table.**

---

### Task 0: Re-baseline to the true current count

The baseline says 135; reality is 132. Sync it so later diffs are meaningful.

**Files:** Modify `scripts/baselines/import-cycles-baseline.json`

- [ ] **Step 1: Confirm the drift**

```bash
bun run scripts/check-import-cycles.ts
```
Expected: `[OK] 132 modules in runtime import cycles (baseline: 135) (down 3 since last baseline).`

- [ ] **Step 2: Lower the baseline**

```bash
bun run check:import-cycles:update
```
Expected: `[OK] Baseline saved: 132 modules in runtime import cycles in src/.`

- [ ] **Step 3: Confirm clean against the new baseline**

```bash
bun run scripts/check-import-cycles.ts
```
Expected: `[OK] 132 modules in runtime import cycles (baseline: 132).`

- [ ] **Step 4: Commit**

```bash
git add scripts/baselines/import-cycles-baseline.json
git commit -m "chore: sync import-cycles baseline to actual (135 -> 132)"
```

---

### Wave 1 - the trivial self-barrel edges (warm-up, 132 -> 127)

Do these first. They are mechanical, they prove your loop works, and they are the exact
shape of technique (B).

### Task 1: `test-runners/scoped-selection.ts` stops importing its own barrel

Frees **2** (kills component #4 entirely).

**Files:** Modify `src/test-runners/scoped-selection.ts:15`

Current line 15:
```typescript
import { DEFAULT_TEST_FILE_PATTERNS, globsToTestRegex } from "@/test-runners";
```

Both symbols are defined in a **sibling of the same directory**:
- `DEFAULT_TEST_FILE_PATTERNS` - `src/test-runners/conventions.ts:28`
- `globsToTestRegex` - `src/test-runners/conventions.ts:112`

- [ ] **Step 1: Replace the self-barrel import with the sibling**

```typescript
import { DEFAULT_TEST_FILE_PATTERNS, globsToTestRegex } from "./conventions";
```

- [ ] **Step 2: Verify the cycle is gone and nothing else broke**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
```
Expected: count **130**; `src/test-runners/index.ts` and `src/test-runners/scoped-selection.ts`
no longer listed by `bun run scripts/check-import-cycles.ts --list`.

- [ ] **Step 3: Run the owning tests**

```bash
bun test test/unit/test-runners/ --timeout=60000
```
Expected: PASS.

- [ ] **Step 4: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/test-runners/scoped-selection.ts scripts/baselines/import-cycles-baseline.json
git commit -m "refactor: break test-runners self-barrel import cycle"
```

---

### Task 2: `context/engine/effectiveness.ts` stops importing its own barrel

Frees **2**.

**Files:** Modify `src/context/engine/effectiveness.ts:16`

Current line 16:
```typescript
import { globToRegex, normalizePath } from "./index";
```

Both symbols are defined in `src/context/engine/providers/static-rules.ts` (`normalizePath`
at :119, `globToRegex` at :123). That is one directory *down*, so a relative path is legal
and is not a `../../` pattern.

- [ ] **Step 1: Replace with the defining leaf**

```typescript
import { globToRegex, normalizePath } from "./providers/static-rules";
```

- [ ] **Step 2: Verify**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
```
Expected: count **129**. (Only 1 module is freed here, not 2: `src/context/engine/index.ts`
stays cyclic through other edges in the 92-module component.)

- [ ] **Step 3: Run the owning tests**

```bash
bun test test/unit/context/ --timeout=60000
```
Expected: PASS.

- [ ] **Step 4: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/context/engine/effectiveness.ts scripts/baselines/import-cycles-baseline.json
git commit -m "refactor: break context/engine self-barrel import cycle"
```

---

### Task 3: `cli/rules-migrate.ts` stops reaching back into `cli/rules.ts`

Frees **2** (kills component #5 entirely).

**Files:** Modify `src/cli/rules-migrate.ts:19`, `src/cli/rules.ts`; likely Create `src/cli/rules-cli-deps.ts`

Current line 19 of `rules-migrate.ts`:
```typescript
import { _rulesCLIDeps } from "./rules";
```

`rules.ts` imports `rules-migrate.ts` back, so this is a mutual 2-cycle. `_rulesCLIDeps` is
an injectable deps object - the standard fix is to give it its own home that neither file
owns.

- [ ] **Step 1: Confirm the shape of the mutual edge**

```bash
grep -n "rules-migrate\|_rulesCLIDeps" src/cli/rules.ts
grep -rn "_rulesCLIDeps" src/ test/
```
Note every consumer before moving anything. If a test imports `_rulesCLIDeps` from
`@/cli/rules`, that spelling must keep working (tests may reach `src/` internals, so a
re-export from `rules.ts` is fine and does **not** create a cycle in this direction).

- [ ] **Step 2: Move the deps object to its own module**

Create `src/cli/rules-cli-deps.ts` holding the `_rulesCLIDeps` declaration exactly as it
appears in `rules.ts` today (copy it verbatim, including its type annotation and comments).

- [ ] **Step 3: Point both files at the new module**

In `src/cli/rules-migrate.ts` line 19:
```typescript
import { _rulesCLIDeps } from "./rules-cli-deps";
```
In `src/cli/rules.ts`, delete the local declaration and add, preserving the old spelling for
existing callers:
```typescript
export { _rulesCLIDeps } from "./rules-cli-deps";
```

- [ ] **Step 4: Verify**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
bun run check:file-sizes
bun test test/unit/cli/ --timeout=60000
bun run test:coverage
```
Expected: count **127**; a new `src/` file exists so coverage must be re-checked (section 1.5).

- [ ] **Step 5: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/cli/ scripts/baselines/
git commit -m "refactor: extract _rulesCLIDeps to break cli/rules cycle"
```

---

### Wave 2 - the two big structural wins (127 -> 61)

These two tasks account for **66 of the 132**. Do them one at a time, with a full verify
between them.

### Task 4: defer `findings/cycle.ts`'s dependency on `@/operations`

**Frees 55.** The single highest-leverage change in this plan: it splits the 92-module
component into a 15-module remainder plus acyclic modules.

**Files:** Modify `src/findings/cycle.ts` (lines 13, 45-48, 130, 283)

> **Line numbers below are all measured against the file as it is now.** Step 2 deletes line
> 13, which shifts every later line up by one (45 -> 44, 130 -> 129, 283 -> 282). Match on the
> quoted *text*, not the number, and re-grep between steps:
> `grep -n "_cycleDeps\|doCallOp\|newCorrelationId" src/findings/cycle.ts`

Current line 13:
```typescript
import { callOp as _callOp, newCorrelationId } from "@/operations";
```

Why technique (D) is right here: both symbols are consumed **only at call time**, inside the
`async function runFixCycle` (declared at :116):
- `_callOp` is read at :130 as `_deps.callOp ?? _cycleDeps.callOp`
- `newCorrelationId` is read at :283 as `deps: { ..., newCallId: newCorrelationId, ... }`

Neither is needed at module-init time, so a deferred import is faithful, not a dodge.

`_cycleDeps` is exported (and re-exported by `src/findings/index.ts:29`) but **no test and
no other `src/` file reads it** - verified by `grep -rn "_cycleDeps" src/ test/`, which
returns only the declaration and that barrel re-export. Keep the export so the public
surface is unchanged; make its `callOp` optional instead of eagerly bound.

- [ ] **Step 1: Confirm the consumer set has not changed**

```bash
grep -rn "_cycleDeps" src/ test/
grep -n "_callOp\|newCorrelationId" src/findings/cycle.ts
```
Expected: `_cycleDeps` appears only in `src/findings/cycle.ts` and `src/findings/index.ts:29`.
If a test now reads `_cycleDeps.callOp`, stop and escalate - the shape change below would
break it.

- [ ] **Step 2: Delete the static import**

Remove line 13 entirely:
```typescript
import { callOp as _callOp, newCorrelationId } from "@/operations";
```

- [ ] **Step 3: Make `_cycleDeps.callOp` an optional override rather than an eager binding**

Replace the current declaration (`export const _cycleDeps = {` begins at :45 and the block
ends at :48; :44 is blank):
```typescript
export const _cycleDeps = {
  callOp: _callOp as unknown as CallOpFn,
  now: () => new Date().toISOString(),
};
```
with:
```typescript
/**
 * Injectable deps. `callOp` is deliberately absent by default: binding it here
 * would need a static `@/operations` import, and that edge closes a runtime
 * import cycle (see docs/plans/STATUS-import-cycles-drain.md). `runFixCycle`
 * resolves the real `callOp` lazily at call time; set this field only to
 * override it.
 */
export const _cycleDeps: { callOp?: CallOpFn; now: () => string } = {
  now: () => new Date().toISOString(),
};
```

- [ ] **Step 4: Resolve both symbols lazily at the top of `runFixCycle`**

Immediately after the `const logger = ...` line (:129), replace the `doCallOp` line so it
reads:
```typescript
  const ops = await import("@/operations");
  const doCallOp = _deps.callOp ?? _cycleDeps.callOp ?? (ops.callOp as unknown as CallOpFn);
  const newCallId = ops.newCorrelationId;
```

- [ ] **Step 5: Use the local binding at the dispatch site**

At :283, change:
```typescript
      deps: { callOp: doCallOp, newCallId: newCorrelationId, logger, logCtx, now },
```
to:
```typescript
      deps: { callOp: doCallOp, newCallId, logger, logCtx, now },
```

- [ ] **Step 6: Verify the big drop**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
```
Expected: count **72** (127 - 55). If it drops by far less, you have missed a second static
edge out of `findings/` into `operations/` - re-run the ranker from section 2.2.

- [ ] **Step 7: Run the owning tests, then the full gate**

```bash
bun test test/unit/findings/ --timeout=60000
bun run check:all
```
Expected: PASS. `runFixCycle` is on the hot path for every rectification cycle, so a green
`test/unit/findings/` is the real signal here, not just the ratchet.

- [ ] **Step 8: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/findings/cycle.ts scripts/baselines/import-cycles-baseline.json
git commit -m "refactor: defer @/operations import in findings/cycle to break cycle"
```

---

### Task 5: promote `pipelineEventBus` so `execution/` reaches it without the `@/pipeline` barrel

**Frees 11.** Splits component #2.

**Files:** Modify `src/execution/story-orchestrator/run-phase.ts:8`; Create `src/pipeline/event-bus/index.ts` (moved from `src/pipeline/event-bus.ts`)

Current line 8 of `run-phase.ts`:
```typescript
import { pipelineEventBus } from "@/pipeline";
```

`pipelineEventBus` is defined at `src/pipeline/event-bus.ts:402`. Note why the cheap options
are unavailable:
- **(A)** no - it is a live singleton, used as a value.
- **(B)** no - `run-phase.ts` is at `src/execution/story-orchestrator/`, so a relative path
  to `src/pipeline/` needs `../../pipeline/...`, which biome's `noRestrictedImports` bans.
- **(C)** yes - this is exactly the documented case.

So: move `src/pipeline/event-bus.ts` to `src/pipeline/event-bus/index.ts`, making
`@/pipeline/event-bus` an *exact* barrel match and therefore legal.

- [ ] **Step 1: Record every current importer of the module**

```bash
grep -rn "pipeline/event-bus\|from \"./event-bus\"\|from \"../event-bus\"" src/ test/ bin/ scripts/
```
Keep this list. Relative importers inside `src/pipeline/` keep working unchanged (`./event-bus`
resolves to the directory's `index.ts` once the file is gone), but you must confirm each one
after the move.

- [ ] **Step 2: Move the file with git so history follows**

```bash
mkdir -p src/pipeline/event-bus
git mv src/pipeline/event-bus.ts src/pipeline/event-bus/index.ts
```

- [ ] **Step 3: Fix relative paths *inside* the moved file**

The file is now one directory deeper, so every relative specifier it contains needs one more
`../`. Check them, and watch the biome limit - any specifier that would become `../../*`
must be respelled as a `@/` barrel import instead.

```bash
grep -n "from \"\./\|from \"\.\./" src/pipeline/event-bus/index.ts
bun x tsc --noEmit
```

- [ ] **Step 4: Confirm no shadowing collision was created**

```bash
ls src/pipeline/event-bus.ts 2>/dev/null && echo "COLLISION - delete the stale file" || echo "clean"
bun run check:alias-internals
```
Expected: `clean`, and `check:alias-internals` passes. Both `event-bus.ts` and
`event-bus/index.ts` existing at once is the #1648 defect (section 1.3 trap C).

- [ ] **Step 5: Point `run-phase.ts` at the nested barrel**

Replace line 8:
```typescript
import { pipelineEventBus } from "@/pipeline/event-bus";
```

- [ ] **Step 6: Verify**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
bun run check:file-sizes
bun test test/unit/pipeline/ test/unit/execution/ --timeout=60000
bun run test:coverage
```
Expected: count **61** (72 - 11). Coverage is re-checked because a `src/` file moved.

- [ ] **Step 7: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/pipeline/ src/execution/story-orchestrator/run-phase.ts scripts/baselines/
git commit -m "refactor: promote pipeline/event-bus to nested barrel to break execution cycle"
```

---

### Wave 3 - the `context/engine` parent-barrel back-edges (61 -> 50)

### Task 6: four `context/engine/providers/*` files stop importing the ancestor `@/context` barrel

Frees **11** in total, but **unevenly**: the first three edges you fix free only 1 module
each, and the fourth frees 8. Do not conclude the approach is wrong when edge 1 barely moves
the number - all four must land before the component splits.

> **Read this before starting.** The mechanical ranker names the edge
> `src/context/index.ts -> src/context/engine/index.ts` as the cut. **Do not take that
> cut.** It would mean deleting `@/context`'s public re-export of the engine surface, which
> is an API change and is forbidden by section 1.4. Cut the **back-edges** instead: four
> nested files reaching *up* into their own ancestor barrel. Same loops, no API change.

**Files:** Modify
- `src/context/engine/providers/test-coverage.ts:13` - `generateTestCoverageSummary`
- `src/context/engine/providers/canonical-rules-cache.ts:10` - `loadCanonicalRules` (+ `type CanonicalRule`)
- `src/context/engine/providers/static-rules.ts:24` - (multi-symbol block, read it)
- `src/context/engine/providers/feature-context.ts:21` - `FeatureContextProvider as FeatureContextProviderV1`

- [ ] **Step 1: Re-confirm the four edges and find each symbol's real home**

```bash
grep -rn "from \"@/context\"" src/context/engine/
for s in generateTestCoverageSummary loadCanonicalRules FeatureContextProvider; do
  echo "== $s"; grep -rn "export .*$s" src/context/ | grep -v "index.ts"
done
sed -n '18,26p' src/context/engine/providers/static-rules.ts
```

- [ ] **Step 2: Handle the type-only symbols first with technique (A)**

`canonical-rules-cache.ts:10` mixes a type and a value: `{ type CanonicalRule, loadCanonicalRules }`.
Split it, because a mixed statement still counts as a value edge (section 1.3 trap A):
```typescript
import type { CanonicalRule } from "@/context";
import { loadCanonicalRules } from "@/context";
```
The second line is the one that still needs fixing in step 3. Apply the same split to any
other of the four files whose block mixes types and values.

- [ ] **Step 3: For each remaining value symbol, pick (B) or (C) and apply it**

Work **one file at a time**, verifying between each - four simultaneous edits make a
regression impossible to attribute.

- If the defining leaf is inside `src/context/engine/` or `src/context/`, use **(B)**: a
  relative specifier. From `src/context/engine/providers/x.ts`, `../` reaches
  `src/context/engine/` and `./` reaches `providers/` - both legal. A specifier that would
  need `../../` is banned by biome; use (C) for that one.
- Otherwise use **(C)**: promote the defining leaf to `<leaf>/index.ts` and import
  `@/context/<leaf>` as an exact barrel match. Re-run the step-4 collision check from Task 5
  every time you do this.

- [ ] **Step 4: Verify after each file**

```bash
bun run scripts/check-import-cycles.ts
bun x tsc --noEmit
bun run check:alias-internals
```
Expected after all four: count **50**. If the count stalls while `tsc` stays green, one of
the four still has a value edge - re-run the section 2.2 ranker and read the `parent-barrel`
rows.

- [ ] **Step 5: Run the owning tests and the full gate**

```bash
bun test test/unit/context/ --timeout=60000
bun run check:all
bun run test:coverage
```

- [ ] **Step 6: Re-baseline and commit**

```bash
bun run check:import-cycles:update
git add src/context/ scripts/baselines/
git commit -m "refactor: break context/engine parent-barrel back-edges"
```

---

### Wave 4 - the remaining named edges (50 -> 20)

Each of these is a single edge with a known frees-count. They are independent of one another.
Same loop every time: apply the technique, run section 2.1, re-baseline, commit. **One edge
per commit.**

### Task 7: `agents/acp/spawn-client.ts -> ./spawn-client-session` (frees 7)

**Files:** Modify `src/agents/acp/spawn-client.ts:22,25`

```typescript
22:import { SpawnAcpSession } from "./spawn-client-session";
25:export { SpawnAcpSession } from "./spawn-client-session";
```

**Both lines are edges** and both must go - line 25 is a value re-export, which
`check-import-cycles.ts` counts exactly like an import, so fixing line 22 alone will not move
the count.

Verified facts (do not re-derive):
- `SpawnAcpSession` is a **class** (`export class SpawnAcpSession implements AcpSession` at
  `src/agents/acp/spawn-client-session.ts:22`), instantiated with `new SpawnAcpSession({...})`
  at `spawn-client.ts:187` and `:244`. **Technique (A) is unavailable** - it is a real value.
- Both `new` sites sit inside `async` methods: `createSession` (declared `:149`) contains
  `:187`, `loadSession` (declared `:210`) contains `:244`. **So technique (D) applies.**
- `SpawnAcpSession` is **not** re-exported by `src/agents/acp/index.ts` or `src/agents/index.ts`.
  Line 25's only real consumer is one test,
  `test/unit/agents/acp/spawn-client-pid-callback.test.ts:17`, which imports it from
  `@/agents/acp/spawn-client`. Tests may reach `src/` internals, so it can be repointed.
- Do **not** instead cut `spawn-client-session.ts -> @/agents`. It is a real edge and looks
  like the tidier side, but removing it frees **0 modules** - `spawn-client-session.ts` stays
  in the 92-module blob by other paths. Measured, not guessed.

- [ ] **Step 1: Defer the class to call time (technique D)**

Delete line 22 (`import { SpawnAcpSession } from "./spawn-client-session";`). Then in **both**
`createSession` and `loadSession`, immediately before the `return new SpawnAcpSession({`
statement, add:
```typescript
    const { SpawnAcpSession } = await import("./spawn-client-session");
```

- [ ] **Step 2: Drop the value re-export**

Delete line 25 (`export { SpawnAcpSession } from "./spawn-client-session";`).

- [ ] **Step 3: Repoint the one test that relied on it**

In `test/unit/agents/acp/spawn-client-pid-callback.test.ts:17`, split the import so
`SpawnAcpSession` comes from its real home:
```typescript
import { _spawnClientDeps, createSpawnAcpClient, SpawnAcpClient } from "@/agents/acp/spawn-client";
import { SpawnAcpSession } from "@/agents/acp/spawn-client-session";
```

- [ ] **Step 4: Verify, test, re-baseline, commit**

```bash
bun run scripts/check-import-cycles.ts     # expect 43
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.test.json
bun run check:alias-internals
bun test test/unit/agents/ --timeout=60000
bun run check:import-cycles:update
git add src/agents/acp/spawn-client.ts test/unit/agents/acp/spawn-client-pid-callback.test.ts scripts/baselines/
git commit -m "refactor: defer SpawnAcpSession import to break acp cycle"
```
Note the second `tsc` invocation - the test tree has its own config, and this task edits a test.

### Task 8: `debate/session-helpers.ts -> ./selectors` (frees 6)

**Files:** Modify `src/debate/session-helpers.ts:10-11`

```typescript
10:import type { SelectorContext } from "./selectors";
11:import { pickSelectorKind, resolveSelector } from "./selectors";
```

Line 10 is already type-only and costs nothing. Line 11 is the edge, and it is a
**`child-barrel`** import in the section 2.2 taxonomy: `src/debate/session-helpers.ts` sits in
`src/debate/`, and `src/debate/selectors/index.ts` is the barrel of a subdirectory of that
same directory. So the defining leaf is one segment down and technique **(B)** applies.
The defining leaves are verified:
- `pickSelectorKind` - `src/debate/selectors/pick.ts:17`
- `resolveSelector` - `src/debate/selectors/registry.ts:14`

For context, the loop this breaks runs
`session-helpers.ts:11 -> selectors/index.ts -> selectors/judge.ts:13 -> @/operations -> operations/debate-hybrid.ts:4 -> session-helpers.ts`.
The back-edge is `debate-hybrid.ts` importing `_debateSessionDeps` from
`../debate/session-helpers`, not anything under `selectors/` - so the import-type edges at
`selectors/types.ts:8` and `selectors/verifier-pick.ts:10` are already free and are **not**
the problem.

- [ ] **Step 1: Replace line 11 with the two defining leaves**

```typescript
import { pickSelectorKind } from "./selectors/pick";
import { resolveSelector } from "./selectors/registry";
```
Leave line 10 (`import type { SelectorContext } from "./selectors";`) exactly as it is - it is
type-only and costs nothing.

- [ ] **Step 2: Verify, test, re-baseline, commit**

```bash
bun run scripts/check-import-cycles.ts     # expect 37
bun x tsc --noEmit
bun run check:alias-internals
bun test test/unit/debate/ --timeout=60000
bun run check:import-cycles:update
git add src/debate/session-helpers.ts scripts/baselines/
git commit -m "refactor: import debate selector leaves directly to break cycle"
```

### Task 9: `agents/acp/stdout-line-reader.ts -> @/agents` (frees 5)

**Files:** Modify `src/agents/acp/stdout-line-reader.ts:6-7`

```typescript
6:import type { AcpLineActivity, AcpParseState } from "@/agents";
7:import { parseAcpxJsonLine } from "@/agents";
```

Line 6 is already type-only. Line 7 is the edge, and `parseAcpxJsonLine` is defined at
`src/agents/acp/parser.ts:82` - **the same directory**. Technique **(B)**:

```typescript
import { parseAcpxJsonLine } from "./parser";
```

Watch the symbol names: the barrel exports `AcpLineActivity`/`AcpParseState` while
`parser.ts:82` declares `AcpxLineActivity`/`AcpxParseState` (note the `x`). Leave line 6 on
`@/agents` unless `tsc` objects - it is type-only and free either way.

- [ ] Apply, verify, expect **32**, run `bun test test/unit/agents/ --timeout=60000`, re-baseline, commit.

### Task 10: `routing/router.ts -> ../operations` (frees 4)

**Files:** Modify `src/routing/router.ts:14-15`

```typescript
14:import type { CallContext } from "../operations";
15:import { callOp, classifyRouteBatchOp, classifyRouteOp } from "../operations";
```

Line 14 is already type-only. Line 15 is the edge. Same situation as Task 4: these are
operation-dispatch functions called at request time, not module-init time. Prefer technique
**(D)** - `await import("@/operations")` inside whichever async method consumes them. Confirm
each call site is in an `async` function first; if any is not, use (C) on the defining leaf
instead.

- [ ] Apply, verify, expect **28**, run `bun test test/unit/routing/ --timeout=60000`, re-baseline, commit.

### Task 11: the `cli` / `plan/strategies` knot (frees 5, kills component #3)

**Files:** Modify `src/plan/strategies/context-builder.ts:1-8`, `src/cli/plan.ts`, `src/cli/plan-command.ts`

The verified edge map of the component:

| # | Edge | Real? |
|--:|:--|:--|
| 1 | `cli/index.ts:52` → `export {...} from "./plan"` | real |
| 2 | `cli/plan.ts` (whole file) → `export {...} from "./plan-command"` | real |
| 3 | `cli/plan-command.ts:17-18,21` → `../plan/strategies` (value import + value re-export) | real |
| 4 | `plan/strategies/index.ts:2` → `export { buildPlanModeContext } from "./context-builder"` | real |
| 5 | `plan/strategies/context-builder.ts:2-8` → `@/cli` | real - **closes the 5-loop** |
| 6 | `cli/plan-command.ts:26` → `./plan` | **was a PHANTOM; gone since `bf3ad94b5`** |

Edge 6 never existed in the code: `cli/plan-command.ts:26` is a *comment* whose prose matched
the checker's regex. The gate was fixed in `bf3ad94b5` (see section 8.3), so **this task is now
a single edge** and there is nothing to escalate.

**Part A - cut edge 5 (frees 5, killing the whole component).** This is the layering defect: a planning strategy importing
the CLI barrel. All five symbols are called as real values inside the `async function
buildPlanModeContext`, so technique (A) is out; and the relative path would be
`../../cli/plan-helpers`, which biome bans, so (B) is out. **Technique (C)** it is, and note
this is a restructure *within* `src/cli/`, not a cross-directory relocation - so it does
**not** need escalation under section 1.4.

Verified homes of the five symbols:

| Symbol | Defined in |
|:--|:--|
| `buildPackageSummary` | `src/cli/plan-helpers.ts:61` |
| `buildSourceRootsSection` | `src/cli/plan-helpers.ts:75` |
| `DEFAULT_TIMEOUT_SECONDS` | `src/cli/plan-runtime.ts:26` |
| `createPlanRuntime` | `src/cli/plan-runtime.ts:28` |
| `detectProjectName` | `src/cli/plan-runtime.ts:62` |

- [ ] **A1:** `git mv src/cli/plan-helpers.ts src/cli/plan-helpers/index.ts` and
      `git mv src/cli/plan-runtime.ts src/cli/plan-runtime/index.ts` (create the dirs first).
      Fix the relative specifiers *inside* both moved files - they are one level deeper now;
      any that would become `../../*` must be respelled as a `@/` barrel import.
      `cli/index.ts`'s existing `from "./plan-helpers"` / `from "./plan-runtime"` keep
      resolving unchanged.
- [ ] **A2:** Confirm no shadowing collision: `ls src/cli/plan-helpers.ts src/cli/plan-runtime.ts`
      must both be absent, and `bun run check:alias-internals` must pass.
- [ ] **A3:** Replace `context-builder.ts` lines 2-8 with:
```typescript
import { buildPackageSummary, buildSourceRootsSection } from "@/cli/plan-helpers";
import { createPlanRuntime, DEFAULT_TIMEOUT_SECONDS, detectProjectName } from "@/cli/plan-runtime";
```
- [ ] **A4:** Verify (expect **23**), `bun test test/unit/cli/ --timeout=60000`, `bun run test:coverage`
      (files moved), re-baseline, commit.

**Part B - no longer exists.**

Earlier revisions of this plan had a Part B for two modules that stayed cyclic after Part A.
That was a gate defect, not a cycle: `cli/plan-command.ts:26` is a comment whose prose matched
`STATIC_IMPORT_RE`, inventing an edge that cannot exist at runtime. Fixed in `bf3ad94b5`
(section 8.3). Part A alone now takes this component to zero - `frees 5`, verified by
simulation against the fixed gate. Expect **23** after A4, not 25.

### Task 12: the two `context/engine/handlers/* -> ../pull-tools` edges (frees 3)

**Files:** Modify `src/context/engine/handlers/query-neighbor.ts:16-17`,
`src/context/engine/handlers/query-feature-context.ts:18-19`

Both files carry the identical pair:
```typescript
import type { PullToolBudget } from "../pull-tools";
import { _pullToolsDeps, DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools";
```

The type line is free; the value line is the edge. The loops are 2-node and verified:
`pull-tools.ts:383` does `export { handleQueryNeighbor } from "./handlers/query-neighbor"`, and
`:372` does the same for `handleQueryFeatureContext` - so each handler and `pull-tools.ts`
point at each other.

The two imported symbols need **different** techniques:
- `DEFAULT_MAX_TOKENS_PER_CALL` (`pull-tools.ts:62`, `= 2048`) is used as a **default parameter
  value**, which is evaluated synchronously - (D) cannot apply. Extract it to a shared leaf
  instead, same play as Task 3.
- `_pullToolsDeps` (`pull-tools.ts:35-44`) is read **inside** each handler body -
  `query-neighbor.ts:96` and `query-feature-context.ts:98`, both `const logger = _pullToolsDeps.getLogger();`
  - and both enclosing functions are `export async function` (`:31` and `:54`). **(D) applies.**

- [ ] **Step 1: Extract the constant to a leaf neither side imports back**

Create `src/context/engine/pull-tools-constants.ts`:
```typescript
export const DEFAULT_MAX_TOKENS_PER_CALL = 2048;
```
Then in `pull-tools.ts`, replace the declaration at `:62` with a re-export so existing callers
are unaffected:
```typescript
export { DEFAULT_MAX_TOKENS_PER_CALL } from "./pull-tools-constants";
```

- [ ] **Step 2: Fix `query-neighbor.ts` (frees 1)**

Replace line 17 with:
```typescript
import { DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools-constants";
```
and at line 96, defer the deps object:
```typescript
  const { _pullToolsDeps } = await import("../pull-tools");
  const logger = _pullToolsDeps.getLogger();
```
Verify (expect **22**), then commit before touching the second file.

- [ ] **Step 3: Fix `query-feature-context.ts` the same way (frees 2)**

Replace line 19 with the `../pull-tools-constants` import, and apply the same two-line change
at line 98. Verify (expect **20**), commit.

- [ ] **Step 4: Full verify**

```bash
bun x tsc --noEmit
bun run check:alias-internals
bun run check:file-sizes
bun test test/unit/context/ --timeout=60000
bun run test:coverage          # a new src/ file was added
bun run check:import-cycles:update
```

> **Out of scope but worth knowing:** `src/context/engine/handlers/query-scratch.ts:207` has the
> identical `_pullToolsDeps.getLogger()` pattern and imports the same two symbols from
> `../pull-tools`. It is *not* in a cycle, so this task leaves it alone - but once the constant
> is extracted in Step 1, switching it over is a free consistency win if a reviewer asks.

---

## 4. Definition of done for this plan

- [ ] `bun run scripts/check-import-cycles.ts` reports **20 or fewer** cyclic modules.
- [ ] `scripts/baselines/import-cycles-baseline.json` `count` equals the measured count
      (no drift), and its `modules` array contains only the residue from section 5.
- [ ] `bun run check:all` passes.
- [ ] `bun run test:coverage` passes.
- [ ] `bun run test:full` passes at least once at the end of the drain (`FULL=1 NAX_PRECHECK=1`).
- [ ] Section 8 has one appended entry per wave, recording measured (not predicted) counts.
- [ ] `.nax/rules/project-conventions.md`'s "Cycle ratchet" paragraph still describes reality.

---

## 5. The residue - what this plan deliberately does not fix

After all 12 tasks, one SCC of **20 modules** remains:

```
src/execution/dry-run.ts
src/execution/escalation/index.ts
src/execution/escalation/tier-escalation.ts
src/execution/escalation/tier-outcome.ts
src/execution/index.ts
src/execution/iteration-runner.ts
src/execution/lifecycle/index.ts
src/execution/lifecycle/run-cleanup.ts
src/execution/lifecycle/run-completion.ts
src/execution/lifecycle/run-regression.ts
src/execution/lifecycle/run-setup.ts
src/execution/pipeline-result-handler.ts
src/execution/runner-completion.ts
src/execution/runner.ts
src/execution/unified-executor.ts
src/pipeline/index.ts
src/pipeline/stages/completion.ts
src/pipeline/stages/execution.ts
src/pipeline/stages/index.ts
src/pipeline/stages/queue-check.ts
```

Five of those twenty (`src/execution/lifecycle/*`) would come out via the one cut this plan
refuses - `src/execution/index.ts -> ./lifecycle`, a public barrel re-export. Removing it is
an API change and belongs to the design decision below, not to a refactor pass.

This is a genuine mutual dependency between the `execution` and `pipeline` layers, not a
barrel accident: `pipeline/stages/*` call into `@/execution` to run work, and `execution/*`
call into `@/pipeline` to emit events and check the queue. Every remaining edge frees exactly
1 module, which is the signature of a densely-connected knot rather than a few bad imports.

Breaking it needs a design decision, not a refactor pass - most likely extracting the shared
contract (the event bus, the queue interface, the result types) into a third layer that both
sides depend on and neither owns. **That is out of scope for this plan.** Do not attempt it as
part of the drain; open a separate design note.

A reasonable next step for whoever picks it up: Task 5 already moved the event bus to its own
nested barrel, which is the first brick of exactly that extraction.

---

## 6. If a task will not budge

1. Re-run the ranker (section 2.2) and read the **actual** top rows. This plan's table is a
   simulation; after a few real cuts the graph is different.
2. Check whether you fixed a *type* edge and expected a count change. Type-only imports were
   never counted, so converting one changes nothing. Confirm with
   `bun run scripts/check-import-cycles.ts --list` and look for your file.
3. Check for a **second** static edge from the same file - a value `export ... from` re-export
   counts exactly like an `import ... from` (this is what makes Task 7 subtle).
4. If `check:alias-internals` fails on your fix, you reached for `@/<dir>/<internal>`. Go back
   to section 1.3 and use (B), (C) or (D) instead. Never add an exemption.
5. If the ratchet fails with "newly inside a runtime import cycle" while the total dropped,
   your fix traded one cycle for another. The named modules in the failure message tell you
   which - revert and re-approach.
6. If the honest fix requires changing a public barrel's exports, **stop and escalate**
   (section 1.4). Two tasks are already marked for this: Task 6 and Task 11.

---

## 7. Command reference

```bash
bun run scripts/check-import-cycles.ts            # the gate
bun run scripts/check-import-cycles.ts --list     # every cyclic module + a representative loop
bun run check:import-cycles:update                # lower the baseline (never raise it)
bun run check:alias-internals                     # the opposing gate
bun x tsc --noEmit                                # types
bun run check:all                                 # every ratchet + biome
bun run test:coverage                             # NOT in check:all - run it when src/ files are added or moved
bun run test:full                                 # FULL=1 NAX_PRECHECK=1, end of drain
```

---

## 8. Log (append-only)

### 8.1 - 2026-09-13 - plan written

Measured 132 cyclic modules against a stale baseline of 135. Five SCCs: 92, 31, 5, 2, 2.
Edge ranking produced by greedy removal over all 262 internal edges (remove edge, recompute
Tarjan SCCs, keep the largest reduction), then the resulting 17-cut task sequence was
re-simulated in plan order to fix the per-task expected counts.

Simulated result of the 12-task queue: **132 -> 20**, residue being the `execution`/`pipeline`
knot in section 5. The unconstrained greedy optimum is 15; this plan gives up 5 modules by
refusing the `src/execution/index.ts -> ./lifecycle` cut, which would delete a public barrel
re-export. Every per-task count in section 3 comes from that simulation, not from arithmetic
on the ranking - three of the four Task 6 edges free only 1 module each, which a naive
reading of the ranking would get wrong.

No code changed.

### 8.2 - 2026-09-13 - plan reviewed before handover

Three verification passes run against the codebase before this plan was handed to an
implementer. Every line number, symbol location, script name and policy claim in sections 0-2
and 7 was checked against source. Corrections applied:

- **Two off-by-one line numbers** in Task 4: `runFixCycle` is declared at `:116` (not 117), and
  `_cycleDeps` at `:45` (not 44 - that line is blank).
- **Line numbers are now labelled as navigation aids, not edit addresses** (section 1.5). Task 4
  deletes line 13 and then cites lines 45/130/283, all of which shift by one; the task now says
  so explicitly.
- **The section 2.2 ranker had a classifier bug.** It labelled a barrel-of-my-own-subdirectory
  edge `cross-barrel`, contradicting Task 8's own prose which (correctly) treats it as cheap.
  Added a distinct `child-barrel` kind. `sed -i ''` replaced with `perl -pi` (BSD-only syntax).
- **Added section 2.3**, the rule that matters most when reading the ranker: an edge whose
  left-hand side ends in `/index.ts` is a barrel re-exporting its own surface, and must never be
  cut. The ranker's #2 and #4 rows (both `frees=55` / `frees=43`) are exactly this trap.
- **Tasks 7, 8, 11 and 12 rewritten from "go investigate" into prescribed edits**, each fact
  verified: the defining leaf of every symbol, whether each consumer is a value or a type,
  and whether each enclosing function is `async` (required before prescribing technique D).
- **Task 7 was pointing at a defensible but ineffective fix.** Cutting
  `spawn-client-session.ts -> @/agents` frees **0** modules; the load-bearing edge is
  `spawn-client.ts -> ./spawn-client-session` (frees 7). `SpawnAcpSession` is a class used with
  `new`, so the fix is (D), not (A) as originally suggested.

**One defect found in the gate itself.** `scripts/check-import-cycles.ts` does not strip
comments before matching `STATIC_IMPORT_RE`, so prose containing the literal shape
`import ... from "..."` is parsed as a real dependency edge. `src/cli/plan-command.ts:26` is
such a comment, and it fabricates the `plan-command -> plan` edge that Task 11 was originally
written to "find". Confirmed by running the checker's own regex against the line. A repo-wide
scan found exactly one other matching comment (`src/log-format/summary.ts:12`), whose specifier
`./runner` does not resolve, so it creates no edge. Net effect on today's count: **zero** - but
it becomes the last 2 of the drain once Task 11 Part A lands. Task 11 Part B records both the
proper fix (strip comments in the gate) and the zero-risk workaround (reword the comment), and
routes the choice to the maintainer rather than the implementer.

### 8.3 - 2026-09-13 - the gate defect from 8.2 is fixed (`bf3ad94b5`)

`scripts/check-import-cycles.ts` built the graph by matching a regex against raw file text.
Two defects, both fixed, with tests in `test/unit/scripts/check-import-cycles.test.ts`:

1. **Comments were not stripped.** Prose containing the shape `import ... from "..."` parsed as
   a dependency. `src/cli/plan-command.ts:26` is such a comment and it invented the
   `plan-command -> plan` edge. `stripComments()` now blanks comments before matching, tracking
   string literals so a `//` or `/*` inside one stays data - a naive stripper would treat the
   `/*` in `const s = "/*";` as a comment opener and swallow every import after it.
2. **The prelude pattern was `[^"']*?`, which crosses newlines.** A match could begin at
   `export interface Foo {` and run to an unrelated statement's `from "..."`; the prelude then
   no longer began with `type`, so a **type-only re-export was counted as a value edge**.
   `src/config/runtime-types.ts` has exactly that shape. A quote in the intervening text had
   been masking it by accident, which is why fixing (1) exposed it - blanking a comment removes
   the apostrophe that was holding the false match back. The match is now anchored to the start
   of a line (`^` with `m`; no `import`/`export ... from` statement in `src/` is indented) and
   the prelude admits only what an import clause can hold: `[A-Za-z0-9_$*,{}\s]`.

Validated by diffing every edge of the `src/` graph before and after: **24 removed, 0 added.**
Each removal was classified by hand - 23 are type-only imports that had been mislabelled as
value edges, 1 is the `plan-command` comment. A repo-wide scan found one other import-shaped
comment (`src/log-format/summary.ts:12`) whose specifier `./runner` does not resolve, so it
never created an edge.

**The reported count is unchanged at 132** - all 24 phantom edges sat inside components that
other real edges already hold together - so no baseline move was needed and every expected
count in section 3 still holds, with one exception: **Task 11 loses its Part B.** Cutting
`context-builder -> @/cli` now frees **5** rather than 3 and takes that component to zero, so
A4's expected reading is **23**, not 25. Re-simulated against the fixed gate; the final residue
is still 20.

Known limit, recorded rather than hidden: regex literals are not tracked, so an unescaped `//`
inside one blanks the rest of that line. It cannot invent an edge, only drop one, and it would
require an import sharing a line with a regex literal - which the before/after diff confirms no
file in `src/` does.
