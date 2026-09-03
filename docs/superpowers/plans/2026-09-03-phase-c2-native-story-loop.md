# Phase C2 — Native Story Loop and Tool-Call Instrument Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native path the smallest capability set that lets an implementer story reach a commit, and record every tool outcome durably enough to decide what Phase C3 should be.

**Architecture:** Three new tools join the C1 registry — `GitCommit` (stage and commit, nax-built argv), `RunCommand` (executes only commands the project already declares, via the existing quality runner), and `RequestCapability` (records a want, grants nothing). A sink on the existing per-call log seam persists every outcome to `.nax/tool-audit/`, because the logger the seam writes to today is not durable enough for a decision to be read back off it.

**Tech Stack:** TypeScript, Bun, `bun test`. Existing seams: `src/tools/` (C1 registry, policy, runtime), `src/quality/runner.ts`, `src/verification/shell-quote.ts`, `src/review/review-audit.ts` (persistence shape to mirror).

**Spec:** `docs/superpowers/specs/2026-09-03-phase-c2-native-story-loop-design.md`

## Global Constraints

- **The root is a hard boundary no grant can widen.** Containment (`resolveWithin`) runs before pattern matching, for every tool, including the new ones.
- **No new tool joins `DEFAULT_CODING_TOOLS`.** That constant stays `["Read", "Glob", "Grep"]` (`src/config/permissions.ts:96`). Every tool added here requires an explicit grant AND an explicit op declaration; advertised is the intersection and both can only narrow.
- **Permission decisions live only in `src/config/permissions.ts`.** `scripts/check-permission-mode-ssot.ts` is an enforced CI gate. Tools apply decisions, they never make them.
- **`src/tools/` may not import `@nathapp/nax-ai`.** `scripts/check-nax-ai-imports.ts` confines it to `src/agents/native/`.
- **A signal a later decision depends on is written to the audit records, not the logger.** Spec section 3.3.
- **File size gate:** `scripts/check-file-sizes.ts` runs on every commit with a baseline of 16 grandfathered files. Do not add a 17th — keep new files small.
- **Every commit runs the full pre-commit gate** (typecheck, biome, 23 check scripts). Run `bun run typecheck && bun run lint` before committing if unsure.
- **Never pipe the root test run through `tail`** — it is two turbo runs and the output matters.

---

### Task 1: The `GitCommit` tool

Stages named paths and commits them in one call. Separate from `gitTool` because `buildGitArgv` cannot express it: that builder appends `--` and then pathspecs, and refuses any element starting with `-`, so `commit -m <message>` is not representable in it by construction.

**Files:**
- Create: `src/tools/git-commit.ts`
- Modify: `src/tools/index.ts` (export), `src/tools/runtime.ts:55` (add to the builtin list), `src/tools/registry.ts` (add `"GitCommit"` to `RESERVED_TOOL_NAMES`), `src/tools/types.ts` (add `"GitCommit"` to `CodingToolName`)
- Test: `test/unit/tools/git-commit.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolResult`, `ToolRunContext` from `./registry`; `gitWithTimeout` from `@/utils/git`; `GIT_ESCAPE_FLAGS` from `./git`.
- Produces: `export const gitCommitTool: CodingTool`, and `export function buildCommitArgvs(input: Record<string, unknown>): { add: string[]; commit: string[] } | { error: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tools/git-commit.test.ts
import { describe, expect, test } from "bun:test";
import { buildCommitArgvs } from "@/tools/git-commit";
import { GIT_ESCAPE_FLAGS } from "@/tools/git";

describe("buildCommitArgvs", () => {
  test("stages the named paths and commits with the message", () => {
    const built = buildCommitArgvs({ message: "feat(US-1): thing", paths: ["src/a.ts"] });
    expect(built).toEqual({
      add: ["add", "--", "src/a.ts"],
      commit: ["commit", "-m", "feat(US-1): thing"],
    });
  });

  test("supports a multi-line body, which the implementer prompt requires", () => {
    const built = buildCommitArgvs({ message: "feat: x\n\nException (b): contract drift.", paths: ["a.ts"] });
    expect(built).toMatchObject({ commit: ["commit", "-m", "feat: x\n\nException (b): contract drift."] });
  });

  test("refuses a path that would parse as a flag", () => {
    expect(buildCommitArgvs({ message: "m", paths: ["--git-dir=/etc"] })).toEqual({
      error: 'path "--git-dir=/etc" may not begin with "-"',
    });
  });

  test("refuses an empty message rather than committing an empty subject", () => {
    expect(buildCommitArgvs({ message: "  ", paths: ["a.ts"] })).toEqual({ error: "message must be a non-empty string" });
  });

  test("requires at least one path -- it never stages the whole tree implicitly", () => {
    expect(buildCommitArgvs({ message: "m", paths: [] })).toEqual({ error: "paths must name at least one file" });
  });

  test("emits no escape flag in either argv", () => {
    const built = buildCommitArgvs({ message: "-c core.pager=id", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(built.add).not.toContain(flag);
      expect(built.commit).not.toContain(flag);
    }
  });

  test("a message that looks like a flag is still a message, never an argv element of its own", () => {
    const built = buildCommitArgvs({ message: "--work-tree=/etc", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    expect(built.commit).toEqual(["commit", "-m", "--work-tree=/etc"]);
    expect(built.commit.indexOf("--work-tree=/etc")).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/git-commit.test.ts`
