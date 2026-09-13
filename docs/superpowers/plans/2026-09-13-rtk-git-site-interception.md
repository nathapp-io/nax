# rtk Command Interception — Git Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route nax's `Git` tool calls through rtk for two measured verbs, behind an opt-in config flag, without any nax module outside one file knowing rtk exists.

**Architecture:** A generic `CommandInterceptor` seam consulted by `gitWithTimeout` between argv construction and spawn. One provider implements it for rtk as a static per-verb argv prefix. Every rewrite is validated and ledgered; a provider that cannot run declines, and nax runs the original. With the interceptor disabled — the default — every call site is byte-identical to today.

**Tech Stack:** TypeScript strict, Bun (`Bun.spawn`, `Bun.which`), `bun:test`, Biome, zod (config schemas).

**Spec:** `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md`
**Evidence:** `docs/superpowers/results/2026-09-13-rtk-savings-measurement.md`

## STOP — start from the right commit

This plan and the ruling it implements are **not on `origin/main` yet**. At the time of
writing they live on branch `feat/rtk-site-scope-ruling`:

The branch carries US-001's measured results, **R10** (the ruling that defines this plan's
scope), the corrected spec, and this plan — across several commits. Take the branch tip; do
not cherry-pick, and do not rely on any single commit hash, since both documents were
revised after they were first written.

**If you read the spec from `origin/main` you will build the wrong thing.** The version on
main still describes three interception sites, still carries a `sites` config key, still
lists predicted verb values that the measurement removed, and — most dangerously — still
names `gitWithTimeout` as the interception site, which would silently corrupt nax's own git
parsing (see Task 4). It contains no R10 at all.

Before Task 1:

```bash
grep -c "R10" docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md
grep -c "52 callers" docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md
```

Both must be non-zero. The second is the load-bearing one: it proves you have the spec
*after* the interception site was corrected, not merely after R10 landed.

If the grep returns 0, you are on the wrong base. Check out `feat/rtk-site-scope-ruling`,
or — if it has since merged — re-pull `main` and confirm the grep is non-zero before
writing any code.

Branch your work from whichever of those is current. Do not branch from a stale local
`main`: a worktree created by tooling branches from your current local HEAD, not from
`origin/main`, so verify with `git log --oneline origin/main..HEAD` before opening a PR or
you will ship this whole branch inside your feature PR.

The tasks are **sequential** — each builds on the previous one's types. Do not parallelise
them.

## Read this before Task 1 (fresh-session handover)

You have no context from the session that wrote this. Read, in order:

1. `CLAUDE.md` at the repo root — Bun-native APIs only, TypeScript strict, `bun:test`, Biome.
2. `.nax/rules/project-conventions.md`, `test-writing.md`, `error-handling.md`, `config-patterns.md`. Never edit `.claude/rules/` — it is generated from `.nax/rules/` and `check-rules-drift` will fail you.
3. The spec above — **especially R1, R4, R6, R7 and R10**. R10 is a user ruling that defines this plan's scope; violating it is not an improvement.

## Global Constraints

- **R10 is binding: do not add an interception seam to `src/quality/runner.ts` or `src/verification/executor.ts`.** Those sites are dropped. Task 6 Step 5 adds a test that fails if anyone re-adds one. `RunCommand` is therefore NOT covered by this feature — it reaches the shell through the dropped quality site.
- **R1: no nax module outside `src/execution/interceptors/rtk/` may *depend on* rtk.** R1 is about dependency, not spelling: only that directory and the composition site may **import** the provider. Naming rtk in a comment, or as a config default string, is fine and unavoidable — the provider has to be named somewhere. Task 6 Step 5's fence enforces the import rule; two earlier revisions used a substring scan and were broken by their own comments.
- **R7: `enabled` defaults to `false`.** Every task's tests must prove the disabled path is unchanged.
- Source files ≤ **600 lines**, test files ≤ **800** (`scripts/check-file-sizes.ts`; new files get no grandfathering).
- Runtime import cycles must stay at **0** (`bun run scripts/check-import-cycles.ts`, baseline 0).
- Errors use `new NaxError(message, code)` — message first. Import from `@/errors`.
- Tests import source via the `@/` alias and shared fakes via the `@test/helpers` barrel. No `as unknown as` in `test/` (ratchet baseline 0) — `test/helpers/spawn.ts` exists precisely so you never need one.
- Conventional commits. No attribution lines.
- Run `AGENT=1 bun run check:all` before every commit, and `bun run test:coverage` after adding any new `src/` file — **coverage is not part of `check:all`** and will not catch you otherwise.

Conventions this plan depends on, verified against the tree at `865bbe406`:

| Thing | Correct form | Easy mistake |
|---|---|---|
| Importing src from a test | `@/execution/command-interceptor` | a relative `../../../src/...` path |
| Importing a shared test fake | `@test/helpers` (barrel) | reaching into `test/helpers/spawn.ts` directly |
| Faking a spawn | `makeSpawn(({ cmd, opts }) => "stdout").spawn` | an object literal, `as never`, or a cast through `unknown` |
| Restoring a patched dep | `withDepsRestore(_gitDeps, ["spawn"])` | a hand-written `afterEach` |
| `NaxError` | `new NaxError(message, code)` | arguments reversed |
| Running one test file | `CI=1 AGENT=1 bun test <path>` | bare `bun test` |

## Four gates that will fail you, and the layout that satisfies them

**Read this section before Task 1.** An earlier revision of this plan was rejected in
review because it violated all four. They are not hypothetical — each is enforced inside
`check:all`, and the pre-commit hook runs `check:all`.

**1. The barrel gate** (`scripts/check-alias-internals.ts`). A value-level
`@/<dir>/<internal>` import from `src/` is forbidden when `src/<dir>/index.ts` exists —
and `src/tools/index.ts` and `src/execution/index.ts` both do. An **exact barrel match**
is legal: `listBarrelDirs` (line 130) recurses and registers every directory holding an
`index.ts`, and `classify` (line 211) returns `null` — no violation — when the import path
equals a registered barrel exactly. Hence the nested-directory layout below. Precedents:
`src/execution/checkpoint/`, `src/execution/helpers/`, `src/review/runner/`.

⚠️ **Create the directory form only.** `findShadowedBarrels` (line 157) *removes* a barrel
that has a same-named sibling file, so leaving a stray `src/execution/command-interceptor.ts`
beside `command-interceptor/index.ts` silently un-registers the barrel and every import of
it becomes a violation — with an error message that points at the import, not at the stray
file. If you refactor a `.ts` into a `/index.ts`, delete the original in the same step.

Note also that `test/` files are **exempt** from this gate for `@/` paths, so a passing
test suite proves nothing about it. Only `check:all` does.

