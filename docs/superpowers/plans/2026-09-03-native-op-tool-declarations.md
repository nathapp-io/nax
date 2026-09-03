# Native Op Tool Declarations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a native agent run a complete three-session TDD story by declaring the tools the `verifier` and `test-writer` ops already require, and add a gate so the next op cannot forget.

**Architecture:** `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS` (read-only), so an op that omits `tools:` silently loses write/run capability on the native transport while remaining fine on acpx. Two ops gain declarations; a new ratchet check enforces the role→capability invariant against the operations barrel, with the seven remaining offenders grandfathered in a baseline.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run`), Biome. Check scripts are `scripts/check-*.ts` run under `bun`, with baselines in `scripts/baselines/`.

**Spec:** `docs/superpowers/specs/2026-09-03-native-op-tool-declarations-design.md`

## Global Constraints

- **No new tool, no new declared command, no shell.** ADR-029 section 3 stays deferred; nothing in this plan may add `Bash` or a general `RunCommand("bash", ...)` entry.
- **Capability narrows, never widens by inheritance.** Tools stay declared per-op. The role table is *enforced*, never *applied* as a default.
- **The verifier may not gain `Write`, `Edit` or `GitCommit`.** It judges work it must not alter.
- **Every `scripts/check-*.ts` must be reachable from `bun run check:all` or `.github/workflows/ci.yml`**, or `check:gate-reachability` fails.
- **Source files: 600-line limit; test files: 800** (`check:file-sizes`). Grandfathered files may not grow.
- **No `as` casts in `test/`** — `check:test-escape-hatches` is a ratchet at `looseCast=1623`. Write full typed literals instead.
- Run the local build as `bun run bin/nax.ts`, never the globally installed `nax` (it predates the tool-audit ledger).

---

### Task 1: The role→capability check script

**Files:**
- Create: `scripts/check-op-tool-capability.ts`
- Create: `scripts/baselines/op-tool-capability-baseline.json`
- Modify: `package.json` (append to the `lint` script chain)
- Test: `test/unit/scripts/check-op-tool-capability.test.ts`

**Interfaces:**
- Consumes: `resolveDeclaredTools` from `@/operations/types`; the operations barrel `@/operations`.
- Produces: `REQUIRED_TOOLS_BY_ROLE: Record<string, readonly string[]>`, `collectOps(mod): OpRow[]` where `OpRow = { name: string; role: string; tools: readonly string[] }`, and `findViolations(rows, baseline): Violation[]` where `Violation = { name: string; role: string; missing: string[] }`. Task 2 and Task 3 rely on `REQUIRED_TOOLS_BY_ROLE` and on the baseline file shrinking.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scripts/check-op-tool-capability.test.ts`:

```typescript
/**
 * The role/capability gate (nax#1800 follow-on).
 *
 * `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS`, so omitting the
 * field yields read-only rather than an error. That is invisible on acpx, where
 * the ACP agent brings its own tools, and silently disables an op on native.
 * This gate makes the omission loud for roles whose work requires more.
 */

import { describe, expect, test } from "bun:test";
import { collectOps, findViolations, REQUIRED_TOOLS_BY_ROLE } from "../../../scripts/check-op-tool-capability";

describe("REQUIRED_TOOLS_BY_ROLE", () => {
  test("a verifier must be able to run commands but never to write", () => {
    const required = REQUIRED_TOOLS_BY_ROLE.verifier;

    expect(required).toContain("RunCommand");
    expect(required).not.toContain("Write");
    expect(required).not.toContain("Edit");
  });

  test("write-capable roles require Write and Edit", () => {
    for (const role of ["implementer", "test-writer", "source-fix", "test-fix", "finish-fix"]) {
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Write");
      expect(REQUIRED_TOOLS_BY_ROLE[role]).toContain("Edit");
    }
  });
});

describe("collectOps", () => {
  test("dedupes ops exported under more than one alias", () => {
    const shared = { kind: "run", name: "implementer", session: { role: "implementer" }, tools: ["Write", "Edit"] };

    const rows = collectOps({ implementerOp: shared, implementTddOp: shared });

    expect(rows).toHaveLength(1);
  });

  test("collects two distinct ops defined in one module", () => {
    const rows = collectOps({
      acceptanceFixSourceOp: { kind: "run", name: "acceptance-fix-source", session: { role: "source-fix" } },
      acceptanceFixTestOp: { kind: "run", name: "acceptance-fix-test", session: { role: "test-fix" } },
    });

    expect(rows.map((r) => r.name).sort()).toEqual(["acceptance-fix-source", "acceptance-fix-test"]);
  });

  test("an op with no tools field reports the read-only default, not an empty set", () => {
    const rows = collectOps({ verifierOp: { kind: "run", name: "verifier", session: { role: "verifier" } } });

    expect(rows[0]?.tools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("ignores exports that are not run operations", () => {
    const rows = collectOps({
      helper: () => "not an op",
      planOp: { kind: "compute", name: "plan", session: { role: "plan" } },
    });

    expect(rows).toEqual([]);
  });
});

describe("findViolations", () => {
  test("reports the specific tools a role requires and the op omits", () => {
    const rows = [{ name: "rectify", role: "implementer", tools: ["Read", "Glob", "Grep"] }];

    const violations = findViolations(rows, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.missing).toEqual(["Write", "Edit"]);
  });

  test("a baselined op is not a violation", () => {
    const rows = [{ name: "rectify", role: "implementer", tools: ["Read", "Glob", "Grep"] }];

    expect(findViolations(rows, ["rectify"])).toEqual([]);
  });

  test("a declared op passes", () => {
    const rows = [{ name: "test-writer", role: "test-writer", tools: ["Read", "Write", "Edit", "RunCommand"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });

  test("a role with no entry in the table is unconstrained", () => {
    const rows = [{ name: "semantic-review", role: "reviewer-semantic", tools: ["Read"] }];

    expect(findViolations(rows, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/scripts/check-op-tool-capability.test.ts`
Expected: FAIL — `Cannot find module '../../../scripts/check-op-tool-capability'`.

- [ ] **Step 3: Write the script**

