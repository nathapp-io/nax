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

## 0. Current state - measured 2026-09-13 after Wave 5 (Tasks 13-17): the drain is complete

```
bun run scripts/check-import-cycles.ts
[OK] 0 modules in runtime import cycles (baseline: 0).
```

| Reading | Value |
|:--|--:|
| Baseline file `count` | **0** |
| Actual cyclic modules in `src/` | **0** |
| Strongly-connected components (SCCs) that are cyclic | **0** |

**The drain is complete: 132 -> 0.** Wave 5 is fully landed; section 8.9 records the
per-task measured counts. The baseline file is `count: 0` with an empty `modules` array and
the gate is now zero-tolerance: any newly introduced cycle fails CI on the spot.

**The architectural debt is real and still open.** A1 (Task 16) removed the
*initialisation-order* cycle by deferring `../pipeline/stages` out of the two execution
entry points; it did **not** make `pipeline` and `execution` independent layers.
`pipeline/stages/*` still calls into `@/execution` for `appendProgress`,
`processQueueFile` and six planning symbols, and that dependency is now invisible to the
gate. The real fix is dependency inversion on the stage list, designed at
`docs/plans/2026-09-13-execution-pipeline-layering-design.md` — see the rewritten
section 5.

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
prelude matches `/^\s*(?:import|export)\s+type/`.

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

### Wave 5 - the "residue" was mostly not a residue (20 -> 0)

> **Read this first.** Section 5 as written after Wave 4 claimed all 20 remaining modules
> were "a genuine mutual dependency ... breaking it needs a design decision". **That was
> wrong for 13 of the 20.** A re-measurement on 2026-09-13 (section 8.8) found that Wave 4
> left two ordinary mechanical edges uncut, and that the real knot is only **7 modules**.
> Every number in this wave was **measured by simulating the edit and re-running the gate**,
> not predicted. Section 5 is corrected in place by Task 17.
>
> The design decision for the 7-module knot **has been made** - route **A1, defer with
> `await import`** (ruled 2026-09-13, see 8.8). You do not need to re-open it. Task 16 is a
> refactor, not a design task.

Tasks run **in order**; the measured count after each is exact.

| Task | Edge cut | Technique | Count after |
|:--|:--|:--|--:|
| 13 | 9 files -> `@/pipeline` parent barrel for `pipelineEventBus` | (C) existing nested barrel | **10** |
| 14 | `escalation/tier-escalation.ts -> ../escalation` (self-barrel) | (B) relative leaf | **9** |
| 15 | `escalation/tier-outcome.ts -> ./tier-escalation` | extract shared leaf | **7** |
| 16 | `execution/{iteration-runner,unified-executor} -> ../pipeline/stages` | (D) `await import` | **0** |
| 17 | baseline to 0, gate becomes zero-tolerance, correct section 5 | doc + baseline | **0** |

---

### Task 13: nine files still reach `pipelineEventBus` through the parent barrel (frees 10)

Task 5 (Wave 2) promoted the event bus to its own nested barrel at
`src/pipeline/event-bus/index.ts`. Three call sites were switched over at the time -
`src/execution/cost-guard.ts:6`, `src/execution/merge-conflict-outcomes.ts:20` and
`src/execution/story-orchestrator/run-phase.ts:9` - and the rest were never migrated. Every
one of them still pulls in the whole `@/pipeline` barrel (and therefore `pipeline/stages`,
and therefore `@/execution`) to reach one exported object.

`@/pipeline/event-bus` is an **exact** nested-barrel match, so `check:alias-internals` is
satisfied. This is technique (C) with the barrel already built for you - there is no file to
move, only an import specifier to change.

**Edit.** In each of these **nine** files, replace the whole line

```ts
import { pipelineEventBus } from "@/pipeline";
```

with

```ts
import { pipelineEventBus } from "@/pipeline/event-bus";
```

| # | File | Line (snapshot) |
|--:|:--|--:|
| 1 | `src/execution/dry-run.ts` | 7 |
| 2 | `src/execution/unified-executor.ts` | 3 |
| 3 | `src/execution/pipeline-result-handler.ts` | 11 |
| 4 | `src/execution/runner-completion.ts` | 16 |
| 5 | `src/execution/lifecycle/run-setup.ts` | 22 |
| 6 | `src/execution/lifecycle/run-completion.ts` | 19 |
| 7 | `src/execution/lifecycle/run-regression.ts` | 16 |
| 8 | `src/execution/escalation/tier-outcome.ts` | 11 |
| 9 | `src/execution/escalation/tier-escalation.ts` | 15 |

> **Do not touch the other two hits.** `src/tui/hooks/usePipelineBusEvents.ts:15` and
> `src/finish/phase.ts:18` have the same import line but are **not** in any cycle. Changing
> them is a harmless consistency win, not part of this task - leave them, or do them in a
> separate commit, so the measured delta below stays attributable.

Because the import order is alphabetical by specifier, moving `@/pipeline` to
`@/pipeline/event-bus` does **not** change a file's sort position (`@/pipeline` <
`@/pipeline/event-bus` and both sort after `@/metrics`, before `@/prd`). Biome should not
re-order anything; if `bun run lint` disagrees, take its fix.

**Proof.**
```bash
bun run scripts/check-import-cycles.ts    # expect: 10 (down 10)
```
Measured 2026-09-13: **20 -> 10.**

---

### Task 14: `escalation/tier-escalation.ts` stops importing its own parent barrel (frees 1)

Same shape as Tasks 1 and 2 in Wave 1. `src/execution/escalation/tier-escalation.ts` reaches
three symbols through the directory's own `index.ts`:

```ts
import { calculateMaxIterations, escalateTier, getTierConfig } from "../escalation";
```

`../escalation` from inside `src/execution/escalation/` resolves to
`src/execution/escalation/index.ts` - its own barrel - whose line 6 is
`export { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";`.
The defining leaf is `src/execution/escalation/escalation.ts`, a sibling.

**Edit.** Technique (B), one line:

```ts
import { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
```

`./sibling` is inside biome's `noRestrictedImports` allowance (only `../../*` is banned), and
`check-alias-internals` does not inspect relative specifiers.

