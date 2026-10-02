# S2-4 — nax-agent's runtime slot (spawn), `bun-deps` to nax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nax-agent spawns every process through a runtime slot. The default is a Node `child_process` runtime; nax installs a Bun runtime at startup. `internal/bun-deps.ts` moves to nax unchanged. One runner-neutral table of spawn behaviour cases pins both runtimes. The nax CLI's behaviour is unchanged.

**Architecture:** `packages/nax-agent/src/runtime/` holds the contract types (`AgentRuntime`, `AgentSpawnOptions`, `AgentSpawnResult`), a PATH `which`, the Node runtime, the slot (`setAgentRuntime`/`getAgentRuntime`), and `runtimeSpawn`, which resolves the slot on every call. nax-agent's four spawn seams (`_gitDeps`, `_argvExecDeps`, `_grepDeps`, `_execSourceDeps`) call `runtimeSpawn`. nax adds `src/agent-runtime/bun-runtime.ts` (`Bun.spawn` as is) and a side-effect `install.ts`, imported first by `bin/nax.ts` and `test/preload.ts`. So every nax path runs exactly today's `Bun.spawn`. The cases live in `@nathapp/nax-test-kit/cases/*`: `node:assert` only, with no runner and no Bun types. They run against the Bun runtime in nax and against the Node runtime in nax-agent.

**Tech Stack:** Bun 1.4 workspaces, TypeScript 7.0.2, Biome 2.5.10, `bun:test`, `node:child_process`, `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§4.2, §4.3, §4.4, §6.2, §9 row S2-4). Glob, the §4.1 built-ins and the §4.5 gate are S2-5. The import codemod and the build are S2-6.

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Branch `feat/s2-4-runtime-spawn` (it carries this plan). Rebase it onto `origin/main` before Task 0.
- Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Bun 1.4.0 in CI; TypeScript `7.0.2` exact; Biome `2.5.10` exact. Node floor `>= 22.19` (spec §1). Windows is unsupported, as for nax.
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`.
- **No test is edited to make it pass.** A test may change only to (a) move, (b) change an import specifier, or (c) retype a spawn stub for the new seam type (spec §4.4: "Tests that stub those seams retype their stubs"). Every (c) edit is listed in its task.
- **Test counts are conserved.** Task 0 records them. After Task 6, the totals equal Task 0's plus exactly the new tests each task lists.
- Both coverage gates stay green: nax (`bun run test:coverage`) and nax-agent (`bun run test:coverage`, whose baseline may only shrink). Every new `src/` file needs at least 80% line coverage.
- No push, no PR, no `nax run` / `nax plan` without the maintainer's explicit approval. Max 2 fix rounds per task review.

## Measured on `main` @ `2427bd9a6` (the design rests on these)

**Bun 1.4.2 `Bun.spawn`, the behaviour the cases record:**
- **Synchronous failures:** a missing binary throws `ENOENT` (on PATH: message `Executable not found in $PATH: "<name>"`; absolute: `ENOENT: … posix_spawn '<path>'`). A missing `cwd` throws `ENOENT` and a `cwd` that is a file throws `ENOTDIR`. A non-executable file throws `EACCES`.
- **Exit:** `exit 3` → `exited` 3, `exitCode` 3, `signalCode` null. `kill("SIGKILL")` → `exited` 137, `exitCode` null, `signalCode` `"SIGKILL"`. `kill()` → SIGTERM, 143. `kill()` after exit does not throw.
- **stdin:** if unset it is ignored (the child reads EOF). `write("héllo")` returns 6, the UTF-8 byte count. Writing after the child exited does **not** throw.
- **stderr:** `stderr: "inherit"` gives `stderr === undefined`.
- **env:** `env` replaces the environment, and `undefined` values are dropped. `exited` resolves when the child exits even if a grandchild still holds stdout (about 10 ms). `detached: true` makes pgid == pid.
- **Prototype:** a Node runtime built to this table (scratch, the code in Task 2) passed **20/20** cases under Bun and under real Node 22.22.2. With all four seams on it, nax-agent's full suites passed: unit 2387/2387, integration 31/31, including the real process-group kill tests (ORPHAN-1).

**Seam retype blast radius:** typing the seams as `AgentRuntime["spawn"]` produced 133 type errors in 32 nax test files and 4 in nax-agent. Every one was a `typeof Bun.spawn` stub, almost all from test-kit's `makeSpawn().spawn`. Typing `SpawnStub.spawn` as `typeof Bun.spawn & CaseRuntime["spawn"]` cleared all but 5. Those 5 are two local stub helpers' declared return types (Task 3). One nax `src/` error remains: `worktree/dependencies.ts` needs an annotation (Task 3).

## Decisions taken in this plan (deviations, each measured)

1. **nax's moved `bun-deps.ts` keeps its own `SpawnResult`/`SpawnOptions` types, and the runtime contract uses distinct names (`AgentSpawnOptions`, `AgentSpawnResult`, `AgentSpawnStdin`).** Spec §4.4 bullet 4 has nax import nax-agent's types. Measured: giving nax's `SpawnResult` the two new fields (`exitCode`, `signalCode`) breaks 33 fakes in 12 nax test files. nax `src/` is unaffected. Bullet 1 says the file moves "unchanged". nax's types describe nax's direct `Bun.spawn` wrapper, a different contract from the slot. Distinct names keep the two from being confused at an import site.
2. **With `env` omitted, the Node runtime inherits the live `process.env`; Bun inherits the environment from process start.** Measured: a variable set with `process.env.X = …` after start is invisible to a `Bun.spawn` child without `env`, but visible to `child_process`. No nax or nax-agent `src/` code assigns `process.env` (grep). Copying Bun's snapshot would be a trap for embedders, so the case table pins inheritance with a launch-time variable (`HOME`) and this difference is documented, not normalised.
3. **The Node runtime resolves `exited` on the process `exit` event, not `close`.** Spec §4.2 says "the `close` event". `close` waits for every stdio stream, so a grandchild holding stdout would delay it. `argv-exec`'s drain-grace logic depends on `exited` resolving at exit, which is Bun's behaviour, measured. A case pins it.
4. **`stderr: "inherit"` is not a case.** Bun returns `undefined`; the Node runtime returns an empty stream (spec §4.2). No nax-agent caller inherits stderr.
5. **The runtime is exported from `.` by name, not from `/internal`.** It is public API (koda may install its own). A named list avoids `export *` silently dropping a colliding name. S2-7 curates `.` anyway.
6. **Writing to stdin after exit never throws in either runtime.** That matches Bun. `helper-process.ts`'s `try/catch` around write/end stays as defence.

