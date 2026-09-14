# Permission Substrate (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the native-agent permission substrate — three-state policy verdicts (allow/ask/deny), `allow`/`deny`/`ask` rule lists in `execution.permissions` evaluated under every profile, and the `AskResolver` seam — with byte-identical behavior for every existing config.

**Architecture:** A new `src/permissions/` module owns rule types, the expression grammar, and the ask seam. `resolvePermissions` (staying in `src/config/permissions.ts` — see Deviations) resolves per-stage rule lists under every profile per spec R10. `compileToolPolicy` gains deny/ask evaluation alongside the existing allow matching; `runtime.callTool` is the single async site that resolves an `ask` verdict through the injected resolver (headless v1: always deny, distinct ledger outcome `denied:ask`).

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome, Zod v4.

**Spec:** `docs/superpowers/specs/2026-09-13-nax-native-permission-subsystem-design.md` (§3 R1/R3/R5/R6/R10, §4 US-001/US-002/US-003/US-007, §5 steps 1–3, §6). Plan B (Bash tool, `Mcp(...)`, MCP-under-scoped, redirects, ADR) is a separate plan and NOT in scope here.

## Global Constraints

- **Regression gate:** a config that uses only today's surface (`permissionProfile`, `allowedTools`, `inherit`) must produce identical advertised tool sets and identical verdicts before and after this plan (spec §5 step 1).
- Bun-native only (`Bun.file`, `Bun.spawn`, `Bun.sleep`); no Node fs/child_process in `src/`.
- New `src/` files: ≤600 lines, ≥0.8 per-file coverage (`bun run test:coverage` is a separate gate — run it explicitly). Test files ≤800 lines.
- Every directory with 2+ exports gets a barrel; `src/` imports barrels only (`check:alias-internals`); tests may reach internals via `@/...`.
- `as never` is lint-banned repo-wide; annotate bindings instead of asserting literals (test escape-hatch ratchet).
- No fixed-duration sleeps in tests; no `mock.module()` — `_deps` injection only.
- Permission-mode literals (`"approve-all"`/`"approve-reads"`) outside `src/config/permissions.ts` need `// nax-permission-mode-allow: <reason>` (enforced by `scripts/check-permission-mode-ssot.ts`).
- Conventional commits; one concern per commit. Never `git push` unless told.
- `Mcp(...)` expressions remain load-time errors in this plan (`CONFIG_PERMISSIONS_UNKNOWN_TOOL`) — expansion is Plan B (spec R7); accepting the syntax without expansion would recreate the provider-tools R3 trap (a grant that matches nothing while parser tests stay green).

**Deviations from the spec (deliberate — record ALL of these in the PR):**
1. (US-001) `resolvePermissions`/`resolveScopedPermissions` stay in `src/config/permissions.ts` rather than moving to `src/permissions/resolve.ts` — that path is pinned by `scripts/check-permission-mode-ssot.ts`, CLAUDE.md's "Permission Resolution (Mandatory)" section, and `.nax/rules/` references; moving it is churn with no behavior change. `src/permissions/` owns what is NEW: rule types, grammar, ask seam. `bash-rules.ts` from the spec's file list is Plan B.
2. (US-003) `PolicyVerdict`'s false branch carries an **optional** `outcome?: "denied" | "ask"` (absent = denied), not the spec's required `outcome: "denied" | "denied:ask"` — the optional field keeps every existing verdict-constructing site and test fixture valid, and `denied:ask` exists at the ledger (`ToolCallRecord.outcome`), which is where the spec's telemetry requirement actually bites.
3. (US-001) No `RuleSet` type: `compileToolPolicy` keeps its `ToolGrant[]` first parameter and takes `denyRules`/`askRules` via options; `ResolvedPermissions` carries the same three lists. Equivalent data, far smaller diff, and the byte-identity gate is easier to prove.
4. (US-002) The "a deny/ask rule for a tool never allowable at any layer is a warn, not an error" nicety is dropped from Plan A (dead rules are silently legal); revisit in Plan B alongside `Mcp(...)` validation if wanted.
5. (Task 3 semantics) For a tool the profile baseline already grants, a block `allow` rule REPLACES that tool's compiled patterns (last-write-wins) rather than unioning — this preserves the shipped compiler byte-for-byte and matches the documented `Exec(...)`-replaces-`BUILT_IN_EXEC_PATTERNS` semantics; spec R10's "allow adds" holds for tools the baseline lacks.

---

### Task 1: `src/permissions/` module — rule types, grammar, ask seam

**Files:**
- Create: `src/permissions/types.ts`
- Create: `src/permissions/grammar.ts`
- Create: `src/permissions/ask.ts`
- Create: `src/permissions/index.ts` (barrel)
- Modify: `src/config/permissions.ts` (delete local `parseToolExpression`, import from `@/permissions`)
- Test: `test/unit/permissions/grammar.test.ts`, `test/unit/permissions/ask.test.ts`

**Interfaces:**
- Consumes: `ToolGrant` from `@/tools` (type-only import — keeps `src/permissions` out of runtime import cycles; `check:import-cycles` excludes type-only edges).
- Produces (later tasks rely on these exact names):
  - `parseToolExpression(expression: string): ToolGrant` (moved verbatim from `src/config/permissions.ts:144-154`)
  - `parseRuleList(expressions: readonly string[]): ToolGrant[]`
  - `interface AskRequest { readonly tool: string; readonly stage: string; readonly rule: string; readonly summary: string }`
  - `interface AskResolver { resolve(req: AskRequest): Promise<"allow" | "deny"> }`
  - `const ASK_UNAVAILABLE_REASON: string`
  - `function headlessAskResolver(): AskResolver`

- [ ] **Step 1: Write the failing tests**

`test/unit/permissions/grammar.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseRuleList, parseToolExpression } from "@/permissions";

describe("parseToolExpression", () => {
  test.each([
    ["Read", { tool: "Read", patterns: ["*"] }],
    ["Write(src/**,test/**)", { tool: "Write", patterns: ["src/**", "test/**"] }],
    ["Git(diff,log)", { tool: "Git", patterns: ["diff", "log"] }],
    ["Bash(bun test *)", { tool: "Bash", patterns: ["bun test *"] }],
    ["Write()", { tool: "Write", patterns: ["*"] }],
    ["  Read  ", { tool: "Read", patterns: ["*"] }],
  ])("parses %s", (expression, expected) => {
    expect(parseToolExpression(expression)).toEqual(expected);
  });
});

describe("parseRuleList", () => {
  test("parses each expression into a grant", () => {
    expect(parseRuleList(["Read", "Write(src/**)"])).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: ["src/**"] },
    ]);
  });

  test("empty list yields empty array", () => {
    expect(parseRuleList([])).toEqual([]);
  });
});
```

