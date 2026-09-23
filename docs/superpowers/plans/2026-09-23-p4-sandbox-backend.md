# P4 Sandbox Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sandbox every agent-authored `Bash` and `RunCommand` `Exec` command with `@anthropic-ai/sandbox-runtime` (srt) behind a backend interface, opt-in via `execution.sandbox.enabled`, so `raw` bash runs with its blast radius capped.

**Architecture:** A new `src/sandbox/` module owns the backend interface, the srt backend (the only importer of srt, loaded lazily), a pure per-call policy builder, a real availability probe, and a `CommandLauncher`. The launcher is passed ONLY into the two agent-authored spawn sites (`bash.ts`, `run-command-exec.ts`), so user-authored commands can never be wrapped (D14 by construction). The async probe runs in `resolveCodingToolSupport`; its result reaches the synchronous `buildCodingToolSupport` as data, where it selects tool descriptions and — for `raw` with an unavailable sandbox — a compile-time policy refusal.

**Tech Stack:** Bun 1.4 + TypeScript strict, `bun:test`, zod 4 (use `.prefault({})` for nested defaults — `.default({})` does NOT apply inner defaults in zod 4), Biome, `@anthropic-ai/sandbox-runtime` pinned `0.0.77`.

**Spec:** `docs/superpowers/specs/2026-09-23-p4-sandbox-backend-design.md` — read it in full first, especially §2 (spike findings F1–F6) and §12 (review record). Every "F-number" below refers to it.

**Branch:** `feat/p4-sandbox-backend` (already exists, carries the spec). Branch directly; do not create a worktree.

## Global Constraints

- `@anthropic-ai/sandbox-runtime` pinned EXACTLY `0.0.77` in `dependencies` (not `devDependencies`, not `^`).
- srt is imported ONLY from `src/sandbox/srt-backend.ts`, and only via dynamic `import()` so a run that never sandboxes never loads it.
- `bun run build` passes `--external "@anthropic-ai/sandbox-runtime"` (srt resolves vendored binaries relative to its own files).
- `execution.sandbox.enabled` defaults to `false`. No default posture changes in this plan.
- Every path in a `SandboxPolicy` is absolute, literal (no `*`, `?`, `[`, `{`), and passed through `realOrRaw` (`src/utils/realpath.ts`). F1: Linux silently drops glob denies.
- srt's returned `env` NEVER reaches the child. `SandboxBackend.wrap` returns argv only (F6).
- A wrap that throws after the probe reported `available` is a tool ERROR — the command never runs unwrapped.
- `src/` files stay ≤ 600 lines (`bun run check:file-sizes`); `coding-tool-support.ts` is at 594 before Task 1.
- `src/` uses Bun-native file APIs (`Bun.file`/`Bun.write`), never `fs.readFileSync`/`fs.writeFileSync`; `node:fs` `existsSync`/`readdirSync`/`mkdirSync` and `node:fs/promises` are in use in `src/` and allowed.
- No `mock.module()`; inject via exported `_xxxDeps` objects and restore with `withDepsRestore` from `@test/helpers`.
- Never construct `join(homedir(), ".nax", …)` — use `globalConfigDir()` from `src/config/paths`.
- Test commands: targeted `bun test <file> --timeout=30000`; full `bun run test`. NEVER bare `bun test` with no path. `bun run typecheck` is NOT part of `check:all` — run it explicitly. The pre-commit hook runs typecheck + `check:all`; a commit that fails it did not happen — fix and re-commit, never `--no-verify`.
- Run `bun run lint:fix` before every commit: the pre-commit hook runs `biome check --error-on-warnings`, and import order / formatting in the snippets below is not guaranteed to match Biome. Biome also bans `../../*` relative imports (`style.noRestrictedImports`) — use the `@/` alias from two levels deep.
- Conventional commits (`feat(sandbox): …`, `refactor(agents): …`, `test(sandbox): …`, `docs(adr): …`). No emojis in code or comments.
- nax is a PUBLIC repo: never name private projects in code, comments, ADR text or commit messages.

## Known pre-existing defect — OUT OF SCOPE for this plan

Found during the plan's final review and reproduced on `e0625f27c` through `buildCodingToolSupport` → `runtime.callTool` (macOS): under `raw` with NO sandbox, `echo x > .nax/config.json` returns `ok` and overwrites the file, while the same write to `.nax/features/<f>/prd.json` is correctly denied. The protected-path check involved is `isNaxConfigFile` (`src/tools/nax-owned-writes.ts:34`, called from `policy-bash-raw.ts:82`). Do NOT fix it inside this plan and do not weaken any test to accommodate it: it is being handled separately. The sandbox (this plan) closes it only when `execution.sandbox.enabled` is true; Task 12's live D13a test runs WITH the sandbox, so it is unaffected.

## Review Focus

1. **A secret in `quality.stripEnvVars` reappears inside a sandboxed command** — expected: stripped exactly as today (F6). Pinned in Task 7 (launcher unit test with a fake backend) and Task 12 (live).
2. **A protected path whose parent is a symlinked temp dir (`/var/folders` → `/private/var/folders`, `/tmp` → `/private/tmp`) and does not exist yet** — expected: still denied. Pinned in Task 5 (`realOrRaw` on every emitted path) and Task 12 (live, root under `os.tmpdir()`).
3. **`approvals.json` placed inside a write root because `outputDir` points under `~/.cache` or `/tmp`** — expected: still unwritable, because it is always in `denyWrite`. Pinned in Task 5 and Task 12.
4. **srt's `wrap` throws mid-run after a successful probe** (unstable API, transient failure) — expected: the tool returns an error naming the sandbox; the command does NOT run unwrapped. Pinned in Task 7.
5. **An Exec call with `target: "package"`** (cwd = package dir, not the root) — expected: runs in the package dir, write roots still derived from the story root, and the Yarn `env` overlay still applied. Pinned in Task 9.

---

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `src/agents/coding-tool-extras.ts` | (Task 1) builds the session-local RunCommand + Bash tools — moved out of `coding-tool-support.ts` |
| `src/config/schemas-sandbox.ts` | (Task 3) `SandboxConfigSchema`, `DEFAULT_SANDBOX_CONFIG` |
| `src/sandbox/types.ts` | (Task 4) all sandbox types |
| `src/sandbox/argv-quote.ts` | (Task 4) POSIX single-quote quoting for Exec |
| `src/sandbox/defaults.ts` | (Task 5) built-in cache write roots, credential read denies |
| `src/sandbox/policy-builder.ts` | (Task 5) pure `buildSandboxPolicy` |
| `src/sandbox/policy-inputs.ts` | (Task 5) I/O: feature prd paths, credential files, git layout |
| `src/sandbox/srt-backend.ts` | (Task 6) the only srt importer |
| `src/sandbox/probe.ts` | (Task 6) real availability probe |
| `src/sandbox/registry.ts` | (Task 6) process-level backend + probe cache, reset |
| `src/sandbox/messages.ts` | (Task 7) every agent-facing sandbox sentence |
| `src/sandbox/launcher.ts` | (Task 7) `createCommandLauncher` |
| `src/sandbox/index.ts` | barrel (grows task by task) |
| `src/agents/coding-tool-sandbox.ts` | (Task 10) `resolveSessionSandbox` — async, runs the probe, builds the launcher |
| `scripts/check-sandbox-imports.ts` | (Task 2) import-boundary gate |
| `test/helpers/sandbox.ts` | (Task 6) `makeFakeSandboxBackend` |
| tests under `test/unit/sandbox/`, `test/unit/scripts/`, `test/integration/sandbox/` | per task |

**Modify**
| File | Change |
|---|---|
| `src/agents/coding-tool-support.ts` | Task 1 extraction; Task 10 wiring |
| `package.json` | Task 2 dependency, build external, new check script in `lint:checks` |
| `scripts/check-bundle-externals.ts` | Task 2 |
| `src/config/schemas-execution.ts`, `src/config/schemas.ts` | Task 3 |
| `src/tools/nax-owned-writes.ts` | Task 5 export `QUEUE_CONTROL_FILES` |
| `src/tools/policy.ts`, `src/tools/policy-command-branch.ts` | Task 8 `rawBashRefusal` |
| `src/tools/bash.ts`, `src/tools/run-command.ts`, `src/tools/run-command-exec.ts`, `src/tools/registry.ts`, `src/tools/runtime.ts`, `src/tools/tool-audit.ts` | Task 9 |
| `src/permissions/approvals-link.ts`, `src/pipeline/stages/execution.ts` | Task 11 |
| `src/execution/lifecycle/run-cleanup.ts` | Task 11 |
| `.github/workflows/ci.yml` | Task 12 |
| `docs/adr/ADR-030-bash-approval-modes.md`, the spec | Task 13 |

---

### Task 1: Extract the declared-command tool assembly (pure refactor)

`coding-tool-support.ts` is 594/600 lines; Task 10 must add sandbox threading. Move the `extraTools` RunCommand/Bash construction block into its own file first. **Proof obligation: zero test edits** — every existing test must pass unedited (`git diff --stat HEAD -- test/` empty for this commit).

**Files:**
- Create: `src/agents/coding-tool-extras.ts`
- Modify: `src/agents/coding-tool-support.ts` (the `extraTools:` array inside `createCodingToolRuntime({...})`, currently lines ~219-269)

**Interfaces:**
- Produces: `buildDeclaredCommandTools(args: DeclaredCommandToolsArgs): CodingTool[]` — Task 10 adds a `launcher` field to `DeclaredCommandToolsArgs`.

- [ ] **Step 1: Record the baseline**

Run: `bun test test/unit/agents/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5`
Expected: all pass. Note the pass count.

- [ ] **Step 2: Create `src/agents/coding-tool-extras.ts`**

```ts
/**
 * The session-local tools an operation declares: RunCommand (its declared
 * commands and, when `Exec` is declared, its argv branch) and Bash.
 *
 * Extracted from coding-tool-support.ts to keep that file under its 600-line
 * source limit ahead of the P4 sandbox wiring. A pure move: every comment that
 * explains a field below travelled with it.
 */
import type { BashApprovalMode } from "@/config/bash-approval";
import { type CodingTool, createBashTool, createRunCommandTool, type ToolGrant } from "@/tools";
import type { QualityCommandSpec } from "../quality";

export interface DeclaredCommandToolsArgs {
  readonly declaredCommands: ReadonlyMap<string, QualityCommandSpec>;
  readonly allowExec: boolean;
  readonly execGrant: ToolGrant | undefined;
  readonly allowBash: boolean;
  readonly bashDescriptionPatterns: readonly string[];
  readonly bashApproval: BashApprovalMode;
  readonly root: string;
  readonly repoRoot?: string;
  readonly packageWorkdir?: string;
  readonly commandCwd?: string;
  readonly allowScripts?: boolean;
  readonly packageName?: string;
  readonly stripEnvVars?: readonly string[];
  readonly shell?: string;
}

export function buildDeclaredCommandTools(args: DeclaredCommandToolsArgs): CodingTool[] {
  return [
    ...(args.declaredCommands.size > 0 || args.allowExec
      ? [
          createRunCommandTool(args.declaredCommands, {
            stripEnvVars: args.stripEnvVars,
            commandCwd: args.commandCwd ?? args.root,
            ...(args.allowExec
              ? {
                  exec: {
                    repoRoot: args.repoRoot ?? args.root,
                    // <MOVE the existing comment block from coding-tool-support.ts verbatim>
                    packageWorkdir: args.packageWorkdir ?? args.root,
                    allowScripts: args.allowScripts ?? false,
                    // <MOVE the existing comment block about the compiled grant verbatim>
                    patterns: args.execGrant?.patterns ?? [],
                    ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
                  },
                }
              : {}),
          }),
        ]
      : []),
    ...(args.allowBash
      ? [
          createBashTool({
            ...(args.shell !== undefined ? { shell: args.shell } : {}),
            ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
            // <MOVE the existing "The EFFECTIVE grant" comment verbatim>
            patterns: args.bashDescriptionPatterns,
            bashApproval: args.bashApproval,
          }),
        ]
      : []),
  ];
}
```

The three `<MOVE …>` markers mean: cut those exact comment lines from `coding-tool-support.ts` and paste them here; do not leave the markers. If `bashDescriptionPatterns`'s type in `BashSupportResolution` (`src/agents/coding-tool-bash.ts:17`) is not `readonly string[]`, use `BashSupportResolution["bashDescriptionPatterns"]` instead.

- [ ] **Step 3: Replace the block in `coding-tool-support.ts`**

Replace the whole `extraTools: [ ...(args.extraTools ?? []), ...(declaredCommands.size > 0 || allowExec ? [...] : []), ...(allowBash ? [...] : []) ],` property with:

```ts
    extraTools: [
      ...(args.extraTools ?? []),
      ...buildDeclaredCommandTools({
        declaredCommands,
        allowExec,
        execGrant,
        allowBash,
        bashDescriptionPatterns,
        bashApproval,
        root: args.root,
        ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
        ...(args.packageWorkdir !== undefined ? { packageWorkdir: args.packageWorkdir } : {}),
        ...(args.commandCwd !== undefined ? { commandCwd: args.commandCwd } : {}),
        ...(args.allowScripts !== undefined ? { allowScripts: args.allowScripts } : {}),
        ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
        ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
        ...(args.shell !== undefined ? { shell: args.shell } : {}),
      }),
    ],
```

Add `import { buildDeclaredCommandTools } from "./coding-tool-extras";` and remove `createBashTool` / `createRunCommandTool` from the `@/tools` import if nothing else in the file uses them.

- [ ] **Step 4: Verify behaviour and size**

Run: `bun test test/unit/agents/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5` — same pass count as Step 1.
Run: `wc -l src/agents/coding-tool-support.ts` — expected well under 560.
Run: `bun run typecheck && bun run check:file-sizes && bun run check:import-cycles`
Run: `git diff --stat -- test/` — expected: empty.

- [ ] **Step 5: Commit**

```bash
git add src/agents/coding-tool-extras.ts src/agents/coding-tool-support.ts
git commit -m "refactor(agents): extract the declared-command tool assembly ahead of P4"
```

---

### Task 2: Dependency, bundle external, and the import-boundary gate

**Files:**
- Modify: `package.json` (`dependencies`, `scripts.build`, `scripts["lint:checks"]`, new `scripts["check:sandbox-imports"]`)
- Modify: `scripts/check-bundle-externals.ts`
- Create: `scripts/check-sandbox-imports.ts`
- Test: `test/unit/scripts/check-sandbox-imports.test.ts`

**Interfaces:** Produces the `check:sandbox-imports` gate every later task must keep green.

- [ ] **Step 1: Add the dependency**

Run: `bun add @anthropic-ai/sandbox-runtime@0.0.77 --exact`
Then confirm `package.json` shows `"@anthropic-ai/sandbox-runtime": "0.0.77"` under `dependencies` (no caret).

- [ ] **Step 2: Write the failing gate test**

`test/unit/scripts/check-sandbox-imports.test.ts` — mirror `test/unit/scripts/check-nax-ai-imports.test.ts` (same `runGate`/`tree` helpers, copied into this file):

```ts
/**
 * The sandbox-runtime isolation gate. srt is a "beta research preview" with an
 * explicitly unstable API; confining it to one file confines every future
 * bump to one file. Proven by violating it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-sandbox-imports.ts");

function runGate(root: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, root]);
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nax-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("check-sandbox-imports", () => {
  test("passes when srt is imported only from src/sandbox/srt-backend.ts", () => {
    const root = tree({
      "src/sandbox/srt-backend.ts": 'const m = await import("@anthropic-ai/sandbox-runtime");\n',
      "src/tools/bash.ts": 'import type { CommandLauncher } from "../sandbox";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("fails on a static import outside the backend", () => {
    const root = tree({ "src/tools/bash.ts": 'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";\n' });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/tools/bash.ts:1");
  });

  test("fails on a dynamic import elsewhere in src/sandbox", () => {
    const root = tree({ "src/sandbox/probe.ts": 'await import("@anthropic-ai/sandbox-runtime");\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });

  test("fails when src/sandbox imports an orchestrator module", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "../pipeline/stages";\n' });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("orchestrator");
  });

  test("fails when src/sandbox imports an orchestrator module through the @/ alias", () => {
    const root = tree({ "src/sandbox/launcher.ts": 'import { x } from "@/pipeline/stages";\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
  });

  test("ignores the specifier inside comments", () => {
    const root = tree({ "src/tools/bash.ts": '// see @anthropic-ai/sandbox-runtime\n * @anthropic-ai/sandbox-runtime\n' });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/unit/scripts/check-sandbox-imports.test.ts --timeout=30000`
Expected: FAIL (script does not exist).

- [ ] **Step 4: Write `scripts/check-sandbox-imports.ts`**