**2. The import-cycle gate** (`scripts/check-import-cycles.ts`, baseline 0). A cycle here
is **certain, not possible**: `src/tools/git.ts:18` already imports `gitWithTimeout` from
`@/utils/git`, so the moment `utils/git` imports anything that reaches `tools/git` the
cycle closes. This is why `GIT_ESCAPE_FLAGS` moves to a leaf in Task 1 — that task exists
solely to make Tasks 2-4 possible.

**3. The file-size gate** (`scripts/check-file-sizes.ts`, `SRC_LIMIT = 600`; new files get
no baseline entry, so crossing the cap hard-fails). `src/utils/git.ts` is **579 lines** —
21 from the cap — which is one more reason the seam is **not** there. `src/tools/git.ts`,
where it does go, is **328**. `interceptArgv` still lives in the interceptor module rather
than at the call site, so the tool file stays comfortable and the logic stays testable in
isolation.

**4. `as never` is banned** (`biome-plugins/no-as-never.grit`, active repo-wide via
`biome.json`), as is `as unknown as` in `test/`. `test/helpers/spawn.ts` exists so that you
never need either.

### Module layout

| File | Why it is shaped this way |
|---|---|
| `src/tools/git-flags/index.ts` | Leaf with **no imports**. Holds `GIT_ESCAPE_FLAGS`. Breaks the cycle and satisfies the barrel gate. |
| `src/execution/command-interceptor/index.ts` | Nested barrel → `@/execution/command-interceptor` is a legal exact match. Holds the vocabulary, `validateRewrite`, and `interceptArgv`. |
| `src/execution/interceptors/rtk/index.ts` | Nested barrel, same reason. The only file that knows how to talk to rtk. |
| `src/tools/git.ts` | The **only** interception site. Gains `_gitToolDeps`, one `interceptArgv` call and one guarded `postProcess` call. 328 lines, ample headroom. |
| `src/utils/git.ts` | **Not untouched:** gains one optional `argvOverride` parameter (~4 lines, 579/600) so the Git tool can supply a full argv — Task 4 Step 3. No interception logic and no seam: `gitWithTimeout` has 52 callers that machine-parse their output, and none of them pass it. |
| `src/tools/index.ts` | Re-exports `_gitToolDeps`, following `_grepDeps` at line 11 — `src/` code cannot legally import `@/tools/git` directly (barrel gate). |

## Four scope decisions, already settled — do not re-open them

1. **`Site` is the single value `"git"`.** A three-member union invites exactly the wiring R10 forbids.

2. **`InterceptRequest` is argv-only; the `shell` variant and `rtk rewrite` are dropped.** (User, 2026-09-13.) No call site produces a shell string, so that branch would be unreachable. **The spec's US-004 criterion "each of the four exit codes maps as specified" is deliberately NOT implemented** — its absence is not an oversight. To reopen: re-add the union member, implement the exit-code mapping, and — the actual work — implement R9's narrowing. R9 is retained in the spec for that purpose.

3. **US-005's `RunCommand` truncation-marker item is out of scope.** `RunCommand` reaches the shell via `runQualityCommand` (`src/tools/run-command.ts:349`), the dropped quality site, so `postProcess` never sees its output. The underlying bug is real and pre-existing — `run-command.ts:360` appends no marker and cuts by **characters** while `maxBytes` is a byte budget, unlike `Git`/`Read`/`Grep` which cut by bytes and append a marker; `git-commit.ts:68` shares the mismatch. **File separately.**

4. **US-006 (the `Recall` tool) is deferred out of this plan entirely.** It needs a provider-registration seam that **does not exist**: `options.providers` (`src/agents/types.ts:172`) is read by `resolveCodingToolSupport` (`src/agents/coding-tool-support.ts:263`) but **nothing in `src/` ever sets it** — only tests do. Building that seam is the same gap the MCP client spec faces, and it belongs with that work, not bolted onto a two-verb git feature. Provider tools are also gated to the unrestricted profile only (`coding-tool-support.ts:261`), which is a decision worth taking deliberately.

   **Consequence, and it is by design:** US-005 strips rtk's hints (R4) and the truncation marker degrades to a plain notice that names no tool. The spec already requires exactly this when `Recall` is unadvertised — "offering a tool the agent does not have is worse than offering nothing." So this plan lands on a supported configuration, not a broken one. The recall hash is still captured into `notes` so the later work has it.

   ⚠️ *Beware a name collision while researching this:* `defaultProviders()` in `src/agents/native/client.ts:47` is nax-ai's **model** catalog, unrelated to `ToolProvider`.

---

## Spec coverage

Every user story in the spec, and where it lands. Check your work against this, not
against memory of the spec's prose — which predates R10 in places.

| Spec | Task | Notes |
|---|---|---|
| US-001 measurement | — | Done and committed (`580e9d9e3`). Its output is R10 and `git.verbs`. |
| US-002 interface | Task 2 | Plus `interceptArgv`, which the spec does not name — it exists to keep `src/utils/git.ts` under its size cap. |
| US-003 wiring | Task 4 | The **`Git` tool's** call only (`src/tools/git.ts:319`) — *not* `gitWithTimeout`. The spec's original site was wrong; it was corrected in `580e9d9e3`'s successor. The fence in Task 6 Step 5 keeps it that way. |
| US-004 rtk provider | Task 5 | Minus the `rtk rewrite` exit-code protocol — scope decision 2. |
| US-005 post-processing | Task 6 | Hint stripping only. The `RunCommand` marker item is scope decision 3; the `Recall` half needs US-006. |
| US-006 recall tool | **deferred** | Scope decision 4. No provider-registration seam exists. |
| US-007 config | Task 3 | No `sites` key; verbs are measured, not predicted. |
| US-008 audit | Task 4 | Via `ToolResult.audit.executed`, widening `target` to optional. |

Task 1 maps to no user story: it is the refactor that makes Tasks 2-4 legal under the
cycle and barrel gates.

---

### Task 1: Move `GIT_ESCAPE_FLAGS` to a leaf module

This task ships no feature. It exists because Tasks 2-4 cannot satisfy the cycle and barrel
gates without it. Do it first and separately so that if it breaks something, the blast
radius is one constant.

**Files:**
- Create: `src/tools/git-flags/index.ts`
- Modify: `src/tools/git.ts` (delete the const, re-export from the new leaf)
- Test: `test/unit/tools/git-flags.test.ts`

**Interfaces:**
- Produces: `GIT_ESCAPE_FLAGS: readonly string[]` from `@/tools/git-flags`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { GIT_ESCAPE_FLAGS } from "@/tools/git-flags";