`test/unit/permissions/ask.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ASK_UNAVAILABLE_REASON, headlessAskResolver } from "@/permissions";

describe("headlessAskResolver", () => {
  test("always resolves to deny", async () => {
    const resolver = headlessAskResolver();
    const decision = await resolver.resolve({
      tool: "Write",
      stage: "run",
      rule: "Write(src/**)",
      summary: "Write src/x.ts",
    });
    expect(decision).toBe("deny");
  });

  test("ASK_UNAVAILABLE_REASON names the headless limitation", () => {
    expect(ASK_UNAVAILABLE_REASON).toContain("headless");
    expect(ASK_UNAVAILABLE_REASON).toContain("approval");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/permissions/ --timeout=30000`
Expected: FAIL — `Cannot find module '@/permissions'`.

- [ ] **Step 3: Implement the module**

`src/permissions/types.ts`:

```typescript
/**
 * Permission-subsystem types (spec 2026-09-13 native-permission-subsystem).
 *
 * Rules reuse the ToolGrant shape — {tool, patterns} — with the EFFECT carried
 * by which list a rule sits in (allow/deny/ask), never inside the rule itself.
 * Precedence is deny > ask > allow (spec R6) and is enforced where rules are
 * evaluated (src/tools/policy.ts), not where they are declared.
 */
import type { ToolGrant } from "@/tools";

/** What a matched `ask` rule needs answered before the call may run. */
export interface AskRequest {
  readonly tool: string;
  /** PipelineStage at the time of the call; a plain string here to keep this
   * module free of value imports from src/config. */
  readonly stage: string;
  /** The rule expression that matched, verbatim from config. */
  readonly rule: string;
  /** One human-readable line describing the attempted call. */
  readonly summary: string;
}

/**
 * The seam an interactive approval channel later plugs into (spec R1).
 * Injected where the runtime is created — a runtime capability, not config.
 */
export interface AskResolver {
  resolve(req: AskRequest): Promise<"allow" | "deny">;
}

export type { ToolGrant };
```

`src/permissions/grammar.ts` — move `parseToolExpression` from `src/config/permissions.ts:144-154` **verbatim** (same doc comment, now `export`ed) and add:

```typescript
/** Parse a list of rule expressions into grants. Effect is carried by which
 * config list (allow/deny/ask) the expressions came from, not by the grant. */
export function parseRuleList(expressions: readonly string[]): ToolGrant[] {
  return expressions.map(parseToolExpression);
}
```

`src/permissions/ask.ts`:

```typescript
import type { AskResolver } from "./types";

/**
 * Why a headless run refuses an ask-matched call. Distinct from an ordinary
 * denial on purpose: the command is not forbidden, it is unapprovable HERE
 * (spec US-007). The ledger outcome `denied:ask` is how demand for the
 * interactive channel is measured before anyone builds it.
 */
export const ASK_UNAVAILABLE_REASON =
  "matched an ask rule requiring human approval; this run is headless, so approval is unavailable and the call is refused";

/** The only v1 resolver: always deny (spec R1 — ask resolves to deny headless). */
export function headlessAskResolver(): AskResolver {
  return {
    resolve() {
      return Promise.resolve("deny");
    },
  };
}
```

`src/permissions/index.ts`:

```typescript
export { ASK_UNAVAILABLE_REASON, headlessAskResolver } from "./ask";
export { parseRuleList, parseToolExpression } from "./grammar";
export type { AskRequest, AskResolver } from "./types";
```

In `src/config/permissions.ts`: delete the local `parseToolExpression` (lines 137–154) and add `import { parseToolExpression } from "@/permissions";`. No other change in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/permissions/ test/unit/config/permissions.test.ts --timeout=30000`
Expected: PASS (including the existing config permissions suite — behavior unchanged).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint && bun run typecheck`
Expected: clean — in particular `check:alias-internals` (barrel exists from the first file) and `check:import-cycles` (only type-only edges into `@/tools`).

```bash
git add src/permissions test/unit/permissions src/config/permissions.ts
git commit -m "feat(permissions): permission-subsystem module — rule grammar and ask seam"
```

---

### Task 2: Schema + load-time validation for `allow`/`deny`/`ask`

**Files:**
- Modify: `src/config/schemas-execution.ts:183-190` (`PermissionBlockSchema`)
- Modify: `src/config/config-guards.ts:311-380` (`validatePermissionsBlock`)
- Test: `test/unit/config/scoped-profile-accepted.test.ts` (extend — this 119-line file is where the existing `validatePermissionsBlock` suite and its throw-assertion conventions live, e.g. message-regex assertions like `/unknown tool "Reed"/` at :42-60). NOT `config-guards.test.ts` — that file tests only `warnQualityCommandChains`. Related suites your Step 4 run also exercises: `scoped-permissions.test.ts`, `scoped-profile-guard.test.ts`, `permissions-exec-grant.test.ts`.

**Interfaces:**
- Produces: config keys `execution.permissions.<stage>.{allow,deny,ask}` (each `string[]`, optional, `.strict()` block); load error codes `CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT` (new), plus the existing `CONFIG_PERMISSIONS_UNKNOWN_TOOL` / `CONFIG_PERMISSIONS_BAD_PATTERN` now applied to all four lists.
- Consumes: `RESERVED_TOOL_NAMES` from `@/tools` (already imported in config-guards).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/config/scoped-profile-accepted.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { validatePermissionsBlock } from "@/config/config-guards";

const conf = (block: Record<string, unknown>) => ({ execution: { permissions: { run: block } } });

describe("validatePermissionsBlock — allow/deny/ask lists", () => {
  test("accepts allow, deny and ask lists of known tools", () => {
    expect(() =>
      validatePermissionsBlock(
        conf({ allow: ["Read", "Write(src/**)"], deny: ["Delete"], ask: ["GitCommit"] }),
      ),
    ).not.toThrow();
  });

  test("rejects a block carrying both allowedTools and allow", () => {
    expect(() => validatePermissionsBlock(conf({ allowedTools: ["Read"], allow: ["Read"] }))).toThrow(
      /CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT|both "allowedTools" and "allow"/,
    );
  });

  test.each(["allow", "deny", "ask"] as const)("rejects an unknown tool in %s", (key) => {
    expect(() => validatePermissionsBlock(conf({ [key]: ["Ncat(payload)"] }))).toThrow(/unknown tool "Ncat"/);
  });

  test.each(["allow", "deny", "ask"] as const)("rejects an unclosed pattern list in %s", (key) => {
    expect(() => validatePermissionsBlock(conf({ [key]: ["Write(src/**"] }))).toThrow(/unclosed pattern list/);
  });

  test("still validates the legacy allowedTools list", () => {
    expect(() => validatePermissionsBlock(conf({ allowedTools: ["Nope"] }))).toThrow(/unknown tool "Nope"/);
  });
});
```

Note on the thrown shape: match the existing file's convention for asserting `NaxError` codes (it asserts on message or on `err.code` — copy whichever pattern the neighboring tests use).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config/scoped-profile-accepted.test.ts --timeout=30000`
Expected: FAIL — the `.strict()` schema is not in play here (guards read raw config), so failures are: alias conflict not thrown, `deny`/`ask` lists not scanned.