```ts
#!/usr/bin/env bun

/**
 * Fails if @anthropic-ai/sandbox-runtime is imported anywhere but
 * src/sandbox/srt-backend.ts, or if src/sandbox/ imports an orchestrator
 * module (P4 spec 5.1 / master plan D8: src/sandbox/ is part of the would-be
 * nax-coding package and must stay extractable).
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");
const ALLOWED_FILE = join("src", "sandbox", "srt-backend.ts");
const SANDBOX_DIR = join("src", "sandbox") + sep;
const SRT = /@anthropic-ai\/sandbox-runtime/;
const ORCHESTRATOR = /from\s+["'](?:@\/|(?:\.\.\/)+)(pipeline|execution|operations|prd|runtime)(?:\/|["'])/;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

const violations: { file: string; line: number; text: string; why: string }[] = [];

for await (const file of walk(SCAN)) {
  const rel = relative(ROOT, file);
  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (SRT.test(text) && rel !== ALLOWED_FILE) {
      violations.push({ file: rel, line: index + 1, text: stripped, why: "srt outside src/sandbox/srt-backend.ts" });
    }
    if (rel.startsWith(SANDBOX_DIR) && ORCHESTRATOR.test(text)) {
      violations.push({ file: rel, line: index + 1, text: stripped, why: "src/sandbox imports an orchestrator module" });
    }
  });
}

if (violations.length > 0) {
  console.error("sandbox import boundary violated:");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}  (${v.why})`);
  process.exit(1);
}

console.log("check-sandbox-imports: clean");
```

- [ ] **Step 5: Wire it and the build external**

In `package.json`:
- add `"check:sandbox-imports": "bun run scripts/check-sandbox-imports.ts",` next to `check:nax-ai-imports`;
- in `lint:checks`, insert `&& bun run check:sandbox-imports` right after `bun run check:nax-ai-imports`;
- change `build` to add `--external \"@anthropic-ai/sandbox-runtime\"` right after `--external \"@nathapp/nax-ai\"`.

In `scripts/check-bundle-externals.ts`: add a third invariant to the header comment ("3. `@anthropic-ai/sandbox-runtime` must stay `--external` — it resolves vendored seccomp binaries and `srt-win.exe` relative to its own files, which a bundle would not carry") and a check mirroring the nax-ai one:

```ts
const REQUIRED_SANDBOX_EXTERNAL = '--external "@anthropic-ai/sandbox-runtime"';
// ...inside the `build !== undefined` branch, after the nax-ai check:
if (build !== undefined && !build.includes(REQUIRED_SANDBOX_EXTERNAL)) {
  failures.push(
    `the build script must pass ${REQUIRED_SANDBOX_EXTERNAL}.\n` +
      "srt locates its vendored sandbox binaries relative to its own files; bundled,\n" +
      "they are not beside dist/nax.js and every sandboxed command fails.",
  );
}
```

Update the final success `console.log` to mention it.

- [ ] **Step 6: Verify**

Run: `bun test test/unit/scripts/check-sandbox-imports.test.ts --timeout=30000` — PASS.
Run: `bun run check:sandbox-imports && bun run check:bundle-externals && bun run build` — all succeed; `check:gate-reachability` (inside `check:all`) must also pass, which it does because the new script is in `lint:checks`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock scripts/check-sandbox-imports.ts scripts/check-bundle-externals.ts test/unit/scripts/check-sandbox-imports.test.ts
git commit -m "feat(sandbox): pin sandbox-runtime 0.0.77, keep it external, gate its imports"
```

---

### Task 3: `execution.sandbox` config

**Files:**
- Create: `src/config/schemas-sandbox.ts`
- Modify: `src/config/schemas-execution.ts` (add one field after `approvalTimeout`), `src/config/schemas.ts` (the `execution` default literal, beside `approvalTimeout`), `src/config/runtime-types.ts` (the HAND-WRITTEN `ExecutionConfig` interface at ~line 103 — it is not `z.infer`, so `config.execution.sandbox` does not typecheck without it)
- Test: `test/unit/config/schemas-sandbox.test.ts`

**Interfaces:**
- Produces: `SandboxConfigSchema`, `type SandboxConfig = { enabled: boolean; backend: "srt"; filesystem: { allowWrite: string[]; denyRead: string[] }; network: { allowedDomains?: string[] } }`, `DEFAULT_SANDBOX_CONFIG`. `allowedDomains` ABSENT = open network — not `null`: the repo's `DeepPartial<ExecutionConfig>` cannot map `null`, and a nullable field breaks seven existing test files under `tsconfig.test.json`. Reached at runtime as `config.execution.sandbox`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";
import { DEFAULT_SANDBOX_CONFIG, SandboxConfigSchema } from "@/config/schemas-sandbox";

describe("execution.sandbox", () => {
  test("defaults: off, srt, no extra roots, open network", () => {
    expect(SandboxConfigSchema.parse({})).toEqual({
      enabled: false,
      backend: "srt",
      filesystem: { allowWrite: [], denyRead: [] },
      network: {},
    });
  });

  test("nested defaults apply when only a parent key is given (zod 4 prefault, not default)", () => {
    expect(SandboxConfigSchema.parse({ filesystem: {} }).filesystem).toEqual({ allowWrite: [], denyRead: [] });
    expect(SandboxConfigSchema.parse({ network: {} }).network).toEqual({});
  });

  test("an allow-list and an empty no-network list both survive", () => {
    expect(SandboxConfigSchema.parse({ network: { allowedDomains: ["registry.npmjs.org"] } }).network.allowedDomains).toEqual([
      "registry.npmjs.org",
    ]);
    expect(SandboxConfigSchema.parse({ network: { allowedDomains: [] } }).network.allowedDomains).toEqual([]);
  });

  test("rejects an unknown backend", () => {
    expect(SandboxConfigSchema.safeParse({ backend: "docker" }).success).toBe(false);
  });

  test("BUG-20: the NaxConfig execution default carries the schema-derived sandbox default", () => {
    expect(NaxConfigSchema.parse({}).execution.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/config/schemas-sandbox.test.ts --timeout=30000` — FAIL (module missing).

- [ ] **Step 3: Implement**

`src/config/schemas-sandbox.ts`:

```ts
/**
 * `execution.sandbox` (P4, ADR-030 amendment): the OS sandbox around
 * agent-authored Bash and RunCommand Exec commands.
 *
 * Nested objects use `.prefault({})`, not `.default({})`: in zod 4 a
 * `.default()` value short-circuits parsing, so `{ filesystem: {} }` would
 * yield `filesystem: {}` with no `allowWrite`.
 */
import { z } from "zod";

export const SandboxConfigSchema = z.object({
  /** Opt-in until the P4 exit runs (spec S1). */
  enabled: z.boolean().default(false),
  /** One backend today; the interface admits a container backend later. */
  backend: z.enum(["srt"]).default("srt"),
  filesystem: z
    .object({
      /** Extra write roots, "~" expanded, relative paths resolved against the story root. */
      allowWrite: z.array(z.string()).default([]),
      /** Extra read denies, "~" expanded. */
      denyRead: z.array(z.string()).default([]),
    })
    .prefault({}),
  network: z
    .object({
      /** absent = unrestricted (spec S2); [] = no network; a list = allow-list. */
      allowedDomains: z.array(z.string()).optional(),
    })
    .prefault({}),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/** BUG-20: derived, never hand-written at a second site. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = SandboxConfigSchema.parse({});
```

In `src/config/schemas-execution.ts`, import `{ SandboxConfigSchema }` from `./schemas-sandbox` and add after `approvalTimeout`:

```ts
  /** P4: OS sandbox for agent-authored commands (see schemas-sandbox.ts). */
  sandbox: SandboxConfigSchema.prefault({}),
```

In `src/config/schemas.ts`, in the `execution` default literal right after the `approvalTimeout:` entry:

```ts
      // BUG-20 -- derived, not hand-written (same rationale as `bashApproval`).
      sandbox: DEFAULT_SANDBOX_CONFIG,
```

with `import { DEFAULT_SANDBOX_CONFIG } from "./schemas-sandbox";`. If `src/config/index.ts` re-exports schema types, also export `SandboxConfig` and `DEFAULT_SANDBOX_CONFIG` there.

In `src/config/runtime-types.ts`, inside `ExecutionConfig` right after `approvalTimeout?: number;`, add:

```ts
  /** P4: OS sandbox for agent-authored commands. */
  sandbox?: SandboxConfig;
```

with `import type { SandboxConfig } from "./schemas-sandbox";`.

- [ ] **Step 4: Verify**

Run: `bun test test/unit/config/ --timeout=60000 2>&1 | tail -5` — all pass (existing default-snapshot tests may need the new key; if a test compares the whole `execution` default to a literal, that is the BUG-20 drift the test exists to catch — add `sandbox: DEFAULT_SANDBOX_CONFIG` to its expectation, nothing else).
Run: `bun run typecheck` — BOTH tsconfigs (the script runs `tsconfig.test.json` too); it must be clean before you commit.

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas-sandbox.ts src/config/schemas-execution.ts src/config/schemas.ts src/config/runtime-types.ts src/config/index.ts test/unit/config/
git commit -m "feat(config): add execution.sandbox (opt-in, open network by default)"
```

---

### Task 4: Sandbox types and Exec argv quoting

**Files:**
- Create: `src/sandbox/types.ts`, `src/sandbox/argv-quote.ts`, `src/sandbox/index.ts`
- Test: `test/unit/sandbox/argv-quote.test.ts`

**Interfaces (Produces — every later task uses these exact names):**

```ts
// src/sandbox/types.ts
import type { ArgvExecResult } from "../utils/argv-exec";

export type SandboxBackendName = "srt";

export interface SandboxNetworkPolicy {
  /** Absent = unrestricted. */
  readonly allowedDomains?: readonly string[];
}

export interface SandboxPolicy {
  readonly writeRoots: readonly string[];
  readonly denyWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly network: SandboxNetworkPolicy;
}

export type ProbeResult = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface SandboxWrapRequest {
  readonly command: string;
  readonly shell: string;
  readonly policy: SandboxPolicy;
  readonly cwd: string;
  readonly commandId: string;
}

export interface SandboxBackend {
  readonly name: SandboxBackendName;
  isSupportedPlatform(): Promise<boolean>;
  /** Argv ONLY. The backend's env never crosses this boundary (spec F6). */
  wrap(req: SandboxWrapRequest): Promise<readonly string[]>;
  /** Extra violation text for this command, or "" when there is none. */
  annotate(commandId: string, stderr: string): string;
  /** Called once per finished wrapped command (in-flight bookkeeping). */
  commandFinished(): void;
  reset(): Promise<void>;
}

export type SandboxState =
  | { readonly kind: "disabled" }
  | { readonly kind: "available"; readonly backend: SandboxBackendName; readonly network: "open" | readonly string[] }
  | { readonly kind: "unavailable"; readonly backend: SandboxBackendName; readonly reason: string };

export interface SandboxRecord {
  readonly backend: SandboxBackendName | "none";
  readonly wrapped: boolean;
  readonly reason?: string;
  readonly denialHint?: true;
}

export type LaunchSpec =
  | { readonly kind: "shell"; readonly shell: string; readonly command: string }
  | { readonly kind: "argv"; readonly argv: readonly string[] };

export interface LaunchRequest {
  readonly spec: LaunchSpec;
  /** The policy root (`ctx.root`); write roots derive from it. */
  readonly root: string;
  /** Where the command starts; the PACKAGE dir for an Exec `target: "package"` call. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stripEnvVars: readonly string[];
  /** The CALLER's own overlay (Exec's Yarn no-scripts env). Never the backend's. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface LaunchResult extends ArgvExecResult {
  /** The logical argv (what the tool asked to run), not the sandbox wrapper argv. */
  readonly executed: readonly string[];
  readonly sandbox: SandboxRecord;
}

export interface CommandLauncher {
  readonly state: SandboxState;
  run(req: LaunchRequest): Promise<LaunchResult>;
}

// src/sandbox/argv-quote.ts
export function quoteArgvForShell(argv: readonly string[]): string;
```

- [ ] **Step 1: Write the failing quoting test**

`test/unit/sandbox/argv-quote.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { quoteArgvForShell } from "@/sandbox";

/** Round trip through a REAL /bin/sh: the only proof that quoting is exact. */
function roundTrip(argv: readonly string[]): string[] {
  const script = `${quoteArgvForShell(argv)}`;
  // printf '%s\0' prints each argument NUL-terminated, so the split is exact.
  const proc = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\0' ${script}`]);
  const out = proc.stdout.toString();
  return out.length === 0 ? [] : out.slice(0, -1).split("\0");
}