Create `scripts/check-op-tool-capability.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Ratchet check: an operation whose session role must write files or run
 * commands has to DECLARE those tools.
 *
 * Why this exists: `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS`
 * (`src/operations/types.ts`), so omitting the field yields a read-only set
 * rather than an error. On acpx that is inert -- the ACP agent brings its own
 * tools -- so the omission never surfaces there. On the native transport it
 * silently disables the op: a test-writer that cannot write, a verifier that
 * cannot run its own tests.
 *
 * Capability stays declared per op rather than derived from the role. Deriving
 * would trade a silent under-grant for a silent over-grant -- a new op picking
 * `role: "implementer"` would inherit Write/Edit/GitCommit with nobody deciding
 * it should. So the role table is ENFORCED here, never APPLIED at runtime.
 *
 * The check imports the operations barrel instead of parsing source, because
 * the source shape misleads twice: ops are exported under aliases
 * (`implementerOp` and `implementTddOp` are the same object), and one module can
 * define several ops (`acceptance-fix.ts` defines both `acceptance-fix-source`
 * and `acceptance-fix-test`). Reading the barrel reads what dispatch reads.
 *
 * Usage:
 *   bun scripts/check-op-tool-capability.ts                   # check (CI mode)
 *   bun scripts/check-op-tool-capability.ts --update-baseline # save new baseline
 *
 * Exit codes:
 *   0 — no unbaselined violations
 *   1 — a violation, or a baselined op that has since been fixed (lower the baseline)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeclaredTools } from "../src/operations/types";
import type { CodingToolName } from "../src/tools";
import { byCodePoint } from "../src/utils/sort";

const BASELINE_FILE = join(import.meta.dir, "baselines", "op-tool-capability-baseline.json");

/**
 * Minimum tools a session role's work requires.
 *
 * `verifier` is deliberately run-only: a verifier that can repair what it is
 * judging is not a verifier, and the isolation check it performs assumes it
 * changed nothing.
 */
export const REQUIRED_TOOLS_BY_ROLE: Record<string, readonly string[]> = {
  implementer: ["Write", "Edit"],
  "test-writer": ["Write", "Edit"],
  "source-fix": ["Write", "Edit"],
  "test-fix": ["Write", "Edit"],
  "repo-scoped-test-fix": ["Write", "Edit"],
  "fix-gen": ["Write", "Edit"],
  "finish-fix": ["Write", "Edit"],
  verifier: ["RunCommand"],
};

export interface OpRow {
  readonly name: string;
  readonly role: string;
  readonly tools: readonly string[];
}

export interface Violation {
  readonly name: string;
  readonly role: string;
  readonly missing: string[];
}

interface Baseline {
  updatedAt: string;
  /** Op names knowingly undeclared. Shrinks as the follow-up arc declares them. */
  ops: string[];
}

/** Walk a module's exports for run operations, deduped by object identity. */
export function collectOps(mod: Record<string, unknown>): OpRow[] {
  const seen = new Set<unknown>();
  const rows: OpRow[] = [];
  for (const value of Object.values(mod)) {
    if (typeof value !== "object" || value === null) continue;
    const op = value as { kind?: unknown; name?: unknown; session?: { role?: unknown }; tools?: readonly string[] };
    if (op.kind !== "run" || typeof op.name !== "string") continue;
    const role = op.session?.role;
    if (typeof role !== "string") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    rows.push({ name: op.name, role, tools: resolveDeclaredTools(op as { tools?: readonly CodingToolName[] }) });
  }
  return rows;
}

export function findViolations(rows: readonly OpRow[], baseline: readonly string[]): Violation[] {
  const exempt = new Set(baseline);
  const violations: Violation[] = [];
  for (const row of rows) {
    if (exempt.has(row.name)) continue;
    const required = REQUIRED_TOOLS_BY_ROLE[row.role];
    if (required === undefined) continue;
    const missing = required.filter((tool) => !row.tools.includes(tool));
    if (missing.length > 0) violations.push({ name: row.name, role: row.role, missing });
  }
  return violations;
}

function readBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return { updatedAt: "", ops: [] };
  }
}

async function main(): Promise<void> {
  const mod = (await import("../src/operations")) as Record<string, unknown>;
  const rows = collectOps(mod);
  const baseline = readBaseline();

  if (process.argv.includes("--update-baseline")) {
    const ops = findViolations(rows, [])
      .map((v) => v.name)
      .sort(byCodePoint);
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ updatedAt: new Date().toISOString(), ops }, null, 2)}\n`);
    console.log(`Baseline updated: ${ops.length} undeclared op(s).`);
    return;
  }

  const violations = findViolations(rows, baseline.ops);
  if (violations.length > 0) {
    console.error("[FAIL] operations whose session role requires tools they do not declare:\n");
    for (const v of violations.sort((a, b) => byCodePoint(a.name, b.name))) {
      console.error(`  ${v.name} (role ${v.role}) is missing: ${v.missing.join(", ")}`);
    }
    console.error(`\nAdd a \`tools:\` declaration to the operation. Omitting it yields`);
    console.error(`DEFAULT_CODING_TOOLS (read-only), which disables the op on the native`);
    console.error(`transport while leaving acpx unaffected -- so this never fails at runtime.`);
    process.exit(1);
  }

  const stillViolating = new Set(findViolations(rows, []).map((v) => v.name));
  const stale = baseline.ops.filter((name) => !stillViolating.has(name));
  if (stale.length > 0) {
    console.error(`[FAIL] baseline lists op(s) that no longer violate: ${stale.join(", ")}`);
    console.error("Lower it with: bun scripts/check-op-tool-capability.ts --update-baseline");
    process.exit(1);
  }

  console.log(`OK: ${rows.length} run op(s) checked, ${baseline.ops.length} grandfathered.`);
}