- [ ] **Step 3: Implement**

`src/config/schemas-execution.ts` — extend `PermissionBlockSchema` (keep `.strict()`):

```typescript
const PermissionBlockSchema = z
  .object({
    // Declares the vocabulary the SSOT resolver reads; decides nothing.
    mode: z.enum(["approve-all", "approve-reads", "scoped"]).optional(), // nax-permission-mode-allow: schema declares the field's accepted values, resolvePermissions decides
    /** Legacy alias of `allow` (#374 shape). A block may carry one, never both. */
    allowedTools: z.array(z.string()).optional(),
    /** Rule lists (spec 2026-09-13 §4 US-002). Precedence: deny > ask > allow. */
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    inherit: z.string().optional(),
  })
  .strict();
```

`src/config/config-guards.ts` — inside `validatePermissionsBlock`'s per-stage loop:

1. Widen the local `blocks` type annotation to `Record<string, { allowedTools?: unknown; allow?: unknown; deny?: unknown; ask?: unknown; inherit?: unknown }>`.
2. After the inherit-cycle walk, add the alias-conflict check:

```typescript
    if (block?.allowedTools !== undefined && block?.allow !== undefined) {
      throw new NaxError(
        [
          `Invalid configuration — execution.permissions.${stage} carries both "allowedTools" and "allow".`,
          `"allowedTools" is the legacy alias of "allow"; a block may use one, never both,`,
          "because a merge would silently decide which list wins.",
        ].join("\n"),
        "CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT",
        { stage: "config" },
      );
    }
```

3. Replace the single `allowedTools` expression scan (`config-guards.ts:354-378`) with a loop over all four lists, hoisting the existing expression checks into a local helper so the messages keep naming the stage:

```typescript
    for (const key of ["allowedTools", "allow", "deny", "ask"] as const) {
      const list = block?.[key];
      if (list === undefined || !Array.isArray(list)) continue;
      for (const expression of list) {
        if (typeof expression !== "string") continue;
        validateToolExpression(stage, expression, known);
      }
    }
```

where `validateToolExpression(stage, expression, known)` is a module-private function containing the exact unknown-tool and unclosed-pattern throws currently inlined at `config-guards.ts:356-377` (same messages, same codes).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config/ --timeout=30000`
Expected: PASS, including all pre-existing config-guards and schema tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas-execution.ts src/config/config-guards.ts test/unit/config
git commit -m "feat(config): allow/deny/ask rule lists in execution.permissions with load-time validation"
```

---

### Task 3: `resolvePermissions` — rules under every profile (spec R10)

**Files:**
- Modify: `src/config/permissions.ts`
- Test: `test/unit/config/permissions.test.ts` (extend; split into `permissions-rules.test.ts` beside it if the file nears 800 lines)

**Interfaces:**
- Produces: `ResolvedPermissions` gains two optional fields consumed by Task 6:

```typescript
export interface ResolvedPermissions {
  mode: "approve-all" | "approve-reads" | "default";
  toolGrants?: readonly ToolGrant[];
  /** Deny rules for the stage (spec R6: deny > ask > allow). Same {tool, patterns} shape. */
  denyRules?: readonly ToolGrant[];
  /** Ask rules for the stage; resolved by an AskResolver at call time (spec R1). */
  askRules?: readonly ToolGrant[];
}
```

- Consumes: `parseRuleList` from `@/permissions` (Task 1).

**Semantics to implement (spec R10 + R6):**
- The per-stage block lookup (stage → `inherit` chain → `default` → none) runs for **every** profile, not only `scoped`. Extract the walk currently inside `resolveScopedPermissions` (`permissions.ts:203-224`) into a private `lookupStageBlock(blocks, stage)` returning the resolved block or `undefined`; `resolveScopedPermissions`'s observable behavior is preserved through it.
- A block's rule lists resolve as: `allow` = `block.allow ?? block.allowedTools ?? []` (the load guard from Task 2 makes both-present unreachable), `deny` = `block.deny ?? []`, `ask` = `block.ask ?? []`.
- Profile baselines are unchanged: `unrestricted` keeps `unconditionalGrants([...DEFAULT_CODING_TOOLS, "Write", ..., EXEC_TOOL_NAME])`; `safe` keeps `unconditionalGrants(DEFAULT_CODING_TOOLS)`; `scoped` keeps no baseline. The block's `allow` rules are **concatenated after** the baseline (`toolGrants: [...baseline, ...allowRules]`). ⚠️ The grant compiler (`policy.ts:202-211`) is **last-write-wins per tool** — do NOT change that (regression gate). Consequences, both intended: an allow rule for a NEW tool adds it; an allow rule for a tool the baseline already grants **replaces** that tool's patterns at the policy level (e.g. `allow: ["Exec(bun x tsc*)"]` under `unrestricted` replaces `BUILT_IN_EXEC_PATTERNS`, matching the documented "a project's own Exec(...) REPLACES this list" semantics at `permissions.ts:100-111`). Task 7 pins last-write-wins with a test.
- `deny`/`ask` lists attach under every profile including the invalid-profile arm's fail-closed return? No — the invalid arm (`permissions.ts:183-189`) stays exactly as it is (no grants, no rules): config validation was bypassed, nothing from that config is trusted.
- No-blocks configs are byte-identical to today: `unrestricted`/`safe` return exactly the current objects (assert with `toEqual` against the pre-change literals); `scoped` with no blocks returns `{ mode: "approve-reads", toolGrants: [] }` as now.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { resolvePermissions } from "@/config/permissions";
import { makeNaxConfig } from "@test/helpers";

// NEVER `as unknown as` — the check:test-as-unknown-as ratchet fails CI on any
// new occurrence. Mirror test/unit/config/scoped-permissions.test.ts:6-9's
// sanctioned idiom: makeNaxConfig(...) from @test/helpers takes a DeepPartial.
const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

