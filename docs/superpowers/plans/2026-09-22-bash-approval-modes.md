# Bash Approval Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bashApproval` mode axis (`raw` | `gated` | `escalate`) that changes how a model-authored bash command string is adjudicated, behind the single existing policy gate.

**Architecture:** The mode reaches `compileToolPolicy` as an option and the Bash branch dispatches on it. `gated` is today's path untouched. `raw` swaps `checkBashCommand` for a best-effort protected-path screen that allows anything the lexer cannot parse. `escalate` converts a Category-A denial into the existing `ask` verdict, which the already-wired deny-always `AskResolver` then refuses — producing `denied:ask` ledger rows. No new async provider chain; no change to `src/tools/bash.ts`.

**Tech Stack:** TypeScript, Bun, Zod (config schemas), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-22-bash-approval-modes-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Baseline commit:** `e25351557`. Every line number in this plan was verified there. If a cited line has moved, re-locate by the quoted text, never by line number alone.
- **Never run bare `bun test`.** Use `bun run test` (full suite), `bun run test:unit`, `bun run test:integration`. Single file: `bun run test:unit ./test/unit/path/file.test.ts` works because the script passes through to `bun test <dir-or-file>`.
- **`typecheck` is NOT in `check:all`** (nax#2115). Run `bun run typecheck` separately before every commit.
- **`src/` file-size gate is 600 lines**; test files 800. Current: `policy.ts` 583, `coding-tool-support.ts` 582, `policy-bash.ts` 265, `runtime.ts` 436, `permissions.ts` 295, `schemas-execution.ts` 489, `bash-deny-suite.test.ts` 214. **New logic lands in new files.**
- **`check:test-satellites` blocks any NEW ticket-named test file.** Its regex matches `US-\d+`, `nax#\d+`, `ADR-\d+`, `BUG-\d+`, `#\d{3,4}` in the **basename**. Never create `bash-modes-US-001.test.ts`. Add cases to existing files, or use a concern name like `policy-bash-raw.test.ts`.
- **`check:permission-mode-ssot`** forbids `src/` from open-coding permission-mode strings outside `src/config/permissions.ts`. Its doctrine: every permission decision belongs to `resolvePermissions()`. The opt-out is an inline `// nax-permission-mode-allow: <reason>` marker.
- **`src/tools/bash.ts` must never gain a check of its own** (single-gate rule, `bash.ts:14-19`).
- **Do not change what the lexer refuses.** The 19 rows in `test/unit/permissions/bash-lex.test.ts:94-113` must pass unmodified at every commit.
- **Default mode is `raw`** (user ruling, 2026-09-22).
- **Commit after every task.** Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.

---

## File Structure

**Created:**
- `src/tools/policy-bash-raw.ts` — the `raw` mode screen. One responsibility: decide allow/deny for a command string under `raw`, using the protected-path predicate. No grant matching, no containment.
- `src/config/bash-approval.ts` — the `BashApprovalMode` type, its Zod schema, the derived default, and `resolveBashApproval()` (the `bashApprovalOps` surface). Separate from `permissions.ts` (295 lines) and `schemas-execution.ts` (489 lines) to keep both clear of the 600 gate.
- `test/unit/tools/policy-bash-raw.test.ts` — unit tests for the raw screen.
- `test/unit/config/bash-approval.test.ts` — unit tests for mode resolution and defaulting.
- `docs/adr/ADR-030-bash-approval-modes.md` — the governing ADR.

**Modified:**
- `src/tools/nax-owned-writes.ts` — extract a tool-agnostic protected-path predicate.
- `src/tools/policy-bash.ts:24-27,44-46,229-231,245-248` — add `escalatable` to the deny arm; set it at the two Category-A sites.
- `src/config/schemas-execution.ts` — `bashApproval` on `ExecutionConfigSchema` and on `PermissionBlockSchema`.
- `src/config/schemas.ts:124-165` — derived default in the `execution` literal (BUG-20).
- `src/config/runtime-types.ts` — `bashApproval` on `ExecutionConfig`.
- `src/config/permissions.ts` — `StageBlock`, `StageRules`, `stageRules`, `withRules`, `ResolvedPermissions`.
- `src/tools/policy.ts:100-112,336-354` — `ToolPolicyOptions.bashApproval`; dispatch in `commandBranch`.
- `src/agents/coding-tool-support.ts` — thread the mode into `compileToolPolicy`; synthetic Bash grant gated on declaration.
- `test/integration/permissions/bash-deny-suite.test.ts` — three-mode coverage.
- `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` — amendment at the end of §3.

---

## Task 1: ADR-030 and the ADR-029 amendment — ✅ DONE

> **Completed 2026-09-22 in commit `76044fe7b`.** Both documents are already on this branch;
> the steps below are retained as the record of what was written. **Start at Task 2.**
> If you disagree with the posture ADR-030 records, raise it before writing code — do not
> silently implement something else.


Documentation only. It goes first because the posture reversal is the decision the code implements, and a reviewer should be able to reject the posture before any code exists.

**Files:**
- Create: `docs/adr/ADR-030-bash-approval-modes.md`
- Modify: `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` (insert before `### 4. Permission policy stays in nax`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-level. Later tasks cite ADR-030 in doc comments.

- [x] **Step 1: Write ADR-030**

Create `docs/adr/ADR-030-bash-approval-modes.md` with this content:

```markdown
# ADR-030: Bash approval modes

**Status:** Accepted · **Date:** 2026-09-22
**Amends:** ADR-029 §3 (see the amendment at the end of that section)

## Context

ADR-029 §3 shipped a bash gate that is safe-by-refusal: a command runs only where a human wrote
a `Bash(...)` allow rule, and any construct the lexer cannot read is refused by name. Two costs
were then measured on the native path:

- An agent that cannot pipe or filter reads whole files instead, so tool-result bytes dominate
  context growth.
- A capability the typed tools do not expose is unreachable. In one run the verifier issued 13
  sequential `Git` calls to walk history and hit 3 hard failures expressing `git log --all`,
  `git diff --stat` and `git show -1`.

## Decision

A mode axis `bashApproval` with values `raw | gated | escalate`, resolved in the policy layer.

- `gated` — ADR-029 §3 behaviour, unchanged.
- `escalate` — `gated`, except a denial the gate could not adjudicate (lexer refusal, or no
  allow rule matched) returns the `ask` verdict instead. Denials that are affirmatively out of
  bounds — root escape, `.git/`, denied flags, an explicit deny rule — stay hard denials with
  `breach` preserved.
- `raw` — pass-through: no lexer refusal, no per-segment grant matching, no containment. One
  exception, a best-effort protected-path screen: if the lexer CAN parse the command and a
  segment writes or redirects into a nax-owned path, the command is denied; if the lexer cannot
  parse it, it runs.

**The default is `raw`.**

## Consequences

**This removes the only mechanical boundary around a bash call.** ADR-029 §3 already recorded
that no OS-level sandbox exists. Under `raw` the lexer refusal and root containment are gone as
well. A `raw` bash call runs with the privileges of the nax process and may write anywhere that
process can reach. The protected-path screen is advisory: a command using substitution bypasses
it completely, by construction.

This is accepted for trusted repositories under a threat model of agent mistakes, not hostile
repository content. Two properties bound it and must not regress:

1. Review operations and the verifier never declare `Bash`, and the synthetic grant introduced
   with `raw` is a no-op for an operation that did not declare it. Those roles are unaffected by
   any mode.
2. The deny path stays deterministic and fail-closed; `src/tools/bash.ts` still gates nothing.

An OS-level sandbox is the intended precondition for `raw` and is not part of this decision.
Until it exists, `raw` is a posture choice made with the blast radius stated above.

`escalate` ships with the existing deny-always headless `AskResolver`, so it refuses in exactly
the cases `gated` refuses — but it records the ledger outcome `denied:ask` rather than `denied`,
which is the demand signal ADR-029 §3 asks for before an interactive channel is built.
```

- [x] **Step 2: Write the ADR-029 amendment**

In `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md`, find the line:

```
### 4. Permission policy stays in nax
```

Insert this immediately BEFORE it (i.e. at the end of §3, after the `2026-09-14` amendment):

```markdown
#### Amendment, 2026-09-22: `raw` mode reverses safe-by-refusal, by choice

ADR-030 introduces a `bashApproval` mode axis whose default, `raw`, deliberately bypasses this
section's safe-by-refusal posture: no lexer refusal, no per-segment allow matching, no root
containment. Only a best-effort protected-path screen remains, and it is advisory — a command
using substitution bypasses it by construction.

**One sentence in this section is overturned.** §3 states:

> Config can narrow this ceiling, never widen it.

Under `raw`, config widens it: `Bash` is granted by a synthetic grant rather than by a
human-written `Bash(...)` allow rule. The narrowing that survives is structural rather than
configured — an operation that does not declare `Bash` receives no shell under any mode, so
review operations and the verifier are untouched. The rest of this section stands.

Two corrections to this section while amending it: the deny suite is described above as
"eleven rows"; it is now 21 cases. And the three-state verdict's `AskResolver` remains
deny-always — `escalate` routes more denials through it, which is how the reopen condition
below gets its data.
```

- [x] **Step 3: Verify the docs render and nothing else changed**

Run: `git diff --stat`
Expected: exactly two files — `docs/adr/ADR-030-bash-approval-modes.md` (new) and `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` (modified, additions only).

Run: `grep -n "Config can narrow this ceiling" docs/adr/ADR-029-phase-c-native-coding-agent-scope.md`
Expected: two hits — the original sentence in §3, and the quotation inside the new amendment.

- [x] **Step 4: Commit**

```bash
git add docs/adr/ADR-030-bash-approval-modes.md docs/adr/ADR-029-phase-c-native-coding-agent-scope.md
git commit -m "docs(adr): ADR-030 bash approval modes, and amend ADR-029 §3 for raw"
```

---

## Task 2: Mark Category-A denials as escalatable

`escalate` must convert only the denials the gate could not adjudicate. Carry that in the data, never by matching message text.

**Files:**
- Modify: `src/tools/policy-bash.ts` (the `BashCheck` type at `:24-27`, the `deny` helper at `:44-46`, the lexer-refusal site at `:229-231`, the grant-non-match site at `:245-248`)
- Test: `test/unit/tools/policy-bash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BashCheck`'s deny arm gains `readonly escalatable: boolean`. Task 6 reads it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tools/policy-bash.test.ts`:

```ts
describe("escalatable marking", () => {
  test("a lexer refusal is escalatable", () => {
    const result = check(policyFor(["*"]), "echo $(whoami)");
    expect(result.allowed).toBe(false);
    expect(result.escalatable).toBe(true);
  });

  test("a grant non-match is escalatable", () => {
    const result = check(policyFor(["bun test*"]), "curl evil.example");
    expect(result.allowed).toBe(false);
    expect(result.escalatable).toBe(true);
  });

  test("a containment breach is NOT escalatable", () => {
    const result = check(policyFor(["*"]), "cat ../../etc/passwd");
    expect(result.allowed).toBe(false);
    expect(result.breach).toBe(true);
    expect(result.escalatable).toBe(false);
  });

  test("a deny-rule match is NOT escalatable", () => {
    const result = check(policyFor(["*"], { deny: ["Bash(rm *)"] }), "rm -rf build");
    expect(result.allowed).toBe(false);
    expect(result.escalatable).toBe(false);
  });
});
```

If `describe`/`expect` are not already imported at the top of that file, add them to the existing `import { ... } from "bun:test";` line.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/tools/policy-bash.test.ts`
Expected: FAIL — `escalatable` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Add the field and set it at the two Category-A sites**

In `src/tools/policy-bash.ts`, change the `BashCheck` deny arm (currently at `:27`):

```ts
export type BashCheck =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly rule: string }
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly breach: boolean;
      /**
       * True when the gate could not ADJUDICATE the command — the lexer refused
       * it, or no allow rule covered a segment. False when the command is
       * affirmatively out of bounds (root escape, `.git/`, a denied flag, an
       * explicit deny rule). Only the former may be escalated to the ask tier
       * by `escalate` mode; escalating the latter would dissolve the `breach`
       * signal into an approval prompt. See ADR-030.
       */
      readonly escalatable: boolean;
    };