> **The confusing bit:** the directory is `escalation/` **and** the leaf file is
> `escalation.ts`, so `../escalation` and `./escalation` differ by one character and resolve
> to completely different modules. Match on the quoted text and re-read the line after
> editing.

**Proof.**
```bash
bun run scripts/check-import-cycles.ts --list    # expect: 9
```
Measured 2026-09-13: **10 -> 9.** The two modules left in that corner are
`tier-escalation.ts` and `tier-outcome.ts`, now cycling directly with each other - which is
Task 15.

---

### Task 15: break the `tier-escalation` / `tier-outcome` mutual recursion (frees 2)

This one *is* a real mutual dependency, but a tiny and obvious one:

| Direction | Symbols | Sites |
|:--|:--|:--|
| `tier-escalation.ts -> ./tier-outcome` | `handleMaxAttemptsReached`, `handleNoTierAvailable` | lines 423, 466, 482 |
| `tier-outcome.ts -> ./tier-escalation` | `resolveMaxAttemptsOutcome` | lines 28, 98 |

The second direction carries exactly one symbol, and that symbol is a **pure synchronous
function with no imports of its own** - `resolveMaxAttemptsOutcome(failureCategory?:
FailureCategory): "pause" | "fail"`, a `switch` over categories at
`src/execution/escalation/tier-escalation.ts:85`. It is stranded in a 598-line file that
otherwise does async orchestration. Extracting it is the right change on its own merits and
removes the back-edge as a side effect.

**Step 1 - create `src/execution/escalation/max-attempts-outcome.ts`.** Move the whole
`resolveMaxAttemptsOutcome` function there verbatim, **including its comments** (the block at
line 99 explaining the review-incomplete case is load-bearing context - do not drop it). Its
only dependency is `import type { FailureCategory } from "@/tdd";` - a type import, so it adds
no edge.

**Step 2 - `tier-escalation.ts`:** delete the function body and add, next to its other
sibling imports,

```ts
export { resolveMaxAttemptsOutcome } from "./max-attempts-outcome";
```

Keep this re-export. It is a value `export ... from`, so it adds a
`tier-escalation -> max-attempts-outcome` edge - which is fine, the new leaf imports nothing
back. It exists to keep **two existing deep test imports** working:
`test/unit/execution/escalation/tier-escalation-greenfield.test.ts:12` imports the symbol
from `@/execution/escalation/tier-escalation`, and if `tier-escalation.ts` also *uses* the
function itself, import it from the leaf rather than relying on the re-export.

**Step 3 - `tier-outcome.ts:18`:** repoint to the leaf.

```ts
import { resolveMaxAttemptsOutcome } from "./max-attempts-outcome";
```

**Step 4 - `escalation/index.ts` is unchanged.** Line 18 already re-exports
`resolveMaxAttemptsOutcome` from within this directory, and so does `execution/index.ts:33`
and `execution/runner.ts:48`. **No public barrel export moves or disappears**, so section 1.4
is not engaged. The other three test files reach it via `@/execution` and
`@/execution/runner` and keep working untouched.

> **Trap (1.5, file-size gate):** this *shrinks* `tier-escalation.ts`, which is safe. But
> technique (C)-adjacent tasks that add a file under `src/` need the coverage gate - a new
> `.ts` file with a single pure function is exactly the kind of file that can land under the
> per-file floor. **Run `bun run test:coverage` for this task.** If the new file is short of
> the floor, the existing assertions in `tier-escalation.test.ts` and
> `tier-escalation-greenfield.test.ts` already cover every branch of the `switch` - the fix is
> to point the coverage baseline entry at the new path, not to write new tests.

**Proof.**
```bash
bun run scripts/check-import-cycles.ts    # expect: 7
bun run test:coverage
bun test test/unit/execution/escalation/ --timeout=30000
```
Measured 2026-09-13: **9 -> 7.** What remains is the real knot, and only the real knot.

---

### Task 16: defer `pipeline/stages` from the two execution entry points (frees 7, reaches 0)

**This is the task the plan previously said needed a design decision. The decision was made
on 2026-09-13: route A1, defer with `await import`. Implement it; do not re-litigate it.**

The knot is seven modules and it is genuinely bidirectional:

```
pipeline/stages/index.ts
  -> stages/completion.ts   -> @/execution  (appendProgress)
  -> stages/queue-check.ts  -> @/execution  (processQueueFile)
  -> stages/execution.ts    -> @/execution  (6 symbols)
                                  |
                            execution/index.ts
                                  |
       +--------------------------+--------------------------+
       v                                                     v
execution/iteration-runner.ts                     execution/unified-executor.ts
       -> ../pipeline/stages (defaultPipeline)      -> ../pipeline/stages (pre/postRunPipeline)
```

Cutting **either** direction fully dissolves it - both were simulated and both reach 0. A1
cuts the `execution -> pipeline/stages` direction, because it is two files and three call
sites, and because technique (D) removes the edge from the **real ESM initialisation order**,
not merely from the ratchet (section 1.3(D): "Not a loophole; it is the honest fix").

All three call sites were checked and are **already inside `await` expressions in `async`
functions**, so no signature anywhere has to change.

**Step 1 - `src/execution/iteration-runner.ts`.** Delete line 15:

```ts
import { defaultPipeline } from "../pipeline/stages";
```

At line 215 the symbol is consumed in an already-async call:

```ts
const pipelineResult = await _iterationRunnerDeps.runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);
```

Replace with a deferred load immediately above it:

```ts
const { defaultPipeline } = await import("../pipeline/stages");
const pipelineResult = await _iterationRunnerDeps.runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);
```

> This sits on the per-iteration path, so it runs once per story attempt rather than once per
> process. That is not a performance concern: the ESM module cache makes every call after the
> first a resolved-promise lookup, and `defaultPipeline` is *already* a lazy `Proxy` over an
> array (`src/pipeline/stages/index.ts:59`) precisely so its stages are not materialised at
> module-evaluation time. If you would rather hoist it, hoist it to the top of the enclosing
> async function - **not** to module scope, which re-adds the edge.

**Step 2 - `src/execution/unified-executor.ts`.** Delete line 8:

```ts
import { postRunPipeline, preRunPipeline } from "../pipeline/stages";
```

Two consumption sites, both inside `await runPipeline(...)` calls:

- **line ~170**, `preRunPipeline` passed as the last argument to a `runPipeline` call inside
  an `if` block.
- **line ~641**, `postRunPipeline` passed as the first argument to `await runPipeline(...)`
  inside the `if (ctx.config.acceptance?.enabled)` block.

Add a `const { preRunPipeline } = await import("../pipeline/stages");` (resp.
`postRunPipeline`) as the first statement inside each of those two blocks. They are in
different branches and neither runs unconditionally, so **do not** try to share one load
between them at function scope.

> Re-grep between Step 1 and Step 2 and between the two sites in Step 2. Deleting line 8
> shifts every later line in `unified-executor.ts` up by one, and adding a statement shifts
> the second site down. Match on the quoted text (`preRunPipeline,` / `postRunPipeline,`).

**Step 3 - leave `../pipeline/runner` alone.** Both files also import `runPipeline` /
`logPipelineOutcome` from `../pipeline/runner`, and so do `pre-run.ts` and
`parallel-worker.ts`. `src/pipeline/runner.ts` is **not** in the cycle and never was. Do not
convert those - you would be adding dynamic imports for nothing.

**Proof.**
```bash
bun run scripts/check-import-cycles.ts    # expect: 0
bun run check:all
bun run test:coverage
```
Measured 2026-09-13 (by deleting both import lines to simulate the cut): **7 -> 0.**

> **Do not skip the test run here.** This is the only task in the whole drain that changes
> *when* a module is evaluated on a hot path. `bun run test:full` (`FULL=1 NAX_PRECHECK=1`)
> is required by section 4 at the end of the drain, and this is the task that makes it worth
> running.

---

#### Task 16 blast radius - read before editing

Tasks 13-15 are import-specifier rewrites: nothing about *when* a module is evaluated
changes, so their blast radius is the type checker and nothing else. **Task 16 is the only
task in this entire drain that changes runtime evaluation order**, and it does it on the
per-story hot path. Everything below was checked on 2026-09-13; the conclusion is that the
radius is small, but each item is checked for a reason and you should re-confirm rather than
assume.

**1. Stage side effects at module scope - the one thing that could actually break.**
Deferring `../pipeline/stages` means `pipeline/stages/index.ts` and everything it statically
imports (`acceptance`, `acceptance-setup`, `completion`, `constitution`, `context`,
`execution`, `optimizer`, `prompt`, `queue-check`, `routing`) are no longer evaluated when
`execution/iteration-runner.ts` is loaded. They are evaluated on **first call** instead. If
any of those ten modules performs a side effect at module scope that some *other* module
silently depends on having already happened - registering a subscriber, mutating a shared
registry, seeding a cache - deferring it moves that side effect later and the dependent
breaks. Grep the ten stage files for top-level statements that are not `import`, `export`,
`const`/`function` declarations or type aliases before you edit. This is the failure mode
section 1.1 describes, running in the opposite direction.

**2. `defaultPipeline` is already lazy - this is the reassuring part.**
`src/pipeline/stages/index.ts:59` defines it as a `Proxy` over an empty array whose every
trap calls `getDefaultPipeline()`, which memoises `buildDefaultPipeline()` on first property
access. The stage list was *already* not materialised at module-evaluation time. Deferring
the import moves the module evaluation, not the pipeline construction, and the construction
was already happening at first use. `preRunPipeline` and `postRunPipeline` (lines 86 and 92)
are plain arrays holding one stage each and are constructed eagerly - but they are only ever
passed straight into `runPipeline`, so moving their construction to the call site is inert.

**3. Cost on the hot path: one module-cache lookup per story attempt.** The
`iteration-runner.ts` site runs once per story attempt, not once per process. After the first
call `await import(...)` is a resolved-promise lookup in the ESM registry - microseconds, and
already awaited inside an async function that is about to spawn an agent. Not a concern.

**4. The build emits one file and keeps emitting one file.** `bun run build` is
`bun build bin/nax.ts --outdir dist --target bun` with **no `--splitting` flag**, so Bun
inlines dynamic imports rather than emitting chunks. `dist/` is a single `nax.js` today
*with 84 dynamic imports already in the graph*, several of them reachable from this same
path (`src/pipeline/stages/acceptance.ts:50`, `src/operations/full-suite-gate.ts:165`).
Task 16 adds no new build artifact and no new load-time fetch. Still run `bun run build` and
confirm `dist/` is one file.

**5. Test mocking is unaffected, and if anything improves.** No test anywhere does
`mock.module` on `../pipeline/stages` or on `@/pipeline` - checked across all of `test/`.
Both edited files also expose `_deps` seams (`_iterationRunnerDeps` at
`iteration-runner.ts:308`, `_unifiedExecutorDeps`) and `runPipeline` is injected through
them, so the tests that exercise this path stub the *runner*, never the stage list. A
deferred import also resolves **after** `mock.module` calls in a test body rather than before,
which makes future mocking easier, not harder.

**6. One source-scraping test will break if you deviate from the recipe.**
`test/unit/execution/iteration-runner-worktree.test.ts:54` reads
`src/execution/iteration-runner.ts` as **text** and asserts that the index of
`"prepareWorktreeDependencies"` is less than the index of the literal substring
`"runPipeline(defaultPipeline"`. The recipe in Step 1 preserves that substring exactly,
because it adds a line *above* the call and leaves the call itself untouched. If you rename
the destructured binding, inline the import into the argument list
(`runPipeline((await import(...)).defaultPipeline, ...)`), or let a formatter wrap the call,
**this test fails on a change that is otherwise correct**. Keep the call line byte-identical.

**7. What Task 16 does *not* change.** No exported signature, no public barrel export, no
`_deps` seam shape, no config, no behaviour observable to a caller. `check:alias-internals`
is untouched (relative specifiers). The three `../pipeline/runner` imports in these two files
stay static - see Step 3.

**8. What it leaves behind - state this in the PR description.** A1 removes the
initialisation-order cycle; it does **not** make `pipeline` and `execution` independent.
`pipeline/stages/*` still calls into `@/execution`, and after Task 17 lowers the baseline to
0 that dependency is invisible to the gate. See Task 17 Step 3 and route A3 in 8.8.