Expected: FAIL — cannot resolve `@/tools/git-commit`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/tools/git-commit.ts
/**
 * Stage-and-commit, the one mutating git operation the implementer role needs.
 *
 * Separate from gitTool because buildGitArgv cannot express it: that builder
 * terminates with `--` and pathspecs and refuses any element beginning with
 * "-", so `commit -m <message>` is not representable in it. Splitting the tool
 * also lets a stage be granted the read verbs without the write one.
 *
 * The message is an argv ELEMENT, never parsed. A message that looks like a
 * flag is inert because it sits after `-m` in an argv array that never reaches
 * a shell -- a test pins that position.
 */
import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export function buildCommitArgvs(
  input: Record<string, unknown>,
): { add: string[]; commit: string[] } | { error: string } {
  const message = input.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { error: "message must be a non-empty string" };
  }
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (paths.length === 0) return { error: "paths must name at least one file" };

  const add: string[] = ["add", "--"];
  for (const path of paths) {
    if (typeof path !== "string") return { error: "paths must be strings" };
    if (path.startsWith("-")) return { error: `path "${path}" may not begin with "-"` };
    add.push(path);
  }
  return { add, commit: ["commit", "-m", message] };
}

export const gitCommitTool: CodingTool = {
  name: "GitCommit",
  description:
    "Stage the named files and commit them. Supply the message as text and the files as an array; this is not a command line.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message. May contain a blank line and a body." },
      paths: { type: "array", items: { type: "string" }, description: "Files to stage, relative to the repository root" },
    },
    required: ["message", "paths"],
  },
  scope: { pathFields: [], arrayPathFields: ["paths"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const built = buildCommitArgvs(input);
    if ("error" in built) return { content: built.error, isError: true };

    const staged = await gitWithTimeout(built.add, ctx.root, 30_000);
    if (staged.exitCode !== 0) {
      return { content: `git add failed: ${staged.stderr.trim() || `exit ${staged.exitCode}`}`, isError: true };
    }
    const committed = await gitWithTimeout(built.commit, ctx.root, 30_000);
    if (committed.exitCode !== 0) {
      return { content: `git commit failed: ${committed.stderr.trim() || `exit ${committed.exitCode}`}`, isError: true };
    }
    return { content: committed.stdout.trim().slice(0, ctx.maxBytes) };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/tools/git-commit.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Register it as a built-in and reserve the name**

In `src/tools/types.ts`, extend the union:

```typescript
export type CodingToolName = "Read" | "Glob" | "Grep" | "Write" | "Edit" | "Git" | "GitCommit";
```

In `src/tools/registry.ts`:

```typescript
export const RESERVED_TOOL_NAMES: readonly CodingToolName[] = [
  "Read", "Glob", "Grep", "Write", "Edit", "Git", "GitCommit",
];
```

In `src/tools/runtime.ts`, add `gitCommitTool` to the builtin loop (import it from `./git-commit`):

```typescript
  for (const tool of [readTool, globTool, grepTool, writeTool, editTool, gitTool, gitCommitTool]) {
```

In `src/tools/index.ts`:

```typescript
export { buildCommitArgvs, gitCommitTool } from "./git-commit";
```

- [ ] **Step 6: Verify it is registered and still not granted by default**

Add to `test/unit/tools/git-commit.test.ts`:

```typescript
import { _resetBuiltinsForTest, registerBuiltinCodingTools } from "@/tools/runtime";
import { _resetRegistryForTest, getCodingTool } from "@/tools/registry";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";

test("registers as a builtin", () => {
  _resetRegistryForTest();
  _resetBuiltinsForTest();
  registerBuiltinCodingTools();
  expect(getCodingTool("GitCommit")?.name).toBe("GitCommit");
});

test("is NOT in the default grant -- mutation is always explicit", () => {
  expect(DEFAULT_CODING_TOOLS).not.toContain("GitCommit");
});
```

Run: `bun test test/unit/tools/git-commit.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/tools/git-commit.ts src/tools/index.ts src/tools/runtime.ts src/tools/registry.ts src/tools/types.ts test/unit/tools/git-commit.test.ts
git commit -m "feat(tools): add GitCommit, the one mutating git operation the implementer needs"
```

---

### Task 2: The `RunCommand` tool

Executes only commands the project has already declared. The model names a key and fills declared placeholders; it never authors the command string.

**Files:**
- Create: `src/tools/run-command.ts`
- Modify: `src/tools/index.ts`, `src/tools/runtime.ts`, `src/tools/registry.ts`, `src/tools/types.ts` (same four registration points as Task 1)
- Test: `test/unit/tools/run-command.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolRunContext` from `./registry`; `runQualityCommand` and `QualityCommandResult` from `@/quality/runner`; `shellQuoteArg` from `@/verification/shell-quote`.
- Produces: `export function substituteCommand(template: string, values: Record<string, string>): string | { error: string }`, `export function createRunCommandTool(declared: ReadonlyMap<string, string>): CodingTool`.

**Design note:** the tool is created from a declared-command map rather than reading config itself, because `src/tools/` is transport- and config-neutral by design (`scripts/check-adapter-no-config-import.sh` enforces the same discipline one layer out). The map is resolved once and injected, mirroring how `ResolvedPermissions` already rides down pre-resolved.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tools/run-command.test.ts
import { describe, expect, test } from "bun:test";
import { substituteCommand } from "@/tools/run-command";

describe("substituteCommand", () => {
  test("substitutes a declared placeholder", () => {
    expect(substituteCommand("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test 'a.test.ts'");
  });

  test("quotes the substituted value so a metacharacter cannot escape", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a.ts; rm -rf /" });
    expect(out).toBe("bun test 'a.ts; rm -rf /'");
  });

  test("quotes an embedded single quote rather than closing the string", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a'; id; '.ts" });
    expect(out).toBe(`bun test 'a'\\''; id; '\\''.ts'`);
  });

  test("preserves an env-assignment prefix, which is why this is a shell string", () => {
    expect(substituteCommand("CI=1 bun test {{files}}", { files: "a.ts" })).toBe("CI=1 bun test 'a.ts'");
  });

  test("refuses a placeholder the template does not declare", () => {
    expect(substituteCommand("bun test {{files}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command',
    });
  });

  test("refuses when a declared placeholder is left unfilled", () => {
    expect(substituteCommand("bun test {{files}}", {})).toEqual({
      error: "placeholder {{files}} has no value",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/run-command.test.ts`
Expected: FAIL — cannot resolve `@/tools/run-command`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/tools/run-command.ts
/**
 * Runs a command the PROJECT declared, never one the model wrote.
 *
 * This reaches a shell, deliberately: src/quality/runner.ts executes every
 * configured command through one to preserve their quoting semantics, and a
 * declared command like "CI=1 bun test {{files}}" has no argv form -- CI=1 is a
 * shell assignment, not a binary. Building a second execution path would mean
 * the same command behaved differently depending on who invoked it.
 *
 * So the property here is narrower than the Git tool's, and is stated rather
 * than implied: the model does not author the command string. It names a
 * declared key and supplies placeholder values, and those values are the entire
 * injection surface. They are quoted with shellQuoteArg -- the same helper
 * command-resolver.ts already applies to {{package}}.
 */
import { runQualityCommand } from "@/quality/runner";
import { shellQuoteArg } from "@/verification/shell-quote";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

export function substituteCommand(
  template: string,
  values: Record<string, string>,
): string | { error: string } {
  const declared = new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) return { error: `value "${key}" is not a placeholder in this command` };
  }
  for (const key of declared) {
    if (values[key] === undefined) return { error: `placeholder {{${key}}} has no value` };
  }
  return template.replaceAll(PLACEHOLDER, (_m, key: string) => shellQuoteArg(values[key] as string));
}

export function createRunCommandTool(declared: ReadonlyMap<string, string>): CodingTool {
  const keys = [...declared.keys()];
  return {
    name: "RunCommand",
    description:
      `Run one of this project's declared commands: ${keys.join(", ")}. Supply values for its placeholders; you cannot write a command of your own.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: keys, description: "Which declared command to run" },
        values: { type: "object", description: "Values for the command's placeholders, e.g. { files: \"a.test.ts\" }" },
      },
      required: ["command"],
    },
    scope: { pathFields: [], verbField: "command", allowedVerbs: keys },

    async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
      const key = typeof input.command === "string" ? input.command : "";
      const template = declared.get(key);
      if (template === undefined) return { content: `unknown command "${key}"`, isError: true };

      const raw = (input.values ?? {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) values[k] = String(v);

      const command = substituteCommand(template, values);
      if (typeof command !== "string") return { content: command.error, isError: true };

      const result = await runQualityCommand({
        commandName: key,
        command,
        workdir: ctx.root,
        stripEnvVars: [],
      });
      const body = `exit ${result.exitCode}\n${result.output}`;
      return { content: body.slice(0, ctx.maxBytes), isError: !result.success };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/tools/run-command.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the escape test that actually attempts an escape**

The spec calls quoting the highest-severity defect this phase can ship, and requires a test that attempts the escape rather than asserting the helper was called. Add:

```typescript
import { createRunCommandTool } from "@/tools/run-command";

test("a metacharacter in a value cannot run a second command", async () => {
  const tool = createRunCommandTool(new Map([["echoFiles", "echo {{files}}"]]));
  const result = await tool.run(
    { command: "echoFiles", values: { files: "a.ts; echo PWNED" } },
    { root: process.cwd(), resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 },
  );
  expect(result.content).toContain("a.ts; echo PWNED");
  expect(result.content).not.toContain("PWNED\n");
  expect(result.content.match(/PWNED/g)?.length).toBe(1);
});
```

Run: `bun test test/unit/tools/run-command.test.ts`
Expected: PASS, 7 tests. If `PWNED` appears twice the quoting is broken and the tool must not ship.

- [ ] **Step 6: Reserve the name, but do NOT register the instance**

`RunCommand` is built from configuration, so it is **per-session**, while `src/tools/registry.ts` is a **process-global** `Map` (its own comment: "the registry is process-global, the runtime is per-session"). Registering a per-session instance globally is silently wrong rather than loudly wrong: `registerBuiltinCodingTools` guards with `if (getCodingTool(tool.name) === undefined)`, so a second session with a different config would keep the **first** session's command map forever, with no error.

So: add `"RunCommand"` to `CodingToolName` and to `RESERVED_TOOL_NAMES` (reserving the name prevents a third party shadowing it), but do **not** add it to the builtin instance loop in `runtime.ts`. Task 5 passes the instance in per session via `extraTools`.

Export the factory only:

```typescript
// src/tools/index.ts
export { createRunCommandTool, substituteCommand } from "./run-command";
```

Add `"RunCommand"` to `CodingToolName` and `RESERVED_TOOL_NAMES`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/run-command.ts src/tools/index.ts src/tools/registry.ts src/tools/types.ts test/unit/tools/run-command.test.ts
git commit -m "feat(tools): add RunCommand over the project's declared commands"
```

---

### Task 3: The `RequestCapability` tool

Grants nothing. Its only effect is that a want becomes a row.

**Files:**
- Create: `src/tools/request-capability.ts`
- Modify: `src/tools/index.ts`, `src/tools/runtime.ts`, `src/tools/registry.ts`, `src/tools/types.ts`
- Test: `test/unit/tools/request-capability.test.ts`

**Interfaces:**
- Produces: `export const requestCapabilityTool: CodingTool`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/request-capability.test.ts
import { expect, test } from "bun:test";
import { requestCapabilityTool } from "@/tools/request-capability";

const ctx = { root: "/tmp", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 };

test("records the want and refuses it", async () => {
  const result = await requestCapabilityTool.run({ capability: "bun install", reason: "module missing" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("bun install");
  expect(result.content).toContain("not available");
});

test("requires a capability string", async () => {
  const result = await requestCapabilityTool.run({ reason: "x" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("capability must be a non-empty string");
});

test("never runs anything -- reason is optional and free text", async () => {
  const result = await requestCapabilityTool.run({ capability: "rm -rf /" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("rm -rf /");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/request-capability.test.ts`
Expected: FAIL — cannot resolve `@/tools/request-capability`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/tools/request-capability.ts
/**
 * Declares a capability the model wanted and could not reach. Runs nothing.
 *
 * A denial is only produced if the model attempts a call, and a model told it
 * has no shell will not attempt one -- so the absence of denials would be
 * indistinguishable from the absence of need. Issue #1800 is the worked
 * example: a reviewer said in prose "I have no file/shell access tool in this
 * environment" and then returned a pass, and nothing structured captured it.
 *
 * The refusal is the point. The value is the row it leaves behind.
 */
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export const requestCapabilityTool: CodingTool = {
  name: "RequestCapability",
  description:
    "Declare a capability you need but do not have (for example a shell command you would have run). This grants nothing and runs nothing; it records the need so the tool set can be widened later.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string", description: "What you would have run or reached, verbatim" },
      reason: { type: "string", description: "Why you needed it, in one sentence" },
    },
    required: ["capability"],
  },
  scope: { pathFields: [] },

  async run(input: Record<string, unknown>, _ctx: ToolRunContext): Promise<ToolResult> {
    const capability = input.capability;
    if (typeof capability !== "string" || capability.trim() === "") {
      return { content: "capability must be a non-empty string", isError: true };
    }
    return {
      content: `Recorded: "${capability}" is not available on this path. Continue without it, or stop and say you cannot proceed.`,
      isError: true,
    };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/request-capability.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Register it as a builtin**

Apply the four registration edits (`CodingToolName`, `RESERVED_TOOL_NAMES`, the builtin loop in `runtime.ts`, `index.ts`) for `requestCapabilityTool`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/request-capability.ts src/tools/index.ts src/tools/runtime.ts src/tools/registry.ts src/tools/types.ts test/unit/tools/request-capability.test.ts
git commit -m "feat(tools): add RequestCapability so an unmet need becomes a row"
```

---

### Task 4: The tool-call audit sink

Every outcome persisted where a later decision can actually read it.

**Files:**
- Create: `src/tools/tool-audit.ts`
- Modify: `src/tools/runtime.ts` (the `log` function at ~line 84, and `createCodingToolRuntime`'s options)
- Test: `test/unit/tools/tool-audit.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export interface ToolCallRecord { tool: string; outcome: "ok" | "error" | "denied"; breach?: boolean; input: Record<string, unknown>; resultBytes: number; storyId?: string; at: string }`, `export interface ToolAuditSink { record(entry: ToolCallRecord): void; flush(): Promise<void> }`, `export function createToolAuditSink(opts: { dir: string; sessionName: string }): ToolAuditSink`, `export function createNoOpToolAuditSink(): ToolAuditSink`.

**Why this task exists:** `src/tools/runtime.ts` already logs every outcome, and its own comment explains why. But it logs through `getSafeLogger()`. Issue #1359 closed on a measured zero taken off exactly such a counter, while the persisted audit records still held ten in-window findings — the zero meant "no data retained" and was read as "did not happen". This sink is that lesson applied before the fact.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tools/tool-audit.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolAuditSink } from "@/tools/tool-audit";

describe("createToolAuditSink", () => {
  test("writes one file holding every recorded call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s1" });
    sink.record({ tool: "Read", outcome: "ok", input: { path: "a.ts" }, resultBytes: 10, at: "2026-09-03T00:00:00.000Z" });
    sink.record({ tool: "RequestCapability", outcome: "error", input: { capability: "bun install" }, resultBytes: 0, at: "2026-09-03T00:00:01.000Z" });
    await sink.flush();

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.sessionName).toBe("s1");
    expect(parsed.calls).toHaveLength(2);
    expect(parsed.calls[1].tool).toBe("RequestCapability");
    expect(parsed.calls[1].input.capability).toBe("bun install");
  });

  test("a denial is persisted, not only logged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s2" });
    sink.record({ tool: "Write", outcome: "denied", breach: true, input: { path: "/etc/passwd" }, resultBytes: 0, at: "2026-09-03T00:00:00.000Z" });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].outcome).toBe("denied");
    expect(parsed.calls[0].breach).toBe(true);
  });

  test("flushing with no calls writes nothing -- an empty file is not evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    await createToolAuditSink({ dir, sessionName: "s3" }).flush();
    expect(await readdir(dir)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/tool-audit.test.ts`
Expected: FAIL — cannot resolve `@/tools/tool-audit`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/tools/tool-audit.ts
/**
 * Durable record of every coding-tool call.
 *
 * runtime.ts already logs each outcome, and says why: a refused call that
 * leaves no trace is indistinguishable from a call never made. But it logs
 * through getSafeLogger(), and issue #1359 closed on a measured zero taken off
 * exactly such a counter while the persisted records still held ten in-window
 * findings. The zero meant "no data retained" and was read as "did not happen".
 *
 * So a signal a later decision depends on is written here, not there. The
 * logger keeps its calls for operator visibility; neither replaces the other.
 *
 * File shape mirrors src/review/review-audit.ts: one JSON file per session,
 * named <epochMs>-<sessionName>.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ToolCallRecord {
  readonly tool: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly breach?: boolean;
  readonly input: Record<string, unknown>;
  readonly resultBytes: number;
  readonly storyId?: string;
  readonly at: string;
}

export interface ToolAuditSink {
  record(entry: ToolCallRecord): void;
  flush(): Promise<void>;
}

export function createNoOpToolAuditSink(): ToolAuditSink {
  return { record() {}, async flush() {} };
}

export function createToolAuditSink(opts: { dir: string; sessionName: string }): ToolAuditSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push(entry);
    },
    async flush() {
      if (calls.length === 0) return;
      await mkdir(opts.dir, { recursive: true });
      const body = JSON.stringify({ sessionName: opts.sessionName, calls }, null, 2);
      await writeFile(join(opts.dir, `${Date.now()}-${opts.sessionName}.json`), body);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/tools/tool-audit.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the sink into the runtime's existing log seam**

In `src/tools/runtime.ts`, add `sink` to the options and record alongside every `log(...)` call. The `log` helper already receives tool, outcome and byte count; extend it to take the input too:

```typescript
export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  storyId?: string;
  sink?: ToolAuditSink;
}): CodingToolRuntime {
  const sink = opts.sink ?? createNoOpToolAuditSink();
  // ...
  function log(
    tool: string,
    outcome: CodingToolOutcome["kind"],
    resultBytes: number,
    input: Record<string, unknown>,
    breach?: boolean,
  ): void {
    _codingToolDeps.getLogger()?.info("coding-tool", "invoked", {
      storyId: opts.storyId, tool, outcome, resultBytes,
    });
    sink.record({
      tool, outcome, breach, input, resultBytes,
      storyId: opts.storyId, at: new Date().toISOString(),
    });
  }
```

Update every existing `log(...)` call site in `callTool` to pass `input` (and `verdict.breach` at the denial site).

- [ ] **Step 6: Prove the runtime records a denial**

Add to `test/unit/tools/tool-audit.test.ts`:

```typescript
import { compileToolPolicy } from "@/tools/policy";
import { createCodingToolRuntime } from "@/tools/runtime";

test("the runtime records a denial through the sink, not only the logger", async () => {
  const recorded: unknown[] = [];
  const sink = { record: (e: unknown) => recorded.push(e), flush: async () => {} };
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], process.cwd()),
    sink,
  });
  await runtime.callTool("GitCommit", { message: "m", paths: ["a.ts"] });
  expect(recorded).toHaveLength(1);
  expect((recorded[0] as { outcome: string }).outcome).toBe("denied");
  expect((recorded[0] as { tool: string }).tool).toBe("GitCommit");
});
```

Run: `bun test test/unit/tools/tool-audit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/tools/tool-audit.ts src/tools/runtime.ts src/tools/index.ts test/unit/tools/tool-audit.test.ts
git commit -m "feat(tools): persist every tool outcome to an audit record, not just the logger"
```

---

### Task 5: Build the producer, and prove it is on the live path

**This task exists because of a defect C1 shipped and had to fix twice.** A field was added, an op declared it, the loop dispatched it — and nothing ever constructed the runtime, so every coding tool silently did not exist while all per-task reviews passed, because each task was correct in isolation. The same shape appeared in Phase B with `transcriptDir`. A task that adds a capability must also add its producer, and a step must verify the producer is reached.

**Read `src/agents/coding-tool-support.ts` in full before starting.** It is under 90 lines and the two functions in it are not interchangeable:

- `buildCodingToolSupport({ root?, grants?, declared, storyId? })` — takes **no config**. Do not add one; the grants are already resolved by the time they reach it.
- `resolveCodingToolSupport(options)` — has `options.config`, and its own comment names it "the single entry point both dispatch hops use", precisely so a tool wired into one hop and not the other cannot go unnoticed.

The declared-command map is therefore built in `resolveCodingToolSupport` and passed down.

**Files:**
- Modify: `src/tools/runtime.ts` (accept `extraTools`), `src/agents/coding-tool-support.ts` (build the map, the sink, and widen `CodingToolSupport`), `src/runtime/session-run-hop.ts:63` and `src/operations/build-hop-callback.ts:293` (flush the sink), `src/config/permissions.ts` (grants), `src/operations/types.ts` (op `tools` declarations)
- Test: `test/unit/agents/coding-tool-support.test.ts`

**Interfaces:**
- Consumes: `createRunCommandTool` (Task 2), `createToolAuditSink` / `ToolAuditSink` (Task 4), `gitCommitTool` (Task 1), `requestCapabilityTool` (Task 3).
- Produces: `CodingToolSupport` gains `readonly auditSink: ToolAuditSink`. `createCodingToolRuntime` gains `extraTools?: readonly CodingTool[]`.

- [ ] **Step 1: Let the runtime carry session-local tools**

The global registry cannot hold `RunCommand` (Task 2 Step 6). Give the runtime a session-local layer consulted **before** the registry, in `src/tools/runtime.ts`:

```typescript
export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  storyId?: string;
  sink?: ToolAuditSink;
  extraTools?: readonly CodingTool[];
}): CodingToolRuntime {
  registerBuiltinCodingTools();
  const extra = new Map((opts.extraTools ?? []).map((t) => [t.name, t]));
  const lookup = (name: string): CodingTool | undefined => extra.get(name) ?? getCodingTool(name);
```

Replace both `getCodingTool(name)` calls in `advertised` and `callTool` with `lookup(name)`.

- [ ] **Step 2: Write the failing test**

```typescript
// test/unit/agents/coding-tool-support.test.ts
import { expect, test } from "bun:test";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

const grants = [{ tool: "RunCommand", patterns: ["*"] }, { tool: "GitCommit", patterns: ["*"] }];

test("advertises a RunCommand built from the declared commands", () => {
  const support = buildCodingToolSupport({
    root: process.cwd(),
    grants,
    declared: ["RunCommand"],
    declaredCommands: new Map([["test", "bun run test"]]),
  });
  expect(support?.tools.map((t) => t.name)).toContain("RunCommand");
});

test("omits RunCommand when the project declares no commands", () => {
  const support = buildCodingToolSupport({
    root: process.cwd(),
    grants,
    declared: ["RunCommand"],
    declaredCommands: new Map(),
  });
  expect(support).toBeUndefined();
});

test("exposes an audit sink so calls can be persisted", () => {
  const support = buildCodingToolSupport({
    root: process.cwd(),
    grants,
    declared: ["GitCommit"],
    declaredCommands: new Map(),
    auditDir: "/tmp/c2-audit-test",
    sessionName: "s1",
  });
  expect(support?.auditSink).toBeDefined();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support.test.ts`
Expected: FAIL — `buildCodingToolSupport` does not accept `declaredCommands`.

- [ ] **Step 4: Widen `buildCodingToolSupport`**

Add `declaredCommands: ReadonlyMap<string, string>`, `auditDir?: string` and `sessionName?: string` to its argument object. Build the sink (`createToolAuditSink` when `auditDir` is given, else `createNoOpToolAuditSink`), build `extraTools` as `declaredCommands.size > 0 ? [createRunCommandTool(declaredCommands)] : []`, pass both into `createCodingToolRuntime`, and return `{ runtime, tools, auditSink }`.

Keep the existing early returns: `declared.length === 0`, `grants.length === 0`, the empty-root `NaxError`, and `tools.length === 0` all still return `undefined`.

- [ ] **Step 5: Supply the map from config in `resolveCodingToolSupport`**

This is the only function with `options.config`. Build the map from `options.config?.quality?.commands`, keeping string values only:

```typescript
const commands = options.config?.quality?.commands ?? {};
const declaredCommands = new Map(
  Object.entries(commands).filter((e): e is [string, string] => typeof e[1] === "string"),
);
```

Pass it, plus `auditDir` and `sessionName`, into `buildCodingToolSupport`. Derive `auditDir` through `src/config/paths.ts` rather than open-coding a `.nax/` path — `scripts/check-feature-dir-ssot.ts` and `scripts/check-no-real-global-nax.ts` are both enforced gates. If no suitable helper exists, add one there.

- [ ] **Step 6: Flush the sink at both hops**

A sink that is never flushed writes nothing, and that failure is silent — the same shape as the producer bug this task exists to prevent. There are exactly two call sites:

- `src/operations/build-hop-callback.ts:293`
- `src/runtime/session-run-hop.ts:63`

Both already hold `codingSupport`. After the dispatch completes at each site, `await codingSupport.auditSink.flush()`. Use `try/finally` so a failed dispatch still writes its ledger — a run that fails is exactly the run whose ledger matters most.

- [ ] **Step 7: Grant the new tools**

In `src/config/permissions.ts`, the `unrestricted` branch grants `[...DEFAULT_CODING_TOOLS, "Write", "Edit", "Git"]`. Extend it with `"GitCommit"`, `"RunCommand"` and `"RequestCapability"`. Do **not** touch `DEFAULT_CODING_TOOLS` itself — spec section 4.

- [ ] **Step 8: Declare the tools on the implement op**

In `src/operations/types.ts`, add to the implement operation's `tools` array: `"Read"`, `"Glob"`, `"Grep"`, `"Write"`, `"Edit"`, `"RunCommand"`, `"GitCommit"`, `"RequestCapability"`. Advertised is the intersection with policy, so this cannot widen anything policy denies.

- [ ] **Step 9: Verify the producer is reached, and the sink is flushed — grep, do not assume**

```bash
grep -rn "createRunCommandTool\|createToolAuditSink" src/ | grep -v "^src/tools/"
grep -rn "auditSink.flush" src/
```

Expected: the first finds both in `src/agents/coding-tool-support.ts`; the second finds **two** hits, one per hop. **If either grep comes up short this task is not done** — that is exactly the C1 defect, and a passing unit test will not catch it.

- [ ] **Step 10: Run the tests**

Run: `bun test test/unit/agents/coding-tool-support.test.ts test/unit/tools/`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/tools/runtime.ts src/agents/coding-tool-support.ts src/runtime/session-run-hop.ts src/operations/build-hop-callback.ts src/config/permissions.ts src/operations/types.ts test/unit/agents/coding-tool-support.test.ts
git commit -m "feat(agents): construct RunCommand and the audit sink on both dispatch hops"
```

---

### Task 6: Live probe and the fixture run

Compiling proves the parts typecheck. Only an end-to-end trace proves the loop runs — the C1 and Phase B lesson, applied.

**Files:**
- Create: `scripts/probe-c2-story-loop.ts`
- Test: exercised by running it, not by a unit test.

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Write the probe**

Model it on `scripts/probe-native-coding-tools.ts`. It must, against a scratch git repository:

1. Build a policy granting `Read`, `Write`, `Edit`, `RunCommand`, `GitCommit`, `RequestCapability`.
2. Construct a runtime with a real audit sink pointed at a temp directory.
3. Call `RunCommand` with a declared `test` command, `GitCommit` with a message and one path, and `RequestCapability` with `"bun install"`.
4. Flush the sink and print the resulting JSON.

- [ ] **Step 2: Run the probe**

Run: `bun run scripts/probe-c2-story-loop.ts`
Expected: a JSON document containing three calls — one `ok` or `error` from `RunCommand`, one `ok` from `GitCommit` (verify with `git log -1` in the scratch repo), and one `error` from `RequestCapability` carrying `"bun install"`.

- [ ] **Step 3: Run the fixture story**

Run a native implement story against the `tdd-calc` fixture, not a live repository.

Per spec section 5, success is:

1. the story reaches a commit unaided, and
2. `.nax/tool-audit/` holds a non-empty, readable ledger attributable to the story.

**A run that fails to complete but produces a well-formed ledger satisfies this phase.** Do not substitute a completion rate for this criterion.

- [ ] **Step 4: Record the ledger's verdict**

Summarise, from the ledger: which tools were called, how often, and every `RequestCapability` row. That summary is C2's actual deliverable and the input to the section 8 exit criterion — whether a native run needs a shell at all.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-c2-story-loop.ts
git commit -m "test(tools): end-to-end probe for the C2 story loop and its ledger"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| 3.1 Git write verbs | Task 1 |
| 3.2 `RunCommand`, declared commands, quoting | Task 2 |
| 3.3 The instrument (audit records, not logger) | Task 4 |
| 3.4 `RequestCapability` | Task 3 |
| 3.5 Out of scope (Bash, sandbox, network) | No task, by design — nothing here introduces them |
| 4 Restrictive-first posture | Task 5 Steps 4-5 (`DEFAULT_CODING_TOOLS` untouched; explicit grant plus explicit declaration) |
| 5 Validation on the fixture | Task 6 |
| 7 Quoting risk needs an escape-attempting test | Task 2 Step 5 |
| 8 Exit criterion | Task 6 Step 4 |

**Placeholder scan:** no TBD/TODO, and no "similar to Task N". Task 5 Steps 4, 5 and 7 describe edits in prose against named files, named symbols and named CI gates rather than showing a full diff, because each modifies an existing function whose surrounding shape must be read first — Step 1 instructs exactly that, and the signatures those steps must match are quoted in the task preamble rather than guessed at.

**Type consistency:** `ToolAuditSink`/`ToolCallRecord` (Task 4) are used unchanged in Tasks 5 and 6. `createRunCommandTool(declared: ReadonlyMap<string, string>)` (Task 2) is called with a map built in Task 5. `buildCommitArgvs` returns `{ add, commit } | { error }` and every caller narrows on `"error" in built`. `CodingToolName` gains exactly three members across Tasks 1-3, and each task adds it to `RESERVED_TOOL_NAMES` in the same step.

**Known gaps, flagged rather than hidden:**

1. `RunCommand` is per-session but `src/tools/registry.ts` is process-global, and registering a per-session instance there fails *silently* (the builtin loop guards on absence, so session two would inherit session one's command map). Task 2 Step 6 reserves the name only; Task 5 Step 1 adds the `extraTools` layer. If those two tasks go to different workers, this is the hand-off most likely to break.
2. The audit sink is useless unless flushed, and nothing type-checks that it was. Task 5 Step 6 flushes at both hops and Step 9 greps for two hits, because a unit test on `buildCodingToolSupport` passes whether or not any caller flushes.
3. Task 5 Step 5 must derive `auditDir` through `src/config/paths.ts`; two enforced CI gates reject an open-coded `.nax/` path, and the helper may need to be added there first.