const CORPUS: readonly (readonly string[])[] = [
  ["bun", "add", "left-pad"],
  ["echo", "it's"],
  ["echo", "a'b'c", "''", "'"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax is the input under test
  ["echo", "$(touch /tmp/nax-pwned)", "`id`", "${HOME}", "$HOME"],
  ["echo", "a;b", "a&&b", "a|b", "a>b", "a<b", "a&"],
  ["echo", "line1\nline2", "tab\there"],
  ["echo", "*", "?", "[a-z]", "{a,b}", "~"],
  ["echo", "-n", "--flag=value", "-"],
  ["echo", ""],
  ["echo", "héllo", "日本語", "emoji-free"],
  ["echo", "back\\slash", "\\'"],
];

describe("quoteArgvForShell", () => {
  test.each(CORPUS.map((argv) => [argv.join(" | "), argv] as const))("round-trips exactly: %s", (_label, argv) => {
    expect(roundTrip(argv)).toEqual([...argv].slice(0));
  });

  test("never lets a metacharacter execute", () => {
    roundTrip(["echo", "$(touch /tmp/nax-p4-quote-canary)"]);
    expect(Bun.file("/tmp/nax-p4-quote-canary").size).toBe(0);
  });

  test("wraps every element, even a plain word", () => {
    expect(quoteArgvForShell(["bun", "test"])).toBe("'bun' 'test'");
  });
});
```

Note on the canary: `Bun.file(...).size` is `0` for a missing file.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/sandbox/argv-quote.test.ts --timeout=30000` — FAIL.

- [ ] **Step 3: Implement**

`src/sandbox/types.ts`: exactly the block in **Interfaces** above, with a file header:

```ts
/**
 * Types for the OS sandbox around agent-authored commands (P4).
 *
 * Every path in a SandboxPolicy is absolute, literal and realpath-resolved:
 * srt on Linux silently DROPS any denyWrite entry containing a glob
 * (spec F1), and resolves only paths that already exist (spec 12, finding 3).
 */
```

`src/sandbox/argv-quote.ts`:

```ts
/**
 * POSIX single-quote quoting for RunCommand's Exec branch under the sandbox.
 *
 * srt wraps a command STRING that runs under `sh -c`, so a sandboxed Exec
 * call becomes `sh -c '<argv, each element quoted>'`. Inside single quotes
 * nothing is special, and an embedded quote is closed, escaped and reopened
 * ('\''), so the mapping is injective and no metacharacter is ever
 * interpreted. Lives here, not in run-command-exec.ts, whose whole-file guard
 * forbids a shell-quoting import.
 */
export function quoteArgvForShell(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}
```

`src/sandbox/index.ts`:

```ts
export { quoteArgvForShell } from "./argv-quote";
export type {
  CommandLauncher,
  LaunchRequest,
  LaunchResult,
  LaunchSpec,
  ProbeResult,
  SandboxBackend,
  SandboxBackendName,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxRecord,
  SandboxState,
  SandboxWrapRequest,
} from "./types";
```

If `@/sandbox` does not resolve in tests, check `tsconfig.json` `paths` — `@/*` maps to `src/*`, so it will.

- [ ] **Step 4: Verify**

Run: `bun test test/unit/sandbox/argv-quote.test.ts --timeout=30000` — PASS.
Run: `bun run typecheck && bun run check:sandbox-imports`

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/ test/unit/sandbox/argv-quote.test.ts
git commit -m "feat(sandbox): types and exact argv quoting for sandboxed Exec"
```

---

### Task 5: Policy builder and its inputs

**Files:**
- Create: `src/sandbox/defaults.ts`, `src/sandbox/policy-builder.ts`, `src/sandbox/policy-inputs.ts`
- Modify: `src/tools/nax-owned-writes.ts` (export `QUEUE_CONTROL_FILES`), `src/tools/index.ts` (re-export it), `src/sandbox/index.ts`
- Test: `test/unit/sandbox/policy-builder.test.ts`, `test/unit/sandbox/policy-inputs.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` (Task 4), `SandboxConfig` (Task 3), `realOrRaw` (`src/utils/realpath.ts`), `featuresDir`/`globalConfigDir` (`src/config/paths`), `QUEUE_CONTROL_FILES`.
- Produces:

```ts
// policy-inputs.ts
export type GitLayout =
  | { readonly kind: "none" }
  | { readonly kind: "main"; readonly gitDir: string }
  | { readonly kind: "worktree"; readonly gitDir: string; readonly commonDir: string };
export const _policyInputDeps: { git: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>; readdir: typeof readdir; homedir: () => string; tmpdir: () => string; platform: () => NodeJS.Platform };
export async function resolveGitLayout(root: string): Promise<GitLayout>;
export async function listFeaturePrdPaths(root: string): Promise<string[]>;
export async function listCredentialFiles(): Promise<string[]>;
export function defaultTempRoots(): string[];

// policy-builder.ts
export interface SandboxPolicyInput {
  readonly root: string;
  readonly git: GitLayout;
  readonly featurePrdPaths: readonly string[];
  readonly credentialFiles: readonly string[];
  readonly approvalsFile?: string;
  readonly home: string;
  readonly tempRoots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly config: SandboxConfig;
}
export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy;
```

- [ ] **Step 1: Export the queue-control set**

In `src/tools/nax-owned-writes.ts` change `const QUEUE_CONTROL_FILES` to `export const QUEUE_CONTROL_FILES` (keep its comment). No barrel change: `policy-builder.ts` imports the file directly. Run `bun run typecheck`.

- [ ] **Step 2: Write the failing policy-builder test**

`test/unit/sandbox/policy-builder.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "@/config/schemas-sandbox";
import { buildSandboxPolicy, type SandboxPolicyInput } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

const GLOB = /[*?[\]{}]/;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-policy-"));
  root = join(base, "repo");
  home = join(base, "home");
  mkdirSync(join(root, ".nax", "features", "f1"), { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => cleanupTempDir(base));

function input(over: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput {
  return {
    root,
    git: { kind: "main", gitDir: join(root, ".git") },
    featurePrdPaths: [join(root, ".nax", "features", "f1", "prd.json")],
    credentialFiles: [join(base, "gnax", "credentials"), join(base, "gnax", "credentials-bak-2")],
    home,
    tempRoots: [join(base, "tmp")],
    platform: "linux",
    config: DEFAULT_SANDBOX_CONFIG,
    ...over,
  };
}

describe("buildSandboxPolicy", () => {
  test("F1: no denyWrite or denyRead entry contains a glob character", () => {
    const policy = buildSandboxPolicy(input());
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots]) expect(p).not.toMatch(GLOB);
  });

  test("every emitted path is absolute", () => {
    const policy = buildSandboxPolicy(input());
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots]) expect(p.startsWith("/")).toBe(true);
  });

  test("protected nax paths are literal denies", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).toContain(join(root, ".nax", "config.json"));
    expect(policy.denyWrite).toContain(join(root, ".nax", "mono"));
    expect(policy.denyWrite).toContain(join(root, ".nax", "features", "f1", "prd.json"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt.processing"));
  });

  test("main checkout: hooks and config of the git dir are denied", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).toContain(join(root, ".git", "hooks"));
    expect(policy.denyWrite).toContain(join(root, ".git", "config"));
    expect(policy.writeRoots).not.toContain(join(root, ".git"));
  });

  test("F2 + finding 4: a worktree gets the common dir writable and every pointer denied", () => {
    const common = join(base, "main", ".git");
    const gitDir = join(common, "worktrees", "US-001");
    const policy = buildSandboxPolicy(input({ git: { kind: "worktree", gitDir, commonDir: common } }));
    expect(policy.writeRoots).toContain(common);
    for (const p of [
      join(common, "hooks"),
      join(common, "config"),
      join(root, ".git"),
      join(gitDir, "gitdir"),
      join(gitDir, "commondir"),
    ]) {
      expect(policy.denyWrite).toContain(p);
    }
  });

  test("finding 5: the approvals file is always denied, even inside a write root", () => {
    const approvalsFile = join(home, ".cache", "nax", "approvals.json");
    const policy = buildSandboxPolicy(input({ approvalsFile }));
    expect(policy.writeRoots).toContain(join(home, ".cache"));
    expect(policy.denyWrite).toContain(approvalsFile);
  });

  test("write roots: root, temp roots, built-in caches; macOS adds /tmp/claude and ~/Library/Caches", () => {
    const linux = buildSandboxPolicy(input());
    expect(linux.writeRoots).toContain(root);
    expect(linux.writeRoots).toContain(join(base, "tmp"));
    expect(linux.writeRoots).toContain(join(home, ".bun", "install", "cache"));
    expect(linux.writeRoots).not.toContain(join(home, "Library", "Caches"));
    const mac = buildSandboxPolicy(input({ platform: "darwin" }));
    expect(mac.writeRoots).toContain(join(home, "Library", "Caches"));
    expect(mac.writeRoots).toContain(realOrRaw("/tmp/claude"));
  });

  test("credential read denies: built-ins under home plus the listed nax credential files", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyRead).toContain(join(home, ".ssh"));
    expect(policy.denyRead).toContain(join(home, ".npmrc"));
    expect(policy.denyRead).toContain(join(base, "gnax", "credentials-bak-2"));
  });

  test("config extras: ~ expands, relative allowWrite resolves against the root", () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["~/.cache/custom", "build-out"], denyRead: ["~/secrets"] },
    };
    const policy = buildSandboxPolicy(input({ config }));
    expect(policy.writeRoots).toContain(join(home, ".cache", "custom"));
    expect(policy.writeRoots).toContain(join(root, "build-out"));
    expect(policy.denyRead).toContain(join(home, "secrets"));
  });

  test("finding 3: a nonexistent deny under a symlinked parent is emitted in its resolved spelling", () => {
    const real = join(base, "real");
    mkdirSync(join(real, ".nax", "features", "f9"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(real, link);
    const policy = buildSandboxPolicy(
      input({ root: link, featurePrdPaths: [join(link, ".nax", "features", "f9", "prd.json")] }),
    );
    expect(policy.denyWrite).toContain(join(real, ".nax", "features", "f9", "prd.json"));
    expect(policy.writeRoots).toContain(real);
  });

  test("network: absent allowedDomains is open (no key); a list passes through", () => {
    expect(buildSandboxPolicy(input()).network).toEqual({});
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, network: { allowedDomains: ["registry.npmjs.org"] } };
    expect(buildSandboxPolicy(input({ config })).network).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  });

  test("no duplicates", () => {
    const policy = buildSandboxPolicy(input({ tempRoots: [join(base, "tmp"), join(base, "tmp")] }));
    expect(new Set(policy.writeRoots).size).toBe(policy.writeRoots.length);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test test/unit/sandbox/policy-builder.test.ts --timeout=30000` — FAIL.

- [ ] **Step 4: Implement `defaults.ts` and `policy-builder.ts`**

`src/sandbox/defaults.ts`:

```ts
/**
 * Built-in sandbox lists (spec 5.3). One auditable constant each; extend a
 * project's set through `execution.sandbox.filesystem`, not by editing these.
 */

/** Package-manager caches, relative to $HOME. The bun cache is REQUIRED: bun stages temp files there (spec F3). */
export const BUILTIN_CACHE_WRITE_ROOTS: readonly string[] = [
  ".bun/install/cache",
  ".npm",
  ".cache",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".pnpm-store",
];

/** macOS-only cache root, relative to $HOME. */
export const MACOS_CACHE_WRITE_ROOT = "Library/Caches";

/** srt forces TMPDIR to this inside the macOS sandbox and does not create it (spec F3). */
export const SRT_MACOS_TMPDIR = "/tmp/claude";

/** Credential stores the agent's commands may not read, relative to $HOME. nax's own credential files are listed separately (they live under globalConfigDir()). */
export const BUILTIN_CREDENTIAL_READ_DENIES: readonly string[] = [
  ".ssh",
  ".aws",
  ".config/gcloud",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".config/gh",
];
```

`src/sandbox/policy-builder.ts`:

```ts
/**
 * Pure: everything the sandbox allows and denies for one command (spec 5.3).
 *
 * Rebuilt per call so a feature directory created mid-run gets its prd.json
 * deny. Every emitted path goes through realOrRaw -- srt realpaths only paths
 * that exist, so a deny for a not-yet-created file under a symlinked temp dir
 * would otherwise keep a spelling the kernel never sees (spec 12, finding 3).
 */
import { isAbsolute, join, resolve } from "node:path";
import type { SandboxConfig } from "../config/schemas-sandbox";
import { QUEUE_CONTROL_FILES } from "../tools/nax-owned-writes";
import { realOrRaw } from "../utils/realpath";
import {
  BUILTIN_CACHE_WRITE_ROOTS,
  BUILTIN_CREDENTIAL_READ_DENIES,
  MACOS_CACHE_WRITE_ROOT,
  SRT_MACOS_TMPDIR,
} from "./defaults";
import type { GitLayout } from "./policy-inputs";
import type { SandboxPolicy } from "./types";

export interface SandboxPolicyInput {
  readonly root: string;
  readonly git: GitLayout;
  readonly featurePrdPaths: readonly string[];
  readonly credentialFiles: readonly string[];
  readonly approvalsFile?: string;
  readonly home: string;
  readonly tempRoots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly config: SandboxConfig;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function literal(paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => realOrRaw(p)))];
}

function gitDenies(root: string, git: GitLayout): string[] {
  if (git.kind === "none") return [];
  const common = git.kind === "worktree" ? git.commonDir : git.gitDir;
  const hooksAndConfig = [join(common, "hooks"), join(common, "config")];
  if (git.kind === "main") return hooksAndConfig;
  // A worktree's `.git` is a pointer FILE, and gitdir/commondir point back;
  // repointing any of them at an agent-written config (core.hooksPath) would
  // make nax's own unsandboxed git run hooks (spec 12, finding 4).
  return [...hooksAndConfig, join(root, ".git"), join(git.gitDir, "gitdir"), join(git.gitDir, "commondir")];
}

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const { root, home, config } = input;
  const writeRoots = literal([
    root,
    ...(input.git.kind === "worktree" ? [input.git.commonDir] : []),
    ...input.tempRoots,
    ...(input.platform === "darwin" ? [SRT_MACOS_TMPDIR, join(home, MACOS_CACHE_WRITE_ROOT)] : []),
    ...BUILTIN_CACHE_WRITE_ROOTS.map((rel) => join(home, rel)),
    ...config.filesystem.allowWrite.map((p) => {
      const expanded = expandHome(p, home);
      return isAbsolute(expanded) ? expanded : resolve(root, expanded);
    }),
  ]);
  const denyWrite = literal([
    join(root, ".nax", "config.json"),
    join(root, ".nax", "mono"),
    ...input.featurePrdPaths,
    ...[...QUEUE_CONTROL_FILES].map((name) => join(root, name)),
    ...gitDenies(root, input.git),
    ...(input.approvalsFile !== undefined ? [input.approvalsFile] : []),
  ]);
  const denyRead = literal([
    ...BUILTIN_CREDENTIAL_READ_DENIES.map((rel) => join(home, rel)),
    ...input.credentialFiles,
    ...config.filesystem.denyRead.map((p) => resolve(root, expandHome(p, home))),
  ]);
  const allowed = config.network.allowedDomains;
  return { writeRoots, denyWrite, denyRead, network: allowed === undefined ? {} : { allowedDomains: [...allowed] } };
}
```

**Rule: only emit a write-deny whose PARENT directory exists.** On Linux, srt/bwrap makes writes beneath a missing ancestor of a deny path land somewhere ephemeral and vanish silently (spike, Linux run 3: `mkdir -p .nax/features/f2` succeeded in the sandbox, yet `f2` never appeared on the host). Every deny this builder emits satisfies the rule today (feature dirs are listed from disk; `.nax`, the root, the approvals file's `outputDir` and the worktree pointer files all exist) — keep it that way when adding entries.

`check:feature-dir-ssot` forbids open-coding `join(root, ".nax", "features", …)` in `src/`. This file does NOT build a features path (the prd paths arrive as input, built in `policy-inputs.ts` via `featuresDir`). `join(root, ".nax", "config.json")` and `".nax", "mono"` are not features paths. If `check:no-real-global-nax` or `check:feature-dir-ssot` flags a line anyway, use `projectConfigDir(root)` from `src/config/paths` for the `.nax` dir rather than adding an allow comment.

- [ ] **Step 5: Run the builder test**

Run: `bun test test/unit/sandbox/policy-builder.test.ts --timeout=30000` — PASS.

- [ ] **Step 6: Write the failing policy-inputs test**

`test/unit/sandbox/policy-inputs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { listCredentialFiles, listFeaturePrdPaths, resolveGitLayout } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let base: string;
beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-inputs-"));
});
afterEach(() => cleanupTempDir(base));

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("resolveGitLayout", () => {
  test("not a repo -> none", async () => {
    expect(await resolveGitLayout(base)).toEqual({ kind: "none" });
  });

  test("main checkout -> main with an absolute git dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    expect(await resolveGitLayout(base)).toEqual({ kind: "main", gitDir: join(base, ".git") });
  });

  test("a nax-style worktree -> worktree with gitDir under the common dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    writeFileSync(join(base, "a.txt"), "a");
    git(["add", "-A"], base);
    git(["commit", "-qm", "seed"], base);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt"], base);
    const layout = await resolveGitLayout(join(base, ".nax-wt", "US-001"));
    expect(layout).toEqual({
      kind: "worktree",
      gitDir: join(base, ".git", "worktrees", "US-001"),
      commonDir: join(base, ".git"),
    });
  });
});

describe("listFeaturePrdPaths", () => {
  test("one prd.json path per feature directory, existing file or not", async () => {
    mkdirSync(join(base, ".nax", "features", "a"), { recursive: true });
    mkdirSync(join(base, ".nax", "features", "b"), { recursive: true });
    writeFileSync(join(base, ".nax", "features", "a", "prd.json"), "{}");
    const paths = (await listFeaturePrdPaths(base)).sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual([
      join(base, ".nax", "features", "a", "prd.json"),
      join(base, ".nax", "features", "b", "prd.json"),
    ]);
  });

  test("no features directory -> empty", async () => {
    expect(await listFeaturePrdPaths(base)).toEqual([]);
  });
});

describe("listCredentialFiles", () => {
  test("every credentials* file in the global nax dir, as literals", async () => {
    const dir = globalConfigDir();
    mkdirSync(dir, { recursive: true });
    const made = ["credentials", "credentials-bak-2", "config.json"].map((n) => join(dir, n));
    try {
      for (const f of made) writeFileSync(f, "{}");
      const files = await listCredentialFiles();
      expect(files).toContain(join(dir, "credentials"));
      expect(files).toContain(join(dir, "credentials-bak-2"));
      expect(files).not.toContain(join(dir, "config.json"));
    } finally {
      for (const f of made) rmSync(f, { force: true });
    }
  });
});
```

(`test/preload.ts` redirects `globalConfigDir()` into an isolated temp dir, so this never touches the real `~/.nax`.)

- [ ] **Step 7: Implement `policy-inputs.ts`**

```ts
/**
 * The I/O half of the sandbox policy: what exists on disk right now.
 * Kept apart from policy-builder.ts so the builder stays pure.
 */
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { featuresDir, globalConfigDir } from "../config/paths";
import { gitWithTimeout } from "../utils/git";
import { realOrRaw } from "../utils/realpath";

export type GitLayout =
  | { readonly kind: "none" }
  | { readonly kind: "main"; readonly gitDir: string }
  | { readonly kind: "worktree"; readonly gitDir: string; readonly commonDir: string };

const GIT_LAYOUT_TIMEOUT_MS = 10_000;

export const _policyInputDeps = {
  git: (args: string[], cwd: string) => gitWithTimeout(args, cwd, GIT_LAYOUT_TIMEOUT_MS),
  readdir,
  homedir,
  tmpdir,
  platform: (): NodeJS.Platform => process.platform,
};

async function gitPath(flag: string, root: string): Promise<string | undefined> {
  const r = await _policyInputDeps.git(["rev-parse", flag], root);
  if (r.exitCode !== 0) return undefined;
  const out = r.stdout.trim();
  return realOrRaw(isAbsolute(out) ? out : resolve(root, out));
}

/** Resolved once per session. A worktree's git dir differs from its common dir. */
export async function resolveGitLayout(root: string): Promise<GitLayout> {
  const gitDir = await gitPath("--git-dir", root);
  const commonDir = await gitPath("--git-common-dir", root);
  if (gitDir === undefined || commonDir === undefined) return { kind: "none" };
  return gitDir === commonDir ? { kind: "main", gitDir } : { kind: "worktree", gitDir, commonDir };
}

/** One `<features>/<f>/prd.json` per feature directory present now (existing file or not). */
export async function listFeaturePrdPaths(root: string): Promise<string[]> {
  const dir = featuresDir(root);
  try {
    const entries = await _policyInputDeps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name, "prd.json"));
  } catch {
    return [];
  }
}