**Verification sequence for this task specifically** - do not compress it:
```bash
bun run scripts/check-import-cycles.ts                       # expect 0
bun x tsc --noEmit
bun test test/unit/execution/ --timeout=30000                # the scraping test lives here
bun test test/unit/pipeline/ --timeout=30000
bun run check:all
bun run build && ls dist                                     # expect exactly nax.js
bun run test:coverage
bun run test:full                                            # FULL=1 NAX_PRECHECK=1
```

---

### Task 17: baseline to zero, and correct section 5

The drain ends here. Ruled 2026-09-13: **the baseline goes to 0 and the gate becomes
zero-tolerance** - any newly introduced cycle fails CI on the spot.

**Step 1 - lower the baseline.**
```bash
bun run check:import-cycles:update
```
Then **read the diff**. `scripts/baselines/import-cycles-baseline.json` must end up with
`count: 0` and an **empty** `modules` array. Section 1.4's "never raise the baseline" still
stands; this is the one and only lowering to zero.

**Step 2 - correct section 5 of this document.** Its central claim - that all 20 modules were
an irreducible mutual dependency needing a design decision - is now known to be false for 13
of them, and resolved for the other 7. Replace the section body with a short statement that
the residue is empty and that the `execution` <-> `pipeline` mutual dependency is now broken
at the `execution -> pipeline/stages` edge by deferral. **Section 8 stays append-only** -
correct section 5 in place, and let 8.7 and 8.8 stand as the record of what was believed when.

**Step 3 - the architectural debt is still real.** A1 removed the *initialisation-order*
cycle; it did not make `pipeline` and `execution` independent layers. `pipeline/stages/*`
still calls into `@/execution` for `appendProgress`, `processQueueFile` and six planning
symbols, and that dependency is now invisible to the gate. Note this explicitly in the
rewritten section 5 so a future reader does not mistake a green ratchet for a clean layering.
Route A3 from 8.8 remains the real fix and belongs in its own design note, not here - it is
open at **`docs/plans/2026-09-13-execution-pipeline-layering-design.md`**. Link that note from
the rewritten section 5. (That note also overturns 8.8's own guess at A3's shape: there is no
shared contract left to extract, and the fix is dependency inversion on the stage list.)

**Step 4 - check section 4's boxes** and confirm
`.nax/rules/project-conventions.md`'s "Cycle ratchet" paragraph still describes reality now
that the baseline reads 0.

**Proof.**
```bash
bun run scripts/check-import-cycles.ts    # [OK] 0 modules ... (baseline: 0)
bun run check:all
bun run test:coverage
bun run test:full                          # FULL=1 NAX_PRECHECK=1 - section 4 requires this once
```

---

## 4. Definition of done for this plan

- [x] `bun run scripts/check-import-cycles.ts` reports **0** cyclic modules.
- [x] `scripts/baselines/import-cycles-baseline.json` `count` is **0** with an empty
      `modules` array (no drift).
- [x] `bun run check:all` passes.
- [x] `bun run test:coverage` passes.
- [x] `bun run test:full` passes at least once at the end of the drain (`FULL=1 NAX_PRECHECK=1`).
- [x] Section 8 has one appended entry per wave, recording measured (not predicted) counts.
- [x] `.nax/rules/project-conventions.md`'s "Cycle ratchet" paragraph still describes reality.

---

## 5. The residue - rewritten 2026-09-13 by Task 17 (the drain is complete)

**The residue is empty.** The baseline reads `count: 0` with an empty `modules` array, and
the gate is zero-tolerance: any newly introduced cycle fails CI on the spot. The section-5
"20 modules needing a design decision" claim, written after Wave 4, was re-measured in 8.8
and found to be wrong for 13 of those modules (mechanical edges) and resolved for the other
7 (route A1). 8.7 and 8.8 stand as the record of what was believed when; the correction
banner at the bottom of this section documents the change.

**The architectural debt is still real.** A1 (Task 16) removed the *initialisation-order*
cycle by deferring `../pipeline/stages` from `execution/iteration-runner.ts` and
`execution/unified-executor.ts` with `await import(...)`, per the ruling in 8.8. It did not
make `pipeline` and `execution` independent layers: `pipeline/stages/*` still calls into
`@/execution` for `appendProgress`, `processQueueFile` and six planning symbols, and that
dependency is now invisible to the gate. A green ratchet is not a clean layering.

The real fix is dependency inversion on the stage list, not contract extraction — route A3
from 8.8 guessed at a shared contract, which turned out to already be resolved. The design
note at **`docs/plans/2026-09-13-execution-pipeline-layering-design.md`** owns that work;
it moves public exports out of `@/pipeline` / `@/execution`, engages section 1.4, and needs
its own spec and reviewers. Task 5's nested-barrel move of `pipeline/event-bus` was its
first brick.

> **CORRECTION 2026-09-13 - the text below this banner is the pre-Wave-5 section 5 and is
> retained only as the record of the wrong belief it produced.** It claimed 20 modules were
> an irreducible mutual dependency needing a design decision. That was false; see 8.8 and
> the Wave 5 tasks. Do not plan work from it.

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

### 8.4 - 2026-09-13 - Wave 1 complete (Tasks 1-3): 132 -> 128

Measured, not predicted. Deviations from the section 3 simulation:

- **Task 1 (test-runners self-barrel): 132 -> 130, exactly as simulated.** Component #4
  (`test-runners/{index,scoped-selection}`) died. One extra shift: biome's
  `organizeImports` reordered the new `./conventions` specifier relative to the `@/` and
  `../` imports; the pre-commit hook caught it and it was fixed with `biome check --write`
  before committing.
- **Task 2 (context/engine effectiveness self-barrel): measured 130 -> 130, 0 freed**
  (simulated 1). The cut still happened exactly as written (`./index` -> 
  `./providers/static-rules`), but the ranker confirmed after Task 1 that the edge frees
  nothing: `effectiveness.ts` stays in the 92-module component through the longer loop
  `effectiveness -> static-rules -> @/context -> engine/index -> effectiveness`, whose
  load-bearing back-edge (`static-rules -> @/context`) is Task 6's. The module is now
  expected to free with Task 6, not Task 2.
  **Plan gap found: `test/unit/context/engine/effectiveness-barrel.test.ts` (US-003
  adversarial finding) pinned the OLD direction** - it asserted `effectiveness.ts` must
  import `globToRegex`/`normalizePath` *through the barrel*, the exact opposite of this
  task. The test was updated (with user approval) to carve out a scoped exemption for the
  two cycle-drain symbols; the convention still holds for everything else and the exemption
  is itself pinned so it cannot widen silently. 2 of 4 assertions changed; the other two
  (type-only exemption, barrel re-exports precondition) untouched.