describe("resolvePermissions — rules under every profile (spec R10)", () => {
  test("unrestricted with no permissions block is byte-identical to today", () => {
    const resolved = resolvePermissions(cfg({ permissionProfile: "unrestricted" }), "run");
    expect(resolved.mode).toBe("approve-all");
    expect(resolved.denyRules).toBeUndefined();
    expect(resolved.askRules).toBeUndefined();
    expect(resolved.toolGrants).toEqual(
      resolvePermissions(cfg({ permissionProfile: "unrestricted" }), "verify").toolGrants,
    );
  });

  test("deny and ask rules attach under unrestricted", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "unrestricted",
        permissions: { run: { deny: ["Delete"], ask: ["GitCommit"] } },
      }),
      "run",
    );
    expect(resolved.mode).toBe("approve-all");
    expect(resolved.denyRules).toEqual([{ tool: "Delete", patterns: ["*"] }]);
    expect(resolved.askRules).toEqual([{ tool: "GitCommit", patterns: ["*"] }]);
  });

  test("allow rules extend the unrestricted baseline (extra Exec patterns)", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "unrestricted",
        permissions: { run: { allow: ["Exec(bun x tsc*)"] } },
      }),
      "run",
    );
    expect(resolved.toolGrants).toContainEqual({ tool: "Exec", patterns: ["bun x tsc*"] });
    // Baseline grants for OTHER tools stay. (At resolve level both Exec grants
    // are present; at compile level last-write-wins means the allow rule
    // replaces Exec's baseline patterns — see the Semantics block and Task 7.)
    expect(resolved.toolGrants?.some((g) => g.tool === "Read" && g.patterns.includes("*"))).toBe(true);
  });

  test("safe profile: rules attach, baseline stays reads-only", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "safe", permissions: { run: { deny: ["Read(.env*)"] } } }),
      "run",
    );
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.toolGrants?.map((g) => g.tool)).toEqual(["Read", "Glob", "Grep"]);
    expect(resolved.denyRules).toEqual([{ tool: "Read", patterns: [".env*"] }]);
  });

  test("scoped: allow is an alias-compatible replacement for allowedTools", () => {
    const viaAlias = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { run: { allowedTools: ["Read", "Write(src/**)"] } } }),
      "run",
    );
    const viaAllow = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Write(src/**)"] } } }),
      "run",
    );
    expect(viaAllow).toEqual(viaAlias);
  });

  test("inherit carries all three lists", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "scoped",
        permissions: {
          run: { allow: ["Read"], deny: ["Delete"], ask: ["GitCommit"] },
          verify: { inherit: "run" },
        },
      }),
      "verify",
    );
    expect(resolved.toolGrants).toEqual([{ tool: "Read", patterns: ["*"] }]);
    expect(resolved.denyRules).toEqual([{ tool: "Delete", patterns: ["*"] }]);
    expect(resolved.askRules).toEqual([{ tool: "GitCommit", patterns: ["*"] }]);
  });

  test("scoped with no block for the stage and no default: no grants, no rules", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { plan: { allow: ["Read"] } } }),
      "run",
    );
    expect(resolved).toEqual({ mode: "approve-reads", toolGrants: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config/permissions*.test.ts --timeout=30000`
Expected: FAIL — `denyRules`/`askRules` undefined where expected, `allow` key ignored, rules not attached under `unrestricted`/`safe`.

- [ ] **Step 3: Implement in `src/config/permissions.ts`**

Shape (the switch stays; each arm composes with the resolved block):

```typescript
interface StageBlock {
  allowedTools?: string[];
  allow?: string[];
  deny?: string[];
  ask?: string[];
  inherit?: string;
}

/** Stage -> inherit chain -> `default` -> undefined. The walk formerly inside
 * resolveScopedPermissions; now shared by every profile (spec R10). */
function lookupStageBlock(
  blocks: Record<string, StageBlock | undefined> | undefined,
  stage: PipelineStage,
): StageBlock | undefined {
  if (!blocks) return undefined;
  const seen = new Set<string>();
  let key: string | undefined = stage;
  let block = blocks[stage];
  while (block?.inherit !== undefined && key !== undefined && !seen.has(key)) {
    seen.add(key);
    key = block.inherit;
    block = blocks[key];
  }
  return block ?? blocks.default;
}

interface StageRules {
  readonly allow: readonly ToolGrant[];
  readonly deny: readonly ToolGrant[];
  readonly ask: readonly ToolGrant[];
}

function stageRules(config: AgentManagerConfig | undefined, stage: PipelineStage): StageRules {
  const blocks = config?.execution?.permissions as Record<string, StageBlock | undefined> | undefined;
  const block = lookupStageBlock(blocks, stage);
  return {
    allow: parseRuleList(block?.allow ?? block?.allowedTools ?? []),
    deny: parseRuleList(block?.deny ?? []),
    ask: parseRuleList(block?.ask ?? []),
  };
}

/** Attach rule fields only when non-empty, so no-block configs stay
 * byte-identical to the pre-rules shape (the regression gate). */
function withRules(base: ResolvedPermissions, rules: StageRules): ResolvedPermissions {
  return {
    ...base,
    ...(rules.allow.length > 0 ? { toolGrants: [...(base.toolGrants ?? []), ...rules.allow] } : {}),
    ...(rules.deny.length > 0 ? { denyRules: rules.deny } : {}),
    ...(rules.ask.length > 0 ? { askRules: rules.ask } : {}),
  };
}
```

`resolvePermissions` arms become:

```typescript
  const rules = stageRules(config, _stage);
  switch (profile) {
    case "unrestricted":
      return withRules({ mode: "approve-all", toolGrants: unconditionalGrants([/* unchanged list */]) }, rules);
    case "safe":
      return withRules({ mode: "approve-reads", toolGrants: unconditionalGrants(DEFAULT_CODING_TOOLS) }, rules);
    case "scoped":
      // No baseline: withRules concatenates the block's allow rules onto [].
      return withRules({ mode: "approve-reads", toolGrants: [] }, rules);
    default: /* unchanged fail-closed arm */
  }
```

For the `scoped` arm, preserve the existing no-block/no-allow result exactly: when the lookup found no block or the block has no allow list, return `{ mode: "approve-reads", toolGrants: [] }` (with deny/ask rules still attached if the block declared them). **Keep the `resolveScopedPermissions` name** — refactor its body to use `lookupStageBlock` + `withRules`, and keep its doc comment (the "#374" and containment-note prose). The name is referenced by comments in `config-guards.ts:326` and `schemas-execution.ts:194`, by CLAUDE.md's "Permission Resolution" section, and by `.nax/rules`-generated docs; deleting it would strand all of those (and CLAUDE.md is generated — never hand-edit it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config/ --timeout=30000`
Expected: PASS — new tests and every pre-existing permissions test (the byte-identity assertions are the regression gate).

- [ ] **Step 5: Commit**

```bash
git add src/config/permissions.ts test/unit/config
git commit -m "feat(permissions): resolve allow/deny/ask stage rules under every profile (spec R10)"
```

---

### Task 4: `PolicyVerdict` three-state + deny/ask evaluation in `compileToolPolicy`

**Files:**
- Modify: `src/tools/types.ts:109-111` (`PolicyVerdict`)
- Modify: `src/tools/policy.ts` (compile deny/ask; evaluate in `check()`; `grantedTools()` excludes unconditionally-denied tools)
- Test: `test/unit/tools/policy.test.ts` (416 lines today — room to extend; split into `test/unit/tools/policy-rules.test.ts` only if it approaches the 800-line cap)

**Interfaces:**
- Produces:

```typescript
// src/tools/types.ts
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly breach: boolean;
      /**
       * "ask": every OTHER gate passed and an ask rule matched — an AskResolver
       * may approve it (spec R1). Absent or "denied": final. `allowed: false`
       * for the ask shape on purpose: any consumer that only reads `allowed`
       * fails closed.
       */
      readonly outcome?: "denied" | "ask";
      /** Present only with outcome "ask": what an approval would admit. */
      readonly resolvedPaths?: readonly string[];
    };
```

- `ToolPolicyOptions` gains `readonly denyRules?: readonly ToolGrant[]` and `readonly askRules?: readonly ToolGrant[]`.
- Consumes: `ResolvedPermissions.denyRules`/`askRules` shapes from Task 3 (plumbed in Task 6; this task tests the policy directly).

**Semantics (spec R6 — deny > ask > allow, evaluated per branch):**
- Compile `denyRules`/`askRules` with the same per-tool structure grants use (`unconditional` / `matchers` / `argvPatterns`); multiple rules for one tool merge into one entry (patterns concatenated, `"*"` ⇒ unconditional).
- `check()` order per call:
  1. Unknown tool → deny (unchanged).
  2. Unconditional deny entry for the tool → deny immediately: `` `tool "${tool}" is denied for this stage by rule ${sourceExpr}` `` where `sourceExpr` is `Tool` or `Tool(patterns...)` reconstructed from the raw patterns.
  3. Argv branch: `validateArgv` first (unchanged); then deny-entry argv match → deny; then ask-entry argv match → mark ask; then the existing allow match. The ask mark does not short-circuit — allow matching still runs, because an ask on a call the stage never granted is a plain denial (`ask` gates granted calls, it does not grant).
  4. Verb branch: verb ∈ deny entry's raw patterns → deny; verb ∈ ask entry's raw patterns → mark ask; existing tool-allowedVerbs and grant checks unchanged.
  5. Path loops (all four field kinds): for each resolved path, deny-glob match → deny (reason `` `${tool} path "${rel}" is denied for this stage` ``); ask-glob match → mark ask. Containment (`resolveWithin`) still runs first and its `breach` denial wins over everything.
  6. If nothing denied, allow checks passed, and any ask mark was set → return `{ allowed: false, reason, breach: false, outcome: "ask", resolvedPaths }` with `reason` naming the matched rule expression. Otherwise the existing allow verdict.
- Deny/ask matchers are NOT filtered through `pathMatchers`' verb-name exclusion the way allow matchers are: a deny entry's patterns are matched as verbs in the verb branch and as path globs in the path loops, whichever branch is active — mirror how the allow grant's `raw`/`matchers` are consulted per branch.
- `grantedTools()` returns grant keys minus tools with an **unconditional** deny entry, so `advertised()` (declared ∩ granted) stops advertising a tool config fully denied. A scoped (pattern) deny does not de-advertise.
- The `deny()` helper gains the optional outcome: `function deny(reason: string, breach = false): PolicyVerdict { return { allowed: false, reason, breach, outcome: "denied" }; }` — one site, every existing denial keeps working.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "@/tools";
import type { ToolScope } from "@/tools";

const ROOT = process.cwd(); // policy tests in this file already anchor on a real dir; reuse the existing helper if one exists
const pathScope: ToolScope = { pathFields: ["path"] };
const verbScope: ToolScope = { verbField: "subcommand", allowedVerbs: ["diff", "log", "show"], pathFields: [] };

describe("compileToolPolicy — deny rules (spec R6)", () => {
  test("unconditional deny beats an unconditional allow, and de-advertises", () => {
    const policy = compileToolPolicy([{ tool: "Delete", patterns: ["*"] }], ROOT, {
      denyRules: [{ tool: "Delete", patterns: ["*"] }],
    });
    const verdict = policy.check("Delete", pathScope, { path: "src/x.ts" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
    expect(policy.grantedTools()).not.toContain("Delete");
  });

  test("path-scoped deny refuses matching paths and leaves others allowed", () => {
    const policy = compileToolPolicy([{ tool: "Read", patterns: ["*"] }], ROOT, {
      denyRules: [{ tool: "Read", patterns: [".env*"] }],
    });
    expect(policy.check("Read", pathScope, { path: ".env.local" }).allowed).toBe(false);
    expect(policy.check("Read", pathScope, { path: "src/index.ts" }).allowed).toBe(true);
    expect(policy.grantedTools()).toContain("Read"); // scoped deny does not de-advertise
  });

  test("verb deny refuses the verb, allows siblings", () => {
    const policy = compileToolPolicy([{ tool: "Git", patterns: ["*"] }], ROOT, {
      denyRules: [{ tool: "Git", patterns: ["show"] }],
    });
    expect(policy.check("Git", verbScope, { subcommand: "show" }).allowed).toBe(false);
    expect(policy.check("Git", verbScope, { subcommand: "diff" }).allowed).toBe(true);
  });
});

describe("compileToolPolicy — ask rules (spec R1/R6)", () => {
  test("ask on a granted call yields outcome ask with resolvedPaths", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], ROOT, {
      askRules: [{ tool: "Write", patterns: ["src/**"] }],
    });
    const verdict = policy.check("Write", pathScope, { path: "src/x.ts" });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.outcome).toBe("ask");
      expect(verdict.breach).toBe(false);
      expect(verdict.resolvedPaths?.length).toBe(1);
    }
  });

  test("deny beats ask on the same call", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], ROOT, {
      denyRules: [{ tool: "Write", patterns: ["src/**"] }],
      askRules: [{ tool: "Write", patterns: ["src/**"] }],
    });
    const verdict = policy.check("Write", pathScope, { path: "src/x.ts" });
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });

  test("ask does not grant: an ungranted tool with an ask rule stays plainly denied", () => {
    const policy = compileToolPolicy([], ROOT, { askRules: [{ tool: "Write", patterns: ["*"] }] });
    const verdict = policy.check("Write", pathScope, { path: "src/x.ts" });
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });

  test("containment breach beats ask", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], ROOT, {
      askRules: [{ tool: "Write", patterns: ["*"] }],
    });
    const verdict = policy.check("Write", pathScope, { path: "../outside.ts" });
    expect(verdict.allowed === false && verdict.breach).toBe(true);
    expect(verdict.allowed === false && verdict.outcome).toBe("denied");
  });
});
```

Match the surrounding file's conventions for ROOT (it has existing fixtures/tmp-dir helpers — use those, not `process.cwd()`, if present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/tools/policy*.test.ts --timeout=30000`
Expected: FAIL — `denyRules`/`askRules` options unknown (typecheck) or ignored at runtime.

