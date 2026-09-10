# Denial Affordance SSOT (nax#1971) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every denied coding-tool call name an affordance the session actually has, instead of a bare refusal or the package-manager install allowlist.

**Architecture:** Three changes in the denial path only — nothing about what is *permitted* changes. (1) `policy.ts`'s verb denial names the permitted verbs, computed as the intersection of the tool's `allowedVerbs` and the stage's grant. (2) A new `redirectForVerb` makes the existing `#1937` redirect reachable from the verb branch, which `RunCommand` and `Git` deny through. (3) When no redirect row matches an argv call, name the commands the project declared rather than the install allowlist. Two supporting changes let nax's own repo benefit: `coverage` becomes a known `quality.commands` key (zod currently strips it silently), and nax's `lint` points at the same superset its pre-commit hook runs.

**Tech Stack:** TypeScript, Bun test, zod v4, biome.

**Spec:** No spec file — this is a bounded change designed in-chat against [nax#1971](https://github.com/nathapp-io/nax/issues/1971). The issue body is the requirements document; read it before Task 1.

**Worktree:** `/Users/williamkhoo/workspace/subrina-coder/projects/nax/worktrees/1971-denial-affordance`, branch `fix/1971-denial-affordance-ssot`, based on `a0d3d06c0`. Run `bun install --frozen-lockfile` once before starting (already done at plan time).

## Global Constraints

- Never name a tool the session was not advertised. Every redirect row is gated on the caller's `available` set. This is the defect #1937 exists to fix; reintroducing it fails the task.
- Never name a command the project did not declare. Gate on `declaredCommands`, never on a hardcoded script name or package runner name.
- No project-specific strings. `bun run check:*`, `biome`, `pytest` and friends must not appear in `src/tools/`. Detection heuristics may list runner *binaries*; message *content* comes only from `declaredCommands` / `allowedVerbs`.
- Files stay under the repo's 600-line gate (`bun run check:file-sizes`). `denial-redirect.ts` is 66 lines today and has room.
- No `as unknown as` in `test/` — the gate `check:test-as-unknown-as` has baseline 0.
- Commit messages follow conventional commits and reference `(#1971)`.
- Run `bun run check:all` before every commit; the pre-commit hook runs it plus typecheck and will reject otherwise.

---

### Task 1: Verb denial names the permitted verbs

The bare refusal at `src/tools/policy.ts:330` teaches the model nothing. `Git {subcommand:"grep"}` and `RunCommand {command:"test:coverage"}` both land here and learn only that they guessed wrong.

The subtlety: `scope.allowedVerbs` is what the **tool** permits, but line 332 narrows again to what the **stage's grant** permits. Naming `allowedVerbs` alone would advertise a verb this stage cannot use — the same defect in new clothing. Both denials must name the **intersection**.

**Files:**
- Modify: `src/tools/policy.ts:324-335`
- Test: `test/unit/tools/policy.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour change only: the two `deny(...)` calls in the `verbField` block gain a `-- permitted: a, b, c` suffix.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tools/policy.test.ts`. Match the file's existing setup style for `compileToolPolicy` — read the top of the file first and reuse its helper if one exists rather than inventing a new fixture.

```ts
describe("verb denial names what is permitted (#1971)", () => {
  const scope = {
    pathFields: [] as string[],
    verbField: "command",
    allowedVerbs: ["lint", "test", "testScoped", "coverage"],
  };

  test("an unknown verb is told the verbs the stage can use", () => {
    const policy = compileToolPolicy({ root: "/tmp", grants: { RunCommand: ["*"] } });
    const verdict = policy.check("RunCommand", scope, { command: "test:coverage" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("test:coverage");
    expect(verdict.reason).toContain("permitted: lint, test, testScoped, coverage");
  });

  test("a narrower grant names only what the grant allows, not every allowedVerb", () => {
    const policy = compileToolPolicy({ root: "/tmp", grants: { RunCommand: ["lint", "test"] } });
    const verdict = policy.check("RunCommand", scope, { command: "coverage" });
    expect(verdict.allowed).toBe(false);
    // `coverage` is an allowedVerb but NOT granted to this stage: naming it
    // would send the model back into the same denial.
    expect(verdict.reason).not.toContain("coverage,");
    expect(verdict.reason).toContain("permitted: lint, test");
  });

  test("a grant with no usable verb says so rather than naming an empty list", () => {
    const policy = compileToolPolicy({ root: "/tmp", grants: { RunCommand: ["build"] } });
    const verdict = policy.check("RunCommand", scope, { command: "lint" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("no subcommands are permitted for this stage");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/tools/policy.test.ts -t "#1971"
```

Expected: FAIL — the reason is `"test:coverage" is not a permitted RunCommand subcommand` with no `permitted:` suffix.

- [ ] **Step 3: Implement**

Replace the `verbField` block at `src/tools/policy.ts:324-335`:

```ts
      // Verb gating: the tool's own allowedVerbs bound what config can grant,
      // so a "*" grant can never reach a mutating subcommand.
      if (scope.verbField !== undefined) {
        const verb = input[scope.verbField];
        if (typeof verb !== "string") return deny(`"${scope.verbField}" must be a string`);

        // Name what the stage can actually use, not merely what the tool
        // allows (nax#1971). `allowedVerbs` alone would advertise a verb a
        // narrower grant refuses one line below -- sending the model straight
        // back into a denial, which is the defect #1937 exists to fix.
        const usableVerbs =
          scope.allowedVerbs === undefined
            ? []
            : grant.unconditional
              ? [...scope.allowedVerbs]
              : scope.allowedVerbs.filter((v) => grant.raw.includes(v));
        const permitted =
          usableVerbs.length === 0
            ? "no subcommands are permitted for this stage"
            : `permitted: ${usableVerbs.join(", ")}`;

        if (scope.allowedVerbs !== undefined && !scope.allowedVerbs.includes(verb)) {
          return deny(`"${verb}" is not a permitted ${tool} subcommand -- ${permitted}`);
        }
        if (!grant.unconditional && !grant.raw.includes(verb)) {
          return deny(`${tool} is not granted the "${verb}" subcommand for this stage -- ${permitted}`);
        }
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/tools/policy.test.ts
```

Expected: PASS, including every pre-existing test in the file. If an existing assertion did an exact-equality match on one of these two reason strings, update it to the new text — the message is deliberately changing.

- [ ] **Step 5: Run the broader tool suite**

```bash
bun test test/unit/tools/
```

Expected: PASS. `run-command.test.ts` and `git.test.ts` are the likely places holding an exact-match assertion.

- [ ] **Step 6: Commit**

```bash
bun run check:all
git add src/tools/policy.ts test/unit/tools/
git commit -m "fix(tools): verb denials name the subcommands the stage can use (#1971)"
```

---

### Task 2: Make the redirect reachable from the verb branch

`src/tools/runtime.ts:209-211` gates the redirect on `Array.isArray(rawArgv)`. `RunCommand` and `Git` deny through `verbField`, where `rawArgv` is `undefined`, so the redirect is structurally unreachable for them. `Exec ["ls","-la"]` gets "you already have `Glob`" while `RunCommand {command:"ls -la"}` — same session, same intent — gets nothing.

Two shapes arrive in the verb slot: a mini command line the model stuffed there (`"ls -la"`, `"wc -l a.ts b.ts"`) and a bare word (`"grep"`, `"diff"`). The first is handled by tokenizing and reusing the existing `intendedTool()`; the second needs a small bare-verb table.

**Self-redirect guard:** `Git {subcommand:"diff"}` denied by a narrow grant must not be told "you already have `Git`". `redirectForVerb` takes the denied tool's name and returns `undefined` when the row points back at it.

**Files:**
- Modify: `src/tools/denial-redirect.ts` (add `redirectForVerb`)
- Modify: `src/tools/runtime.ts:194-215`
- Test: `test/unit/tools/denial-redirect.test.ts`

**Interfaces:**
- Consumes: `intendedTool(argv)` — the existing private helper in `denial-redirect.ts`. Do not change its signature.
- Produces:
  ```ts
  export function redirectForVerb(
    deniedTool: string,
    verb: string,
    available: ReadonlySet<string>,
    declaredCommands: ReadonlySet<string>,
  ): string | undefined
  ```
  Task 3 modifies `redirectForArgv` in the same file but does not touch this function.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tools/denial-redirect.test.ts` (it already defines `const ALL = new Set(["Glob", "Git", "Delete", "RunCommand"])` and `const CMDS = new Set(["test", "testScoped", "lint"])` — add `Grep` to a local set rather than mutating `ALL`, so existing tests keep their meaning).

```ts
import { redirectForVerb } from "@/tools/denial-redirect";

const WITH_GREP = new Set(["Glob", "Git", "Delete", "RunCommand", "Grep"]);

describe("redirectForVerb (#1971)", () => {
  test("a command line stuffed into the verb slot reuses the argv table", () => {
    expect(redirectForVerb("RunCommand", "ls -la", ALL, CMDS)).toContain("Glob");
    expect(redirectForVerb("RunCommand", "ls -la src", ALL, CMDS)).toContain("Glob");
  });

  test("a bare read-only git verb points at Git", () => {
    expect(redirectForVerb("RunCommand", "diff", ALL, CMDS)).toContain("Git");
    expect(redirectForVerb("RunCommand", "status", ALL, CMDS)).toContain("Git");
  });

  test("a bare git points at Git", () => {
    expect(redirectForVerb("RunCommand", "git", ALL, CMDS)).toContain("Git");
  });

  test("grep points at Grep", () => {
    expect(redirectForVerb("Git", "grep", WITH_GREP, CMDS)).toContain("Grep");
  });

  test("never redirects a tool back at itself", () => {
    // Git {subcommand:"diff"} denied by a narrow grant: "you already have Git"
    // is useless, and would read as a contradiction of the denial.
    expect(redirectForVerb("Git", "diff", ALL, CMDS)).toBeUndefined();
  });

  test("says nothing when the target tool is not advertised", () => {
    expect(redirectForVerb("Git", "grep", ALL, CMDS)).toBeUndefined();
    expect(redirectForVerb("RunCommand", "ls -la", new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("says nothing for a verb that maps to no tool", () => {
    expect(redirectForVerb("RunCommand", "test:coverage", WITH_GREP, CMDS)).toBeUndefined();
    expect(redirectForVerb("RunCommand", "", WITH_GREP, CMDS)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/tools/denial-redirect.test.ts -t "#1971"
```

Expected: FAIL to compile / import — `redirectForVerb` is not exported.

- [ ] **Step 3: Implement `redirectForVerb`**

Append to `src/tools/denial-redirect.ts`, below `redirectForArgv`:

```ts
/**
 * Bare verbs that are really a request for a first-class tool.
 *
 * Distinct from `intendedTool`: those are argv command lines, these are single
 * words the model put in a `verbField` slot (`RunCommand {command:"diff"}`).
 */
const VERB_TOOLS: ReadonlyMap<string, { tool: string; how: string }> = new Map([
  ["grep", { tool: "Grep", how: "Grep searches file contents" }],
  ["git", { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` }],
  ...[...GIT_READ_VERBS].map(
    (v) =>
      [v, { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` }] as const,
  ),
]);

/**
 * Name the tool that serves the intent behind a denied VERB call.
 *
 * `redirectForArgv` is unreachable for RunCommand and Git: they deny through
 * `verbField`, where the policy sees no argv at all, so every such denial was a
 * bare refusal (nax#1971). A verb slot carries either a mini command line the
 * model stuffed there ("ls -la") -- tokenized here and handed to the same argv
 * table -- or a bare word ("grep"), handled by VERB_TOOLS.
 */
export function redirectForVerb(
  deniedTool: string,
  verb: string,
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const tokens = verb.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;

  // A multi-token verb IS a command line; reuse the argv table verbatim so the
  // two branches can never disagree about what `ls -la` means.
  if (tokens.length > 1) {
    const viaArgv = redirectForArgv(tokens, available, declaredCommands);
    // Suppress a self-redirect the same way the bare-verb path does below.
    return viaArgv?.includes(`\`${deniedTool}\``) === true ? undefined : viaArgv;
  }

  const hit = VERB_TOOLS.get(tokens[0] as string);
  if (hit === undefined) return undefined;
  // Telling Git it already has Git reads as a contradiction of the denial.
  if (hit.tool === deniedTool) return undefined;
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/tools/denial-redirect.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Wire it into the runtime**

Replace `src/tools/runtime.ts:209-211` (inside `if (!verdict.allowed)`):

```ts
        const rawArgv = argvField === undefined ? undefined : input[argvField];
        const verbField = tool.scope.verbField;
        const rawVerb = verbField === undefined ? undefined : input[verbField];
        const declared = opts.declaredCommands ?? new Set<string>();
        // An argv call and a verb call deny through different policy branches;
        // before #1971 only the first could reach a redirect at all.
        const extra = Array.isArray(rawArgv)
          ? redirectForArgv(rawArgv as readonly string[], advertisedNames, declared)
          : typeof rawVerb === "string"
            ? redirectForVerb(name, rawVerb, advertisedNames, declared)
            : undefined;
```

Update the import on line 14 to `import { redirectForArgv, redirectForVerb } from "./denial-redirect";`.

Note `name` (the tool's registered name), not `policyIdentity` — the latter is `Exec` for argv calls and would break the self-redirect guard.

- [ ] **Step 6: Write the wiring test**

Append to `test/unit/tools/denial-redirect.test.ts`, following the runtime-level tests already at the bottom of that file (read them first and mirror their fixture setup):

```ts
test("a denied RunCommand verb names the tool the session already has (#1971)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nax-verb-redirect-"));
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy({ root, grants: { RunCommand: ["*"], Glob: ["*"] } }),
    extraTools: [createRunCommandTool(new Map([["lint", "echo lint"]]), { allowExec: false })],
    declaredCommands: new Set(["lint"]),
  });
  const result = await runtime.call("RunCommand", { command: "ls -la" });
  expect(result.kind).toBe("denied");
  expect(result.kind === "denied" && result.reason).toContain("Glob");
});
```

Check `createRunCommandTool`'s real signature in `src/tools/run-command.ts` before writing this — mirror how `run-command.test.ts` constructs it rather than guessing the options bag.

- [ ] **Step 7: Run the full tool suite**

```bash
bun test test/unit/tools/
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
bun run check:all
git add src/tools/denial-redirect.ts src/tools/runtime.ts test/unit/tools/denial-redirect.test.ts
git commit -m "fix(tools): make the denial redirect reachable from the verb branch (#1971)"
```

---

### Task 3: Name declared commands when no redirect row matches

An unmatched argv call falls back to the package-manager grant list, which is never the answer:

```
Exec is not granted for argv "bun run check:all"
  -- granted forms: bun install, bun add*, npm ci, ...
```

The model wanted to run a project gate. Name the commands the project declared instead.

**Scoping decision:** fire this only when `argv[0]` is a recognised task runner. Firing on *every* unmatched argv would append "RunCommand can run lint, test, build" to unrelated denials like `rm -r directory` — noise, and it would silently change two existing tests that assert `undefined` for unsupported delete forms. The runner list is a *detection* heuristic that degrades to today's behaviour on a miss; the message content still comes only from `declaredCommands`.

**Files:**
- Modify: `src/tools/denial-redirect.ts` (`redirectForArgv`)
- Test: `test/unit/tools/denial-redirect.test.ts`

**Interfaces:**
- Consumes: `redirectForVerb` from Task 2 (unchanged; it calls `redirectForArgv` for multi-token verbs, so this change reaches the verb branch too).
- Produces: no signature change to `redirectForArgv`. New behaviour: returns a declared-commands sentence where it previously returned `undefined`, for runner-shaped argv only.

- [ ] **Step 1: Write the failing tests**

```ts
describe("declared-commands fallback (#1971)", () => {
  test("a runner invoking an unknown script is told what the project declares", () => {
    const r = redirectForArgv(["bun", "run", "check:all"], ALL, CMDS);
    expect(r).toContain("RunCommand");
    expect(r).toContain("test, testScoped, lint");
  });

  test("works for any runner, not just bun", () => {
    expect(redirectForArgv(["npm", "run", "lint:ci"], ALL, CMDS)).toContain("RunCommand");
    expect(redirectForArgv(["make", "check"], ALL, CMDS)).toContain("RunCommand");
    expect(redirectForArgv(["uv", "run", "pytest"], ALL, CMDS)).toContain("RunCommand");
  });

  test("a specific row still wins over the fallback", () => {
    // `bun test <file>` must stay pointed at testScoped, not the generic list.
    expect(redirectForArgv(["bun", "test", "a.test.ts"], ALL, CMDS)).toContain("testScoped");
  });

  test("says nothing when the project declared no commands", () => {
    expect(redirectForArgv(["bun", "run", "check:all"], ALL, new Set())).toBeUndefined();
  });

  test("says nothing when RunCommand is not advertised", () => {
    expect(redirectForArgv(["bun", "run", "check:all"], new Set(["Read"]), CMDS)).toBeUndefined();
  });

  test("does not fire on non-runner argv", () => {
    // Guards the existing unsupported-delete-form tests from silently changing.
    expect(redirectForArgv(["rm", "-r", "directory"], ALL, CMDS)).toBeUndefined();
    expect(redirectForArgv(["wc", "-l", "a.ts"], ALL, CMDS)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/unit/tools/denial-redirect.test.ts -t "declared-commands fallback"
```

Expected: FAIL — every fallback assertion gets `undefined`.

- [ ] **Step 3: Implement**

In `src/tools/denial-redirect.ts`, add above `redirectForArgv`:

```ts
/**
 * Task-runner binaries. A detection heuristic ONLY: what gets named comes
 * entirely from the project's declared commands, never from this list. A runner
 * missing here degrades to the pre-#1971 message rather than to a wrong one.
 */
const TASK_RUNNERS = new Set([
  "bun", "npm", "pnpm", "yarn", "deno", "npx",
  "make", "just", "task",
  "go", "cargo", "uv", "poetry", "pipenv", "tox", "gradle", "mvn",
]);
```

Then in `redirectForArgv`, replace `if (hit === undefined) return undefined;` with:

```ts
  if (hit === undefined) {
    // Nothing specific matched. If the model reached for a task runner, it
    // wanted to run a project gate -- name the gates this project actually
    // declared, rather than the package-manager install allowlist that
    // policy.ts already printed and that is never the answer (nax#1971).
    const av = argv[0] === "timeout" ? argv.slice(2) : argv;
    const head = av[0];
    if (head === undefined || !TASK_RUNNERS.has(head)) return undefined;
    if (!available.has("RunCommand") || declaredCommands.size === 0) return undefined;
    return `this session already has RunCommand with declared commands: ${[...declaredCommands].join(", ")}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test test/unit/tools/denial-redirect.test.ts
```

Expected: PASS, including the pre-existing `does not redirect an unsupported delete form` cases — `rm` and `git` are not in `TASK_RUNNERS`.

Note: `go`, `cargo` and `uv` appear both in `TASK_RUNNERS` and in the Exec install allowlist (`go get`, `cargo add`, `uv sync`). That is not a conflict — an argv the allowlist *grants* never reaches the denial path at all.

- [ ] **Step 5: Run the full tool suite**

```bash
bun test test/unit/tools/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check:all
git add src/tools/denial-redirect.ts test/unit/tools/denial-redirect.test.ts
git commit -m "fix(tools): name declared commands when no redirect row matches (#1971)"
```

---

### Task 4: Add `coverage` to the `quality.commands` schema

`quality.commands` is a closed zod object. A `coverage` key in `.nax/config.json` parses successfully and is **silently stripped**, so it never reaches `declaredCommands` and `RunCommand` still denies it. Verified at plan time:

```
QualityConfigSchema.safeParse({ commands: { lint: "x", coverage: "bun run test:coverage" } })
→ success: true, parsed commands: {"lint":"x"}
```

`coverage` is an agent affordance nax never invokes itself — which is exactly what `declaredCommands` means.

**Files:**
- Modify: `src/config/schemas-execution.ts:270-291` (the `commands` object)
- Modify: `src/config/runtime-types.ts:177-196` (the `QualityConfig["commands"]` interface)
- Modify: `src/cli/config-descriptions.ts` (near line 113)
- Test: `test/unit/config/` — find the file already covering `QualityConfigSchema` with `ls test/unit/config/` and add there; create `quality-commands-coverage.test.ts` only if none exists.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `QualityConfig["commands"].coverage?: string`. Task 5 sets it in `.nax/config.json`.

- [ ] **Step 1: Write the failing test**

```ts
test("coverage survives the parse so RunCommand can declare it (#1971)", () => {
  const parsed = QualityConfigSchema.parse({
    commands: { lint: "bun run lint", coverage: "bun run test:coverage" },
  });
  expect(parsed.commands.coverage).toBe("bun run test:coverage");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test test/unit/config/ -t "coverage survives the parse"
```

Expected: FAIL — `parsed.commands.coverage` is `undefined` (stripped), and TypeScript flags the property as unknown.

- [ ] **Step 3: Implement**

In `src/config/schemas-execution.ts`, inside the `commands` object, after `build`:

```ts
      /**
       * Coverage gate (e.g. `bun run test:coverage`, `pytest --cov`). nax never
       * invokes this itself -- it exists so a coding agent can check whether it
       * met the project's coverage bar instead of guessing a script name and
       * being denied (nax#1971).
       */
      coverage: z.string().optional(),
```

In `src/config/runtime-types.ts`, inside `QualityConfig["commands"]`, after `build?: string;`:

```ts
    /** Coverage gate (e.g. "bun run test:coverage"); agent affordance, never invoked by nax. */
    coverage?: string;
```

In `src/cli/config-descriptions.ts`, beside the `quality.commands.lint` entry:

```ts
  "quality.commands.coverage": "Custom coverage command",
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test test/unit/config/
bun x tsc --noEmit
```

Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
bun run check:all
git add src/config/schemas-execution.ts src/config/runtime-types.ts src/cli/config-descriptions.ts test/unit/config/
git commit -m "feat(config): add quality.commands.coverage so it is not stripped (#1971)"
```

---

### Task 5: Point nax's own config at the gates it actually enforces

nax's `lint` is `bun run lint` (biome + 13 custom scripts). Its own pre-commit hook runs `bun run check:all` — that same chain plus 11 more. So nax can green a story the commit hook then rejects, which is why the agent kept reaching for `check:test-mocks`, `check-test-escape-hatches` and `check:all` by hand.

Measured at plan time on this tree: `lint` 5s, `check:all` 5s. No cost argument against the swap.

**Files:**
- Modify: `.nax/config.json` (`quality.commands`)

**Interfaces:**
- Consumes: `quality.commands.coverage` from Task 4. Doing this task first would silently strip the key.

- [ ] **Step 1: Confirm Task 4 landed**

```bash
git log --oneline -1 -- src/config/schemas-execution.ts
```

Expected: the Task 4 commit. If not, stop and do Task 4 first.

- [ ] **Step 2: Edit `.nax/config.json`**

In `quality.commands`, change `lint` and add `coverage`:

```json
    "lint": "bun run check:all",
    "coverage": "bun run test:coverage",
```

Leave `test`, `typecheck`, `build`, `testScoped`, `lintFix` and `formatFix` untouched. `lintFix` stays `bun run lint:fix`: a `check:file-sizes` failure is not auto-fixable, but `mechanical-lintfix` is `maxAttempts: 1` / `coRun: "exclusive"` (`src/operations/mechanical-lintfix-strategy.ts:82`), so an unfixable finding costs one pass and then falls through to LLM rectification. That is unchanged from today — `bun run lint` already contains 13 non-auto-fixable scripts.

- [ ] **Step 3: Verify both commands resolve and the config parses**

```bash
bun run check:all && echo "check:all OK"
bun run test:coverage >/dev/null 2>&1; echo "test:coverage exit=$?"
bun -e 'const {loadConfig} = await import("./src/config/index.ts"); const c = await loadConfig(process.cwd()); console.log(JSON.stringify(c.quality.commands, null, 2));'
```

Expected: `check:all OK`; `test:coverage` exits 0; the printed commands include `"lint": "bun run check:all"` and `"coverage": "bun run test:coverage"`. If `loadConfig` is not the real export name, find it with `grep -n "export.*loadConfig\|export async function load" src/config/index.ts`.

- [ ] **Step 4: Commit**

```bash
git add .nax/config.json
git commit -m "chore(config): run the full static-check chain and declare coverage (#1971)"
```

---

### Task 6: End-to-end verification against the real denials

Every change so far was unit-tested in isolation. This task confirms the five denial shapes from the #1971 evidence now produce useful messages, and that the full suite is green.

**Files:**
- Test: `test/unit/tools/denial-redirect.test.ts` (one table-driven test)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Write the regression table**

```ts
describe("the #1971 denial shapes each name an affordance", () => {
  const WITH_GREP = new Set(["Glob", "Git", "Delete", "RunCommand", "Grep"]);

  test.each([
    { tool: "RunCommand", verb: "ls -la", expect: "Glob" },
    { tool: "RunCommand", verb: "diff", expect: "Git" },
    { tool: "RunCommand", verb: "git", expect: "Git" },
    { tool: "Git", verb: "grep", expect: "Grep" },
  ])("$tool {$verb} names $expect", ({ tool, verb, expect: want }) => {
    expect(redirectForVerb(tool, verb, WITH_GREP, CMDS)).toContain(want);
  });

  test.each([["bun", "run", "check:all"], ["bun", "run", "check:test-mocks"]])(
    "a lint gate names the declared commands: %s",
    (...argv: string[]) => {
      expect(redirectForArgv(argv, WITH_GREP, CMDS)).toContain("RunCommand");
    },
  );

  test("wc stays unredirected -- nothing serves a line count", () => {
    expect(redirectForVerb("RunCommand", "wc -l a.ts", WITH_GREP, CMDS)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it**

```bash
bun test test/unit/tools/denial-redirect.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full suite and every gate**

```bash
bun run test
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.test.json
bun run check:all
bun run test:coverage
```

Expected: all PASS. `test:coverage` is baseline-ratcheted — if it fails because the new code is under-covered, add the missing unit test rather than updating the baseline.

- [ ] **Step 4: Commit and push**

```bash
git add test/unit/tools/denial-redirect.test.ts
git commit -m "test(tools): cover the #1971 denial shapes end to end (#1971)"
git push -u origin fix/1971-denial-affordance-ssot
```

- [ ] **Step 5: Open the PR**

Title: `fix(tools): denied calls name an affordance the session has (#1971)`

Body must cover: the two structural causes (redirect gated on argv; bare verb refusal), the three fixes, the schema strip that made `coverage` a no-op, the `lint` → `check:all` swap with the 5s/5s measurement, and a test plan listing the commands from Step 3. Close with `Closes #1971`.

---

## Self-Review

**Spec coverage** — #1971's three suggested fixes map to Tasks 1 (name permitted verbs), 2 (verb-branch redirect), 3 (generic declared-commands fallback). The two additions agreed in chat map to Tasks 4 (`coverage` schema) and 5 (nax config). Task 6 verifies against the evidence in the issue body. No requirement is unassigned.

**Placeholder scan** — every code step carries real code; no TBD, no "similar to Task N". Three steps deliberately say *read the existing file first* (Task 1 Step 1 fixture, Task 2 Step 6 `createRunCommandTool` signature, Task 4 test location) rather than guess at a signature the plan author did not verify — those are instructions to check a fact, not deferred decisions.

**Type consistency** — `redirectForVerb(deniedTool, verb, available, declaredCommands)` has the same argument order everywhere it appears (Tasks 2, 6, and the runtime wiring). `redirectForArgv` keeps its existing three-argument signature throughout. `TASK_RUNNERS` and `VERB_TOOLS` are each defined once, in Task 3 and Task 2 respectively. `GIT_READ_VERBS` is reused from the existing module, not redefined.

**Ordering** — Task 4 must precede Task 5 (Step 1 of Task 5 enforces this). Task 3 modifies a function Task 2 calls, so running them out of order would leave Task 2's multi-token path untested against the fallback; Task 3 Step 4 catches that.

**One known risk** — Task 1 changes two denial strings that pre-existing tests may assert exactly. Task 1 Steps 4-5 tell the implementer to expect that and update rather than work around it.
