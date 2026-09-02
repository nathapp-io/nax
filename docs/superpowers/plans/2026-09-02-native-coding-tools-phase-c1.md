# Phase C1 — Native Filesystem Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let nax execute filesystem tools in-process for ops on the native transport, gated by a compiled permission policy that cannot be widened past a single root.

**Architecture:** `resolvePermissions` grows to return declarative grants; `src/tools/` compiles those into a policy, enforces it, and executes six tools; `src/agents/` routes coding-tool calls over a new interaction kind so a denial stays distinguishable from an error. Nothing new is wired end to end — the managers already resolve permissions and pass them down pre-resolved, and the policy rides that existing rail.

**Tech Stack:** TypeScript, Bun (test runner and `Bun.spawn`/`Bun.which` via `src/utils/bun-deps.ts`), Zod (config schema), `@nathapp/nax-ai` (tool definitions, native tree only), biome (format and lint).

**Spec:** `docs/superpowers/specs/2026-09-02-native-coding-tools-phase-c1-design.md` — read it before Task 1. This plan argues from it.

## Global Constraints

- **No `Bash`.** Not in any task. ADR-029 section 3 severs it; C1 does not take it on.
- **The root is a hard boundary no permission profile can widen.** `unrestricted` means "any tool, any path within the root", never "any path on the machine". Every containment test asserts this.
- **Single root only.** No `/tmp`, no scratch directory, no `roots[]` field. Containment stays behind one `resolveWithin(root, path)` seam so multi-root remains a future additive change.
- **`@nathapp/nax-ai` may be imported only under `src/agents/native/`** — enforced by `check:nax-ai-imports`. `src/tools/` must not import it.
- **Every permission *decision* lives in `src/config/permissions.ts`** — enforced by `check:permission-mode-ssot`. Code that *applies* a resolved decision carries the comment marker `nax-permission-mode-allow: <reason>`.
- **Spawning tools take a nax-constructed argv, never a shell string.** No `;`, `|`, `$()` can reach a shell because no shell is invoked.
- **Files stay in the 200-400 line norm** — `check:file-sizes` refuses growth of already-oversized files.
- **Run `bun x biome check --write <files>` before every commit.** Plan code blocks are correct TypeScript but not biome-formatted (it reflows multi-line calls and sorts imports).
- **Full gate before any push:** `bun run typecheck && bun run lint && bun run test`.
- **Commit style:** conventional commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`).
- **This repository is public.** No absolute user paths (`/Users/<name>/...`) and no private repository names in any committed file, including test fixtures.

---

## File Structure

**Created — `src/tools/` (transport-neutral; imports no nax-ai):**

| File | Responsibility |
|---|---|
| `types.ts` | `CodingToolName`, `ToolGrant`, `ToolScope`, `PolicyVerdict`, `ToolResult`, `CodingTool` |
| `policy.ts` | Compile grants to matchers; `resolveWithin` containment; per-call `check` |
| `registry.ts` | Name to tool; reserved built-in names; third-party registration |
| `read.ts` `glob.ts` `grep.ts` `write.ts` `edit.ts` `git.ts` | One tool each |
| `runtime.ts` | `CodingToolRuntime` — pairs policy with registry, yields ok/error/denied |
| `index.ts` | Barrel (required by `check:alias-internals` — `@/tools` must point here) |

**Created — `src/agents/run-interaction-handler.ts`:** `buildRunInteractionHandler`, relocated out of the ACP tree, plus the coding-tool branch.

**Created — `src/agents/coding-tool-support.ts`:** builds a live runtime from resolved grants plus an op's declaration. One small function with one caller, so "nothing ever supplied it" stays a visible question rather than a silent absence.

**Created — `scripts/probe-native-coding-tools.ts`:** live proof the gate refuses a write outside the root.

**Modified:**

| File | Change |
|---|---|
| `src/config/permissions.ts` | `ResolvedPermissions` gains `toolGrants`; `resolveScopedPermissions` becomes real |
| `src/config/schemas-execution.ts` | `execution.permissions` block schema (schema.ts is a barrel) |
| `src/config/loader.ts`, `src/config/config-guards.ts` | Both unimplemented-guards removed (Task 13, last) |
| `src/agents/interaction-handler.ts` | Third `AdapterInteraction` member; denial field on the response |
| `src/agents/acp/adapter-output.ts` | `buildRunInteractionHandler` removed (moved out) |
| `src/operations/types.ts` | `RunOperation.tools` |
| `src/agents/native/session/tool-mapping.ts` | Map coding tools to nax-ai `ToolDefinition` |
| `src/agents/native/session/turn-loop.ts` | Dispatch the coding-tool kind; render three outcomes |
| `src/session/manager-run.ts` | Construct the runtime and thread it onto the request |
| `docs/specs/scoped-permissions.md` | Section 2.3 amended: delegation is no longer the only model |

**Task order is safety-relevant.** The config guards that currently reject `permissionProfile: "scoped"` come out in **Task 13, last**. Removing them earlier opens a window where a config declares `scoped` while nothing enforces it — silently weaker permissions than asked for, the exact failure those guards exist to prevent. Tasks 1-12 test the resolver directly instead.

---

### Task 1: Policy core — containment and pattern matching

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/policy.ts`
- Create: `src/tools/index.ts`
- Test: `test/unit/tools/policy.test.ts`

**Interfaces:**
- Consumes: `realOrRaw`, `isInside` from `src/utils/realpath.ts` (existing).
- Produces: `type CodingToolName`; `interface ToolGrant { tool: string; patterns: readonly string[] }`; `interface ToolScope { pathFields: readonly string[]; verbField?: string; allowedVerbs?: readonly string[] }`; `type PolicyVerdict`; `interface ToolPolicy { root: string; grantedTools(): readonly string[]; check(tool, scope, input): PolicyVerdict }`; `function compileToolPolicy(grants: readonly ToolGrant[], root: string): ToolPolicy`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/policy.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools";
import type { ToolScope } from "@/tools";

const PATH_SCOPE: ToolScope = { pathFields: ["path"] };
let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "nax-policy-"));
  root = join(base, "repo");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "no");
  symlinkSync(outside, join(root, "escape-link"));
});

