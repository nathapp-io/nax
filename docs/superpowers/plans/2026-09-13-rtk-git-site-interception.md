# rtk Command Interception — Git Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route nax's `Git` tool calls through rtk for two measured verbs, behind an opt-in config flag, without any nax module outside one file knowing rtk exists.

**Architecture:** A generic `CommandInterceptor` seam consulted by `gitWithTimeout` between argv construction and spawn. One provider implements it for rtk as a static per-verb argv prefix. Every rewrite is validated, ledgered, and bounded by a circuit breaker. With the interceptor disabled — the default — every call site is byte-identical to today.

**Tech Stack:** TypeScript strict, Bun (`Bun.spawn`, `Bun.which`), `bun:test`, Biome, zod (config schemas).

**Spec:** `docs/superpowers/specs/2026-09-13-nax-rtk-command-interception-design.md`
**Evidence:** `docs/superpowers/results/2026-09-13-rtk-savings-measurement.md`

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
- Tests import source via the `@/` alias. No `as unknown as` in `test/` (ratchet baseline 0).
- Conventional commits. No attribution lines.
- Run `AGENT=1 bun run check:all` before every commit, and `bun run test:coverage` after adding any new `src/` file — **coverage is not part of `check:all`** and will not catch you otherwise.

## Three scope decisions this plan makes, and why

These follow from R10 rather than from the spec's prose, which predates it. Each is reversible; none should be reversed silently.

1. **`Site` is narrowed to the single value `"git"`.** The spec declares `"quality" | "verification" | "git"`. With two sites dropped, a three-member union invites exactly the wiring R10 forbids. A one-member union makes adding a site a deliberate type change that a reviewer sees.

2. **`InterceptRequest` is argv-only; the `shell` variant is dropped, and with it `rtk rewrite`.** No remaining call site produces a shell string, so the shell branch and its four-exit-code protocol would be unreachable code from the day it lands. US-004's argv path uses a static per-verb mapping and never calls `rtk rewrite`. **Consequence: the spec's US-004 acceptance criterion "each of the four exit codes maps as specified" is not implemented.** If you want the shell variant kept as a seam for a future reopening, say so before Task 1 — it is cheap now and expensive to retrofit.

3. **US-005's `RunCommand` truncation-marker item is out of scope.** `RunCommand` reaches the shell via `runQualityCommand` (`src/tools/run-command.ts:349`), the dropped quality site, so its output is never rewritten and `postProcess` never sees it. The underlying complaint is real and pre-existing — `run-command.ts:360` is `body.slice(0, ctx.maxBytes)`, which appends no marker and cuts by **characters** while `maxBytes` is a byte budget, unlike `Git`/`Read`/`Grep` which cut by bytes via `Buffer.subarray` and append `... [truncated at N bytes]`. `GitCommit` (`src/tools/git-commit.ts:68`) has the same character/byte mismatch. **File these as a separate issue; do not fix them here.** Task 5 works against the `Git` tool's existing marker (`src/tools/git.ts:270`) instead.

## File Structure

| File | Responsibility |
|---|---|
| `src/execution/command-interceptor.ts` (new) | Vocabulary (`Site`, `InterceptRequest`, `InterceptResult`, `CommandInterceptor`) and `validateRewrite`. Knows nothing of rtk. |
| `src/execution/interceptors/rtk.ts` (new) | The only file that knows rtk exists: argv mapping, preflight, circuit breaker, hint stripping. |
| `src/execution/interceptors/recall-tool.ts` (new) | The `static` `ToolProvider` exposing `Recall`. |
| `src/config/schemas-execution.ts` (modify) | `commandInterceptor` block on `ExecutionConfigSchema`. |
| `src/cli/config-descriptions.ts` (modify) | Field descriptions, so `nax config` explains the switch. |
| `src/utils/git.ts` (modify) | The one call site: consult the interceptor before spawning. |

---

### Task 1: Interceptor vocabulary and rewrite validation