- [ ] **Step 3: Implement in `src/tools/policy.ts` + `src/tools/types.ts`**

- Extend `PolicyVerdict` per the interface block above.
- In `compileToolPolicy`, add a compile pass shared with grants:

```typescript
  interface CompiledEntry {
    unconditional: boolean;
    matchers: CompiledPattern[];
    argvPatterns: readonly (readonly CompiledPattern[])[];
    raw: readonly string[];
  }

  function compileRuleMap(rules: readonly ToolGrant[] | undefined): Map<string, CompiledEntry> {
    const map = new Map<string, CompiledEntry>();
    for (const rule of rules ?? []) {
      const existing = map.get(rule.tool);
      const patterns = existing === undefined ? rule.patterns : [...existing.raw, ...rule.patterns];
      const nonWildcard = patterns.filter((p) => p !== "*");
      map.set(rule.tool, {
        unconditional: patterns.includes("*"),
        matchers: nonWildcard.map((source) => ({ source, re: globToRegExp(source) })),
        argvPatterns: nonWildcard.map((source) => compileArgvPattern(source)),
        raw: patterns,
      });
    }
    return map;
  }

  const denyBy = compileRuleMap(options?.denyRules);
  const askBy = compileRuleMap(options?.askRules);
```

Do **NOT** route the existing allow-grant loop (`policy.ts:202-211`) through `compileRuleMap`: the allow compiler is last-write-wins per tool (`compiled.set` overwrites), and unifying it with `compileRuleMap`'s merge semantics silently changes verdicts for any config carrying two expressions for one tool — breaching the byte-identity regression gate. `compileRuleMap` (merge) is for `denyRules`/`askRules` ONLY, where merging is safe because the lists are new. Leave the grant loop untouched.