- **Task 3 (_rulesCLIDeps extraction): 130 -> 128, exactly the simulated 2.** Component #5
  (`cli/{rules,rules-migrate}`) died. Deviation from the plan's edit list: `rules.ts` also
  *consumes* `_rulesCLIDeps` internally (not just re-exports it), so the re-export alone
  left 14 `TS2552` errors; the fix was a local `import { _rulesCLIDeps } from
  "./rules-cli-deps"` alongside the re-export. The extraction also orphaned three imports
  in `rules.ts` (`loadCanonicalRules`, `getLogger`, `_rulesLintDeps`) which had been used
  only by the moved object; each was removed and the file re-linted. Test-spelling
  `@/cli/rules` for `_rulesCLIDeps` was preserved via the re-export, so all six
  `test/unit/cli/rules*` suites passed unchanged.

Full gates after Wave 1: cycles 128/baseline 128, tsc clean, alias-internals clean,
file-sizes clean, `test/unit/cli/` 1050 pass, `test:coverage` OK (new `src/` file
`rules-cli-deps.ts`, 0 files below floor).

Commits: `ff994cb74` (Task 1), `f56a625f1` (Task 2), `3ee38f3ba` (Task 3).

**Expected-count adjustment going forward:** Task 2's simulated freeing is dead;
`effectiveness.ts` is credited to Task 6. Wave 2's simulated **127 -> 61** becomes
**128 -> 62** (Task 4's 55 and Task 5's 11 are unaffected by the shift — re-confirmed
against the current graph with the section 2.2 ranker, which still reads frees=55 and
frees=11; 128 - 66 = 62, not the plan's 61).

### 8.5 - 2026-09-13 - Wave 2 complete (Tasks 4-5): 128 -> 62

Measured, not predicted. Both edges landed exactly as the 8.4 adjustment said they would.

- **Task 4 (defer `@/operations` in findings/cycle, frees 55): 128 -> 73, exactly.**
  The entire cut was scripted: delete the static import, make `_cycleDeps.callOp`
  optional, `await import("@/operations")` at the top of `runFixCycle`, use the local
  `newCallId` at the dispatch site. `grep -rn "_cycleDeps"` pre-check confirmed no test or
  other `src/` file reads the field. All 227 `test/unit/findings/` tests pass; `check:all`
  green. The 92-module component split into the 20-module residue (section 5), a 15, a
  12, and a 10 — no surprise stragglers.
- **Task 5 (promote `pipeline/event-bus` to a nested barrel, frees 11): 73 -> 62,
  exactly.** Three plan deviations, none structural:
  - The four relative specifiers inside the moved file (`../config`, `../logger`,
    `../plugins/extensions`, an inline `import("../metrics/types").RunFallbackAggregate`)
    would have become `../../*` and ran into biome's ban. They were respelled as `@/`
    specifiers per plan step 3 — except `@/metrics/types` is *not* legal (alias-into-
    internal, even type-only): the gate's own docs exempt `import type` statements but
    not inline `import(...)` types, and the gate flagged it. Since the metrics barrel
    re-exports `RunFallbackAggregate` (`src/metrics/index.ts:29`), the inline type was
    hoisted to a top-level `import type { RunFallbackAggregate } from "@/metrics"`.
  - `run-phase.ts` needs the barrel edge cut to actually land: my first pass moved the
    file and fixed its internals, and the count correctly *stayed* at 73 until I also
    changed `run-phase.ts:8` from `@/pipeline` to `@/pipeline/event-bus` (plan step 5) —
    immediate drop to 62. Order matters: the move alone frees nothing.
  - Two tests pin the module's old path as text (`test/unit/execution/parallel-cleanup.
    test.ts` BUG-071 `StoryCompletedEvent` block, `test/unit/cleanup/decompose-removal.
    test.ts` AC5): `readSrc("pipeline/event-bus.ts")` was failing to read the moved
    file. Both updated to `pipeline/event-bus/index.ts`, test names adjusted.

Full gates after Wave 2: cycles 62/baseline 62, tsc clean, alias-internals clean (92
barrels), file-sizes clean, `test/unit/pipeline/` + `test/unit/execution/` 2538 pass,
`test:coverage` OK.

Commits: `560fed8d3` (Task 4), `26827e735` (Task 5).

**Expected-count adjustment going forward:** the graph has changed enough that some
Wave 3-4 edges have different freed-counts now (measured, section 2.2 ranker at 8.5):
- Task 6's four back-edges: `feature-context.ts -> @/context` now frees **4** alone
  (simulated 8 for the fourth edge); expect the component to split over three cuts, with
  the last one landing the big drop. Do **not** take the `context/index.ts ->
  context/engine/index.ts` cut (ranks at frees=12) — still a public re-export, section
  1.4.
- Task 10 (`routing/router.ts -> @/operations`) now frees **3** (simulated 4).
- Tasks 7, 8, 11 unchanged (frees 7, 6, 5).
- Wave 3-4 land **20** either way: the residue is already separated, so the 37 leftover
  modules are the whole remaining story. 15 (Task 6) + 12 and 10 partly (Tasks 7-10) +
  5 (Task 11) + Task 12's 3 -> exactly 20 at the end, per the plan's simulation of the
  final residue.

### 8.6 - 2026-09-13 - Wave 3 complete (Task 6): 62 -> 50

`context/index.ts` component is gone. The edge-by-edge drops were **1, 1, 2, 8** across
the four files (plan predicted 1, 1, 1, 8; static-rules' multi-symbol edge freed 2 instead
of 1 because its cut also unloaded the `static-rules-budget-notice` type-only re-route —
the total is unchanged at exactly the plan's **50**).

Deviation from the plan's edit list: the plan's "pick (B) or (C)" prose allowed (B) for
leaves in `src/context/engine/`, but **no** defining leaf of the four sits under
`engine/` — they are all in `src/context/` proper, one level above `providers/`, so every
edge used technique (C):
- `generateTestCoverageSummary` -> promote `src/context/test-scanner.ts` to
  `test-scanner/index.ts` (its own `../` imports respelled to `@/optimizer`,
  `@/test-runners`, `@/logger`, `@/utils/errors` — all verified barrel-legal).
- `loadCanonicalRules` + `type CanonicalRule` -> promote `rules/canonical-loader.ts`;
  the mixed `{ type CanonicalRule, loadCanonicalRules }` statement was split per plan
  step 2, with both halves now pointing at `@/context/rules/canonical-loader` (the
  type-only half could have stayed on `@/context` but the leaf is equally legal).
- `static-rules.ts` multi-symbol block -> promote `rules/rule-sections.ts` and
  `rules/rule-budget.ts` in addition to canonical-loader; all five symbols now come
  from `@/context/rules/{rule-sections,rule-budget,canonical-loader}`.
- `FeatureContextProvider as FeatureContextProviderV1` -> promote
  `providers/feature-context.ts` (V1) to `providers/feature-context/index.ts`. That
  cascaded one level: V1 imports `resolveFeatureId` from `../feature-resolver`, which
  would have become `../../` (banned), so `src/context/feature-resolver.ts` was
  promoted to its own nested barrel too and V1 spells it `@/context/feature-resolver`.

Collision checks (plan step 4 / Task 5 step 4) run after every promotion: no
file-vs-barrel shadowing, `check:alias-internals` clean at every step (98 barrels at
completion).

The 3-module remnant is exactly the Task 12 knot (`pull-tools.ts` <-> the two
`handlers/query-*` files); Task 12's expected frees of 3 applies to it directly.

Full gates after Wave 3: cycles 50/baseline 50, tsc clean, alias-internals clean,
file-sizes clean, `check:all` green (one biome import-order fix needed after the moves),
`test/unit/context/` 1544 pass, `test:coverage` OK (six `src/` files moved).

Commit: `7afbc01ad`.

**Expected-count adjustment going forward:** Task 6's realized total (12 freed) matches
the plan's 62 -> 50 exactly. Wave 4 targets: Tasks 7, 8, 11 unchanged (7, 6, 5);
Task 10 frees **3** (not 4) — re-measured after Wave 3, the `routing/router.ts` cut
trawls one fewer module; Task 9's edge was 5; Task 12 frees **3**. Sum of remaining
cuts: 7+6+5+3+5+3 = 29 -> **50 - 29 = 21**, one above the plan's 20. The ranker at Wave 3
shows `agents/acp/adapter-lifecycle.ts -> spawn-client.ts` and `operations/index.ts ->
debate-hybrid.ts` as the highest-value extra edges after the Task 7/8/9 cuts, so the 21
may collapse to 20 with a free edge at the end — re-measure after each cut and trust the
tool.

### 8.7 - 2026-09-13 - Wave 4 complete (Tasks 7-12 + bonus cut): 50 -> 20


Measured, not predicted. The drain is done — 132 -> 20, the plan's exact end state, with
the residue verified module-for-module against section 5 (diff of `--list` output vs the
20 listed modules: empty).

Per-task drops and deviations from the plan's simulated counts:

- **Task 7 (defer `SpawnAcpSession`, frees 7): 50 -> 43, exactly.** Scripted edit landed
  verbatim: delete the import + the value re-export, `await import()` before both `new`
  sites, repoint the one test. Zero surprises, 1416 agent tests green.
- **Task 8 (`session-helpers` leaf imports): 43 -> 42, freed 1 of the simulated 6.** The
  plan's simulation was wrong about this edge surviving the graph changes of Waves 2-3:
  the loop re-routed through my new `session-helpers -> selectors/registry` edge into
  `selectors/judge.ts -> @/operations` (ranked frees=6 at the time). The prescribed edit
  was made exactly as written; the count just didn't follow. Re-ranked per section 6.1.
- **Task 9 (`stdout-line-reader -> ./parser`, frees 5): 42 -> 37, exactly.**
- **Task 10 (defer `@/operations` in `routing/router.ts`): 37 -> 34, freed 3** (simulated
  4; the 8.6 adjustment said 3). Both call sites confirmed inside `async` before
  applying (D); `await import("@/operations")` added at the top of `resolveRouting` and
  `tryLlmBatchRoute`.
- **Task 11 (cli/plan strategies knot, frees 5): 34 -> 29, exactly, component killed.**
  Technique (C) required a cascade the plan did not list: `plan-runtime/index.ts`'s
  `../context/generator` would have become `../../`, so `src/context/generator.ts` was
  promoted to a nested barrel alongside the two `src/cli/` files. Three other relative
  specifiers inside the moved files (incl. two dynamic `import()`s at lines 112/122)
  were respelled to `@/precheck` / `../plan-decompose`. All three moved files' internal
  `../` imports were respelled to barrels; the `@/analyze`, `@/interaction`,
  `@/context/generator` targets were verified to be exact barrel matches first.
  `context-builder.ts` lines 2-8 replaced with the two new imports verbatim from the
  plan.
- **Task 12 (pull-tools handlers, frees 3): 29 -> 26, exactly.** Extracted
  `DEFAULT_MAX_TOKENS_PER_CALL` to `pull-tools-constants.ts`; re-exported from
  `pull-tools.ts`, imported as a leaf by both handlers, `_pullToolsDeps` deferred to
  `await import("../pull-tools")` at the call sites. Deviation: `pull-tools.ts` itself
  also consumes the constant (lines 96/127/179), so it needed the leaf import in
  addition to the re-export — the pure re-export alone left three `TS2304` errors.
- **Bonus cut (deferential `_debateSessionDeps`, frees 6): 26 -> 20, the plan's target.**
  At 26, `routing`/`operations`/`debate` still held a 6-module loop
  (`session-helpers -> selectors/registry -> judge/synthesis -> @/operations ->
  debate-hybrid -> session-helpers`) — the residue Task 8 was supposed to have killed.
  Ranker said the load-bearing back-edge is `operations/debate-hybrid.ts ->
  session-helpers.ts` (frees 6) — the exact edge Task 8's prose named but whose cut the
  plan did not prescribe (section 6.1: re-rank and trust the tool; the plan's task list
  is the simulation's). Applied technique (D): deleted the static import and resolved
  the logger directly from `@/logger` (the deps object's `getSafeLogger` is an identity
  cast of the logger's own function, so behavior is unchanged). Caveat: `_debateSessionDeps`
  is exported and test-mocked elsewhere (`runner-*.test.ts`); only `debate-hybrid.ts`
  was switched. One test
  (`test/unit/operations/debate-hybrid.test.ts` "hopBody sends proposal first...") pins
  that `ctx.send` runs **synchronously before the first await** — the naive
  `await import()` at the top of `hopBody` broke it; `@/logger`'s static import avoids
  the extra microtask and keeps the timing contract.

**Definition of done status:** cycles 20/baseline 20 with residue matching section 5
module-for-module; `check:all` green; `test:coverage` green; `.nax/rules/
project-conventions.md` "Cycle ratchet" paragraph updated (94 -> 20 modules) and
re-exported via `nax rules export --agent=claude` (rules-drift clean).
`test:full` (`FULL=1 NAX_PRECHECK=1`) run end-of-drain: **4 pre-existing failures in
`test/integration/plan/logger.test.ts` and `test/integration/cli/cli-precheck-checks
.test.ts` (logger write-error handling, gitignore coverage, precheck emoji/summary)**,
reproduced identically on the pre-drain base commit `e69bb5fdf` in a worktree — not
caused by this drain, out of scope.

Commits, in order: `3e313e65f` (7), `a3e72f7e7` (8), `5b33f15ac` (9), `d51fffc51` (10),
`3fe744a05` (11), `6d1384c29` (12), `ce906f83` (bonus).

**Looking forward:** the 20-module `execution`/`pipeline` knot is untouched by design
(section 5). Breaking it is a design decision — extract the shared contract (event bus,
queue interface, result types) into a third layer. Task 5's nested-barrel move of
`pipeline/event-bus` remains the first brick of that extraction.
### 8.8 - 2026-09-13 - the 20-module "residue" re-measured; Wave 5 planned; A1 ruled

**Trigger.** Section 5, written after Wave 4, claimed all 20 remaining modules were "a genuine
mutual dependency between the `execution` and `pipeline` layers, not a barrel accident", that
"every remaining edge frees exactly 1 module", and that breaking it "needs a design decision,
not a refactor pass". That framing was taken to the design-decision conversation. It did not
survive re-measurement.

**Method.** Every number below was produced by making the edit in the working tree, running
`bun run scripts/check-import-cycles.ts --list`, and then reverting. Nothing is predicted.
The tree was confirmed back at 20 after each probe and again at the end.

**Finding 1 - 10 of the 20 were a Wave-2 migration that was never finished.** Task 5 promoted
the event bus to `src/pipeline/event-bus/index.ts` and switched three call sites
(`cost-guard.ts`, `merge-conflict-outcomes.ts`, `story-orchestrator/run-phase.ts`). **Nine
other files in the cycle still imported `pipelineEventBus` from the `@/pipeline` parent
barrel**, dragging in `pipeline/stages` and therefore `@/execution` to reach one object. A
pure specifier rewrite on nine lines: **20 -> 10, measured.** This is the single largest
unclaimed win left in the drain and it required no decision of any kind.

**Finding 2 - 1 more was an ordinary self-barrel edge.**
`src/execution/escalation/tier-escalation.ts:21` imported `{ calculateMaxIterations,
escalateTier, getTierConfig }` from `"../escalation"` - its own directory barrel - when the
defining leaf is the sibling `./escalation`. Identical in shape to Waves 1's Tasks 1 and 2.
The directory and the leaf file share a name, which is presumably why the ranker's output was
misread. **10 -> 9, measured.**

**Finding 3 - 2 more were a real but trivially separable mutual recursion.**
`tier-escalation.ts` <-> `tier-outcome.ts`. The back-edge carries exactly one symbol,
`resolveMaxAttemptsOutcome`, a pure synchronous `switch` with no value imports, stranded in a
598-line async-orchestration file. Extracting it to its own leaf is correct on its own merits
and no public barrel export moves. **9 -> 7.**

**Finding 4 - the real knot is 7 modules, and section 5's "every remaining edge frees exactly
1 module" is false of it.** The knot is
`pipeline/stages/{index,completion,execution,queue-check}` <-> `execution/{index,
iteration-runner,unified-executor}`. Cutting **either** direction dissolves the whole thing:

| Route | What was simulated | Measured |
|:--|:--|--:|
| A1 | delete the two `../pipeline/stages` import lines in `iteration-runner.ts` and `unified-executor.ts` | **7 -> 0** |
| A2 | delete the three `@/execution` imports in `stages/{completion,queue-check,execution}.ts` | **7 -> 0** |

So this was never a choice between "fix it" and "accept it"; it was a choice of which
direction to cut and by which technique.

**Decision (ruled by the maintainer, 2026-09-13): route A1 - defer with `await import`.**

- **A1 (chosen).** Two files, three call sites, all three already inside `await` expressions
  in `async` functions. Technique (D), which section 1.3 describes as "not a loophole; it is
  the honest fix" because it removes the edge from the real ESM initialisation order rather
  than only from the ratchet. 84 existing precedents in `src/`. Blast radius documented in
  full under Task 16 - the short version is that `defaultPipeline` was *already* a lazy
  `Proxy`, the build has no `--splitting` flag so `dist/` stays a single `nax.js`, no test
  mocks the stages module, and exactly one source-scraping assertion
  (`iteration-runner-worktree.test.ts:54`) constrains how the edit must be spelled.
- **A2 (rejected).** Promoting ~5 execution leaves (`progress`, `queue-handler`,
  `plan-inputs`, `build-plan-for-strategy`, `post-run`) to nested barrels. Keeps every import
  static and eager, so its runtime blast radius is nil - but it is five directory moves plus
  a `test:coverage` pass, and it makes the dependency one-directional **in spelling only**:
  `pipeline` would still depend on `execution` code, just spelled so the gate cannot see it.
  More churn than A1 for a weaker result.
- **A3 (deferred, not rejected).** Make the two layers genuinely independent. At the time of
  this ruling A3 was assumed to mean extracting the shared contract - the event bus, the queue
  interface, the result types - into a third layer both sides depend on and neither owns.
  **That assumption was later found to be wrong**: all three pieces are already resolved, and
  the actual fix is dependency inversion on the stage list. See
  `docs/plans/2026-09-13-execution-pipeline-layering-design.md`, which supersedes this
  paragraph's description of A3 while leaving the ruling itself intact.
  **This is the only route that actually fixes the layering, and it is the one with the large
  blast radius**: it moves public exports out of `@/pipeline` and `@/execution` (engaging
  section 1.4), touches every import site of the moved symbols across `src/` and `test/`, and
  cannot be handed to an implementer as a mechanical recipe the way Tasks 13-17 can. Task 5
  already laid its first brick by giving the event bus its own nested barrel. It belongs in
  its own design note with its own spec, **not** in this drain.

**Consequence to keep visible.** A1 buys a green ratchet without buying clean layering.
`pipeline/stages/*` still calls into `@/execution` for `appendProgress`, `processQueueFile`
and six planning symbols; after Task 17 lowers the baseline to 0 that dependency is invisible
to the gate. Task 17 Step 3 requires this to be written into the rewritten section 5 so a
future reader does not mistake a passing check for a resolved architecture.

**Second ruling: the baseline goes to 0 and the gate becomes zero-tolerance.** Any newly
introduced cycle fails CI immediately from then on. Section 1.4's "never raise the baseline"
is unchanged; Task 17 is the one and only lowering to zero.

**Wave 5 (Tasks 13-17) is written up in section 3 and is ready for handover to an implementer
with no context.** Expected path, every step measured rather than predicted:
**20 -> 10 -> 9 -> 7 -> 0.** Section 5 is left standing until Task 17 rewrites it, with a
correction banner pointing here; section 8 remains append-only.

### 8.9 - 2026-09-13 - Wave 5 complete (Tasks 13-17): 20 -> 0, the drain is done

Measured, not predicted. The baseline file reads `count: 0` with an empty `modules` array;
the gate is now zero-tolerance. Section 5 was rewritten by Task 17; section 0 re-measured.

Per-task drops (all exactly as Wave 5's table predicted, every step 2026-09-13):

- **Task 13 (nine `@/pipeline/event-bus` specifier rewrites, frees 10): 20 -> 10, exactly.**
  The nine files in the table were edited verbatim; `usePipelineBusEvents.ts` and
  `finish/phase.ts` left untouched per the task's note. tsc + alias-internals + lint clean.
  Commit `b8588d058`.
- **Task 14 (tier-escalation self-barrel, frees 1): 10 -> 9, exactly.** The pre-commit hook
  caught one biome `organizeImports` ordering change (the `../progress` / `./escalation`
  pair) — fixed with `biome check --write` before committing. Commit `f0b283e11`.
- **Task 15 (extract `resolveMaxAttemptsOutcome`, frees 2): 9 -> 7, exactly.**
  Deviations from the prescribed edit list: the leaf's type import is spelled
  `@/tdd/types` (the plan prose said `@/tdd`; the file's own specifier wins). Biome again
  re-ordered imports in `tier-outcome.ts`; `test:coverage` green (new `src/` file
  `max-attempts-outcome.ts` above the per-file floor, 0 below). 136 escalation tests
  unchanged and green. Commit `6ffa5b36d`.
- **Task 16 (defer `../pipeline/stages`, frees 7): 7 -> 0, exactly.** The edit landed as
  prescribed: import lines deleted, `await import` added above the two `unified-executor.ts`
  call sites (inside their `if` blocks, per the task's warning) and above the
  `iteration-runner.ts` call site with the call line byte-identical (the
  `iteration-runner-worktree.test.ts` source-scraping assertion stayed green).
  **One plan gap, fixed inline:** the +2 lines pushed `unified-executor.ts` to 735, one over
  its 734-line grandfathered file-size record — the section 1.5 reminder that the gate is a
  ratchet, not a suggestion. Applied the prescribed remedy (split, not raise): extracted
  `reconcileBatchOutcome` (+ its load-bearing doc comment) verbatim to a new leaf
  `src/execution/reconcile-batch-outcome.ts`, repointed the one internal call site and the
  one test import via a re-export, dropped the now-unused `markStoryFailed`/
  `markStoryPassed` imports, and lowered the file-sizes baseline (734 -> 702). Blast-radius
  items re-confirmed: grep of the ten stage files found no module-scope side effects beyond
  `const` declarations and the already-lazy `defaultPipeline` Proxy; `bun run build` still
  emits a single `dist/nax.js`; per-story hot path cost is one module-cache lookup. Commit
  `19e178db9`.
- **Task 17 (baseline to 0 + section 5 rewrite): done here.** Section 0 re-measured
  (0 modules / 0 SCCs), section 5 rewritten in place with the correction banner retained,
  section 4's boxes checked, `.nax/rules/project-conventions.md` "Cycle ratchet" paragraph
  re-read and confirmed still accurate at zero (it describes the mechanism, not a count).

Full gates at end of drain: cycles **0/baseline 0**, tsc clean, alias-internals clean,
file-sizes clean (baseline lowered), lint clean, `check:all` green, `test:coverage` green,
build single-file. `test:full` (`FULL=1 NAX_PRECHECK=1`): **18460 pass, 4 fail** — the same
four pre-existing integration failures 8.7 recorded (logger write-error handling, gitignore
coverage, precheck emoji/summary). Re-confirmed pre-existing this wave by reproducing the
identical 41-pass/4-fail result on the pre-drain base `e69bb5fdf` in a worktree — not caused
by this drain.

Commits this wave, in order: `b8588d058` (13), `f0b283e11` (14), `6ffa5b36d` (15),
`19e178db9` (16), plus the final doc commit (17).

**The drain is done: 132 -> 0.** The remaining `execution <-> pipeline` dependency is
invisible to the gate and belongs to
`docs/plans/2026-09-13-execution-pipeline-layering-design.md` (route A3, dependency
inversion on the stage list).