Pure types plus one validation function. No wiring, no rtk, no config.

**Files:**
- Create: `src/execution/command-interceptor.ts`
- Test: `test/unit/execution/command-interceptor.test.ts`

**Interfaces:**
- Consumes: `GIT_ESCAPE_FLAGS` from `@/tools/git`; `NaxError` from `@/errors`.
- Produces: `type Site = "git"`; `InterceptRequest`; `InterceptResult`; `CommandInterceptor`; `validateRewrite(req: InterceptRequest, result: InterceptResult): InterceptResult`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import type { InterceptRequest, InterceptResult } from "@/execution/command-interceptor";
import { validateRewrite } from "@/execution/command-interceptor";

const req: InterceptRequest = {
  kind: "argv",
  argv: ["git", "log", "--oneline"],
  cwd: "/repo",
  site: "git",
};

describe("validateRewrite", () => {
  test("passes a rewrite that only prefixes the provider binary", () => {
    const result: InterceptResult = { kind: "rewritten", argv: ["rtk", "git", "log", "--oneline"], provider: "rtk" };
    expect(validateRewrite(req, result)).toEqual(result);
  });

  test("declines a rewrite that changes any original token", () => {
    const out = validateRewrite(req, { kind: "rewritten", argv: ["rtk", "git", "log", "-p"], provider: "rtk" });
    expect(out.kind).toBe("declined");
  });

  test("declines a rewrite that introduces a git escape flag", () => {
    // -C retargets the working tree. nax runs stories in parallel worktrees,
    // where hitting the wrong tree fails silently rather than loudly (R6).
    const escaped: InterceptRequest = { ...req, argv: ["git", "status"] };
    const out = validateRewrite(escaped, {
      kind: "rewritten",
      argv: ["rtk", "-C", "/elsewhere", "git", "status"],
      provider: "rtk",
    });
    expect(out.kind).toBe("declined");
  });

  test("declines a rewrite whose first token is not the named provider", () => {
    const out = validateRewrite(req, { kind: "rewritten", argv: ["other", "git", "log", "--oneline"], provider: "rtk" });
    expect(out.kind).toBe("declined");
  });

  test("passes unchanged and declined results straight through", () => {
    expect(validateRewrite(req, { kind: "unchanged" })).toEqual({ kind: "unchanged" });
    const declined: InterceptResult = { kind: "declined", reason: "no binary" };
    expect(validateRewrite(req, declined)).toEqual(declined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/execution/command-interceptor.test.ts`
Expected: FAIL — `Cannot find module '@/execution/command-interceptor'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Generic command-interception seam. rtk is a consumer, not a concept here (R1).
 *
 * Argv-only by construction: R10 drops both shell-string sites, so a `shell`
 * request variant would be unreachable code and would drag R9's shell-rewrite
 * validation in with it.
 */
import { GIT_ESCAPE_FLAGS } from "@/tools/git";

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

function decline(reason: string): InterceptResult {
  return { kind: "declined", reason };
}

/**
 * A rewrite may do exactly one thing: prefix the original argv with the
 * provider's own binary name. Anything else is refused.
 *
 * This is the argv analogue of R9's shell narrowing, and it is far tighter
 * because it can be: the mapping is static and built by nax, never a string
 * parsed back out of a subprocess.
 */
export function validateRewrite(req: InterceptRequest, result: InterceptResult): InterceptResult {
  if (result.kind !== "rewritten") return result;

  const { argv, provider } = result;
  if (argv.length !== req.argv.length + 1) return decline("rewrite must add exactly one leading token");
  if (argv[0] !== provider) return decline(`rewrite must lead with the provider binary, got ${argv[0]}`);
  for (const [i, token] of req.argv.entries()) {
    if (argv[i + 1] !== token) return decline(`rewrite altered token ${i}: ${token} -> ${argv[i + 1]}`);
  }
  if (argv.some((token) => GIT_ESCAPE_FLAGS.includes(token))) return decline("rewrite introduced a git escape flag");
  return result;
}
```

- [ ] **Step 4: Run the tests and the cycle check**

Run: `CI=1 AGENT=1 bun test test/unit/execution/command-interceptor.test.ts && bun run scripts/check-import-cycles.ts`
Expected: PASS, and `[OK] 0 modules in runtime import cycles`.

If the cycle check regresses, `GIT_ESCAPE_FLAGS` is the cause. Move that one constant to a leaf module (for example `src/tools/git-flags.ts`) and re-export it from `src/tools/git.ts` so existing importers are untouched. Do not copy the list — two copies of a security constant will drift.

- [ ] **Step 5: Commit**

```bash
git add src/execution/command-interceptor.ts test/unit/execution/command-interceptor.test.ts
git commit -m "feat(execution): command interceptor vocabulary and rewrite validation"
```

---

### Task 2: Config block and its description

**Files:**
- Modify: `src/config/schemas-execution.ts` (add to `ExecutionConfigSchema`, line 198)
- Modify: `src/cli/config-descriptions.ts` (add after line 64)
- Test: `test/unit/config/command-interceptor-config.test.ts`

**Interfaces:**
- Produces: `execution.commandInterceptor` config, shape `{ provider: string; enabled: boolean; git: { verbs: string[] }; failuresBeforeDisable: number }`.

The measured defaults are `enabled: false` (R7) and `verbs: ["log", "diff"]`. `status`, `blame` and `show` are absent deliberately — see US-007. **Do not "helpfully" add them.**

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

Note on that last test: the repo's config schemas normally strip unknown keys, and that stripping is intended behaviour elsewhere. This block is `.strict()` specifically because `sites` was a real key in an earlier revision of the spec — a user carrying it forward from a draft must get an error, not silence.

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/config/command-interceptor-config.test.ts`
Expected: FAIL — `commandInterceptor` is undefined.

- [ ] **Step 3: Add the schema**

Add near the other nested blocks in `src/config/schemas-execution.ts`:

```typescript
/**
 * Command interception. Opt-in (R7): interception changes what the agent sees,
 * so it must not switch on merely because the provider binary is installed.
 *
 * `git.verbs` carries MEASURED values (US-001, run 4) — `log` at 85.0% and
 * `diff` at 27.9% delivered savings. `status` (47% of ~1 KB) and `blame`
 * (byte-identical) were measured and excluded; `show` is disqualified on
 * exit-code divergence. See the results doc before changing this list.
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

Then add to `ExecutionConfigSchema`'s object literal:

```typescript
  commandInterceptor: CommandInterceptorConfigSchema.default({
    provider: "rtk",
    enabled: false,
    git: { verbs: ["log", "diff"] },
    failuresBeforeDisable: 3,
  }),
```

- [ ] **Step 4: Add the descriptions**

In `src/cli/config-descriptions.ts`, after the `execution.contextProviderTokenBudget` entry:

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

- [ ] **Step 5: Run tests and the gate**

Run: `CI=1 AGENT=1 bun test test/unit/config/ && AGENT=1 bun run check:all`
Expected: PASS. If a config-display or drift test fails, it is asserting on the full field list — update its fixture, do not weaken the schema.

- [ ] **Step 6: Commit**

```bash
git add src/config/schemas-execution.ts src/cli/config-descriptions.ts test/unit/config/command-interceptor-config.test.ts
git commit -m "feat(config): opt-in command interceptor block with measured git verbs"
```

---

### Task 3: Wire the git site, ledger the rewrite, and fence the dropped sites

**Files:**
- Modify: `src/utils/git.ts` (`gitWithTimeout`, line 71)
- Test: `test/unit/utils/git-interception.test.ts`
- Test: `test/unit/execution/dropped-sites.test.ts`

**Interfaces:**
- Consumes: `CommandInterceptor`, `validateRewrite`, `InterceptRequest` from Task 1.
- Produces: `gitWithTimeout` accepts an optional interceptor through `_gitDeps`; returns `{ stdout, stderr, exitCode, executed?: readonly string[], provider?: string }`.

`gitWithTimeout` already spawns through the injectable `_gitDeps.spawn`, so a fake interceptor needs no process control.

- [ ] **Step 1: Write the failing test**

`_gitDeps` (`src/utils/git.ts:41`) is a plain mutable object, so a test swaps
`spawn` and restores it in `afterEach`. `spawn` must return a Bun-subprocess-shaped
object: `gitWithTimeout` reads `stdout`, `stderr`, `exited` and calls `kill`.

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { _gitDeps, gitWithTimeout } from "@/utils/git";

const realSpawn = _gitDeps.spawn;
const realInterceptor = _gitDeps.interceptor;

afterEach(() => {
  _gitDeps.spawn = realSpawn;
  _gitDeps.interceptor = realInterceptor;
});

/** Records the argv it was handed and returns an immediately-exited process. */
function captureSpawn(seen: string[][]) {
  return ((argv: string[]) => {
    seen.push([...argv]);
    return {
      stdout: new Response("out").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    };
  }) as unknown as typeof _gitDeps.spawn;
}

function fake(result: InterceptResult | (() => never)): CommandInterceptor {
  return {
    provider: "fake",
    intercept: async () => (typeof result === "function" ? result() : result),
  };
}

describe("gitWithTimeout interception", () => {
  test("spawns the original argv when no interceptor is configured", async () => {
    const seen: string[][] = [];
    _gitDeps.spawn = captureSpawn(seen);
    _gitDeps.interceptor = undefined;

    await gitWithTimeout(["log"], "/repo");

    expect(seen).toEqual([["git", "log"]]);
  });

  test("spawns the rewritten argv and reports what executed", async () => {
    const seen: string[][] = [];
    _gitDeps.spawn = captureSpawn(seen);
    _gitDeps.interceptor = fake({ kind: "rewritten", argv: ["fake", "git", "log"], provider: "fake" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(seen).toEqual([["fake", "git", "log"]]);
    expect(result.executed).toEqual(["fake", "git", "log"]);
    expect(result.provider).toBe("fake");
  });

  test("spawns the original argv when the interceptor declines", async () => {
    const seen: string[][] = [];
    _gitDeps.spawn = captureSpawn(seen);
    _gitDeps.interceptor = fake({ kind: "declined", reason: "no binary" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(seen).toEqual([["git", "log"]]);
    expect(result.executed).toBeUndefined();
  });

  test("spawns the original argv when the interceptor throws", async () => {
    // Fail open at REWRITE time (R3): a sick interceptor must not fail the command.
    const seen: string[][] = [];
    _gitDeps.spawn = captureSpawn(seen);
    _gitDeps.interceptor = fake(() => {
      throw new Error("boom");
    });

    await gitWithTimeout(["log"], "/repo");

    expect(seen).toEqual([["git", "log"]]);
  });

  test("spawns the original argv when the rewrite fails validation", async () => {
    // -C retargets the working tree; validateRewrite refuses it (R6).
    const seen: string[][] = [];
    _gitDeps.spawn = captureSpawn(seen);
    _gitDeps.interceptor = fake({
      kind: "rewritten",
      argv: ["fake", "-C", "/elsewhere", "git", "log"],
      provider: "fake",
    });

    await gitWithTimeout(["log"], "/repo");

    expect(seen).toEqual([["git", "log"]]);
  });

  test("a rewritten command that runs and fails keeps its non-zero exit code", async () => {
    // R3's other half: nax never re-runs raw to disambiguate an exit code.
    const seen: string[][] = [];
    _gitDeps.spawn = ((argv: string[]) => {
      seen.push([...argv]);
      return {
        stdout: new Response("").body,
        stderr: new Response("fatal").body,
        exited: Promise.resolve(2),
        kill: () => {},
      };
    }) as unknown as typeof _gitDeps.spawn;
    _gitDeps.interceptor = fake({ kind: "rewritten", argv: ["fake", "git", "log"], provider: "fake" });

    const result = await gitWithTimeout(["log"], "/repo");

    expect(result.exitCode).toBe(2);
    expect(seen).toHaveLength(1);
  });
});
```

⚠️ `as unknown as` is banned in `test/` (ratchet baseline 0) and the two casts above
will trip `check-test-as-unknown-as`. Before writing this file, check how
`test/unit/tools/git.test.ts` builds its spawn doubles and follow that shape instead —
if it uses a typed helper, reuse it; if the repo has no spawn-double helper, add one in
`test/helpers/` with a real type rather than casting. Do not add a ratchet exemption.

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/utils/git-interception.test.ts`
Expected: FAIL — `gitWithTimeout` ignores the interceptor.

- [ ] **Step 3: Implement the seam**

In `gitWithTimeout`, between argv construction and the spawn:

```typescript
  let argv = ["git", ...args];
  let executed: readonly string[] | undefined;
  let provider: string | undefined;

  const interceptor = _gitDeps.interceptor;
  if (interceptor !== undefined) {
    const req: InterceptRequest = { kind: "argv", argv, cwd: workdir, site: "git" };
    // Fail open at REWRITE time (R3). A rewritten command that actually ran and
    // failed is a real failure and is never re-run raw — re-running a command to
    // disambiguate an exit code makes execution non-idempotent.
    let outcome: InterceptResult;
    try {
      outcome = validateRewrite(req, await interceptor.intercept(req));
    } catch {
      outcome = { kind: "declined", reason: "interceptor threw" };
    }
    if (outcome.kind === "rewritten") {
      argv = [...outcome.argv];
      executed = outcome.argv;
      provider = outcome.provider;
    }
  }

  const proc = _gitDeps.spawn(argv, { cwd: workdir, stdout: "pipe", stderr: "pipe" });
```

Add `interceptor?: CommandInterceptor` to `_gitDeps`, defaulting to `undefined`. Return `executed` and `provider` alongside the existing fields so the caller can ledger them — `sink.record()` in `src/tools/runtime.ts:172-184` already accepts `executed` and `provider` keys, which is US-008's "requested vs executed" with no new ledger shape.

- [ ] **Step 4: Write the fence test for the dropped sites**

```typescript
import { describe, expect, test } from "bun:test";

describe("R10: the shell sites stay unwired", () => {
  test("no interception seam exists in the quality or verification runners", async () => {
    for (const path of ["src/quality/runner.ts", "src/verification/executor.ts"]) {
      const source = await Bun.file(path).text();
      expect(source).not.toContain("CommandInterceptor");
      expect(source).not.toContain("interceptor");
    }
  });

  test("no nax module outside the rtk provider mentions rtk (R1)", async () => {
    const hits = new Bun.Glob("**/*.ts").scanSync({ cwd: "src" });
    const offenders: string[] = [];
    for (const rel of hits) {
      if (rel === "execution/interceptors/rtk.ts") continue;
      if ((await Bun.file(`src/${rel}`).text()).includes("rtk")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
```

The second test will fail until Task 4 creates that file. That is fine and expected — write it now so it cannot be forgotten, and let Task 4 turn it green.

- [ ] **Step 5: Run the suite and the gate**

Run: `CI=1 AGENT=1 bun test test/unit/utils/ test/unit/execution/ && AGENT=1 bun run check:all && bun run test:coverage`
Expected: interception tests PASS; the R1 test fails only on the missing rtk file.

- [ ] **Step 6: Commit**

```bash
git add src/utils/git.ts test/unit/utils/git-interception.test.ts test/unit/execution/dropped-sites.test.ts
git commit -m "feat(git): consult a command interceptor before spawning"
```

---

### Task 4: The rtk provider

**Files:**
- Create: `src/execution/interceptors/rtk.ts`
- Test: `test/unit/execution/interceptors/rtk.test.ts`

**Interfaces:**
- Consumes: `CommandInterceptor`, `InterceptRequest`, `InterceptResult` from Task 1; config from Task 2.
- Produces: `createRtkInterceptor(opts: { verbs: readonly string[]; failuresBeforeDisable: number; enabled: boolean; _deps?: RtkDeps }): CommandInterceptor`, and `RtkDeps = { which(bin: string): string | null; spawn: typeof Bun.spawn; record(state: InterceptorState): void }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";

const req = (verb: string) => ({ kind: "argv" as const, argv: ["git", verb, "--oneline"], cwd: "/repo", site: "git" as const });
const withRtk = { which: () => "/usr/bin/rtk", spawn: (() => {}) as never };

describe("rtk interceptor", () => {
  test("rewrites a verb that is in the configured list", async () => {
    const i = createRtkInterceptor({ verbs: ["log"], failuresBeforeDisable: 3, _deps: withRtk });
    const out = await i.intercept(req("log"));
    expect(out).toEqual({ kind: "rewritten", argv: ["rtk", "git", "log", "--oneline"], provider: "rtk" });
  });

  test("leaves a verb outside the list unchanged", async () => {
    const i = createRtkInterceptor({ verbs: ["log"], failuresBeforeDisable: 3, _deps: withRtk });
    expect((await i.intercept(req("diff"))).kind).toBe("unchanged");
  });

  test("declines every request when rtk is not on PATH, and never throws", async () => {
    const i = createRtkInterceptor({ verbs: ["log"], failuresBeforeDisable: 3, _deps: { ...withRtk, which: () => null } });
    const out = await i.intercept(req("log"));
    expect(out.kind).toBe("declined");
  });

  test("an empty verb list intercepts nothing", async () => {
    const i = createRtkInterceptor({ verbs: [], failuresBeforeDisable: 3, _deps: withRtk });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
  });

  test("the circuit breaker latches after the configured failure count", async () => {
    let calls = 0;
    const flaky = { ...withRtk, which: () => { calls += 1; throw new Error("boom"); } };
    const i = createRtkInterceptor({ verbs: ["log"], failuresBeforeDisable: 2, _deps: flaky });
    await i.intercept(req("log"));
    await i.intercept(req("log"));
    const before = calls;
    await i.intercept(req("log"));
    // Latched: no further probing of the sick binary.
    expect(calls).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Key points, all from US-004 and the measurement:

- The verb is `argv[1]` (`argv[0]` is always `"git"`). Match against the configured list; anything else returns `unchanged`.
- Rewrite is a static prefix: `["rtk", ...req.argv]`. Never call `rtk rewrite` — it returns a string and would require re-splitting an argv nax already has correctly.
- Preflight `which("rtk")` **once** per interceptor instance, memoised. A missing binary means every request returns `declined`, never a throw.
- Count failures; once the count reaches `failuresBeforeDisable`, latch permanently and return `declined` without touching the binary again.

**Record the interceptor's state once per run, whatever that state is.** Emit a single
preflight record carrying `{ enabled, provider, version, verbs }` — including when
`enabled` is `false`. This is the half that makes the spec §7 A/B self-evidencing: without
it, a run with interception off is indistinguishable in its artifacts from a run that
simply made no git calls, and two ledgers you cannot tell apart cannot be compared. It
also satisfies H6, since a version that changed between the two arms invalidates the
comparison and must be visible after the fact rather than inferred.

```typescript
test("records its state even when disabled", () => {
  const records: unknown[] = [];
  createRtkInterceptor({ verbs: ["log"], failuresBeforeDisable: 3, enabled: false, _deps: { ...withRtk, record: (r) => records.push(r) } });
  expect(records).toEqual([{ enabled: false, provider: "rtk", version: null, verbs: ["log"] }]);
});
```

- [ ] **Step 4: Run the tests, including the R1 fence from Task 3**

Run: `CI=1 AGENT=1 bun test test/unit/execution/ && AGENT=1 bun run check:all && bun run test:coverage`
Expected: PASS, including `no nax module outside the rtk provider mentions rtk`.

- [ ] **Step 5: Commit**

```bash
git add src/execution/interceptors/rtk.ts test/unit/execution/interceptors/rtk.test.ts
git commit -m "feat(execution): rtk interceptor with preflight and circuit breaker"
```

---

### Task 5: Strip rtk's recovery hints from rewritten output

**Files:**
- Modify: `src/execution/interceptors/rtk.ts` (add `postProcess`)
- Modify: `src/utils/git.ts` (call `postProcess` for rewritten commands only, guarded)
- Test: `test/unit/execution/interceptors/rtk-postprocess.test.ts`
- Test: `test/unit/utils/git-interception.test.ts` (extend with the two call-site tests in Step 4)

rtk appends hints like `[full diff: rtk git diff --no-compact]` and `[+12 hidden: rtk recall 3f9c2a81d4e7]`. A nax agent has no shell, so these are instructions it cannot follow — passing them through reproduces nax#1800 and burns turns on denials (R4).

- [ ] **Step 1: Write the failing test**

```typescript
describe("rtk postProcess", () => {
  test("strips a full-diff hint", () => {
    const { output } = i.postProcess!("diff body\n[full diff: rtk git diff --no-compact]", req("diff"));
    expect(output).toBe("diff body");
  });

  test("strips a hidden-lines hint and carries the hash out-of-band", () => {
    const { output, notes } = i.postProcess!("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", req("log"));
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
    expect(notes?.recallId).toBe("3f9c2a81d4e7");
  });

  test("leaves output with no hints untouched", () => {
    expect(i.postProcess!("plain body", req("log")).output).toBe("plain body");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/rtk-postprocess.test.ts`
Expected: FAIL — `postProcess` is undefined.

- [ ] **Step 3: Implement `postProcess`**

Strip each known hint form; capture any recall hash into `notes.recallId`. Return the trimmed output. The hash travels out-of-band precisely because the hint carrying it is being removed — Task 6 is what makes it reachable again.

- [ ] **Step 4: Verify the call site degrades safely**

The spec requires that a throwing `postProcess` degrades to raw output rather than failing the command. Add that guard at the call site and a test for it:

```typescript
test("a throwing postProcess degrades to the raw output", async () => {
  const seen: string[][] = [];
  _gitDeps.spawn = captureSpawn(seen, "body\n[full diff: rtk git diff --no-compact]");
  _gitDeps.interceptor = {
    provider: "fake",
    intercept: async () => ({ kind: "rewritten", argv: ["fake", "git", "log"], provider: "fake" }),
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
  _gitDeps.spawn = captureSpawn([], "body");
  _gitDeps.interceptor = {
    provider: "fake",
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

Extend `captureSpawn` from Task 3 to take the stdout body it should return.

- [ ] **Step 5: Run tests and commit**

```bash
CI=1 AGENT=1 bun test test/unit/execution/ && AGENT=1 bun run check:all
git add -A && git commit -m "feat(execution): strip rtk recovery hints from rewritten output"
```

---

### Task 6: The Recall tool, and the marker that names it

**Files:**
- Create: `src/execution/interceptors/recall-tool.ts`
- Modify: `src/tools/git.ts` (truncation marker, line 270)
- Test: `test/unit/execution/interceptors/recall-tool.test.ts`

**Prerequisite:** the provider-tools mechanism, shipped in nax#2031. Read `docs/superpowers/specs/2026-09-13-nax-provider-tools-design.md` before starting. The recall tool is a **`static`-kind** provider — nax authors the schema, so it carries none of the sanitization or lockfile obligations a `discovered` provider does.

⚠️ **Provider tools resolve only under the unrestricted permission profile.** A late fix in #2031 gates provider resolution on `resolvePermissions` returning approve-all with a root present; under `safe` or `scoped` no provider tool is advertised or callable. Decide deliberately whether `Recall` is acceptable as unrestricted-only, and if not, raise it before writing code rather than discovering it in review.

- [ ] **Step 1: Write the failing test**

`ToolProvider` (`src/tools/provider-types.ts:28-38`) requires `id`, `kind`, `stages`
and `tools(workdir)`. Each `ProviderTool` carries `localName`, `description`,
`inputSchema` and `run(input, ctx)`.

```typescript
import { describe, expect, test } from "bun:test";
import { createRecallProvider } from "@/execution/interceptors/recall-tool";

const store = new Map<string, string>([["3f9c2a81d4e7", "the full untruncated output"]]);

describe("Recall provider", () => {
  test("is a static provider — no sanitization or pinning obligations", async () => {
    const provider = createRecallProvider({ enabled: true, store });
    expect(provider.kind).toBe("static");
    expect(provider.id).toBe("recall");
  });

  test("retrieves output by a hash captured from a stripped hint", async () => {
    const provider = createRecallProvider({ enabled: true, store });
    const [tool] = await provider.tools("/repo");
    const result = await tool.run({ id: "3f9c2a81d4e7" }, ctx());
    expect(result.content).toBe("the full untruncated output");
    expect(result.isError).toBeFalsy();
  });

  test("an unknown hash is an error result, not a throw", async () => {
    const provider = createRecallProvider({ enabled: true, store });
    const [tool] = await provider.tools("/repo");
    const result = await tool.run({ id: "deadbeef" }, ctx());
    expect(result.isError).toBe(true);
  });

  test("advertises nothing when the interceptor is disabled", async () => {
    const provider = createRecallProvider({ enabled: false, store });
    expect(await provider.tools("/repo")).toEqual([]);
  });
});
```

Write `ctx()` as a small local helper returning a `ToolRunContext` — read
`test/unit/tools/` for how existing tool tests build one, and reuse that helper if it
already exists rather than inventing a second shape.

Grant denial is not tested here: it is the policy layer's behaviour, already covered
where `compileToolPolicy` is tested. Asserting it again in this file would test
someone else's code and give a false sense of coverage.

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=1 AGENT=1 bun test test/unit/execution/interceptors/recall-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the static provider**

Expose one tool, `Recall`, taking `{ id: string }` and returning the full output for that hash via `rtk recall <hash>`.

- [ ] **Step 4: Close the loop in the marker**

`src/tools/git.ts:270` currently appends `... [truncated at ${maxBytes} bytes]`. When a recall id is available **and** `Recall` is advertised for this hop, extend it:

```
... [truncated at 40000 bytes; full output available via Recall(id: "3f9c2a81d4e7")]
```

**The conditional is the whole point.** When `Recall` is not advertised — interceptor disabled, provider ungranted, stage not attached — the marker must degrade to the plain notice. Offering a tool the agent does not have is worse than offering nothing: it burns a turn on a denial to discover that. Write the negative test first.

Note R1: `src/tools/git.ts` must not learn what rtk is. It receives an opaque recall id and an "is `Recall` advertised" boolean; it never knows who produced them.

- [ ] **Step 5: Run everything and commit**

```bash
CI=1 AGENT=1 bun run test && AGENT=1 bun run check:all && bun run test:coverage
git add -A && git commit -m "feat(execution): recall tool and a truncation marker that names it"
```

---

## After the plan: the thing that decides whether any of this ships

Everything above is the cost of **finding out**, not a committed build. Per spec §7, the token-savings claim is not proven by any of these tests:

> Run the same story with `enabled: false` and `enabled: true` and compare cost-ledger spend and turn counts.

The measurement in the results doc is **bytes of command output, not billed tokens** — rtk ships no tokenizer and estimates tokens as `bytes / 4`. nax's cost ledger is the authority. Run that A/B once Task 4 lands and the feature is exercisable end-to-end.

If the A/B is unconvincing, the honest outcome is to leave `enabled: false` permanently or delete the feature. Say so plainly rather than shipping it on the strength of a green test suite.