if (import.meta.main) await main();
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `bun test test/unit/scripts/check-op-tool-capability.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Generate the baseline and confirm its contents**

Run:
```bash
bun scripts/check-op-tool-capability.ts --update-baseline
cat scripts/baselines/op-tool-capability-baseline.json
```
Expected: exactly seven ops — `acceptance-fix-source`, `acceptance-fix-test`, `autofix-implementer`, `autofix-test-writer`, `finish-fix`, `full-suite-rectify`, `rectify`. `verifier` and `test-writer` WILL also be present at this point because Tasks 2 and 3 have not run yet; that is expected, and Task 3 Step 5 removes them.

- [ ] **Step 6: Wire the gate into CI and verify reachability**

In `package.json`, add `check:op-tool-capability` as a script and append it to the `lint` chain:

```json
"check:op-tool-capability": "bun run scripts/check-op-tool-capability.ts",
```

Append ` && bun run check:op-tool-capability` to the end of the existing `lint` script value.

Run: `bun run check:gate-reachability`
Expected: `OK: all 24 check scripts are reachable from CI` (24, not 23).

- [ ] **Step 7: Run the gate itself**

Run: `bun run check:op-tool-capability`
Expected: `OK: 28 run op(s) checked, 9 grandfathered.`

- [ ] **Step 8: Commit**

```bash
git add scripts/check-op-tool-capability.ts scripts/baselines/op-tool-capability-baseline.json package.json test/unit/scripts/check-op-tool-capability.test.ts
git commit -m "feat(gates): require write-capable ops to declare their tools

resolveDeclaredTools is \`op.tools ?? DEFAULT_CODING_TOOLS\`, so an op that
omits the field silently receives read-only. That is inert on acpx, where the
ACP agent brings its own tools, and disables the op on native.

The gate enforces a role table rather than applying it: deriving tools from the
role would trade a silent under-grant for a silent over-grant. Nine ops are
grandfathered; the verifier and test-writer leave the baseline next."
```

---

### Task 2: Declare the verifier's tools

**Files:**
- Modify: `src/operations/verify.ts` (add `tools:` to `verifierOp`, after the `config:` line)
- Test: `test/unit/operations/op-tool-declarations.test.ts`

**Interfaces:**
- Consumes: `REQUIRED_TOOLS_BY_ROLE` from Task 1 (the gate that makes this required).
- Produces: `verifierOp.tools` = `["Read", "Glob", "Grep", "Git", "RunCommand"]`. Task 4's fixture run depends on `RunCommand` being present.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/op-tool-declarations.test.ts`:

```typescript
/**
 * Tool declarations for the TDD session ops.
 *
 * Asserted through resolveDeclaredTools rather than by reading `op.tools`
 * directly, so the test exercises the same path dispatch does -- an op that
 * omits the field resolves to DEFAULT_CODING_TOOLS, and reading the literal
 * would hide that.
 */

import { describe, expect, test } from "bun:test";
import { verifierOp } from "@/operations/verify";
import { resolveDeclaredTools } from "@/operations/types";

describe("verifierOp tools", () => {
  test("can run the story's scoped tests", () => {
    expect(resolveDeclaredTools(verifierOp)).toContain("RunCommand");
  });

  test("can diff against the pre-implementer ref to check test-file tampering", () => {
    expect(resolveDeclaredTools(verifierOp)).toContain("Git");
  });

  test("cannot repair what it is judging", () => {
    const tools = resolveDeclaredTools(verifierOp);

    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("GitCommit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/operations/op-tool-declarations.test.ts`
Expected: FAIL on the first two — the resolved set is `["Read","Glob","Grep"]`, so `RunCommand` and `Git` are absent. The third test PASSES already; it guards a property that must be preserved.

- [ ] **Step 3: Add the declaration**

In `src/operations/verify.ts`, inside `verifierOp`, immediately after the `config: tddConfigSelector,` line:

```typescript
  // Read + run, never write. `RunCommand` because the role's first instruction
  // is "Run ONLY the story's scoped test files"; `Git` because it must also
  // "check whether the implementer modified test files after the test-writer
  // phase", which is a diff against the `beforeRef` this op already receives.
  // Write/Edit/GitCommit are withheld deliberately: a verifier that can repair
  // what it judges is not a verifier, and its isolation check assumes it
  // changed nothing.
  tools: ["Read", "Glob", "Grep", "Git", "RunCommand"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/operations/op-tool-declarations.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/operations/verify.ts test/unit/operations/op-tool-declarations.test.ts
git commit -m "feat(verify): declare the verifier's tools

Its role says 'Run ONLY the story's scoped test files' and 'check whether the
implementer modified test files after the test-writer phase'. It could do
neither: with no declaration it resolved to the read-only default, so on native
it had no way to run a command or take a diff.

Write/Edit/GitCommit stay withheld. A verifier that can repair what it judges
is not a verifier."
```