```

Change the `deny` helper (currently at `:44-46`):

```ts
function deny(reason: string, breach = false, escalatable = false): BashCheck {
  return { kind: "deny", reason, breach, escalatable };
}
```

At the lexer-refusal site (currently `:229-231`), pass the flag:

```ts
  if (lexed.kind === "refused") {
    return deny(
      `command contains ${lexed.construct}, which cannot be analysed and is therefore refused -- ` +
        "rewrite it without that construct, or use a structured tool",
      false,
      true,
    );
  }
```

At the grant-non-match site (currently `:245-248`):

```ts
    return deny(`${tool} is not granted "${render(segment)}" -- ${alternatives}`, false, true);
```

Leave every other `deny(...)` call untouched — they default to `escalatable: false`, which is correct.

- [ ] **Step 4: Propagate the flag through the policy verdict**

In `src/tools/policy.ts`, find the `commandBranch` deny line (currently `:351`):

```ts
    if (result.kind === "deny") return deny(result.reason, result.breach);
```

Change it to:

```ts
    if (result.kind === "deny") return deny(result.reason, result.breach, result.escalatable);
```

Then carry the flag through the verdict. `PolicyVerdict` lives in **`src/tools/types.ts:146-156`**, not in `policy.ts`. Add the field to its DENY arm only:

```ts
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly breach: boolean;
      readonly outcome?: "denied" | "ask";
      readonly resolvedPaths?: readonly string[];
      /** Present only with outcome "ask": the matching configured rule expression. */
      readonly rule?: string;
      /** See BashCheck.escalatable in policy-bash.ts. Bash-branch only; other
       * branches leave it undefined, which reads as not-escalatable. */
      readonly escalatable?: boolean;
    };