- `grantedTools()` becomes `[...compiled.keys()].filter((t) => denyBy.get(t)?.unconditional !== true)`.
- In `check()`:
  - After the unknown-tool guard: `const denyEntry = denyBy.get(tool); const askEntry = askBy.get(tool);` and the unconditional-deny short-circuit.
  - Argv branch: after `validateArgv`, `if (denyEntry !== undefined && (denyEntry.unconditional || matchesArgvGrant(denyEntry.argvPatterns, argv))) return deny(...)`; then compute `askMatched = askEntry !== undefined && (askEntry.unconditional || matchesArgvGrant(askEntry.argvPatterns, argv))`; run the existing allow logic; on the allow-success path, if `askMatched` return the ask verdict instead of `{allowed: true}`.
  - Verb branch: `denyEntry.raw.includes(verb)` (or unconditional) → deny; `askEntry` analog → set `askMatched`.
  - Path loops: alongside the existing `matchesAny(globs, rel)` allow check, add `if (denyEntry !== undefined && (denyEntry.unconditional || matchesAny(denyEntry.matchers, rel))) return deny(...)` and the ask analog setting `askMatched`. Deny check runs after containment, before the allow-glob check.
  - Final return: `askMatched ? askVerdict(resolvedPaths) : { allowed: true, resolvedPaths }` where

```typescript
  function askVerdict(resolvedPaths: readonly string[], rule: string): PolicyVerdict {
    return {
      allowed: false,
      reason: `matched ask rule "${rule}" — requires approval before it may run`,
      breach: false,
      outcome: "ask",
      resolvedPaths,
    };
  }
```

  Track WHICH ask pattern matched (`source` of the matching `CompiledPattern`, or the tool name for unconditional) so `rule` is concrete.
- `deny()` helper: add `outcome: "denied"`.
- Keep `check()` fully synchronous — the resolver is consulted in Task 5, not here.
- Watch the 600-line file limit: `policy.ts` is at 440 and this adds ~80–100. If it crosses 600, extract `compileRuleMap` + pattern helpers (`globToRegExp`, `compileArgvPattern`, `matchesArgvPattern`, `matchesAny`, `CompiledPattern`) into a new `src/tools/policy-match.ts` imported by `policy.ts` (tests may import it directly; `src/` reaches it only via `policy.ts`, keeping the barrel surface unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/tools/ --timeout=30000`
Expected: PASS — new rules tests plus every existing policy/exec-guard/narrow-grants test (allow-path behavior is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/tools/types.ts src/tools/policy.ts src/tools/policy-match.ts test/unit/tools 2>/dev/null || git add src/tools/types.ts src/tools/policy.ts test/unit/tools
git commit -m "feat(tools): three-state PolicyVerdict with deny/ask rule evaluation in compileToolPolicy"
```

---

### Task 5: Ask resolution in `callTool` + `denied:ask` ledger outcome

**Files:**
- Modify: `src/tools/runtime.ts` (resolver option; ask handling in `callTool`; `log()` outcome widening)
- Modify: `src/tools/tool-audit.ts:21` (`ToolCallRecord.outcome` union)
- Test: `test/unit/tools/runtime.test.ts` (extend the existing runtime suite)

**Interfaces:**
- Consumes: `AskResolver`, `headlessAskResolver`, `ASK_UNAVAILABLE_REASON` from `@/permissions`; `PolicyVerdict.outcome === "ask"` from Task 4.
- Produces: `createCodingToolRuntime` opts gain `askResolver?: AskResolver` (default `headlessAskResolver()`); `ToolCallRecord.outcome` becomes `"ok" | "error" | "denied" | "denied:ask"`. The model-facing `CodingToolOutcome` union is UNCHANGED — an ask-refusal surfaces as `kind: "denied"` with the distinct reason.

**Semantics (spec US-007):**
- `runtime.ts` is the sole caller of `policy.check` in `src/` (verified on main) — this is the one place an `ask` verdict is acted on.
- In `callTool`, after `const verdict = opts.policy.check(...)`:

```typescript
      if (!verdict.allowed && verdict.outcome === "ask") {
        const decision = await askResolver.resolve({
          tool: policyIdentity,
          stage: "unknown", // no stage in this layer; the ledger's session name carries role context
          rule: verdict.reason,
          summary: `${policyIdentity} ${JSON.stringify(input).slice(0, 200)}`,
        });
        if (decision === "allow") {
          // Approved: run with what the policy resolved for this call.
          return runTool(tool, input, verdict.resolvedPaths ?? []);
        }
        const reason = `${verdict.reason} -- ${ASK_UNAVAILABLE_REASON}`;
        log(policyIdentity, "denied:ask", reason.length, input, false, reason);
        return { kind: "denied", reason, breach: false };
      }
```

  where `runTool(tool, input, resolvedPaths)` is the existing try/catch execution block (`runtime.ts:247-272`) extracted into a local function so both the allow path and the approved-ask path share it (it already takes `verdict.resolvedPaths` — parameterize that).
- `log()`'s `outcome` parameter type widens to `CodingToolOutcome["kind"] | "denied:ask"`; the level rule treats `"denied:ask"` like a non-breach denial (`warn`).
- The existing `denied` branch is untouched; denial-redirect hints stay on plain denials only (Bash-aware redirects are Plan B US-008).
- Default resolver: `const askResolver = opts.askResolver ?? headlessAskResolver();` at runtime construction.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import type { AskResolver } from "@/permissions";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";
// Reuse the runtime test file's existing fixtures for a real tmp root + registered tools.

describe("callTool — ask resolution (spec US-007)", () => {
  test("headless default refuses an ask-matched call with the ask reason and ledgers denied:ask", async () => {
    const records: { outcome: string; reason?: string }[] = [];
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      sink: { record: (e) => void records.push(e), flush: async () => {} },
    });
    runtime.advertised(["Read"]);
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(outcome.reason).toContain("approval");
      expect(outcome.breach).toBe(false);
    }
    expect(records.at(-1)?.outcome).toBe("denied:ask");
  });

  test("an approving resolver lets the call run", async () => {
    const approveAll: AskResolver = { resolve: () => Promise.resolve("allow") };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      askResolver: approveAll,
    });
    runtime.advertised(["Read"]);
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("ok");
  });

  test("plain denials never consult the resolver", async () => {
    let consulted = 0;
    const counting: AskResolver = { resolve: () => (consulted++, Promise.resolve("allow")) };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([], root), // nothing granted
      askResolver: counting,
    });
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("denied");
    expect(consulted).toBe(0);
  });
});
```

Fixture reality check: `test/unit/tools/runtime.test.ts:19-22` has NO shared helpers — a plain inline `beforeAll` creating a mkdtemp root containing only `src/a.ts`. Your tests read `file.txt`, so create it explicitly or the GREEN step fails with `kind: "error"` (a missing file is a tool error, not a denial) and you will misdiagnose it:

```typescript
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-ask-"));
  writeFileSync(join(root, "file.txt"), "hello");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/tools/runtime*.test.ts --timeout=30000`
Expected: FAIL — `askResolver` opt unknown; ask verdict currently falls through the plain-denied branch without the ask reason or the `denied:ask` ledger row.

- [ ] **Step 3: Implement** per the Semantics block above (extract `runTool`, add the ask branch, widen `ToolCallRecord.outcome` and `log()`'s parameter, default the resolver).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/tools/ --timeout=30000`
Expected: PASS, existing runtime/denial-redirect tests included.

