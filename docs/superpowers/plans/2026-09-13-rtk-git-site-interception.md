# rtk Command Interception — Git Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route nax's `Git` tool calls through rtk for two measured verbs, behind an opt-in config flag, without any nax module outside one file knowing rtk exists.

**Architecture:** A generic `CommandInterceptor` seam consulted by `gitWithTimeout` between argv construction and spawn. One provider implements it for rtk as a static per-verb argv prefix. Every rewrite is validated, ledgered, and bounded by a circuit breaker. With the interceptor disabled — the default — every call site is byte-identical to today.

**Tech Stack:** TypeScript strict, Bun (`Bun.spawn`, `Bun.which`), `bun:test`, Biome, zod (config schemas).

**Spec:** `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md`
**Evidence:** `docs/superpowers/results/2026-09-13-rtk-savings-measurement.md`

## STOP — start from the right commit

This plan and the ruling it implements are **not on `origin/main` yet**. At the time of
writing they live on branch `feat/rtk-site-scope-ruling`:

| commit | what it carries |
|---|---|
| `580e9d9e3` | US-001's measured results, and **R10** — the ruling that defines this plan's scope |
| `865bbe406` | this plan |

**If you read the spec from `origin/main` you will build the wrong thing.** The version on
main still describes three interception sites, still carries a `sites` config key, and
still lists predicted verb values that the measurement removed. It contains no R10 at all.

Before Task 1:

```bash
git log --oneline origin/main..HEAD          # expect the two commits above, or none if merged
grep -c "R10" docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md
```

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

- **R10 is binding: do not add an interception seam to `src/quality/runner.ts` or `src/verification/executor.ts`.** Those sites are dropped. Task 3 adds a test that fails if anyone re-adds one. `RunCommand` is therefore NOT covered by this feature — it reaches the shell through the dropped quality site.
- **R1: no nax module outside `src/execution/interceptors/rtk.ts` may mention rtk.** Not the git tool, not config validation, not the ledger. The string `"rtk"` appearing anywhere else in `src/` is a review failure.
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
(`@/execution/command-interceptor` where `command-interceptor/index.ts` exists) is legal;
an internal path is not. Hence the nested-directory layout below. Precedents:
`src/execution/checkpoint/`, `src/execution/helpers/`, `src/review/runner/`.

**2. The import-cycle gate** (`scripts/check-import-cycles.ts`, baseline 0). A cycle here
is **certain, not possible**: `src/tools/git.ts:18` already imports `gitWithTimeout` from
`@/utils/git`, so the moment `utils/git` imports anything that reaches `tools/git` the
cycle closes. This is why `GIT_ESCAPE_FLAGS` moves to a leaf in Task 1 — that task exists
solely to make Tasks 2-4 possible.

**3. The file-size gate** (`scripts/check-file-sizes.ts`, `SRC_LIMIT = 600`).
`src/utils/git.ts` is **579 lines** and is **not** in `scripts/baselines/file-sizes-baseline.json`,
so there is no baseline escape: crossing 600 is a new violation and hard-fails. That is
**21 lines of headroom for this entire feature.** Every design choice below that looks
indirect is buying headroom — the interception logic lives in the interceptor module and
`src/utils/git.ts` gains a single call.

**4. `as never` is banned** (`biome-plugins/no-as-never.grit`, active repo-wide via
`biome.json`), as is `as unknown as` in `test/`. `test/helpers/spawn.ts` exists so that you
never need either.

### Module layout

| File | Why it is shaped this way |
|---|---|
| `src/tools/git-flags/index.ts` | Leaf with **no imports**. Holds `GIT_ESCAPE_FLAGS`. Breaks the cycle and satisfies the barrel gate. |
| `src/execution/command-interceptor/index.ts` | Nested barrel → `@/execution/command-interceptor` is a legal exact match. Holds the vocabulary, `validateRewrite`, and `interceptArgv`. |
| `src/execution/interceptors/rtk/index.ts` | Nested barrel, same reason. The only file that knows how to talk to rtk. |
| `src/utils/git.ts` | Gains ~8 lines: one `interceptArgv` call and one guarded `postProcess` call. |

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
| US-003 wiring | Task 4 | The git site only. The fence in Task 6 Step 5 keeps it that way. |
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
    expect(parsed.commandInterceptor.failuresBeforeDisable).toBe(3);
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
    failuresBeforeDisable: z.number().int().positive().default(3),
  })
  .strict();