/** Every `credentials*` file in the global nax dir, expanded to literals (F1: no globs). */
export async function listCredentialFiles(): Promise<string[]> {
  const dir = globalConfigDir();
  try {
    const entries = await _policyInputDeps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.name.startsWith("credentials")).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** `os.tmpdir()` plus `/tmp` (Linux tools fall back to it; srt sets no TMPDIR there -- spec F3). */
export function defaultTempRoots(): string[] {
  return [_policyInputDeps.tmpdir(), "/tmp"];
}
```

`git rev-parse --git-dir` prints a path relative to the cwd for a main checkout (`.git`) and absolute for a worktree; `resolve(root, out)` handles both. `gitWithTimeout`'s default argv is `["git", ...args]` with `cwd: workdir`.

Add to `src/sandbox/index.ts`:

```ts
export { buildSandboxPolicy, type SandboxPolicyInput } from "./policy-builder";
export {
  _policyInputDeps,
  defaultTempRoots,
  type GitLayout,
  listCredentialFiles,
  listFeaturePrdPaths,
  resolveGitLayout,
} from "./policy-inputs";
```

- [ ] **Step 8: Verify**

Run: `bun test test/unit/sandbox/ --timeout=30000` — PASS.
Run: `bun run typecheck && bun run check:import-cycles && bun run check:feature-dir-ssot && bun run check:no-real-global-nax && bun run check:sandbox-imports`

- [ ] **Step 9: Commit**

```bash
git add src/sandbox/ src/tools/nax-owned-writes.ts test/unit/sandbox/
git commit -m "feat(sandbox): literal, realpath-resolved per-call sandbox policy"
```

---

### Task 6: srt backend, probe, and the process registry

**Files:**
- Create: `src/sandbox/srt-backend.ts`, `src/sandbox/probe.ts`, `src/sandbox/registry.ts`, `test/helpers/sandbox.ts`
- Modify: `src/sandbox/index.ts`, `test/helpers/index.ts`
- Test: `test/unit/sandbox/probe.test.ts`, `test/unit/sandbox/registry.test.ts`, `test/unit/sandbox/srt-backend.test.ts`

**Interfaces:**
- Consumes: Task 4 types, `runArgv` (`src/utils/argv-exec.ts`), `SandboxConfig` (Task 3), `realOrRaw`.
- Produces:

```ts
// srt-backend.ts
export const _srtBackendDeps: { load: () => Promise<SrtModule>; platform: () => NodeJS.Platform; mkdir: typeof mkdir };
export function createSrtBackend(network: SandboxConfig["network"]): SandboxBackend;
// probe.ts
export const _probeDeps: { tmpdir: () => string; runArgv: typeof runArgv };
export async function probeSandbox(backend: SandboxBackend): Promise<ProbeResult>;
// registry.ts
export const _sandboxRegistryDeps: { createBackend: (network: SandboxConfig["network"]) => SandboxBackend; probe: (b: SandboxBackend) => Promise<ProbeResult> };
export function sandboxBackendFor(config: SandboxConfig): SandboxBackend;
export function probeSandboxOnce(backend: SandboxBackend, storyId?: string): Promise<ProbeResult>;
export function warnSandboxUnavailableOnce(reason: string, storyId?: string): void;
export async function resetSandboxBackend(): Promise<void>;
export function _resetSandboxRegistryForTests(): void;
// test/helpers/sandbox.ts
export type FakeSandboxMode = "enforce" | "leak" | "cannot-run" | "throw" | "unsupported";
export function makeFakeSandboxBackend(mode?: FakeSandboxMode): SandboxBackend & { readonly calls: SandboxWrapRequest[]; finished: number };
```

- [ ] **Step 1: Write the fake backend helper**

`test/helpers/sandbox.ts` — a fake that fails the way production fails (master plan §5: "a test double that cannot fail the way production fails will hide a critical"):

```ts
/**
 * A SandboxBackend double with every production failure mode (master plan 5:
 * a double that cannot fail the way production fails hides a critical).
 *
 * - enforce: runs the command, rewriting any `> <denied path>` redirect to
 *   `/dev/null` -- enough to model the probe and simple denied writes. Real
 *   enforcement is tested against real srt in the live suite (Task 12).
 * - leak: runs the command as-is (a sandbox that does not enforce).
 * - cannot-run: every command fails like bwrap in stock Docker (spec F4).
 * - throw: wrap rejects.
 * - unsupported: isSupportedPlatform() resolves false.
 */
import type { SandboxBackend, SandboxWrapRequest } from "@/sandbox";

export type FakeSandboxMode = "enforce" | "leak" | "cannot-run" | "throw" | "unsupported";

export function makeFakeSandboxBackend(
  mode: FakeSandboxMode = "enforce",
): SandboxBackend & { readonly calls: SandboxWrapRequest[]; finished: number } {
  const calls: SandboxWrapRequest[] = [];
  const fake = {
    name: "srt" as const,
    calls,
    finished: 0,
    async isSupportedPlatform() {
      return mode !== "unsupported";
    },
    async wrap(req: SandboxWrapRequest): Promise<readonly string[]> {
      calls.push(req);
      if (mode === "throw") throw new Error("fake wrap failure");
      if (mode === "cannot-run") {
        return ["/bin/sh", "-c", "echo \"bwrap: Can't mount proc on /proc: Operation not permitted\" >&2; exit 1"];
      }
      if (mode === "enforce") {
        // Neutralise redirects into denied paths: the only shape the fake must
        // honour is `> <denied path>` / `> <relative path resolving to one>`.
        let command = req.command;
        for (const denied of req.policy.denyWrite) {
          const rel = denied.startsWith(`${req.cwd}/`) ? denied.slice(req.cwd.length + 1) : denied;
          command = command.replaceAll(`> ${denied}`, "> /dev/null").replaceAll(`> ${rel}`, "> /dev/null");
        }
        return [req.shell, "-c", command];
      }
      return [req.shell, "-c", req.command];
    },
    annotate() {
      return "";
    },
    commandFinished() {
      fake.finished += 1;
    },
    async reset() {},
  };
  return fake;
}
```

Export it from `test/helpers/index.ts`: `export { type FakeSandboxMode, makeFakeSandboxBackend } from "./sandbox";`.

- [ ] **Step 2: Write the failing probe test**

`test/unit/sandbox/probe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeFakeSandboxBackend } from "@test/helpers";
import { probeSandbox } from "@/sandbox";

describe("probeSandbox", () => {
  test("available when the allowed write lands and the denied write does not", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    expect(await probeSandbox(backend)).toEqual({ available: true });
    expect(backend.finished).toBe(1);
  });

  test("the denied marker is a literal entry in denyWrite (deny-within-allow), not merely outside the roots", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    await probeSandbox(backend);
    const req = backend.calls[0];
    expect(req?.policy.denyWrite.some((p) => p.endsWith("/denied/marker"))).toBe(true);
    expect(req?.policy.writeRoots.length).toBe(1);
  });

  test("a sandbox that runs but does not enforce is UNAVAILABLE, never available", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("leak"));
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("did not enforce");
  });

  test("F4: a sandbox that cannot run a command is unavailable and says why", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("cannot-run"));
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("Can't mount proc");
  });

  test("a wrap that throws is unavailable", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("throw"));
    expect(result).toEqual({ available: false, reason: "sandbox wrap failed: fake wrap failure" });
  });

  test("an unsupported platform is unavailable without wrapping", async () => {
    const backend = makeFakeSandboxBackend("unsupported");
    const result = await probeSandbox(backend);
    expect(result.available).toBe(false);
    expect(backend.calls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test test/unit/sandbox/probe.test.ts --timeout=30000` — FAIL.

- [ ] **Step 4: Implement `probe.ts`**

```ts
/**
 * Is the sandbox actually working here? Decided by RUNNING one wrapped
 * command, never by a dependency check: in stock Docker bwrap is installed
 * and every command fails (spec F4), and a sandbox that runs but does not
 * enforce must count as absent, not present.
 *
 * The denied marker sits under the probe's own write root and is listed in
 * denyWrite: srt's deny-within-allow wins on both platforms (spec 5.4). A
 * marker merely "outside the roots" would be inside a tmp write root in
 * production and falsely read as a leak.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArgv } from "../utils/argv-exec";
import { realOrRaw } from "../utils/realpath";
import type { ProbeResult, SandboxBackend } from "./types";

const PROBE_TIMEOUT_MS = 30_000;

export const _probeDeps = { tmpdir, runArgv };

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export async function probeSandbox(backend: SandboxBackend): Promise<ProbeResult> {
  if (!(await backend.isSupportedPlatform())) {
    return { available: false, reason: `platform ${process.platform} is not supported by the ${backend.name} sandbox` };
  }
  const dir = realOrRaw(mkdtempSync(join(_probeDeps.tmpdir(), "nax-sandbox-probe-")));
  mkdirSync(join(dir, "allowed"));
  mkdirSync(join(dir, "denied"));
  const allowed = join(dir, "allowed", "marker");
  const denied = join(dir, "denied", "marker");
  try {
    let argv: readonly string[];
    try {
      argv = await backend.wrap({
        command: `echo ok > ${allowed}; echo leak > ${denied}; exit 0`,
        shell: "/bin/sh",
        policy: { writeRoots: [dir], denyWrite: [denied], denyRead: [], network: {} },
        cwd: dir,
        commandId: "nax-sandbox-probe",
      });
    } catch (err) {
      return { available: false, reason: `sandbox wrap failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    let result: Awaited<ReturnType<typeof runArgv>>;
    try {
      result = await _probeDeps.runArgv({ argv, cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    } finally {
      // Exactly once per successful wrap, even when the spawn itself throws.
      backend.commandFinished();
    }
    if (!existsSync(allowed)) {
      return { available: false, reason: `sandbox could not run a command: ${firstLine(result.stderr) || `exit ${result.exitCode}`}` };
    }
    if (existsSync(denied)) return { available: false, reason: "sandbox ran a command but did not enforce a write deny" };
    return { available: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Note: the probe paths contain no spaces (mkdtemp names are `[A-Za-z0-9]`), and `realOrRaw` of a temp dir yields no shell metacharacters on macOS/Linux, so the unquoted `>` targets are safe here.

- [ ] **Step 5: Run the probe test** — `bun test test/unit/sandbox/probe.test.ts --timeout=30000` — PASS.

- [ ] **Step 6: Write the srt backend**

`src/sandbox/srt-backend.ts`:

```ts
/**
 * The ONLY importer of @anthropic-ai/sandbox-runtime (enforced by
 * scripts/check-sandbox-imports.ts). Loaded by dynamic import so a run that
 * never sandboxes never loads it.
 *
 * srt's SandboxManager is a process-wide singleton; per-call customConfig
 * carries each story's roots, so parallel worktree stories share it (spike:
 * concurrent roots isolated). The returned `env` of wrapWithSandboxArgv is
 * process.env itself and is DISCARDED here (spec F6).
 */
import { mkdir } from "node:fs/promises";
import type { SandboxConfig } from "../config/schemas-sandbox";
import { SRT_MACOS_TMPDIR } from "./defaults";
import type { SandboxBackend, SandboxPolicy, SandboxWrapRequest } from "./types";

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");
type SrtRuntimeConfig = Parameters<SrtModule["SandboxManager"]["initialize"]>[0];
type SrtNetwork = SrtRuntimeConfig["network"];

export const _srtBackendDeps = {
  load: (): Promise<SrtModule> => import("@anthropic-ai/sandbox-runtime"),
  platform: (): NodeJS.Platform => process.platform,
  mkdir,
};

/**
 * Open network = `network` WITHOUT `allowedDomains`. srt's type requires the
 * field, but its runtime decides restriction on `allowedDomains !== undefined`
 * (sandbox-manager.js, `hasNetworkConfig`), and `initialize` dereferences
 * `network`, so the object must exist. This is the one cast in the module; the
 * live suite pins the behaviour (open => no proxy variables in the argv), so
 * an srt bump that changes it fails a test rather than silently restricting.
 */
function srtNetwork(allowedDomains: readonly string[] | undefined): SrtNetwork {
  if (allowedDomains !== undefined) return { allowedDomains: [...allowedDomains], deniedDomains: [] };
  const open: Pick<SrtNetwork, "deniedDomains"> = { deniedDomains: [] };
  return open as SrtNetwork;
}

function customConfig(policy: SandboxPolicy): Partial<SrtRuntimeConfig> {
  return {
    filesystem: { denyRead: [...policy.denyRead], allowWrite: [...policy.writeRoots], denyWrite: [...policy.denyWrite] },
    ...(policy.network.allowedDomains !== undefined ? { network: srtNetwork(policy.network.allowedDomains) } : {}),
  };
}

export function createSrtBackend(network: SandboxConfig["network"]): SandboxBackend {
  let initialized: Promise<SrtModule> | undefined;
  let loaded: SrtModule | undefined;
  let inFlight = 0;

  function initialize(): Promise<SrtModule> {
    initialized ??= (async () => {
      const mod = await _srtBackendDeps.load();
      if (_srtBackendDeps.platform() === "darwin") await _srtBackendDeps.mkdir(SRT_MACOS_TMPDIR, { recursive: true });
      await mod.SandboxManager.initialize({
        network: srtNetwork(network.allowedDomains),
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      } as SrtRuntimeConfig);
      loaded = mod;
      return mod;
    })();
    return initialized;
  }

  return {
    name: "srt",
    async isSupportedPlatform() {
      const mod = await _srtBackendDeps.load();
      return mod.SandboxManager.isSupportedPlatform();
    },
    async wrap(req: SandboxWrapRequest) {
      const mod = await initialize();
      inFlight += 1;
      try {
        const { argv } = await mod.SandboxManager.wrapWithSandboxArgv(
          req.command,
          req.shell,
          customConfig(req.policy),
          undefined,
          req.cwd,
          { commandId: req.commandId },
        );
        return argv;
      } catch (err) {
        inFlight -= 1;
        throw err;
      }
    },
    annotate(commandId: string, stderr: string) {
      if (loaded === undefined) return "";
      const annotated = loaded.SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
      return annotated.startsWith(stderr) ? annotated.slice(stderr.length).trim() : "";
    },
    commandFinished() {
      inFlight = Math.max(0, inFlight - 1);
      // Removes bwrap mount placeholders (Linux). Never while another wrapped
      // command runs: a running sandbox may still depend on them.
      if (inFlight === 0) loaded?.SandboxManager.cleanupAfterCommand();
    },
    async reset() {
      if (loaded !== undefined) await loaded.SandboxManager.reset();
      initialized = undefined;
      loaded = undefined;
      inFlight = 0;
    },
  };
}
```

The `Pick<…>` intermediate is required: a bare `({ deniedDomains: [] } as SrtNetwork)` fails TS2352 (`never[]` is not comparable). Verified to compile together with the outer `as SrtRuntimeConfig` on `initialize`. If srt's `wrapWithSandboxArgv` options type is named differently, read `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.d.ts:75-79` — the sixth parameter is `options?: WrapWithSandboxOptions` with `commandId`.

- [ ] **Step 7: Registry**

`src/sandbox/registry.ts`:

```ts
/**
 * Process-level sandbox state: one backend (srt's manager is a singleton), one
 * probe result, and the once-per-process log lines (spec 5.7). One nax process
 * serves one project, so one network config per process holds.
 */
import type { SandboxConfig } from "../config/schemas-sandbox";
import { getSafeLogger } from "../logger";
import { probeSandbox } from "./probe";
import { createSrtBackend } from "./srt-backend";
import type { ProbeResult, SandboxBackend } from "./types";

export const _sandboxRegistryDeps = {
  createBackend: (network: SandboxConfig["network"]): SandboxBackend => createSrtBackend(network),
  probe: (backend: SandboxBackend): Promise<ProbeResult> => probeSandbox(backend),
};

let backend: SandboxBackend | undefined;
let probed: Promise<ProbeResult> | undefined;
let warnedUnavailable = false;

export function sandboxBackendFor(config: SandboxConfig): SandboxBackend {
  backend ??= _sandboxRegistryDeps.createBackend(config.network);
  return backend;
}

export function probeSandboxOnce(target: SandboxBackend, storyId = "_sandbox"): Promise<ProbeResult> {
  probed ??= _sandboxRegistryDeps.probe(target).then((result) => {
    getSafeLogger()?.info("sandbox", "Sandbox probe", {
      storyId,
      backend: target.name,
      available: result.available,
      ...(result.available ? {} : { reason: result.reason }),
    });
    return result;
  });
  return probed;
}

export function warnSandboxUnavailableOnce(reason: string, storyId = "_sandbox"): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  getSafeLogger()?.warn("sandbox", "Sandbox unavailable: raw bash is refused; gated/escalate commands run unwrapped", {
    storyId,
    reason,
  });
}

/** Run cleanup. The probe result is kept: the platform does not change. */
export async function resetSandboxBackend(): Promise<void> {
  const current = backend;
  backend = undefined;
  if (current !== undefined) await current.reset();
}

export function _resetSandboxRegistryForTests(): void {
  backend = undefined;
  probed = undefined;
  warnedUnavailable = false;
}
```

`test/unit/sandbox/registry.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeSandboxBackend, withDepsRestore } from "@test/helpers";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import {
  _resetSandboxRegistryForTests,
  _sandboxRegistryDeps,
  probeSandboxOnce,
  resetSandboxBackend,
  sandboxBackendFor,
} from "@/sandbox";

describe("sandbox registry", () => {
  withDepsRestore(_sandboxRegistryDeps);
  afterEach(() => _resetSandboxRegistryForTests());

  test("one backend per process", () => {
    let created = 0;
    _sandboxRegistryDeps.createBackend = () => {
      created += 1;
      return makeFakeSandboxBackend();
    };
    sandboxBackendFor(DEFAULT_SANDBOX_CONFIG);
    sandboxBackendFor(DEFAULT_SANDBOX_CONFIG);
    expect(created).toBe(1);
  });

  test("the probe runs once and its result is cached", async () => {
    let probes = 0;
    _sandboxRegistryDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const b = makeFakeSandboxBackend();
    await probeSandboxOnce(b);
    await probeSandboxOnce(b);
    expect(probes).toBe(1);
  });

  test("reset drops the backend (reset() called) but keeps the probe result", async () => {
    let resets = 0;
    const fake = {
      ...makeFakeSandboxBackend(),
      reset: async () => {
        resets += 1;
      },
    };
    _sandboxRegistryDeps.createBackend = () => fake;
    let probes = 0;
    _sandboxRegistryDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    await probeSandboxOnce(sandboxBackendFor(DEFAULT_SANDBOX_CONFIG));
    await resetSandboxBackend();
    expect(resets).toBe(1);
    await probeSandboxOnce(sandboxBackendFor(DEFAULT_SANDBOX_CONFIG));
    expect(probes).toBe(1);
  });
});
```

- [ ] **Step 8: srt backend smoke test against REAL srt**

`test/unit/sandbox/srt-backend.test.ts` — real srt, skipped with its reason printed when the probe says unavailable:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { createSrtBackend, probeSandbox } from "@/sandbox";

const backend = createSrtBackend({});
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

describe(`srt backend (${label})`, () => {
  afterAll(() => backend.reset());

  test.skipIf(!probe.available)("open network: the wrapped argv sets no proxy variables", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t1",
    });
    backend.commandFinished();
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY=");
  });

  test.skipIf(!probe.available)("wrap returns argv only -- the backend's env never crosses (F6)", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t2",
    });
    backend.commandFinished();
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((a) => typeof a === "string")).toBe(true);
  });
});
```

**srt's `SandboxManager` is one per process, and `bun test` runs every file in ONE process.** Every test file that creates a real srt backend must `reset()` it in `afterAll` (above), and must never hold two live srt backends at once. A second backend instance with `allowedDomains: ["registry.npmjs.org"]` cannot be tested in the same file (srt's manager is a singleton and this file already initialized it open); the allow-list shape is covered by the live suite (Task 12), which runs in its own file/process.