- [ ] **Step 5: Commit**

```bash
git add src/tools/runtime.ts src/tools/tool-audit.ts test/unit/tools
git commit -m "feat(tools): resolve ask verdicts through AskResolver; ledger outcome denied:ask"
```

---

### Task 6: Plumb rules and resolver through `coding-tool-support`

**Files:**
- Modify: `src/agents/coding-tool-support.ts`
- Test: `test/unit/agents/coding-tool-support.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: `ResolvedPermissions.denyRules`/`askRules` (Task 3); `ToolPolicyOptions.denyRules`/`askRules` (Task 4); `headlessAskResolver` default already applied inside `createCodingToolRuntime` (Task 5 — no resolver wiring needed here yet; the interactive channel later injects at this seam).
- Produces: `buildCodingToolSupport` args gain `denyRules?: readonly ToolGrant[]` and `askRules?: readonly ToolGrant[]`, forwarded into `compileToolPolicy`'s options (`coding-tool-support.ts:112`). `resolveCodingToolSupport` forwards `resolved.denyRules`/`resolved.askRules`.

**Semantics:**
- `compileToolPolicy(narrowGrants(grants, args.toolPatterns), args.root, { execTouchedPaths, ...(args.denyRules !== undefined ? { denyRules: args.denyRules } : {}), ...(args.askRules !== undefined ? { askRules: args.askRules } : {}) })`.
- `narrowGrants` applies to **allow** grants only — deny/ask rules bypass it by construction (they are separate arguments). Pin that with a test: an op `toolPatterns` narrowing must not erase a deny rule.
- The `grants.length === 0 → undefined` early-return (`coding-tool-support.ts:73`) stays: a deny/ask-only stage with zero allow grants advertises nothing, which is already the correct (empty) outcome.
- Provider gating (`providersPermitted`, line 274) is untouched — widening it is Plan B US-006.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { buildCodingToolSupport } from "@/agents/coding-tool-support"; // match the existing test file's import path
// Reuse the file's existing root fixture.

describe("buildCodingToolSupport — deny/ask plumbing", () => {
  test("a deny rule reaches the compiled policy", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Read", patterns: ["*"] }],
      declared: ["Read"],
      denyRules: [{ tool: "Read", patterns: [".env*"] }],
    });
    expect(support).toBeDefined();
    const denied = await support?.runtime.callTool("Read", { path: ".env.local" });
    expect(denied?.kind).toBe("denied");
    const allowed = await support?.runtime.callTool("Read", { path: "file.txt" });
    expect(allowed?.kind).toBe("ok");
  });

  test("op toolPatterns narrowing does not erase a deny rule", async () => {
    const support = buildCodingToolSupport({
      root,
      grants: [{ tool: "Write", patterns: ["*"] }],
      declared: ["Write"],
      toolPatterns: { Write: ["src/**"] },
      denyRules: [{ tool: "Write", patterns: ["src/generated/**"] }],
    });
    const denied = await support?.runtime.callTool("Write", {
      path: "src/generated/x.ts",
      content: "x",
    });
    expect(denied?.kind).toBe("denied");
  });
});
```

(Adjust `Write` input fields to the write tool's actual schema as the existing tests in the file use it.)

Fixture reality check: `test/unit/agents/coding-tool-support.test.ts:14-16` creates an **empty** mkdtemp root. The `Read` assertions above need `file.txt` to exist — `writeFileSync(join(root, "file.txt"), "x")` in the setup — or the "allowed" call returns `kind: "error"` instead of `"ok"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support*.test.ts --timeout=30000`
Expected: FAIL — `denyRules` arg unknown.

- [ ] **Step 3: Implement** — add the two optional args to `buildCodingToolSupport`, forward into `compileToolPolicy` options; in `resolveCodingToolSupport`, spread `...(resolved.denyRules !== undefined ? { denyRules: resolved.denyRules } : {})` and the `askRules` analog into the `buildCodingToolSupport` call (`coding-tool-support.ts:298-314`).

  Also change `coding-tool-support.ts:93` from `grants.find((grant) => grant.tool === EXEC_TOOL_NAME)` to `grants.findLast(...)`: Task 3 concatenates baseline + allow rules, and the compiled policy is last-write-wins per tool — `find` (first) would hand the RunCommand exec branch's advertised allowlist (`describeExecAllowlist`) the baseline patterns while the policy enforces the block's, telling the model forms are ungrantable that would actually pass. With a single Exec grant (every existing config) `findLast` ≡ `find`, so the regression gate holds. Add a test: unrestricted + `allow: ["Exec(bun x tsc*)"]` → the support's exec patterns are `["bun x tsc*"]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/agents/ --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/coding-tool-support.ts test/unit/agents
git commit -m "feat(agents): thread deny/ask rules from resolved permissions into the tool policy"
```

---

### Task 7: End-to-end equivalence + precedence suite, repo gates, wrap-up

**Files:**
- Create: `test/unit/permissions/substrate-equivalence.test.ts`
- Modify (docs, small): `docs/architecture/agent-adapters.md` §14 — one paragraph noting the rule lists and the ask seam, pointing at the spec (the full "Permissions" doc page is Plan B US-009).

**Interfaces:** consumes everything above; produces nothing new — this task is the spec §6 verification spine for Plan A.

- [ ] **Step 1: Write the end-to-end tests** (config → `resolvePermissions` → `compileToolPolicy` → verdicts):

```typescript
import { describe, expect, test } from "bun:test";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy } from "@/tools";
import { makeNaxConfig } from "@test/helpers";

