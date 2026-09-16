# Agent Scope Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the coding agent's boundary visible to it, and make nax's own run state unwritable by rule rather than by accident of containment.

**Architecture:** Three independent changes on one seam. (1) The `.nax/` write guard moves out of `src/tools/policy.ts` into its own module, is widened to cover monorepo overrides at any package depth, and gains a write-only refusal for a story's own `prd.json` — reads stay allowed, because agents legitimately read their PRD. (2) The containment refusal names the permitted root instead of merely asserting one exists. (3) A short scope block is prepended to every dispatched prompt on both protocols, telling the agent which tree it is rooted at and how to spell paths for it. Nothing here changes the containment root itself.

**Tech Stack:** TypeScript, Bun, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-repo-rooted-agent-analysis.md` — specifically its "Recommendation → Do now instead" section and blocker B2. The repo-rooting change that document assesses is **explicitly out of scope here**; this plan implements only the near-term work it recommends, plus the B2 hardening.

## Starting state — read this first

- **Branch: `feat/agent-scope-awareness`**, already created, based on `main` @ `d9614909c`. It carries two docs-only commits (`04487be10` the spec, `8dc17fa11` this plan) and **zero code**. It is NOT pushed.
- Work on that branch. Do not branch again, and do not rebase onto a newer `main` without saying so.
- Everything below was verified against that commit. If a cited line number has moved, trust the **symbol name** and re-locate it; do not assume the surrounding logic changed.
- Task 1 must land before Tasks 3 and 4 (file-size headroom). Tasks 2, 3 and 5 are otherwise independent of each other.

### Two conventions this repo enforces that will bite you

- **`@/tools/<internal-file>` imports are legal from `test/`** and illegal from `src/`. `scripts/check-alias-internals.ts` exemption 2 states it explicitly: "a unit test's job is to exercise the unit, so reaching past a barrel is the intended behaviour". The test snippets below rely on this — they are correct as written.
- **`src/tools/nax-owned-writes.ts` must NOT be added to `src/tools/index.ts`.** `src/tools/deny-paths.ts` — the module this one is modelled on — is deliberately absent from that barrel. `src/prompts/sections/agent-scope.ts` is the opposite case: every sibling there IS barrel-exported, so it must be.

## Global Constraints

- **Never run bare `bun test`** — it has no path and pulls in e2e. Full suite is `bun run test`. Targeted iteration is `bun test test/unit/<path>.test.ts --timeout=30000` (documented in `CLAUDE.md:43`).
- **File-size ratchet is hard**: 600 lines for `src/`, 800 for `test/` (`scripts/check-file-sizes.ts`). `src/tools/policy.ts` is at **596/600** — Task 1 must land before Tasks 3 and 4, because it is what creates the headroom they spend.
- **`bun run check:all` must be green before every commit** — the pre-commit hook runs it and will reject the commit otherwise.
- **No `as unknown as` in `test/`** (baseline 0, enforced by `scripts/check-test-escape-hatches.ts`).
- **Containment semantics must not be relaxed.** Every path refused today stays refused. Task 2 and Task 3 only ever refuse *more*.
- **Reads of `.nax/` stay allowed** except for the config files already refused today. `policy.ts:60-67` states the reason: specs, PRDs, rules and run state "are things an agent legitimately reads, and refusing them wholesale would break ordinary work to close one hole."

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tools/nax-owned-writes.ts` | **New.** The single definition of which `.nax/` paths nax refuses, and to which tools. Holds `isNaxConfigFile` (moved from `policy.ts`), the run-state write guard, and the mutating-tool set. |
| `src/tools/policy.ts` | **Modified.** Loses `isNaxConfigFile` and its docblock (−28 lines); gains one import and a two-line hook in `applyPathRules`; `outOfRootReason` gains the root in its message. |
| `src/prompts/sections/agent-scope.ts` | **New.** Renders the scope block. Pure, protocol-agnostic, no I/O. Named `build*Section` and barrel-exported, matching every sibling in that directory. |
| `src/agents/tool-preamble.ts` | **Modified.** Prepends the scope block on both protocol arms, at the existing dispatch seam. |
| `src/prompts/sections/index.ts` | **Modified.** One export line. |
| `test/unit/tools/nax-owned-writes.test.ts` | **New.** Unit tests for the guard module. |
| `test/unit/prompts/agent-scope.test.ts` | **New.** Unit tests for the scope renderer. |