## Review Focus

1. **A spawn that fails asynchronously in Node but synchronously in Bun.** Callers (`grep.ts`, `helper-process.ts`, `run-command-exec.ts`) `try/catch` the spawn call. An `error` event after `spawn()` returns would instead reject `exited`, which they do not expect. Pinned by the four synchronous-failure cases (Task 1) running against the Node runtime (Task 2).
2. **An unhandled `error` event on the child's stdin crashing the process** (EPIPE). Pinned by the write-after-exit case.
3. **nax running any spawn on the Node runtime by accident**, for example a nax entry point that does not import the install module first. Pinned in Task 5 by `install.test.ts`, which checks the slot under nax's preload and that `bin/nax.ts`'s first import is the install module.
4. **A seam resolving the runtime at module load instead of per call**, which would freeze whatever was installed when the module was first imported. Pinned in Task 3 (`seam-delegation.test.ts` installs a fake after import).
5. **Process-group kill leaking grandchildren on the Node runtime (ORPHAN-1).** Pinned by the group-kill case, plus `argv-exec`'s existing real-process tests, now running on the Node runtime.

---

## File structure

**New: test-kit** (`packages/test-kit/`)
- `src/cases/runtime-types.ts`: `CaseSpawnResult`, `CaseRuntime` (structural mirror of nax-agent's contract; test-kit depends on no nax package).
- `src/cases/spawn-cases.ts`: `RuntimeCase`, `SPAWN_CASES` (20 cases).
- `package.json` export `"./cases/*": "./src/cases/*.ts"`.

**New: nax-agent** (`packages/nax-agent/`)
- `src/runtime/types.ts`, `src/runtime/which.ts`, `src/runtime/node-runtime.ts`, `src/runtime/slot.ts`, `src/runtime/index.ts`.
- `test/unit/runtime/node-runtime.test.ts`, `which.test.ts`, `slot.test.ts`, `seam-delegation.test.ts`.

**New: nax** (`packages/nax/`)
- `src/agent-runtime/bun-runtime.ts`, `src/agent-runtime/install.ts`.
- `test/unit/agent-runtime/bun-runtime.test.ts`, `test/unit/agent-runtime/install.test.ts`.

**Moved:** `packages/nax-agent/src/internal/bun-deps.ts` → `packages/nax/src/utils/bun-deps.ts` (unchanged).

**Modified:** nax-agent `src/internal/{git-exec,argv-exec}.ts`, `src/tools/grep.ts`, `src/native/credentials/helper-process.ts`, `src/internal.ts`, `src/index.ts`, `scripts/baselines/coverage-per-file-baseline.json`. test-kit `src/bun/spawn.ts`. nax `bin/nax.ts`, `test/preload.ts`, `src/worktree/dependencies.ts`, `test/unit/utils/git-auto-commit-block.test.ts`, `test/integration/tdd/_tdd-test-helpers.ts`, the 32 import sites, and `.nax/mono/packages/nax-agent/context.md`.

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1:** Rebase and install (`git fetch origin && git rebase origin/main && bun install --frozen-lockfile` at the repo root).
- [ ] **Step 2:** Record suite totals (`N pass / skip / fail`) for nax `./test/unit/` and `./test/integration/`, nax-agent `./test/unit/` and `./test/integration/`, and repo-tooling `./test/unit/`. Run each with `bun test <dir> --timeout=60000` from its package directory. Every `fail` must be 0.
- [ ] **Step 3:** Record both coverage gates (`bun run test:coverage` in `packages/nax` and in `packages/nax-agent`): lines, functions, and files below floor.
- [ ] **Step 4:** Record the CLI fingerprint:

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun bin/nax.ts --help | md5
bun bin/nax.ts --version
```

- [ ] **Step 5:** Re-confirm the import inventory. Expected: **32 files**, with per-name counts `sleep 4, which 2, typedSpawn 6, cancellableDelay 9, SpawnOptions 6, SpawnResult 7, spawn 7`, and 13 files importing other `/internal` names alongside.

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
git grep -lE 'import (type )?\{[^}]*\b(spawn|typedSpawn|which|sleep|file|cancellableDelay|SpawnResult|SpawnOptions)\b[^}]*\} from "@nathapp/nax-agent/internal"' -- src test | wc -l
```

Expected: `32`. Another number means `main` moved. Re-run the inventory and carry the new list into Task 4.

No commit.

---

### Task 1: Runner-neutral spawn cases in test-kit, and the stub type

**Files:**
- Create: `packages/test-kit/src/cases/runtime-types.ts`, `packages/test-kit/src/cases/spawn-cases.ts`
- Modify: `packages/test-kit/package.json`, `packages/test-kit/src/bun/spawn.ts`

**Interfaces:**
- Produces: `@nathapp/nax-test-kit/cases/runtime-types` exporting `CaseSpawnResult`, `CaseRuntime`; `@nathapp/nax-test-kit/cases/spawn-cases` exporting `RuntimeCase { name: string; run(runtime: CaseRuntime): Promise<void> }` and `SPAWN_CASES: readonly RuntimeCase[]` (20 cases); `SpawnStub.spawn: typeof Bun.spawn & CaseRuntime["spawn"]`. Tasks 2, 3 and 5 consume these.

- [ ] **Step 1: The structural types** — `packages/test-kit/src/cases/runtime-types.ts`:

```ts
/**
 * The process-spawning contract the spawn cases exercise, mirrored structurally
 * from nax-agent's `AgentRuntime` (src/runtime/types.ts). test-kit depends on no
 * nax package, so it cannot import that type; any runtime matching this shape
 * can run the cases. Runner-neutral: no bun:test, vitest or Bun types.
 */
export interface CaseSpawnResult {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly stdin?: { write(data: string | Uint8Array): number; end(): void; flush(): void };
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CaseRuntime {
  spawn(
    cmd: readonly string[],
    opts: {
      cwd?: string;
      stdin?: "pipe" | "inherit";
      stdout: "pipe";
      stderr: "pipe" | "inherit";
      env?: Record<string, string | undefined>;
      detached?: boolean;
    },
  ): CaseSpawnResult;
}
```

- [ ] **Step 2: The cases** — `packages/test-kit/src/cases/spawn-cases.ts`:

```ts
/**
 * Spawn behaviour cases (spec S2 §4.3): plain data plus node:assert over any
 * runtime of the CaseRuntime shape. Each case records Bun's measured behaviour;
 * a non-Bun runtime normalises to it. Runner-neutral: run them from bun:test or
 * vitest with `for (const c of SPAWN_CASES) test(c.name, () => c.run(runtime))`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseRuntime, CaseSpawnResult } from "./runtime-types";

export interface RuntimeCase {
  readonly name: string;
  run(runtime: CaseRuntime): Promise<void>;
}

const PIPES = { stdout: "pipe", stderr: "pipe" } as const;
const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The error `f` throws synchronously; fails the case if it returns. */
function thrownBy(f: () => unknown): { code?: string } {
  try {
    f();
  } catch (error) {
    return error as { code?: string };
  }
  throw new assert.AssertionError({ message: "expected spawn to throw synchronously" });
}

function stdinOf(p: CaseSpawnResult): NonNullable<CaseSpawnResult["stdin"]> {
  if (p.stdin === undefined) throw new assert.AssertionError({ message: "stdin: 'pipe' gave no stdin" });
  return p.stdin;
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "nax-spawn-case-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export const SPAWN_CASES: readonly RuntimeCase[] = [
  {
    name: "a zero exit: exited 0, exitCode 0, signalCode null",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "exit 0"], PIPES);
      assert.equal(await p.exited, 0);
      assert.equal(p.exitCode, 0);
      assert.equal(p.signalCode, null);
    },
  },
  {
    name: "a non-zero exit is reported as is",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "exit 3"], PIPES);
      assert.equal(await p.exited, 3);
      assert.equal(p.exitCode, 3);
    },
  },
  {
    name: "stdout and stderr carry their own bytes",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "printf 'out-é'; printf 'err' >&2"], PIPES);
      const [out, err] = await Promise.all([text(p.stdout), text(p.stderr)]);
      assert.equal(out, "out-é");
      assert.equal(err, "err");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "stdout.cancel() does not throw and the process still exits",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "yes | head -c 1000000"], PIPES);
      await p.stdout.cancel();
      await p.stderr.cancel();
      assert.equal(typeof (await p.exited), "number");
    },
  },
  {
    name: "stdin write returns the UTF-8 byte count; end() delivers EOF; flush() does not throw",
    async run(rt) {
      const p = rt.spawn(["cat"], { stdin: "pipe", ...PIPES });
      const stdin = stdinOf(p);
      assert.equal(stdin.write("héllo"), 6);
      stdin.flush();
      stdin.end();
      assert.equal(await text(p.stdout), "héllo");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "unset stdin reads as EOF, not the parent's stdin",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "cat; echo done"], PIPES);
      assert.equal((await text(p.stdout)).trim(), "done");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "writing to stdin after the child exited does not throw (a broken pipe is swallowed)",
    async run(rt) {
      const p = rt.spawn(["true"], { stdin: "pipe", ...PIPES });
      await p.exited;
      await pause(50);
      const stdin = stdinOf(p);
      stdin.write("x".repeat(70_000));
      stdin.flush();
      stdin.end();
      await pause(50);
    },
  },
  {
    name: "env replaces the environment; undefined values are dropped",
    async run(rt) {
      const p = rt.spawn(["/bin/sh", "-c", 'echo "[$FOO][$BAR][$HOME]"'], {
        env: { FOO: "foo", BAR: undefined },
        ...PIPES,
      });
      assert.equal((await text(p.stdout)).trim(), "[foo][][]");
    },
  },
  {
    name: "no env inherits the environment the process started with",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", 'echo "$HOME"'], PIPES);
      assert.equal((await text(p.stdout)).trim(), process.env.HOME ?? "");
    },
  },
  {
    name: "cwd sets the working directory",
    run: (rt) =>
      withTempDir(async (dir) => {
        writeFileSync(join(dir, "marker"), "");
        const p = rt.spawn(["ls"], { cwd: dir, ...PIPES });
        assert.equal((await text(p.stdout)).trim(), "marker");
      }),
  },
  {
    name: "a missing binary on PATH throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["nax-no-such-binary-xyz"], PIPES)).code, "ENOENT");
    },
  },
  {
    name: "a missing absolute binary throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["/nonexistent/nax-bin-xyz"], PIPES)).code, "ENOENT");
    },
  },
  {
    name: "a missing cwd throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["true"], { cwd: "/nonexistent/nax-dir-xyz", ...PIPES })).code, "ENOENT");
    },
  },
  {
    name: "a cwd that is a file throws ENOTDIR synchronously",
    run: (rt) =>
      withTempDir(async (dir) => {
        const file = join(dir, "f");
        writeFileSync(file, "");
        assert.equal(thrownBy(() => rt.spawn(["true"], { cwd: file, ...PIPES })).code, "ENOTDIR");
      }),
  },
  {
    name: "kill(SIGKILL): exited 137, exitCode null, signalCode SIGKILL",
    async run(rt) {
      const p = rt.spawn(["sleep", "5"], PIPES);
      p.kill("SIGKILL");
      assert.equal(await p.exited, 137);
      assert.equal(p.exitCode, null);
      assert.equal(p.signalCode, "SIGKILL");
    },
  },
  {
    name: "kill() defaults to SIGTERM: exited 143",
    async run(rt) {
      const p = rt.spawn(["sleep", "5"], PIPES);
      p.kill();
      assert.equal(await p.exited, 143);
      assert.equal(p.signalCode, "SIGTERM");
    },
  },
  {
    name: "kill() after exit does not throw",
    async run(rt) {
      const p = rt.spawn(["true"], PIPES);
      await p.exited;
      p.kill("SIGKILL");
    },
  },
  {
    name: "exited resolves when the child exits even if a grandchild still holds stdout",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "sleep 3 & echo started"], PIPES);
      const started = Date.now();
      await p.exited;
      assert.ok(Date.now() - started < 2000, `exited took ${Date.now() - started}ms`);
      await p.stdout.cancel();
      await p.stderr.cancel();
    },
  },
  {
    name: "detached makes the child its own process-group leader",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "ps -o pgid= -p $$"], { ...PIPES, detached: true });
      assert.equal(Number((await text(p.stdout)).trim()), p.pid);
    },
  },
  {
    name: "killing a detached child's process group leaves no descendants (ORPHAN-1)",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], { ...PIPES, detached: true });
      const reader = p.stdout.getReader();
      const first = await reader.read();
      const grandchild = Number(new TextDecoder().decode(first.value).trim());
      assert.ok(isAlive(grandchild), "the grandchild should be running before the kill");
      process.kill(-p.pid, "SIGKILL");
      await p.exited;
      await reader.cancel();
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = !isAlive(grandchild);
        if (!gone) await pause(25);
      }
      assert.ok(gone, `grandchild ${grandchild} survived the group kill`);
    },
  },
];
```

- [ ] **Step 3: Export the subpath.** In `packages/test-kit/package.json`, `exports` becomes:

```json
  "exports": {
    "./bun/*": "./src/bun/*.ts",
    "./cases/*": "./src/cases/*.ts"
  },
```

- [ ] **Step 4: The stub type.** In `packages/test-kit/src/bun/spawn.ts`:
  - add `import type { CaseRuntime } from "../cases/runtime-types";` at the top;
  - in `interface SpawnStub`, replace `spawn: typeof Bun.spawn;` with:

```ts
  /**
   * Assignable both to `typeof Bun.spawn` (nax's own spawn seams) and to
   * nax-agent's `AgentRuntime["spawn"]` seams, which are typed against the same
   * shape as CaseRuntime.
   */
  spawn: typeof Bun.spawn & CaseRuntime["spawn"];
```

  - change the implementation signature `export function makeSpawn(handler: … = () => "") {` to end in `): unknown {`, the same pattern `makeSpawnResult` uses, so the overload stays compatible. Update its doc's first line to "A `spawn` stub, recording every call."

- [ ] **Step 5: Run the cases against Bun directly (they must pass as written)**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/test-kit
cat > /tmp/s2-4-bun-cases.ts <<'EOF'
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import type { CaseRuntime, CaseSpawnResult } from "@nathapp/nax-test-kit/cases/runtime-types";
const rt: CaseRuntime = { spawn: (cmd, opts) => Bun.spawn([...cmd], opts) as unknown as CaseSpawnResult };
let failed = 0;
for (const c of SPAWN_CASES) await c.run(rt).catch((e) => { failed++; console.log(`FAIL ${c.name}: ${e.message}`); });
console.log(`${SPAWN_CASES.length - failed}/${SPAWN_CASES.length}`);
EOF
cp /tmp/s2-4-bun-cases.ts ./zz-bun-cases.ts && bun ./zz-bun-cases.ts; rm ./zz-bun-cases.ts
bun run typecheck && bun run check:all
```

Expected: `20/20`; typecheck and check:all exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/test-kit
git commit -m "test: runner-neutral spawn behaviour cases in test-kit"
```

---

### Task 2: nax-agent's runtime (types, `which`, Node runtime, slot)

**Files:**
- Create: `packages/nax-agent/src/runtime/{types,which,node-runtime,slot,index}.ts`
- Modify: `packages/nax-agent/src/index.ts`
- Test: `packages/nax-agent/test/unit/runtime/{node-runtime,which,slot}.test.ts`

**Interfaces:**
- Consumes: Task 1's `SPAWN_CASES`.
- Produces (from `#src/runtime/index`, and from `@nathapp/nax-agent`): `AgentRuntime { spawn(cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult }`, `AgentSpawnOptions`, `AgentSpawnResult`, `AgentSpawnStdin`, `nodeRuntime: AgentRuntime`, `setAgentRuntime(runtime: AgentRuntime | null): void`, `getAgentRuntime(): AgentRuntime`, `runtimeSpawn: AgentRuntime["spawn"]`. From `#src/runtime/which`: `which(name: string, pathEnv?: string): string | null`.

New tests: **28** (node-runtime 20, which 5, slot 3).

- [ ] **Step 1: Write the failing tests**

`test/unit/runtime/node-runtime.test.ts`:

```ts
import { describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { nodeRuntime } from "#src/runtime/index";

describe("nodeRuntime meets the spawn behaviour cases", () => {
  for (const c of SPAWN_CASES) test(c.name, () => c.run(nodeRuntime), 15_000);
});
```

`test/unit/runtime/which.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { which } from "#src/runtime/which";

describe("which", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupTempDir(d);
  });
  const tmp = (): string => {
    const d = makeTempDir("nax-which-");
    dirs.push(d);
    return d;
  };

  test("finds an executable on PATH", () => {
    expect(which("sh")).toMatch(/\/sh$/);
  });

  test("returns null for a name on no PATH entry", () => {
    expect(which("nax-no-such-binary-xyz")).toBeNull();
  });

  test("a name with a slash is checked as a path: executable or null", () => {
    const d = tmp();
    const exe = join(d, "tool");
    const plain = join(d, "data");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);
    expect(which(exe)).toBe(exe);
    expect(which(plain)).toBeNull();
  });

  test("searches only the PATH it is given", () => {
    expect(which("sh", "/nonexistent-nax-path")).toBeNull();
  });

  test("skips a directory that has the binary's name", () => {
    const d = tmp();
    mkdirSync(join(d, "tool"));
    expect(which("tool", d)).toBeNull();
  });
});
```

`test/unit/runtime/slot.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { type AgentRuntime, getAgentRuntime, nodeRuntime, setAgentRuntime } from "#src/runtime/index";

const fake: AgentRuntime = {
  spawn: () => {
    throw new Error("fake runtime");
  },
};

describe("agent runtime slot", () => {
  afterEach(() => setAgentRuntime(null));

  test("serves the Node runtime when nothing is installed", () => {
    expect(getAgentRuntime()).toBe(nodeRuntime);
  });

  test("serves the installed runtime", () => {
    setAgentRuntime(fake);
    expect(getAgentRuntime()).toBe(fake);
  });

  test("installing null restores the Node default", () => {
    setAgentRuntime(fake);
    setAgentRuntime(null);
    expect(getAgentRuntime()).toBe(nodeRuntime);
  });
});
```

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun test ./test/unit/runtime/ --timeout=60000
```

Expected: FAIL. `#src/runtime/index` and `#src/runtime/which` do not exist.

- [ ] **Step 2: `src/runtime/types.ts`**

```ts
/**
 * The process-spawning contract nax-agent's tools run through (spec S2 §4.2).
 * The shape records Bun.spawn's measured behaviour; the Node default
 * (node-runtime.ts) normalises to it, and nax installs Bun.spawn itself.
 *
 * Distinct from nax's own `SpawnOptions`/`SpawnResult` (packages/nax/src/utils/
 * bun-deps.ts), which describe nax's direct Bun.spawn wrapper.
 */
export interface AgentSpawnOptions {
  cwd?: string;
  stdin?: "pipe" | "inherit";
  stdout: "pipe";
  stderr: "pipe" | "inherit";
  /** Replaces the environment; `undefined` values are dropped. Omitted: inherit. */
  env?: Record<string, string | undefined>;
  /** setsid: the child becomes its own process-group leader, so a group kill reaches its descendants (ORPHAN-1). */
  detached?: boolean;
}

export interface AgentSpawnStdin {
  /** Returns the number of bytes written. Never throws for a child that already exited. */
  write(data: string | Uint8Array): number;
  end(): void;
  flush(): void;
}

export interface AgentSpawnResult {
  readonly stdout: ReadableStream<Uint8Array>;
  /** With `stderr: "inherit"` there is nothing to read; callers that inherit never read it. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** The exit code, or 128 + the signal number for a signal exit. Resolves at exit, not when the pipes close. */
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly stdin?: AgentSpawnStdin;
  /** `null` until exit, and after a signal exit. */
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * The slot's contract. `spawn` throws synchronously when the process cannot be
 * started (missing binary, missing or non-directory cwd, not executable).
 */
export interface AgentRuntime {
  spawn(cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult;
}
```

- [ ] **Step 3: `src/runtime/which.ts`**

```ts
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first executable regular file named `name` on `pathEnv` (POSIX; Windows is
 * unsupported, as for nax). A name containing "/" is checked as a path.
 */
export function which(name: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (name.includes("/")) return isExecutableFile(name) ? name : null;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
```

- [ ] **Step 4: `src/runtime/node-runtime.ts`**

```ts
/**
 * The default runtime: node:child_process adapted to AgentSpawnResult, normalised
 * to Bun.spawn's measured behaviour (the spawn cases in @nathapp/nax-test-kit).
 *
 * Known difference, kept on purpose: with `env` omitted the child inherits the
 * live process.env, where Bun passes the environment the process started with.
 */
import { spawn as spawnChild } from "node:child_process";
import { statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
import type { AgentRuntime, AgentSpawnOptions, AgentSpawnResult, AgentSpawnStdin } from "./types";
import { which } from "./which";

type SpawnErrorCode = "ENOENT" | "ENOTDIR" | "EACCES";
const ERRNO: Record<SpawnErrorCode, number> = { ENOENT: -2, ENOTDIR: -20, EACCES: -13 };

function spawnError(code: SpawnErrorCode, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: ERRNO[code], syscall: "posix_spawn", path });
}

/** Bun fails a spawn synchronously; child_process reports it later, so check first. */
function precheck(cmd: readonly string[], opts: AgentSpawnOptions): string {
  const bin = cmd[0];
  if (bin === undefined || bin === "") throw new TypeError("spawn: empty argv");
  if (opts.cwd !== undefined) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(opts.cwd).isDirectory();
    } catch {
      throw spawnError("ENOENT", `ENOENT: no such file or directory, posix_spawn '${bin}'`, bin);
    }
    if (!isDirectory) throw spawnError("ENOTDIR", `ENOTDIR: not a directory, posix_spawn '${bin}'`, bin);
  }
  if (bin.includes("/")) {
    try {
      statSync(bin);
    } catch {
      throw spawnError("ENOENT", `ENOENT: no such file or directory, posix_spawn '${bin}'`, bin);
    }
    if (which(bin) === null) throw spawnError("EACCES", `EACCES: permission denied, posix_spawn '${bin}'`, bin);
    return bin;
  }
  if (which(bin, opts.env?.PATH ?? process.env.PATH) === null) {
    throw Object.assign(new Error(`Executable not found in $PATH: "${bin}"`), { code: "ENOENT", errno: -2, path: bin });
  }
  return bin;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** 128 + n for a signal exit, as Bun reports it. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + (signal !== null ? (osConstants.signals[signal] ?? 0) : 0);
}

function toWeb(stream: Readable | null): ReadableStream<Uint8Array> {
  return stream === null ? emptyStream() : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
}

export function nodeSpawn(cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult {
  const bin = precheck(cmd, opts);
  const child = spawnChild(bin, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env !== undefined ? definedEnv(opts.env) : process.env,
    stdio: [opts.stdin ?? "ignore", "pipe", opts.stderr],
    detached: opts.detached === true,
  });
  // A broken pipe on stdin is swallowed, as Bun does; an unhandled 'error' event would crash the process.
  child.stdin?.on("error", () => {});
  // 'exit', not 'close': a grandchild still holding a pipe must not delay it (Bun resolves at exit).
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(exitStatus(code, signal)));
  });
  const stdin: AgentSpawnStdin | undefined =
    opts.stdin === "pipe" && child.stdin !== null
      ? {
          write: (data) => {
            if (child.stdin !== null && !child.stdin.destroyed) child.stdin.write(data);
            return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          },
          end: () => {
            child.stdin?.end();
          },
          flush: () => {},
        }
      : undefined;
  return {
    stdout: toWeb(child.stdout),
    stderr: opts.stderr === "pipe" ? toWeb(child.stderr) : emptyStream(),
    exited,
    pid: child.pid ?? -1,
    stdin,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

export const nodeRuntime: AgentRuntime = { spawn: nodeSpawn };
```

- [ ] **Step 5: `src/runtime/slot.ts` and `src/runtime/index.ts`**

```ts
// src/runtime/slot.ts
import { nodeRuntime } from "./node-runtime";
import type { AgentRuntime } from "./types";

let installed: AgentRuntime | null = null;

/**
 * Install (or, with `null`, clear) the process-wide runtime. nax installs its
 * Bun runtime at startup; an embedder may install its own. Like the logger
 * slot, it is module-level; S3 decides whether it becomes per-session.
 */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  installed = runtime;
}

/** The installed runtime, or the Node default. */
export function getAgentRuntime(): AgentRuntime {
  return installed ?? nodeRuntime;
}

/** Spawn through whatever runtime is installed at the moment of the call. */
export const runtimeSpawn: AgentRuntime["spawn"] = (cmd, opts) => getAgentRuntime().spawn(cmd, opts);
```

```ts
// src/runtime/index.ts
export { nodeRuntime, nodeSpawn } from "./node-runtime";
export { getAgentRuntime, runtimeSpawn, setAgentRuntime } from "./slot";
export type { AgentRuntime, AgentSpawnOptions, AgentSpawnResult, AgentSpawnStdin } from "./types";
```

In `src/index.ts`, add after the last `export *` line:

```ts
export {
  type AgentRuntime,
  type AgentSpawnOptions,
  type AgentSpawnResult,
  type AgentSpawnStdin,
  getAgentRuntime,
  nodeRuntime,
  setAgentRuntime,
} from "#src/runtime/index";
```

- [ ] **Step 6: Run, check, commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun test ./test/unit/runtime/ --timeout=60000
bun run typecheck && bun run check:all
```

Expected: 28 pass, 0 fail; checks exit 0. `check-complexity` may flag `nodeSpawn` or `precheck`. If it does, split it, e.g. move the `stdin` adapter into `function pipedStdin(child): AgentSpawnStdin | undefined`. Do not baseline.

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent
git commit -m "feat: nax-agent runtime slot with a Node child_process default"
```

---

### Task 3: nax-agent's spawn seams go through the slot

**Files:**
- Modify: `packages/nax-agent/src/internal/git-exec.ts`, `src/internal/argv-exec.ts`, `src/tools/grep.ts`, `src/native/credentials/helper-process.ts`
- Modify (rule (c) retypes): `packages/nax/test/unit/utils/git-auto-commit-block.test.ts`, `packages/nax/test/integration/tdd/_tdd-test-helpers.ts`
- Modify: `packages/nax/src/worktree/dependencies.ts`
- Test: `packages/nax-agent/test/unit/runtime/seam-delegation.test.ts`

**Interfaces:**
- Consumes: Task 2's `runtimeSpawn`, `setAgentRuntime`, `AgentRuntime`, `AgentSpawnResult`, `AgentSpawnStdin`, and `which` from `#src/runtime/which`.
- Produces: `_gitDeps.spawn`, `_argvExecDeps.spawn`, `_grepDeps.spawn` typed `AgentRuntime["spawn"]`; `_grepDeps.which: (name: string) => string | null`.

New tests: **4**.

- [ ] **Step 1: Write the failing test** — `test/unit/runtime/seam-delegation.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { _execSourceDeps } from "#src/native/credentials/helper-process";
import { _argvExecDeps } from "#src/internal/argv-exec";
import { _gitDeps } from "#src/internal/git-exec";
import { type AgentRuntime, setAgentRuntime } from "#src/runtime/index";
import { _grepDeps } from "#src/tools/grep";

/** A runtime installed AFTER the seams' modules loaded: a seam that captured the runtime at load would miss it. */
function recordingRuntime(): AgentRuntime & { calls: { cmd: readonly string[]; stdin?: string }[] } {
  const calls: { cmd: readonly string[]; stdin?: string }[] = [];
  return {
    calls,
    spawn(cmd, opts) {
      calls.push({ cmd, stdin: opts.stdin });
      throw new Error("recorded");
    },
  };
}

describe("nax-agent's spawn seams resolve the runtime slot per call", () => {
  afterEach(() => setAgentRuntime(null));

  test.each([
    ["_gitDeps", () => _gitDeps.spawn(["git", "status"], { stdout: "pipe", stderr: "pipe" })],
    ["_argvExecDeps", () => _argvExecDeps.spawn(["echo", "x"], { stdout: "pipe", stderr: "pipe" })],
    ["_grepDeps", () => _grepDeps.spawn(["rg", "x"], { stdout: "pipe", stderr: "pipe" })],
  ] as const)("%s.spawn goes through the installed runtime", (_name, call) => {
    const rt = recordingRuntime();
    setAgentRuntime(rt);
    expect(call).toThrow("recorded");
    expect(rt.calls).toHaveLength(1);
  });

  test("_execSourceDeps.spawn goes through the installed runtime with stdin piped", () => {
    const rt = recordingRuntime();
    setAgentRuntime(rt);
    expect(() => _execSourceDeps.spawn(["helper"])).toThrow("recorded");
    expect(rt.calls).toEqual([{ cmd: ["helper"], stdin: "pipe" }]);
  });
});
```

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun test ./test/unit/runtime/seam-delegation.test.ts --timeout=60000
```

Expected: FAIL. The seams call `Bun.spawn` directly: `git status` actually runs, nothing throws `"recorded"`, and `rt.calls` stays empty.

- [ ] **Step 2: Rewire the four seams**

`src/internal/git-exec.ts`: replace `import { spawn } from "./bun-deps";` with `import { runtimeSpawn } from "#src/runtime/index";`, and `_gitDeps`'s `spawn,` with `spawn: runtimeSpawn,`.

`src/internal/argv-exec.ts`: the same two edits for `_argvExecDeps`.

`src/tools/grep.ts`: replace `import { spawn, which } from "#src/internal/bun-deps";` with:

```ts
import { runtimeSpawn } from "#src/runtime/index";
import { which } from "#src/runtime/which";
```

and `export const _grepDeps = { which, spawn };` with:

```ts
export const _grepDeps = {
  which: (name: string): string | null => which(name),
  spawn: runtimeSpawn,
};
```

`src/native/credentials/helper-process.ts`: add `import { type AgentSpawnResult, type AgentSpawnStdin, runtimeSpawn } from "#src/runtime/index";`. Above `_execSourceDeps`, add:

```ts
/** A piped spawn always has stdin; a runtime that broke that is a spawn failure, caught by the caller. */
function hasStdin(proc: AgentSpawnResult): proc is AgentSpawnResult & { readonly stdin: AgentSpawnStdin } {
  return proc.stdin !== undefined;
}

function spawnHelper(argv: readonly string[]): HelperProcess {
  // nax-git-env-allow: caller-supplied helper argv, not git; the child inherits nax's env by contract
  const proc = runtimeSpawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (!hasStdin(proc)) throw new Error("the runtime returned no stdin for a piped spawn");
  return proc;
}
```

and replace the `spawn:` property (with its two-line body and the `nax-git-env-allow` comment) with `spawn: spawnHelper,`. Change the `HelperProcess` doc line "The slice of Bun's Subprocess this module uses." to "The slice of the runtime's spawn result this module uses." Update the comment at the `spawn-failed` branch, "A missing binary never reaches `exited`: Bun throws ENOENT from spawn.", to "A missing binary never reaches `exited`: the runtime throws ENOENT from spawn."

- [ ] **Step 3: Run nax-agent**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun test ./test/unit/runtime/ --timeout=60000
bun test ./test/unit/ --timeout=60000 2>&1 | tail -4
bun test ./test/integration/ --timeout=60000 2>&1 | tail -4
bun run typecheck && bun run check:all
```

Expected: runtime 32 pass. Unit = Task 0 + 28 + 4, 0 fail (every real git, `runArgv` and grep process now runs on the Node runtime). Integration unchanged, 0 fail. Checks exit 0.

- [ ] **Step 4: nax's type fallout (rule (c))**

- `packages/nax/src/worktree/dependencies.ts`: `export const _worktreeDependencyDeps = _argvExecDeps;` becomes `export const _worktreeDependencyDeps: typeof _argvExecDeps = _argvExecDeps;` (TS2883: the inferred type now names nax-agent's runtime types).
- `packages/nax/test/unit/utils/git-auto-commit-block.test.ts`: `function mockSpawnOutput(output: string, exitCode = 0): typeof Bun.spawn {` becomes `…: typeof _gitDeps.spawn {`.
- `packages/nax/test/integration/tdd/_tdd-test-helpers.ts`: the `presentAsSpawn` overload's return type `typeof Bun.spawn` becomes `typeof Bun.spawn & typeof _gitDeps.spawn` (it is assigned to nax's Bun-typed seams and to `_gitDeps.spawn`).

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun run typecheck
bun test ./test/unit/utils/git-auto-commit-block.test.ts ./test/unit/worktree/ ./test/integration/tdd/ --timeout=60000 2>&1 | tail -4
bun run check:all
```

Expected: typecheck exit 0 (src and tests). Those tests pass at their Task 0 counts. check:all exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax-agent packages/nax
git commit -m "refactor: nax-agent's spawn seams go through the runtime slot"
```

---

### Task 4: `bun-deps.ts` moves to nax

**Files:**
- Move: `packages/nax-agent/src/internal/bun-deps.ts` → `packages/nax/src/utils/bun-deps.ts`
- Modify: `packages/nax-agent/src/internal.ts`, `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`, the 32 nax import sites.

**Interfaces:**
- Produces: `packages/nax/src/utils/bun-deps.ts` exporting exactly what it exported before (`SpawnResult`, `SpawnOptions`, `typedSpawn`, `which`, `sleep`, `cancellableDelay`, `file`, `spawn`).

- [ ] **Step 1: Move and drop the re-export**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages
git mv nax-agent/src/internal/bun-deps.ts nax/src/utils/bun-deps.ts
grep -n 'internal/bun-deps' nax-agent/src/internal.ts
```

Delete the line `export * from "#src/internal/bun-deps";` from `nax-agent/src/internal.ts`. Then `git grep -n "bun-deps" -- nax-agent/src` must print nothing.

- [ ] **Step 2: Rewrite the nax import sites, scripted**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
python3 - <<'EOF'
import re, subprocess
NAMES = {"spawn", "typedSpawn", "which", "sleep", "file", "cancellableDelay", "SpawnResult", "SpawnOptions"}
RE = re.compile(r'import(\s+type)?\s*\{([^}]*)\}\s*from\s*"@nathapp/nax-agent/internal";')
files = subprocess.run(["git", "ls-files", "src", "test"], capture_output=True, text=True).stdout.split()
changed = 0
for f in (x for x in files if x.endswith((".ts", ".tsx"))):
    src = open(f).read()
    def split(m):
        all_type = m.group(1) is not None
        specs = [s.strip() for s in m.group(2).split(",") if s.strip()]
        base = lambda s: re.sub(r"^type\s+", "", s).split(" as ")[0].strip()
        moved = [s for s in specs if base(s) in NAMES]
        if not moved:
            return m.group(0)
        kept = [s for s in specs if base(s) not in NAMES]
        t = "type " if all_type else ""
        out = []
        if kept:
            out.append(f'import {t}{{ {", ".join(kept)} }} from "@nathapp/nax-agent/internal";')
        out.append(f'import {t}{{ {", ".join(moved)} }} from "@/utils/bun-deps";')
        return "\n".join(out)
    new = RE.sub(split, src)
    if new != src:
        open(f, "w").write(new)
        changed += 1
print("files changed:", changed)
EOF
bun x biome check --write src test >/dev/null 2>&1; bun x biome check --error-on-warnings src test 2>&1 | tail -2
git grep -nE 'import (type )?\{[^}]*\b(typedSpawn|cancellableDelay|SpawnResult|SpawnOptions)\b[^}]*\} from "@nathapp/nax-agent/internal"' -- src test || echo "no bun-deps names left on /internal"
```

Expected: `files changed: 32`, Biome clean, and `no bun-deps names left on /internal`. If Biome reports an unused import or a duplicate, merge it by hand; that is still rule (b).

- [ ] **Step 3: Drop the moved file's coverage entry from nax-agent's baseline**

Remove the `"src/internal/bun-deps.ts": …` line from `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`. The file is gone from the package.

- [ ] **Step 4: Run**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax-agent
bun run typecheck && bun run check:all && bun test ./test/unit/ --timeout=60000 2>&1 | tail -3
cd ../nax
bun run typecheck && bun run check:all
bun test ./test/unit/ --timeout=60000 2>&1 | tail -4
bun test ./test/integration/ --timeout=60000 2>&1 | tail -4
```

Expected: everything exits 0. nax unit and integration equal Task 0 (no nax test added yet), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A packages/nax packages/nax-agent
git commit -m "refactor: move bun-deps from nax-agent to nax, unchanged"
```

---

### Task 5: nax installs its Bun runtime

**Files:**
- Create: `packages/nax/src/agent-runtime/bun-runtime.ts`, `packages/nax/src/agent-runtime/install.ts`
- Modify: `packages/nax/bin/nax.ts`, `packages/nax/test/preload.ts`
- Test: `packages/nax/test/unit/agent-runtime/bun-runtime.test.ts`, `packages/nax/test/unit/agent-runtime/install.test.ts`

**Interfaces:**
- Consumes: Task 2's `setAgentRuntime`, `getAgentRuntime`, `AgentRuntime`, `AgentSpawnResult` from `@nathapp/nax-agent`; Task 1's `SPAWN_CASES`.
- Produces: `bunAgentRuntime: AgentRuntime`; the side-effect module `src/agent-runtime/install.ts`.

New tests: **22** (bun-runtime 20, install 2).

- [ ] **Step 1: Write the failing tests**

`test/unit/agent-runtime/bun-runtime.test.ts`:

```ts
import { describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

describe("nax's Bun runtime meets the spawn behaviour cases", () => {
  for (const c of SPAWN_CASES) test(c.name, () => c.run(bunAgentRuntime), 15_000);
});
```

`test/unit/agent-runtime/install.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAgentRuntime } from "@nathapp/nax-agent";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

describe("nax installs its Bun runtime", () => {
  test("every nax test runs nax-agent on the Bun runtime (installed by the preload)", () => {
    expect(getAgentRuntime()).toBe(bunAgentRuntime);
  });

  test("bin/nax.ts imports the install module before anything else", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../bin/nax.ts")).text();
    const firstImport = source.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "../src/agent-runtime/install";');
  });
});
```

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun test ./test/unit/agent-runtime/ --timeout=60000
```

Expected: FAIL, because `@/agent-runtime/bun-runtime` does not exist.

- [ ] **Step 2: Implement**

`src/agent-runtime/bun-runtime.ts`:

```ts
import type { AgentRuntime, AgentSpawnResult } from "@nathapp/nax-agent";

/**
 * nax's runtime for nax-agent: Bun.spawn as is, so every nax CLI path keeps the
 * exact process behaviour it had before the runtime slot existed (spec S2 §4.2).
 * Installed by ./install.ts; nax-agent's own Node default stays unused in nax.
 */
export const bunAgentRuntime: AgentRuntime = {
  spawn: (cmd, opts) => Bun.spawn([...cmd], opts) as unknown as AgentSpawnResult,
};
```

`src/agent-runtime/install.ts`:

```ts
/**
 * Side-effect module: installs nax's Bun runtime into nax-agent's runtime slot.
 * Imported FIRST by bin/nax.ts and test/preload.ts, so every nax path (including
 * ones that never call initLogger, such as --help) and every nax test runs it.
 * Never reset.
 */
import { setAgentRuntime } from "@nathapp/nax-agent";
import { bunAgentRuntime } from "./bun-runtime";

setAgentRuntime(bunAgentRuntime);
```

`bin/nax.ts`: insert `import "../src/agent-runtime/install";` as the first import line (above `import { existsSync, … } from "node:fs";`). `test/preload.ts`: insert `import "../src/agent-runtime/install";` as its first import line. Biome leaves a side-effect import in place; check that it did.

- [ ] **Step 3: Run, check**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax
bun test ./test/unit/agent-runtime/ --timeout=60000
bun run typecheck && bun run check:all
bun bin/nax.ts --help | md5
bun bin/nax.ts --version
```

Expected: 22 pass; checks exit 0; the `--help` md5 and `--version` equal Task 0 Step 4.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax
git commit -m "feat: nax installs a Bun runtime into nax-agent's runtime slot"
```

---

### Task 6: Context, verify, record

**Files:** `.nax/mono/packages/nax-agent/context.md`, generated files.

- [ ] **Step 1: Context.** In `.nax/mono/packages/nax-agent/context.md`:
  - in the source layout block, replace the `internal/` line's mention of "argv exec" helpers with what remains, and add a line `├── runtime/            # the runtime slot: AgentRuntime contract, Node default, which`;
  - in Engineering Rules, add this bullet:

```markdown
- **Spawn only through the runtime slot.** `runtimeSpawn` / `getAgentRuntime().spawn` from `#src/runtime/index`; never `Bun.spawn` or `node:child_process` directly. The Node runtime is the default; nax installs a Bun runtime (`packages/nax/src/agent-runtime/install.ts`). New spawn behaviour gets a case in `@nathapp/nax-test-kit/cases/spawn-cases`, which both runtimes run.
```

  Then regenerate: `bun packages/nax/bin/nax.ts generate && bun packages/nax/bin/nax.ts generate --all-packages`. Expect only nax-agent's generated agent files to change.

- [ ] **Step 2: Totals.** Re-run Task 0 Step 2. Expected:
  - nax-agent unit = before + 32 (Task 2: 28, Task 3: 4);
  - nax unit = before + 22 (Task 5);
  - integration unchanged in both packages; repo-tooling unchanged;
  - 0 fail anywhere.

- [ ] **Step 3: Gates.**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck && bun run check:all
cd packages/nax && bun run test:coverage 2>&1 | tail -6 && bun run build 2>&1 | tail -2
cd ../nax-agent && bun run test:coverage 2>&1 | tail -6
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git diff origin/main -- packages/nax/package.json | grep -A3 '"dependencies"' || echo "nax dependencies untouched"
```

Expected: all exit 0. nax-agent's baseline count is at most Task 0's minus 1 (bun-deps gone), with no new file under 80%: the five runtime files are covered by the cases and unit tests. nax shows no new file below the floor (`src/utils/bun-deps.ts` was at or above 80% in nax's former combined run). `nax dependencies untouched`.

- [ ] **Step 4: Commit and record.** Commit the context change (`docs: nax-agent spawns through the runtime slot`). Put the measured block, the six decisions and the totals in the PR body. The PR is not opened without the maintainer's approval.

---

## Self-review notes

- Spec §4.2: the slot, the Node default, nax's install point and the `SpawnResult` additions (`exitCode`, `signalCode`, 128+n, synchronous failure, stdin byte count) are covered in Tasks 2 and 5. Glob is deferred to S2-5 by §9.
- Spec §4.3: the spawn cases cover every listed item. They run against Bun (nax, Task 5) and Node (nax-agent, Task 2). The vitest runs are S2-8.
- Spec §4.4: `bun-deps` moves unchanged (Task 4), and nax-agent's users switch to the slot (Task 3, including `helper-process.ts:66`). Seams are retyped (Task 3), and test-kit's stub gains the intersection type (Task 1). The types stay separate by decision 1.
- Spec §6.2: `test-kit/cases` is created as a runner-neutral subpath (Task 1).
- Names are consistent across tasks: `AgentRuntime`, `AgentSpawnOptions`, `AgentSpawnResult`, `AgentSpawnStdin`, `nodeRuntime`, `nodeSpawn`, `setAgentRuntime`, `getAgentRuntime`, `runtimeSpawn`, `which`, `bunAgentRuntime`, `SPAWN_CASES`, `CaseRuntime`, `CaseSpawnResult`, `RuntimeCase`.