describe("compileToolPolicy — patterns", () => {
  test("allows a path matching the grant's glob", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: "src/a.ts" });
    expect(verdict.allowed).toBe(true);
  });

  test("denies a path outside the grant's glob", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: "test/a.ts" });
    expect(verdict.allowed).toBe(false);
  });

  test("denies a tool with no grant at all", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: "src/a.ts" }).allowed).toBe(false);
  });

  test("a bare '*' grant allows any path inside the root", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    expect(policy.check("Read", PATH_SCOPE, { path: "test/deep/x.ts" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — containment is the hard boundary", () => {
  // The design's central safety claim. If this block is ever deleted to make
  // something pass, unrestricted silently means the whole filesystem.
  test("unrestricted-equivalent grants STILL deny outside the root", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], root);
    const verdict = policy.check("Write", PATH_SCOPE, { path: join(outside, "secret.txt") });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("denies '..' traversal", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const verdict = policy.check("Read", PATH_SCOPE, { path: "../elsewhere/secret.txt" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("denies a symlink pointing outside the root", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root);
    const verdict = policy.check("Read", PATH_SCOPE, { path: "escape-link/secret.txt" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("a breach is distinguishable from an ordinary pattern denial", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    const denial = policy.check("Write", PATH_SCOPE, { path: "test/a.ts" });
    expect(denial.allowed).toBe(false);
    if (!denial.allowed) expect(denial.breach).toBe(false);
  });

  test("allows a path that does not exist yet, inside the root", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["src/**"] }], root);
    expect(policy.check("Write", PATH_SCOPE, { path: "src/not/created/yet.ts" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — tool-level gating", () => {
  const VERB_SCOPE: ToolScope = {
    pathFields: [],
    verbField: "subcommand",
    allowedVerbs: ["diff", "log", "show", "status", "blame"],
  };

  test("allows a granted verb", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["diff", "log"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "diff" }).allowed).toBe(true);
  });

  test("denies a verb the grant omits", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["diff", "log"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "blame" }).allowed).toBe(false);
  });

  test("denies a verb outside the tool's own allowedVerbs even when granted '*'", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root);
    expect(policy.check("Git", VERB_SCOPE, { subcommand: "push" }).allowed).toBe(false);
  });

  test("grantedTools lists the tools carrying a grant", () => {
    const policy = compileToolPolicy(
      [{ tool: "Read", patterns: ["*"] }, { tool: "Git", patterns: ["diff"] }],
      root,
    );
    expect([...policy.grantedTools()].sort()).toEqual(["Git", "Read"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/policy.test.ts`
Expected: FAIL — `Cannot find module '@/tools'`.

- [ ] **Step 3: Write the types**

Create `src/tools/types.ts`:

```typescript
/**
 * Shared vocabulary for nax's own coding tools.
 *
 * Deliberately free of any transport type: this module is imported by the
 * policy, the tools and the runtime, none of which may see `@nathapp/nax-ai`
 * (check:nax-ai-imports confines that package to src/agents/native/).
 */

/** The tools nax ships. Third parties register additional names at runtime. */
export type CodingToolName = "Read" | "Glob" | "Grep" | "Write" | "Edit" | "Git";

/**
 * One declarative permission grant, as produced by resolvePermissions.
 *
 * `patterns` is either globs over the tool's path-bearing fields
 * (`["src/**"]`), or the verb list for a verb-gated tool (`["diff","log"]`).
 * `["*"]` means unconditional — but never wider than the root.
 */
export interface ToolGrant {
  readonly tool: string;
  readonly patterns: readonly string[];
}

/**
 * How the policy gates a given tool, declared by the tool itself.
 *
 * Declaring the path-bearing fields is what lets the policy gate a tool it has
 * no special knowledge of, including one registered by a third party. A tool
 * with no path fields is gated at the tool/verb level instead — the honest
 * expression for something whose arguments are not paths.
 */
export interface ToolScope {
  readonly pathFields: readonly string[];
  readonly verbField?: string;
  readonly allowedVerbs?: readonly string[];
}

/**
 * `breach` separates "you may not write there" from "that path is not in this
 * repository at all". Both deny; only the latter is logged at warn, because a
 * path escaping the root can mean prompt injection.
 */
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | { readonly allowed: false; readonly reason: string; readonly breach: boolean };

export interface ToolPolicy {
  readonly root: string;
  grantedTools(): readonly string[];
  check(tool: string, scope: ToolScope, input: Record<string, unknown>): PolicyVerdict;
}
```

- [ ] **Step 4: Write the policy**

Create `src/tools/policy.ts`:

```typescript
/**
 * Compile declarative grants into a policy, and answer one call at a time.
 *
 * nax-permission-mode-allow: applies grants resolved by resolvePermissions;
 * decides no permission of its own.
 *
 * Containment runs BEFORE pattern matching and is not expressible in config:
 * the root is a hard boundary no profile can widen. `unrestricted` means "any
 * tool, any path within the root", never "any path on the machine".
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { isInside, realOrRaw } from "@/utils/realpath";
import type { PolicyVerdict, ToolGrant, ToolPolicy, ToolScope } from "./types";

/**
 * Absolute, symlink-resolved form of `candidate` if it lies inside `root`.
 *
 * The single containment seam. Multi-root support (a future configurable
 * extension) changes this function and nothing else, which is why every tool
 * receives an already-resolved path rather than resolving one itself.
 */
export function resolveWithin(root: string, candidate: string): string | null {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (!isInside(root, absolute)) return null;
  return realOrRaw(absolute);
}

/** Minimatch-style glob to RegExp: `**` spans separators, `*` does not. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((re) => re.test(value));
}

export function compileToolPolicy(grants: readonly ToolGrant[], root: string): ToolPolicy {
  const resolvedRoot = realOrRaw(root);
  const compiled = new Map<string, { unconditional: boolean; matchers: RegExp[]; raw: readonly string[] }>();

  for (const grant of grants) {
    const unconditional = grant.patterns.includes("*");
    compiled.set(grant.tool, {
      unconditional,
      matchers: grant.patterns.filter((p) => p !== "*").map(globToRegExp),
      raw: grant.patterns,
    });
  }

  function deny(reason: string, breach = false): PolicyVerdict {
    return { allowed: false, reason, breach };
  }

  return {
    root: resolvedRoot,

    grantedTools() {
      return [...compiled.keys()];
    },

    check(tool, scope, input) {
      const grant = compiled.get(tool);
      if (grant === undefined) return deny(`tool "${tool}" is not permitted for this stage`);

      // Verb gating: the tool's own allowedVerbs bound what config can grant,
      // so a "*" grant can never reach a mutating subcommand.
      if (scope.verbField !== undefined) {
        const verb = input[scope.verbField];
        if (typeof verb !== "string") return deny(`"${scope.verbField}" must be a string`);
        if (scope.allowedVerbs !== undefined && !scope.allowedVerbs.includes(verb)) {
          return deny(`"${verb}" is not a permitted ${tool} subcommand`);
        }
        if (!grant.unconditional && !grant.raw.includes(verb)) {
          return deny(`${tool} is not granted the "${verb}" subcommand for this stage`);
        }
      }

      const resolvedPaths: string[] = [];
      for (const field of scope.pathFields) {
        const value = input[field];
        if (value === undefined) continue;
        if (typeof value !== "string") return deny(`"${field}" must be a string path`);

        const resolved = resolveWithin(resolvedRoot, value);
        if (resolved === null) {
          return deny(`path "${value}" resolves outside the permitted root`, true);
        }

        if (!grant.unconditional) {
          const rel = relative(resolvedRoot, resolved).split(sep).join("/");
          if (!matchesAny(grant.matchers, rel)) {
            return deny(`${tool} is not granted "${rel}" for this stage`);
          }
        }
        resolvedPaths.push(resolved);
      }

      return { allowed: true, resolvedPaths };
    },
  };
}
```

Create `src/tools/index.ts`:

```typescript
export { compileToolPolicy, resolveWithin } from "./policy";
export type { CodingToolName, PolicyVerdict, ToolGrant, ToolPolicy, ToolScope } from "./types";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/tools/policy.test.ts`
Expected: PASS, 15 tests.

If the `globToRegExp` loop has a stray token from transcription, `bun x tsc --noEmit` reports it — fix and re-run.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): compile permission grants into a root-bounded policy"
```

---

### Task 2: Tool registry with declared scope

**Files:**
- Create: `src/tools/registry.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/registry.test.ts`

**Interfaces:**
- Consumes: `ToolScope`, `CodingToolName` from Task 1.
- Produces: `interface ToolResult { content: string; isError?: boolean }`; `interface CodingTool { name: string; description: string; inputSchema: JSONSchema; scope: ToolScope; run(input, ctx: ToolRunContext): Promise<ToolResult> }`; `interface ToolRunContext { root: string; resolvedPaths: readonly string[]; maxBytes: number }`; `function registerCodingTool(tool: CodingTool): void`; `function getCodingTool(name: string): CodingTool | undefined`; `function listCodingTools(): readonly CodingTool[]`; `const RESERVED_TOOL_NAMES: readonly string[]`; `function _resetRegistryForTest(): void`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/registry.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import type { CodingTool } from "@/tools";
import { _resetRegistryForTest, getCodingTool, listCodingTools, registerCodingTool } from "@/tools";

function fakeTool(name: string): CodingTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    async run() {
      return { content: "ok" };
    },
  };
}

afterEach(() => {
  _resetRegistryForTest();
});

describe("coding tool registry", () => {
  test("registers and retrieves a third-party tool", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(getCodingTool("Fetch")?.name).toBe("Fetch");
  });

  test("lists registered tools", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(listCodingTools().map((t) => t.name)).toContain("Fetch");
  });

  test("returns undefined for an unknown name", () => {
    expect(getCodingTool("Nope")).toBeUndefined();
  });

  // A registered "Write" would shadow the gated implementation: privilege
  // escalation. It must fail at registration, not at call time.
  test("refuses to shadow a reserved built-in name", () => {
    expect(() => registerCodingTool(fakeTool("Write"))).toThrow(/reserved/i);
  });

  test("refuses a duplicate registration", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(() => registerCodingTool(fakeTool("Fetch"))).toThrow(/already registered/i);
  });

  test("refuses a tool declaring a verb field with no allowedVerbs", () => {
    const bad = { ...fakeTool("Verby"), scope: { pathFields: [], verbField: "cmd" } };
    expect(() => registerCodingTool(bad)).toThrow(/allowedVerbs/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/registry.test.ts`
Expected: FAIL — `registerCodingTool` is not exported.

- [ ] **Step 3: Write the registry**

Create `src/tools/registry.ts`:

```typescript
/**
 * Name-to-tool registry, mirroring PULL_TOOL_REGISTRY in the context engine.
 *
 * Open to third-party registration, with two rules that make that safe:
 * built-in names are reserved (a registered "Write" would shadow the gated
 * implementation), and a verb-gated tool must declare the verbs it permits so
 * the policy can never be granted a subcommand the tool itself disallows.
 *
 * Registration is in-process — another nax module or plugin. This is an
 * extension point, not a plugin download path.
 */

import { NaxError } from "@/errors";
import type { JSONSchema } from "@/context/engine";
import type { CodingToolName, ToolScope } from "./types";

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolRunContext {
  /** Absolute, symlink-resolved permitted root. */
  readonly root: string;
  /** Paths the policy already resolved and approved, in pathFields order. */
  readonly resolvedPaths: readonly string[];
  /** Output ceiling in bytes; the tool truncates rather than the caller. */
  readonly maxBytes: number;
}

export interface CodingTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly scope: ToolScope;
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>;
}

/** Built-in names may never be re-registered. */
export const RESERVED_TOOL_NAMES: readonly CodingToolName[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Git",
];

const registry = new Map<string, CodingTool>();

export function registerCodingTool(tool: CodingTool): void {
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(tool.name) && !internalRegistration) {
    throw new NaxError(
      `Tool name "${tool.name}" is reserved for a nax built-in and cannot be re-registered.`,
      "TOOL_NAME_RESERVED",
      { stage: "tools", tool: tool.name },
    );
  }
  if (registry.has(tool.name)) {
    throw new NaxError(`Tool "${tool.name}" is already registered.`, "TOOL_ALREADY_REGISTERED", {
      stage: "tools",
      tool: tool.name,
    });
  }
  if (tool.scope.verbField !== undefined && tool.scope.allowedVerbs === undefined) {
    throw new NaxError(
      `Tool "${tool.name}" declares verbField but no allowedVerbs; the policy would have no bound to enforce.`,
      "TOOL_SCOPE_INCOMPLETE",
      { stage: "tools", tool: tool.name },
    );
  }
  registry.set(tool.name, tool);
}

let internalRegistration = false;

/** Register a nax built-in, bypassing the reserved-name check by design. */
export function registerBuiltinTool(tool: CodingTool): void {
  internalRegistration = true;
  try {
    registerCodingTool(tool);
  } finally {
    internalRegistration = false;
  }
}

export function getCodingTool(name: string): CodingTool | undefined {
  return registry.get(name);
}

export function listCodingTools(): readonly CodingTool[] {
  return [...registry.values()];
}

/** @internal Test-only: clears registrations between cases. */
export function _resetRegistryForTest(): void {
  registry.clear();
}
```

Append to `src/tools/index.ts`:

```typescript
export {
  _resetRegistryForTest,
  getCodingTool,
  listCodingTools,
  registerBuiltinTool,
  registerCodingTool,
  RESERVED_TOOL_NAMES,
} from "./registry";
export type { CodingTool, ToolResult, ToolRunContext } from "./registry";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/tools/registry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): open tool registry with reserved built-in names"
```

---

### Task 3: Permission resolver returns grants

**Files:**
- Modify: `src/config/permissions.ts`
- Modify: `src/config/schemas-execution.ts` (add `execution.permissions`)
- Test: `test/unit/config/scoped-permissions.test.ts`

**Interfaces:**
- Consumes: `ToolGrant` from Task 1.
- Produces: `ResolvedPermissions` gains `toolGrants?: readonly ToolGrant[]`; `const DEFAULT_CODING_TOOLS: readonly CodingToolName[]`; `resolveScopedPermissions` returns real grants.

**The loader guards stay in place for now.** They are removed in Task 13, once enforcement is proven. Until then a config cannot select `scoped`, so these tests call `resolvePermissions` directly.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/scoped-permissions.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { DEFAULT_CODING_TOOLS, resolvePermissions } from "@/config/permissions";
import { makeNaxConfig } from "../../helpers/mock-nax-config";

// `check:test-as-unknown-as` sits at baseline 0 — a cast here fails the gate.
// makeNaxConfig is the sanctioned factory; resolvePermissions reads only
// `execution`, and NaxConfig is structurally assignable to AgentManagerConfig.
// Mirror the existing idiom in test/unit/config/permissions.test.ts.
function configWith(execution: Record<string, unknown>) {
  return makeNaxConfig({ execution } as Parameters<typeof makeNaxConfig>[0]);
}

describe("resolvePermissions — unrestricted", () => {
  test("grants every default tool unconditionally", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "unrestricted" }), "run");
    expect(resolved.mode).toBe("approve-all");
    const write = resolved.toolGrants?.find((g) => g.tool === "Write");
    expect(write?.patterns).toEqual(["*"]);
  });
});

describe("resolvePermissions — safe", () => {
  test("grants read tools only", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "safe" }), "run");
    const names = (resolved.toolGrants ?? []).map((g) => g.tool).sort();
    expect(names).toEqual([...DEFAULT_CODING_TOOLS].sort());
  });

  test("does not grant Write", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "safe" }), "run");
    expect((resolved.toolGrants ?? []).some((g) => g.tool === "Write")).toBe(false);
  });
});

describe("resolvePermissions — scoped", () => {
  const scoped = configWith({
    permissionProfile: "scoped",
    permissions: {
      default: { allowedTools: ["Read", "Glob", "Grep"] },
      run: { allowedTools: ["Read", "Write(src/**,test/**)"] },
      rectification: { inherit: "run" },
      review: { allowedTools: ["Read", "Git(diff,log)"] },
    },
  });

  test("parses a pattern list out of a tool expression", () => {
    const resolved = resolvePermissions(scoped, "run");
    const write = resolved.toolGrants?.find((g) => g.tool === "Write");
    expect(write?.patterns).toEqual(["src/**", "test/**"]);
  });

  test("a bare tool name grants it unconditionally", () => {
    const resolved = resolvePermissions(scoped, "run");
    expect(resolved.toolGrants?.find((g) => g.tool === "Read")?.patterns).toEqual(["*"]);
  });

  test("follows an inherit chain", () => {
    const resolved = resolvePermissions(scoped, "rectification");
    expect(resolved.toolGrants?.find((g) => g.tool === "Write")?.patterns).toEqual(["src/**", "test/**"]);
  });

  test("falls back to the default block for an unlisted stage", () => {
    const resolved = resolvePermissions(scoped, "acceptance");
    expect((resolved.toolGrants ?? []).map((g) => g.tool).sort()).toEqual(["Glob", "Grep", "Read"]);
  });

  test("carries subcommand patterns for a verb-gated tool", () => {
    const resolved = resolvePermissions(scoped, "review");
    expect(resolved.toolGrants?.find((g) => g.tool === "Git")?.patterns).toEqual(["diff", "log"]);
  });

  test("scoped with no permissions block grants nothing and stays read-only", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "scoped" }), "run");
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.toolGrants).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/config/scoped-permissions.test.ts`
Expected: FAIL — `DEFAULT_CODING_TOOLS` is not exported.

- [ ] **Step 3: Add the config schema**

**`src/config/schema.ts` is a re-export barrel — do not add schemas there.** The execution schema lives in `src/config/schemas-execution.ts`; you will find `permissionProfile` at line 203. Add beside it:

```typescript
const PermissionBlockSchema = z
  .object({
    mode: z.enum(["approve-all", "approve-reads", "scoped"]).optional(),
    allowedTools: z.array(z.string()).optional(),
    inherit: z.string().optional(),
  })
  .strict();

/**
 * Per-stage tool policy (GitHub #374). Keys are pipeline stages plus "default".
 * Read by resolveScopedPermissions; enforced by src/tools/.
 */
export const PermissionsBlockSchema = z.record(z.string(), PermissionBlockSchema);
```

Add `permissions: PermissionsBlockSchema.optional(),` to that same object, on the line after `permissionProfile`. Optional, so `DEFAULT_CONFIG` in `src/config/schemas.ts` needs no new entry.

- [ ] **Step 4: Implement the resolver**

In `src/config/permissions.ts`, add the import and the constant:

```typescript
import type { CodingToolName, ToolGrant } from "@/tools";

/**
 * Coding tools a native run-op receives when it declares none.
 *
 * Named rather than inlined for the same reason as DEFAULT_PERMISSION_PROFILE
 * above: the *unset* case is a deliberate disposition, not an accident, and it
 * should be greppable. Reading within the root is the same risk class as the
 * context pull tools ops already receive, and defaulting it on is what closes
 * the diff-only review gap for every native op at once.
 *
 * Write, Edit and Git are absent by design: Write/Edit mutate, and Git exposes
 * history, arbitrary refs and blame — materially more surface than "search the
 * working tree". Each must be declared by the operation that wants it.
 */
export const DEFAULT_CODING_TOOLS: readonly CodingToolName[] = ["Read", "Glob", "Grep"];

/** Grants for a profile that imposes no per-stage policy. */
function unconditionalGrants(tools: readonly string[]): ToolGrant[] {
  return tools.map((tool) => ({ tool, patterns: ["*"] }));
}

/**
 * Parse one #374 tool expression.
 *
 * `Read`                  -> unconditional
 * `Write(src/**,test/**)` -> those two globs
 * `Git(diff,log)`         -> those two subcommands
 */
function parseToolExpression(expression: string): ToolGrant {
  const open = expression.indexOf("(");
  if (open === -1) return { tool: expression.trim(), patterns: ["*"] };
  const tool = expression.slice(0, open).trim();
  const inner = expression.slice(open + 1, expression.lastIndexOf(")"));
  const patterns = inner
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { tool, patterns: patterns.length > 0 ? patterns : ["*"] };
}
```

Extend the resolved type:

```typescript
export interface ResolvedPermissions {
  mode: "approve-all" | "approve-reads" | "default";
  /**
   * Declarative grants — data, never matchers. Compiled into an enforceable
   * policy by src/tools/, which keeps glob and filesystem semantics out of the
   * config layer while the decision stays here, in the gated SSOT.
   */
  toolGrants?: readonly ToolGrant[];
}
```

Give the two simple profiles their grants, in `resolvePermissions`:

```typescript
    case "unrestricted":
      return {
        mode: "approve-all",
        toolGrants: unconditionalGrants([...DEFAULT_CODING_TOOLS, "Write", "Edit", "Git"]),
      };
    case "safe":
      return { mode: "approve-reads", toolGrants: unconditionalGrants(DEFAULT_CODING_TOOLS) };
```

Replace the `resolveScopedPermissions` stub with:

```typescript
/**
 * Per-stage scoped allowlists (GitHub #374).
 *
 * Lookup order matches docs/specs/scoped-permissions.md section 2.4:
 * stage block -> inherit target -> default block -> no grants.
 *
 * Note what does NOT appear here: any notion of a filesystem root. Containment
 * is not expressible in config by design — the root is a hard boundary that no
 * profile can widen, enforced in src/tools/policy.ts.
 */
function resolveScopedPermissions(
  config: AgentManagerConfig | undefined,
  stage: PipelineStage,
): ResolvedPermissions {
  const blocks = config?.execution?.permissions as
    | Record<string, { allowedTools?: string[]; inherit?: string } | undefined>
    | undefined;
  if (!blocks) return { mode: "approve-reads", toolGrants: [] };

  const seen = new Set<string>();
  let key: string | undefined = stage;
  let block = blocks[stage];

  // Bounded inherit chain: a cycle or a dangling target falls through to
  // `default` rather than looping or throwing mid-run.
  while (block?.inherit !== undefined && key !== undefined && !seen.has(key)) {
    seen.add(key);
    key = block.inherit;
    block = blocks[key];
  }
  block ??= blocks.default;
  if (!block?.allowedTools) return { mode: "approve-reads", toolGrants: [] };

  return { mode: "approve-reads", toolGrants: block.allowedTools.map(parseToolExpression) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/config/scoped-permissions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `bun test test/unit/config`
Expected: PASS. The existing guard tests still pass because both loader guards are untouched.

- [ ] **Step 7: Format, typecheck, gate, commit**

```bash
bun x biome check --write src/config test/unit/config
bun run typecheck
bun run check:permission-mode-ssot
git add src/config test/unit/config
git commit -m "feat(config): resolve per-stage tool grants for the scoped profile"
```

---

### Task 4: Read and Glob

**Files:**
- Create: `src/tools/read.ts`, `src/tools/glob.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/read-glob.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolResult`, `ToolRunContext`, `registerBuiltinTool` (Task 2).
- Produces: `const readTool: CodingTool`, `const globTool: CodingTool`, `function registerFilesystemTools(): void`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/read-glob.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { globTool, readTool } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-fs-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "notes.md"), "hello\n");
});