- [ ] **Step 9: Barrel + verify**

Add to `src/sandbox/index.ts`:

```ts
export { _probeDeps, probeSandbox } from "./probe";
export {
  _resetSandboxRegistryForTests,
  _sandboxRegistryDeps,
  probeSandboxOnce,
  resetSandboxBackend,
  sandboxBackendFor,
  warnSandboxUnavailableOnce,
} from "./registry";
export { _srtBackendDeps, createSrtBackend } from "./srt-backend";
```

Run: `bun test test/unit/sandbox/ --timeout=60000` — PASS (srt-backend tests pass on macOS; skip with the reason on a machine without a working sandbox).
Run: `bun run typecheck && bun run check:sandbox-imports && bun run check:import-cycles && bun run build`

- [ ] **Step 10: Commit**

```bash
git add src/sandbox/ test/helpers/sandbox.ts test/helpers/index.ts test/unit/sandbox/
git commit -m "feat(sandbox): srt backend, real availability probe, process registry"
```

---

### Task 7: Agent-facing text and the command launcher

**Files:**
- Create: `src/sandbox/messages.ts`, `src/sandbox/launcher.ts`
- Modify: `src/sandbox/index.ts`
- Test: `test/unit/sandbox/launcher.test.ts`, `test/unit/sandbox/messages.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:

```ts
// messages.ts
export function sandboxSentence(network: "open" | readonly string[]): string;
export function unsandboxedSentence(reason: string): string;
export function rawBashRefusalReason(reason: string): string;
export function denialHintLine(writeRoots: readonly string[]): string;
export const LIKELY_SANDBOX_DENIAL: RegExp;
// launcher.ts
export interface CommandLauncherOptions {
  readonly state: SandboxState;
  readonly backend?: SandboxBackend;                              // required when state.kind === "available"
  readonly policyFor?: (root: string) => Promise<SandboxPolicy>;  // required when state.kind === "available"
}
export const _launcherDeps: { runArgv: typeof runArgv; newCommandId: () => string };
export function createCommandLauncher(opts: CommandLauncherOptions): CommandLauncher;
export const DISABLED_SANDBOX_STATE: SandboxState;  // { kind: "disabled" }
```

- [ ] **Step 1: messages.ts (with a test pinning every sentence)**

`src/sandbox/messages.ts`:

```ts
/**
 * Every sentence the agent reads about the sandbox (spec 5.5), in one place so
 * descriptions, refusals and result notes cannot drift apart. The agent must
 * always know whether it is sandboxed and what it may write (spec S5).
 */

export const LIKELY_SANDBOX_DENIAL = /Operation not permitted|Read-only file system/;

function describeNetwork(network: "open" | readonly string[]): string {
  if (network === "open") return "network access is unrestricted";
  if (network.length === 0) return "network access is disabled";
  return `network access is limited to ${network.join(", ")}`;
}

export function sandboxSentence(network: "open" | readonly string[]): string {
  return (
    "inside an OS sandbox: writes are allowed only under the repository root, the system temp directories and " +
    "package-manager caches; credential files (~/.ssh, ~/.aws, ~/.npmrc, nax credentials and similar) are unreadable; " +
    `${describeNetwork(network)}. A write anywhere else fails with "Operation not permitted" or "Read-only file system" ` +
    "-- that is the sandbox, not a bug in your command."
  );
}

export function unsandboxedSentence(reason: string): string {
  return `Commands are NOT sandboxed on this machine (${reason}).`;
}

export function rawBashRefusalReason(reason: string): string {
  return (
    `sandbox unavailable (${reason}): raw bash requires the sandbox when execution.sandbox.enabled is true -- ` +
    "set this stage's bashApproval to gated or escalate, or disable the sandbox."
  );
}

export function denialHintLine(writeRoots: readonly string[]): string {
  return `note: this command ran in the nax sandbox; that failure may be a sandbox denial -- writable roots: ${writeRoots.join(", ")}.`;
}
```

`test/unit/sandbox/messages.test.ts` — pin the exact strings:

```ts
import { describe, expect, test } from "bun:test";
import { denialHintLine, LIKELY_SANDBOX_DENIAL, rawBashRefusalReason, sandboxSentence } from "@/sandbox";