```

Then update `policy.ts`'s local `deny` helper (`grep -n "function deny(" src/tools/policy.ts`) to take a third parameter defaulting to `false`, so no other call site changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/tools/policy-bash.test.ts`
Expected: PASS.

Run: `bun run test:unit ./test/unit/permissions/bash-lex.test.ts`
Expected: PASS, unchanged — this task must not alter lexer behaviour.

Run: `bun run test:integration ./test/integration/permissions/bash-deny-suite.test.ts`
Expected: PASS, all 21 cases — adding a field must not change any verdict.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/tools/policy-bash.ts src/tools/policy.ts test/unit/tools/policy-bash.test.ts
git commit -m "feat(permissions): mark category-A bash denials escalatable"
```

---

## Task 3: A tool-agnostic protected-path predicate

`naxOwnedWriteRefusal` is gated on `NAX_OWNED_WRITE_TOOLS` (`Write`, `Edit`, `Delete`, `GitCommit`) and so returns `undefined` for `Bash`. The raw screen needs the underlying path test without the tool gate, and there must stay exactly one definition of "nax-owned path".

**Files:**
- Modify: `src/tools/nax-owned-writes.ts`
- Test: `test/unit/tools/nax-owned-writes.test.ts` (create if absent — the basename mirrors a `src/` module, so `check:test-satellites` exempts it)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isNaxOwnedWritePath(rel: string): boolean` — `rel` is a `/`-joined path relative to the permitted root. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

Create or append to `test/unit/tools/nax-owned-writes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isNaxOwnedWritePath } from "@/tools/nax-owned-writes";

describe("isNaxOwnedWritePath", () => {
  test("a feature PRD is owned", () => {
    expect(isNaxOwnedWritePath(".nax/features/my-feature/prd.json")).toBe(true);
  });

  test("a root queue-control file is owned", () => {
    expect(isNaxOwnedWritePath(".queue.txt")).toBe(true);
  });

  test("a nested file merely named like the queue file is not owned", () => {
    expect(isNaxOwnedWritePath("sub/.queue.txt")).toBe(false);
  });

  test("an ordinary source file is not owned", () => {
    expect(isNaxOwnedWritePath("src/index.ts")).toBe(false);
  });

  test("a non-prd file under a feature dir is not owned", () => {
    expect(isNaxOwnedWritePath(".nax/features/my-feature/notes.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/tools/nax-owned-writes.test.ts`
Expected: FAIL — `isNaxOwnedWritePath` is not exported.

- [ ] **Step 3: Extract the predicate**

In `src/tools/nax-owned-writes.ts`, add this exported function above `naxOwnedWriteRefusal`:

```ts
/**
 * Is this path one nax owns the writes to, independent of WHICH tool is asking?
 *
 * `naxOwnedWriteRefusal` answers the same question for the four file-writing
 * tools and returns prose. This predicate is the tool-agnostic half, extracted
 * so the `raw` bash screen (ADR-030) can consult exactly the same path set
 * without being in `NAX_OWNED_WRITE_TOOLS`. One definition, two callers.
 *
 * @param rel - Path relative to the permitted root, `/`-joined.
 */
export function isNaxOwnedWritePath(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.length === 1 && QUEUE_CONTROL_FILES.has(segments[0] ?? "")) return true;
  return segments[0] === ".nax" && segments[1] === "features" && segments[segments.length - 1] === "prd.json";
}
```

Then rewrite `naxOwnedWriteRefusal`'s own checks to call it, so the two cannot drift. Keep its distinct prose for each case: read the existing body and replace only the two boolean tests (the `segments.length === 1 && QUEUE_CONTROL_FILES.has(...)` test and the `isFeaturePrd` computation), leaving every returned message string exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/tools/nax-owned-writes.test.ts`
Expected: PASS.

Run: `bun run test:unit ./test/unit/tools/ && bun run test:integration ./test/integration/permissions/`
Expected: PASS — the refactor must not change any existing refusal.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/tools/nax-owned-writes.ts test/unit/tools/nax-owned-writes.test.ts
git commit -m "refactor(tools): extract tool-agnostic nax-owned path predicate"
```

---

## Task 4: The `raw` mode screen

**Files:**
- Create: `src/tools/policy-bash-raw.ts`
- Test: `test/unit/tools/policy-bash-raw.test.ts`

**Interfaces:**
- Consumes: `isNaxOwnedWritePath` (Task 3); `lexBashCommand` from `@/permissions`; `BashCheck` from `./policy-bash`.
- Produces:
  ```ts
  export interface RawScreenArgs {
    readonly tool: string;
    readonly command: unknown;
    readonly initialPath: string;
    readonly resolvePath: (candidate: string, cwd: string) => string | null;
    readonly root: string;
  }
  export function screenRawBashCommand(args: RawScreenArgs): BashCheck;
  ```
  Task 6 calls it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/policy-bash-raw.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { screenRawBashCommand } from "@/tools/policy-bash-raw";

const ROOT = "/tmp/raw-screen-root";

function screen(command: unknown) {
  return screenRawBashCommand({
    tool: "Bash",
    command,
    initialPath: ROOT,
    root: ROOT,
    resolvePath: (candidate, cwd) => resolve(cwd, candidate),
  });
}

describe("screenRawBashCommand", () => {
  test("allows an ordinary command", () => {
    expect(screen("bun test src/foo.test.ts").kind).toBe("allow");
  });

  test("allows a pipeline the gated lexer would accept", () => {
    expect(screen("bun test 2>/dev/null | head -20").kind).toBe("allow");
  });

  test("ALLOWS a construct the lexer refuses — this is what makes raw raw", () => {
    expect(screen("echo $(whoami)").kind).toBe("allow");
    expect(screen("echo `date`").kind).toBe("allow");
    expect(screen("cat <<EOF\nhi\nEOF").kind).toBe("allow");
  });

  test("allows a write outside the root — raw enforces no containment", () => {
    expect(screen("echo hi > ../../outside.txt").kind).toBe("allow");
  });

  test("DENIES a parseable redirect into a feature PRD", () => {
    const result = screen("echo {} > .nax/features/f/prd.json");
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("prd.json");
      expect(result.escalatable).toBe(false);
    }
  });

  test("DENIES a parseable argument naming a feature PRD", () => {
    expect(screen("rm .nax/features/f/prd.json").kind).toBe("deny");
  });

  test("DENIES a parseable write to the root queue-control file", () => {
    expect(screen("echo ABORT > .queue.txt").kind).toBe("deny");
  });

  test("a non-string command is denied", () => {
    expect(screen(42).kind).toBe("deny");
  });

  test("an empty command is denied", () => {
    expect(screen("   ").kind).toBe("deny");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/tools/policy-bash-raw.test.ts`
Expected: FAIL — module `@/tools/policy-bash-raw` not found.

- [ ] **Step 3: Write the implementation**

Create `src/tools/policy-bash-raw.ts`:

```ts
/**
 * The `raw` bash mode screen (ADR-030).
 *
 * `raw` is pass-through: no per-segment grant matching, no root containment,
 * and — unlike `checkBashCommand` — a command the lexer CANNOT read is ALLOWED
 * rather than refused. That inversion is the whole point of the mode.
 *
 * The one thing this screen still does is catch a naive mistake: if the lexer
 * CAN parse the command and a segment names or redirects into a path nax owns
 * (`.nax/config.json`, `.nax/mono/*\/config.json`, `.nax/features/**\/prd.json`,
 * the root queue-control files), the command is denied.
 *
 * ADVISORY BY CONSTRUCTION. A command using substitution is not parsed and
 * therefore is not screened at all: `sh -c "$(echo rm) .nax/features/f/prd.json"`
 * passes straight through. This is a mistake-catcher, not a boundary, and it
 * must never grow into a general gate — gating lives in policy, once
 * (`src/tools/bash.ts:14-19`).
 */
import { relative, sep } from "node:path";
import { lexBashCommand } from "@/permissions";
import { isNaxConfigFile, isNaxOwnedWritePath } from "./nax-owned-writes";
import type { BashCheck } from "./policy-bash";

export interface RawScreenArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The shell's initial working directory. */
  readonly initialPath: string;
  /** Resolves a candidate from an effective shell working directory. */
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  /** The permitted root, used to relativise a resolved path. */
  readonly root: string;
}

function deny(reason: string): BashCheck {
  // Never escalatable: a protected-path write is affirmatively out of bounds,
  // not a command the gate merely could not read.
  return { kind: "deny", reason, breach: false, escalatable: false };
}

/** A protected path, named for the refusal message, or undefined. */
function protectedHit(args: RawScreenArgs, candidate: string): string | undefined {
  const resolved = args.resolvePath(candidate, args.initialPath);
  if (resolved === null) return undefined;
  if (isNaxConfigFile(args.root, resolved)) return candidate;
  const rel = relative(args.root, resolved).split(sep).join("/");
  if (rel.startsWith("..")) return undefined;
  return isNaxOwnedWritePath(rel) ? candidate : undefined;
}