function ctx(paths: string[], maxBytes = 10_000) {
  return { root, resolvedPaths: paths, maxBytes };
}

describe("readTool", () => {
  test("returns file contents", async () => {
    const res = await readTool.run({ path: "src/a.ts" }, ctx([join(root, "src", "a.ts")]));
    expect(res.content).toContain("export const a = 1;");
    expect(res.isError).toBeFalsy();
  });

  test("a missing file is an error, not a denial", async () => {
    const res = await readTool.run({ path: "src/nope.ts" }, ctx([join(root, "src", "nope.ts")]));
    expect(res.isError).toBe(true);
  });

  test("truncates beyond maxBytes and says so", async () => {
    const res = await readTool.run({ path: "src/a.ts" }, ctx([join(root, "src", "a.ts")], 5));
    expect(res.content.length).toBeLessThan(60);
    expect(res.content).toContain("truncated");
  });

  test("declares its path field so the policy can gate it", () => {
    expect(readTool.scope.pathFields).toEqual(["path"]);
  });
});

describe("globTool", () => {
  test("matches files by pattern, relative to the root", async () => {
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx([]));
    const lines = res.content.trim().split("\n").sort();
    expect(lines).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  test("reports no matches without erroring", async () => {
    const res = await globTool.run({ pattern: "**/*.py" }, ctx([]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches");
  });

  test("never returns a path outside the root", async () => {
    const res = await globTool.run({ pattern: "../**/*" }, ctx([]));
    expect(res.content).not.toContain("..");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/read-glob.test.ts`
Expected: FAIL — `readTool` is not exported.

- [ ] **Step 3: Implement Read**

Create `src/tools/read.ts`:

```typescript
/**
 * Read one file, already resolved and approved by the policy.
 *
 * The tool never resolves a path itself: it uses ctx.resolvedPaths, which the
 * policy produced. That is what keeps containment in one seam.
 */

import { readFile } from "node:fs/promises";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const readTool: CodingTool = {
  name: "Read",
  description: "Read a UTF-8 text file from the repository. Paths are relative to the repository root.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the repository root" } },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(_input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    try {
      return { content: truncate(await readFile(target, "utf8"), ctx.maxBytes) };
    } catch (err) {
      // An unreadable file is a tool ERROR the model can react to, never a
      // denial: the policy already said yes.
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
```

- [ ] **Step 4: Implement Glob**

Create `src/tools/glob.ts`:

```typescript
/**
 * List files matching a glob, always relative to and bounded by the root.
 *
 * Bun.Glob scans from a cwd, so the root is the cwd and results are relative by
 * construction. A pattern that tries to climb out ("../**") therefore matches
 * nothing rather than escaping.
 */

import { sep } from "node:path";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";
import { resolveWithin } from "./policy";

const MAX_MATCHES = 500;

export const globTool: CodingTool = {
  name: "Glob",
  description:
    "List repository files matching a glob pattern (e.g. 'src/**/*.ts'). Results are paths relative to the repository root.",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern, relative to the repository root" } },
    required: ["pattern"],
  },
  // The pattern is not a path: it is matched inside the root by construction,
  // so there is no path field for the policy to gate. Grant-level gating still
  // applies, which is what decides whether Glob may run at all.
  scope: { pathFields: [] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string") return { content: "pattern must be a string", isError: true };

    const matches: string[] = [];
    try {
      // `absolute: false` is the repo-wide idiom (test-scanner.ts:318,
      // fragments/store.ts:53, manifest-purge.ts:64) and yields root-relative
      // paths directly. Each is still re-checked through resolveWithin, because
      // a pattern that climbs out must produce nothing rather than escape.
      const glob = new Bun.Glob(pattern);
      for await (const hit of glob.scan({ cwd: ctx.root, absolute: false })) {
        if (resolveWithin(ctx.root, hit) === null) continue;
        matches.push(hit.split(sep).join("/"));
        if (matches.length >= MAX_MATCHES) break;
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    if (matches.length === 0) return { content: `no matches for "${pattern}"` };
    return { content: matches.sort().join("\n") };
  },
};
```

- [ ] **Step 5: Export and register**

Append to `src/tools/index.ts`:

```typescript
export { readTool } from "./read";
export { globTool } from "./glob";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/unit/tools/read-glob.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): Read and Glob bounded to the permitted root"
```

---

### Task 5: Grep — ripgrep when present, grep otherwise

**Files:**
- Create: `src/tools/grep.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/grep.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolRunContext` (Task 2); `which`, `spawn` from `@/utils/bun-deps`.
- Produces: `const grepTool: CodingTool`; `function buildGrepArgv(binary: "rg" | "grep", pattern: string, path: string | undefined): string[]`; `const _grepDeps = { which, spawn }`.

Both branches spawn. Both are governed by the same rule as Git: fixed binary, nax-constructed argv, no shell. `_grepDeps` is injectable so the fallback is tested without uninstalling ripgrep.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/grep.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { _grepDeps, buildGrepArgv, grepTool } from "@/tools";

let root: string;
const realWhich = _grepDeps.which;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-grep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const needle = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const other = 2;\n");
});

afterEach(() => {
  _grepDeps.which = realWhich;
});

function ctx(maxBytes = 10_000) {
  return { root, resolvedPaths: [], maxBytes };
}

describe("buildGrepArgv", () => {
  test("ripgrep form is fixed-string, line-numbered, and never a shell string", () => {
    const argv = buildGrepArgv("rg", "needle", undefined);
    expect(argv[0]).toBe("rg");
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--line-number");
    expect(argv).toContain("needle");
  });

  test("grep fallback uses recursive line-numbered fixed-string flags", () => {
    const argv = buildGrepArgv("grep", "needle", undefined);
    expect(argv.slice(0, 2)).toEqual(["grep", "-r"]);
    expect(argv).toContain("-n");
    expect(argv).toContain("-F");
  });

  test("the pattern is passed after a '--' terminator so it is never read as a flag", () => {
    const argv = buildGrepArgv("rg", "--oh-no", undefined);
    expect(argv.indexOf("--")).toBeGreaterThan(-1);
    expect(argv.indexOf("--oh-no")).toBeGreaterThan(argv.indexOf("--"));
  });
});

describe("grepTool", () => {
  test("finds a match using whichever binary is present", async () => {
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.content).toContain("a.ts");
    expect(res.content).not.toContain("b.ts");
  });

  test("produces the same match via the grep fallback when rg is absent", async () => {
    _grepDeps.which = (name: string) => (name === "rg" ? null : realWhich(name));
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.content).toContain("a.ts");
  });

  test("no match is an empty result, not an error", async () => {
    const res = await grepTool.run({ pattern: "zzz-nothing-zzz" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches");
  });

  test("errors when neither binary is available", async () => {
    _grepDeps.which = () => null;
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/ripgrep|grep/i);
  });

  test("declares no path field, so it is gated at the tool level", () => {
    expect(grepTool.scope.pathFields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/grep.test.ts`
Expected: FAIL — `buildGrepArgv` is not exported.

- [ ] **Step 3: Implement Grep**

Create `src/tools/grep.ts`:

```typescript
/**
 * Search file contents, preferring ripgrep and falling back to grep.
 *
 * Both branches spawn a subprocess, so this tool is NOT evidence that the
 * default tool set is in-process — it is not. What makes it safe is the same
 * property that makes Git safe: a fixed binary, an argv nax constructs
 * entirely, and no shell, so the model supplies data and never a command.
 *
 * The two binaries take different flags, so the argv builder is per-binary
 * rather than shared, and the fallback is tested explicitly: a machine without
 * ripgrep must produce the same matches, not a silent empty result.
 */

import { spawn, which } from "@/utils/bun-deps";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const GREP_TIMEOUT_MS = 15_000;

/** @internal Injectable for tests — exercises the fallback without uninstalling ripgrep. */
export const _grepDeps = { which, spawn };

export function buildGrepArgv(binary: "rg" | "grep", pattern: string, path: string | undefined): string[] {
  const target = path ?? ".";
  // `--` terminates flag parsing: a pattern beginning with "-" is then data,
  // not an option. Neither binary is ever handed a shell string.
  if (binary === "rg") {
    return ["rg", "--fixed-strings", "--line-number", "--no-heading", "--color", "never", "--", pattern, target];
  }
  return ["grep", "-r", "-n", "-F", "--", pattern, target];
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const grepTool: CodingTool = {
  name: "Grep",
  description:
    "Search repository file contents for a literal string. Returns 'path:line:text' rows relative to the repository root.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Literal string to search for" },
      path: { type: "string", description: "Optional subdirectory, relative to the repository root" },
    },
    required: ["pattern"],
  },
  // Searching is bounded by cwd, so there is no path to gate; the grant decides
  // whether Grep runs at all.
  scope: { pathFields: [] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string") return { content: "pattern must be a string", isError: true };
    const path = typeof input.path === "string" ? input.path : undefined;

    const binary: "rg" | "grep" | null = _grepDeps.which("rg")
      ? "rg"
      : _grepDeps.which("grep")
        ? "grep"
        : null;
    if (binary === null) {
      return { content: "neither ripgrep nor grep is available on this machine", isError: true };
    }

    const proc = _grepDeps.spawn(buildGrepArgv(binary, pattern, path), {
      cwd: ctx.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, GREP_TIMEOUT_MS);

    // Drain concurrently: a large result set fills the pipe buffer and would
    // otherwise block the process before it can exit.
    const stdoutText = new Response(proc.stdout).text().catch(() => "");
    const stderrText = new Response(proc.stderr).text().catch(() => "");
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const stdout = await stdoutText;
    // Both binaries exit 1 for "no matches" — a normal outcome, not a failure.
    if (exitCode === 1 && stdout.trim() === "") return { content: `no matches for "${pattern}"` };
    if (exitCode !== 0 && stdout.trim() === "") {
      return { content: (await stderrText).trim() || `${binary} exited ${exitCode}`, isError: true };
    }
    return { content: truncate(stdout.trimEnd(), ctx.maxBytes) };
  },
};
```

- [ ] **Step 4: Export**

Append to `src/tools/index.ts`:

```typescript
export { _grepDeps, buildGrepArgv, grepTool } from "./grep";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/tools/grep.test.ts`
Expected: PASS, 8 tests. The fallback test passes on a machine with or without ripgrep, because `which` is stubbed rather than the binary removed.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): Grep via ripgrep with a grep fallback"
```

---

### Task 6: Write and Edit

**Files:**
- Create: `src/tools/write.ts`, `src/tools/edit.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/write-edit.test.ts`

**Interfaces:**
- Consumes: `CodingTool`, `ToolRunContext` (Task 2).
- Produces: `const writeTool: CodingTool`, `const editTool: CodingTool`.

`Edit` takes `old_string`/`new_string` (design section 10, question 3 resolved to the self-verifying contract: a stale match fails loudly instead of corrupting a line range).

**These two tools have no production consumer.** Every op that writes also needs to run tests, which needs `Bash`, which C1 excludes. They are built so #374's gate has a concrete subject, and they are exercised by these tests alone. That is deliberate and recorded in design section 3.5 — do not "fix" it by wiring them into an op.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/write-edit.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { editTool, writeTool } from "@/tools";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nax-write-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
});

function ctx(paths: string[]) {
  return { root, resolvedPaths: paths, maxBytes: 10_000 };
}

describe("writeTool", () => {
  test("writes file contents", async () => {
    const target = join(root, "src", "new.ts");
    const res = await writeTool.run({ path: "src/new.ts", content: "x\n" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toBe("x\n");
  });

  test("creates missing parent directories", async () => {
    const target = join(root, "src", "deep", "nested", "n.ts");
    await writeTool.run({ path: "src/deep/nested/n.ts", content: "y\n" }, ctx([target]));
    expect(existsSync(target)).toBe(true);
  });

  test("overwrites an existing file", async () => {
    const target = join(root, "src", "a.ts");
    await writeTool.run({ path: "src/a.ts", content: "replaced\n" }, ctx([target]));
    expect(readFileSync(target, "utf8")).toBe("replaced\n");
  });

  test("declares its path field so the policy can gate it", () => {
    expect(writeTool.scope.pathFields).toEqual(["path"]);
  });
});

describe("editTool", () => {
  test("replaces an exact match", async () => {
    const target = join(root, "src", "a.ts");
    const res = await editTool.run(
      { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 99;" },
      ctx([target]),
    );
    expect(res.isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toContain("const a = 99;");
  });

  // A stale match is an ERROR, not a denial: the policy said yes, the file
  // simply is not what the model believed.
  test("a match that is not present is an error", async () => {
    const target = join(root, "src", "a.ts");
    const res = await editTool.run(
      { path: "src/a.ts", old_string: "const zzz = 0;", new_string: "x" },
      ctx([target]),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not found/i);
  });

  test("an ambiguous match is an error rather than a guess", async () => {
    const target = join(root, "src", "dup.ts");
    writeFileSync(target, "same\nsame\n");
    const res = await editTool.run(
      { path: "src/dup.ts", old_string: "same", new_string: "other" },
      ctx([target]),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/2 times|ambiguous/i);
  });

  test("leaves the file untouched when the edit fails", async () => {
    const target = join(root, "src", "a.ts");
    const before = readFileSync(target, "utf8");
    await editTool.run({ path: "src/a.ts", old_string: "nope", new_string: "x" }, ctx([target]));
    expect(readFileSync(target, "utf8")).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/write-edit.test.ts`
Expected: FAIL — `writeTool` is not exported.

- [ ] **Step 3: Implement Write**

Create `src/tools/write.ts`:

```typescript
/**
 * Write a file whose path the policy already resolved and approved.
 *
 * No production op declares this tool: everything that writes also needs to run
 * tests, which needs Bash, which C1 excludes. It exists so #374's gate has a
 * concrete subject (design section 3.5) and is exercised by tests alone.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export const writeTool: CodingTool = {
  name: "Write",
  description: "Write UTF-8 text to a repository file, creating it and any missing parent directories.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const content = input.content;
    if (typeof content !== "string") return { content: "content must be a string", isError: true };

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { content: `wrote ${Buffer.byteLength(content, "utf8")} bytes` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
```

- [ ] **Step 4: Implement Edit**

Create `src/tools/edit.ts`:

```typescript
/**
 * Replace one exact occurrence in a file.
 *
 * old_string/new_string rather than a line range (design section 10, question
 * 3): the contract verifies itself. A stale match fails loudly, where a line
 * range would silently overwrite whatever had moved into those lines.
 *
 * Like Write, this has no production consumer in C1.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editTool: CodingTool = {
  name: "Edit",
  description:
    "Replace one exact occurrence of old_string with new_string in a repository file. Fails if the match is absent or ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
      old_string: { type: "string", description: "Exact text to replace; must occur exactly once" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return { content: "old_string and new_string must be strings", isError: true };
    }

    let source: string;
    try {
      source = await readFile(target, "utf8");
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const occurrences = countOccurrences(source, oldString);
    if (occurrences === 0) {
      return { content: `old_string not found in ${target}; the file may have changed`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `old_string is ambiguous: found ${occurrences} times. Include more surrounding context.`,
        isError: true,
      };
    }

    try {
      await writeFile(target, source.replace(oldString, newString), "utf8");
      return { content: `edited ${target}` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
```

- [ ] **Step 5: Export**

Append to `src/tools/index.ts`:

```typescript
export { writeTool } from "./write";
export { editTool } from "./edit";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/unit/tools/write-edit.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): Write and Edit with a self-verifying edit contract"
```

---

### Task 7: Git — read-only, structured argv

**Files:**
- Create: `src/tools/git.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/git.test.ts`

**Interfaces:**
- Consumes: `gitWithTimeout` from `@/utils/git`; `CodingTool` (Task 2).
- Produces: `const gitTool: CodingTool`; `const GIT_READ_VERBS: readonly string[]`; `const GIT_ESCAPE_FLAGS: readonly string[]`; `function buildGitArgv(input): string[] | { error: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/git.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildGitArgv, GIT_ESCAPE_FLAGS, GIT_READ_VERBS, gitTool } from "@/tools";

function argvOf(input: Record<string, unknown>): string[] {
  const built = buildGitArgv(input);
  if ("error" in built) throw new Error(`expected argv, got error: ${built.error}`);
  return built;
}

describe("buildGitArgv", () => {
  test("builds a plain diff", () => {
    expect(argvOf({ subcommand: "diff" })).toEqual(["diff"]);
  });

  test("appends refs then paths after a '--' separator", () => {
    expect(argvOf({ subcommand: "diff", refs: ["HEAD~1", "HEAD"], paths: ["src/a.ts"] })).toEqual([
      "diff",
      "HEAD~1",
      "HEAD",
      "--",
      "src/a.ts",
    ]);
  });

  test("rejects a subcommand outside the read-only verb list", () => {
    const built = buildGitArgv({ subcommand: "commit" });
    expect("error" in built).toBe(true);
  });

  test("rejects a ref that looks like a flag", () => {
    const built = buildGitArgv({ subcommand: "log", refs: ["--exec-path=/tmp/evil"] });
    expect("error" in built).toBe(true);
  });

  test("rejects a path that looks like a flag", () => {
    const built = buildGitArgv({ subcommand: "diff", paths: ["-C/etc"] });
    expect("error" in built).toBe(true);
  });

  // Asserted rather than merely not-written: a later refactor could reintroduce
  // one, and each of these reaches outside the repository or executes code.
  test("no built argv ever contains a repo-escape flag", () => {
    const inputs = [
      { subcommand: "diff", refs: ["HEAD"], paths: ["src"] },
      { subcommand: "log" },
      { subcommand: "show", refs: ["HEAD"] },
      { subcommand: "status" },
      { subcommand: "blame", paths: ["src/a.ts"] },
    ];
    for (const input of inputs) {
      const argv = argvOf(input);
      for (const flag of GIT_ESCAPE_FLAGS) {
        expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
      }
    }
  });

  test("mutating verbs are absent from the read-only verb list", () => {
    for (const verb of ["commit", "push", "checkout", "reset", "clean"]) {
      expect(GIT_READ_VERBS).not.toContain(verb);
    }
  });
});

describe("gitTool", () => {
  test("declares its verbs so the policy can gate at the tool level", () => {
    expect(gitTool.scope.verbField).toBe("subcommand");
    expect(gitTool.scope.allowedVerbs).toEqual(GIT_READ_VERBS);
  });

  test("declares no path field — pathspecs are validated in the argv builder", () => {
    expect(gitTool.scope.pathFields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/git.test.ts`
Expected: FAIL — `buildGitArgv` is not exported.

- [ ] **Step 3: Implement Git**

Create `src/tools/git.ts`:

```typescript
/**
 * Read-only git, for reviewers that need a real diff rather than one pushed
 * into the prompt.
 *
 * This spawns a subprocess, which ADR-029 section 3 severed for Bash. The
 * distinction, written down rather than assumed: git is a FIXED binary invoked
 * with an argv nax constructs entirely, with no shell. The model supplies
 * structure — a subcommand, refs, pathspecs — never a command string. Bash
 * inverts that, which is why it needs a sandbox and a threat model instead of
 * an allowlist.
 *
 * Reuses gitWithTimeout, which already provides the argv-array spawn, the
 * explicit cwd, the SIGKILL timeout, and concurrent pipe draining — the last of
 * which matters here because `git log -p` is exactly the output that fills a
 * 64KB pipe buffer and deadlocks a naive implementation.
 */

import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

/** Read-only verbs. Mutating verbs are not representable in the input type. */
export const GIT_READ_VERBS: readonly string[] = ["diff", "log", "show", "status", "blame"];

/**
 * Flags that escape the repository or execute code.
 *
 * `-c` is included because config injection is a command-execution vector:
 * `-c core.pager=<cmd>` runs <cmd>. These are never emitted, and a test asserts
 * their absence from every built argv so a later refactor cannot reintroduce
 * one silently.
 */
export const GIT_ESCAPE_FLAGS: readonly string[] = ["-C", "--git-dir", "--work-tree", "--exec-path", "-c"];

function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

export function buildGitArgv(input: Record<string, unknown>): string[] | { error: string } {
  const subcommand = input.subcommand;
  if (typeof subcommand !== "string" || !GIT_READ_VERBS.includes(subcommand)) {
    return { error: `subcommand must be one of: ${GIT_READ_VERBS.join(", ")}` };
  }

  const refs = Array.isArray(input.refs) ? input.refs : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];

  const argv: string[] = [subcommand];
  for (const ref of refs) {
    if (typeof ref !== "string") return { error: "refs must be strings" };
    // A ref that begins with "-" would be parsed as an option, which is how an
    // escape flag would arrive. Refuse rather than sanitise.
    if (looksLikeFlag(ref)) return { error: `ref "${ref}" may not begin with "-"` };
    argv.push(ref);
  }

  if (paths.length > 0) {
    argv.push("--");
    for (const path of paths) {
      if (typeof path !== "string") return { error: "paths must be strings" };
      if (looksLikeFlag(path)) return { error: `path "${path}" may not begin with "-"` };
      argv.push(path);
    }
  }

  return argv;
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const gitTool: CodingTool = {
  name: "Git",
  description:
    "Run a read-only git command (diff, log, show, status, blame) in the repository. Supply refs and pathspecs as arrays, not as a command line.",
  inputSchema: {
    type: "object",
    properties: {
      subcommand: { type: "string", enum: [...GIT_READ_VERBS], description: "Read-only git subcommand" },
      refs: { type: "array", items: { type: "string" }, description: "Refs, e.g. ['HEAD~1','HEAD']" },
      paths: { type: "array", items: { type: "string" }, description: "Pathspecs, relative to the repository root" },
    },
    required: ["subcommand"],
  },
  scope: { pathFields: [], verbField: "subcommand", allowedVerbs: GIT_READ_VERBS },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const built = buildGitArgv(input);
    if ("error" in built) return { content: built.error, isError: true };

    try {
      const { stdout, stderr, exitCode } = await gitWithTimeout(built, ctx.root);
      if (exitCode !== 0 && stdout.trim() === "") {
        return { content: stderr.trim() || `git exited ${exitCode}`, isError: true };
      }
      return { content: truncate(stdout.trimEnd(), ctx.maxBytes) || "(no output)" };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
```

- [ ] **Step 4: Export**

Append to `src/tools/index.ts`:

```typescript
export { buildGitArgv, GIT_ESCAPE_FLAGS, GIT_READ_VERBS, gitTool } from "./git";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/tools/git.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bun x biome check --write src/tools test/unit/tools
bun run typecheck
git add src/tools test/unit/tools
git commit -m "feat(tools): read-only Git with a structured, escape-proof argv"
```

---

### Task 8: CodingToolRuntime — policy plus registry

**Files:**
- Create: `src/tools/runtime.ts`
- Modify: `src/tools/index.ts`
- Test: `test/unit/tools/runtime.test.ts`

**Interfaces:**
- Consumes: `ToolPolicy` (Task 1), registry (Task 2), all six tools (Tasks 4-7).
- Produces: `type CodingToolOutcome = { kind: "ok" | "error"; content: string } | { kind: "denied"; reason: string; breach: boolean }`; `interface CodingToolRuntime { advertised(declared): readonly CodingTool[]; callTool(name, input): Promise<CodingToolOutcome> }`; `function createCodingToolRuntime(opts: { policy: ToolPolicy; maxBytes?: number; logger?: Logger }): CodingToolRuntime`; `const DEFAULT_TOOL_MAX_BYTES: number`.

This is the analogue of `ContextToolRuntime`. It applies the policy; it decides nothing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/runtime.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-runtime-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
});

function runtimeWith(grants: { tool: string; patterns: string[] }[]) {
  return createCodingToolRuntime({ policy: compileToolPolicy(grants, root) });
}

describe("createCodingToolRuntime", () => {
  test("executes a permitted call", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.content).toContain("const a = 1;");
  });

  // The distinction ADR-029 section 5 exists to protect: a refusal is not a crash.
  test("a policy refusal is 'denied', not 'error'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["docs/**"] }]);
    const out = await rt.callTool("Read", { path: "src/a.ts" });
    expect(out.kind).toBe("denied");
  });

  test("an ungranted tool is denied", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect((await rt.callTool("Write", { path: "src/a.ts", content: "x" })).kind).toBe("denied");
  });

  test("a containment breach is denied and flagged", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "../../etc/hosts" });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.breach).toBe(true);
  });

  test("a failing tool is 'error', distinct from 'denied'", async () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    const out = await rt.callTool("Read", { path: "src/missing.ts" });
    expect(out.kind).toBe("error");
  });

  test("an unknown tool name is denied", async () => {
    const rt = runtimeWith([{ tool: "Nope", patterns: ["*"] }]);
    expect((await rt.callTool("Nope", {})).kind).toBe("denied");
  });

  test("a thrown tool becomes 'error', never an escaped exception", async () => {
    const rt = runtimeWith([{ tool: "Git", patterns: ["*"] }]);
    const out = await rt.callTool("Git", { subcommand: "not-a-verb" });
    expect(out.kind).toBe("error");
  });
});

describe("advertised", () => {
  test("intersects the op's declaration with the policy's grants", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Glob", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read", "Write"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("a tool granted but not declared is not advertised", () => {
    const rt = runtimeWith([
      { tool: "Read", patterns: ["*"] },
      { tool: "Git", patterns: ["*"] },
    ]);
    expect(rt.advertised(["Read"]).map((t) => t.name)).toEqual(["Read"]);
  });

  test("declaring nothing advertises nothing", () => {
    const rt = runtimeWith([{ tool: "Read", patterns: ["*"] }]);
    expect(rt.advertised([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/runtime.test.ts`
Expected: FAIL — `createCodingToolRuntime` is not exported.

- [ ] **Step 3: Implement the runtime**

Create `src/tools/runtime.ts`:

```typescript
/**
 * Pairs the compiled policy with the tool registry and answers one call.
 *
 * nax-permission-mode-allow: consumes grants resolved by resolvePermissions;
 * makes no permission decision of its own.
 *
 * The three outcomes are kept structurally distinct. Reusing one channel for a
 * refusal and a crash would make a denied permission look like a recoverable
 * tool error, which ADR-029 section 5 forbids.
 */

import { getSafeLogger } from "@/logger";
import { editTool } from "./edit";
import { gitTool } from "./git";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { type CodingTool, getCodingTool, registerBuiltinTool } from "./registry";
import type { ToolPolicy } from "./types";
import { writeTool } from "./write";

/** Per-call output ceiling, mirroring ToolDescriptor.maxTokensPerCall in spirit. */
export const DEFAULT_TOOL_MAX_BYTES = 40_000;

export type CodingToolOutcome =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | { readonly kind: "denied"; readonly reason: string; readonly breach: boolean };

export interface CodingToolRuntime {
  /** Op declaration intersected with policy grants. Both can only narrow. */
  advertised(declared: readonly string[]): readonly CodingTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<CodingToolOutcome>;
}

let builtinsRegistered = false;

/** Idempotent: the registry is process-global, the runtime is per-session. */
export function registerBuiltinCodingTools(): void {
  if (builtinsRegistered) return;
  for (const tool of [readTool, globTool, grepTool, writeTool, editTool, gitTool]) {
    if (getCodingTool(tool.name) === undefined) registerBuiltinTool(tool);
  }
  builtinsRegistered = true;
}

/** @internal Test-only: pairs with _resetRegistryForTest. */
export function _resetBuiltinsForTest(): void {
  builtinsRegistered = false;
}

export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
}): CodingToolRuntime {
  registerBuiltinCodingTools();
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const granted = new Set(opts.policy.grantedTools());

  return {
    advertised(declared) {
      const out: CodingTool[] = [];
      for (const name of declared) {
        if (!granted.has(name)) continue;
        const tool = getCodingTool(name);
        if (tool !== undefined) out.push(tool);
      }
      return out;
    },

    async callTool(name, input) {
      const tool = getCodingTool(name);
      if (tool === undefined) {
        return { kind: "denied", reason: `unknown tool "${name}"`, breach: false };
      }

      const verdict = opts.policy.check(name, tool.scope, input);
      if (!verdict.allowed) {
        if (verdict.breach) {
          // In band so an unattended run survives one bad path guess, but loud:
          // a path escaping the root can indicate prompt injection.
          getSafeLogger()?.warn("tools", "[policy] path resolved outside the permitted root", {
            tool: name,
            reason: verdict.reason,
            root: opts.policy.root,
          });
        }
        return { kind: "denied", reason: verdict.reason, breach: verdict.breach };
      }

      try {
        const result = await tool.run(input, {
          root: opts.policy.root,
          resolvedPaths: verdict.resolvedPaths,
          maxBytes,
        });
        return result.isError === true
          ? { kind: "error", content: result.content }
          : { kind: "ok", content: result.content };
      } catch (err) {
        return { kind: "error", content: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 4: Export**

Append to `src/tools/index.ts`:

```typescript
export {
  _resetBuiltinsForTest,
  createCodingToolRuntime,
  DEFAULT_TOOL_MAX_BYTES,
  registerBuiltinCodingTools,
} from "./runtime";
export type { CodingToolOutcome, CodingToolRuntime } from "./runtime";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/tools/runtime.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the whole tools suite and gates**

```bash
bun test test/unit/tools
bun run typecheck
bun run check:nax-ai-imports
bun run check:alias-internals
bun run check:file-sizes
```
Expected: all PASS. `check:nax-ai-imports` matters here — `src/tools/` must never import `@nathapp/nax-ai`.

- [ ] **Step 7: Format and commit**

```bash
bun x biome check --write src/tools test/unit/tools
git add src/tools test/unit/tools
git commit -m "feat(tools): coding tool runtime keeping denial distinct from error"
```

---

### Task 9: Route coding-tool calls over their own interaction kind

**Files:**
- Create: `src/agents/run-interaction-handler.ts`
- Modify: `src/agents/interaction-handler.ts`
- Modify: `src/agents/acp/adapter-output.ts` (remove `buildRunInteractionHandler`)
- Modify: `src/agents/types.ts` (add `codingToolRuntime` to `AgentRunOptions`)
- Test: `test/unit/agents/run-interaction-handler.test.ts`

**Interfaces:**
- Consumes: `CodingToolRuntime`, `CodingToolOutcome` (Task 8).
- Produces: `AdapterInteraction` gains `{ kind: "coding-tool"; name: string; input?: Record<string, unknown> }`; `AdapterInteractionResponse` gains `denied?: { reason: string; breach: boolean }`; `buildRunInteractionHandler` exported from its new home.

`buildRunInteractionHandler` is transport-agnostic despite living in the ACP tree — the same trap Phase B hit with `buildContextToolPreamble`, which it fixed by relocating to `src/agents/tool-preamble.ts`. Importing ACP into the native tree is backwards and trips `check:alias-internals`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/run-interaction-handler.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildRunInteractionHandler, type RunInteractionOptions } from "@/agents/run-interaction-handler";
import type { CodingToolOutcome, CodingToolRuntime } from "@/tools";

// No casts: the handler takes a NARROWED option type (see Step 4), so a test can
// construct one honestly. `check:test-as-unknown-as` sits at baseline 0.
function runtimeReturning(outcome: CodingToolOutcome): CodingToolRuntime {
  return {
    advertised: () => [],
    callTool: async () => outcome,
  };
}

function optionsWith(runtime: CodingToolRuntime): RunInteractionOptions {
  return { codingToolRuntime: runtime };
}

describe("buildRunInteractionHandler — coding tools", () => {
  test("returns tool output on success", async () => {
    const handler = buildRunInteractionHandler(optionsWith(runtimeReturning({ kind: "ok", content: "file body" })));
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" } });
    expect(res?.answer).toContain("file body");
    expect(res?.denied).toBeUndefined();
  });

  test("an error carries no denial marker", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "error", content: "ENOENT" })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.answer).toContain("ENOENT");
    expect(res?.denied).toBeUndefined();
  });

  // The whole point of the separate channel: a refusal must not look like a crash.
  test("a denial is marked structurally, not merely worded", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "not granted", breach: false })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Write", input: {} });
    expect(res?.denied).toEqual({ reason: "not granted", breach: false });
  });

  test("a breach denial carries the breach flag through", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "outside root", breach: true })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.denied?.breach).toBe(true);
  });

  test("returns null when no coding runtime is configured", async () => {
    const handler = buildRunInteractionHandler({});
    expect(await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/run-interaction-handler.test.ts`
Expected: FAIL — module `@/agents/run-interaction-handler` not found.

- [ ] **Step 3: Widen the interaction vocabulary**

In `src/agents/interaction-handler.ts`:

```typescript
export type AdapterInteraction =
  | { kind: "context-tool"; name: string; input?: unknown; error?: string }
  | { kind: "question"; text: string }
  // Coding tools get their own kind rather than riding "context-tool": that
  // channel is the context engine's pull-tool vocabulary, with PullToolBudget
  // behind it. Routing Write through it would be a category error.
  | { kind: "coding-tool"; name: string; input?: Record<string, unknown> };

export interface AdapterInteractionResponse {
  answer: string;
  /**
   * Present only when the permission policy refused the call.
   *
   * Structural rather than a string convention: `{ answer }` alone cannot
   * distinguish "refused, and here is why" from "here is your file", and
   * conflating the two is exactly what ADR-029 section 5 forbids.
   */
  denied?: { reason: string; breach: boolean };
}
```

- [ ] **Step 4: Move the handler and add the branch**

Create `src/agents/run-interaction-handler.ts` with the existing body of `buildRunInteractionHandler` from `src/agents/acp/adapter-output.ts` (including its private `buildContextToolResult` helper).

**Narrow the parameter while moving it.** The handler reads four fields of `AgentRunOptions` and nothing else, and a full `AgentRunOptions` has six required fields a test cannot honestly supply — which is what would otherwise force an `as unknown as` cast into `test/`, where the ratchet sits at baseline 0. Declare and export:

```typescript
/** Exactly what the handler reads. Narrower than AgentRunOptions on purpose. */
export type RunInteractionOptions = Pick<
  AgentRunOptions,
  "contextToolRuntime" | "contextPullTools" | "interactionBridge" | "codingToolRuntime"
>;

export function buildRunInteractionHandler(options: RunInteractionOptions): InteractionHandler {
```

`AgentRunOptions` remains assignable to it, so every existing ACP call site compiles unchanged.

Then add the coding-tool branch before the final `return null`:

```typescript
      if (req.kind === "coding-tool") {
        const runtime = options.codingToolRuntime;
        if (!runtime) return null;
        const outcome = await runtime.callTool(req.name, req.input ?? {});
        if (outcome.kind === "denied") {
          return {
            answer: `Denied: ${outcome.reason}`,
            denied: { reason: outcome.reason, breach: outcome.breach },
          };
        }
        return { answer: outcome.content };
      }
```

In `src/agents/acp/adapter-output.ts`, delete `buildRunInteractionHandler` and its now-unused `buildContextToolResult`, and re-export from the new home so existing ACP callers keep compiling:

```typescript
export { buildRunInteractionHandler } from "../run-interaction-handler";
```

In `src/agents/types.ts`, add to `AgentRunOptions`:

```typescript
  /** Executes nax's own coding tools; absent means the op declared none. */
  codingToolRuntime?: import("@/tools").CodingToolRuntime;
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/agents/run-interaction-handler.test.ts
bun test test/unit/agents
```
Expected: PASS. Existing ACP tests still pass via the re-export.

- [ ] **Step 6: Format, gate, commit**

```bash
bun x biome check --write src/agents test/unit/agents
bun run typecheck
bun run check:alias-internals
bun run check:adapter-no-config-import
git add src/agents test/unit/agents
git commit -m "refactor(agents): move run interaction handler out of the ACP tree and route coding tools"
```

---

### Task 10: Operations declare the tools they need

**Files:**
- Modify: `src/operations/types.ts`
- Modify: `src/operations/semantic-review.ts`, `src/operations/adversarial-review.ts`
- Test: `test/unit/operations/tool-declaration.test.ts`

**Interfaces:**
- Consumes: `CodingToolName` (Task 1), `DEFAULT_CODING_TOOLS` (Task 3).
- Produces: `RunOperation.tools?: readonly CodingToolName[]`; `function resolveDeclaredTools(op: { tools?: readonly CodingToolName[] }): readonly CodingToolName[]`.

Before editing, confirm the review op filenames: `ls src/operations | grep -i review`. Use the actual `semantic` and `adversarial` review op files.

- [ ] **Step 1: Write the failing test**

Create `test/unit/operations/tool-declaration.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import { resolveDeclaredTools } from "@/operations/types";

describe("resolveDeclaredTools", () => {
  test("an op declaring nothing gets the default read set", () => {
    expect(resolveDeclaredTools({})).toEqual(DEFAULT_CODING_TOOLS);
  });

  test("an explicit empty array opts out entirely", () => {
    expect(resolveDeclaredTools({ tools: [] })).toEqual([]);
  });

  test("an explicit declaration is used verbatim", () => {
    expect(resolveDeclaredTools({ tools: ["Read", "Git"] })).toEqual(["Read", "Git"]);
  });

  test("the default set excludes the mutating and broad tools", () => {
    for (const excluded of ["Write", "Edit", "Git"]) {
      expect(DEFAULT_CODING_TOOLS).not.toContain(excluded);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/tool-declaration.test.ts`
Expected: FAIL — `resolveDeclaredTools` is not exported.

- [ ] **Step 3: Add the field and the resolver**

In `src/operations/types.ts`, add to `RunOperation`, beside `session`:

```typescript
  /**
   * Coding tools this operation needs.
   *
   * Advertised = this declaration INTERSECTED with what the permission policy
   * grants. Both axes can only narrow: a reviewer that never declares Write
   * cannot receive it even under `unrestricted`, because "should a reviewer
   * write files" is a capability question, not a permission one.
   *
   * Omit to receive DEFAULT_CODING_TOOLS. Use `[]` to opt out explicitly.
   */
  readonly tools?: readonly CodingToolName[];
```

Add the import and the resolver:

```typescript
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import type { CodingToolName } from "@/tools";

/** Absent means the default read set; `[]` means none. The two differ. */
export function resolveDeclaredTools(op: { tools?: readonly CodingToolName[] }): readonly CodingToolName[] {
  return op.tools ?? DEFAULT_CODING_TOOLS;
}
```

- [ ] **Step 4: Declare Git on the review ops**

In each of the semantic and adversarial review op definitions, add beside `session`:

```typescript
  tools: ["Read", "Glob", "Grep", "Git"],
```

This is what closes the diff-only gap: those two ops can now read files across the tree and pull a real diff, instead of seeing only what was pushed into the prompt.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/operations/tool-declaration.test.ts
bun test test/unit/operations
```
Expected: PASS.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bun x biome check --write src/operations test/unit/operations
bun run typecheck
git add src/operations test/unit/operations
git commit -m "feat(operations): declare per-op coding tools and grant reviews Git"
```

---

### Task 11: Construct the runtime and supply it to the session

**Files:**
- Create: `src/agents/coding-tool-support.ts`
- Modify: `src/session/manager-run.ts:87-89`
- Test: `test/unit/agents/coding-tool-support.test.ts`

**Interfaces:**
- Consumes: `createCodingToolRuntime`, `compileToolPolicy` (Tasks 1, 8); `ResolvedPermissions.toolGrants` (Task 3); `resolveDeclaredTools` (Task 10).
- Produces: `interface CodingToolSupport { runtime: CodingToolRuntime; tools: readonly CodingTool[] }`; `function buildCodingToolSupport(args: { root?: string; grants?: readonly ToolGrant[]; declared: readonly CodingToolName[] }): CodingToolSupport | undefined`.

**Read this before writing any code in this task.** There is no `AgentRunOptions.cwd`. The field is **`workdir`** (`src/agents/types.ts:108`, required `string`), and `src/operations/call.ts:197` sets it to **`ctx.packageDir`** — which is **`""` for the root package of every single-package repo**, exactly as `packageWorkdir`'s docstring in `src/runtime/packages.ts` says. Passing that raw would make the fail-loud guard fire on the *common* case and silently disable coding tools everywhere.

The correct root is `packageWorkdir(ctx.packageView)`, the established idiom at `src/operations/verify.ts:186`, `write-test.ts:112` and `implement.ts:98`. This task therefore adds a dedicated `codingToolRoot` field rather than reusing `workdir`, so no existing ACP behaviour changes.

**This task exists because the plan would otherwise ship unreachable code.** Tasks 8-10 build the runtime, add the `AgentRunOptions` field and add the op declaration; Task 12 dispatches. Without this task nothing ever *constructs* a runtime, so `codingToolRuntime` stays undefined, the handler returns `null`, and every coding tool silently does not exist — while all the other tasks pass review, because each is correct in isolation. That is Phase B's `transcriptDir` defect exactly.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/coding-tool-support.test.ts`:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-support-"));
});

describe("buildCodingToolSupport", () => {
  test("builds a runtime advertising the intersection of declared and granted", () => {
    const support = buildCodingToolSupport({
      root,
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
      ],
      declared: ["Read", "Git"],
    });
    expect(support?.tools.map((t) => t.name)).toEqual(["Read"]);
  });

  test("returns undefined when the op declares no tools", () => {
    expect(buildCodingToolSupport({ root, grants: [{ tool: "Read", patterns: ["*"] }], declared: [] })).toBeUndefined();
  });

  test("returns undefined when the policy grants nothing", () => {
    expect(buildCodingToolSupport({ root, grants: [], declared: ["Read"] })).toBeUndefined();
  });

  test("returns undefined when the intersection is empty", () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Write", patterns: ["*"] }],
      declared: ["Read"],
    });
    expect(support).toBeUndefined();
  });

  // The #1794 lesson: an empty root silently becomes process.cwd(), which with
  // -d is a different repository entirely. Refuse rather than guess.
  //
  // The CALLER is responsible for never producing an empty root: it passes
  // packageWorkdir(ctx.packageView), which returns repoRoot when packageDir is
  // "". These two cases guard the seam, they are not the expected path.
  test("fails loudly rather than defaulting when the root is missing", () => {
    expect(() =>
      buildCodingToolSupport({ root: undefined, grants: [{ tool: "Read", patterns: ["*"] }], declared: ["Read"] }),
    ).toThrow(/root/i);
  });

  test("fails loudly on an empty-string root", () => {
    expect(() =>
      buildCodingToolSupport({ root: "", grants: [{ tool: "Read", patterns: ["*"] }], declared: ["Read"] }),
    ).toThrow(/root/i);
  });

  test("the runtime it returns enforces the root", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Read", patterns: ["*"] }],
      declared: ["Read"],
    });
    const outcome = await support?.runtime.callTool("Read", { path: "../../etc/hosts" });
    expect(outcome?.kind).toBe("denied");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support.test.ts`
Expected: FAIL — module `@/agents/coding-tool-support` not found.

- [ ] **Step 3: Write the support builder**

Create `src/agents/coding-tool-support.ts`:

```typescript
/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * This is the seam that makes coding tools reachable at all. It is deliberately
 * one small function with one caller, so "nothing ever supplied it" is a
 * compile-visible question rather than a silent runtime absence.
 */

import { NaxError } from "@/errors";
import {
  type CodingTool,
  type CodingToolName,
  type CodingToolRuntime,
  compileToolPolicy,
  createCodingToolRuntime,
  type ToolGrant,
} from "@/tools";

export interface CodingToolSupport {
  readonly runtime: CodingToolRuntime;
  readonly tools: readonly CodingTool[];
}

export function buildCodingToolSupport(args: {
  root?: string;
  grants?: readonly ToolGrant[];
  declared: readonly CodingToolName[];
}): CodingToolSupport | undefined {
  if (args.declared.length === 0) return undefined;
  const grants = args.grants ?? [];
  if (grants.length === 0) return undefined;

  // An empty root passed to a spawn or a path join silently means
  // process.cwd() — the directory nax was launched from, which under `-d` is a
  // different repository. That is the #1794 defect; refuse instead. Callers
  // pass packageWorkdir(view), which never yields "".
  if (args.root === undefined || args.root.trim() === "") {
    throw new NaxError(
      "Cannot enable coding tools: no working directory was supplied, so the permitted root is unknown.",
      "CODING_TOOL_ROOT_MISSING",
      { stage: "tools" },
    );
  }

  const runtime = createCodingToolRuntime({ policy: compileToolPolicy(grants, args.root) });
  const tools = runtime.advertised(args.declared);
  if (tools.length === 0) return undefined;
  return { runtime, tools };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/unit/agents/coding-tool-support.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Supply the root and the declaration from callOp**

Add two fields to `AgentRunOptions` in `src/agents/types.ts`, beside the existing `contextPullTools` / `contextToolRuntime`:

```typescript
  /** Tools this operation declared; resolveDeclaredTools() has already applied the default. */
  declaredTools?: readonly import("@/tools").CodingToolName[];
  /**
   * Permitted root for coding tools.
   *
   * Deliberately NOT `workdir`: that is `ctx.packageDir`, which is "" for the
   * root package of a single-package repo. This carries
   * packageWorkdir(ctx.packageView), which resolves that to repoRoot.
   */
  codingToolRoot?: string;
```

In `src/operations/call.ts`, in the `runOptions` object literal at line 195 (the one whose `workdir: ctx.packageDir` you can see at line 197), add:

```typescript
    declaredTools: resolveDeclaredTools(runOp),
    codingToolRoot: packageWorkdir(ctx.packageView),
```

Import both: `import { packageWorkdir } from "../runtime/packages";` and `resolveDeclaredTools` from `./types`. `packageWorkdir(ctx.packageView)` is the established idiom here — see `src/operations/verify.ts:186`, `write-test.ts:112`, `implement.ts:98`.

- [ ] **Step 6: Call it from the run path — note the ordering**

**`injectedRequest` is constructed at `src/session/manager-run.ts:63`, but `resolvedPermissions` is not computed until line 88.** You cannot spread coding support into an object that was built twenty-five lines earlier. Hoist the permission resolution above the request literal.

Move these two lines from their current position (around line 87-89) to immediately *before* `const callerCallback = ...` at line 62:

```typescript
  const stage = request.runOptions.pipelineStage ?? "run";
  const resolvedPermissions =
    request.runOptions.resolvedPermissions ?? resolvePermissions(request.runOptions.config, stage);
```

This is a safe hoist: both are pure reads of `request.runOptions`, and nothing between line 62 and line 89 mutates it. Delete the original pair so `stage` and `resolvedPermissions` are declared exactly once — a duplicate `const` is a compile error, which is the desired outcome if the move is done wrongly.

Then, immediately after the hoisted pair, add:

```typescript
  const codingSupport = buildCodingToolSupport({
    root: request.runOptions.codingToolRoot,
    grants: resolvedPermissions.toolGrants,
    declared: request.runOptions.declaredTools ?? [],
  });
```

And extend the existing `injectedRequest` literal's `runOptions` spread (line 65-67) with:

```typescript
      ...(codingSupport ? { codingToolRuntime: codingSupport.runtime, codingTools: codingSupport.tools } : {}),
```

Keep the existing `onSessionEstablished` override in place — add to the object, do not replace it.

- [ ] **Step 7: Verify the wiring is actually reachable**

```bash
bun test test/unit/session
bun test test/unit/agents
bun run typecheck
```
Expected: PASS. Then confirm by inspection that `codingToolRuntime` has a producer:

```bash
rg -n "codingToolRuntime" src/ || grep -rn "codingToolRuntime" src/
```
Expected: at least three sites — the type, the producer in `manager-run.ts`, and the consumer in `run-interaction-handler.ts`. **If the producer is missing, the feature is unreachable no matter how green the tests are.**

- [ ] **Step 8: Format, typecheck, commit**

```bash
bun x biome check --write src/agents src/session test/unit/agents
bun run typecheck
git add src/agents src/session test/unit/agents
git commit -m "feat(session): construct and supply the coding tool runtime"
```

---

### Task 12: Dispatch coding tools in the native turn loop

**Files:**
- Modify: `src/agents/native/session/tool-mapping.ts`
- Modify: `src/agents/native/session/turn-loop.ts`
- Modify: `src/agents/session-types.ts` (add `codingTools` to `SendTurnOpts`)
- Test: `test/unit/agents/native/coding-tool-loop.test.ts`

**Interfaces:**
- Consumes: `CodingTool` (Task 2), the widened `AdapterInteraction`/`AdapterInteractionResponse` (Task 9).
- Produces: `function codingToolsToDefinitions(tools: readonly CodingTool[]): ToolDefinition[]`; `SendTurnOpts.codingTools?: readonly CodingTool[]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/coding-tool-loop.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { codingToolsToDefinitions } from "@/agents/native/session/tool-mapping";
import type { CodingTool } from "@/tools";

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "body" };
  },
};

describe("codingToolsToDefinitions", () => {
  test("carries name, description and schema onto the wire shape", () => {
    expect(codingToolsToDefinitions([fakeRead])).toEqual([
      {
        name: "Read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("drops the nax-side fields — scope and run mean nothing to a provider", () => {
    const [def] = codingToolsToDefinitions([fakeRead]);
    expect(def).not.toHaveProperty("scope");
    expect(def).not.toHaveProperty("run");
  });

  test("maps an empty list to an empty list", () => {
    expect(codingToolsToDefinitions([])).toEqual([]);
  });
});
```

Extend `test/unit/agents/native/turn-loop.test.ts` with, adapting the file's existing harness for building a `SessionHandle` and `SendTurnOpts`:

```typescript
test("a denied coding tool becomes a tool-result that is NOT isError", async () => {
  const messages: unknown[] = [];
  const opts = makeSendTurnOpts({
    codingTools: [fakeRead],
    interactionHandler: {
      async onInteraction() {
        return { answer: "Denied: not granted", denied: { reason: "not granted", breach: false } };
      },
    },
  });

  await runNativeTurn(handle, "please read", opts, {
    complete: async (msgs) => {
      messages.push(...msgs);
      return firstCallRequestsTool();
    },
  });

  const toolResult = messages.find((m) => (m as { role?: string }).role === "tool-result") as {
    isError?: boolean;
    denied?: unknown;
  };
  expect(toolResult.isError).toBeUndefined();
  expect(toolResult.denied).toEqual({ reason: "not granted", breach: false });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/agents/native`
Expected: FAIL — `codingToolsToDefinitions` is not exported.

- [ ] **Step 3: Map coding tools to the wire shape**

Append to `src/agents/native/session/tool-mapping.ts`:

```typescript
import type { CodingTool } from "@/tools";

/**
 * CodingTool -> ToolDefinition.
 *
 * `scope` and `run` stay behind for the same reason the pull tools' budget
 * fields do: nax executes these, so they mean nothing to a provider.
 */
export function codingToolsToDefinitions(tools: readonly CodingTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
```

- [ ] **Step 4: Dispatch the new kind in the loop**

In `src/agents/session-types.ts`, add to `SendTurnOpts`:

```typescript
  /** Coding tools advertised to the model this turn (already policy-filtered). */
  codingTools?: readonly import("@/tools").CodingTool[];
```

In `src/agents/native/session/turn-loop.ts`, advertise both tool families:

```typescript
  const codingTools = opts.codingTools ?? [];
  const codingToolNames = new Set(codingTools.map((t) => t.name));
  const tools = [...toToolDefinitions(opts.contextPullTools ?? []), ...codingToolsToDefinitions(codingTools)];
```

Replace the tool-dispatch body inside the `for (const call of res.toolCalls)` loop:

```typescript
      try {
        const kind = codingToolNames.has(call.name) ? "coding-tool" : "context-tool";
        const answer = await opts.interactionHandler.onInteraction(
          kind === "coding-tool"
            ? { kind, name: call.name, input: (call.input ?? {}) as Record<string, unknown> }
            : { kind, name: call.name, input: call.input },
        );

        // A denial is data the model can act on, and deliberately NOT isError:
        // a refused Write is not a crashed Write (ADR-029 s5).
        if (answer?.denied !== undefined) {
          messages.push({
            role: "tool-result",
            toolCallId: call.id,
            content: answer.answer,
            denied: answer.denied,
          });
          continue;
        }
        messages.push({ role: "tool-result", toolCallId: call.id, content: answer?.answer ?? "" });
      } catch (err) {
        messages.push({
          role: "tool-result",
          toolCallId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
```

If `ConversationMessage` from nax-ai rejects the extra `denied` field, keep the marker inside the transcript by widening nax's local message type rather than by dropping it — losing the marker is the defect this task exists to prevent.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/agents/native
```
Expected: PASS, including the existing Phase B turn-loop tests, which are unchanged because context tools still take the `context-tool` branch.

- [ ] **Step 6: Format, gate, commit**

```bash
bun x biome check --write src/agents test/unit/agents
bun run typecheck
bun run check:nax-ai-imports
git add src/agents test/unit/agents
git commit -m "feat(native): dispatch coding tools and preserve the denial marker"
```

---

### Task 13: Turn on the scoped profile, and prove it live

**Files:**
- Modify: `src/config/loader.ts` (remove both guard calls)
- Modify: `src/config/config-guards.ts` (delete both guards)
- Modify: existing guard tests (delete the cases asserting rejection)
- Create: `scripts/probe-native-coding-tools.ts`
- Modify: `docs/specs/scoped-permissions.md` (amend section 2.3)
- Test: `test/unit/config/scoped-profile-accepted.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-12.
- Produces: a config with `permissionProfile: "scoped"` now loads; a probe script proving denial end to end.

**This is the last task by design.** Removing the guards earlier opens a window where a config declares `scoped` while nothing enforces it — silently weaker permissions than asked for.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/scoped-profile-accepted.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { rejectDeadQualityFlags } from "@/config/config-guards";
import { NaxConfigSchema } from "@/config/schema";

describe("scoped profile is accepted now that enforcement exists", () => {
  test("the schema accepts a permissions block", () => {
    const parsed = NaxConfigSchema.safeParse({
      execution: {
        permissionProfile: "scoped",
        permissions: {
          default: { allowedTools: ["Read", "Glob", "Grep"] },
          review: { allowedTools: ["Read", "Git(diff,log)"] },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("an unknown key inside a permission block is still rejected", () => {
    const parsed = NaxConfigSchema.safeParse({
      execution: {
        permissionProfile: "scoped",
        permissions: { review: { allowedTools: ["Read"], nonsense: true } },
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("the unrelated dead-flag guard still exists and still runs", () => {
    expect(typeof rejectDeadQualityFlags).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/config/scoped-profile-accepted.test.ts`
Expected: FAIL — the schema rejects `permissions`, or the guards throw.

- [ ] **Step 3: Remove both guards**

In `src/config/loader.ts`, delete the two calls and their comments:

```typescript
  rejectUnimplementedScopedProfile(rawConfig);
  rejectUnimplementedPermissionsBlock(rawConfig);
```

Remove both names from the `./config-guards` import list. In `src/config/config-guards.ts`, delete `rejectUnimplementedScopedProfile` and `rejectUnimplementedPermissionsBlock` and their doc comments.

Then find and delete the existing tests asserting rejection:

```bash
rg -l "CONFIG_SCOPED_PROFILE_UNIMPLEMENTED|CONFIG_PERMISSIONS_BLOCK_UNIMPLEMENTED" test/ || \
  grep -rl "CONFIG_SCOPED_PROFILE_UNIMPLEMENTED\|CONFIG_PERMISSIONS_BLOCK_UNIMPLEMENTED" test/
```

Delete only the cases asserting those throws. Leave the rest of each file intact.

- [ ] **Step 4: Replace the guards with a real validator**

Deleting the guards must not mean a malformed policy now fails at call time. Design section 6 requires it to fail at config load, loudly.

In `src/config/config-guards.ts` add:

```typescript
import { RESERVED_TOOL_NAMES } from "@/tools";

/**
 * @internal Validate `execution.permissions` at load time.
 *
 * Replaces rejectUnimplementedScopedProfile/rejectUnimplementedPermissionsBlock,
 * which refused the block outright while it was unenforced. Now that it IS
 * enforced, the failure mode inverts: a typo in a tool name would silently grant
 * nothing, which reads as "the policy is working" right up until it is not.
 * ConfigError at load beats a surprise mid-run.
 */
export function validatePermissionsBlock(conf: Record<string, unknown>): void {
  const execution = conf.execution as Record<string, unknown> | undefined;
  const blocks = execution?.permissions as Record<string, { allowedTools?: unknown; inherit?: unknown }> | undefined;
  if (!blocks) return;

  const known = new Set<string>(RESERVED_TOOL_NAMES);
  for (const [stage, block] of Object.entries(blocks)) {
    if (block?.inherit !== undefined && typeof block.inherit === "string" && blocks[block.inherit] === undefined) {
      throw new NaxError(
        `Invalid configuration — execution.permissions.${stage}.inherit names "${block.inherit}", which is not a permission block.`,
        "CONFIG_PERMISSIONS_BAD_INHERIT",
        { stage: "config" },
      );
    }
    if (block?.allowedTools === undefined) continue;
    if (!Array.isArray(block.allowedTools)) continue;
    for (const expression of block.allowedTools) {
      if (typeof expression !== "string") continue;
      const open = expression.indexOf("(");
      const tool = (open === -1 ? expression : expression.slice(0, open)).trim();
      if (!known.has(tool)) {
        throw new NaxError(
          [
            `Invalid configuration — execution.permissions.${stage} grants unknown tool "${tool}".`,
            `Known tools: ${[...known].join(", ")}.`,
            "An unrecognised name would grant nothing while appearing to grant something.",
          ].join("\n"),
          "CONFIG_PERMISSIONS_UNKNOWN_TOOL",
          { stage: "config", tool },
        );
      }
      if (open !== -1 && !expression.trimEnd().endsWith(")")) {
        throw new NaxError(
          `Invalid configuration — execution.permissions.${stage} has an unclosed pattern list in "${expression}".`,
          "CONFIG_PERMISSIONS_BAD_PATTERN",
          { stage: "config" },
        );
      }
    }
  }
}
```

Call it from `src/config/loader.ts` where the two removed guards were:

```typescript
  // The block is enforced now, so validate it rather than reject it.
  validatePermissionsBlock(rawConfig);
```

Add these cases to `test/unit/config/scoped-profile-accepted.test.ts`:

```typescript
import { validatePermissionsBlock } from "@/config/config-guards";

describe("validatePermissionsBlock", () => {
  test("accepts a well-formed block", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { review: { allowedTools: ["Read", "Git(diff)"] } } } }),
    ).not.toThrow();
  });

  test("rejects an unknown tool name rather than granting nothing", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { review: { allowedTools: ["Reed"] } } } }),
    ).toThrow(/unknown tool/i);
  });

  test("rejects an inherit target that does not exist", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { review: { inherit: "nowhere" } } } }),
    ).toThrow(/inherit/i);
  });

  test("rejects an unclosed pattern list", () => {
    expect(() =>
      validatePermissionsBlock({ execution: { permissions: { run: { allowedTools: ["Write(src/**"] } } } }),
    ).toThrow(/unclosed/i);
  });

  test("ignores config with no permissions block", () => {
    expect(() => validatePermissionsBlock({ execution: {} })).not.toThrow();
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/config
```
Expected: PASS.

- [ ] **Step 6: Write the live probe**

Create `scripts/probe-native-coding-tools.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Live proof that the gate says no.
 *
 * Compiling proves the parts typecheck; only an end-to-end trace proves it
 * runs. Phase B shipped unreachable because nothing supplied transcriptDir and
 * every per-task review still passed — each task was right in isolation.
 *
 * Usage: bun scripts/probe-native-coding-tools.ts
 * Exits non-zero if a denial did not reach the caller, or if a file appeared
 * outside the root.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

const base = mkdtempSync(join(tmpdir(), "nax-probe-"));
const root = join(base, "repo");
const outside = join(base, "outside");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");

const runtime = createCodingToolRuntime({
  // "*" is the unrestricted-equivalent grant: the widest config can express.
  policy: compileToolPolicy([{ tool: "Write", patterns: ["*"] }, { tool: "Read", patterns: ["*"] }], root),
});

const escapeTarget = join(outside, "escaped.txt");
const denied = await runtime.callTool("Write", { path: escapeTarget, content: "should never land" });
const allowed = await runtime.callTool("Read", { path: "src/a.ts" });

const failures: string[] = [];
if (denied.kind !== "denied") failures.push(`expected a denial for a write outside the root, got "${denied.kind}"`);
if (denied.kind === "denied" && !denied.breach) failures.push("expected the denial to be flagged as a breach");
if (existsSync(escapeTarget)) failures.push(`FILE WAS WRITTEN OUTSIDE THE ROOT: ${escapeTarget}`);
if (allowed.kind !== "ok") failures.push(`expected the in-root read to succeed, got "${allowed.kind}"`);

if (failures.length > 0) {
  console.error("probe FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("probe OK: unrestricted-equivalent grants still deny outside the root; no file escaped.");
```

- [ ] **Step 7: Run the probe**

Run: `bun scripts/probe-native-coding-tools.ts`
Expected: `probe OK: ...` and exit 0.

- [ ] **Step 8: Amend the #374 spec**

In `docs/specs/scoped-permissions.md`, replace the section 2.3 backend-mapping table with:

```markdown
### 2.3 Backend mapping

Two enforcement models now exist, and they are not variations of each other.

**ACP path (acpx) — delegated.** nax resolves a mode and passes a flag; the
downstream agent enforces it. `unrestricted` maps to `--approve-all`, `safe` to
the default prompt mode. Scoped allowlists are NOT available here: acpx offers
approve-all, approve-reads and deny-all, and the ACP specification leaves
permission granularity to the client by design.

**Native path — enforced by nax.** There is no flag and no downstream agent.
nax executes each tool itself and gates every call against the compiled policy,
so `allowedTools` is enforced directly. See
`docs/superpowers/specs/2026-09-02-native-coding-tools-phase-c1-design.md`.

The original flag-mapping table assumed delegation was the only model and has
been removed. Sections 2.1, 2.2 and 2.4 are unchanged and describe both paths.

**Still out of scope:** every `Bash(...)` example below. Phase C1 ships no Bash
tool, so a stage whose allowlist names Bash is accepted by config and simply has
no Bash to grant.
```

- [ ] **Step 9: Full gate**

```bash
bun run typecheck
bun run lint
bun run test
```
Expected: all PASS, all 23 gates green.

- [ ] **Step 10: Format and commit**

```bash
bun x biome check --write src scripts test
git add -A
git commit -m "feat(config): enable the scoped permission profile now that nax enforces it"
```

---

## Post-Plan: Validation Run

Not a task — the A/B that produces the evidence ADR-029 section 2 asked for and that design section 2 records as waived.

Same fixture as the Phase B A/B, but **with a planted defect**, and with the review ops now declaring `Read`/`Glob`/`Grep`/`Git`:

1. Plant a defect a diff-only reviewer cannot see — a caller in an unchanged file that the changed signature breaks.
2. Run the review ops native, and again on acpx.
3. Measure **catch rate**, not agreement. Phase B's "same verdict" was two agents agreeing that clean code was clean.
4. Record whether native's cost advantage survives cross-file reading, which adds tool round-trips.

State plainly in the write-up that native is scoped to the root while acpx under `--approve-all` is not. That is a real behavioural difference, and it makes the comparison tighter-but-not-equal rather than parity.