---

### Task 3: Declare the test-writer's tools and shrink the baseline

**Files:**
- Modify: `src/operations/write-test.ts` (add `tools:` to `testWriterOp`)
- Modify: `scripts/baselines/op-tool-capability-baseline.json`
- Test: `test/unit/operations/op-tool-declarations.test.ts` (extend the file from Task 2)

**Interfaces:**
- Consumes: the test file and `resolveDeclaredTools` import from Task 2.
- Produces: `testWriterOp.tools` = `["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"]`, and a baseline of exactly seven ops. Task 4 depends on both declarations being live.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/op-tool-declarations.test.ts`:

```typescript
describe("testWriterOp tools", () => {
  test("can create test files and compile-only stubs", () => {
    const tools = resolveDeclaredTools(testWriterOp);

    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
  });

  test("can run the tests it wrote, to prove they fail on an assertion", () => {
    // The role requires distinguishing an ASSERTION failure from an import or
    // compile error. A test-writer that cannot execute cannot tell them apart.
    expect(resolveDeclaredTools(testWriterOp)).toContain("RunCommand");
  });

  test("can commit its own RED state so the implementer's beforeRef is a clean boundary", () => {
    expect(resolveDeclaredTools(testWriterOp)).toContain("GitCommit");
  });
});
```

Add `testWriterOp` to the existing import at the top of the file:

```typescript
import { testWriterOp } from "@/operations/write-test";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/operations/op-tool-declarations.test.ts`
Expected: FAIL on all three new tests — resolved set is `["Read","Glob","Grep"]`.

- [ ] **Step 3: Add the declaration**

In `src/operations/write-test.ts`, inside `testWriterOp`, immediately after its `config:` line:

```typescript
  // Write/Edit for test files and compile-only stubs. `RunCommand` because step
  // 6 of the role is "Run the new test files. Confirm tests compile AND fail
  // with ASSERTION failures" -- the one distinction the prompt insists on, and
  // one it cannot make without executing. `GitCommit` so the session commits its
  // own RED state, which makes the implementer's `beforeRef` a committed
  // test-only tree rather than whatever an auto-commit happened to sweep up.
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/operations/op-tool-declarations.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Lower the baseline and confirm it holds exactly seven ops**

Run:
```bash
bun scripts/check-op-tool-capability.ts --update-baseline
cat scripts/baselines/op-tool-capability-baseline.json
```
Expected `ops` array, exactly: `acceptance-fix-source`, `acceptance-fix-test`, `autofix-implementer`, `autofix-test-writer`, `finish-fix`, `full-suite-rectify`, `rectify`. If `verifier` or `test-writer` still appears, Task 2 or Step 3 above did not take effect — stop and fix rather than accepting the baseline.

- [ ] **Step 6: Run the full gate suite**

Run: `bun run lint && bun run typecheck`
Expected: both exit 0, and the lint output ends with `OK: 28 run op(s) checked, 7 grandfathered.`

- [ ] **Step 7: Commit**

```bash
git add src/operations/write-test.ts scripts/baselines/op-tool-capability-baseline.json test/unit/operations/op-tool-declarations.test.ts
git commit -m "feat(write-test): declare the test-writer's tools

Write/Edit to create tests and stubs, RunCommand because the role must confirm
its tests fail on an ASSERTION rather than an import error -- a distinction it
cannot make without executing -- and GitCommit so the RED state is committed,
making the implementer's beforeRef a clean test-only boundary.

Baseline drops from nine to seven."
```

---

### Task 4: Prove it end to end on a native three-session run

This task produces evidence, not code. Its deliverable is a results document; the only repository change is the fixture prerequisite.

**Files:**
- Modify (in the `nax-context-dogfood` repo): `fixtures/tdd-calc/.nax/config.json`
- Create: `docs/superpowers/specs/2026-09-03-native-tdd-run-results.md`

**Interfaces:**
- Consumes: `verifierOp.tools` (Task 2) and `testWriterOp.tools` (Task 3).
- Produces: a results document recording per-role tool-audit ledger counts.

- [ ] **Step 1: Add the missing scoped-test command to the fixture**