Why a new module rather than growing `policy.ts`: the same reasoning `src/tools/deny-paths.ts:5-19` already records — `policy.ts` carries the containment seam, is at the ratchet, and "refusing a path the policy already approved" is a separate concern from resolving or containing one.

---

### Task 1: Extract the `.nax/` config guard into its own module

Pure move. No behaviour change, and that is the point: it creates the headroom Tasks 3 and 4 spend, and gives the guard a home with room for a docblock.

**Files:**
- Create: `src/tools/nax-owned-writes.ts`
- Create: `test/unit/tools/nax-owned-writes.test.ts`
- Modify: `src/tools/policy.ts` — delete lines 60-87 (`isNaxConfigFile` and its docblock), add one import

**Interfaces:**
- Consumes: `realOrRaw` from `@/utils/realpath`
- Produces: `isNaxConfigFile(root: string, resolved: string): boolean` — identical signature and behaviour to the function being moved. Task 2 widens it; Task 3 adds two more exports beside it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/nax-owned-writes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isNaxConfigFile } from "@/tools/nax-owned-writes";

const ROOT = "/repo";

describe("isNaxConfigFile", () => {
  test("refuses the root config", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "config.json"))).toBe(true);
  });

  test("refuses a single-segment monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "config.json"))).toBe(true);
  });

  test("allows an ordinary file under .nax/mono", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "api", "notes.md"))).toBe(false);
  });

  test("allows a config.json that is not nax's own", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, "docs", "nax", "config.json"))).toBe(false);
  });

  test("allows a path outside the root", () => {
    expect(isNaxConfigFile(join(ROOT, "packages", "api"), join(ROOT, ".nax", "config.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: FAIL — `Cannot find module '@/tools/nax-owned-writes'`.

- [ ] **Step 3: Create the module with the moved function**

Create `src/tools/nax-owned-writes.ts`:

```ts
/**
 * Which paths nax refuses to let an agent touch, and to which tools.
 *
 * A separate file rather than an addition to src/tools/policy.ts, for the same
 * reason src/tools/deny-paths.ts is one: that file carries the containment
 * seam and sits at the project's file-size ratchet, while this is a narrower
 * concern -- it has nothing to do with resolving or containing a path, only
 * with refusing one containment would otherwise allow.
 *
 * Segment-exact, never a prefix or substring match: `.naxignore`,
 * `docs/nax/config.json` and `.nax/mono/api/notes.md` are ordinary paths a
 * tool must still reach.
 */

import { relative, sep } from "node:path";
import { realOrRaw } from "@/utils/realpath";

/**
 * Is `resolved` one of nax's own CONFIG files, relative to `root`?
 *
 * `.nax/config.json`, and `.nax/mono/<package>/config.json` in a monorepo.
 *
 * Why these at all: `quality.commands` and `acceptance.command` are run by key
 * through a shell and never pass the permission gate -- they are trusted
 * because a HUMAN wrote them. That trust rests entirely on a model being
 * unable to write them. An agent holding `Write` under the default
 * `unrestricted` profile could otherwise add a quality command and receive an
 * ungated shell on the next run, routing around every `Bash(...)` rule, the
 * lexer's construct refusals and containment itself.
 *
 * Refused to EVERY tool, reads included -- this is the pre-existing behaviour
 * and it is deliberate.
 */
export function isNaxConfigFile(root: string, resolved: string): boolean {
  const rel = relative(realOrRaw(root), resolved);
  if (rel === "" || rel.startsWith("..")) return false;
  const segments = rel.split(sep);
  if (segments[0] !== ".nax" || segments[segments.length - 1] !== "config.json") return false;
  // `.nax/config.json` (2) or `.nax/mono/<package>/config.json` (4).
  return segments.length === 2 || (segments.length === 4 && segments[1] === "mono");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: PASS, 5 tests.

- [ ] **Step 5: Delete the original from `policy.ts` and import the new one**

In `src/tools/policy.ts`, delete lines 60-87 inclusive — the `/** Is `resolved` one of nax's own CONFIG files... */` docblock and the `isNaxConfigFile` function beneath it. Verified boundaries: line 59 is blank, line 60 opens the docblock, line 87 is the function's closing `}`, line 88 is blank. `entersGitMetadata` ends at line 58 and stays. Add to the import block (after line 19, keeping alphabetical order by module path):

```ts
import { isNaxConfigFile } from "./nax-owned-writes";
```

Leave the call site in `resolveWithin` untouched — the signature is unchanged.

- [ ] **Step 6: Verify nothing changed behaviourally**

Run: `bun test test/unit/tools/policy.test.ts --timeout=60000`
Expected: PASS, all 68 cases, no edits needed. If any case fails, the move was not pure — revert and redo it as a literal copy.

Run: `bun run check:file-sizes`
Expected: `src/tools/policy.ts` now ~569 lines. Still "14 grandfathered oversized files (baseline 14)".

- [ ] **Step 7: Commit**

```bash
git add src/tools/nax-owned-writes.ts src/tools/policy.ts test/unit/tools/nax-owned-writes.test.ts
git commit -m "refactor(tools): extract the .nax config guard out of policy.ts"
```

---

### Task 2: Refuse monorepo overrides at any package depth

`isNaxConfigFile` admits only a 4-segment `.nax/mono/<pkg>/config.json`, but a real monorepo override is 5 — `.nax/mono/packages/api/config.json` (`src/config/loader.ts:382`, `src/cli/setup-write.ts:42`). Today that file is refused only because containment happens to put it outside a package story's root; a story rooted at the repo (single-package repo, or `workdir: "."`) can write it, and it supplies ungated shell commands.

**Files:**
- Modify: `src/tools/nax-owned-writes.ts` — one line in `isNaxConfigFile`
- Modify: `test/unit/tools/nax-owned-writes.test.ts` — add cases

**Interfaces:**
- Consumes: `isNaxConfigFile` from Task 1
- Produces: no signature change; strictly more paths return `true`

- [ ] **Step 1: Write the failing test**

Add to `describe("isNaxConfigFile", ...)` in `test/unit/tools/nax-owned-writes.test.ts`:

```ts
  test("refuses a nested monorepo override — the real shape loader.ts writes", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "config.json"))).toBe(true);
  });

  test("refuses a deeply nested monorepo override", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "services", "edge", "api", "config.json"))).toBe(true);
  });

  test("still allows a non-config file at the same nesting", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "packages", "api", "notes.md"))).toBe(false);
  });

  test("does not refuse a bare .nax/mono/config.json — no such override exists", () => {
    expect(isNaxConfigFile(ROOT, join(ROOT, ".nax", "mono", "config.json"))).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: FAIL — the two "nested" cases return `false`, expected `true`. The other two already pass; they are pinning behaviour that must not change.

- [ ] **Step 3: Widen the depth rule**

In `src/tools/nax-owned-writes.ts`, replace the final line of `isNaxConfigFile` and its comment:

```ts
  // `.nax/config.json` (2), or `.nax/mono/<package>/config.json` at ANY package
  // depth (>= 4). The real override path is nested -- `loadConfigForWorkdir`
  // reads `.nax/mono/<packageDir>/config.json` where packageDir is the
  // repo-relative package path (`src/config/loader.ts:382`), so a normal
  // `packages/*` layout is 5 segments, not 4. A length-exact rule left every
  // such override writable whenever the story's root was the repo root.
  return segments.length === 2 || (segments.length >= 4 && segments[1] === "mono");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify no existing test depended on the hole**

Run: `bun test test/unit/tools/ --timeout=60000`
Expected: PASS. A failure here means some test asserted a nested override was reachable — read it before changing it; it is more likely the bug than the test.

- [ ] **Step 6: Commit**

```bash
git add src/tools/nax-owned-writes.ts test/unit/tools/nax-owned-writes.test.ts
git commit -m "fix(tools): refuse .nax/mono overrides at any package depth

Part of #2094."
```

---

### Task 3: Refuse writes to a story's own `prd.json`

`isNaxConfigFile` covers only `config.json`. `.nax/features/<feature>/prd.json` holds the acceptance criteria the story is judged against, and is writable today by any story whose root is the repo root. It must stay **readable** — an agent legitimately reads its own PRD — so this cannot live in `resolveWithin`, which has no tool. It goes in `applyPathRules`, beside the deny-rule check, which already runs for all four path-field kinds.

**Files:**
- Modify: `src/tools/nax-owned-writes.ts` — add two exports
- Modify: `src/tools/policy.ts` — extend the import, add two lines to `applyPathRules` (`:310-320`)
- Modify: `test/unit/tools/nax-owned-writes.test.ts` — add a describe block

**Interfaces:**
- Consumes: nothing from Tasks 1-2 beyond the module existing
- Produces:
  - `NAX_OWNED_WRITE_TOOLS: ReadonlySet<string>` — the mutating path-bearing tools
  - `naxOwnedWriteRefusal(tool: string, rel: string): string | undefined` — a reason when the call must be refused, `undefined` otherwise. `rel` is **posix-separated and root-relative**, exactly what `relativeTo()` in `pathsBranch` produces.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/tools/nax-owned-writes.test.ts`:

```ts
import { NAX_OWNED_WRITE_TOOLS, naxOwnedWriteRefusal } from "@/tools/nax-owned-writes";

describe("naxOwnedWriteRefusal", () => {
  test("refuses Write to a feature PRD", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json")).toBeDefined();
  });

  test("refuses Edit, Delete and GitCommit to the same path", () => {
    for (const tool of ["Edit", "Delete", "GitCommit"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeDefined();
    }
  });

  test("allows READS of a feature PRD — an agent legitimately reads its own PRD", () => {
    for (const tool of ["Read", "Grep", "Glob", "Git"]) {
      expect(naxOwnedWriteRefusal(tool, ".nax/features/auth/prd.json")).toBeUndefined();
    }
  });

  test("allows writes elsewhere under .nax/features", () => {
    expect(naxOwnedWriteRefusal("Write", ".nax/features/auth/notes.md")).toBeUndefined();
  });

  test("allows writes to an ordinary prd.json outside .nax", () => {
    expect(naxOwnedWriteRefusal("Write", "docs/prd.json")).toBeUndefined();
  });

  test("the reason names the path and says why", () => {
    const reason = naxOwnedWriteRefusal("Write", ".nax/features/auth/prd.json");
    expect(reason).toContain(".nax/features/auth/prd.json");
    expect(reason).toContain("acceptance criteria");
  });

  test("the mutating set is exactly the path-bearing tools that mutate", () => {
    expect([...NAX_OWNED_WRITE_TOOLS].sort()).toEqual(["Delete", "Edit", "GitCommit", "Write"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: FAIL — `naxOwnedWriteRefusal is not a function`.

- [ ] **Step 3: Implement the guard**

Append to `src/tools/nax-owned-writes.ts`:

```ts
/**
 * The path-bearing tools that MUTATE. Read, Grep, Glob and Git are read-only
 * and are deliberately absent: an agent legitimately reads its own PRD, and
 * refusing that would break ordinary work to close one hole.
 *
 * Bash and Exec are absent because they carry no path fields -- a shell
 * redirect into `.nax/` is gated by the human-authored `Bash(...)` rules and
 * the lexer, which is a different seam from this one.
 */
export const NAX_OWNED_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete", "GitCommit"]);

/**
 * Why `tool` may not touch `rel`, or `undefined` when it may.
 *
 * `rel` MUST be the canonical, posix-separated, root-relative spelling the
 * policy itself derived -- never the caller's own. Matching the caller's
 * spelling means this guard and the policy that approved the call are reading
 * different strings, and every alternate spelling ("./x", "a/../x") walks past
 * the guard. Same rule, and the same reason, as `matchesDenyPaths`.
 *
 * The PRD defines the acceptance criteria the story is judged against. An
 * agent that can rewrite it can pass any review without writing any code,
 * which defeats the review layer without touching a config file.
 */
export function naxOwnedWriteRefusal(tool: string, rel: string): string | undefined {
  if (!NAX_OWNED_WRITE_TOOLS.has(tool)) return undefined;
  const segments = rel.split("/");
  const isFeaturePrd =
    segments[0] === ".nax" && segments[1] === "features" && segments[segments.length - 1] === "prd.json";
  if (!isFeaturePrd) return undefined;
  return `"${rel}" is nax's own run state: it holds the acceptance criteria this story is judged against, so no tool may modify it. Change the code, not the criteria.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/nax-owned-writes.test.ts --timeout=30000`
Expected: PASS, 16 tests.

- [ ] **Step 5: Wire it into the policy**

In `src/tools/policy.ts`, extend the Task 1 import:

```ts
import { isNaxConfigFile, naxOwnedWriteRefusal } from "./nax-owned-writes";
```

and add two lines at the top of `applyPathRules` (currently `:310`), before the deny-entry lookup:

```ts
  function applyPathRules(tool: string, rel: string, state: RuleState): PolicyVerdict | undefined {
    const naxOwned = naxOwnedWriteRefusal(tool, rel);
    if (naxOwned !== undefined) return deny(`${tool} may not modify ${naxOwned}`);
    const denyEntry = denyBy.get(tool);
```

`applyPathRules` is called from all four path-field kinds (`pathFields`, `listPathFields`, `arrayPathFields`, `refPathFields`), so one hook covers every path-bearing mutating call.

- [ ] **Step 6: Write the integration-level test**

Add to `test/unit/tools/policy.test.ts`. The file already provides `PATH_SCOPE` (`:8`) and a `root` bound in `beforeAll` (`:9`, `:12`) — use both; `policy.check` takes `(tool, scope, input)`:

```ts
describe("compileToolPolicy — nax-owned run state", () => {
  test("Write is refused for a feature PRD even under an unconditional grant", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: ".nax/features/auth/prd.json" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("acceptance criteria");
  });

  test("Read is still allowed for the same path", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/features/auth/prd.json" }).allowed).toBe(true);
  });
});
```

- [ ] **Step 7: Run the full tool suite and the size gate**

Run: `bun test test/unit/tools/ --timeout=60000`
Expected: PASS.

Run: `bun run check:file-sizes`
Expected: `policy.ts` ~571. Baseline unchanged at 14.

- [ ] **Step 8: Commit**

```bash
git add src/tools/nax-owned-writes.ts src/tools/policy.ts test/unit/tools/
git commit -m "fix(tools): refuse mutating tools on a feature PRD, keep reads

Closes #2094."
```

---

### Task 4: Name the permitted root in the containment refusal

`outOfRootReason` returns a bare `"resolves outside the permitted root"`. Its own docblock (`policy.ts:242-249`) records that this message once led an agent to delete a tsconfig entry instead of installing the package it needed. The disclosure rule it states — never reveal structure "for a path the model never touched" — is about *other* paths; naming the root for a path the model itself passed is a different thing, and Task 5 tells the agent the same root anyway.

**Files:**
- Modify: `src/tools/policy.ts` — the final return of `outOfRootReason` (`:300`), and its docblock
- Modify: `test/unit/tools/policy.test.ts` — assert the root appears

**Interfaces:**
- Consumes: `outOfRootReason(tool, root, candidate)` as it stands
- Produces: no signature change; the returned string gains the root

- [ ] **Step 1: Write the failing test**

Add to `test/unit/tools/policy.test.ts`, using the same `PATH_SCOPE` / `root` fixtures as Task 3:

```ts
test("an out-of-root refusal names the root the agent is actually confined to", () => {
  const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
  const verdict = policy.check("Read", PATH_SCOPE, { path: "../elsewhere/secret.txt" });
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain(root);
  expect(verdict.reason).toContain("permitted root");
});
```

Note `root` is bound in `beforeAll`, so it is a real temp directory — the assertion proves the message carries the actual root, not a placeholder.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/policy.test.ts --timeout=60000`
Expected: FAIL — the reason is `resolves outside the permitted root` and does not contain the root path.

- [ ] **Step 3: Include the root in the message**

In `src/tools/policy.ts`, replace the final return of `outOfRootReason`:

```ts
    return `resolves outside the permitted root (${root}), which is the only directory this tool can reach`;
```

and add to that function's docblock, after the paragraph explaining the deleted-tsconfig incident:

```
 * The root itself IS named, deliberately. The rule above -- never reveal
 * repository structure -- is about paths the model never touched; this path is
 * one the model just passed, and telling it where the boundary is is the
 * difference between "adapt" and "work around". The same root is stated in the
 * dispatch preamble (src/prompts/sections/agent-scope.ts), so this discloses
 * nothing the agent was not already told.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/policy.test.ts --timeout=60000`
Expected: PASS. Other cases in the file assert on `reason` — if any asserted string equality against the old bare message, update it to the new text; do not weaken the assertion to a substring to avoid the edit.

- [ ] **Step 5: Check the sibling suites that assert on refusal text**

Run: `bun test test/unit/tools/ test/integration/permissions/ --timeout=60000`
Expected: PASS. The deny suite (`test/integration/permissions/bash-deny-suite.test.ts`) asserts refusals happen, not their wording, but confirm rather than assume.

- [ ] **Step 6: Commit**

```bash
git add src/tools/policy.ts test/unit/tools/policy.test.ts
git commit -m "fix(tools): name the permitted root in the containment refusal"
```

---

### Task 5: Tell the agent its scope in the dispatch preamble

Nothing in any prompt states the tool root — verified by grepping every file under `src/prompts/`. The frame is stated once, in the planner prompt, to a different agent than the one that later hits the wall. This adds a short block at the dispatch seam, so both protocol arms get it from one place.

**Files:**
- Create: `src/prompts/sections/agent-scope.ts`
- Create: `test/unit/prompts/agent-scope.test.ts`
- Modify: `src/agents/tool-preamble.ts` — `promptWithToolPreamble` (`:26-29`)

**Interfaces:**
- Consumes: `AgentRunOptions.codingToolRoot` and `.codingToolRepoRoot` (`src/agents/types.ts:182`, `:190`), both `string | undefined`
- Produces: `buildAgentScopeSection(root: string | undefined, repoRoot: string | undefined): string | undefined` — the block, or `undefined` when there is no root to describe

- [ ] **Step 1: Write the failing test**

Create `test/unit/prompts/agent-scope.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildAgentScopeSection } from "@/prompts/sections/agent-scope";

describe("buildAgentScopeSection", () => {
  test("returns undefined when there is no root", () => {
    expect(buildAgentScopeSection(undefined, "/repo")).toBeUndefined();
    expect(buildAgentScopeSection("   ", "/repo")).toBeUndefined();
  });

  test("names the package and how to spell paths for it", () => {
    const out = buildAgentScopeSection("/repo/packages/api", "/repo");
    expect(out).toContain("packages/api");
    expect(out).toContain("src/index.ts");
    expect(out).not.toContain("packages/api/src/index.ts");
  });

  test("says the whole repo is reachable when rooted at the repo", () => {
    const out = buildAgentScopeSection("/repo", "/repo");
    expect(out).toContain("repository root");
    expect(out).not.toContain("cannot be opened");
  });

  test("strips the worktree prefix so the label is the package, not the scratch path", () => {
    const out = buildAgentScopeSection("/repo/.nax-wt/US-001/packages/api", "/repo");
    expect(out).toContain("packages/api");
    expect(out).not.toContain(".nax-wt");
    expect(out).not.toContain("US-001");
  });

  test("falls back to the root itself when no repo root is given", () => {
    expect(buildAgentScopeSection("/repo/packages/api", undefined)).toContain("packages/api");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/prompts/agent-scope.test.ts --timeout=30000`
Expected: FAIL — `Cannot find module '@/prompts/sections/agent-scope'`.

- [ ] **Step 3: Implement the renderer**

Create `src/prompts/sections/agent-scope.ts`:

```ts
/**
 * The scope block: which tree the agent's file tools are rooted at, and how to
 * spell a path for them.
 *
 * Nothing else in any prompt says this. The agent's tools are contained at a
 * root it is never told about, so it cannot tell "outside my reach" from "does
 * not exist" -- it discovers the boundary only by failing, and the refusal is
 * deliberately terse. That gap produces wrong conclusions, not just friction:
 * a reviewer shown a file it cannot open reports the file as missing.
 *
 * Pure and protocol-agnostic: the dispatch seam prepends it for both arms.
 */

import { relative } from "node:path";

/** The worktree segment `packageWorkdir()` bakes into an isolated story's root. */
const WORKTREE_DIR = ".nax-wt";

/**
 * The package label to show, with any worktree scratch prefix removed.
 *
 * Under `storyIsolation: "worktree"` the root is `<repo>/.nax-wt/<storyId>/<pkg>`
 * (src/worktree/manager.ts), so the naive relative path leaks the scratch
 * directory and the story id into the prompt. Both are noise to the agent, and
 * naming them invites it to reason about a path it should not care about.
 * Returns "" when the root IS the repo root.
 */
function packageLabel(root: string, repoRoot: string | undefined): string {
  const rel = repoRoot === undefined || repoRoot.trim() === "" ? root : relative(repoRoot, root);
  const segments = rel.split(/[\\/]/).filter((segment) => segment !== "");
  if (segments[0] !== WORKTREE_DIR) return segments.join("/");
  // Drop `.nax-wt` and the story id beneath it.
  return segments.slice(2).join("/");
}

export function buildAgentScopeSection(root: string | undefined, repoRoot: string | undefined): string | undefined {
  if (root === undefined || root.trim() === "") return undefined;
  const label = packageLabel(root, repoRoot);

  if (label === "") {
    return [
      "## Your file scope",
      "",
      "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root.",
      "Every path you pass them is resolved from there, and nothing outside it can be opened.",
    ].join("\n");
  }

  return [
    "## Your file scope",
    "",
    `Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at \`${label}\`, NOT at the repository root.`,
    `Spell every path relative to that directory: write \`src/index.ts\`, never \`${label}/src/index.ts\`.`,
    "",
    `If a path you were given already starts with \`${label}/\`, strip that prefix before using it.`,
    "If it names a different package, your tools cannot open it — say so rather than guessing at its contents.",
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/prompts/agent-scope.test.ts --timeout=30000`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into both protocol arms**

First export it from the sections barrel. In `src/prompts/sections/index.ts`, add in alphabetical position (before the `./acceptance` exports):

```ts
export { buildAgentScopeSection } from "./agent-scope";
```

Then in `src/agents/tool-preamble.ts`, extend the existing barrel import at `:21` rather than adding a second line:

```ts
import { applyProtocolRegions, buildAgentScopeSection } from "../prompts/sections";
```

(Relative, not aliased: `check:alias-internals` requires an alias to name a barrel, which is why this file's existing imports are relative — see its module docblock.)

Replace the body of `promptWithToolPreamble`:

```ts
export function promptWithToolPreamble(agentName: string, options: AgentRunOptions): string {
  const base = agentName === NATIVE_AGENT ? options.prompt : buildContextToolPreamble(options);
  const scope = buildAgentScopeSection(options.codingToolRoot, options.codingToolRepoRoot);
  return scope === undefined ? base : `${scope}\n\n${base}`;
}
```

Add to that function's docblock:

```
 * The scope block is prepended on BOTH arms: the boundary is a property of the
 * tools, not of the transport, and an ACP agent is as blind to it as a native
 * one. It goes here rather than in a per-op section because every dispatch has
 * a root and none of the op builders can see it.
```

- [ ] **Step 6: Run the dispatch-seam tests**

Run: `bun test test/unit/agents/ --timeout=60000`
Expected: PASS. Any test asserting an exact full-prompt string will now see the scope block first — update those expectations to include it. Do **not** special-case the tests by skipping the block; the block being present is the feature.

- [ ] **Step 7: Run the full suite**

Run: `bun run test`
Expected: all phases pass. Prompt-shape assertions elsewhere (`test/unit/prompts/`) may need the same expectation update as step 6.

- [ ] **Step 8: Commit**

```bash
git add src/prompts/sections/agent-scope.ts src/prompts/sections/index.ts src/agents/tool-preamble.ts test/unit/prompts/agent-scope.test.ts test/unit/agents/
git commit -m "feat(prompts): tell the agent which tree its file tools are rooted at"
```

---

## Final verification

- [ ] **Run the whole gate**

```bash
bun run test
bun run typecheck
bun run check:all
bun run test:coverage
```

Expected: all green; `check-story-workdir-access: clean (0 exemption(s) still pending)`; `check:file-sizes` baseline still 14; coverage at or above floor with 0 files below.

- [ ] **Confirm #2094's two halves actually refuse**

The point of Tasks 2 and 3 is that they no longer depend on containment. Verify with a root-workdir story's shape — root = repo root — which is the case that was reachable:

```bash
bun test test/unit/tools/nax-owned-writes.test.ts test/unit/tools/policy.test.ts --timeout=60000
```

Both `.nax/mono/packages/api/config.json` and `.nax/features/*/prd.json` must be refused with the root set to the repo root, not merely when they fall outside a package root.

---

## Issues this closes

**Closes #2094** — "A root-rooted story can write `.nax/mono/<nested>/config.json` and its own `prd.json`". Tasks 1-3 are its whole fix: Task 2 closes the nested-override half, Task 3 the `prd.json` half. The `Closes #2094.` keyword is on Task 3's commit, which is the one that completes it — do not move it earlier, or the issue auto-closes while half the fix is still unwritten.

**Closes nothing else, and that is not an oversight.** The plan was checked against every open issue:

| Issue | Why it stays open |
|---|---|
| #2090 prompt-embedded git lacks `--relative` | **Mitigated, not fixed.** Task 5's scope block tells the agent to strip the `<package>/` prefix from a path it is handed, which is exactly the recovery an ACP reviewer needs when `git diff --name-only` hands it repo-framed paths. The builders still emit the wrong frame, so the defect stands — the agent is now merely equipped to work around it. Say so in the PR; do not close it. |
| #2083, #2085, #2086, #2087, #2088, #2089, #2091 | Path-frame seams. Untouched by this plan — none involves the tool root, the `.nax` guard or the preamble. |
| #2084 gate bypasses | `scripts/check-story-workdir-access.ts` is not modified here. |
| #2093 Exec `target:"repoRoot"` escapes the worktree | A different seam (`codingToolRepoRoot`). Task 5 *reads* that field for its label and defends against the same worktree shape by stripping `.nax-wt/<storyId>`, but it does not fix the Exec path. |
| #2079, #2080 | Plan-time and PRD-write concerns. |

If a reviewer asks why the path-frame issues did not move: this plan deliberately does not touch the containment root, which is the only thing that would dissolve them. That decision and its reasoning are in the spec.

## Out of scope

Stated so an executor does not drift into it:

- **Moving the containment root to the repo.** The spec assesses it and recommends against shipping it as a root move; it needs the four-way split of `ctx.root` described there, which is a permission-model redesign.
- **#2093** (`Exec target:"repoRoot"` runs in the main checkout from a worktree story). Real and filed, but a different seam.
- **`.nax/rules/`, `status.json`, `.nax/specs/`.** Task 3 covers `prd.json` only, as asked. The same guard is where they would go if they are wanted later — one line each in `naxOwnedWriteRefusal`.
- **The path-frame follow-ups** #2083-#2091. Unaffected by this plan.