// NEVER `as unknown as` — the check:test-as-unknown-as ratchet fails CI on any
// new occurrence. Mirror test/unit/config/scoped-permissions.test.ts:6-9's
// sanctioned idiom: makeNaxConfig(...) from @test/helpers takes a DeepPartial.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

// This file is NEW — no fixtures to reuse. Anchor on a real tmp dir:
const root = mkdtempSync(join(tmpdir(), "substrate-equivalence-"));
writeFileSync(join(root, "file.txt"), "x");

function policyFor(execution: Record<string, unknown>, stage: "run" | "verify" = "run") {
  const resolved = resolvePermissions(cfg(execution), stage);
  return compileToolPolicy(resolved.toolGrants ?? [], root, {
    ...(resolved.denyRules !== undefined ? { denyRules: resolved.denyRules } : {}),
    ...(resolved.askRules !== undefined ? { askRules: resolved.askRules } : {}),
  });
}

describe("substrate equivalence (regression gate, spec §5 step 1)", () => {
  test("profile-only configs: identical grantedTools before/after shapes", () => {
    for (const permissionProfile of ["unrestricted", "safe"] as const) {
      const resolved = resolvePermissions(cfg({ permissionProfile }), "run");
      expect(resolved.denyRules).toBeUndefined();
      expect(resolved.askRules).toBeUndefined();
    }
  });

  test("allowedTools alias behaves identically to allow end-to-end", () => {
    const viaAlias = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allowedTools: ["Read", "Write(src/**)"] } },
    });
    const viaAllow = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Read", "Write(src/**)"] } },
    });
    for (const input of [{ path: "src/a.ts" }, { path: "test/a.ts" }]) {
      expect(viaAllow.check("Write", { pathFields: ["path"] }, input)).toEqual(
        viaAlias.check("Write", { pathFields: ["path"] }, input),
      );
    }
    expect(viaAllow.grantedTools().sort()).toEqual(viaAlias.grantedTools().sort());
  });

  test("deny > ask > allow across the full path (unrestricted profile)", () => {
    const policy = policyFor({
      permissionProfile: "unrestricted",
      permissions: {
        run: { deny: ["Write(src/generated/**)"], ask: ["Write(src/**)"] },
      },
    });
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "src/generated/x.ts" }).allowed).toBe(false);
    const asked = policy.check("Write", { pathFields: ["path"] }, { path: "src/x.ts" });
    expect(asked.allowed === false && asked.outcome).toBe("ask");
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "docs/x.md" }).allowed).toBe(true);
  });

  test("deny binds under unrestricted (spec R10 deny-suite row)", () => {
    const policy = policyFor({
      permissionProfile: "unrestricted",
      permissions: { run: { deny: ["Delete"] } },
    });
    expect(policy.grantedTools()).not.toContain("Delete");
  });

  test("two expressions for one tool: LAST wins (pins today's compiler)", () => {
    // Guards the byte-identity gate: the allow compiler is last-write-wins per
    // tool (policy.ts grant loop). If this test surprises you, do not "fix" the
    // compiler — see Task 4's warning; changing it alters shipped-config verdicts.
    const policy = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Write(src/**)", "Write(test/**)"] } },
    });
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "test/a.ts" }).allowed).toBe(true);
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "src/a.ts" }).allowed).toBe(false);
  });

  test("stage inheritance carries rules end-to-end", () => {
    const policy = policyFor(
      {
        permissionProfile: "scoped",
        permissions: { run: { allow: ["Read"], deny: ["Read(.env*)"] }, verify: { inherit: "run" } },
      },
      "verify",
    );
    expect(policy.check("Read", { pathFields: ["path"] }, { path: ".env.local" }).allowed).toBe(false);
    expect(policy.check("Read", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new suite**

Run: `bun test test/unit/permissions/ --timeout=30000`
Expected: PASS (everything is implemented; a failure here is a real integration gap — fix the producing task's module, not the test).

- [ ] **Step 3: Full gates**

Run, in order:
- `bun run test` — full suite green.
- `bun run check:all` — this is what CI runs. NOTE: `bun run lint` alone does NOT cover `check:permission-mode-ssot`, `check:test-as-unknown-as`, `check:test-escape-hatches`, or `check:rules-drift` — those run only under `check:all` / `check:all-without-biome` (`package.json`), so a green `lint` is not the gate.
- `bun run typecheck`.
- `bun run test:coverage` — every new `src/permissions/*` and modified file ≥0.8 per-file (NOT part of `bun run test` or `check:all`; run explicitly).

Expected: all green. If `check:permission-mode-ssot` flags `src/permissions/`: the module contains no mode literals by design — fix the code, not the script (Deviations note: resolution stayed in `src/config/permissions.ts` precisely to avoid touching the script).

- [ ] **Step 4: Docs touch + commit**

Add to `docs/architecture/agent-adapters.md` §14 (Permission Resolution) one short paragraph: per-stage blocks now carry `allow`/`deny`/`ask` rule lists evaluated under every profile (deny > ask > allow; `allowedTools` is the legacy alias of `allow`); `ask` resolves through an `AskResolver` (headless: refuse, ledger outcome `denied:ask`); full design in `docs/superpowers/specs/2026-09-13-nax-native-permission-subsystem-design.md`.

```bash
git add test/unit/permissions docs/architecture/agent-adapters.md
git commit -m "test(permissions): end-to-end equivalence and precedence suite for the permission substrate"
```

---

## Self-review notes (kept for executors)

- Spec coverage for Plan A's slice: US-001 (Task 1, with the recorded deviation), US-002 minus `Mcp(...)` (Task 2; Mcp is Plan B by the Global Constraints ruling), US-003 (Tasks 3–4), US-007 seam+telemetry (Task 5), R10 (Task 3 + Task 7), regression gate (Tasks 3/7). Bash, MCP widening, redirects, ADR amendment: Plan B.
- `AskRequest.stage` is `"unknown"` at the `callTool` layer — the runtime has no stage. Acceptable for v1 (the ledger session name carries role context); when the interactive resolver lands, stage can be threaded through `createCodingToolRuntime` opts. Do not thread it now (YAGNI).
- If any modified file crosses its size ratchet, split as its own step within the task (policy-match extraction is pre-authorized in Task 4).