describe("GIT_ESCAPE_FLAGS", () => {
  test("bans every flag that can retarget git or execute code", () => {
    // -c is included because `-c core.pager=<cmd>` is code execution.
    expect([...GIT_ESCAPE_FLAGS].sort()).toEqual(["--exec-path", "--git-dir", "--work-tree", "-C", "-c"].sort());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/tools/git-flags.test.ts`
Expected: FAIL — `Cannot find module '@/tools/git-flags'`.

- [ ] **Step 3: Create the leaf and re-export**

`src/tools/git-flags/index.ts` — **this file must import nothing.** That is its entire
purpose: any import here re-opens the cycle it exists to break.

```typescript
/**
 * Git global options nax refuses to let any caller introduce.
 *
 * A leaf module with NO imports, deliberately. `src/tools/git.ts` imports
 * `@/utils/git`, so anything `src/utils/git.ts` reaches must not lead back to
 * `src/tools/git.ts` — see check-import-cycles (baseline 0).
 *
 * `-c` is here because `-c core.pager=<cmd>` is arbitrary code execution.
 */
export const GIT_ESCAPE_FLAGS: readonly string[] = ["-C", "--git-dir", "--work-tree", "--exec-path", "-c"];
```

In `src/tools/git.ts`, delete the const at line 180 and re-export so existing importers are
untouched:

```typescript
export { GIT_ESCAPE_FLAGS } from "@/tools/git-flags";
```

**Do not copy the list.** Two copies of a security constant will drift.

- [ ] **Step 4: Verify nothing regressed**

Run: `CI=1 AGENT=1 bun test test/unit/tools/ && AGENT=1 bun run check:all`
Expected: PASS, including `check-import-cycles` at 0 and `check-alias-internals` clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/git-flags/index.ts src/tools/git.ts test/unit/tools/git-flags.test.ts
git commit -m "refactor(tools): move GIT_ESCAPE_FLAGS to a leaf module"
```

---

### Task 2: Interceptor vocabulary, validation, and the seam helper

**Files:**
- Create: `src/execution/command-interceptor/index.ts`
- Test: `test/unit/execution/command-interceptor.test.ts`

**Interfaces:**
- Consumes: `GIT_ESCAPE_FLAGS` from `@/tools/git-flags` (Task 1).
- Produces, all from `@/execution/command-interceptor`:
  - `type Site = "git"`
  - `interface InterceptRequest { kind: "argv"; argv: readonly string[]; cwd: string; site: Site }`
  - `type InterceptResult = { kind: "unchanged" } | { kind: "rewritten"; argv: readonly string[]; provider: string } | { kind: "declined"; reason: string }`
  - `interface CommandInterceptor { provider: string; intercept(req): Promise<InterceptResult>; postProcess?(output: string, req: InterceptRequest): { output: string; notes?: Record<string, string> } }`
  - `validateRewrite(req: InterceptRequest, result: InterceptResult): InterceptResult`
  - `interceptArgv(argv: readonly string[], cwd: string, interceptor: CommandInterceptor | undefined): Promise<{ argv: readonly string[]; executed?: readonly string[]; provider?: string; rewritten: boolean }>`

`interceptArgv` is where the try/catch and validation live. It exists so `src/utils/git.ts`
grows by one call rather than twenty lines — see gate 3.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { CommandInterceptor, InterceptRequest, InterceptResult } from "@/execution/command-interceptor";
import { interceptArgv, validateRewrite } from "@/execution/command-interceptor";

const req: InterceptRequest = { kind: "argv", argv: ["git", "log", "--oneline"], cwd: "/repo", site: "git" };

function fake(result: InterceptResult | (() => never)): CommandInterceptor {
  return { provider: "rtk", intercept: async () => (typeof result === "function" ? result() : result) };
}

describe("validateRewrite", () => {
  test("passes a rewrite that only prefixes the provider binary", () => {
    const result: InterceptResult = { kind: "rewritten", argv: ["rtk", "git", "log", "--oneline"], provider: "rtk" };
    expect(validateRewrite(req, result)).toEqual(result);
  });

  test("declines a rewrite that changes any original token", () => {
    expect(validateRewrite(req, { kind: "rewritten", argv: ["rtk", "git", "log", "-p"], provider: "rtk" }).kind).toBe(
      "declined",
    );
  });

  test("declines a rewrite of the wrong length", () => {
    expect(
      validateRewrite(req, { kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" }).kind,
    ).toBe("declined");
  });

  test("declines a rewrite whose first token is not the named provider", () => {
    expect(
      validateRewrite(req, { kind: "rewritten", argv: ["other", "git", "log", "--oneline"], provider: "rtk" }).kind,
    ).toBe("declined");
  });

  test("declines an escape flag carried in from the ORIGINAL argv", () => {
    // The length and token checks pass here, so this is the only test that
    // actually reaches the escape-flag branch. A rewrite cannot INTRODUCE a
    // flag without failing an earlier check — this guards the case where the
    // original argv already carried one (R6).
    const escaped: InterceptRequest = { ...req, argv: ["git", "-C", "/elsewhere", "status"] };
    const out = validateRewrite(escaped, {
      kind: "rewritten",
      argv: ["rtk", "git", "-C", "/elsewhere", "status"],
      provider: "rtk",
    });
    expect(out.kind).toBe("declined");
  });

  test("passes unchanged and declined results straight through", () => {
    expect(validateRewrite(req, { kind: "unchanged" })).toEqual({ kind: "unchanged" });
    const declined: InterceptResult = { kind: "declined", reason: "no binary" };
    expect(validateRewrite(req, declined)).toEqual(declined);
  });
});

describe("interceptArgv", () => {
  test("returns the original argv when there is no interceptor", async () => {
    const out = await interceptArgv(["git", "log"], "/repo", undefined);
    expect(out).toEqual({ argv: ["git", "log"], rewritten: false });
  });

  test("returns the rewritten argv and what executed", async () => {
    const out = await interceptArgv(["git", "log"], "/repo", fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" }));
    expect(out.argv).toEqual(["rtk", "git", "log"]);
    expect(out.executed).toEqual(["rtk", "git", "log"]);
    expect(out.provider).toBe("rtk");
    expect(out.rewritten).toBe(true);
  });

  test("falls back to the original argv when the interceptor throws", async () => {
    // Fail open at REWRITE time (R3). A sick interceptor must not fail a command.
    const out = await interceptArgv(["git", "log"], "/repo", fake(() => {
      throw new Error("boom");
    }));
    expect(out.argv).toEqual(["git", "log"]);
    expect(out.rewritten).toBe(false);
  });

  test("falls back to the original argv when the rewrite fails validation", async () => {
    const out = await interceptArgv(["git", "log"], "/repo", fake({ kind: "rewritten", argv: ["rtk", "-C", "/x", "git", "log"], provider: "rtk" }));
    expect(out.argv).toEqual(["git", "log"]);
    expect(out.rewritten).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/execution/command-interceptor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * Generic command-interception seam. rtk is a consumer, not a concept here (R1).
 *
 * Argv-only by construction: R10 drops both shell-string sites, so a `shell`
 * request variant would be unreachable code and would drag R9's shell-rewrite
 * validation in with it.
 */
import { GIT_ESCAPE_FLAGS } from "@/tools/git-flags";

/** One member deliberately: adding a site should be a visible type change (R10). */
export type Site = "git";

export interface InterceptRequest {
  readonly kind: "argv";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly site: Site;
}

export type InterceptResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly argv: readonly string[]; readonly provider: string }
  | { readonly kind: "declined"; readonly reason: string };

export interface CommandInterceptor {
  readonly provider: string;
  intercept(req: InterceptRequest): Promise<InterceptResult>;
  /** Consulted ONLY for output of a command this interceptor actually rewrote. */
  postProcess?(output: string, req: InterceptRequest): { output: string; notes?: Record<string, string> };
}

export interface InterceptOutcome {
  readonly argv: readonly string[];
  readonly executed?: readonly string[];
  readonly provider?: string;
  readonly rewritten: boolean;
}

function decline(reason: string): InterceptResult {
  return { kind: "declined", reason };
}

/**
 * A rewrite may do exactly one thing: prefix the original argv with the
 * provider's own binary name. Anything else is refused.
 *
 * The argv analogue of R9's shell narrowing, and far tighter because it can be:
 * the mapping is static and built by nax, never a string parsed back out of a
 * subprocess.
 */
export function validateRewrite(req: InterceptRequest, result: InterceptResult): InterceptResult {
  if (result.kind !== "rewritten") return result;

  const { argv, provider } = result;
  if (argv.length !== req.argv.length + 1) return decline("rewrite must add exactly one leading token");
  if (argv[0] !== provider) return decline(`rewrite must lead with the provider binary, got ${argv[0]}`);
  for (const [i, token] of req.argv.entries()) {
    if (argv[i + 1] !== token) return decline(`rewrite altered token ${i}`);
  }
  if (argv.some((token) => GIT_ESCAPE_FLAGS.includes(token))) return decline("argv carries a git escape flag");
  return result;
}

/**
 * The whole seam, so call sites stay one line (see the file-size gate).
 *
 * Fails open at REWRITE time only (R3): if the interceptor is sick we run the
 * original. A rewritten command that actually RAN and failed keeps its exit
 * code — nax never re-runs raw to disambiguate one, because that makes
 * execution non-idempotent and can cost a full test-suite run.
 */
export async function interceptArgv(
  argv: readonly string[],
  cwd: string,
  interceptor: CommandInterceptor | undefined,
): Promise<InterceptOutcome> {
  if (interceptor === undefined) return { argv, rewritten: false };

  const req: InterceptRequest = { kind: "argv", argv, cwd, site: "git" };
  let outcome: InterceptResult;
  try {
    outcome = validateRewrite(req, await interceptor.intercept(req));
  } catch {
    outcome = decline("interceptor threw");
  }
  if (outcome.kind !== "rewritten") return { argv, rewritten: false };
  return { argv: outcome.argv, executed: outcome.argv, provider: outcome.provider, rewritten: true };
}
```

- [ ] **Step 4: Run tests and both structural gates**

Run: `CI=1 AGENT=1 bun test test/unit/execution/command-interceptor.test.ts && AGENT=1 bun run check:all && bun run test:coverage`
Expected: PASS. `check-import-cycles` must still report 0 — if it does not, something imported more than `@/tools/git-flags`.

- [ ] **Step 5: Commit**

```bash
git add src/execution/command-interceptor/index.ts test/unit/execution/command-interceptor.test.ts
git commit -m "feat(execution): command interceptor vocabulary, validation and seam"
```

---

### Task 3: Config block and its description

**Files:**
- Modify: `src/config/schemas-execution.ts` (`ExecutionConfigSchema`, line 198)
- Modify: `src/cli/config-descriptions.ts` (after line 64)
- Test: `test/unit/config/command-interceptor-config.test.ts`

The measured defaults are `enabled: false` (R7) and `verbs: ["log", "diff"]`. `status`,
`blame` and `show` are absent deliberately. **Do not add them.**

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

const base = {
  maxIterations: 10,
  iterationDelayMs: 0,
  costLimit: 5,
  maxStoriesPerFeature: 10,
  rectification: {},
  regressionGate: {},
};

describe("execution.commandInterceptor", () => {
  test("defaults to disabled with the measured verbs", () => {
    const parsed = ExecutionConfigSchema.parse(base);
    expect(parsed.commandInterceptor.enabled).toBe(false);
    expect(parsed.commandInterceptor.provider).toBe("rtk");
    expect(parsed.commandInterceptor.git.verbs).toEqual(["log", "diff"]);
  });

  test("has no failuresBeforeDisable key", () => {
    // There is no per-request I/O to fail: preflight runs once at construction
    // and a rewrite is a pure string prefix. A circuit breaker would be a
    // config key that can never fire. See Task 5.
    expect(() =>
      ExecutionConfigSchema.parse({ ...base, commandInterceptor: { failuresBeforeDisable: 3 } }),
    ).toThrow();
  });

  test("an empty verb list is valid and intercepts nothing", () => {
    const parsed = ExecutionConfigSchema.parse({ ...base, commandInterceptor: { git: { verbs: [] } } });
    expect(parsed.commandInterceptor.git.verbs).toEqual([]);
  });

  test("rejects an unknown key rather than stripping it", () => {
    expect(() => ExecutionConfigSchema.parse({ ...base, commandInterceptor: { sites: ["git"] } })).toThrow();
  });
});
```

Note on that last test: config schemas here normally strip unknown keys, and that is
intended elsewhere. This block is `.strict()` specifically because `sites` was a real key
in an earlier revision of the spec — someone carrying it forward from a draft must get an
error, not silence.

If `base` above fails to parse for unrelated reasons, read the existing
`test/unit/config/` suites and copy a known-good fixture rather than guessing at required
fields.

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/config/command-interceptor-config.test.ts`
Expected: FAIL — `commandInterceptor` is undefined.

- [ ] **Step 3: Add the schema**

```typescript
/**
 * Command interception. Opt-in (R7): interception changes what the agent sees,
 * so it must not switch on merely because the provider binary is installed.
 *
 * `git.verbs` carries MEASURED values (US-001 run 4): `log` at 85.0% and `diff`
 * at 27.9% delivered savings. `status` (47% of ~1 KB) and `blame`
 * (byte-identical) were measured and excluded; `show` is disqualified on
 * exit-code divergence. Read the results doc before changing this list.
 */
const CommandInterceptorConfigSchema = z
  .object({
    provider: z.string().min(1).default("rtk"),
    enabled: z.boolean().default(false),
    git: z.object({ verbs: z.array(z.string().min(1)).default(["log", "diff"]) }).default({ verbs: ["log", "diff"] }),
  })
  .strict();
```

Add to `ExecutionConfigSchema`:

```typescript
  commandInterceptor: CommandInterceptorConfigSchema.default({
    provider: "rtk",
    enabled: false,
    git: { verbs: ["log", "diff"] },
  }),
```

- [ ] **Step 4: Add the descriptions**

```typescript
  "execution.commandInterceptor": "Route tool commands through an external filter to shrink their output. Off by default.",
  "execution.commandInterceptor.enabled":
    "Master switch for command interception. Off by default: interception changes what the agent sees, so it does not switch on merely because the provider is installed. This is the only switch — there is no CLI flag or env override. Flip it here, run the same story twice, and compare cost-ledger spend to judge whether it earns its place.",
  "execution.commandInterceptor.provider": "Which interceptor to use. Only 'rtk' exists today.",
  "execution.commandInterceptor.git.verbs":
    "Git subcommands eligible for interception. Measured values: log and diff. status and blame measured no benefit; show is excluded for changing git's exit code.",
```

- [ ] **Step 5: Run and commit**

Run: `CI=1 AGENT=1 bun test test/unit/config/ && AGENT=1 bun run check:all`

If a config-display or snapshot test fails, it asserts on the full field list — update its
fixture; do not weaken the schema.

```bash
git add src/config/schemas-execution.ts src/cli/config-descriptions.ts test/unit/config/command-interceptor-config.test.ts
git commit -m "feat(config): opt-in command interceptor block with measured git verbs"
```

---

### Task 4: Wire the Git tool and ledger what executed

**Files:**
- Modify: `src/tools/git.ts` (add `_gitToolDeps`; intercept at line 319; return `audit`)
- Modify: `src/tools/registry.ts` (make `ToolResult.audit.target` optional)
- Modify: `src/utils/git.ts` (one optional `argvOverride` parameter — see Step 3)
- Modify: `src/tools/index.ts` (re-export `_gitToolDeps`)
- Test: `test/unit/tools/git-interception.test.ts`

**Interfaces:**
- Consumes: `interceptArgv`, `CommandInterceptor` from Task 2.
- Produces: `export const _gitToolDeps = { interceptor: undefined as CommandInterceptor | undefined }` in `@/tools/git`.

🚨 **Read this before touching anything. It is the mistake two earlier revisions of this
plan made, and it is a silent correctness break, not a performance regression.**

The seam goes in **`src/tools/git.ts` at line 319** — the `Git` tool's own call. It does
**not** go in `gitWithTimeout` (`src/utils/git.ts:71`). That function has **52 callers**,
and at least nine of them run `log`/`diff` and then machine-parse the stdout:

| caller | what it parses |
|---|---|
| `src/verification/smart-runner.ts:484,550` | filenames → which tests to run |
| `src/verification/changed-line-ranges.ts:44` | unified diff hunks |
| `src/verification/flake-baseline-diff.ts:54` | filenames → flake baseline |
| `src/review/runner/index.ts:207` | filenames → what to review |
| `src/worktree/merge.ts:366` | filenames → merge-conflict detection |
| `src/finish/review/audit-gaps.ts:88` | filenames |
| `src/utils/git.ts:221` | story commits |
| `src/context/engine/providers/git-history.ts:73` | context provider |

rtk exists to compact output. Compacting a `--name-only` list that nax splits into
filenames means scoped test selection runs the wrong tests and merge-conflict detection
misses files — with no error anywhere. **Nothing is lost by narrowing:** those outputs
never reach a model, so there were never tokens to save there.

`GitCommit` (`src/tools/git-commit.ts:57,62`) is the *other* agent-facing tool that shells
out to git, and it is **not** intercepted: US-003 excludes it, and its verbs (`add`,
`commit`) are not in `git.verbs` anyway. So the precise invariant is *the `Git` tool's
output is the only thing this feature touches* — not "the only agent-facing git".

`src/tools/git.ts` is 328 lines against the 600 cap, so unlike `src/utils/git.ts` (579)
there is ample headroom here. That is a consequence of the correct design, not the reason
for it.

- [ ] **Step 1: Write the failing test**

`makeSpawn(fn).spawn` is assignable to every `_xDeps.spawn`; `withDepsRestore` restores
after each test. Canonical `_gitDeps` example: `test/unit/utils/auto-commit.test.ts:34`.
No cast is needed and none is allowed.

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { _gitToolDeps, gitTool } from "@/tools/git";
import { _gitDeps } from "@/utils/git";

function fake(result: InterceptResult): CommandInterceptor {
  return { provider: "rtk", intercept: async () => result };
}

/** A rewriter that actually passes validateRewrite: prefix, derived from the request. */
function prefixer(): CommandInterceptor {
  return {
    provider: "rtk",
    intercept: async (req) => ({ kind: "rewritten", argv: ["rtk", ...req.argv], provider: "rtk" }),
  };
}

describe("Git tool interception", () => {
  const calls: string[][] = [];

  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_gitToolDeps, ["interceptor"]);
  beforeEach(() => {
    calls.length = 0;
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;
  });

    // ToolRunContext requires all four (src/tools/registry.ts:35-55). This shape is
  // lifted from test/unit/tools/git-commit.test.ts:23 — reuse it, do not invent one.
  const ctx = () => ({ root: "/repo", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

  test("spawns the original argv when no interceptor is installed", async () => {
    _gitToolDeps.interceptor = undefined;
    await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("git");
  });

  test("spawns the rewritten argv and reports what executed", async () => {
    // The fake MUST derive argv from the request. A hardcoded literal fails
    // validateRewrite's length check, silently degrades to "declined", and the
    // test then passes for the wrong reason.
    _gitToolDeps.interceptor = prefixer();
    const result = await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("rtk");
    expect(result.audit?.executed?.[0]).toBe("rtk");
  });

  test("spawns the original argv when the interceptor declines", async () => {
    _gitToolDeps.interceptor = fake({ kind: "declined", reason: "no binary" });
    const result = await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });

  test("a rewritten command that runs and fails keeps its non-zero exit code", async () => {
    // R3's other half: nax never re-runs raw to disambiguate an exit code.
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return { stdout: "", stderr: "fatal: bad revision", exitCode: 128 };
    }).spawn;
    _gitToolDeps.interceptor = prefixer();

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBe(true);
    expect(calls[0]?.[0]).toBe("rtk"); // it really was the rewritten command that ran
    expect(calls).toHaveLength(1); // and it was NOT re-run raw
  });

  test("an internal gitWithTimeout caller is NEVER intercepted", async () => {
    // The guard on this task's whole reason for existing. Internal callers
    // machine-parse their stdout; compacting it breaks them silently.
    _gitToolDeps.interceptor = fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" });

    const { gitWithTimeout } = await import("@/utils/git");
    await gitWithTimeout(["diff", "--name-only"], "/repo");

    expect(calls.at(-1)?.[0]).toBe("git");
  });
});
```

The `ctx()` shape above is lifted from `test/unit/tools/git-commit.test.ts:23`, which is the
fixture to copy. Note `test/unit/tools/git.test.ts` has **no** `ToolRunContext` fixture and
never calls `gitTool.run` — it exercises `buildGitArgv` against real temp repos — so do not
go looking there for one.

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/tools/git-interception.test.ts`
Expected: FAIL — `_gitToolDeps` does not exist.

- [ ] **Step 3: Implement**

Add the deps object near the top of `src/tools/git.ts`, following the `_grepDeps`
convention at `src/tools/grep.ts:33`:

```typescript
/**
 * Interception seam for the Git TOOL only.
 *
 * Deliberately here and not on `_gitDeps`: `gitWithTimeout` is shared by 52
 * callers, nine of which machine-parse `log`/`diff` stdout. Compacting their
 * output breaks them silently. Only this tool's output is agent-facing.
 */
export const _gitToolDeps = { interceptor: undefined as CommandInterceptor | undefined };
```

At line 319, intercept between `buildGitArgv`'s result and the call:

```typescript
      const intercepted = await interceptArgv(["git", ...built], ctx.root, _gitToolDeps.interceptor);
      const { stdout, stderr, exitCode } = await gitWithTimeout(
        [...intercepted.argv].slice(1),
        ctx.root,
        undefined,
        ctx.maxBytes,
      );
```

⚠️ **`gitWithTimeout` prepends `"git"` itself** (`src/utils/git.ts:77` spawns
`["git", ...args]`). So the snippet above is wrong on the rewritten path, and this is the
trap in this task: `intercepted.argv` is `["rtk","git",...built]`, `.slice(1)` leaves
`["git",...built]`, and `gitWithTimeout` turns that into **`git git log …`** — the rewrite
never runs rtk and the command fails instead. The un-rewritten path round-trips correctly
(`["git",...built] → .slice(1) → built`), which is why the disabled default stays
byte-identical.

**The resolution, already decided — do not re-litigate it.** Give `gitWithTimeout` an
optional full-argv parameter and have the `Git` tool pass one:

```typescript
export async function gitWithTimeout(
  args: string[],
  workdir: string,
  timeoutMs: number = _gitDeps.gitTimeoutMs,
  maxBytes?: number,
  /** Full argv INCLUDING argv[0]. Callers that must control argv[0] pass this;
   *  everyone else gets ["git", ...args] as before. */
  argvOverride?: readonly string[],
): Promise<...> {
  const proc = _gitDeps.spawn([...(argvOverride ?? ["git", ...args])], { ... });
```

Roughly three lines in a 579/600-line file, and it adds **no** interception to
`src/utils/git.ts` — no import of the seam, no behaviour change for the other 51 callers,
who never pass the parameter. The call site then becomes:

```typescript
      const intercepted = await interceptArgv(["git", ...built], ctx.root, _gitToolDeps.interceptor);
      const { stdout, stderr, exitCode } = await gitWithTimeout(
        built,
        ctx.root,
        undefined,
        ctx.maxBytes,
        intercepted.argv,
      );
```

The alternative — calling `_gitDeps.spawn` directly, as `src/tools/grep.ts:129` does — was
rejected: `src/tools/git.ts`'s own header comment (lines 12-15) says it reuses
`gitWithTimeout` precisely because `git log -p` is the output that fills a 64 KB pipe
buffer and deadlocks a naive drain. Duplicating that contract in a second place to save a
parameter is a bad trade.

- [ ] **Step 4: Widen the audit field and return it**

In `src/tools/registry.ts`, change `readonly target: "repoRoot" | "package";` to
`readonly target?: "repoRoot" | "package";`, noting in its doc comment that a git rewrite
sets `executed` with no `target` — the repoRoot/package distinction does not apply to a git
read. Verified safe: `src/tools/runtime.ts:139` already types both fields optional
internally, `run-command-exec.ts:126` supplies both, and no test requires `target`.

Return `audit` from `gitTool.run` **only** when a rewrite happened. Note `executed` is
required on `ToolResult.audit` but optional on `InterceptOutcome`, so it must be narrowed
or TS2322 fires under `strict`:

```typescript
const audit = intercepted.executed !== undefined ? { executed: intercepted.executed } : undefined;
return { content, ...(audit !== undefined ? { audit } : {}) };
```

**Also add `_gitToolDeps` to the `src/tools/index.ts` barrel**, beside `_grepDeps` at line
11. Without it, Task 6's composition site cannot import it: `src/tools/index.ts` exists, so
`@/tools/git` is an alias-into-internal import and `check-alias-internals` rejects it from
`src/` (only `test/` is exempt). Do **not** try to set the ledger's `provider`
field — that comes from `opts.providerIdByTool`, a map of *provider-tool* names, and `Git`
is not one.

- [ ] **Step 5: Run everything**

Run: `CI=1 AGENT=1 bun run test && AGENT=1 bun run check:all && bun run test:coverage`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(tools): intercept the Git tool's argv and ledger what executed"
```

---

### Task 5: The rtk provider

**Files:**
- Create: `src/execution/interceptors/rtk/index.ts`
- Test: `test/unit/execution/interceptors/rtk.test.ts`

**Interfaces:**
- `interface InterceptorState { enabled: boolean; version: string | null; verbs: readonly string[] }`
- `interface RtkDeps { which(bin: string): string | null; version(): string | null; record(state: InterceptorState): void }`
- `createRtkInterceptor(opts: { enabled: boolean; verbs: readonly string[]; _deps?: Partial<RtkDeps> }): CommandInterceptor`

**Settled semantics. Implement exactly these.**

1. **Preflight is eager, at construction, and only when `enabled`.** It calls `which("rtk")`
   and then `version()`. Once per run, one process, not on a hot path. It must be
   synchronous (`Bun.spawnSync`) because `createRtkInterceptor` returns a
   `CommandInterceptor`, not a promise.
2. **`record(state)` fires exactly once, at construction, after preflight**, whatever
   `enabled` is. Enabled → `version` is the resolved string. Disabled → nothing is probed
   and `version` is `null`, which is honest because nothing ran.
3. **`enabled: false`** → `intercept()` returns `{ kind: "unchanged" }` always; nothing is
   ever probed.
4. **A missing binary** (`which` → `null`) is terminal: every request returns `declined`,
   and the binary is never probed again. A user without rtk installed must not accumulate
   "failures".
5. **Construction never throws.** A throwing `which` or `version` is caught and degrades to
   the same terminal-declined state as a missing binary. A crash here takes down run setup.
6. The verb is `argv[1]` (`argv[0]` is always `"git"`). Not in `verbs` → `unchanged`.
7. Rewrite is a static prefix: `["rtk", ...req.argv]`. **Never** call `rtk rewrite` — scope
   decision 2.

**There is no circuit breaker, and no `failuresBeforeDisable`.** An earlier revision
specified both. They cannot work: preflight runs once at construction and `intercept()`
performs **no I/O at all** — a rewrite is a pure string prefix and `postProcess` is pure
string work — so there is nothing for a breaker to protect against. A pure
function that throws throws *identically every time*, and fail-open (R3) already runs the
original command in that case — a breaker would change nothing except add a config key that
can never usefully fire, the same objection this plan uses to drop `notes` in Task 6. If a future change introduces
per-request I/O (calling `rtk rewrite`, say), reintroduce the breaker **with** it.

**The `record` sink.** The default implementation writes one structured log line through
`getSafeLogger()` — the same seam `src/utils/git.ts:321` uses — at info level, with
`enabled`, `version` and `verbs` as fields. This is what makes the spec §7 A/B comparable:
a run with interception off must be distinguishable in its artifacts from a run that made
no git calls, and a version change between arms invalidates the comparison (H6) and must be
visible after the fact rather than inferred.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { InterceptorState } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = (verb: string) => ({
  kind: "argv" as const,
  argv: ["git", verb, "--oneline"],
  cwd: "/repo",
  site: "git" as const,
});
const present = { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} };
const make = (o: Partial<Parameters<typeof createRtkInterceptor>[0]> = {}) =>
  createRtkInterceptor({ enabled: true, verbs: ["log"], _deps: present, ...o });

describe("rtk interceptor", () => {
  test("rewrites a verb in the configured list", async () => {
    expect(await make().intercept(req("log"))).toEqual({
      kind: "rewritten",
      argv: ["rtk", "git", "log", "--oneline"],
      provider: "rtk",
    });
  });

  test("leaves a verb outside the list unchanged", async () => {
    expect((await make().intercept(req("diff"))).kind).toBe("unchanged");
  });

  test("an empty verb list intercepts nothing", async () => {
    expect((await make({ verbs: [] }).intercept(req("log"))).kind).toBe("unchanged");
  });

  test("never probes the binary when disabled", async () => {
    let probed = false;
    const i = make({
      enabled: false,
      _deps: { ...present, which: () => { probed = true; return "/usr/bin/rtk"; } },
    });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
    expect(probed).toBe(false);
  });

  test("records the real version at construction when enabled", () => {
    const states: InterceptorState[] = [];
    make({ _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: true, version: "0.45.0", verbs: ["log"] }]);
  });

  test("still records, with a null version, when disabled", () => {
    const states: InterceptorState[] = [];
    make({ enabled: false, _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: false, version: null, verbs: ["log"] }]);
  });

  test("a missing binary declines forever and is probed exactly once", async () => {
    let probes = 0;
    const i = make({ _deps: { ...present, which: () => { probes += 1; return null; } } });
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect(probes).toBe(1);
  });

  test("construction never throws, and a throwing probe degrades to declined", async () => {
    // A throw here would take down run setup (Task 6 installs this in setupRun).
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({ _deps: { ...present, which: () => { throw new Error("boom"); } } });
    }).not.toThrow();
    expect((await i!.intercept(req("log"))).kind).toBe("declined");
  });

  test("construction never throws when the version probe is the thing that fails", async () => {
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({ _deps: { ...present, version: () => { throw new Error("boom"); } } });
    }).not.toThrow();
    expect((await i!.intercept(req("log"))).kind).toBe("declined");
  });
});
```

The `i!` non-null assertions above are on a local in a test, not a cast — `check-test-escape-hatches` counts `as X` casts, not `!`. If you prefer, restructure with a helper that returns the interceptor.

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement to the semantics above**

- [ ] **Step 4: Run and commit**

```bash
CI=1 AGENT=1 bun test test/unit/execution/ && AGENT=1 bun run check:all && bun run test:coverage
git add -A && git commit -m "feat(execution): rtk interceptor with eager preflight and state record"
```

---

### Task 6: Strip rtk's hints, switch it on, and fence it

**Files:**
- Modify: `src/execution/interceptors/rtk/index.ts` (add `postProcess`)
- Modify: `src/tools/git.ts` (guarded `postProcess` call)
- Modify: `src/execution/lifecycle/run-setup.ts` (install the interceptor)
- Test: `test/unit/execution/interceptors/rtk-postprocess.test.ts`
- Test: `test/unit/tools/git-interception.test.ts` (extend)
- Test: `test/unit/execution/command-interceptor.test.ts` (extend with the fence)

rtk appends hints like `[full diff: rtk git diff --no-compact]` and
`[+12 hidden: rtk recall 3f9c2a81d4e7]`. A nax agent has no shell, so these are
instructions it cannot follow — passing them through reproduces nax#1800 and burns turns
on denials (R4).

**`postProcess` returns `{ output }` only — no `notes`.** The spec's `notes` channel exists
to carry a recall hash to US-006's `Recall` tool, and US-006 is deferred (scope decision 4).
A field nothing reads is a field that rots. Add it back with US-006, where it will have a
consumer and a test.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = { kind: "argv" as const, argv: ["git", "log"], cwd: "/repo", site: "git" as const };
const present = { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} };

/** Narrows `postProcess?` once, so no test needs a non-null assertion. */
function postProcess() {
  const { postProcess: fn } = createRtkInterceptor({
    enabled: true,
    verbs: ["log"],
    _deps: present,
  });
  if (fn === undefined) throw new Error("rtk interceptor must define postProcess");
  return fn;
}

describe("rtk postProcess", () => {
  test("strips a full-diff hint and the newline before it", () => {
    expect(postProcess()("diff body\n[full diff: rtk git diff --no-compact]", req).output).toBe("diff body");
  });

  test("strips a hidden-lines hint", () => {
    const { output } = postProcess()("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", req);
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
  });

  test("leaves output with no hints untouched", () => {
    expect(postProcess()("plain body", req).output).toBe("plain body");
  });

  test("does not eat trailing whitespace when there is no hint to strip", () => {
    // Stripping is hint-shaped, not a general trim: trimEnd happens later at
    // the call site, and postProcess must not pre-empt it.
    expect(postProcess()("plain body\n\n", req).output).toBe("plain body\n\n");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk-postprocess.test.ts`
Expected: FAIL — `postProcess` is undefined.

- [ ] **Step 3: Implement `postProcess` and the guarded call site**

In `src/tools/git.ts`, call `postProcess` **only** when `intercepted.rewritten`, inside a
`try`/`catch` that falls back to the raw output.

**Order matters, so fix it deliberately:** line 323 already does `stdout.trimEnd()` and
then `truncate(body, ctx.maxBytes)`. Run `postProcess` **before** both — stripping a hint
changes what the trailing whitespace and the byte budget apply to, and running it after
`truncate` would try to strip a hint that truncation may have already cut in half. Add a
test asserting a hint is stripped from output that also needs trimming.

Add to `test/unit/tools/git-interception.test.ts`:

```typescript
test("a throwing postProcess degrades to the raw output", async () => {
  _gitDeps.spawn = makeSpawn(() => "body\n[full diff: rtk git diff --no-compact]").spawn;
  _gitToolDeps.interceptor = {
    provider: "rtk",
    intercept: async (r) => ({ kind: "rewritten", argv: ["rtk", ...r.argv], provider: "rtk" }),
    postProcess: () => {
      throw new Error("post-process blew up");
    },
  };

  const result = await gitTool.run({ subcommand: "log" }, ctx());

  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("body");
});

test("postProcess is never consulted for a command that was not rewritten", async () => {
  let called = false;
  _gitDeps.spawn = makeSpawn(() => "body").spawn;
  _gitToolDeps.interceptor = {
    provider: "rtk",
    intercept: async () => ({ kind: "unchanged" }),
    postProcess: () => {
      called = true;
      return { output: "" };
    },
  };

  await gitTool.run({ subcommand: "log" }, ctx());

  expect(called).toBe(false);
});
```

⚠️ **Known limitation — record it in a code comment, do not solve it here.**
`gitWithTimeout` bounds stdout with `ctx.maxBytes` before `postProcess` sees it, so a
trailing hint on a very large output can be truncated mid-string and escape stripping. That
is the case the feature most targets. Fixing it means moving the bound after
post-processing, which changes the drain contract and is its own change.

- [ ] **Step 4: Switch it on**

Install the interceptor in **`setupRun`** (`src/execution/lifecycle/run-setup.ts:188`) —
the config arrives as `options.config` (`RunSetupOptions`), `NaxConfig` is imported at
line 16, and the file already composes run-level deps via `_runSetupDeps` (line 40).

⚠️ Verify before writing: confirm `setupRun` runs **before** any `Git` tool call in a run.
If it does not, find the composition point that does — the requirement is "once per run,
before the first tool dispatch", not this specific function.

```typescript
const ci = config.execution.commandInterceptor;
_gitToolDeps.interceptor = createRtkInterceptor({
  enabled: ci.enabled,
  verbs: ci.git.verbs,
});
```

Install it unconditionally and let `enabled` govern behaviour — that way the state is
recorded on every run, which is what makes the spec §7 A/B comparable (a run with
interception off must be distinguishable in its artifacts from a run that made no git
calls).

**This is the only step that makes `enabled: true` do anything.** Until it lands the
feature is inert.

Add an integration test proving that with `enabled: false` no rewrite occurs, and with
`enabled: true` and rtk absent every command still succeeds unchanged. Put it in
`test/unit/execution/lifecycle/` mirroring the source, per
`.nax/rules/test-architecture.md:36`.

- [ ] **Step 5: Add the fence**

Add as a `describe` block inside `test/unit/execution/command-interceptor.test.ts` — not a
standalone file (`.nax/rules/test-architecture.md:57`).

**The fence checks imports, not substrings.** Two earlier revisions used
`text.includes("rtk")`, which fails on any *comment* mentioning rtk — including the
comments this plan itself instructs you to write. R1 is about dependency, so test
dependency:

```typescript
import { describe, expect, test } from "bun:test";

/** Only these may IMPORT the rtk provider. Naming rtk in a comment or a config default is fine. */
const MAY_IMPORT_RTK = new Set(["execution/lifecycle/run-setup.ts"]);

/**
 * Matches the alias form AND any relative spelling — `run-setup.ts` already
 * uses relative imports for its siblings (`../helpers`, `../crash-recovery`),
 * so an alias-only regex would match nothing and pass vacuously.
 */
const IMPORTS_RTK = /from\s+["'](?:@\/execution|\.{1,2}(?:\/\.\.)*)\/?.*interceptors\/rtk(?:\/index)?["']/;

describe("R10 / R1: interception stays where it belongs", () => {
  test("the Git tool is the only interception site", async () => {
    for (const path of ["src/quality/runner.ts", "src/verification/executor.ts", "src/utils/git.ts"]) {
      const source = await Bun.file(path).text();
      expect(source).not.toContain("interceptArgv");
      expect(source).not.toContain("CommandInterceptor");
    }
  });

  test("nothing but the composition site imports the rtk provider (R1)", async () => {
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: "src" })) {
      if (rel.startsWith("execution/interceptors/rtk/")) continue;
      if (MAY_IMPORT_RTK.has(rel)) continue;
      const source = await Bun.file(`src/${rel}`).text();
      if (IMPORTS_RTK.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the fence is not vacuous — the composition site really does import it", async () => {
    // Without this, a relative import spelling makes the test above pass by
    // matching nothing at all, and the allowlist becomes decorative.
    for (const rel of MAY_IMPORT_RTK) {
      expect(IMPORTS_RTK.test(await Bun.file(`src/${rel}`).text())).toBe(true);
    }
  });
});
```

Note the first test now also guards `src/utils/git.ts` — that is the seam location two
earlier revisions got wrong, and this is what stops a future change from moving it back.

- [ ] **Step 6: Run everything and commit**

```bash
CI=1 AGENT=1 bun run test && AGENT=1 bun run check:all && bun run test:coverage
git add -A && git commit -m "feat(execution): strip rtk hints and activate interception from config"
```

---

## Definition of done

All six tasks committed, `check:all` and the full suite green, and:

- With `enabled: false` (the default) every git call spawns exactly what it does today.
- Under **`nax run`** with `enabled: true` and rtk installed, **the `Git` tool's** `log` and
  `diff` calls spawn through rtk (verify the spawned argv really begins `rtk`, not
  `git git` — see Task 4 Step 3), the ledger records what executed, and no rtk hint string
  reaches the agent.
- Under entry points that do **not** call `setupRun` (`nax finish`, `nax plan`, acceptance
  and debate flows), `_gitToolDeps.interceptor` stays `undefined` and interception simply
  does not apply. That is fail-safe and accepted for this plan; widening it means moving the
  install to `resolveCodingToolSupport` (`src/agents/coding-tool-support.ts:177`), which is
  a bigger change than this feature warrants until the A/B justifies it.
- **Every internal `gitWithTimeout` caller still spawns raw git**, whatever `enabled` says.
- With `enabled: true` and rtk **absent**, every command still runs and succeeds.

## The thing that decides whether any of this ships

Everything above is the cost of **finding out**, not a committed build. Per spec §7:

> Run the same story with `enabled: false` and `enabled: true` and compare cost-ledger spend and turn counts.

The measurement in the results doc is **bytes of command output, not billed tokens** — rtk
ships no tokenizer and estimates tokens as `bytes / 4`. nax's cost ledger is the authority.
Run that A/B once Task 6 lands, using Task 5's per-run state record to tell the arms apart.

Note the measurement over-states what this feature can deliver: it sampled `git log`/`diff`
as *shapes*, but only the `Git` tool's calls are intercepted, and the agent issues fewer of
those than nax issues internally. Expect less than the headline 85%/28%.

If the A/B is unconvincing, the honest outcome is to leave `enabled: false` permanently or
delete the feature. Say so plainly rather than shipping it on the strength of a green suite.