describe("sandbox messages", () => {
  test("network phrasing for open, none and an allow-list", () => {
    expect(sandboxSentence("open")).toContain("network access is unrestricted");
    expect(sandboxSentence([])).toContain("network access is disabled");
    expect(sandboxSentence(["registry.npmjs.org"])).toContain("network access is limited to registry.npmjs.org");
  });

  test("the raw refusal names the fallback modes", () => {
    const r = rawBashRefusalReason("bwrap missing");
    expect(r).toStartWith("sandbox unavailable (bwrap missing): raw bash requires the sandbox");
    expect(r).toContain("gated or escalate");
  });

  test("the hint lists the roots", () => {
    expect(denialHintLine(["/a", "/b"])).toEndWith("writable roots: /a, /b.");
  });

  test("denial detection matches both platforms' wording", () => {
    expect(LIKELY_SANDBOX_DENIAL.test("sh: /x: Operation not permitted")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("cannot create /x: Read-only file system")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("No such file or directory")).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing launcher test**

`test/unit/sandbox/launcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _launcherDeps, createCommandLauncher, DISABLED_SANDBOX_STATE, type SandboxPolicy } from "@/sandbox";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-launcher-");
});
afterEach(() => cleanupTempDir(root));

const policy = (r: string): SandboxPolicy => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });
const available = { kind: "available", backend: "srt", network: "open" } as const;

describe("createCommandLauncher", () => {
  withDepsRestore(_launcherDeps);

  test("disabled: byte-identical runArgv arguments to today's Bash spawn", async () => {
    const calls: unknown[] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "bun test" },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: ["NPM_TOKEN"],
    });
    expect(calls[0]).toEqual({ argv: ["/bin/sh", "-c", "bun test"], cwd: root, timeoutMs: 1000, stripEnvVars: ["NPM_TOKEN"] });
    expect(r.executed).toEqual(["/bin/sh", "-c", "bun test"]);
    expect(r.sandbox).toEqual({ backend: "none", wrapped: false });
  });

  test("disabled argv spec passes the caller's env overlay through (Exec's Yarn overlay)", async () => {
    const calls: { env?: unknown }[] = [];
    _launcherDeps.runArgv = async (o) => {
      calls.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run({
      spec: { kind: "argv", argv: ["yarn", "add", "x"] },
      root,
      cwd: root,
      timeoutMs: 1000,
      stripEnvVars: [],
      env: { YARN_ENABLE_SCRIPTS: "false" },
    });
    expect(calls[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });

  test("available: wraps, runs the wrapper argv, records wrapped", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const r = await launcher.run({ spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" }, root, cwd: root, timeoutMs: 5000, stripEnvVars: [] });
    expect(r.stdout.trim()).toBe("hi");
    expect(r.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(r.sandbox).toEqual({ backend: "srt", wrapped: true });
    expect(backend.finished).toBe(1);
  });

  test("available: an argv spec is quoted into one shell command", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const r = await launcher.run({ spec: { kind: "argv", argv: ["echo", "a b", "$(id)"] }, root, cwd: root, timeoutMs: 5000, stripEnvVars: [] });
    expect(backend.calls[0]?.command).toBe("'echo' 'a b' '$(id)'");
    expect(r.stdout.trim()).toBe("a b $(id)");
  });

  // A regression PIN, not the F6 proof: the fake never returns an env, so it
  // cannot reproduce the original bug. The proof is the argv-only `wrap`
  // return type plus the live test in Task 12.
  test("F6: a stripped variable stays stripped inside a wrapped command", async () => {
    process.env.NAX_P4_LAUNCHER_SECRET = "s3cret";
    try {
      const launcher = createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("enforce"), policyFor: async (r) => policy(r) });
      const r = await launcher.run({
        spec: { kind: "shell", shell: "/bin/sh", command: 'echo "[$NAX_P4_LAUNCHER_SECRET]"' },
        root,
        cwd: root,
        timeoutMs: 5000,
        stripEnvVars: ["NAX_P4_LAUNCHER_SECRET"],
      });
      expect(r.stdout.trim()).toBe("[]");
    } finally {
      delete process.env.NAX_P4_LAUNCHER_SECRET;
    }
  });

  test("Review Focus 4: a wrap that throws is an error and NOTHING runs unwrapped", async () => {
    let spawned = 0;
    _launcherDeps.runArgv = async () => {
      spawned += 1;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("throw"), policyFor: async (r) => policy(r) });
    await expect(
      launcher.run({ spec: { kind: "shell", shell: "/bin/sh", command: "touch x" }, root, cwd: root, timeoutMs: 1000, stripEnvVars: [] }),
    ).rejects.toThrow("[sandbox] could not wrap the command: fake wrap failure");
    expect(spawned).toBe(0);
  });

  test("a likely denial appends the hint line and marks the record", async () => {
    const launcher = createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("enforce"), policyFor: async (r) => policy(r) });
    const r = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo 'x: Operation not permitted' >&2; exit 1" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    expect(r.stderr).toContain(`note: this command ran in the nax sandbox; that failure may be a sandbox denial -- writable roots: ${root}.`);
    expect(r.sandbox).toEqual({ backend: "srt", wrapped: true, denialHint: true });
  });

  test("a failure that is not a denial gets no hint", async () => {
    const launcher = createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("enforce"), policyFor: async (r) => policy(r) });
    const r = await launcher.run({ spec: { kind: "shell", shell: "/bin/sh", command: "exit 3" }, root, cwd: root, timeoutMs: 5000, stripEnvVars: [] });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).not.toContain("note: this command ran");
    expect(r.sandbox.denialHint).toBeUndefined();
  });

  test("unavailable: runs unwrapped and records why", async () => {
    const launcher = createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
    const r = await launcher.run({ spec: { kind: "shell", shell: "/bin/sh", command: "echo hi" }, root, cwd: root, timeoutMs: 5000, stripEnvVars: [] });
    expect(r.stdout.trim()).toBe("hi");
    expect(r.sandbox).toEqual({ backend: "srt", wrapped: false, reason: "no bwrap" });
  });

  test("Review Focus 5: cwd is honoured separately from root", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: available, backend, policyFor: async (r) => policy(r) });
    const pkg = `${root}/pkg`;
    Bun.spawnSync(["mkdir", "-p", pkg]);
    const r = await launcher.run({ spec: { kind: "shell", shell: "/bin/sh", command: "pwd" }, root, cwd: pkg, timeoutMs: 5000, stripEnvVars: [] });
    expect(backend.calls[0]?.cwd).toBe(pkg);
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(r.stdout.trim().endsWith("/pkg")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `bun test test/unit/sandbox/launcher.test.ts --timeout=30000` — FAIL.

- [ ] **Step 4: Implement `launcher.ts`**

```ts
/**
 * How an agent-authored command runs (spec 5.1). Never WHETHER -- that is the
 * policy's call (single-gate rule). Handed only to Bash and RunCommand's Exec
 * branch, so a user-authored command can never be wrapped (D14).
 *
 * Two rules with teeth:
 * - F6: the backend returns argv only; runArgv receives the CALLER's env
 *   overlay and strips from process.env exactly as today.
 * - A wrap that throws is an error. The command never runs unwrapped: what
 *   stops is the command, never the sandbox.
 */
import { randomUUID } from "node:crypto";
import { runArgv } from "../utils/argv-exec";
import { quoteArgvForShell } from "./argv-quote";
import { denialHintLine, LIKELY_SANDBOX_DENIAL } from "./messages";
import type {
  CommandLauncher,
  LaunchRequest,
  LaunchResult,
  SandboxBackend,
  SandboxPolicy,
  SandboxRecord,
  SandboxState,
} from "./types";

export const DISABLED_SANDBOX_STATE: SandboxState = { kind: "disabled" };

export const _launcherDeps = { runArgv, newCommandId: (): string => randomUUID() };

export interface CommandLauncherOptions {
  readonly state: SandboxState;
  readonly backend?: SandboxBackend;
  readonly policyFor?: (root: string) => Promise<SandboxPolicy>;
}

function logicalArgv(req: LaunchRequest): readonly string[] {
  return req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv;
}

async function runUnwrapped(req: LaunchRequest, sandbox: SandboxRecord): Promise<LaunchResult> {
  const argv = logicalArgv(req);
  const result = await _launcherDeps.runArgv({
    argv,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    stripEnvVars: [...req.stripEnvVars],
    ...(req.env !== undefined ? { env: req.env } : {}),
  });
  return { ...result, executed: argv, sandbox };
}

async function runWrapped(req: LaunchRequest, backend: SandboxBackend, policy: SandboxPolicy): Promise<LaunchResult> {
  const command = req.spec.kind === "shell" ? req.spec.command : quoteArgvForShell(req.spec.argv);
  const shell = req.spec.kind === "shell" ? req.spec.shell : "/bin/sh";
  const commandId = _launcherDeps.newCommandId();
  let argv: readonly string[];
  try {
    argv = await backend.wrap({ command, shell, policy, cwd: req.cwd, commandId });
  } catch (err) {
    throw new Error(`[sandbox] could not wrap the command: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  try {
    const result = await _launcherDeps.runArgv({
      argv,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      stripEnvVars: [...req.stripEnvVars],
      ...(req.env !== undefined ? { env: req.env } : {}),
    });
    const denied = result.exitCode !== 0 && LIKELY_SANDBOX_DENIAL.test(result.stderr);
    const violations = backend.annotate(commandId, result.stderr);
    const extra = [...(denied ? [denialHintLine(policy.writeRoots)] : []), ...(violations !== "" ? [violations] : [])];
    return {
      ...result,
      stderr: extra.length > 0 ? `${result.stderr}\n${extra.join("\n")}` : result.stderr,
      executed: logicalArgv(req),
      sandbox: { backend: backend.name, wrapped: true, ...(denied ? { denialHint: true as const } : {}) },
    };
  } finally {
    backend.commandFinished();
  }
}

export function createCommandLauncher(opts: CommandLauncherOptions): CommandLauncher {
  const { state } = opts;
  return {
    state,
    async run(req) {
      if (state.kind === "disabled") return runUnwrapped(req, { backend: "none", wrapped: false });
      if (state.kind === "unavailable") {
        return runUnwrapped(req, { backend: state.backend, wrapped: false, reason: state.reason });
      }
      if (opts.backend === undefined || opts.policyFor === undefined) {
        throw new Error("[sandbox] an available launcher needs a backend and a policy");
      }
      return runWrapped(req, opts.backend, await opts.policyFor(req.root));
    },
  };
}
```

`backend.commandFinished()` must run exactly once per successful `wrap` — the `finally` above guarantees it; a `wrap` that throws already decremented its own in-flight count inside `createSrtBackend`.

Add to `src/sandbox/index.ts`:

```ts
export { _launcherDeps, type CommandLauncherOptions, createCommandLauncher, DISABLED_SANDBOX_STATE } from "./launcher";
export { denialHintLine, LIKELY_SANDBOX_DENIAL, rawBashRefusalReason, sandboxSentence, unsandboxedSentence } from "./messages";
```

- [ ] **Step 5: Verify** — `bun test test/unit/sandbox/ --timeout=60000` PASS; `bun run typecheck && bun run check:import-cycles`.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/ test/unit/sandbox/
git commit -m "feat(sandbox): command launcher (argv-only wrap, fail-closed, denial hint)"
```

---

### Task 8: Policy refusal for `raw` when the sandbox is unavailable

**Files:**
- Modify: `src/tools/policy.ts` (`ToolPolicyOptions` ~line 132, `compileToolPolicy` ~line 158, the `commandBranch({...})` call ~line 559), `src/tools/policy-command-branch.ts`
- Test: `test/unit/tools/policy-raw-refusal.test.ts`

**Interfaces:**
- Produces: `ToolPolicyOptions.rawBashRefusal?: string` — when set, every Bash call under `raw` is denied with exactly this reason (`breach: false`, not escalatable). Task 10 passes `rawBashRefusalReason(probe.reason)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy } from "@/tools";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

describe("rawBashRefusal", () => {
  test("raw + refusal: every Bash call is denied with the exact reason", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, {
        bashApproval: "raw",
        rawBashRefusal: "sandbox unavailable (x): raw bash requires the sandbox",
      });
      const v = policy.check("Bash", BASH_SCOPE, { command: "echo hi" });
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(v.reason).toBe("sandbox unavailable (x): raw bash requires the sandbox");
        expect(v.breach).toBe(false);
      }
    } finally {
      cleanupTempDir(root);
    }
  });

  test("raw without a refusal is unchanged (allowed)", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { bashApproval: "raw" });
      expect(policy.check("Bash", BASH_SCOPE, { command: "echo hi" }).allowed).toBe(true);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("gated ignores the refusal (gated/escalate run unwrapped, spec S5)", () => {
    const root = makeTempDir("raw-refusal-");
    try {
      const policy = compileToolPolicy([{ tool: "Bash", patterns: ["echo *"] }], root, {
        bashApproval: "gated",
        rawBashRefusal: "sandbox unavailable",
      });
      expect(policy.check("Bash", BASH_SCOPE, { command: "echo hi" }).allowed).toBe(true);
    } finally {
      cleanupTempDir(root);
    }
  });
});
```

`ToolPolicy.check(tool, scope, input)` and the `PolicyVerdict` deny shape `{ allowed: false, reason, breach, … }` are at `src/tools/types.ts:146-166`.

- [ ] **Step 2: Run to verify it fails** — FAIL (unknown option / allowed).

- [ ] **Step 3: Implement**

In `ToolPolicyOptions` (policy.ts, after `bashApproval`):

```ts
  /**
   * P4: set when `execution.sandbox.enabled` is true and the probe found the
   * sandbox unavailable. Under `raw`, every Bash call is then denied with this
   * reason -- raw requires the sandbox once it is enabled, and a silent
   * fallback to unsandboxed raw would be a posture downgrade (spec S5).
   * Ignored under gated/escalate, which run unwrapped with a warning.
   */
  readonly rawBashRefusal?: string;
```

In `compileToolPolicy`, pass `rawBashRefusal: options?.rawBashRefusal` into the `commandBranch({...})` call.

In `policy-command-branch.ts`, add `readonly rawBashRefusal?: string;` to `BashCommandBranchArgs`, destructure it, and make the raw branch start with:

```ts
  if (bashApproval === "raw") {
    if (rawBashRefusal !== undefined) return deny(rawBashRefusal, false, false);
    const screened = screenRawBashCommand({
```

- [ ] **Step 4: Verify** — `bun test test/unit/tools/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5` PASS; `wc -l src/tools/policy.ts` ≤ 600; `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/policy.ts src/tools/policy-command-branch.ts test/unit/tools/policy-raw-refusal.test.ts
git commit -m "feat(tools): raw bash refuses with a reason when the enabled sandbox is unavailable"
```

---

### Task 9: Bash and Exec run through the launcher; descriptions; audit field

**Files:**
- Modify: `src/tools/bash.ts`, `src/tools/run-command.ts`, `src/tools/run-command-exec.ts`, `src/tools/registry.ts` (`ToolResult.audit`), `src/tools/runtime.ts` (`log()` audit param + `sink.record`), `src/tools/tool-audit.ts` (`ToolCallRecord`)
- Test: `test/unit/tools/bash-sandbox.test.ts`, `test/unit/tools/run-command-exec-sandbox.test.ts`, `test/unit/tools/runtime-sandbox-audit.test.ts`

**Interfaces:**
- Consumes: `CommandLauncher`, `SandboxRecord`, `sandboxSentence`, `unsandboxedSentence` (Task 7).
- Produces: `BashToolOptions.launcher?: CommandLauncher`; `RunCommandExecOptions.launcher?: CommandLauncher`; `ToolResult.audit.sandbox?: SandboxRecord`; `ToolCallRecord.sandbox?: SandboxRecord`. With no launcher, both tools behave exactly as today (existing tests stub `_bashToolDeps.runArgv` and must stay green unedited).

- [ ] **Step 1: Write the failing Bash tests**

`test/unit/tools/bash-sandbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "@test/helpers";
import { createCommandLauncher, DISABLED_SANDBOX_STATE } from "@/sandbox";
import { createBashTool } from "@/tools";

let root: string;
beforeEach(() => {
  root = makeTempDir("bash-sbx-");
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });
const available = { kind: "available", backend: "srt", network: "open" } as const;
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

describe("Bash through the launcher", () => {
  test("disabled launcher: raw description is byte-identical to no launcher", () => {
    const plain = createBashTool({ bashApproval: "raw" }).description;
    const disabled = createBashTool({ bashApproval: "raw", launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }) }).description;
    expect(disabled).toBe(plain);
    expect(plain).toContain("paths are NOT contained");
  });

  test("available: raw description drops the uncontained sentence and states the sandbox", () => {
    const tool = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }),
    });
    expect(tool.description).not.toContain("paths are NOT contained");
    expect(tool.description).toContain("inside an OS sandbox");
    expect(tool.description).toContain("network access is unrestricted");
    expect(tool.description).toContain("that screen is advisory");
  });

  test("unavailable + raw: the description says Bash is refused and why", () => {
    const tool = createBashTool({
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }),
    });
    expect(tool.description).toContain("sandbox unavailable (no bwrap)");
    expect(tool.description).toContain("every call is refused");
  });

  test("gated: available appends the sandbox sentence; unavailable says not sandboxed", () => {
    const on = createBashTool({ bashApproval: "gated", patterns: ["bun *"], launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend(), policyFor }) });
    expect(on.description).toContain("Commands that pass run inside an OS sandbox");
    const off = createBashTool({ bashApproval: "gated", patterns: ["bun *"], launcher: createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } }) });
    expect(off.description).toContain("Commands are NOT sandboxed on this machine (no bwrap).");
  });

  test("run: goes through the launcher and carries the sandbox record on audit", async () => {
    const backend = makeFakeSandboxBackend();
    const tool = createBashTool({ launcher: createCommandLauncher({ state: available, backend, policyFor }) });
    const r = await tool.run({ command: "echo hi" }, ctx());
    expect(r.content).toContain("exit 0");
    expect(r.audit).toEqual({ executed: ["/bin/sh", "-c", "echo hi"], sandbox: { backend: "srt", wrapped: true } });
    expect(backend.calls[0]?.cwd).toBe(root);
  });

  test("run: a wrap failure is a tool error naming the sandbox", async () => {
    const tool = createBashTool({ launcher: createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("throw"), policyFor }) });
    const r = await tool.run({ command: "touch x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[sandbox] could not wrap the command");
    expect(await Bun.file(`${root}/x`).exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement in `bash.ts`**

1. Imports: `import { type CommandLauncher, rawBashRefusalReason, sandboxSentence, unsandboxedSentence } from "../sandbox";`
2. `BashToolOptions` gains:

```ts
  /**
   * P4: how the command runs. Absent = today's direct spawn through
   * `_bashToolDeps.runArgv` (unit tests). Production always passes one --
   * disabled, available or unavailable -- and its state also shapes the
   * description, so the agent always knows whether it is sandboxed.
   */
  readonly launcher?: CommandLauncher;
```

3. Restructure `rawDescription` so the containment sentence is a parameter — the default MUST reproduce today's string byte for byte (the first test pins it):

```ts
const RAW_UNCONTAINED =
  "The command runs from the repository root, but paths are NOT contained to it: a command may read or write anywhere the nax process " +
  "itself can reach, inside the repository or outside it. ";

function rawDescription(shell: string, containment: string = RAW_UNCONTAINED): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    "This stage runs under raw mode (ADR-030): pipes, redirects, command substitution ($(...), backticks), " +
    "process substitution, here-documents and subshells all work here -- nothing is refused for being unparseable, " +
    "and Bash allow/deny/ask rules configured for this stage are NOT consulted. " +
    containment +
    "The only refusal is a command the lexer CAN parse " +
    "that names or redirects into a path nax owns -- .nax/config.json, .nax/mono/*/config.json, " +
    ".nax/features/**/prd.json, or the root queue-control files -- change those through nax rather than by " + // nax-feature-dir-allow: prose naming the raw-mode protected-path screen, not a path construction
    "writing them directly; that screen is advisory, not a boundary, and a command using substitution skips it " +
    "entirely."
  );
}

function rawUnavailableDescription(shell: string, reason: string): string {
  return (
    `Run one shell command string under ${shell} -- but on this machine ${rawBashRefusalReason(reason)} ` +
    "Under raw mode every call is refused; use the structured tools (Read, Glob, Grep, Git, RunCommand) instead."
  );
}
```

Before replacing, diff the old and new `rawDescription()` output once in a scratch `bun -e` to confirm they are equal; the test in Step 1 also pins it. The `rawUnavailableDescription` text contains "every call is refused" (pinned by the test).

4. Replace `bashToolDescription`:

```ts
function bashToolDescription(shell: string, opts: BashToolOptions): string {
  const state = opts.launcher?.state ?? { kind: "disabled" as const };
  if (opts.bashApproval === "raw") {
    if (state.kind === "available") return rawDescription(shell, `The command runs from the repository root ${sandboxSentence(state.network)} `);
    if (state.kind === "unavailable") return rawUnavailableDescription(shell, state.reason);
    return rawDescription(shell);
  }
  // `escalate` stays identical to `gated` -- see the existing comment block, keep it here verbatim.
  const gated = gatedDescription(shell, opts.patterns);
  if (state.kind === "available") return `${gated} Commands that pass run ${sandboxSentence(state.network)}`;
  if (state.kind === "unavailable") return `${gated} ${unsandboxedSentence(state.reason)}`;
  return gated;
}
```

5. In `run()`, replace the `_bashToolDeps.runArgv` call:

```ts
      const argv = [shell, "-c", command];
      try {
        const launched =
          opts.launcher !== undefined
            ? await opts.launcher.run({
                spec: { kind: "shell", shell, command },
                root: ctx.root,
                cwd: ctx.root,
                timeoutMs,
                stripEnvVars: opts.stripEnvVars ?? [],
              })
            : {
                ...(await _bashToolDeps.runArgv({ argv, cwd: ctx.root, timeoutMs, stripEnvVars: [...(opts.stripEnvVars ?? [])] })),
                executed: argv,
                sandbox: undefined,
              };
        const body = launched.timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
        return {
          content: cutToByteCap(body, ctx.readCeiling ?? READ_CEILING),
          isError: launched.timedOut || launched.exitCode !== 0,
          audit: { executed: launched.executed, ...(launched.sandbox !== undefined ? { sandbox: launched.sandbox } : {}) },
          resultBytesPreTruncation: Buffer.byteLength(body, "utf8"),
        };
      } catch (err) {
```

(keep the existing `catch` — a wrap failure arrives there as an `Error` whose message the tool returns with `isError: true`.) Update the file header's "WHAT GATES IT: nothing here" paragraph with one sentence: "The launcher (P4) changes HOW the command runs -- inside an OS sandbox when enabled -- never WHETHER."

- [ ] **Step 4: `registry.ts`, `runtime.ts`, `tool-audit.ts`**

`registry.ts` — `ToolResult.audit` gains (with `import type { SandboxRecord } from "../sandbox";`):

```ts
    /** P4: how an agent-authored Bash/Exec command ran; absent for every other tool. */
    readonly sandbox?: SandboxRecord;
```

`tool-audit.ts` — `ToolCallRecord` gains the same optional field with a comment: "P4: `{ backend, wrapped, reason?, denialHint? }` on every Bash / Exec row; the exit runs gate on `wrapped`. Additive and optional, so `TOOL_AUDIT_SCHEMA_VERSION` stays 1 (as `approval` did)."

`runtime.ts` — in `log()`'s `audit?:` parameter type add `sandbox?: SandboxRecord;`, and in `sink.record({...})` add `...(audit?.sandbox !== undefined ? { sandbox: audit.sandbox } : {}),` after the `approval` line. The call site at ~line 377 already spreads `result.audit`, so nothing else changes.

`test/unit/tools/runtime-sandbox-audit.test.ts` (same in-memory sink and stub-tool shapes as `test/unit/tools/runtime.test.ts:103,488`):

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
beforeAll(() => {
  root = makeTempDir("rt-sbx-audit-");
});
afterAll(() => cleanupTempDir(root));

function runtimeFor(tool: CodingTool, records: ToolCallRecord[]) {
  return createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
    sink: { record: (e) => void records.push(e), flush: async () => {} },
    extraTools: [tool],
  });
}

describe("tool-audit sandbox field", () => {
  test("a tool's audit.sandbox reaches the recorded row", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Wrapped",
      description: "Wrapped",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok", audit: { executed: ["x"], sandbox: { backend: "srt", wrapped: true } } }),
    };
    await runtimeFor(tool, records).callTool("Wrapped", {});
    expect(records[0]?.sandbox).toEqual({ backend: "srt", wrapped: true });
    expect(records[0]?.executed).toEqual(["x"]);
  });

  test("a tool with no sandbox record produces a row WITHOUT the key", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Plain",
      description: "Plain",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok" }),
    };
    await runtimeFor(tool, records).callTool("Plain", {});
    expect(records[0] !== undefined && "sandbox" in records[0]).toBe(false);
  });
});
```

- [ ] **Step 5: Exec — failing test first**

`test/unit/tools/run-command-exec-sandbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "@test/helpers";
import { createCommandLauncher } from "@/sandbox";
import { runExecBranch } from "@/tools/run-command-exec";