`tdd-calc` declares only `test`/`typecheck`/`lint`, none carrying `{{files}}`, so neither role can run a *scoped* set. In the dogfood repo, in `fixtures/tdd-calc/.nax/config.json`, add to `quality.commands`:

```json
"testScoped": "bun test {{files}}"
```

- [ ] **Step 2: Pin all three TDD roles to the native agent**

In the same file, add:

```json
"tdd": {
  "enabled": true,
  "isolationCheck": true,
  "sessionTiers": {
    "testWriter": { "agent": "native", "model": "fast" },
    "implementer": { "agent": "native", "model": "fast" },
    "verifier": { "agent": "native", "model": "fast" }
  }
},
"models": { "native": { "fast": "openrouter/deepseek/deepseek-v4-flash" } }
```

and set `agent.protocol` to `"hybrid"`. Give the fixture a distinct `name` (e.g. `nax-tdd-calc-native`) — a name already claimed by another checkout aborts the run before any code under test executes.

- [ ] **Step 3: Run the fixture from the local build**

Run, from a git worktree of the dogfood repo (runs auto-commit, so arms cannot share a tree):

```bash
cd <worktree>/fixtures/tdd-calc && bun install
bun run <nax-repo>/bin/nax.ts run -f tdd-calc --headless
```

Do **not** use the globally installed `nax`: it predates the tool-audit ledger (`grep -c tool-audit` on its bundle returns 0), so the evidence this task depends on would not exist.

- [ ] **Step 4: Read the ledger, not the verdict**

Run:
```bash
python3 - <<'PY'
import json, glob, collections
import os
for f in sorted(glob.glob(os.path.expanduser("~/.nax/nax-tdd-calc-native/tool-audit/tdd-calc/*.json"))):
    d = json.load(open(f))
    c = collections.Counter((x["tool"], x["outcome"]) for x in d["calls"])
    print(f.split("/")[-1], d["sessionName"], dict(c))
PY
```

Record, per session: `RunCommand` rows for the verifier; `Write`/`Edit` rows for the test-writer; `GitCommit` rows; and `RequestCapability` rows across all three.

ADR-029's first caution governs how this is read: a parity claim must confirm from the run record that tools were *invoked*, never that they were configured. The C1 A/B measured a capability that was not connected, and only the ledger caught it.

- [ ] **Step 5: Write the results document**

Create `docs/superpowers/specs/2026-09-03-native-tdd-run-results.md` recording: whether the story completed; per-role ledger counts; whether the verifier ran `testScoped` or reached for the full `test` suite (the section 5 limitation, observable here); and the `RequestCapability` count, which is the ADR-029 section 3 trigger.

State explicitly what the run does **not** show: `tdd-calc`'s acceptance criteria are pinned to exact strings, which flatters a weak test-writer, so passing is a floor rather than evidence of parity. A `RequestCapability` count of zero is the weakest row in the ledger and must not be reported as "nothing was needed".

If the verifier still fails as it did in Phase B, say so plainly — that retires this design's central claim, and is worth the run either way.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-native-tdd-run-results.md
git commit -m "docs: results of the first full native three-session TDD run"
```

---

### Task 5: Record the ADR-029 section 2 override

**Files:**
- Modify: `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` (append to the "Parity status" subsection of section 2)

**Interfaces:**
- Consumes: the measured outcome from Task 4's results document.
- Produces: no code. Closes the arc.

- [ ] **Step 1: Append the override paragraph**

In section 2, after the existing "Entry condition disposition" paragraph, add a subsection recording: that this work widened native implementation to a write-capable op (`test-writer`), which is what the condition guards; that it therefore needs a recorded override, unlike C2 which excluded the capability; the measured outcome from Task 4; and the limit — that the fixture's exact-string ACs make a passing run a floor rather than evidence of parity.

Cite the results document by path so the measurement travels with the claim.

- [ ] **Step 2: Verify the ADR still passes the doc gates**

Run: `bun run lint`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-029-phase-c-native-coding-agent-scope.md
git commit -m "docs(adr-029): record the section 2 override for native TDD ops

C2 proceeded without an override because it excluded the capability the entry
condition names. This work does not: it widens native implementation to a
write-capable op. Recorded so the gap between the rule and what happened is
written down rather than rediscovered."
```