```

Add to `ExecutionConfigSchema`:

```typescript
  commandInterceptor: CommandInterceptorConfigSchema.default({
    provider: "rtk",
    enabled: false,
    git: { verbs: ["log", "diff"] },
    failuresBeforeDisable: 3,
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
  "execution.commandInterceptor.failuresBeforeDisable":
    "Interception failures tolerated before the provider is disabled for the rest of the run.",
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

### Task 4: Wire the git site and ledger what executed

**Files:**
- Modify: `src/utils/git.ts` (`_gitDeps` line 41, `gitWithTimeout` line 71)
- Modify: `src/tools/registry.ts` (make `ToolResult.audit.target` optional)
- Modify: `src/tools/git.ts` (return `audit: { executed }` when a rewrite happened)
- Test: `test/unit/utils/git-interception.test.ts`

**Interfaces:**
- Consumes: `interceptArgv`, `CommandInterceptor` from Task 2.
- Produces: `_gitDeps.interceptor?: CommandInterceptor`; `gitWithTimeout` returns `{ stdout, stderr, exitCode, executed?, provider? }`.

**On US-008.** `sink.record()` (`src/tools/runtime.ts:172-184`) already accepts `executed`,
and its internal signature at line 139 already types **both** audit fields as optional.
Only the public `ToolResult.audit` (`src/tools/registry.ts:29-32`) requires `target`, which
is `"repoRoot" | "package"` — a notion that does not apply to a git read. So widening that
one field to optional is the whole change. Do **not** invent a `target` value, and do not
try to set the ledger's `provider` field: that comes from `opts.providerIdByTool`, a map of
*provider-tool* names, which `Git` is not. The provider name travels in the log line.

- [ ] **Step 1: Write the failing test**

Uses the repo's typed spawn doubles — `makeSpawn(fn).spawn` is assignable to every
`_xDeps.spawn`, and `withDepsRestore` restores after each test. The canonical example
against `_gitDeps` is `test/unit/utils/auto-commit.test.ts:34`. No cast is needed, and none
is allowed.

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { _gitDeps, gitWithTimeout } from "@/utils/git";

function fake(result: InterceptResult): CommandInterceptor {
  return { provider: "rtk", intercept: async () => result };
}

describe("gitWithTimeout interception", () => {
  const calls: string[][] = [];

  withDepsRestore(_gitDeps, ["spawn", "interceptor"]);
  beforeEach(() => {
    calls.length = 0;
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;
  });

  test("spawns the original argv when no interceptor is configured", async () => {
    _gitDeps.interceptor = undefined;
    await gitWithTimeout(["log"], "/repo");
    expect(calls).toEqual([["git", "log"]]);
  });

  test("spawns the rewritten argv and reports what executed", async () => {
    _gitDeps.interceptor = fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(calls).toEqual([["rtk", "git", "log"]]);
    expect(result.executed).toEqual(["rtk", "git", "log"]);
    expect(result.provider).toBe("rtk");
  });

  test("spawns the original argv when the interceptor declines", async () => {
    _gitDeps.interceptor = fake({ kind: "declined", reason: "no binary" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(calls).toEqual([["git", "log"]]);
    expect(result.executed).toBeUndefined();
  });

  test("a rewritten command that runs and fails keeps its non-zero exit code", async () => {
    // R3's other half: nax never re-runs raw to disambiguate an exit code.
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return { stdout: "", stderr: "fatal", exitCode: 2 };
    }).spawn;
    _gitDeps.interceptor = fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(result.exitCode).toBe(2);
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/utils/git-interception.test.ts`
Expected: FAIL — `gitWithTimeout` ignores the interceptor.

- [ ] **Step 3: Implement, minimally**

`src/utils/git.ts` has **21 lines of headroom**. Keep this tight; the logic lives in Task 2's
module.

Add to `_gitDeps` (line 41) — it is an untyped object literal, so give the optional
property an explicit type by annotating the literal or seeding the key as `undefined`:

```typescript
export const _gitDeps = {
  spawn,
  getSafeLogger,
  gitTimeoutMs: GIT_TIMEOUT_MS,
  timeoutRetryGitTimeoutMs: TIMEOUT_RETRY_GIT_TIMEOUT_MS,
  interceptor: undefined as CommandInterceptor | undefined,
};
```

In `gitWithTimeout`, replace the spawn's argv:

```typescript
  const intercepted = await interceptArgv(["git", ...args], workdir, _gitDeps.interceptor);
  const proc = _gitDeps.spawn([...intercepted.argv], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
```

and include `executed`/`provider` in each return path.

- [ ] **Step 4: Widen the audit field and return it**

In `src/tools/registry.ts`, change `readonly target: "repoRoot" | "package";` to
`readonly target?: "repoRoot" | "package";` and extend its doc comment to say a git rewrite
sets `executed` without a `target`. In `src/tools/git.ts`, return
`audit: { executed }` when `gitWithTimeout` reports one.

Add a test asserting a ledger row for a rewritten git call carries `executed` and a row for
an un-rewritten one does not.

- [ ] **Step 5: Run everything**

Run: `CI=1 AGENT=1 bun run test && AGENT=1 bun run check:all && bun run test:coverage`
Expected: PASS. Watch `check-file-sizes` — if `src/utils/git.ts` crossed 600, move more of
the logic into Task 2's module rather than adding a baseline entry.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(git): consult a command interceptor and ledger what executed"
```

---

### Task 5: The rtk provider

**Files:**
- Create: `src/execution/interceptors/rtk/index.ts`
- Test: `test/unit/execution/interceptors/rtk.test.ts`

**Interfaces:**
- Produces:
  - `interface InterceptorState { enabled: boolean; provider: string; version: string | null; verbs: readonly string[] }`
  - `interface RtkDeps { which(bin: string): string | null; run(argv: readonly string[]): { stdout: string; exitCode: number }; record(state: InterceptorState): void }`
  - `createRtkInterceptor(opts: { enabled: boolean; verbs: readonly string[]; failuresBeforeDisable: number; _deps?: Partial<RtkDeps> }): CommandInterceptor`

**Settled semantics — implement exactly these, do not reinterpret:**

- `enabled: false` → `intercept()` returns `{ kind: "unchanged" }` for every request, and no
  binary is ever probed. (Task 6 will simply not install an interceptor in this case; this
  is belt-and-braces so the object is safe standalone.)
- The verb is `argv[1]` (`argv[0]` is always `"git"`). Not in `verbs` → `unchanged`.
- Rewrite is a static prefix: `["rtk", ...req.argv]`. **Never** call `rtk rewrite` — see
  scope decision 2.
- Preflight runs **once**, lazily, on the first request that would otherwise rewrite. It
  resolves the binary and its version. A missing binary → every request `declined`, never a
  throw.
- A **throwing** preflight counts as one failure and is **not** memoised as success; it is
  retried until the breaker latches.
- The breaker counts failures of preflight or of a rewrite attempt. On reaching
  `failuresBeforeDisable` it latches permanently: every later request returns `declined`
  without touching the binary.
- `record(state)` is called **exactly once**, at construction, whatever `enabled` is.

**Why `record` fires even when disabled:** this is what makes the spec §7 A/B possible.
Without it, a run with interception off is indistinguishable in its artifacts from a run
that made no git calls, and two ledgers you cannot tell apart cannot be compared. It also
satisfies H6 — a version that changed between the two arms invalidates the comparison and
must be visible after the fact rather than inferred.

- [ ] **Step 1: Write the failing tests**

`_deps` is `Partial<RtkDeps>` so each test overrides only what it needs. Provide a default
`record` that discards.

```typescript
import { describe, expect, test } from "bun:test";
import type { InterceptorState } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = (verb: string) => ({ kind: "argv" as const, argv: ["git", verb, "--oneline"], cwd: "/repo", site: "git" as const });
const present = { which: () => "/usr/bin/rtk", run: () => ({ stdout: "rtk 0.45.0", exitCode: 0 }) };

describe("rtk interceptor", () => {
  test("rewrites a verb that is in the configured list", async () => {
    const i = createRtkInterceptor({ enabled: true, verbs: ["log"], failuresBeforeDisable: 3, _deps: present });
    expect(await i.intercept(req("log"))).toEqual({
      kind: "rewritten",
      argv: ["rtk", "git", "log", "--oneline"],
      provider: "rtk",
    });
  });

  test("leaves a verb outside the list unchanged", async () => {
    const i = createRtkInterceptor({ enabled: true, verbs: ["log"], failuresBeforeDisable: 3, _deps: present });
    expect((await i.intercept(req("diff"))).kind).toBe("unchanged");
  });

  test("an empty verb list intercepts nothing", async () => {
    const i = createRtkInterceptor({ enabled: true, verbs: [], failuresBeforeDisable: 3, _deps: present });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
  });

  test("returns unchanged and never probes the binary when disabled", async () => {
    let probed = false;
    const i = createRtkInterceptor({
      enabled: false,
      verbs: ["log"],
      failuresBeforeDisable: 3,
      _deps: { ...present, which: () => { probed = true; return "/usr/bin/rtk"; } },
    });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
    expect(probed).toBe(false);
  });

  test("declines every request when rtk is not on PATH, and never throws", async () => {
    const i = createRtkInterceptor({
      enabled: true, verbs: ["log"], failuresBeforeDisable: 3,
      _deps: { ...present, which: () => null },
    });
    expect((await i.intercept(req("log"))).kind).toBe("declined");
  });

  test("the circuit breaker latches after the configured failure count", async () => {
    let probes = 0;
    const i = createRtkInterceptor({
      enabled: true, verbs: ["log"], failuresBeforeDisable: 2,
      _deps: { ...present, which: () => { probes += 1; throw new Error("boom"); } },
    });

    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect(probes).toBe(2);

    // Latched: the third request must not touch the sick binary at all.
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect(probes).toBe(2);
  });

  test("records its state at construction even when disabled", () => {
    const states: InterceptorState[] = [];
    createRtkInterceptor({
      enabled: false, verbs: ["log"], failuresBeforeDisable: 3,
      _deps: { ...present, record: (s) => states.push(s) },
    });
    expect(states).toEqual([{ enabled: false, provider: "rtk", version: null, verbs: ["log"] }]);
  });
});
```

Note the breaker test asserts the probe **count**, which is what distinguishes latching
from memoisation — a memoised success would also stop probing, so counting alone is not
enough; the failures must be what stops it.

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement to the semantics above**

- [ ] **Step 4: Run and commit**

```bash
CI=1 AGENT=1 bun test test/unit/execution/ && AGENT=1 bun run check:all && bun run test:coverage
git add -A && git commit -m "feat(execution): rtk interceptor with preflight and circuit breaker"
```

---

### Task 6: Strip rtk's recovery hints, and switch the feature on

This task both adds `postProcess` and does the wiring, because neither is independently
verifiable: without wiring nothing is reachable, and without stripping the wiring would
surface hints the agent cannot act on (R4).

**Files:**
- Modify: `src/execution/interceptors/rtk/index.ts` (add `postProcess`)
- Modify: `src/utils/git.ts` (guarded `postProcess` call)
- Modify: the run-level composition site that owns `_gitDeps` setup (see Step 4)
- Test: `test/unit/execution/interceptors/rtk-postprocess.test.ts`
- Test: `test/unit/utils/git-interception.test.ts` (extend)
- Test: `test/unit/execution/command-interceptor.test.ts` (extend with the R10 fence, Step 5)

rtk appends hints like `[full diff: rtk git diff --no-compact]` and
`[+12 hidden: rtk recall 3f9c2a81d4e7]`. A nax agent has no shell, so these are instructions
it cannot follow — passing them through reproduces nax#1800 and burns turns on denials (R4).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = { kind: "argv" as const, argv: ["git", "log"], cwd: "/repo", site: "git" as const };
const present = { which: () => "/usr/bin/rtk", run: () => ({ stdout: "rtk 0.45.0", exitCode: 0 }), record: () => {} };

/** Narrows `postProcess?` once, so no test needs a non-null assertion. */
function makePostProcess() {
  const i = createRtkInterceptor({ enabled: true, verbs: ["log"], failuresBeforeDisable: 3, _deps: present });
  const { postProcess } = i;
  if (postProcess === undefined) throw new Error("rtk interceptor must define postProcess");
  return postProcess;
}

describe("rtk postProcess", () => {
  test("strips a full-diff hint", () => {
    const post = makePostProcess();
    expect(post("diff body\n[full diff: rtk git diff --no-compact]", req).output).toBe("diff body");
  });

  test("strips a hidden-lines hint and carries the hash out-of-band", () => {
    const post = makePostProcess();
    const { output, notes } = post("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", req);
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
    expect(notes?.recallId).toBe("3f9c2a81d4e7");
  });

  test("leaves output with no hints untouched", () => {
    const post = makePostProcess();
    expect(post("plain body", req).output).toBe("plain body");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk-postprocess.test.ts`
Expected: FAIL — `postProcess` is undefined.

- [ ] **Step 3: Implement `postProcess` and the guarded call site**

Strip each known hint form and capture any recall hash into `notes.recallId`.

At the call site in `src/utils/git.ts`, call `postProcess` **only** when
`intercepted.rewritten` is true, inside a `try`/`catch` that falls back to the raw output.
Add these two tests to `test/unit/utils/git-interception.test.ts`, reusing its existing
`makeSpawn` / `withDepsRestore` setup:

```typescript
test("a throwing postProcess degrades to the raw output", async () => {
  _gitDeps.spawn = makeSpawn(() => "body\n[full diff: rtk git diff --no-compact]").spawn;
  _gitDeps.interceptor = {
    provider: "rtk",
    intercept: async () => ({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" }),
    postProcess: () => {
      throw new Error("post-process blew up");
    },
  };

  const result = await gitWithTimeout(["log"], "/repo");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("body");
});

test("postProcess is never consulted for a command that was not rewritten", async () => {
  let called = false;
  _gitDeps.spawn = makeSpawn(() => "body").spawn;
  _gitDeps.interceptor = {
    provider: "rtk",
    intercept: async () => ({ kind: "unchanged" }),
    postProcess: () => {
      called = true;
      return { output: "" };
    },
  };

  await gitWithTimeout(["log"], "/repo");

  expect(called).toBe(false);
});
```

⚠️ **Known limitation, record it in the code comment rather than solving it here:**
`gitWithTimeout` bounds stdout with `maxBytes` before `postProcess` sees it, so a trailing
hint on a very large output can be truncated mid-string and escape stripping. That is the
case the feature targets most, so note it explicitly; fixing it means moving the bound
after post-processing, which changes the drain contract and is its own change.

- [ ] **Step 4: Switch it on**

Find where run-level dependencies are composed and `NaxConfig` is available, and install the
interceptor when `config.execution.commandInterceptor.enabled` is true:

```typescript
_gitDeps.interceptor = createRtkInterceptor({
  enabled: cfg.enabled,
  verbs: cfg.git.verbs,
  failuresBeforeDisable: cfg.failuresBeforeDisable,
});
```

**This is the only task that makes `enabled: true` do anything.** Until it lands the
feature is inert.

Two constraints on where you put it:

- It must run once per run, before any git tool call.
- `createRtkInterceptor` is imported by path, so that module's file will contain the string
  `rtk`. That is expected — see the fence note below.

Add an integration-level test proving that with `enabled: false` no rewrite occurs, and
with `enabled: true` and rtk absent the command still succeeds unchanged.

- [ ] **Step 5: Add the R10 fence**

**Where this goes.** `.nax/rules/test-architecture.md:36,57` requires tests to mirror
`src/` and forbids standalone single-purpose files. These two tests are architectural
guards over `src/execution/`, so add them as a `describe` block inside
`test/unit/execution/command-interceptor.test.ts` (Task 2's file) rather than creating a
new `dropped-sites.test.ts`. If that file would pass 400 lines, split it by describe block
per the same rule — never by topic-of-the-day.

```typescript
import { describe, expect, test } from "bun:test";

// R1 is "no rtk-specific LOGIC outside the provider", not "the four letters
// never appear". These files name rtk as DATA — a config default, its
// description, and the composition site's import — which is unavoidable: the
// provider has to be named somewhere. Logic lives only in the provider.
const RTK_ALLOWED = new Set([
  "execution/interceptors/rtk/index.ts",
  "config/schemas-execution.ts",
  "cli/config-descriptions.ts",
  // <- add the composition site from Step 4
]);

describe("R10: the shell sites stay unwired", () => {
  test("no interception seam exists in the quality or verification runners", async () => {
    for (const path of ["src/quality/runner.ts", "src/verification/executor.ts"]) {
      const source = await Bun.file(path).text();
      expect(source).not.toContain("CommandInterceptor");
      expect(source).not.toContain("interceptArgv");
    }
  });

  test("rtk is named only where it must be (R1)", async () => {
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: "src" })) {
      if (RTK_ALLOWED.has(rel)) continue;
      if ((await Bun.file(`src/${rel}`).text()).includes("rtk")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 6: Run everything and commit**

```bash
CI=1 AGENT=1 bun run test && AGENT=1 bun run check:all && bun run test:coverage
git add -A && git commit -m "feat(execution): strip rtk hints and activate interception from config"
```

---

## Definition of done

All six tasks committed, `check:all` and the full suite green, and:

- With `enabled: false` (the default) every git call spawns exactly what it does today.
- With `enabled: true` and rtk installed, `git log` and `git diff` spawn through rtk, the
  ledger records what executed, and no rtk hint string reaches the agent.
- With `enabled: true` and rtk **absent**, every command still runs and succeeds.

## The thing that decides whether any of this ships

Everything above is the cost of **finding out**, not a committed build. Per spec §7:

> Run the same story with `enabled: false` and `enabled: true` and compare cost-ledger spend and turn counts.

The measurement in the results doc is **bytes of command output, not billed tokens** — rtk
ships no tokenizer and estimates tokens as `bytes / 4`. nax's cost ledger is the authority.
Run that A/B once Task 6 lands, using the per-run state record from Task 5 to tell the two
arms apart.

If the A/B is unconvincing, the honest outcome is to leave `enabled: false` permanently or
delete the feature. Say so plainly rather than shipping it on the strength of a green suite.