let root: string;
beforeEach(() => {
  root = makeTempDir("exec-sbx-");
  mkdirSync(join(root, "packages", "app"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });

describe("Exec through the launcher", () => {
  test("Review Focus 5: package target runs in the package dir, roots derive from ctx.root, audit carries the record", async () => {
    const backend = makeFakeSandboxBackend();
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    const result = await runExecBranch({ argv: ["bun", "--version"], target: "package" }, ctx(), {
      exec: {
        repoRoot: root,
        packageWorkdir: join(root, "packages", "app"),
        allowScripts: false,
        patterns: ["bun *"],
        launcher,
      },
    });
    expect(backend.calls[0]?.cwd).toBe(join(root, "packages", "app"));
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(result.audit?.sandbox).toEqual({ backend: "srt", wrapped: true });
  });
});
```

Add the Yarn overlay test to the same file (it captures the spawn instead of running yarn; `runExecBranch` passes no `yarnMajor`, so `yarn add` always gets the Berry `YARN_ENABLE_SCRIPTS=false` overlay — `src/tools/package-managers-table.ts:256`):

```ts
describe("Exec env overlay through the launcher", () => {
  withDepsRestore(_launcherDeps);

  test("Review Focus 5: the Yarn no-scripts env overlay survives wrapping", async () => {
    const seen: { env?: Readonly<Record<string, string>> }[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    await runExecBranch({ argv: ["yarn", "add", "left-pad"], target: "repoRoot" }, ctx(), {
      exec: { repoRoot: root, packageWorkdir: root, allowScripts: false, patterns: ["yarn *"], launcher },
    });
    expect(seen[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });
});
```

Add `_launcherDeps` to the `@/sandbox` import and `withDepsRestore` to the `@test/helpers` import. If `normalizeExec` rejects `["bun","--version"]` in the first test for this fixture (it may require a manifest), use an argv the existing `test/unit/tools/run-command-exec.test.ts` runs successfully.

- [ ] **Step 6: Implement Exec**

`run-command.ts` — `RunCommandExecOptions` gains:

```ts
  /** P4: how the argv runs. Absent = direct runArgv (unit tests). */
  readonly launcher?: CommandLauncher;
```

(import `type CommandLauncher` and `sandboxSentence`/`unsandboxedSentence` from `"../sandbox"`), and the exec description gets a suffix — change the `exec !== undefined ? \`Two ways …Supply exactly one of "command" or "argv".\`` template to end with `${execSandboxNote(exec.launcher)}`:

```ts
function execSandboxNote(launcher: CommandLauncher | undefined): string {
  const state = launcher?.state;
  if (state?.kind === "available") return ` An "argv" call runs ${sandboxSentence(state.network)}`;
  if (state?.kind === "unavailable") return ` ${unsandboxedSentence(state.reason)}`;
  return "";
}
```

`run-command-exec.ts` — replace the `runArgv({...})` call:

```ts
    const launched =
      opts.exec.launcher !== undefined
        ? await opts.exec.launcher.run({
            spec: { kind: "argv", argv: normalized.argv },
            root: ctx.root,
            cwd: normalized.cwd,
            timeoutMs: EXEC_TIMEOUT_MS,
            stripEnvVars: opts.stripEnvVars ?? [],
            ...(normalized.env !== undefined ? { env: normalized.env } : {}),
          })
        : {
            ...(await runArgv({
              argv: normalized.argv,
              cwd: normalized.cwd,
              timeoutMs: EXEC_TIMEOUT_MS,
              stripEnvVars: [...(opts.stripEnvVars ?? [])],
              ...(normalized.env !== undefined ? { env: normalized.env } : {}),
            })),
            sandbox: undefined,
          };
```

then use `launched` where `result` was used, and set `audit: { executed: normalized.argv, target, ...(launched.sandbox !== undefined ? { sandbox: launched.sandbox } : {}) }`. The only new import is `import type { CommandLauncher } from "../sandbox";` via `RunCommandToolOptions` — do NOT import `quoteArgvForShell` here (the whole-file guard test reads this file and forbids a shell-quoting import; the quoting happens inside the launcher). Run `bun test test/unit/tools/run-command-exec.test.ts` to confirm that guard still passes.

- [ ] **Step 7: Verify**

Run: `bun test test/unit/tools/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5` — all pass, including the untouched `bash.test.ts` and `run-command-exec.test.ts`.
Run: `bun run typecheck && bun run check:import-cycles && bun run check:file-sizes`

- [ ] **Step 8: Commit**

```bash
git add src/tools/ test/unit/tools/
git commit -m "feat(tools): Bash and Exec run through the sandbox launcher and say so"
```

---

### Task 10: Session wiring — probe in the async resolver, data into the sync builder

**Files:**
- Create: `src/agents/coding-tool-sandbox.ts`
- Modify: `src/agents/coding-tool-support.ts`, `src/agents/coding-tool-extras.ts`
- Test: `test/unit/agents/coding-tool-sandbox.test.ts`, `test/integration/permissions/sandbox-wiring.test.ts`

**Interfaces:**
- Consumes: everything above; `approvalsPath` from `@/permissions` (`src/permissions/approvals-store.ts:36`).
- Produces:

```ts
// coding-tool-sandbox.ts
export const _sessionSandboxDeps: {
  backendFor: typeof sandboxBackendFor;
  probe: typeof probeSandboxOnce;
  gitLayout: typeof resolveGitLayout;
  featurePrds: typeof listFeaturePrdPaths;
  credentialFiles: typeof listCredentialFiles;
  tempRoots: typeof defaultTempRoots;
  homedir: () => string;
  platform: () => NodeJS.Platform;
};
export async function resolveSessionSandbox(args: {
  readonly config: SandboxConfig | undefined;
  readonly root: string;
  readonly outputDir?: string;
  readonly needsLauncher: boolean;
  readonly storyId?: string;
}): Promise<CommandLauncher>;
export function rawRefusalFor(launcher: CommandLauncher | undefined): string | undefined;
// buildCodingToolSupport args gain:  launcher?: CommandLauncher
// DeclaredCommandToolsArgs gains:    launcher?: CommandLauncher
```

- [ ] **Step 1: Write the failing unit test**

`test/unit/agents/coding-tool-sandbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _sessionSandboxDeps, rawRefusalFor, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import { _resetSandboxRegistryForTests } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let root: string;
beforeEach(() => {
  root = makeTempDir("session-sbx-");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const enabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };

describe("resolveSessionSandbox", () => {
  withDepsRestore(_sessionSandboxDeps);

  test("disabled config: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({ config: DEFAULT_SANDBOX_CONFIG, root, needsLauncher: true });
    expect(l.state).toEqual({ kind: "disabled" });
    expect(probes).toBe(0);
  });

  test("enabled but no Bash/Exec declared: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: false });
    expect(l.state.kind).toBe("disabled");
    expect(probes).toBe(0);
  });

  test("enabled + available: policy carries the approvals file and the story root", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    const outputDir = `${root}/out`;
    const l = await resolveSessionSandbox({ config: enabled, root, outputDir, needsLauncher: true });
    expect(l.state).toEqual({ kind: "available", backend: "srt", network: "open" });
    await l.run({ spec: { kind: "shell", shell: "/bin/sh", command: "true" }, root, cwd: root, timeoutMs: 5000, stripEnvVars: [] });
    const policy = backend.calls[0]?.policy;
    expect(policy?.denyWrite.some((p) => p.endsWith("/out/approvals.json"))).toBe(true);
    expect(policy?.writeRoots).toContain(realOrRaw(root));
  });

  test("enabled + unavailable: unavailable launcher and a raw refusal", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no bwrap" });
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: true });
    expect(l.state).toEqual({ kind: "unavailable", backend: "srt", reason: "no bwrap" });
    expect(rawRefusalFor(l)).toContain("sandbox unavailable (no bwrap)");
  });

  test("rawRefusalFor is undefined unless unavailable", () => {
    expect(rawRefusalFor(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement `src/agents/coding-tool-sandbox.ts`**

```ts
/**
 * The async half of P4's session wiring (spec 5.2, review finding 7).
 *
 * resolveCodingToolSupport is async and awaits this; buildCodingToolSupport is
 * synchronous and on the hot dispatch path, so it only receives the result as
 * data. Nothing here may be called from the sync path.
 */
import { homedir } from "node:os";
import type { SandboxConfig } from "@/config/schemas-sandbox";
import { approvalsPath } from "@/permissions";
import {
  type CommandLauncher,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  defaultTempRoots,
  listCredentialFiles,
  listFeaturePrdPaths,
  buildSandboxPolicy,
  probeSandboxOnce,
  rawBashRefusalReason,
  resolveGitLayout,
  sandboxBackendFor,
  warnSandboxUnavailableOnce,
} from "@/sandbox";

export const _sessionSandboxDeps = {
  backendFor: sandboxBackendFor,
  probe: probeSandboxOnce,
  gitLayout: resolveGitLayout,
  featurePrds: listFeaturePrdPaths,
  credentialFiles: listCredentialFiles,
  tempRoots: defaultTempRoots,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
};

export async function resolveSessionSandbox(args: {
  readonly config: SandboxConfig | undefined;
  readonly root: string;
  readonly outputDir?: string;
  readonly needsLauncher: boolean;
  readonly storyId?: string;
}): Promise<CommandLauncher> {
  const config = args.config;
  if (config === undefined || !config.enabled || !args.needsLauncher) {
    return createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
  }
  const backend = _sessionSandboxDeps.backendFor(config);
  const probe = await _sessionSandboxDeps.probe(backend, args.storyId);
  if (!probe.available) {
    warnSandboxUnavailableOnce(probe.reason, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: probe.reason } });
  }
  const git = await _sessionSandboxDeps.gitLayout(args.root);
  const credentialFiles = await _sessionSandboxDeps.credentialFiles();
  const approvalsFile = args.outputDir !== undefined ? approvalsPath(args.outputDir) : undefined;
  const policyFor = async (root: string) =>
    buildSandboxPolicy({
      root,
      git,
      featurePrdPaths: await _sessionSandboxDeps.featurePrds(root),
      credentialFiles,
      ...(approvalsFile !== undefined ? { approvalsFile } : {}),
      home: _sessionSandboxDeps.homedir(),
      tempRoots: _sessionSandboxDeps.tempRoots(),
      platform: _sessionSandboxDeps.platform(),
      config,
    });
  const network = config.network.allowedDomains ?? "open"; // absent = open (spec S2)
  return createCommandLauncher({ state: { kind: "available", backend: backend.name, network }, backend, policyFor });
}

/** The compile-time policy refusal for `raw` (Task 8), or undefined. */
export function rawRefusalFor(launcher: CommandLauncher | undefined): string | undefined {
  return launcher?.state.kind === "unavailable" ? rawBashRefusalReason(launcher.state.reason) : undefined;
}
```

If `@/permissions` does not export `approvalsPath`, import it from the path `src/pipeline/stages/execution.ts:41` uses.

- [ ] **Step 4: Thread it**

`coding-tool-extras.ts`: add `readonly launcher?: CommandLauncher;` to `DeclaredCommandToolsArgs` (import type from `@/sandbox`), add `...(args.launcher !== undefined ? { launcher: args.launcher } : {}),` inside the `exec: {...}` object and inside the `createBashTool({...})` options.

`coding-tool-support.ts`:
- `buildCodingToolSupport` args gain `/** P4: resolved by resolveCodingToolSupport (async); data only here. */ launcher?: CommandLauncher;`
- in `compileToolPolicy(effectiveGrants, args.root, { bashApproval, ... })` add `...(rawRefusalFor(args.launcher) !== undefined ? { rawBashRefusal: rawRefusalFor(args.launcher) } : {}),` — compute it once into a `const rawBashRefusal = rawRefusalFor(args.launcher);` above the call.
- pass `...(args.launcher !== undefined ? { launcher: args.launcher } : {}),` into `buildDeclaredCommandTools({...})`.
- in `resolveCodingToolSupport`, before the final `return buildCodingToolSupport({`:

```ts
  // P4: the probe is async, so it runs here and reaches the sync seam as data.
  // Read from the ROOT config: execution.sandbox is global-only (spec 6).
  const launcher =
    options.codingToolRoot !== undefined && options.codingToolRoot.trim() !== ""
      ? await resolveSessionSandbox({
          config: options.config?.execution?.sandbox,
          root: options.codingToolRoot,
          ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
          needsLauncher: declared.includes(BASH_TOOL_NAME) || declared.includes(EXEC_TOOL_NAME),
          ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
        })
      : undefined;
```

and add `...(launcher !== undefined ? { launcher } : {}),` to the `buildCodingToolSupport({...})` call. Imports: `import type { CommandLauncher } from "@/sandbox";` and `import { rawRefusalFor, resolveSessionSandbox } from "./coding-tool-sandbox";`.

If `options.config?.execution?.sandbox` does not typecheck because `AgentRunOptions["config"]` is the narrowed agent-manager `Pick`, read it via the same local widening pattern the file already uses for `quality`/`install` (RULING F2 comment): widen `options.config` to `{ execution?: { sandbox?: SandboxConfig } }` locally, do not broaden the shared selector.

- [ ] **Step 5: Integration test through the production seam (fake backend, real shell)**

`test/integration/permissions/sandbox-wiring.test.ts` — through the production seam, asserting what happened on disk:

```ts
/**
 * P4 wiring through buildCodingToolSupport -> runtime.callTool, with a FAKE
 * backend (real enforcement is the live suite's job). Asserts executed
 * outcomes -- was the canary written? -- not verdicts alone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { BashApprovalMode } from "@/config/bash-approval";
import { type CommandLauncher, createCommandLauncher, rawBashRefusalReason } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let root: string;
beforeEach(() => {
  root = makeTempDir("sbx-wiring-");
});
afterEach(() => cleanupTempDir(root));

const unavailable = () => createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

function session(bashApproval: BashApprovalMode, launcher: CommandLauncher, allow: string[] = ["*"]) {
  const support = buildCodingToolSupport({
    root,
    declared: ["Read", "Bash"],
    grants: [{ tool: "Read", patterns: ["*"] }, { tool: "Bash", patterns: allow }],
    bashApproval,
    launcher,
  });
  if (support === undefined) throw new Error("no support");
  return support;
}

describe("sandbox wiring (production seam)", () => {
  test("raw + unavailable: refused with the reason, and nothing ran", async () => {
    const support = session("raw", unavailable());
    const out = await support.runtime.callTool("Bash", { command: "echo hi > canary.txt" });
    expect(out.kind).toBe("denied");
    // toStartWith: the runtime may append a " -- <redirect>" to any denial (runtime.ts:456-465).
    if (out.kind === "denied") expect(out.reason).toStartWith(rawBashRefusalReason("no bwrap"));
    expect(existsSync(join(root, "canary.txt"))).toBe(false);
  });

  test("raw + unavailable: the advertised Bash description says so", () => {
    const bash = session("raw", unavailable()).tools.find((t) => t.name === "Bash");
    expect(bash?.description).toContain("sandbox unavailable (no bwrap)");
  });

  test("gated + unavailable: an allowed command runs unwrapped", async () => {
    const support = session("gated", unavailable(), ["echo *"]);
    const out = await support.runtime.callTool("Bash", { command: "echo hi" });
    expect(out.kind).toBe("ok");
  });

  test("raw + available: runs through the backend at the root", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: { kind: "available", backend: "srt", network: "open" }, backend, policyFor });
    const out = await session("raw", launcher).runtime.callTool("Bash", { command: "echo hi > canary.txt" });
    expect(out.kind).toBe("ok");
    expect(existsSync(join(root, "canary.txt"))).toBe(true);
    // ctx.root arrives realpath-resolved (compileToolPolicy -> realOrRaw): /var -> /private/var on macOS.
    expect(backend.calls[0]?.cwd).toBe(realOrRaw(root));
  });

  test("D14: a declared RunCommand command never reaches the launcher", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({ state: { kind: "available", backend: "srt", network: "open" }, backend, policyFor });
    const support = buildCodingToolSupport({
      root,
      declared: ["RunCommand"],
      grants: [{ tool: "RunCommand", patterns: ["*"] }],
      declaredCommands: new Map([["hello", "echo hi"]]),
      bashApproval: "raw",
      launcher,
    });
    const out = await support?.runtime.callTool("RunCommand", { command: "hello" });
    expect(out?.kind).toBe("ok");
    expect(backend.calls).toHaveLength(0);
  });
});
```

If `RunCommand`'s grant pattern syntax differs (check `test/unit/tools/run-command.test.ts` for how a declared command is granted), match it; the assertion that matters is `backend.calls` staying empty.

- [ ] **Step 6: Verify**

Run: `bun test test/unit/agents/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5` — PASS.
Run: `bun run typecheck && bun run check:file-sizes && bun run check:import-cycles && bun run check:sandbox-imports`
Run: `wc -l src/agents/coding-tool-support.ts` — must be ≤ 600.

- [ ] **Step 7: Commit**

```bash
git add src/agents/ test/unit/agents/coding-tool-sandbox.test.ts test/integration/permissions/sandbox-wiring.test.ts
git commit -m "feat(agents): probe the sandbox per session and hand it to the tools as data"
```

---

### Task 11: Approvals-cache relaxation and run-end reset

**Files:**
- Modify: `src/permissions/approvals-link.ts`, `src/pipeline/stages/execution.ts:147-151`, `src/execution/lifecycle/run-cleanup.ts:~286-294`
- Test: `test/unit/permissions/approvals-link.test.ts` (extend), `test/unit/execution/lifecycle/run-cleanup-sandbox.test.ts`

**Interfaces:**
- `createApprovalsLink` opts gain `readonly sandboxEnabled: boolean;` (required — every caller must decide).

- [ ] **Step 1: Failing table test**

Add to the existing approvals-link test file (find it: `rg -l createApprovalsLink test/`), a `test.each`:

```ts
test.each([
  { raw: false, sandbox: false, disabled: false },
  { raw: true, sandbox: false, disabled: true },
  { raw: true, sandbox: true, disabled: false },
  { raw: false, sandbox: true, disabled: false },
])("P4: raw=$raw sandbox=$sandbox -> cache disabled=$disabled", async ({ raw, sandbox, disabled }) => {
  const dir = makeTempDir("link-");
  const link = createApprovalsLink({
    approvalsFile: await seeded(dir),
    repoRoot: "/repo",
    stageModes: raw ? ["escalate", "raw"] : ["escalate"],
    sandboxEnabled: sandbox,
  });
  const out = await link.resolve(REQ);
  expect(out.decision).toBe(disabled ? "abstain" : "allow");
  cleanupTempDir(dir);
});
```

`REQ` and `seeded()` already exist at the top of `test/unit/permissions/approvals-link.test.ts`. Every existing `createApprovalsLink({...})` call in that file and in `test/integration/permissions/approval-gate.test.ts` needs `sandboxEnabled: false` added (the field is required) — that is the only edit to existing tests in this task, and it preserves their meaning.

- [ ] **Step 2: Implement**

```ts
export function createApprovalsLink(opts: {
  readonly approvalsFile: string;
  readonly repoRoot: string;
  /** Every stage's resolved bashApproval mode in this run. */
  readonly stageModes: readonly string[];
  /**
   * `execution.sandbox.enabled` (P4). With the sandbox enabled a raw stage is
   * either wrapped -- and the approvals file is ALWAYS in its denyWrite, even
   * when outputDir puts it inside a write root -- or refused outright, so it
   * cannot forge this file. Config-only by design: no dependency on the probe.
   */
  readonly sandboxEnabled: boolean;
}): AskLink {
  const rawStage = opts.stageModes.includes("raw") && !opts.sandboxEnabled;
```

Update the header's TRUST BOUNDARY paragraph: replace "P4's sandbox is what closes the underlying hole." with "P4's sandbox closes the underlying hole when enabled: see `sandboxEnabled`." and the warn reason to `"a stage resolves to bashApproval:raw without the sandbox, which can forge this file"`.

In `execution.ts` pass `sandboxEnabled: ctx.config.execution?.sandbox?.enabled === true,` (use whatever accessor for the root config the surrounding code already uses — `ctx.config`).

- [ ] **Step 3: Run-end reset**

In `run-cleanup.ts` after the interaction-chain block:

```ts
  // P4: srt keeps proxy servers and (Linux) bridge processes per process.
  try {
    await _runCleanupDeps.resetSandbox();
  } catch (error) {
    logger?.warn("sandbox", "Sandbox reset failed", { error });
  }
```

and add `resetSandbox: resetSandboxBackend` to `_runCleanupDeps`, importing it as `import { resetSandboxBackend } from "@/sandbox";` (Biome bans `../../*` relative imports).

`test/unit/execution/lifecycle/run-cleanup-sandbox.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makePluginRegistry, makePRD, withDepsRestore } from "@test/helpers";
import { _runCleanupDeps, cleanupRun } from "@/execution";
import type { RunCleanupOptions } from "@/execution/lifecycle/run-cleanup";

function options(): RunCleanupOptions {
  return {
    runId: "run-p4",
    startTime: Date.now() - 1000,
    totalCost: 0,
    storiesCompleted: 0,
    prd: makePRD({ feature: "p4-sandbox" }),
    pluginRegistry: makePluginRegistry(),
    workdir: "/tmp/p4-sandbox",
    interactionChain: null,
    feature: "p4-sandbox",
    prdPath: "/tmp/p4-sandbox/.nax/features/p4-sandbox/prd.json",
    branch: "feat/p4",
    version: "1.0.0",
    hooks: { hooks: {} },
    dryRun: true,
  };
}

describe("cleanupRun -- P4 sandbox reset", () => {
  withDepsRestore(_runCleanupDeps, ["resetSandbox", "wipeScratchpad"]);

  test("resets the sandbox backend once", async () => {
    let resets = 0;
    _runCleanupDeps.resetSandbox = async () => {
      resets += 1;
    };
    _runCleanupDeps.wipeScratchpad = async () => {};
    await cleanupRun(options());
    expect(resets).toBe(1);
  });

  test("a failing reset does not fail cleanup", async () => {
    _runCleanupDeps.resetSandbox = async () => {
      throw new Error("bridge did not exit");
    };
    _runCleanupDeps.wipeScratchpad = async () => {};
    await expect(cleanupRun(options())).resolves.toBeUndefined();
  });
});
```

The options literal is the one from `test/unit/execution/lifecycle/run-cleanup-scratchpad-wipe.test.ts:26-45`; if `RunCleanupOptions` has gained required fields since, copy that file's current `makeCleanupOptions`.

- [ ] **Step 4: Verify** — `bun test test/unit/permissions/ test/unit/execution/ test/integration/permissions/ --timeout=60000 2>&1 | tail -5` PASS; `bun run typecheck`; `bun run check:logger-storyid` (execution.ts is in its scope — the edited line is not a logger call, so the count is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/permissions/approvals-link.ts src/pipeline/stages/execution.ts src/execution/lifecycle/run-cleanup.ts test/
git commit -m "feat(permissions): approvals cache survives raw stages when the sandbox is enabled"
```

---

### Task 12: Live sandbox suite (real srt, production entry) and CI

**Files:**
- Create: `test/integration/sandbox/sandbox-live.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:** Consumes everything. This is the suite the spec's §8.4 names; every assertion is on the FILE SYSTEM after the call, never on a verdict alone.

- [ ] **Step 1: Write the suite**

`test/integration/sandbox/sandbox-live.test.ts`:

```ts
/**
 * P4 live suite: REAL srt, through the production seam
 * (resolveSessionSandbox -> buildCodingToolSupport -> runtime.callTool),
 * asserting what landed on disk -- never a verdict alone.
 *
 * Skipped, with the probe's reason in the describe title, when the sandbox is
 * unavailable here. With NAX_SANDBOX_REQUIRED=1 (CI) unavailable is a FAILURE,
 * so the suite can never pass by skipping where it is supposed to run.
 *
 * srt's SandboxManager is one per process and `bun test` shares one process
 * across files: this file uses ONLY the registry's backend (one instance) and
 * resets it in afterAll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForCondition, withDepsRestore } from "@test/helpers";
import { _sessionSandboxDeps, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import { _resetSandboxRegistryForTests, probeSandboxOnce, resetSandboxBackend, sandboxBackendFor } from "@/sandbox";

const CONFIG = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
const probe = await probeSandboxOnce(sandboxBackendFor(CONFIG));
const REQUIRED = process.env.NAX_SANDBOX_REQUIRED === "1";
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

if (!probe.available && REQUIRED) {
  test("the sandbox must be available where NAX_SANDBOX_REQUIRED=1", () => {
    throw new Error(`sandbox unavailable in a required environment: ${probe.reason}`);
  });
}

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

describe.skipIf(!probe.available)(`live sandbox (${label})`, () => {
  withDepsRestore(_sessionSandboxDeps, ["tempRoots", "homedir"]);
  let base: string;
  let root: string;
  let outside: string;
  let home: string;

  beforeEach(() => {
    // Under os.tmpdir(): on macOS that is /var/folders -> /private/var, so a
    // not-yet-existing deny is exercised through a symlinked spelling
    // (Review Focus 2).
    base = makeTempDir("sbx-live-");
    root = join(base, "repo");
    outside = join(base, "outside");
    home = join(base, "home");
    for (const d of [root, outside, home, join(base, "tmp"), join(root, ".nax", "features", "f1")]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(root, ".nax", "config.json"), "{}\n");
    // The session's temp root is a PRIVATE dir, so the rest of the system
    // temp dir -- where `outside` lives -- is outside every write root.
    _sessionSandboxDeps.tempRoots = () => [join(base, "tmp")];
    _sessionSandboxDeps.homedir = () => home;
  });
  afterEach(() => cleanupTempDir(base));
  afterAll(async () => {
    await resetSandboxBackend();
    _resetSandboxRegistryForTests();
  });

  async function bash(opts: { root?: string; outputDir?: string; stripEnvVars?: string[] } = {}) {
    const r = opts.root ?? root;
    const launcher = await resolveSessionSandbox({
      config: CONFIG,
      root: r,
      ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
      needsLauncher: true,
    });
    const support = buildCodingToolSupport({
      root: r,
      declared: ["Read", "Bash"],
      grants: [{ tool: "Read", patterns: ["*"] }],
      bashApproval: "raw",
      launcher,
      ...(opts.stripEnvVars !== undefined ? { stripEnvVars: opts.stripEnvVars } : {}),
    });
    if (support === undefined) throw new Error("no coding-tool support");
    return async (command: string, timeoutMs?: number) => {
      const out = await support.runtime.callTool("Bash", { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      return { kind: out.kind, content: "content" in out ? String(out.content) : "" };
    };
  }

  test("a write inside the root lands; a write outside does not", async () => {
    const run = await bash();
    await run(`echo in > in.txt; echo out > ${outside}/leak.txt`);
    expect(existsSync(join(root, "in.txt"))).toBe(true);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false);
  });

  test("D13a gap 3 composite: an unmodellable cd into .nax cannot overwrite config.json", async () => {
    const run = await bash();
    await run("cd -P .nax && echo PWNED > config.json");
    expect(readFileSync(join(root, ".nax", "config.json"), "utf8")).toBe("{}\n");
  });

  test("a prd.json in a feature dir created AFTER the session started is protected", async () => {
    const run = await bash();
    mkdirSync(join(root, ".nax", "features", "f2"), { recursive: true });
    writeFileSync(join(root, ".nax", "features", "f2", "prd.json"), "{}");
    await run("echo PWNED > .nax/features/f2/prd.json");
    expect(readFileSync(join(root, ".nax", "features", "f2", "prd.json"), "utf8")).toBe("{}");
  });

  test("Review Focus 3: approvals.json under an outputDir INSIDE a write root stays unwritable", async () => {
    const outputDir = join(home, ".cache", "nax");
    mkdirSync(outputDir, { recursive: true });
    const approvals = join(outputDir, "approvals.json");
    writeFileSync(approvals, "[]");
    const run = await bash({ outputDir });
    await run(`echo forged > ${approvals}; echo ok > ${join(home, ".cache", "other.txt")}`);
    expect(readFileSync(approvals, "utf8")).toBe("[]");
    // the cache root itself IS writable -- the deny is specific, not a missing root
    expect(existsSync(join(home, ".cache", "other.txt"))).toBe(true);
  });

  test("F6 / Review Focus 1: a stripped secret is empty inside the sandbox", async () => {
    process.env.NAX_P4_FAKE_SECRET = "s3cret";
    try {
      const run = await bash({ stripEnvVars: ["NAX_P4_FAKE_SECRET"] });
      const out = await run('echo "[$NAX_P4_FAKE_SECRET]"');
      expect(out.content).toContain("[]");
      expect(out.content).not.toContain("s3cret");
    } finally {
      delete process.env.NAX_P4_FAKE_SECRET;
    }
  });

  test("F2 + finding 4: from a worktree, commits work; hooks, config and the .git pointer are unwritable", async () => {
    git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "seed.txt"), "seed");
    git(["add", "-A"], root);
    git(["commit", "-qm", "seed"], root);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt-us-001"], root);
    const wt = join(root, ".nax-wt", "US-001");
    const configBefore = readFileSync(join(root, ".git", "config"), "utf8");
    const pointerBefore = readFileSync(join(wt, ".git"), "utf8");

    const run = await bash({ root: wt });
    await run('echo w > w.txt && git -c user.email=a@b -c user.name=a add w.txt && git -c user.email=a@b -c user.name=a commit -qm "p4 live commit"');
    expect(git(["log", "--oneline", "wt-us-001"], root)).toContain("p4 live commit");

    await run(`echo 'echo HOOKED' > ${join(root, ".git", "hooks", "pre-commit")}`);
    await run(`echo '[core]' >> ${join(root, ".git", "config")}`);
    await run("echo 'gitdir: /tmp/elsewhere' > .git");
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(wt, ".git"), "utf8")).toBe(pointerBefore);
  });

  test("a timeout kills sandboxed grandchildren", async () => {
    const run = await bash();
    const out = await run("sleep 4711 & sleep 4711 & wait", 1000);
    expect(out.content).toContain("timed out");
    const survivors = () =>
      Bun.spawnSync(["/bin/sh", "-c", "ps -e -o args | grep 'sleep 4711' | grep -v grep || true"]).stdout.toString().trim();
    // Rejects (fails the test) if any survivor outlives 3 s.
    await waitForCondition(() => survivors() === "", 3_000, 50);
  });

  test("the likely-denial note reaches the tool result", async () => {
    const run = await bash();
    const out = await run(`echo x > ${outside}/y.txt`);
    expect(out.content).toContain("note: this command ran in the nax sandbox");
  });

  test("the resolved spelling is what the policy used (symlinked temp parent)", async () => {
    // makeTempDir returns the UNRESOLVED spelling; the deny must still hold.
    const run = await bash();
    mkdirSync(join(root, ".nax", "features", "f3"), { recursive: true });
    await run("echo PWNED > .nax/features/f3/prd.json");
    expect(existsSync(join(root, ".nax", "features", "f3", "prd.json"))).toBe(false);
  });
});
```

**Give every `test(...)` in this file an explicit third argument `30_000`** (e.g. `test("…", async () => { … }, 30_000);`): `bunfig.toml` and `scripts/run-tests.ts:60` impose a 5 s default, and the worktree and timeout tests have too little margin under it. No fixed sleeps anywhere (`.nax/rules/forbidden-patterns-tests.md`): the timeout test waits with `waitForCondition`. If `waitForCondition` resolves rather than rejects on timeout in this repo's version, follow it with `expect(survivors()).toBe("")`.

- [ ] **Step 2: Run locally (macOS)**

Run: `bun test test/integration/sandbox/sandbox-live.test.ts --timeout=60000`
Expected: PASS, describe title `live sandbox (available)`. If any assertion fails, it is a real defect — fix the source, not the test.

- [ ] **Step 3: CI — install and enable bubblewrap, require the sandbox**

In `.github/workflows/ci.yml`, after "Install dependencies" and before "Typecheck":

```yaml
      # P4: the live sandbox suite needs a working bubblewrap. Ubuntu 24.04
      # restricts unprivileged user namespaces through AppArmor, which makes
      # bwrap fail every command; the sysctl lifts that for this job only.
      # NAX_SANDBOX_REQUIRED (below) turns an unavailable sandbox into a test
      # FAILURE, so the suite cannot pass here by skipping.
      - name: Enable the OS sandbox (bubblewrap)
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq bubblewrap socat ripgrep
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
```

and add to the "Test (integration)" step:

```yaml
        env:
          NAX_SANDBOX_REQUIRED: "1"
```

This is verified only when the PR's CI runs. If the first CI run fails with the "required environment" test, read the reason it prints, fix the runner setup (not the test), and record what was needed in the ADR text (Task 13).

- [ ] **Step 4: Verify** — `bun run test 2>&1 | tail -8` (full suite green locally); `bun run test:coverage` (per-file 80% floor — new `src/sandbox/*` files are covered by Tasks 4–12; if `srt-backend.ts` is under the floor on a machine where the live suite skipped, that is expected locally only if the sandbox is unavailable there — on macOS it must pass).

- [ ] **Step 5: Commit**

```bash
git add test/integration/sandbox/ .github/workflows/ci.yml
git commit -m "test(sandbox): live suite through the production seam; CI requires the sandbox"
```

---

### Task 13: ADR-030 amendment, spec status, final gates

**Files:**
- Modify: `docs/adr/ADR-030-bash-approval-modes.md` (append an amendment section after the P2 amendment, before any trailing references), `docs/superpowers/specs/2026-09-23-p4-sandbox-backend-design.md` (status line)

- [ ] **Step 1: Write the amendment**

Append `## Amendment — 2026-09-23: the sandbox backend (P4)` with these subsections, each a short paragraph in the ADR's existing voice (read the P2 amendment first and match it):

1. **Decision.** `execution.sandbox` wraps agent-authored Bash and RunCommand Exec commands in an OS sandbox behind a `SandboxBackend` interface; srt (`@anthropic-ai/sandbox-runtime`, pinned 0.0.77) is the first backend; a container backend would implement the same interface. Opt-in (`enabled: false`) until the P4 exit runs; the flip to default-on is a separate change.
2. **Posture when enabled.** `raw` requires the sandbox: if the probe finds it unavailable, every raw Bash call is refused with a reason naming `gated`/`escalate`. `gated`/`escalate` run unwrapped with one warning — their mechanical gate is still the boundary. No silent posture downgrade.
3. **Threat model unchanged (D1).** Blast-radius limiter for the agent's own mistakes, not a security boundary. Network is open by default for that reason.
4. **Literal paths, and why.** srt on Linux silently drops glob `denyWrite` entries; every policy path is literal and realpath-resolved.
5. **Worktrees.** The git common dir is writable so commits work; hooks, config and every worktree pointer file are denied. Known limitation: an agent mistake can move other refs in the common dir — accepted under D1.
6. **Two holes closed when sandboxed.** D13a gap 3 (the unmodellable `cd` into `.nax`) and the P2 approvals-cache forgery; the approvals file is always write-denied, so the cache's raw precondition becomes "raw AND sandbox disabled".
7. **Environment.** srt's returned env is discarded; `stripEnvVars` applies exactly as before.
8. **Platform requirements.** macOS: `sandbox-exec` (built in). Linux: `bwrap`, `socat`, `rg`; in a container `--security-opt systempaths=unconfined`; on Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns=0`. Windows: unavailable (probe). Record here anything Task 12's first CI run needed beyond this.

- [ ] **Step 2: Spec status and the master plan**

Change the spec's status line to `**Status:** implemented on feat/p4-sandbox-backend (PR pending); exit runs pending (§10)`.

The master plan lives OUTSIDE this repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-native-coding-agent-master-plan.md`. Update its §6 P4 row to "IMPLEMENTED on `feat/p4-sandbox-backend` (head `<sha>`), NOT pushed; exit runs pending", amend D5 in §3 with one paragraph (literal realpath'd paths, real probe, open network default, opt-in, srt env discarded — cite the spec's F1–F6), and add a dated changelog entry at the top of §8 listing what shipped and what did not. Commit it in THAT repo (`git -C /Users/williamkhoo/workspace/subrina-coder add projects/nax/nax-native-coding-agent-master-plan.md && git -C /Users/williamkhoo/workspace/subrina-coder commit -m "docs(nax): P4 sandbox backend implemented"`), staging only that file — the workspace has many unrelated untracked files.

- [ ] **Step 3: Final gates**

Run each and confirm green:

```bash
bun run typecheck
bun run check:all
bun run test
bun run test:coverage
bun run build
git diff --stat main...HEAD
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/ADR-030-bash-approval-modes.md docs/superpowers/specs/2026-09-23-p4-sandbox-backend-design.md
git commit -m "docs(adr): amend ADR-030 for the P4 sandbox backend"
```

- [ ] **Step 5: Stop before pushing**

Do NOT push or open a PR. Per the working agreement, code review happens BEFORE push: report the branch head and the gate results, and hand off for review (`superpowers:requesting-code-review` or the user's choice). The P4 exit runs (spec §10) are billed `nax run`s and need explicit user approval at the launch moment.
