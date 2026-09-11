# Quality Command Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a declared quality command be a *list* of commands that all run and report every failure, instead of a single shell string whose `&&` chain hides every error after the first.

**Architecture:** `quality.commands.<name>` and `review.commands.<name>` widen from `z.string()` to `z.union([z.string(), z.array(z.string())])`. The single execution chokepoint `runQualityCommand` (`src/quality/runner.ts:98`, 9 call sites) accepts the widened type and, for a list, runs **every** entry regardless of exit code, then folds the results into one `QualityCommandResult`. All 9 call sites — the harness gates *and* the agent's `RunCommand` tool — inherit the behaviour with no change. A config-load warning flags existing `&&` strings and names the list form.

**Tech Stack:** TypeScript, Bun (`bun:test`), Zod v4.

**Spec:** GitHub issue [nathapp-io/nax#1990](https://github.com/nathapp-io/nax/issues/1990), specifically [this comment](https://github.com/nathapp-io/nax/issues/1990#issuecomment-5632617332) which establishes the mechanism and the root cause. Read both before starting.

## Global Constraints

- **This is a project-agnostic harness fix.** The defect is nax's config surface, not nax's own `package.json`. Do not "fix" the repo's scripts as a substitute — that is Task 7, explicitly last, and it is dogfooding rather than the fix.
- **Strictly additive.** Every existing string-valued command must keep working byte-for-byte. A string stays a single spawn with identical semantics.
- **Do not change the declared key set.** `quality.commands` relies on Zod stripping unknown keys, and that strip is intended behaviour. Widen value types only; never add, rename, or remove a key.
- **Aggregation means run-all.** A list runs every entry even after one fails. That is the entire point — short-circuiting is the bug.
- **Per-entry timeout.** Each list entry gets the full `timeoutMs` (default `120_000`), matching today's per-command semantics. Do not divide a shared budget.
- **File size gate is active.** `bun run check:file-sizes` blocks growth past the repo's ceiling; keep new logic in new files where a target file is already large.
- **Error handling:** use `NaxError` per `.nax/rules/error-handling.md`; a plain `Error` requires a `// nax-lint-allow: plain-error` marker.
- Commands: test `bun run test`, scoped `CI=1 AGENT=1 bun test --timeout=60000 <files>`, typecheck `bun run typecheck`, lint `bun run check:all`.

### Import rules for this change — read before writing any import

Two gates constrain where `command-spec` may be imported from, and they pull in opposite directions. Getting this wrong fails `bun run check:all` in a way that is easy to "fix" incorrectly.

- **`check:alias-internals`** (`scripts/check-alias-internals.ts`) forbids *value-level* `@/<dir>/<internal>` imports when `src/<dir>/index.ts` exists — and `src/quality/index.ts` does. Two exemptions apply and are load-bearing here: **test files are exempt** for any `@/…` specifier (`:236`), and **type-only imports are exempt** (`:235`).
- **`check:import-cycles`** is the opposing constraint. `src/quality/index.ts` (the barrel) re-exports `self-verification.ts`, which imports `../config`. So a `src/config/*` file that imports the **barrel** `@/quality` closes a `config → quality → config` loop. Importing the **leaf** `../quality/command-spec` does not, because `command-spec.ts` imports nothing at all.

The resulting rule, which every task below follows:

| Importer | Import as | Why |
|---|---|---|
| Test files | `@/quality/command-spec` | Tests are exempt from the alias gate |
| Inside `src/quality/` | `./command-spec` | Same directory, relative |
| `src/tools/`, `src/agents/` — **type only** | `import type { QualityCommandSpec } from "@/quality"` | Type-only imports are exempt and erased |
| `src/config/`, `src/context/` — **value** | `../quality/command-spec` (relative leaf) | Avoids the barrel, so no import cycle; a relative path is not an `@/` alias so the encapsulation gate does not fire |

**Do not "tidy" a relative leaf import into `@/quality`.** It will pass the alias gate and fail the cycle gate. The comment in each such file must say so.

## File Structure

| File | Responsibility |
|---|---|
| `src/quality/command-spec.ts` | **new** — `QualityCommandSpec` type, `normalizeCommandSpec()`, `containsShellChain()`. The single place that knows a spec can be a list. |
| `src/quality/runner.ts` | Widen `QualityCommandOptions.command`; add the run-all fold. Existing single-command spawn logic is untouched and becomes the inner step. |
| `src/quality/aggregate.ts` | **new** — `aggregateResults()`: folds `QualityCommandResult[]` into one. Pure, trivially testable, keeps `runner.ts` from growing. Used only by `runner.ts`, so it is deliberately **not** exported from the barrel. |
| `src/quality/index.ts` | Barrel — must re-export the new `command-spec` symbols, following the existing `export type { … }` / `export { … }` split. |
| `src/config/schemas-execution.ts:276-310` | Widen `QualityConfigSchema.commands` value types. |
| `src/config/schemas-review.ts:208-218` | Widen `ReviewConfigSchema.commands` value types. |
| `src/config/merge.ts:123-145` | Per-package `quality.commands` → `review.commands` bridge — widen the copied types. |
| `src/agents/coding-tool-support.ts:203-205` | `declaredCommands` map currently drops non-string values; must carry lists. |
| `src/tools/run-command.ts:222,259` | Template substitution must apply per list entry. |
| `src/config/config-warnings.ts` | **new** — the `&&` warning. |
| `src/context/injector.ts:243-244`, `src/quality/self-verification.ts:156-157` | Render a list into the string these prompt surfaces expect. |

---

### Task 1: `QualityCommandSpec` type and normaliser

**Files:**
- Create: `src/quality/command-spec.ts`
- Test: `test/unit/quality/command-spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type QualityCommandSpec = string | string[]`; `normalizeCommandSpec(spec: QualityCommandSpec | undefined): string[]` (returns `[]` for undefined/empty-after-trim, otherwise non-empty trimmed entries); `containsShellChain(spec: QualityCommandSpec | undefined): boolean` (true when any entry contains `&&`).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/quality/command-spec.test.ts
import { describe, expect, test } from "bun:test";
import { containsShellChain, normalizeCommandSpec } from "@/quality/command-spec";

describe("normalizeCommandSpec", () => {
  test("wraps a string into a single-entry list", () => {
    expect(normalizeCommandSpec("bun run lint")).toEqual(["bun run lint"]);
  });

  test("returns an empty list for undefined", () => {
    expect(normalizeCommandSpec(undefined)).toEqual([]);
  });

  test("returns an empty list for a whitespace-only string", () => {
    expect(normalizeCommandSpec("   ")).toEqual([]);
  });

  test("passes a list through, trimming each entry", () => {
    expect(normalizeCommandSpec([" tsc --noEmit ", "tsc -p tsconfig.test.json"])).toEqual([
      "tsc --noEmit",
      "tsc -p tsconfig.test.json",
    ]);
  });

  test("drops blank entries from a list", () => {
    expect(normalizeCommandSpec(["tsc --noEmit", "  ", ""])).toEqual(["tsc --noEmit"]);
  });

  test("returns an empty list when every list entry is blank", () => {
    expect(normalizeCommandSpec(["  ", ""])).toEqual([]);
  });
});

describe("containsShellChain", () => {
  test("detects && in a string spec", () => {
    expect(containsShellChain("tsc --noEmit && tsc -p tsconfig.test.json")).toBe(true);
  });

  test("detects && in any list entry", () => {
    expect(containsShellChain(["tsc --noEmit", "biome check && echo done"])).toBe(true);
  });

  test("is false for a clean string", () => {
    expect(containsShellChain("bun run lint")).toBe(false);
  });

  test("is false for a clean list", () => {
    expect(containsShellChain(["tsc --noEmit", "tsc -p tsconfig.test.json"])).toBe(false);
  });

  test("is false for undefined", () => {
    expect(containsShellChain(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/command-spec.test.ts`
Expected: FAIL — `Cannot find module '@/quality/command-spec'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/quality/command-spec.ts
/**
 * A declared quality command. A plain string is one shell command (the
 * historical shape). A list means "run every entry, report every failure" —
 * the form that exists because `a && b` short-circuits, hiding each failure
 * after the first from an agent that pays a full round trip per invocation
 * (nax#1990).
 */
export type QualityCommandSpec = string | string[];

/**
 * Flatten a spec to the list of commands to actually run. Blank entries are
 * dropped so a stray "" in a list cannot spawn an empty shell; a spec that is
 * entirely blank returns [], which callers treat as "not declared".
 */
export function normalizeCommandSpec(spec: QualityCommandSpec | undefined): string[] {
  if (spec === undefined) return [];
  const entries = typeof spec === "string" ? [spec] : spec;
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * True when any entry chains with `&&`. Used only to warn: a chain still runs
 * exactly as it always did, it just hides later failures.
 */
export function containsShellChain(spec: QualityCommandSpec | undefined): boolean {
  return normalizeCommandSpec(spec).some((entry) => entry.includes("&&"));
}
```

- [ ] **Step 4: Export from the quality barrel**

`src/quality/index.ts` is the module's public API and external value-importers need these. Follow the file's existing type/value split exactly:

```ts
export type { QualityCommandSpec } from "./command-spec";
export { containsShellChain, normalizeCommandSpec, renderCommandSpec } from "./command-spec";
```

(`renderCommandSpec` arrives in Task 6 — add it to this export line then, not now, or the build breaks.)

- [ ] **Step 5: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/command-spec.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add src/quality/command-spec.ts src/quality/index.ts test/unit/quality/command-spec.test.ts
git commit -m "feat(quality): add QualityCommandSpec type and normaliser"
```

---

### Task 2: Result aggregation

**Files:**
- Create: `src/quality/aggregate.ts`
- Test: `test/unit/quality/aggregate.test.ts`

**Interfaces:**
- Consumes: `QualityCommandResult` from `src/quality/runner.ts:56-64`.
- Produces: `aggregateResults(commandName: string, results: QualityCommandResult[]): QualityCommandResult`.

Fold semantics — these are the contract, get them exactly right:
- `success` — true only if **every** step succeeded.
- `exitCode` — the first non-zero exit code, else `0`.
- `output` — every step's output, each preceded by `\n=== <command> (exit <n>) ===\n`, joined in order. Every step appears, including passing ones, so the agent sees the whole picture in one read.
- `durationMs` — sum of all steps.
- `timedOut` — true if **any** step timed out.
- `command` — entries joined with `" && "` **for display only** (it is what a human recognises); the actual execution did not short-circuit.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/quality/aggregate.test.ts
import { describe, expect, test } from "bun:test";
import { aggregateResults } from "@/quality/aggregate";
import type { QualityCommandResult } from "@/quality/runner";

function result(over: Partial<QualityCommandResult>): QualityCommandResult {
  return {
    commandName: "typecheck",
    command: "tsc --noEmit",
    success: true,
    exitCode: 0,
    output: "",
    durationMs: 10,
    timedOut: false,
    ...over,
  };
}

describe("aggregateResults", () => {
  test("succeeds only when every step succeeded", () => {
    const agg = aggregateResults("typecheck", [result({}), result({ command: "tsc -p b" })]);
    expect(agg.success).toBe(true);
    expect(agg.exitCode).toBe(0);
  });

  test("fails when any step failed", () => {
    const agg = aggregateResults("typecheck", [
      result({}),
      result({ command: "tsc -p b", success: false, exitCode: 2 }),
    ]);
    expect(agg.success).toBe(false);
  });

  test("reports the first non-zero exit code", () => {
    const agg = aggregateResults("typecheck", [
      result({ success: false, exitCode: 2 }),
      result({ command: "tsc -p b", success: false, exitCode: 5 }),
    ]);
    expect(agg.exitCode).toBe(2);
  });

  test("includes output from every step, failing and passing alike", () => {
    const agg = aggregateResults("typecheck", [
      result({ command: "tsc --noEmit", success: false, exitCode: 2, output: "src error" }),
      result({ command: "tsc -p tsconfig.test.json", output: "clean" }),
    ]);
    expect(agg.output).toContain("src error");
    expect(agg.output).toContain("clean");
    expect(agg.output).toContain("=== tsc --noEmit (exit 2) ===");
    expect(agg.output).toContain("=== tsc -p tsconfig.test.json (exit 0) ===");
  });

  test("does not stop at the first failure — later output is present", () => {
    const agg = aggregateResults("lint", [
      result({ command: "a", success: false, exitCode: 1, output: "first failure" }),
      result({ command: "b", success: false, exitCode: 1, output: "second failure" }),
    ]);
    expect(agg.output).toContain("first failure");
    expect(agg.output).toContain("second failure");
  });

  test("sums durations", () => {
    const agg = aggregateResults("typecheck", [result({ durationMs: 10 }), result({ durationMs: 32 })]);
    expect(agg.durationMs).toBe(42);
  });

  test("is timedOut when any step timed out", () => {
    const agg = aggregateResults("test", [result({}), result({ timedOut: true, success: false, exitCode: -1 })]);
    expect(agg.timedOut).toBe(true);
  });

  test("joins commands for display", () => {
    const agg = aggregateResults("typecheck", [result({ command: "a" }), result({ command: "b" })]);
    expect(agg.command).toBe("a && b");
  });

  test("preserves the command name", () => {
    expect(aggregateResults("lint", [result({})]).commandName).toBe("lint");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/aggregate.test.ts`
Expected: FAIL — `Cannot find module '@/quality/aggregate'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/quality/aggregate.ts
import type { QualityCommandResult } from "./runner";

/**
 * Fold per-step results into one. Every step's output is included — including
 * the steps that passed — because the caller ran the whole list precisely so
 * that one read shows the full picture (nax#1990).
 */
export function aggregateResults(commandName: string, results: QualityCommandResult[]): QualityCommandResult {
  const firstFailure = results.find((r) => r.exitCode !== 0);
  return {
    commandName,
    command: results.map((r) => r.command).join(" && "),
    success: results.every((r) => r.success),
    exitCode: firstFailure?.exitCode ?? 0,
    output: results.map((r) => `\n=== ${r.command} (exit ${r.exitCode}) ===\n${r.output}`).join(""),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    timedOut: results.some((r) => r.timedOut),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/aggregate.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/quality/aggregate.ts test/unit/quality/aggregate.test.ts
git commit -m "feat(quality): add result aggregation for multi-step commands"
```

---

### Task 3: `runQualityCommand` runs a list

**Files:**
- Modify: `src/quality/runner.ts:25-54` (options type), `src/quality/runner.ts:98-120` (entry point)
- Test: `test/unit/quality/runner-multi-command.test.ts`

**Interfaces:**
- Consumes: `normalizeCommandSpec` (Task 1), `aggregateResults` (Task 2).
- Produces: `QualityCommandOptions.command: QualityCommandSpec`. All 9 existing call sites keep compiling unchanged because `string` is assignable to `QualityCommandSpec`.

Rename the existing single-command body to `runSingleCommand(opts & { command: string })` and make `runQualityCommand` the dispatcher. **Do not change the spawn, timeout, drain, or logging logic** — move it verbatim.

Empty-spec guard: today `if (!command || command.trim() === "")` returns a synthetic failure. Preserve that exactly for a spec that normalises to `[]`, so an empty list behaves like an empty string.

- [ ] **Step 1: Write the failing test**

> **Use the repo's `makeSpawn` helper — do not hand-roll a stub.** `runQualityCommand` calls `_qualityRunnerDeps.spawn` with the **object** form (`spawn({ cmd: ["/bin/sh", "-c", command], cwd, … })`, `runner.ts:145`), not positional args. `makeSpawn` (`test/helpers/spawn.ts`, exported from `@test/helpers`) normalises both shapes, records every call as `{ cmd, opts }`, and builds a complete fake proc (`stdout`/`stderr` streams, `exited`, `pid`, `killed`). The shell command is `cmd[2]`.

```ts
// test/unit/quality/runner-multi-command.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

const realSpawn = _qualityRunnerDeps.spawn;
afterEach(() => {
  _qualityRunnerDeps.spawn = realSpawn;
});

/** Script each shell command's exit code; returns the stub for call assertions. */
function stubSpawn(exitCodeFor: (command: string) => number) {
  const stub = makeSpawn(({ cmd }) => {
    const command = cmd[2] ?? "";
    return { exitCode: exitCodeFor(command), stdout: `output of ${command}` };
  });
  _qualityRunnerDeps.spawn = stub.spawn;
  return stub;
}

/** The shell command of each recorded spawn, in order. */
function commandsRun(stub: ReturnType<typeof stubSpawn>): string[] {
  return stub.calls.map((call) => call.cmd[2] ?? "");
}

describe("runQualityCommand with a list", () => {
  test("runs every entry even after one fails", async () => {
    const stub = stubSpawn((c) => (c === "step-a" ? 1 : 0));
    await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b", "step-c"],
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["step-a", "step-b", "step-c"]);
  });

  test("aggregates failure across entries", async () => {
    stubSpawn((c) => (c === "step-b" ? 2 : 0));
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  test("carries output from every entry", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.output).toContain("output of step-a");
    expect(result.output).toContain("output of step-b");
  });

  test("succeeds when every entry succeeds", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a plain string still spawns exactly once", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: "only-one",
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["only-one"]);
    expect(result.command).toBe("only-one");
  });

  test("an empty list is treated as an undeclared command", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({ commandName: "build", command: [], workdir: "/tmp" });
    expect(stub.calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/runner-multi-command.test.ts`
Expected: FAIL — a list is not assignable to `command: string`, and an array reaches the spawn as `"step-a,step-b"`.

- [ ] **Step 3: Write minimal implementation**

In `src/quality/runner.ts`, add the import and widen the option:

```ts
import { aggregateResults } from "./aggregate";
import { type QualityCommandSpec, normalizeCommandSpec } from "./command-spec";
```

```ts
export interface QualityCommandOptions {
  /** Short name used in logs (e.g. "lint", "typecheck", "lintFix"). */
  commandName: string;
  /**
   * The command to run. A string is one shell command. A list runs every
   * entry — even after one fails — and aggregates the results, so a
   * multi-step gate reports all its failures in one invocation (nax#1990).
   */
  command: QualityCommandSpec;
  // ...rest unchanged
}
```

Rename the current exported function to a private single-step runner, typed to a plain string, keeping its body exactly as-is:

```ts
async function runSingleCommand(
  opts: Omit<QualityCommandOptions, "command"> & { command: string },
): Promise<QualityCommandResult> {
  // ...the entire existing body of runQualityCommand, unchanged...
}
```

Then add the new dispatcher in its place:

```ts
export async function runQualityCommand(opts: QualityCommandOptions): Promise<QualityCommandResult> {
  const steps = normalizeCommandSpec(opts.command);

  if (steps.length === 0) {
    return {
      commandName: opts.commandName,
      command: typeof opts.command === "string" ? opts.command : "",
      success: false,
      exitCode: -1,
      output: `[nax] ${opts.commandName} skipped: empty command`,
      durationMs: 0,
      timedOut: false,
    };
  }

  if (steps.length === 1 && steps[0] !== undefined) {
    return await runSingleCommand({ ...opts, command: steps[0] });
  }

  const results: QualityCommandResult[] = [];
  for (const step of steps) {
    // Sequential and unconditional: the whole point is that a failing step
    // does not stop the ones after it (nax#1990). Sequential rather than
    // parallel because these share a working directory and a build cache.
    results.push(await runSingleCommand({ ...opts, command: step }));
  }
  return aggregateResults(opts.commandName, results);
}
```

Leave the original empty-command guard inside `runSingleCommand` exactly where it is. It becomes unreachable via the dispatcher but costs nothing, and removing it risks the existing contract below.

**Existing contract this must not break** — `test/unit/quality/runner-empty-command.test.ts` (which imports from the `@/quality` barrel, not the leaf) asserts that `command: ""` and `command: "   "` both yield `success: false`, `exitCode: -1`, and an output containing `"empty command"`. The dispatcher's early return above satisfies all three; verify in Step 5 rather than assuming.

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/runner-multi-command.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Verify no existing caller regressed**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/`
Expected: PASS — `runner.test.ts`, `runner-empty-command.test.ts`, `runner-env-strip.test.ts`, `runner-origin.test.ts` all still green.

- [ ] **Step 6: Commit**

```bash
git add src/quality/runner.ts test/unit/quality/runner-multi-command.test.ts
git commit -m "feat(quality): run every entry of a list-valued quality command"
```

---

### Task 4: Widen the config schemas

**Files:**
- Modify: `src/config/schemas-execution.ts:278-310` (`QualityConfigSchema.commands`)
- Modify: `src/config/schemas-review.ts:208-218` (`ReviewConfigSchema.commands`)
- Modify: `src/config/merge.ts:123-145` (per-package bridge)
- Test: `test/unit/config/quality-command-list.test.ts`

**Interfaces:**
- Consumes: `QualityCommandSpec` (Task 1).
- Produces: both schemas accept `string | string[]` for every command key. Key names are unchanged.

Define the value schema once so the two files cannot drift:

```ts
// in src/config/schemas-execution.ts, exported
export const QualityCommandSpecSchema = z.union([z.string(), z.array(z.string()).min(1)]);
```

`.min(1)` rejects `[]` at config load — an empty list is a config mistake, distinct from omitting the key.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config/quality-command-list.test.ts
import { describe, expect, test } from "bun:test";
import { QualityConfigSchema } from "@/config/schemas-execution";
import { ReviewConfigSchema } from "@/config/schemas-review";

describe("quality.commands accepts a list", () => {
  test("accepts a string (unchanged)", () => {
    const parsed = QualityConfigSchema.parse({ commands: { typecheck: "tsc --noEmit" } });
    expect(parsed.commands.typecheck).toBe("tsc --noEmit");
  });

  test("accepts a list", () => {
    const parsed = QualityConfigSchema.parse({
      commands: { typecheck: ["tsc --noEmit", "tsc --noEmit -p tsconfig.test.json"] },
    });
    expect(parsed.commands.typecheck).toEqual(["tsc --noEmit", "tsc --noEmit -p tsconfig.test.json"]);
  });

  test("rejects an empty list", () => {
    expect(() => QualityConfigSchema.parse({ commands: { typecheck: [] } })).toThrow();
  });

  test("rejects a list of non-strings", () => {
    expect(() => QualityConfigSchema.parse({ commands: { typecheck: [1, 2] } })).toThrow();
  });

  test("still strips unknown command keys", () => {
    const parsed = QualityConfigSchema.parse({ commands: { typecheck: "tsc", nonsense: "x" } });
    expect("nonsense" in parsed.commands).toBe(false);
  });
});

describe("review.commands accepts a list", () => {
  test("accepts a list", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: ["typecheck"],
      commands: { typecheck: ["tsc --noEmit", "tsc -p tsconfig.test.json"] },
    });
    expect(parsed.commands.typecheck).toEqual(["tsc --noEmit", "tsc -p tsconfig.test.json"]);
  });

  test("accepts a string (unchanged)", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: ["lint"],
      commands: { lint: "bun run lint" },
    });
    expect(parsed.commands.lint).toBe("bun run lint");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/config/quality-command-list.test.ts`
Expected: FAIL — list values rejected by `z.string()`.

- [ ] **Step 3: Write minimal implementation**

In `src/config/schemas-execution.ts`, above `QualityConfigSchema`:

```ts
/**
 * A declared quality command: one shell string, or a list that all runs with
 * every failure reported. The list form exists because `a && b`
 * short-circuits, hiding each failure after the first from an agent that pays
 * a full round trip per invocation (nax#1990). `.min(1)` rejects `[]`, which
 * is a config mistake rather than "no command declared".
 */
export const QualityCommandSpecSchema = z.union([z.string(), z.array(z.string()).min(1)]);
```

Replace every `z.string().optional()` inside `QualityConfigSchema.commands` with the shared schema. That object has exactly **12** keys — `typecheck`, `lint`, `lintScoped`, `test`, `testScoped`, `lintFix`, `lintFixScoped`, `formatFix`, `formatFixScoped`, `build`, `coverage`, `setup`. Widen all 12; the JSDoc on `coverage` and `setup` stays untouched. (The last key is `setup`, the one-time package init — there is no `install` key in this object; `install` is a separate top-level config section.) The object's trailing `.default({})` is unchanged and is what lets the Step 1 tests parse a bare `{ commands: … }`.

```ts
      typecheck: QualityCommandSpecSchema.optional(),
```

Do the same for all nine keys in `ReviewConfigSchema.commands` (`src/config/schemas-review.ts:209-217`), importing `QualityCommandSpecSchema` from `./schemas-execution`.

In `src/config/merge.ts:123-145`, the bridge copies values verbatim (`lint: packageOverride.quality.commands.lint` and siblings) — no logic change is needed, but confirm it typechecks with the widened type and does not narrow to `string` anywhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/config/quality-command-list.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck both projects**

Run: `bun run typecheck`
Expected: exit 0. If a consumer breaks on the widened type, that consumer is Task 6 — note it, do not fix it here.

- [ ] **Step 6: Commit**

```bash
git add src/config/schemas-execution.ts src/config/schemas-review.ts src/config/merge.ts test/unit/config/quality-command-list.test.ts
git commit -m "feat(config): accept a list for every declared quality command"
```

---

### Task 5: Agent `RunCommand` tool carries lists

**Files:**
- Modify: `src/agents/coding-tool-support.ts:203-205` (`declaredCommands` map)
- Modify: `src/tools/run-command.ts:222,259` (template substitution per entry)
- Test: `test/unit/tools/run-command-list.test.ts`

**Interfaces:**
- Consumes: `QualityCommandSpec`, `normalizeCommandSpec` (Task 1); `runQualityCommand` (Task 3).
- Produces: `declaredCommands: Map<string, QualityCommandSpec>`.

This is the path that produced the 13 serial `typecheck` invocations in the issue. Two defects to fix:

1. `coding-tool-support.ts:203-205` filters on `typeof e[1] === "string"`, so a list-valued command is **silently dropped** and the agent is told the key is not permitted.
2. `run-command.ts:259` calls `substituteCommand(template, values)` on a single string; placeholders like `{{files}}` must be substituted into **each** entry.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tools/run-command-list.test.ts
import { describe, expect, test } from "bun:test";
import { substituteCommandSpec } from "@/tools/run-command";

describe("substituteCommandSpec", () => {
  test("substitutes into a string spec", () => {
    expect(substituteCommandSpec("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test a.test.ts");
  });

  test("substitutes into every entry of a list spec", () => {
    expect(substituteCommandSpec(["tsc --noEmit", "bun test {{files}}"], { files: "a.test.ts" })).toEqual([
      "tsc --noEmit",
      "bun test a.test.ts",
    ]);
  });

  test("propagates an error from any entry", () => {
    const out = substituteCommandSpec(["ok", "echo '{{files}}'"], { files: "a.ts" });
    expect(typeof out).toBe("object");
    expect(out).toHaveProperty("error");
  });

  test("leaves a list without placeholders untouched", () => {
    expect(substituteCommandSpec(["tsc --noEmit", "tsc -p tsconfig.test.json"], {})).toEqual([
      "tsc --noEmit",
      "tsc -p tsconfig.test.json",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/tools/run-command-list.test.ts`
Expected: FAIL — `substituteCommandSpec` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/run-command.ts`, alongside the existing `substituteCommand` (leave it exactly as it is — other callers and its own tests depend on it):

```ts
import { type QualityCommandSpec } from "@/quality/command-spec";

/**
 * Apply placeholder substitution across a spec. A list substitutes into every
 * entry and fails as a whole if any entry fails, so a partially-substituted
 * list can never reach the shell.
 */
export function substituteCommandSpec(
  spec: QualityCommandSpec,
  values: Record<string, string>,
): QualityCommandSpec | { error: string } {
  if (typeof spec === "string") return substituteCommand(spec, values);
  const out: string[] = [];
  for (const entry of spec) {
    const substituted = substituteCommand(entry, values);
    if (typeof substituted !== "string") return substituted;
    out.push(substituted);
  }
  return out;
}
```

At `run-command.ts:259`, swap the call:

```ts
      const command = substituteCommandSpec(template, values);
      if (typeof command !== "string" && !Array.isArray(command)) return { content: command.error, isError: true };
```

`runQualityCommand` at `:262` already accepts the widened type from Task 3 — pass `command` through unchanged.

In `src/agents/coding-tool-support.ts:203-205`, stop dropping lists:

```ts
  const declaredCommands = new Map(
    Object.entries(commands).filter((e): e is [string, QualityCommandSpec] =>
      typeof e[1] === "string" || Array.isArray(e[1]),
    ),
  );
```

Also widen the local type at `:185`:

```ts
        quality?: { commands?: Partial<Record<string, QualityCommandSpec>>; stripEnvVars?: unknown };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/tools/run-command-list.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify the tool suite still passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/tools/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/run-command.ts src/agents/coding-tool-support.ts test/unit/tools/run-command-list.test.ts
git commit -m "feat(tools): let RunCommand resolve and run list-valued quality commands"
```

---

### Task 6: String-rendering consumers

**Files:**
- Modify: `src/context/injector.ts:243-244`
- Modify: `src/quality/self-verification.ts:156-157`
- Test: `test/unit/quality/self-verification.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `normalizeCommandSpec` (Task 1).
- Produces: no new exports — these sites render a spec into the single string their prompt surfaces expect.

Both sites pass a command into prompt text as a `string`. With a list they would render `"a,b"`. Render deliberately instead: join with `" && "`, which is what a human reader recognises and what they would type by hand.

- [ ] **Step 1: Write the failing test**

The function owning `self-verification.ts:156-157` is `resolveSelfVerificationPromptInput(config, packageDir)` — **async**, two arguments, exported from the `@/quality` barrel. It also calls `detectLanguage(packageDir)`, so pass a real directory.

Append to `test/unit/quality/self-verification.test.ts`:

```ts
describe("resolveSelfVerificationPromptInput with list-valued commands", () => {
  test("renders a list-valued typecheck command as a joined string", async () => {
    const config = {
      quality: {
        commands: { typecheck: ["tsc --noEmit", "tsc -p tsconfig.test.json"], lint: "bun run lint" },
      },
    } as never;

    const input = await resolveSelfVerificationPromptInput(config, process.cwd());

    expect(input.typecheckCommand).toBe("tsc --noEmit && tsc -p tsconfig.test.json");
    expect(input.lintCommand).toBe("bun run lint");
  });

  test("leaves an undeclared command undefined", async () => {
    const config = { quality: { commands: {} } } as never;
    const input = await resolveSelfVerificationPromptInput(config, process.cwd());
    expect(input.typecheckCommand).toBeUndefined();
  });
});
```

Add `resolveSelfVerificationPromptInput` to the file's existing import from `@/quality` if it is not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/self-verification.test.ts`
Expected: FAIL — receives `"tsc --noEmit,tsc -p tsconfig.test.json"`.

- [ ] **Step 3: Write minimal implementation**

Add a shared helper to `src/quality/command-spec.ts`:

```ts
/**
 * Render a spec as the single string that prompt and context surfaces show a
 * reader. `" && "` is what a human recognises and would type, even though a
 * list does not actually short-circuit when it runs.
 */
export function renderCommandSpec(spec: QualityCommandSpec | undefined): string | undefined {
  const steps = normalizeCommandSpec(spec);
  return steps.length === 0 ? undefined : steps.join(" && ");
}
```

Add it to the barrel export line created in Task 1 Step 4:

```ts
export { containsShellChain, normalizeCommandSpec, renderCommandSpec } from "./command-spec";
```

Then at `src/context/injector.ts:243-244` — note the **relative leaf** import, per the Import rules above:

```ts
// Leaf, not `@/quality`: the barrel re-exports self-verification.ts, which
// imports ../config, and routing this through it would close an import cycle.
// command-spec.ts imports nothing, so the leaf is safe. Do not "tidy" this.
import { renderCommandSpec } from "../quality/command-spec";
```

```ts
    lintCommand: renderCommandSpec(config.quality?.commands?.lint),
    typecheckCommand: renderCommandSpec(config.quality?.commands?.typecheck),
```

And at `src/quality/self-verification.ts:156-157` — same directory, so a plain relative import:

```ts
import { renderCommandSpec } from "./command-spec";
```

```ts
    lintCommand: renderCommandSpec(config.quality?.commands?.lint),
    typecheckCommand: renderCommandSpec(config.quality?.commands?.typecheck),
```

`SelfVerificationPromptInput.lintCommand` / `.typecheckCommand` are already `string | undefined`, and `renderCommandSpec` returns exactly that — so the interface needs no change. If typecheck disagrees, read the interface before editing it.

Add the `renderCommandSpec` unit tests to `test/unit/quality/command-spec.test.ts`:

```ts
describe("renderCommandSpec", () => {
  test("returns a string spec unchanged", () => {
    expect(renderCommandSpec("bun run lint")).toBe("bun run lint");
  });
  test("joins a list with ' && '", () => {
    expect(renderCommandSpec(["a", "b"])).toBe("a && b");
  });
  test("returns undefined for undefined", () => {
    expect(renderCommandSpec(undefined)).toBeUndefined();
  });
  test("returns undefined for an all-blank spec", () => {
    expect(renderCommandSpec(["  ", ""])).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/quality/ test/unit/context/`
Expected: PASS

- [ ] **Step 5: Full typecheck — this is the gate that finds any consumer missed**

Run: `bun run typecheck`
Expected: exit 0. Any remaining error names a site that still assumes `string`; fix it with `renderCommandSpec` (display) or `normalizeCommandSpec` (execution) as appropriate.

- [ ] **Step 6: Commit**

```bash
git add src/quality/command-spec.ts src/context/injector.ts src/quality/self-verification.ts test/unit/quality/
git commit -m "feat(quality): render list-valued commands for prompt surfaces"
```

---

### Task 7: Warn on `&&` in a declared command

**Files:**
- Create: `src/config/config-warnings.ts`
- Test: `test/unit/config/command-chain-warning.test.ts`

**Interfaces:**
- Consumes: `containsShellChain` (Task 1).
- Produces: `collectCommandChainWarnings(commands: Partial<Record<string, QualityCommandSpec>> | undefined): string[]`.

This is what reaches existing repos that never read a changelog. Emit one warning per offending key naming the list form.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config/command-chain-warning.test.ts
import { describe, expect, test } from "bun:test";
import { collectCommandChainWarnings } from "@/config/config-warnings";

describe("collectCommandChainWarnings", () => {
  test("warns for a string command containing &&", () => {
    const warnings = collectCommandChainWarnings({ typecheck: "tsc --noEmit && tsc -p tsconfig.test.json" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("typecheck");
    expect(warnings[0]).toContain("&&");
  });

  test("names the list form in the remedy", () => {
    const [warning] = collectCommandChainWarnings({ lint: "a && b" });
    expect(warning).toContain("list");
  });

  test("is silent for a clean string", () => {
    expect(collectCommandChainWarnings({ lint: "bun run lint" })).toEqual([]);
  });

  test("is silent for a list", () => {
    expect(collectCommandChainWarnings({ typecheck: ["tsc --noEmit", "tsc -p tsconfig.test.json"] })).toEqual([]);
  });

  test("warns once per offending key", () => {
    const warnings = collectCommandChainWarnings({ lint: "a && b", typecheck: "c && d", test: "clean" });
    expect(warnings).toHaveLength(2);
  });

  test("is silent for undefined", () => {
    expect(collectCommandChainWarnings(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/config/command-chain-warning.test.ts`
Expected: FAIL — `Cannot find module '@/config/config-warnings'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config/config-warnings.ts
// Leaf import, NOT `@/quality`. The quality barrel re-exports
// self-verification.ts, which imports ../config — routing this through the
// barrel closes a config -> quality -> config cycle that `check:import-cycles`
// rejects. command-spec.ts has zero imports, so the leaf is safe, and a
// relative path is not an `@/` alias so `check:alias-internals` does not fire.
// Do not "tidy" this into a barrel import.
import { type QualityCommandSpec, containsShellChain } from "../quality/command-spec";

/**
 * Warn about `&&`-chained quality commands. A chain short-circuits, so every
 * failure after the first is hidden — and an agent pays a full round trip on a
 * growing context to discover each one (nax#1990). The chain still runs
 * exactly as before; this only points at the list form.
 */
export function collectCommandChainWarnings(
  commands: Partial<Record<string, QualityCommandSpec>> | undefined,
): string[] {
  if (commands === undefined) return [];
  return Object.entries(commands)
    .filter(([, spec]) => containsShellChain(spec))
    .map(
      ([key]) =>
        `quality.commands.${key} chains with \`&&\`, so it stops at the first failing step and hides the rest. ` +
        `Declare it as a list instead — e.g. ["step one", "step two"] — to run every step and report every failure in one invocation.`,
    );
}
```

Wire it where config is loaded and validated, next to the existing guards in `src/config/config-guards.ts`, emitting through the same logger those guards use. Read that file first and follow its established reporting shape — do not invent a new warning channel.

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/config/command-chain-warning.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/config-warnings.ts test/unit/config/command-chain-warning.test.ts
git commit -m "feat(config): warn when a declared quality command chains with &&"
```

---

### Task 8: Full gates, docs, and dogfood

**Files:**
- Modify: `package.json` (`typecheck`, `lint` → list form in `.nax/config.json`)
- Modify: `.nax/config.json` (`quality.commands.typecheck`, `quality.commands.lint`)
- Modify: `docs/` — the configuration reference page describing `quality.commands`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

This is **dogfooding, not the fix**. It only lands after Tasks 1-7 are green, and it is not a substitute for any of them.

- [ ] **Step 1: Run the full suite**

Run: `bun run test`
Expected: all phases pass.

- [ ] **Step 2: Run the full quality gates**

Run: `bun run typecheck && bun run check:all`
Expected: exit 0. (Yes, this plan's own verification uses a `&&` chain — that is fine for a human running it once, and is exactly the shape the feature exists to spare an *agent*.)

- [ ] **Step 3: Convert this repo's own declared commands**

In `.nax/config.json`, replace:

```json
    "typecheck": "bun run typecheck",
    "lint": "bun run check:all",
```

with the list form that exposes both projects and the check suite separately:

```json
    "typecheck": ["bun x tsc --noEmit", "bun x tsc --noEmit -p tsconfig.test.json"],
    "lint": ["bun x biome check --error-on-warnings src/ bin/ test/ scripts/", "bun run check:all"],
```

- [ ] **Step 4: Verify the agent-facing path end to end**

Run: `bun run nax config` and confirm `quality.commands.typecheck` round-trips as a two-element list.

Then introduce a deliberate type error in a **test** file only (e.g. add `const x: number = "s";` to `test/unit/quality/aggregate.test.ts`) and confirm a single `typecheck` invocation reports it **even though `src/` is clean** — the exact case that took five invocations in the issue. Revert the deliberate error.

- [ ] **Step 5: Document the list form**

Add to the `quality.commands` section of the configuration reference: both accepted shapes, the run-all-and-aggregate semantics, that each entry gets the full timeout, and a worked example per ecosystem (TS/Python/Go/Rust) from the issue comment.

- [ ] **Step 6: Commit**

```bash
git add .nax/config.json docs/
git commit -m "chore: declare nax's own typecheck and lint as lists"
```

---

## Self-Review

**1. Spec coverage.** The spec (#1990 + comment) proposes four things. (1) widen the value type to a union → Task 4. (2) warn on `&&` → Task 7. (3) demote probe-build/spec-review blast-radius prediction to a follow-up → deliberately **out of scope** for this plan; it is a separate, heavier piece of work and the issue comment says so. (4) convert nax's own scripts → Task 8, explicitly last and labelled dogfooding. The execution semantics the spec implies but does not spell out (run-all, aggregate, per-entry timeout) are Tasks 1-3, and the two consumer paths that would otherwise silently drop lists are Tasks 5-6.

**2. Placeholder scan.** No TBDs. Every code step carries real code. One step still carries a read-first instruction — the existing guard-reporting shape in `config-guards.ts`, Task 7 Step 3 — because the warning must be emitted through whatever channel those guards already use rather than a new one. That is a bounded "match the neighbouring pattern" instruction, not "figure it out". The other read-first instruction in the first draft (the `self-verification.ts` export name) has since been resolved against the source; see the verification pass below.

**3. Type consistency.** `QualityCommandSpec` (Task 1) is the single type used by `QualityCommandOptions.command` (Task 3), both schemas via `QualityCommandSpecSchema` (Task 4), `declaredCommands` (Task 5), and `collectCommandChainWarnings` (Task 7). `normalizeCommandSpec` is used for execution, `renderCommandSpec` for display, `containsShellChain` for the warning — three distinct names, no overlap. `aggregateResults(commandName, results)` (Task 2) is called only from Task 3 with that exact signature. `substituteCommand` keeps its original signature; `substituteCommandSpec` is the new wrapper, so existing callers and tests are untouched.

**Risk to watch during execution:** Task 4 Step 5 (`bun run typecheck`) is the gate that reveals any consumer of `quality.commands` still assuming `string`. The grep in this plan found `injector.ts`, `self-verification.ts`, `merge.ts`, `config-guards.ts` and `coding-tool-support.ts`, but that was a grep, not a compile. Treat new errors there as expected work for Task 6, not as a surprise.

### Verification pass — corrections already applied

This plan was re-checked against the code after drafting. Five defects were found and fixed inline; they are listed so an executor knows these specific points are verified rather than assumed.

1. **`spawn` is called with an object, not positional args.** `runner.ts:145` uses `spawn({ cmd: ["/bin/sh", "-c", command], … })`. The original Task 3 test hand-rolled a stub reading `args[2]` from a positional array — it could never have matched. Now uses the repo's `makeSpawn` helper (`test/helpers/spawn.ts`), which normalises both shapes and records `{ cmd, opts }` per call.
2. **`buildSelfVerificationOptions` does not exist.** The real owner of `self-verification.ts:156-157` is `resolveSelfVerificationPromptInput(config, packageDir)` — async, two arguments, barrel-exported, and it calls `detectLanguage(packageDir)`. Task 6's test was rewritten against the real signature.
3. **The 12th command key is `setup`, not `install`.** `install` is a separate top-level config section (`{ allowScripts }`), not a command. Task 4 now lists all 12 keys explicitly.
4. **The barrel was never updated.** `src/quality/index.ts` is the module's public API; new symbols must be re-exported there following its existing type/value split. Added as Task 1 Step 4, with `renderCommandSpec` deferred to Task 6 so the build never references a symbol that does not yet exist.
5. **Barrel vs leaf imports are load-bearing, and the two gates disagree.** Importing `@/quality` from `src/config/*` closes a `config → quality → config` cycle via `self-verification.ts`; importing the zero-dependency leaf does not, and a relative path also sidesteps `check:alias-internals`. Documented in Global Constraints with a per-importer table, and repeated as an inline comment at both leaf-import sites — because the natural instinct is to "clean up" a relative import into an alias, which passes one gate and fails the other.

Two exemptions were confirmed in `scripts/check-alias-internals.ts` and the plan relies on both: **test files are exempt** for any `@/…` specifier (`:236`), and **type-only imports are exempt** (`:235`). This is why the test files may import `@/quality/command-spec` directly and why `src/tools/` and `src/agents/` may use `import type … from "@/quality"`.