export function screenRawBashCommand(args: RawScreenArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  // The inversion: unreadable means unscreened, and unscreened means allowed.
  if (lexed.kind === "refused") return { kind: "allow" };

  for (const segment of lexed.segments) {
    for (const token of segment.tokens) {
      if (token.opaque) continue;
      const hit = protectedHit(args, token.text);
      if (hit !== undefined) {
        return deny(
          `${tool} command names "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
    }
    for (const redirect of segment.redirects) {
      if (redirect.opaque) continue;
      const hit = protectedHit(args, redirect.target);
      if (hit !== undefined) {
        return deny(
          `${tool} command redirects into "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
    }
  }

  return { kind: "allow" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/tools/policy-bash-raw.test.ts`
Expected: PASS, all 9 cases.

If the PRD-argument case fails, check that `lexBashCommand` yields the path as a plain token with `opaque: false` — print `JSON.stringify(lexBashCommand("rm .nax/features/f/prd.json"), null, 2)` in a scratch script to confirm the token shape before changing the implementation.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck
bun run lint:biome
git add src/tools/policy-bash-raw.ts test/unit/tools/policy-bash-raw.test.ts
git commit -m "feat(permissions): add the raw bash mode protected-path screen"
```

---

## Task 5: The `bashApproval` config surface

**Files:**
- Create: `src/config/bash-approval.ts`
- Modify: `src/config/schemas-execution.ts`, `src/config/schemas.ts`, `src/config/runtime-types.ts`
- Test: `test/unit/config/bash-approval.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type BashApprovalMode = "raw" | "gated" | "escalate";
  export const BashApprovalModeSchema: z.ZodEnum<["raw", "gated", "escalate"]>;
  export const DEFAULT_BASH_APPROVAL_MODE: BashApprovalMode; // "raw"
  ```
  Tasks 6 and 7 consume all three.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/bash-approval.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { BashApprovalModeSchema, DEFAULT_BASH_APPROVAL_MODE } from "@/config/bash-approval";
import { NaxConfigSchema } from "@/config/schemas";

describe("BashApprovalModeSchema", () => {
  test("accepts the three modes", () => {
    for (const mode of ["raw", "gated", "escalate"]) {
      expect(BashApprovalModeSchema.parse(mode)).toBe(mode);
    }
  });

  test("rejects a profile name, which is a different axis", () => {
    expect(() => BashApprovalModeSchema.parse("unrestricted")).toThrow();
  });

  test("the default is raw", () => {
    expect(DEFAULT_BASH_APPROVAL_MODE).toBe("raw");
  });
});

describe("config defaulting (BUG-20)", () => {
  test("an empty config carries the default", () => {
    expect(NaxConfigSchema.parse({}).execution.bashApproval).toBe("raw");
  });

  test("a PARTIAL execution object still carries the default", () => {
    // This is the BUG-20 shape: a hand-written default literal in schemas.ts
    // that omits the key leaves it undefined here.
    const parsed = NaxConfigSchema.parse({ execution: { maxIterations: 3 } });
    expect(parsed.execution.bashApproval).toBe("raw");
  });

  test("an explicit value survives", () => {
    const parsed = NaxConfigSchema.parse({ execution: { bashApproval: "gated" } });
    expect(parsed.execution.bashApproval).toBe("gated");
  });

  test("a per-stage override parses", () => {
    const parsed = NaxConfigSchema.parse({
      execution: { permissions: { run: { bashApproval: "escalate" } } },
    });
    expect(parsed.execution.permissions?.run?.bashApproval).toBe("escalate");
  });

  test("an invalid per-stage value is rejected", () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { permissions: { run: { bashApproval: "nope" } } } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: FAIL — module `@/config/bash-approval` not found.

- [ ] **Step 3: Create the module**

Create `src/config/bash-approval.ts`:

```ts
/**
 * The `bashApproval` mode axis (ADR-030).
 *
 * Named `raw | gated | escalate` rather than `unrestricted | ...` on purpose:
 * `unrestricted` already names a permission PROFILE
 * (`src/config/permissions.ts:17`), and a mode value colliding with a profile
 * name is a config foot-gun. Profiles answer "which tools is this stage
 * granted"; the mode answers "how is a bash command string adjudicated".
 */
import { z } from "zod";

export const BashApprovalModeSchema = z.enum(["raw", "gated", "escalate"]);

export type BashApprovalMode = z.infer<typeof BashApprovalModeSchema>;

/**
 * BUG-20 — derived from the schema, never hand-written at a second site. The
 * `execution` default literal in `schemas.ts` must reference THIS constant:
 * zod does not re-parse a `.default()` value, so a literal there drifts from
 * the field's own default the moment either changes.
 */
export const DEFAULT_BASH_APPROVAL_MODE: BashApprovalMode = BashApprovalModeSchema.parse("raw");
```

- [ ] **Step 4: Wire it into the schemas**

In `src/config/schemas-execution.ts`, add the import near the other imports:

```ts
import { BashApprovalModeSchema, DEFAULT_BASH_APPROVAL_MODE } from "./bash-approval";
```

Add the field to `PermissionBlockSchema` (which is `.strict()`, so it MUST be declared there), immediately after the `mode` field:

```ts
    /**
     * Per-stage override of `execution.bashApproval` (ADR-030). Unlike the
     * sibling `mode` field above, this one IS read — see `stageRules` in
     * `src/config/permissions.ts`. A declared-but-unread key is a defect.
     */
    bashApproval: BashApprovalModeSchema.optional(),
```

Add the global field to `ExecutionConfigSchema`, immediately after `permissionProfile`:

```ts
  bashApproval: BashApprovalModeSchema.default(DEFAULT_BASH_APPROVAL_MODE),
```

In `src/config/schemas.ts`, add to the `execution: ExecutionConfigSchema.default({...})` literal, next to `permissionProfile: "unrestricted"`:

```ts
      // BUG-20 — derived, not hand-written; see DEFAULT_BASH_APPROVAL_MODE.
      bashApproval: DEFAULT_BASH_APPROVAL_MODE,
```

and import it:

```ts
import { DEFAULT_BASH_APPROVAL_MODE } from "./bash-approval";
```

In `src/config/runtime-types.ts`, add to `interface ExecutionConfig`:

```ts
  /** ADR-030. Global default; `permissions.<stage>.bashApproval` overrides it. */
  bashApproval?: "raw" | "gated" | "escalate";
```

and add the same optional field to the `permissions` record's value type in that file (the block that currently declares `mode`, `allowedTools`, `inherit`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: PASS, all 9 cases. The "PARTIAL execution object" case is the one that catches BUG-20 — if it fails, the literal in `schemas.ts` is missing the key.

Run: `bun run test:unit ./test/unit/config/`
Expected: PASS — no existing config test changes.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/config/bash-approval.ts src/config/schemas-execution.ts src/config/schemas.ts src/config/runtime-types.ts test/unit/config/bash-approval.test.ts
git commit -m "feat(config): add the bashApproval mode axis, default raw"
```

---

## Task 6: Resolve the mode in `resolvePermissions`

Per the `check:permission-mode-ssot` doctrine, every permission decision belongs to `resolvePermissions()`. The per-stage override must be READ here, in the same change that declared it.

**Files:**
- Modify: `src/config/permissions.ts` (`StageBlock` `:176-182`, `StageRules` `:203-207`, `stageRules` `:209-217`, `withRules` `:221-227`, `ResolvedPermissions` `:30-61`)
- Test: `test/unit/config/bash-approval.test.ts` (append)

**Interfaces:**
- Consumes: `BashApprovalMode`, `DEFAULT_BASH_APPROVAL_MODE` (Task 5).
- Produces: `ResolvedPermissions.bashApproval: BashApprovalMode` — always present, never undefined. Task 7 reads it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/config/bash-approval.test.ts`:

```ts
import { resolvePermissions } from "@/config/permissions";
import { makeNaxConfig } from "@test/helpers";

describe("resolvePermissions bashApproval", () => {
  test("defaults to raw with no config", () => {
    expect(resolvePermissions(makeNaxConfig({}), "run").bashApproval).toBe("raw");
  });

  test("honours the global setting", () => {
    const cfg = makeNaxConfig({ execution: { bashApproval: "gated" } });
    expect(resolvePermissions(cfg, "run").bashApproval).toBe("gated");
  });

  test("a per-stage override beats the global setting", () => {
    const cfg = makeNaxConfig({
      execution: { bashApproval: "gated", permissions: { run: { bashApproval: "escalate" } } },
    });
    expect(resolvePermissions(cfg, "run").bashApproval).toBe("escalate");
  });

  test("a per-stage override applies only to its own stage", () => {
    const cfg = makeNaxConfig({
      execution: { bashApproval: "gated", permissions: { run: { bashApproval: "raw" } } },
    });
    expect(resolvePermissions(cfg, "verify").bashApproval).toBe("gated");
  });

  test("resolves for every profile, not just scoped", () => {
    for (const permissionProfile of ["unrestricted", "safe", "scoped"] as const) {
      const cfg = makeNaxConfig({ execution: { permissionProfile, bashApproval: "escalate" } });
      expect(resolvePermissions(cfg, "run").bashApproval).toBe("escalate");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: FAIL — `bashApproval` is `undefined` on the resolved object.

- [ ] **Step 3: Implement the resolution**

In `src/config/permissions.ts`:

Add the import:

```ts
import { type BashApprovalMode, DEFAULT_BASH_APPROVAL_MODE } from "./bash-approval";
```

Add to `interface StageBlock`:

```ts
  bashApproval?: BashApprovalMode;
```

Add to `ResolvedPermissions`:

```ts
  /**
   * How a model-authored bash command string is adjudicated for this stage
   * (ADR-030). Always present: the global default is `raw`, and a per-stage
   * `permissions.<stage>.bashApproval` overrides it. Compiled into the policy
   * by src/tools/, like the rule lists above — the DECISION stays here.
   */
  bashApproval: BashApprovalMode;
```

Making it required will surface every construction site at typecheck; that is intended. Add `bashApproval` to `StageRules` and resolve it in `stageRules`:

```ts
interface StageRules {
  readonly allow: readonly ToolGrant[];
  readonly deny: readonly ToolGrant[];
  readonly ask: readonly ToolGrant[];
  readonly bashApproval: BashApprovalMode;
}

function stageRules(config: AgentManagerConfig | undefined, stage: PipelineStage): StageRules {
  const blocks = config?.execution?.permissions as Record<string, StageBlock | undefined> | undefined;
  const block = lookupStageBlock(blocks, stage);
  return {
    allow: parseRuleList(block?.allow ?? block?.allowedTools ?? []),
    deny: parseRuleList(block?.deny ?? []),
    ask: parseRuleList(block?.ask ?? []),
    // Per-stage beats global beats the schema default.
    bashApproval: block?.bashApproval ?? config?.execution?.bashApproval ?? DEFAULT_BASH_APPROVAL_MODE,
  };
}
```

In `withRules`, always attach it — unlike the rule lists, this field is never conditional.

**Change the `base` parameter's type to `Omit<ResolvedPermissions, "bashApproval">`.** Leaving it as `ResolvedPermissions` makes all three call sites (`:238`, `:257`, `:294`) fail to typecheck, because each passes a base literal that does not yet carry the field — `withRules` is precisely what adds it:

```ts
function withRules(base: Omit<ResolvedPermissions, "bashApproval">, rules: StageRules): ResolvedPermissions {
  return {
    ...base,
    bashApproval: rules.bashApproval,
    ...(rules.allow.length > 0 ? { toolGrants: [...(base.toolGrants ?? []), ...rules.allow] } : {}),
    ...(rules.deny.length > 0 ? { denyRules: rules.deny } : {}),
    ...(rules.ask.length > 0 ? { askRules: rules.ask } : {}),
  };
}
```

Now fix the ONE return path that does not go through `withRules`. (`resolveScopedPermissions` at `:294` already ends in `withRules(...)`, so it needs no change — verify that before touching it.) The fail-closed default arm at `:269` currently returns `{ mode: INVALID_PROFILE_MODE }`; make it:

```ts
      return { mode: INVALID_PROFILE_MODE, bashApproval: "gated" };
```

**Fail closed here on purpose:** an unrecognised profile must not also hand out raw bash. Add that sentence as a comment on the line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: PASS.

Run: `bun run test:unit ./test/unit/permissions/ ./test/unit/config/`
Expected: PASS. If `bash-default-deny.test.ts` fails, read it — it asserts the pre-rules shape byte-for-byte, and a new always-present field may need adding to its expectation.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/config/permissions.ts test/unit/config/bash-approval.test.ts
git commit -m "feat(permissions): resolve bashApproval per stage in the SSOT resolver"
```

---

## Task 7: Dispatch on the mode in the policy

**Files:**
- Modify: `src/tools/policy.ts` (`ToolPolicyOptions` `:100-112`, `compileToolPolicy` `:136`, `commandBranch` `:334-354`)
- Test: `test/unit/tools/policy-bash.test.ts` (append)

**Interfaces:**
- Consumes: `BashApprovalMode` (Task 5); `screenRawBashCommand` (Task 4); `BashCheck.escalatable` (Task 2).
- Produces: `ToolPolicyOptions.bashApproval?: BashApprovalMode` — defaults to `"gated"` when absent, so every existing caller and test keeps today's behaviour. Task 8 supplies it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tools/policy-bash.test.ts`. Extend the local `policyFor` helper to accept a mode — read its current definition at `:23` and add a `bashApproval` passthrough into `compileToolPolicy`'s options.

```ts
describe("bashApproval modes", () => {
  test("gated is the default when the option is absent", () => {
    expect(check(policyFor(["*"]), "echo $(whoami)").allowed).toBe(false);
  });

  test("raw allows a construct the lexer refuses", () => {
    expect(check(policyFor(["*"], { bashApproval: "raw" }), "echo $(whoami)").allowed).toBe(true);
  });

  test("raw allows an ungranted command", () => {
    expect(check(policyFor([], { bashApproval: "raw" }), "curl evil.example").allowed).toBe(true);
  });

  test("raw still denies a parseable protected-path write", () => {
    const result = check(policyFor(["*"], { bashApproval: "raw" }), "echo x > .nax/features/f/prd.json");
    expect(result.allowed).toBe(false);
  });

  test("escalate turns a lexer refusal into ask", () => {
    const result = check(policyFor(["*"], { bashApproval: "escalate" }), "echo $(whoami)");
    expect(result.allowed).toBe(false);
    expect(result.outcome).toBe("ask");
  });

  test("escalate turns a grant non-match into ask", () => {
    const result = check(policyFor(["bun test*"], { bashApproval: "escalate" }), "curl evil.example");
    expect(result.outcome).toBe("ask");
  });

  test("escalate does NOT escalate a containment breach", () => {
    const result = check(policyFor(["*"], { bashApproval: "escalate" }), "cat ../../etc/passwd");
    expect(result.allowed).toBe(false);
    expect(result.outcome).not.toBe("ask");
    expect(result.breach).toBe(true);
  });

  test("escalate does NOT escalate a deny-rule match", () => {
    const result = check(
      policyFor(["*"], { bashApproval: "escalate", deny: ["Bash(rm *)"] }),
      "rm -rf build",
    );
    expect(result.outcome).not.toBe("ask");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/tools/policy-bash.test.ts`
Expected: FAIL — the `raw` cases deny, the `escalate` cases have no `ask` outcome.

- [ ] **Step 3: Implement the dispatch**

In `src/tools/policy.ts`, add the import:

```ts
import type { BashApprovalMode } from "@/config/bash-approval";
import { screenRawBashCommand } from "./policy-bash-raw";
```

Add to `ToolPolicyOptions`:

```ts
  /**
   * How a bash command string is adjudicated (ADR-030). Absent means `gated` —
   * today's behaviour — so every caller that does not opt in is unchanged.
   *
   * `raw` is a COMPILE-TIME input rather than a post-check transform on
   * purpose: `checkBashCommand` lexes before it evaluates grants, so a `Bash(*)`
   * grant cannot produce pass-through, and a post-check deny→allow would widen
   * genuine containment denials too.
   */
  readonly bashApproval?: BashApprovalMode;
```

In `compileToolPolicy`, read it near the other option reads (beside `denyBy`/`askBy`):

```ts
  const bashApproval: BashApprovalMode = options?.bashApproval ?? "gated";
```

Rewrite `commandBranch`'s body after the `scope.commandField` guard:

```ts
    if (scope.commandField === undefined) return undefined;

    if (bashApproval === "raw") {
      const screened = screenRawBashCommand({
        tool,
        command: input[scope.commandField],
        initialPath: resolvedRoot,
        root: resolvedRoot,
        resolvePath: (candidate, cwd) => resolveWithin(resolvedRoot, resolve(cwd, candidate)),
      });
      if (screened.kind === "deny") return deny(screened.reason, screened.breach, screened.escalatable);
      return { allowed: true, resolvedPaths: [] };
    }

    const denyEntry = denyBy.get(tool);
    const askEntry = askBy.get(tool);
    const result = checkBashCommand({
      tool,
      command: input[scope.commandField],
      grant,
      ...(denyEntry !== undefined ? { denyEntry } : {}),
      ...(askEntry !== undefined ? { askEntry } : {}),
      initialPath: resolvedRoot,
      resolvePath: (candidate, cwd) => resolveWithin(resolvedRoot, resolve(cwd, candidate)),
    });
    if (result.kind === "deny") {
      // `escalate` converts only a denial the gate could not ADJUDICATE. A
      // breach, a denied flag or an explicit deny rule stays a hard refusal:
      // escalating those would dissolve the `breach` signal into an approval
      // prompt. See ADR-030 and the two escalatable sites in policy-bash.ts.
      if (bashApproval === "escalate" && result.escalatable) {
        // NOT `askVerdict(...)`: that helper REWRITES reason as
        // `matched ask rule "<rule>"`, which is false here — no ask rule
        // matched. Build the verdict directly so the original denial reason
        // survives into the ledger and into the human prompt. `rule` is
        // omitted; `runtime.ts` falls back to `verdict.reason`.
        return { allowed: false, reason: result.reason, breach: false, outcome: "ask", resolvedPaths: [] };
      }
      return deny(result.reason, result.breach, result.escalatable);
    }
    if (result.kind === "ask") return askVerdict([], result.rule);
    return { allowed: true, resolvedPaths: [] };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/tools/policy-bash.test.ts`
Expected: PASS.

Run: `bun run test:integration ./test/integration/permissions/bash-deny-suite.test.ts`
Expected: PASS, all 21 — no caller supplies the option yet, so every case still runs `gated`.

- [ ] **Step 5: Check the file-size gate**

Run: `wc -l src/tools/policy.ts`
Expected: under 600. It was 583; this task adds roughly 20 lines. **If it crosses 600, stop and extract `commandBranch` into `src/tools/policy-command-branch.ts` before continuing** — do not shrink comments to squeeze under.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/tools/policy.ts test/unit/tools/policy-bash.test.ts
git commit -m "feat(permissions): dispatch the bash gate on bashApproval mode"
```

---

## Task 8: Thread the mode through, and grant Bash under `raw`

Under `raw` the agent still needs the `Bash` TOOL granted — the mode changes gating, not granting. The grant must be synthetic (no human rule), and it must be a **no-op for an operation that did not declare `Bash`**, which is what keeps review ops and the verifier shell-free.

**Files:**
- Modify: `src/agents/coding-tool-support.ts` (near `:177-195`)
- Test: `test/integration/permissions/bash-deny-suite.test.ts` (append; full coverage lands in Task 9)

**Interfaces:**
- Consumes: `ResolvedPermissions.bashApproval` (Task 6); `ToolPolicyOptions.bashApproval` (Task 7).
- Produces: nothing new; wires existing pieces.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/permissions/bash-deny-suite.test.ts`:

```ts
describe("raw mode grants Bash only to an op that declared it", () => {
  test("an op that declared Bash runs an ungranted command under raw", async () => {
    const support = await session({ declared: FIX_TOOLS, allow: [], bashApproval: "raw" });
    const result = await call(support, "echo hello");
    expect(result.kind).toBe("ok");
  });

  test("an op that did NOT declare Bash still cannot reach it under raw", async () => {
    const support = await session({ declared: ["Read"], allow: ["*"], bashApproval: "raw" });
    const result = await call(support, "echo hello");
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.reason).toContain("unknown tool");
  });
});
```

Extend the local `session()` helper (`:45-63`) to accept `bashApproval` and pass it into `buildCodingToolSupport`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:integration ./test/integration/permissions/bash-deny-suite.test.ts`
Expected: FAIL — the first case denies, because no grant covers `Bash`.

- [ ] **Step 3: Implement the threading and the synthetic grant**

In `src/agents/coding-tool-support.ts`, near the existing `allowBash` computation at `:179`:

```ts
  const allowBash = args.declared.includes(BASH_TOOL_NAME);

  // ADR-030: `raw` changes GATING, not GRANTING — the Bash tool still has to be
  // granted or `callTool` never reaches the policy. The grant is synthetic
  // (no human wrote a `Bash(...)` rule) and is deliberately conditioned on the
  // op having DECLARED Bash. That condition is what keeps review ops and the
  // verifier shell-free under every mode: they declare no Bash, so no mode can
  // hand them one. Never grant unconditionally here.
  const bashApproval = args.bashApproval ?? "gated";
  const effectiveGrants =
    bashApproval === "raw" && allowBash && bashGrant === undefined
      ? [...narrowedGrants, { tool: BASH_TOOL_NAME, patterns: ["*"] as readonly string[] }]
      : narrowedGrants;
```

Use `effectiveGrants` in the `compileToolPolicy` call and add the option:

```ts
    policy: compileToolPolicy(effectiveGrants, args.root, {
      bashApproval,
      ...(args.denyRules !== undefined ? { denyRules: args.denyRules } : {}),
      ...(args.askRules !== undefined ? { askRules: args.askRules } : {}),
      ...(args.fileOutputPath !== undefined ? { ownedWriteExemption: args.fileOutputPath } : {}),
    }),
```

Add `bashApproval?: BashApprovalMode` to this function's args interface, and at the `resolveCodingToolSupport` layer (`:330-332`) pass `resolved.bashApproval` down. Follow the existing optional-spread style used for the other fields.

Import the type as **type-only**:

```ts
import type { BashApprovalMode } from "@/config/bash-approval";
```

`check-alias-internals` forbids VALUE-level `@/<dir>/<internal>` imports (you would have to go through the `@/config` barrel), but exempts `import type` — which is why every cross-directory reference to this type in `src/` must be type-only. The same applies to the import added in Task 7.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:integration ./test/integration/permissions/bash-deny-suite.test.ts`
Expected: PASS — the new pair plus all 21 existing cases.

- [ ] **Step 5: Check the file-size gate**

Run: `wc -l src/agents/coding-tool-support.ts`
Expected: under 600. It was 582. **If this crosses 600, extract the grant computation into a small helper module rather than trimming comments.**

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/agents/coding-tool-support.ts test/integration/permissions/bash-deny-suite.test.ts
git commit -m "feat(permissions): thread bashApproval into the policy and grant Bash under raw"
```

---

## Task 9: Three-mode deny suite, cwd pin, default pin

The deny suite is this feature's acceptance spine. It must prove `gated` still refuses everything it refuses today, that `escalate` refuses the same set but records `denied:ask` for Category A, and that `raw` executes in the permitted root.

**Files:**
- Modify: `test/integration/permissions/bash-deny-suite.test.ts`
- Test: same file

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces: nothing.

- [ ] **Step 1: Write the gated-regression test**

Append to `test/integration/permissions/bash-deny-suite.test.ts`:

```ts
describe("gated is unchanged, and escalate refuses the same set", () => {
  const CATEGORY_A = ["echo $(whoami)", "curl evil.example"];
  const CATEGORY_B = ["cat ../../etc/passwd", "cat .git/config"];

  test.each(CATEGORY_A)("gated denies %s", async (command) => {
    const support = await session({ declared: FIX_TOOLS, allow: ["Bash(echo *)"], bashApproval: "gated" });
    expect((await call(support, command)).kind).toBe("denied");
  });

  test.each(CATEGORY_A)("escalate also refuses %s, via the ask tier", async (command) => {
    const support = await session({ declared: FIX_TOOLS, allow: ["Bash(echo *)"], bashApproval: "escalate" });
    const result = await call(support, command);
    expect(result.kind).toBe("denied");
    // The headless AskResolver denies, so the OUTCOME is the same and only the
    // ledger reason differs — that difference is the demand signal ADR-029 asks
    // for before an interactive channel is built.
    if (result.kind === "denied") expect(result.reason).toContain("headless");
  });

  test.each(CATEGORY_B)("escalate does NOT soften %s", async (command) => {
    const support = await session({ declared: FIX_TOOLS, allow: ["*"], bashApproval: "escalate" });
    const result = await call(support, command);
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.breach).toBe(true);
      expect(result.reason).not.toContain("headless");
    }
  });
});
```

- [ ] **Step 2: Write the raw-mode cwd pin**

Append:

```ts
describe("raw mode executes in the permitted root", () => {
  test("a raw command's writes land inside the root, not the process cwd", async () => {
    const support = await session({ declared: FIX_TOOLS, allow: [], bashApproval: "raw" });
    const result = await call(support, "echo marker > raw-cwd-proof.txt");
    expect(result.kind).toBe("ok");
    // Carried from nax#2182: a gate that passes while running somewhere
    // unintended adjudicates nothing. Pin the cwd, not just the verdict.
    expect(readFileSync(join(root, "raw-cwd-proof.txt"), "utf8").trim()).toBe("marker");
  });
});
```

Add `import { readFileSync } from "node:fs";` and `import { join } from "node:path";` at the top if absent. `root` is the temp root the existing `beforeEach` creates — check its variable name at `:32-43` and use it.

- [ ] **Step 3: Write the default-mode pin — at the layer that actually decides it**

⚠️ **Do not pin the default through `session()`.** That helper calls
`buildCodingToolSupport` DIRECTLY with hand-built grants (`bash-deny-suite.test.ts:45-63`); it
never goes through `resolvePermissions`, so the config default cannot reach it. With no
`bashApproval` passed, `buildCodingToolSupport`'s own `?? "gated"` fallback applies — which is
correct and deliberate for a direct caller, but it means an integration test here would assert
`gated` and tell you nothing about the shipped posture.

The default lives in the config layer and is already pinned there by Task 6
(`resolvePermissions(makeNaxConfig({}), "run").bashApproval === "raw"`) and Task 5
(`NaxConfigSchema.parse({}).execution.bashApproval === "raw"`). Add one explicit posture guard
beside them rather than a misleading one here. Append to `test/unit/config/bash-approval.test.ts`:

```ts
test("POSTURE GUARD: the shipped default is raw", () => {
  // If this flips it must flip deliberately, with an ADR-030 amendment — never
  // as a side effect of a schema edit. See ADR-029 §3's 2026-09-22 amendment
  // for what `raw` by default gives up.
  expect(NaxConfigSchema.parse({}).execution.bashApproval).toBe("raw");
  expect(resolvePermissions(makeNaxConfig({}), "run").bashApproval).toBe("raw");
});
```

Then add the complementary assertion HERE, which is what this file can honestly prove — that a
direct `buildCodingToolSupport` caller still gets today's behaviour when it passes nothing:

```ts
test("a direct buildCodingToolSupport caller defaults to gated, not raw", async () => {
  // `session()` bypasses resolvePermissions, so this pins the LOCAL fallback,
  // not the shipped posture. Both matter: a direct caller must never silently
  // acquire a shell it did not ask for.
  const support = await session({ declared: FIX_TOOLS, allow: [] });
  expect((await call(support, "echo $(whoami)")).kind).toBe("denied");
});
```

- [ ] **Step 4: Run the full suite**

Run: `bun run test:integration ./test/integration/permissions/`
Expected: PASS — all original 21 cases plus the new ones.

Run: `bun run test:unit ./test/unit/permissions/bash-lex.test.ts`
Expected: PASS, unmodified. If any of the 19 refusal rows changed, the implementation altered lexer behaviour — revert and fix.

- [ ] **Step 5: Check the test-file size gate**

Run: `wc -l test/integration/permissions/bash-deny-suite.test.ts`
Expected: under 800. It was 214. If it approaches the limit, split the mode cases into `test/integration/permissions/bash-deny-modes.test.ts` — a concern name, never a ticket name (`check:test-satellites`).

- [ ] **Step 6: Commit**

```bash
bun run typecheck
git add test/integration/permissions/
git commit -m "test(permissions): cover all three bashApproval modes, pin raw cwd and the default"
```

---

## Task 10: Export the `bashApprovalOps` surface and run the full gates

**Files:**
- Modify: `src/config/bash-approval.ts`
- Test: `test/unit/config/bash-approval.test.ts` (append)

**Interfaces:**
- Consumes: `BashApprovalMode` (Task 5).
- Produces: `export function resolveBashApproval(global, perStage): BashApprovalMode` — the named seam later phases compose against.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/config/bash-approval.test.ts`:

```ts
import { resolveBashApproval } from "@/config/bash-approval";

describe("resolveBashApproval", () => {
  test("per-stage wins", () => {
    expect(resolveBashApproval("gated", "escalate")).toBe("escalate");
  });

  test("falls back to global", () => {
    expect(resolveBashApproval("escalate", undefined)).toBe("escalate");
  });

  test("falls back to the default when both are absent", () => {
    expect(resolveBashApproval(undefined, undefined)).toBe("raw");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: FAIL — `resolveBashApproval` is not exported.

- [ ] **Step 3: Implement it and use it in `stageRules`**

Add to `src/config/bash-approval.ts`:

```ts
/**
 * `bashApprovalOps` (ADR-030): the named surface of mode resolution.
 *
 * Deliberately a pure function, not an async provider chain. The human
 * resolver is the existing `AskResolver`, which the `ask` tier already reaches
 * (`src/tools/runtime.ts:378`); a second chain would duplicate it. A future
 * model-based classifier attaches at the POST-ALLOW seam in `runtime.ts`
 * instead, narrowing allow → ask, which is a different insertion point.
 */
export function resolveBashApproval(
  global: BashApprovalMode | undefined,
  perStage: BashApprovalMode | undefined,
): BashApprovalMode {
  return perStage ?? global ?? DEFAULT_BASH_APPROVAL_MODE;
}
```

Then replace the inline fallback chain in `stageRules` (Task 6, Step 3) with a call to it, so there is one definition of the precedence:

```ts
    bashApproval: resolveBashApproval(config?.execution?.bashApproval, block?.bashApproval),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:unit ./test/unit/config/bash-approval.test.ts`
Expected: PASS.

- [ ] **Step 5: Run every gate**

```bash
bun run typecheck
bun run check:all
bun run test
```

Expected: all green. Notes:
- `check:permission-mode-ssot` may flag the new mode strings in `src/`. They are a DIFFERENT axis from `approve-all`/`approve-reads`, so they should not match its hardcoded token list — if it does flag them, read `scripts/check-permission-mode-ssot.ts:37` and decide deliberately between adding an inline `// nax-permission-mode-allow: <reason>` marker and leaving the gate alone.
- `nax` exits 0 on failure; these are `bun`/`tsc` commands and their exit codes ARE trustworthy.

- [ ] **Step 6: Commit**

```bash
git add src/config/bash-approval.ts test/unit/config/bash-approval.test.ts
git commit -m "feat(config): export the bashApprovalOps mode-resolution surface"
```

---

## Post-implementation: what to measure

Not a code task — record these once the branch is running somewhere real. They decide two later questions.

1. **`denied:ask` rate.** ADR-029 §3 gates any interactive approval channel on it: *"A material rate of those rows justifies building an interactive approval channel; zero rows means the seam stays dormant."* The pre-change baseline is **zero**.
2. **`Bash` call volume and outcome by stage/role** — confirms the synthetic grant reached only ops that declared `Bash`, and that review ops and the verifier got nothing.
3. **`Git` tool errors and sequential-history-walk length, by role** — decides whether the typed `Git` surface needs widening for the roles that never receive `Bash`. Baseline to beat: 13 sequential `Git` calls and 3 hard failures in one verifier session.
