# MCP Client Support for the Native Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the native coding agent call tools served by external stdio MCP servers — the motivating case being `codebase-memory-mcp` — configured entirely in `.nax/config.json`, with per-`(server, workdir)` connections, a pinning lockfile, and no change to how any operation declares its tools.

**Architecture:** MCP is delivered as a `discovered` **ToolProvider**, the extension point that landed with nax#2031 (`src/tools/provider-*.ts`). A run-scoped connection pool keyed by `(serverId, workdir)` hangs off `NaxRuntime`; one `ToolProvider` per configured server asks the pool for its tool list at the hop's permitted root, filters it through the lockfile and `allowedTools`, and adapts each descriptor into a `CodingTool` whose `run()` is a pool call. Everything downstream — namespacing, grant expansion, sanitisation, advertisement, the ledger's `provider` field — is provider-tools' machinery, already shipped and tested.

**Tech Stack:** TypeScript + Bun, zod v4 for config, `@modelcontextprotocol/sdk` v1.30.0 (client + stdio transport only), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-13-nax-mcp-client-design.md`
**Branch:** `feat/mcp-client`, branched from `main` at `3aaa468c4`.
**Provenance:** every `file.ts:LINE` citation, gate threshold and lint rule below was verified against `3aaa468c4` on 2026-09-13, and the zod, config-parse, tool-policy and ACP-exclusion claims were each probed by running them. Re-verify before starting if `main` has moved — the import-cycles drain (#2026) has moved these files once already.
**Prerequisite (MERGED):** `docs/superpowers/specs/2026-09-13-nax-provider-tools-design.md` → PR #2031, on `main` as `230f25551`.

---

## Global Constraints

These apply to every task. They are not repeated per task.

**Repo gates** — `bun run check:all` must pass before every commit, and `bun run test` before the final one.
- `check:file-sizes` — **600 lines max** per `src/**/*.ts`, **800** per `test/**/*.test.ts`. New files may never enter the baseline. Split before you exceed it.
- `check:nax-error` — no new `throw new Error(...)` in `src/`. Use `NaxError(message, CODE, { stage })`.
- `check:logger-storyid` — every `logger.{info,warn,error,debug}` call in scoped dirs passes a data object whose **first key is `storyId`**.
- `check:import-cycles` — zero new runtime import cycles. `src/mcp/` must not import from `src/agents/` or `src/operations/`; those import `src/mcp/` (via the runtime), never the reverse.
- `check:alias-internals` — **once `src/mcp/index.ts` exists, a value import of `@/mcp/<internal>` from `src/`, `bin/` or `scripts/` is a violation.** Production code imports the barrel: `import { createMcpPool } from "@/mcp"`. Task 2 therefore creates the barrel with the directory's first file, rather than at the end. Two exemptions apply and are used throughout this plan: type-only imports, and value imports from `test/` (a unit test's job is to reach the unit).
- **`bun run test:coverage` is NOT part of `check:all` or `bun run test`** — it is a separate CI step with a **per-file floor of 0.8** (`PER_FILE_FLOOR`, `scripts/check-coverage.ts:76`) that fails on any **new** `src/` file below it. This plan adds seven. `test/unit/`, `test/integration/` and `test/ui/` all feed the report (`GATED_SUITES`, `:98`); only `test/e2e/` is excluded. Run it after Task 8 and again after Task 9, and treat a below-floor new file as unfinished work rather than a baseline entry.
- `check:no-control-bytes` — no literal control bytes in any file. A `\0` written as a two-character escape sequence is fine; a raw byte is not. This plan avoids the question entirely by keying the pool with `JSON.stringify([...])`.
- `check:bundle-externals` — do **not** add `@modelcontextprotocol/sdk` to the build's `--external` list. It bundles cleanly (measured below).

**Test conventions** — these are lint- or ratchet-enforced, and every test in this plan already complies. A fresh agent adding a case must keep them:
- **No `as never`, anywhere.** `biome-plugins/no-as-never.grit` is wired at `biome.json`'s root, so it covers `src/`, `bin/` and `test/` alike. Type the fixture instead. Note `JSONSchema` is `Record<string, unknown>` (`src/context/engine/types.ts:79`), so a tool schema needs no cast at all.
- **Avoid `as <CapitalisedType>` in `test/`.** `check:test-escape-hatches` ratchets a `looseCast` count (baseline 1593) over `test/` only and fails when it rises. Annotate the binding (`const server: McpServerConfig = {...}`) rather than asserting the literal.
- **No fixed-duration sleeps in tests** — neither `Bun.sleep(n)` nor `await new Promise(r => setTimeout(r, n))`. Use an explicit gate promise the test resolves, or a never-resolving promise where the code under test owns the deadline. (`Bun.sleep` in `src/` is the opposite: it is the *required* form for a delay.)
- **Empty `catch {}` is banned** (`no-empty-catch.grit`, also root-scoped). `await p.catch(() => {})` is explicitly sanctioned and is what this plan uses.
- A test that calls `createRuntime()` must close it — `check:runtime-cleanup` greps each such file for `.close(`.

**Dependency (Task 2)** — `@modelcontextprotocol/sdk@^1.30.0`, a normal `dependencies` entry. Measured before adoption, on 2026-09-13:

| | measured |
|---|---|
| `bun build` of `client/index.js` + `client/stdio.js` | 544 KB, zero express/hono in the output — the SDK's 17 direct deps are its *server*/HTTP surface and tree-shake away |
| nax's own `dist/nax.js` today | 4.78 MB (so ~+11% worst case; less, since zod is shared) |
| installed | 91 packages, 26 MB |
| `bun audit` | clean, 0 vulnerabilities |
| zod peer (`^3.25 \|\| ^4.0`) | resolves to 4.6.4, matching nax's `^4.3.6` |

**Three deviations from the spec.** The spec was written before provider-tools landed; where the shipped code disagrees, the shipped code wins. Each is a ruling, not an oversight:

- **D1 — Tool names are `<serverId>__<toolName>`, not `mcp__<server>__<tool>`.** `namespacedToolName` (`src/tools/provider-adapt.ts:19`) owns the namespace and `validateProviderId` (`src/tools/provider-types.ts:47`) rejects any id containing `__`, so the spec's three-part name is unreachable. The provider id **is** the config key: one identifier across `mcp.servers.<id>`, the tool name, the ledger's `provider` field and every denial message. Task 5 adds a duplicate-id guard against future static providers.
- **D2 — No `Mcp(...)` grant expression; MCP is advertised only under the `unrestricted` profile.** `src/agents/coding-tool-support.ts:261` gates all provider resolution on `resolved.mode === "approve-all"`, which only `unrestricted` returns. Spec US-004's `Mcp(server:tool)` narrowing would first require reopening that fail-closed gate. **Chosen because nothing uses scoped permissions yet** — no config in this repo, and no fixture, sets `execution.permissionProfile` at all, so every run takes the `unrestricted` default. Building narrowing syntax for an unexercised profile would be speculative work with real regression risk. Narrowing therefore lives in the `mcp` block: `stages`, `allowedTools`, `enabled`, and the lockfile. Spec R5 ("MCP is never wildcard-granted") holds by construction: `unconditionalGrants` (`src/config/permissions.ts:167-177`) enumerates built-ins only, and every MCP grant is an exact namespaced name emitted by `expandProviderGrants`.
- **D3 — `resolvePermissions` and `agentManagerConfigSelector` are NOT touched.** Spec US-001 called for widening the selector so the permission layer could read `mcp`. It does not need to: grants come from `expandProviderGrants` inside `resolveProviderTools`, and the pool is built in `createRuntime`, which holds the full `NaxConfig` already. Leaving the permission SSOT alone is the smaller and safer change.

**One consequence of D2 worth stating** — a tool withheld by lock drift is *never advertised*, so no call is ever made and there is no denial to carry a "run `nax mcp lock`" redirect (spec US-003/US-007 assumed one). The refresh instruction goes where a human will actually see it: a `warn` log at resolve time and a `withheld` entry in the run rollup (Task 8).

**Standing operational rule** — this repo's owner has a standing ruling: **never launch `nax run` or `nax plan` without explicit approval at the launch moment.** Task 10 requires a real run; it stops and asks.

---

### Task 1: The `mcp` config block

**Files:**
- Create: `src/config/schemas-mcp.ts`
- Create: `src/config/runtime-types-mcp.ts`
- Modify: `src/config/schemas.ts` (import + mount alongside `finish:` at `:415`)
- Modify: `src/config/runtime-types.ts:504-560` (`NaxConfig.mcp` + type re-export)
- Modify: `src/config/schema.ts` (re-export type and schema)
- Modify: `src/config/index.ts` (re-export type and schema)
- Modify: `src/cli/config-descriptions.ts` (field docs)
- Test: `test/unit/config/schemas-mcp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `McpConfigSchema`, `McpServerSchema`, `MCP_SERVER_ID_RE`, `MCP_DEFAULT_TIMEOUT_MS`; types `McpConfig`, `McpServerConfig`, `McpStage`. `NaxConfig.mcp?: McpConfig`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/schemas-mcp.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { McpConfigSchema } from "@/config/schemas-mcp";
import { NaxConfigSchema } from "@/config";

const server = { command: "codebase-memory-mcp", stages: ["run"] };

describe("McpConfigSchema", () => {
  test("parses two servers with disjoint stages", () => {
    const parsed = McpConfigSchema.parse({
      servers: {
        "codebase-memory": { ...server, allowedTools: ["search_graph"] },
        docs: { command: "docs-mcp", stages: ["review"] },
      },
    });
    expect(Object.keys(parsed.servers)).toEqual(["codebase-memory", "docs"]);
    expect(parsed.servers["codebase-memory"]?.stages).toEqual(["run"]);
    expect(parsed.servers.docs?.stages).toEqual(["review"]);
  });

  test("applies defaults: args, env, timeoutMs, enabled", () => {
    const parsed = McpConfigSchema.parse({ servers: { a: { command: "x" } } });
    expect(parsed.servers.a).toEqual({
      command: "x",
      args: [],
      env: {},
      stages: [],
      timeoutMs: 60_000,
      enabled: true,
    });
  });

  test("rejects an unknown key inside a server block", () => {
    const result = McpConfigSchema.safeParse({ servers: { a: { command: "x", stage: ["run"] } } });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown stage name", () => {
    // There is no `implement` stage — implementation runs under `run`.
    expect(McpConfigSchema.safeParse({ servers: { a: { command: "x", stages: ["implement"] } } }).success).toBe(false);
  });

  test("accepts the wildcard stage", () => {
    expect(McpConfigSchema.parse({ servers: { a: { command: "x", stages: ["*"] } } }).servers.a?.stages).toEqual(["*"]);
  });

  test("rejects a server id that is not a valid provider id", () => {
    for (const bad of ["Codebase", "-leading", "has space", "double__underscore", ""]) {
      expect(McpConfigSchema.safeParse({ servers: { [bad]: { command: "x" } } }).success).toBe(false);
    }
  });

  test("rejects an empty command", () => {
    expect(McpConfigSchema.safeParse({ servers: { a: { command: "" } } }).success).toBe(false);
  });

  test("mounts on NaxConfigSchema and defaults to no servers", () => {
    const config = NaxConfigSchema.parse({ name: "x" });
    expect(config.mcp).toEqual({ servers: {} });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/config/schemas-mcp.test.ts`
Expected: FAIL — `Cannot find module '@/config/schemas-mcp'`.

- [ ] **Step 3: Write the schema**

Create `src/config/schemas-mcp.ts`:

```ts
/**
 * `mcp` config block — external MCP servers the native agent may call tools on.
 *
 * `.strict()` throughout: a typo'd key must fail loudly. A silently stripped
 * `stage:` (for `stages:`) would leave a server attached to nothing, which
 * reads at runtime as "MCP is broken" rather than "the config has a typo".
 *
 * Server ids are PROVIDER ids (src/tools/provider-types.ts): the id is the tool
 * name's namespace, so the two charsets must agree or a config that parses
 * would throw at adaptation time instead.
 */
import { z } from "zod";

/** Mirrors PROVIDER_ID_RE; `__` is additionally excluded below (it is the namespace separator). */
export const MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Per-call ceiling. Not a measured value: nax's own bounds are GIT_TIMEOUT_MS
 * 10s (src/utils/git.ts) and EXEC_TIMEOUT_MS 300s (src/tools/run-command-exec.ts),
 * and MCP calls span both extremes — a graph search is milliseconds, an index
 * rebuild is minutes. 60s is long enough for any interactive query and short
 * enough that a wedged server does not consume a hop. A server with genuinely
 * long operations raises its own `timeoutMs`.
 */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * PipelineStage (src/config/permissions.ts:18-27) plus `"*"`. Spelled out rather
 * than derived so an unknown stage is a schema error at load, not a server that
 * silently attaches to nothing. There is no `implement` stage.
 */
export const McpStageSchema = z.enum([
  "plan",
  "run",
  "setup",
  "verify",
  "review",
  "rectification",
  "regression",
  "acceptance",
  "complete",
  "*",
]);

export const McpServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    stages: z.array(McpStageSchema).default([]),
    /** Omitted => every locked tool is grantable. */
    allowedTools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().default(MCP_DEFAULT_TIMEOUT_MS),
    /** Kill switch that needs no lock entry and invalidates no lock. */
    enabled: z.boolean().default(true),
  })
  .strict();

const McpServerIdSchema = z
  .string()
  .regex(MCP_SERVER_ID_RE)
  .refine((id) => !id.includes("__"), { message: "server id may not contain '__' (the tool-name separator)" });

export const McpConfigSchema = z
  .object({
    servers: z.record(McpServerIdSchema, McpServerSchema).default({}),
  })
  .strict();
```

- [ ] **Step 4: Write the runtime types**

Create `src/config/runtime-types-mcp.ts`:

```ts
/**
 * `mcp` config types — external MCP servers (client only; nax is never a server).
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit.
 */

export type McpStage =
  | "plan"
  | "run"
  | "setup"
  | "verify"
  | "review"
  | "rectification"
  | "regression"
  | "acceptance"
  | "complete"
  | "*";

export interface McpServerConfig {
  /** Executable spawned over stdio. */
  command: string;
  args: string[];
  /** Overlaid on the inherited environment; never replaces PATH wholesale. */
  env: Record<string, string>;
  /** Pipeline stages this server attaches to; `["*"]` is every stage. */
  stages: McpStage[];
  /** Optional narrowing; omitted means every locked tool is grantable. */
  allowedTools?: string[];
  /** Per-call timeout in ms. */
  timeoutMs: number;
  enabled: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
```

- [ ] **Step 5: Mount it and thread the types**

In `src/config/schemas.ts`, add to the imports (after `./schemas-infra`'s import group):

```ts
import { McpConfigSchema } from "./schemas-mcp";
```

and mount it in `NaxConfigSchema` immediately after the `finish:` block (`:415`), using the derived-default idiom the `context:` field documents at `:304-310`:

```ts
    // Derived, not hand-written — same reason as `context:` above: a literal
    // default here would shadow every inner `.default()` in McpConfigSchema.
    mcp: McpConfigSchema.default(() => McpConfigSchema.parse({})),
```

In `src/config/runtime-types.ts`, beside the `finish` re-export (`:500`):

```ts
export type { McpConfig, McpServerConfig, McpStage } from "./runtime-types-mcp";
```

and on `NaxConfig` (after `finish?:`, `:545`):

```ts
  /** External MCP servers the native agent may call tools on (client only) */
  mcp?: import("./runtime-types-mcp").McpConfig;
```

In `src/config/schema.ts` add `McpConfig`, `McpServerConfig`, `McpStage` to the `export type { ... } from "./types"` list and `McpConfigSchema` to the schema export block. In `src/config/index.ts` add the same three types to the `from "./schema"` type block and `McpConfigSchema` to its value block.

- [ ] **Step 6: Document the fields**

In `src/cli/config-descriptions.ts`, add a block (keep it beside the other top-level blocks; the ordering in that file is by config section):

```ts
  // MCP
  mcp: "External MCP servers the native agent may call tools on (client only; nax is not an MCP server)",
  "mcp.servers": "Map of server id to server block. The id is the tool-name namespace: a tool named search_graph on server codebase-memory is advertised as codebase-memory__search_graph",
  "mcp.servers.<id>.command": "Executable to spawn for this stdio MCP server",
  "mcp.servers.<id>.args": "Arguments passed to the command (default: [])",
  "mcp.servers.<id>.env": "Environment overlaid on the inherited environment for this server (default: {})",
  "mcp.servers.<id>.stages": "Pipeline stages this server attaches to, e.g. [\"run\", \"review\"]. [\"*\"] means every stage. Empty (the default) means the server is configured but never advertised. There is no 'implement' stage - implementation runs under 'run'",
  "mcp.servers.<id>.allowedTools": "Optional narrowing to specific tool names. Omitted means every tool present in .nax/mcp-lock.json is grantable",
  "mcp.servers.<id>.timeoutMs": "Per-call timeout in milliseconds (default: 60000)",
  "mcp.servers.<id>.enabled": "Kill switch. false means the server is not connected, not locked and contributes no tools (default: true)",
```

- [ ] **Step 7: Run the tests**

Run: `bun test test/unit/config/schemas-mcp.test.ts test/unit/cli/config-descriptions.test.ts`
Expected: PASS, both files.

- [ ] **Step 8: Run the gates**

Run: `bun run check:all && bun run typecheck`
Expected: OK on every line.

- [ ] **Step 9: Commit**

```bash
git add src/config/schemas-mcp.ts src/config/runtime-types-mcp.ts src/config/schemas.ts \
        src/config/runtime-types.ts src/config/schema.ts src/config/index.ts \
        src/cli/config-descriptions.ts test/unit/config/schemas-mcp.test.ts
git commit -m "feat(config): mcp server config block"
```

---

### Task 2: Stdio MCP client wrapper

**Files:**
- Modify: `package.json` (add the dependency)
- Create: `src/mcp/types.ts`
- Create: `src/mcp/client.ts`
- Create: `src/mcp/index.ts` (the barrel — created **now**, with the directory's first file, so no `src/` consumer ever has to reach past it; see `check:alias-internals` in Global Constraints)
- Test: `test/unit/mcp/client.test.ts`

**Interfaces:**
- Consumes: Task 1's `McpServerConfig` (for `command`/`args`/`env` only).
- Produces:
  - `interface McpToolDescriptor { readonly name: string; readonly description: string; readonly inputSchema: JSONSchema }`
  - `interface McpCallResult { readonly content: string; readonly isError: boolean; readonly bytesPreTruncation: number }`
  - `interface McpConnection { readonly serverId: string; readonly workdir: string; readonly pid: number | null; listTools(): Promise<readonly McpToolDescriptor[]>; callTool(name: string, input: Record<string, unknown>, opts: { timeoutMs: number; maxBytes: number }): Promise<McpCallResult>; close(): Promise<void> }`
  - `connectMcpServer(args: { serverId: string; workdir: string; command: string; args: readonly string[]; env: Record<string, string>; connectTimeoutMs: number }): Promise<McpConnection>`
  - `_mcpClientDeps` — injectable `{ createClient, createTransport }` seam, mirroring `_argvExecDeps` (`src/utils/argv-exec.ts:38`).
  - `interface McpClientLike` — the structural slice of the SDK client this wrapper uses, so a test fake satisfies the seam with no cast (`as never` is lint-banned; see Global Constraints).

- [ ] **Step 1: Add the dependency**

```bash
bun add @modelcontextprotocol/sdk@^1.30.0
bun audit
```
Expected: `bun audit` reports no vulnerabilities. Do **not** touch the `--external` list in the `build` script; `check:bundle-externals` asserts it names only `@nathapp/nax-ai`.

- [ ] **Step 2: Write the failing test**

Create `test/unit/mcp/client.test.ts`. It drives the real wrapper against fake SDK objects through the dependency seam — no subprocess, no protocol:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { _mcpClientDeps, connectMcpServer } from "@/mcp/client";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

function fakeSdk(over: {
  tools?: unknown[];
  call?: (name: string, args: Record<string, unknown>) => unknown;
  connect?: () => Promise<void>;
}) {
  const closed: string[] = [];
  Object.assign(_mcpClientDeps, {
    createTransport: () => ({ pid: 4242, close: async () => void closed.push("transport") }),
    createClient: () => ({
      connect: over.connect ?? (async () => {}),
      listTools: async () => ({ tools: over.tools ?? [] }),
      callTool: async (params: { name: string; arguments: Record<string, unknown> }) =>
        over.call ? over.call(params.name, params.arguments) : { content: [] },
      close: async () => void closed.push("client"),
    }),
  });
  return closed;
}

const connect = () =>
  connectMcpServer({
    serverId: "memory",
    workdir: "/w",
    command: "fake",
    args: [],
    env: {},
    connectTimeoutMs: 1000,
  });

describe("connectMcpServer", () => {
  test("exposes the transport pid", async () => {
    fakeSdk({});
    const conn = await connect();
    expect(conn.pid).toBe(4242);
    await conn.close();
  });

  test("maps tool descriptors, defaulting a missing description", async () => {
    fakeSdk({ tools: [{ name: "search_graph", description: "Search", inputSchema: { type: "object" } }, { name: "bare", inputSchema: { type: "object" } }] });
    const conn = await connect();
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_graph", "bare"]);
    expect(tools[0]?.description).toBe("Search");
    expect(tools[1]?.description).toBe("");
    await conn.close();
  });

  test("joins text content blocks and reports non-text ones without dropping the result", async () => {
    fakeSdk({ call: () => ({ content: [{ type: "text", text: "a" }, { type: "image", data: "..." }, { type: "text", text: "b" }] }) });
    const conn = await connect();
    const result = await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(result.content).toBe("a\n[image content omitted]\nb");
    expect(result.isError).toBe(false);
    await conn.close();
  });

  test("carries the server's isError through as data", async () => {
    fakeSdk({ call: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }) });
    const conn = await connect();
    expect(await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 })).toMatchObject({ isError: true, content: "boom" });
    await conn.close();
  });

  test("truncates to maxBytes and reports the pre-truncation size", async () => {
    fakeSdk({ call: () => ({ content: [{ type: "text", text: "x".repeat(5000) }] }) });
    const conn = await connect();
    const result = await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 100 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100);
    expect(result.bytesPreTruncation).toBe(5000);
    await conn.close();
  });

  test("a rejecting connect() surfaces as a NaxError naming the server", async () => {
    fakeSdk({ connect: async () => { throw new Error("ENOENT"); } });
    expect(connect()).rejects.toThrow(/memory/);
  });

  test("close() closes the client", async () => {
    const closed = fakeSdk({});
    const conn = await connect();
    await conn.close();
    expect(closed).toContain("client");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/unit/mcp/client.test.ts`
Expected: FAIL — `Cannot find module '@/mcp/client'`.

- [ ] **Step 4: Write the types**

Create `src/mcp/types.ts`:

```ts
/**
 * Vocabulary for the MCP client layer.
 *
 * Deliberately free of SDK types: everything above this file speaks nax's own
 * shapes, so swapping transports (spec R10 defers streamable HTTP) or the SDK
 * itself touches `client.ts` alone.
 */
import type { JSONSchema } from "@/context/engine";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface McpCallResult {
  readonly content: string;
  /** Error AS DATA (ADR-029 section 5) — never a throw for a server-side failure. */
  readonly isError: boolean;
  /** Result size before the maxBytes slice, so elision is visible in the ledger. */
  readonly bytesPreTruncation: number;
}

export interface McpConnection {
  readonly serverId: string;
  readonly workdir: string;
  /** Child pid, for the runtime's PidRegistry. Null before start or after close. */
  readonly pid: number | null;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    input: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}
```

- [ ] **Step 5: Write the client**

Create `src/mcp/client.ts`:

```ts
/**
 * One stdio MCP connection, wrapped so nothing above this file imports the SDK.
 *
 * Two traps the SDK's defaults set, both handled here:
 *
 * 1. `StdioClientTransport` uses `getDefaultEnvironment()` ONLY when `env` is
 *    absent. Passing `{ NAX: "1" }` would therefore hand the server an
 *    environment with no PATH, and it would fail to exec its own helpers. The
 *    configured env is an OVERLAY on the default, never a replacement.
 * 2. `stderr` defaults to `"inherit"`, which would interleave a server's
 *    diagnostics into nax's TUI. Piped and dropped instead.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONSchema } from "@/context/engine";
import { NaxError } from "@/errors";
import type { McpCallResult, McpConnection, McpToolDescriptor } from "./types";

/** Injectable seam, mirroring `_argvExecDeps` — lets the unit tests run without a subprocess. */
export const _mcpClientDeps = {
  createTransport: (params: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): { pid: number | null; close(): Promise<void> } =>
    new StdioClientTransport({ ...params, stderr: "pipe" }),
  createClient: (): McpClientLike => new Client({ name: "nax", version: "1" }),
};

/**
 * The slice of the SDK client this wrapper uses.
 *
 * Declared structurally rather than importing the SDK's own types, so a fake in
 * a test satisfies it without a cast — `as never` is lint-banned repo-wide
 * (biome-plugins/no-as-never.grit). `Client` satisfies this shape, so the seam
 * needs no assertion either.
 */
export interface McpClientLike {
  // `unknown` for the SDK-typed parameters, and METHOD syntax rather than
  // arrow-property syntax, both deliberately: method parameters compare
  // bivariantly, which is what lets the real `Client` (whose `connect` takes a
  // `Transport`) satisfy this interface while a test fake taking nothing also
  // satisfies it. Naming the SDK's own types here would drag them above this
  // file; `never` would make the parameter unusable.
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools: unknown[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

function toDescriptors(tools: readonly unknown[]): readonly McpToolDescriptor[] {
  const out: McpToolDescriptor[] = [];
  for (const raw of tools) {
    const tool = raw as RawTool;
    if (typeof tool.name !== "string" || tool.name.length === 0) continue;
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: (tool.inputSchema ?? {}) as JSONSchema,
    });
  }
  return out;
}

/** Truncate to a byte ceiling without splitting a code point (mirrors provider-sanitize). */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function renderContent(result: unknown): { text: string; isError: boolean } {
  const body = (result ?? {}) as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(body.content) ? body.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else parts.push(`[${String(typed.type ?? "unknown")} content omitted]`);
  }
  return { text: parts.join("\n"), isError: body.isError === true };
}

export async function connectMcpServer(args: {
  serverId: string;
  workdir: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  connectTimeoutMs: number;
}): Promise<McpConnection> {
  const transport = _mcpClientDeps.createTransport({
    command: args.command,
    args: [...args.args],
    // Trap 1 above: overlay, never replace.
    env: { ...getDefaultEnvironment(), ...args.env },
    cwd: args.workdir,
  });
  const client = _mcpClientDeps.createClient();

  try {
    await client.connect(transport, { timeout: args.connectTimeoutMs });
  } catch (error) {
    await transport.close().catch(() => {});
    throw new NaxError(
      `MCP server "${args.serverId}" failed to connect at ${args.workdir}: ${String(error)}`,
      "MCP_CONNECT_FAILED",
      { stage: "tools" },
    );
  }

  return {
    serverId: args.serverId,
    workdir: args.workdir,
    get pid() {
      return transport.pid ?? null;
    },
    async listTools() {
      const response = await client.listTools(undefined, { timeout: args.connectTimeoutMs });
      return toDescriptors(response.tools ?? []);
    },
    async callTool(name, input, opts) {
      const raw = await client.callTool({ name, arguments: input }, undefined, { timeout: opts.timeoutMs });
      const { text, isError } = renderContent(raw);
      return {
        content: truncateToBytes(text, opts.maxBytes),
        isError,
        bytesPreTruncation: Buffer.byteLength(text, "utf8"),
      };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
```

- [ ] **Step 6: Create the barrel**

Create `src/mcp/index.ts`. Each later task appends its own line; nothing under `src/` may import `@/mcp/<internal>` once this file exists.

```ts
export * from "./client";
export * from "./types";
```

- [ ] **Step 7: Run the tests**

Run: `bun test test/unit/mcp/client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Verify the bundle still builds and stays externals-clean**

Run: `bun run build && bun run check:bundle-externals && bun run check:all`
Expected: build succeeds, both checks OK.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/mcp/types.ts src/mcp/client.ts src/mcp/index.ts test/unit/mcp/client.test.ts
git commit -m "feat(mcp): stdio MCP client wrapper"
```

---

### Task 3: Connection pool keyed by `(serverId, workdir)`

**Files:**
- Create: `src/mcp/pool.ts`
- Test: `test/unit/mcp/pool.test.ts`

**Interfaces:**
- Consumes: Task 2's `connectMcpServer`, `McpConnection`, `McpToolDescriptor`, `McpCallResult`; Task 1's `McpServerConfig`.
- Produces:
  - `type McpServerEvent = { readonly serverId: string; readonly workdir: string; readonly at: string } & ({ readonly kind: "connected"; readonly pid: number | null; readonly toolCount: number } | { readonly kind: "connect-failed"; readonly reason: string; readonly attempt: number } | { readonly kind: "closed" })`
  - `interface McpPool { listTools(serverId: string, workdir: string): Promise<readonly McpToolDescriptor[]>; call(serverId: string, workdir: string, tool: string, input: Record<string, unknown>, opts: { timeoutMs: number; maxBytes: number }): Promise<McpCallResult>; events(): readonly McpServerEvent[]; close(): Promise<void> }`
  - `createMcpPool(opts: { servers: Readonly<Record<string, McpServerConfig>>; pidRegistry?: { register(pid: number): Promise<void>; unregister(pid: number): Promise<void> }; retry?: { maxAttempts: number; baseDelayMs: number }; storyId?: string }): McpPool`
  - `MCP_CONNECT_TIMEOUT_MS`, `MCP_DEFAULT_RETRY`

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp/pool.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import { createMcpPool } from "@/mcp/pool";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

interface Spawn { cwd: string; pid: number }

function fakeSdk(opts: { failFirst?: number; gate?: Promise<void> } = {}) {
  const spawns: Spawn[] = [];
  const closes: number[] = [];
  let attempts = 0;
  let nextPid = 100;
  Object.assign(_mcpClientDeps, {
    createTransport: (params: { cwd: string }) => {
      const pid = nextPid++;
      spawns.push({ cwd: params.cwd, pid });
      return { pid, close: async () => void closes.push(pid) };
    },
    createClient: () => ({
      connect: async () => {
        attempts++;
        // A gate the test opens explicitly. A fixed sleep is banned in tests
        // (.nax/rules/forbidden-patterns-tests.md): flaky under load, and
        // additive on a suite Bun runs serially.
        if (opts.gate) await opts.gate;
        if (opts.failFirst !== undefined && attempts <= opts.failFirst) throw new Error("ENOENT");
      },
      listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] }),
      callTool: async (p: { name: string }) => ({ content: [{ type: "text", text: `ran ${p.name}` }] }),
      close: async () => {},
    }),
  });
  return { spawns, closes, attemptCount: () => attempts };
}

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

describe("createMcpPool", () => {
  test("two workdirs against one server id produce two connections", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/work/a");
    await pool.listTools("memory", "/work/b");
    expect(sdk.spawns.map((s) => s.cwd)).toEqual(["/work/a", "/work/b"]);
    await pool.close();
  });

  test("repeated use of one key connects once and caches tools/list", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/w");
    await pool.listTools("memory", "/w");
    await pool.call("memory", "/w", "t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(sdk.spawns.length).toBe(1);
    await pool.close();
  });

  test("concurrent first use of one key awaits a single in-flight connect", async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sdk = fakeSdk({ gate });
    const pool = createMcpPool({ servers });
    const all = Promise.all([
      pool.listTools("memory", "/w"),
      pool.listTools("memory", "/w"),
      pool.listTools("memory", "/w"),
    ]);
    open();
    await all;
    expect(sdk.spawns.length).toBe(1);
    await pool.close();
  });

  test("every spawned pid is registered, and unregistered on close", async () => {
    fakeSdk();
    const registered: number[] = [];
    const unregistered: number[] = [];
    const pool = createMcpPool({
      servers,
      pidRegistry: {
        register: async (pid) => void registered.push(pid),
        unregister: async (pid) => void unregistered.push(pid),
      },
    });
    await pool.listTools("memory", "/w");
    expect(registered.length).toBe(1);
    await pool.close();
    expect(unregistered).toEqual(registered);
  });

  test("close() twice is a no-op the second time", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/w");
    await pool.close();
    await pool.close();
    expect(sdk.closes.length).toBe(1);
  });

  test("a failing connect degrades: empty tool list, no throw, event recorded", async () => {
    fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 2, baseDelayMs: 0 } });
    expect(await pool.listTools("memory", "/w")).toEqual([]);
    expect(pool.events().filter((e) => e.kind === "connect-failed").length).toBeGreaterThan(0);
    await pool.close();
  });

  test("connect is retried up to maxAttempts and then not retried again for that key", async () => {
    const sdk = fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 2, baseDelayMs: 0 } });
    await pool.listTools("memory", "/w");
    await pool.listTools("memory", "/w");
    expect(sdk.attemptCount()).toBe(2);
    await pool.close();
  });

  test("a transient failure recovers within the attempt budget", async () => {
    fakeSdk({ failFirst: 1 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    expect((await pool.listTools("memory", "/w")).map((t) => t.name)).toEqual(["t"]);
    await pool.close();
  });

  test("an unknown or disabled server yields no tools and never spawns", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers: { off: { ...servers.memory, enabled: false } } });
    expect(await pool.listTools("off", "/w")).toEqual([]);
    expect(await pool.listTools("nope", "/w")).toEqual([]);
    expect(sdk.spawns.length).toBe(0);
    await pool.close();
  });

  test("a call against an unreachable server returns an error result, not a throw", async () => {
    fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 1, baseDelayMs: 0 } });
    const result = await pool.call("memory", "/w", "t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    await pool.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/mcp/pool.test.ts`
Expected: FAIL — `Cannot find module '@/mcp/pool'`.

- [ ] **Step 3: Write the pool**

Create `src/mcp/pool.ts`:

```ts
/**
 * Run-scoped MCP connections, keyed by (serverId, workdir).
 *
 * The workdir is in the key because nax runs stories in PARALLEL WORKTREES and a
 * server like codebase-memory-mcp is inherently cwd-scoped: it indexes a
 * repository. One run-scoped connection pointed at the main checkout would
 * answer every worktree's queries against the wrong tree — a silent wrong
 * answer, not a crash. Cost: one subprocess per active worktree per server.
 *
 * Requests are serialized per connection by construction: the turn loop
 * dispatches tool calls in a sequential `for` loop
 * (src/agents/native/session/turn-loop.ts:406), awaiting each before the next,
 * so one hop never has two calls in flight against one server.
 */
import { getSafeLogger } from "@/logger";
import type { McpServerConfig } from "@/config";
import { connectMcpServer } from "./client";
import type { McpCallResult, McpConnection, McpToolDescriptor } from "./types";

/** Connect (and tools/list) deadline. Shorter than a call: a server that cannot start in 15s will not. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** Mirrors `agent.native.transportRetry` (src/config/schemas-infra.ts) rather than inventing a shape. */
export const MCP_DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 2000 } as const;

export type McpServerEvent = { readonly serverId: string; readonly workdir: string; readonly at: string } & (
  | { readonly kind: "connected"; readonly pid: number | null; readonly toolCount: number }
  | { readonly kind: "connect-failed"; readonly reason: string; readonly attempt: number }
  | { readonly kind: "closed" }
);

export interface McpPool {
  listTools(serverId: string, workdir: string): Promise<readonly McpToolDescriptor[]>;
  call(
    serverId: string,
    workdir: string,
    tool: string,
    input: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<McpCallResult>;
  events(): readonly McpServerEvent[];
  close(): Promise<void>;
}

interface PidRegistryLike {
  register(pid: number): Promise<void>;
  unregister(pid: number): Promise<void>;
}

interface Entry {
  connection: McpConnection;
  tools: readonly McpToolDescriptor[];
}

export function createMcpPool(opts: {
  servers: Readonly<Record<string, McpServerConfig>>;
  pidRegistry?: PidRegistryLike;
  retry?: { maxAttempts: number; baseDelayMs: number };
  storyId?: string;
}): McpPool {
  const retry = opts.retry ?? MCP_DEFAULT_RETRY;
  // JSON.stringify, not a separator character: a workdir may contain anything a
  // filesystem allows, and a delimiter collision would silently merge two keys.
  const keyOf = (serverId: string, workdir: string): string => JSON.stringify([serverId, workdir]);
  const entries = new Map<string, Promise<Entry | undefined>>();
  const events: McpServerEvent[] = [];
  let closed = false;

  const record = (event: McpServerEvent): void => {
    events.push(event);
  };

  async function open(serverId: string, workdir: string): Promise<Entry | undefined> {
    const server = opts.servers[serverId];
    if (server === undefined || !server.enabled) return undefined;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        const connection = await connectMcpServer({
          serverId,
          workdir,
          command: server.command,
          args: server.args,
          env: server.env,
          connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
        });
        const pid = connection.pid;
        if (pid !== null) await opts.pidRegistry?.register(pid).catch(() => {});
        const tools = await connection.listTools();
        record({ kind: "connected", serverId, workdir, at: new Date().toISOString(), pid, toolCount: tools.length });
        getSafeLogger()?.info("mcp", `[pool] ${serverId} connected`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          pid,
          tools: tools.length,
        });
        return { connection, tools };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        record({ kind: "connect-failed", serverId, workdir, at: new Date().toISOString(), reason, attempt });
        getSafeLogger()?.warn("mcp", `[pool] ${serverId} connect failed`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          attempt,
          error: reason,
        });
        if (attempt < retry.maxAttempts && retry.baseDelayMs > 0) {
          await Bun.sleep(retry.baseDelayMs * attempt);
        }
      }
    }
    // Spec R8: failure degrades. The undefined entry is CACHED, so a wedged
    // server costs its attempt budget once per (server, workdir) per run rather
    // than on every hop.
    return undefined;
  }

  function entry(serverId: string, workdir: string): Promise<Entry | undefined> {
    if (closed) return Promise.resolve(undefined);
    const key = keyOf(serverId, workdir);
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    // Memoize the PROMISE, not the result: concurrent first use must await one
    // in-flight connect, never start a second subprocess.
    const pending = open(serverId, workdir);
    entries.set(key, pending);
    return pending;
  }

  return {
    async listTools(serverId, workdir) {
      return (await entry(serverId, workdir))?.tools ?? [];
    },

    async call(serverId, workdir, tool, input, callOpts) {
      const resolved = await entry(serverId, workdir);
      if (resolved === undefined) {
        // Error AS DATA (ADR-029 section 5, spec US-006): a dead server must not
        // throw into the turn loop, which would end the hop.
        const content = `MCP server "${serverId}" is unavailable; its tools cannot be called for this hop.`;
        return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
      }
      try {
        return await resolved.connection.callTool(tool, input, callOpts);
      } catch (error) {
        const content = `MCP server "${serverId}" is unavailable: ${String(error)}`;
        return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
      }
    },

    events() {
      return events;
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      const settled = await Promise.allSettled(pending);
      await Promise.allSettled(
        settled.map(async (result) => {
          if (result.status !== "fulfilled" || result.value === undefined) return;
          const { connection } = result.value;
          const pid = connection.pid;
          await connection.close();
          if (pid !== null) await opts.pidRegistry?.unregister(pid).catch(() => {});
          record({ kind: "closed", serverId: connection.serverId, workdir: connection.workdir, at: new Date().toISOString() });
        }),
      );
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/mcp/pool.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the gates**

Run: `bun run check:all && bun run typecheck`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/pool.ts test/unit/mcp/pool.test.ts
git commit -m "feat(mcp): connection pool keyed by server and workdir"
```

---

### Task 4: Lockfile and `nax mcp lock`

**Files:**
- Create: `src/mcp/lock.ts`
- Modify: `src/mcp/index.ts` (add `export * from "./lock";` and `export * from "./pool";` — `src/cli/mcp.ts` reaches both through the barrel)
- Create: `src/cli/mcp.ts`
- Modify: `bin/nax.ts` (register the `mcp` command group, beside `authCmd` at `:1195`)
- Test: `test/unit/mcp/lock.test.ts`

**Interfaces:**
- Consumes: Task 2's `McpToolDescriptor`; Task 3's `createMcpPool`.
- Produces:
  - `interface McpLockFile { readonly version: 1; readonly servers: Record<string, Record<string, string>> }` — server id → tool name → schema hash.
  - `mcpLockPath(projectRoot: string): string` → `<projectRoot>/.nax/mcp-lock.json`
  - `schemaHash(schema: unknown): string`
  - `readMcpLock(projectRoot: string): Promise<McpLockFile | undefined>`
  - `writeMcpLock(projectRoot: string, lock: McpLockFile): Promise<void>`
  - `applyLock(locked: Record<string, string> | undefined, discovered: readonly McpToolDescriptor[]): { admitted: readonly McpToolDescriptor[]; withheld: readonly { name: string; reason: "absent-from-lock" | "schema-changed" }[] }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp/lock.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLock, mcpLockPath, readMcpLock, schemaHash, writeMcpLock } from "@/mcp/lock";
import type { McpToolDescriptor } from "@/mcp/types";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-lock-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tool = (name: string, schema: Record<string, unknown> = { type: "object" }): McpToolDescriptor => ({
  name,
  description: "d",
  inputSchema: schema,
});

describe("schemaHash", () => {
  test("is stable across key order", () => {
    expect(schemaHash({ a: 1, b: { c: 2, d: 3 } })).toBe(schemaHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test("changes when the schema changes", () => {
    expect(schemaHash({ type: "object" })).not.toBe(schemaHash({ type: "object", required: ["q"] }));
  });
});

describe("applyLock", () => {
  test("admits a tool whose name and schema hash match", () => {
    const t = tool("search_graph");
    const result = applyLock({ search_graph: schemaHash(t.inputSchema) }, [t]);
    expect(result.admitted.map((x) => x.name)).toEqual(["search_graph"]);
    expect(result.withheld).toEqual([]);
  });

  test("withholds a tool absent from the lock", () => {
    const result = applyLock({}, [tool("delete_project")]);
    expect(result.admitted).toEqual([]);
    expect(result.withheld).toEqual([{ name: "delete_project", reason: "absent-from-lock" }]);
  });

  test("withholds a tool whose schema hash changed", () => {
    const result = applyLock({ search_graph: "deadbeef" }, [tool("search_graph")]);
    expect(result.admitted).toEqual([]);
    expect(result.withheld).toEqual([{ name: "search_graph", reason: "schema-changed" }]);
  });

  test("an absent lock section withholds everything", () => {
    expect(applyLock(undefined, [tool("a"), tool("b")]).withheld.map((w) => w.name)).toEqual(["a", "b"]);
  });
});

describe("read/write", () => {
  test("round-trips and is byte-identical for an unchanged tool set", async () => {
    const dir = await tempDir();
    const lock = { version: 1 as const, servers: { memory: { b: "2", a: "1" } } };
    await writeMcpLock(dir, lock);
    const first = await Bun.file(mcpLockPath(dir)).text();
    await writeMcpLock(dir, JSON.parse(JSON.stringify(lock)));
    expect(await Bun.file(mcpLockPath(dir)).text()).toBe(first);
    expect(await readMcpLock(dir)).toEqual(lock);
  });

  test("keys are sorted so a re-run produces no diff noise", async () => {
    const dir = await tempDir();
    await writeMcpLock(dir, { version: 1, servers: { z: { b: "2", a: "1" }, a: { c: "3" } } });
    const text = await Bun.file(mcpLockPath(dir)).text();
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
  });

  test("a missing lock reads as undefined, not a throw", async () => {
    expect(await readMcpLock(await tempDir())).toBeUndefined();
  });

  test("a malformed lock reads as undefined", async () => {
    const dir = await tempDir();
    await Bun.write(mcpLockPath(dir), "{ not json");
    expect(await readMcpLock(dir)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/mcp/lock.test.ts`
Expected: FAIL — `Cannot find module '@/mcp/lock'`.

- [ ] **Step 3: Write the lockfile module**

Create `src/mcp/lock.ts`:

```ts
/**
 * Pinning for discovered MCP tool sets — `.nax/mcp-lock.json`.
 *
 * Without it, attaching a server grants whatever that server advertises TODAY:
 * a server upgrade silently widens the grant. codebase-memory-mcp ships
 * `delete_project`, `index_repository` and `manage_adr`, so this is a real
 * capability risk rather than a theoretical one.
 *
 * Same posture as `bun.lock`: drift is visible and refreshing it is deliberate
 * (`nax mcp lock`). A tool that appears later, or whose input schema changes,
 * is withheld until a human re-locks.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PROJECT_NAX_DIR } from "@/config";
import type { McpToolDescriptor } from "./types";

export interface McpLockFile {
  readonly version: 1;
  /** server id -> tool name -> input-schema hash */
  readonly servers: Record<string, Record<string, string>>;
}

export const MCP_LOCK_FILENAME = "mcp-lock.json";
export const MCP_LOCK_REFRESH_COMMAND = "nax mcp lock";

export function mcpLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_NAX_DIR, MCP_LOCK_FILENAME);
}

/** Key-sorted JSON, so a hash depends on the schema's content and not its serialisation order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(schema) ?? null)).digest("hex").slice(0, 16);
}

export async function readMcpLock(projectRoot: string): Promise<McpLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(mcpLockPath(projectRoot), "utf8")) as McpLockFile;
    if (parsed?.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) return undefined;
    return parsed;
  } catch {
    // Missing or malformed both mean "nothing is pinned", which withholds every
    // tool. Failing closed is the point; a throw here would abort a run over a
    // file the operator may simply not have created yet.
    return undefined;
  }
}

export async function writeMcpLock(projectRoot: string, lock: McpLockFile): Promise<void> {
  const servers = Object.fromEntries(
    Object.entries(lock.servers)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, tools]) => [
        id,
        Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ]),
  );
  await mkdir(join(projectRoot, PROJECT_NAX_DIR), { recursive: true });
  await writeFile(mcpLockPath(projectRoot), `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
}

export interface WithheldTool {
  readonly name: string;
  readonly reason: "absent-from-lock" | "schema-changed";
}

export function applyLock(
  locked: Record<string, string> | undefined,
  discovered: readonly McpToolDescriptor[],
): { admitted: readonly McpToolDescriptor[]; withheld: readonly WithheldTool[] } {
  const admitted: McpToolDescriptor[] = [];
  const withheld: WithheldTool[] = [];
  for (const tool of discovered) {
    const pinned = locked?.[tool.name];
    if (pinned === undefined) withheld.push({ name: tool.name, reason: "absent-from-lock" });
    else if (pinned !== schemaHash(tool.inputSchema)) withheld.push({ name: tool.name, reason: "schema-changed" });
    else admitted.push(tool);
  }
  return { admitted, withheld };
}
```

- [ ] **Step 4: Write the CLI command**

Create `src/cli/mcp.ts`:

```ts
/**
 * `nax mcp lock` — refresh `.nax/mcp-lock.json` from what each configured
 * server advertises right now.
 *
 * Connects every enabled server ONCE, at the project root. That is deliberate:
 * the lock pins a server's capability surface, which does not vary per worktree,
 * even though connections at runtime do (spec R7).
 */
import { loadConfig } from "@/config";
// The BARREL, not `@/mcp/pool` — `check:alias-internals` forbids a value import
// of `@/<dir>/<internal>` from `src/` once `src/<dir>/index.ts` exists.
import { createMcpPool, mcpLockPath, schemaHash, writeMcpLock } from "@/mcp";

// `loadConfig(startDir)` — NOT `loadConfigForWorkdir`, whose first argument is a
// config FILE path (src/config/loader.ts:403), not a directory. Every other CLI
// command loads this way (src/cli/setup.ts:31, src/cli/generate.ts:56).
export async function runMcpLockCommand(workdir: string): Promise<void> {
  const config = await loadConfig(workdir);
  const servers = config.mcp?.servers ?? {};
  const enabled = Object.entries(servers).filter(([, server]) => server.enabled);
  if (enabled.length === 0) {
    console.log("No enabled MCP servers configured; nothing to lock.");
    return;
  }

  const pool = createMcpPool({ servers });
  try {
    const locked: Record<string, Record<string, string>> = {};
    for (const [id] of enabled) {
      const tools = await pool.listTools(id, workdir);
      locked[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
      console.log(`${id}: ${tools.length} tool(s) locked`);
      if (tools.length === 0) console.log(`  (server advertised nothing - check \`${servers[id]?.command}\` runs)`);
    }
    await writeMcpLock(workdir, { version: 1, servers: locked });
    console.log(`Wrote ${mcpLockPath(workdir)}`);
  } finally {
    await pool.close();
  }
}
```

In `bin/nax.ts`, beside the `authCmd` group (`:1195`):

```ts
const mcpCmd = program.command("mcp").description("Manage MCP servers the native agent may call tools on");

mcpCmd
  .command("lock")
  .description("Refresh .nax/mcp-lock.json from what each configured server advertises")
  .action(async () => {
    const { runMcpLockCommand } = await import("../src/cli/mcp");
    await runMcpLockCommand(process.cwd());
  });
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/mcp/lock.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify the command is wired**

Run: `bun run dev mcp lock`
Expected: in this repo (no `mcp` block configured) it prints `No enabled MCP servers configured; nothing to lock.` and exits 0.

- [ ] **Step 7: Run the gates**

Run: `bun run check:all && bun run typecheck`
Expected: OK.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/lock.ts src/mcp/index.ts src/cli/mcp.ts bin/nax.ts test/unit/mcp/lock.test.ts
git commit -m "feat(mcp): pin discovered tool sets with .nax/mcp-lock.json"
```

---

### Task 5: The MCP tool provider

**Files:**
- Create: `src/mcp/provider.ts`
- Modify: `src/mcp/index.ts` (add `export * from "./provider";`)
- Test: `test/unit/mcp/provider.test.ts`

**Interfaces:**
- Consumes: Task 1's `McpConfig`; Task 3's `McpPool`; Task 4's `applyLock` / `readMcpLock` / `MCP_LOCK_REFRESH_COMMAND`; `ToolProvider`, `ProviderTool`, `validateProviderId` from `@/tools`.
- Produces:
  - `createMcpProviders(args: { config: McpConfig | undefined; pool: McpPool; projectRoot: string; storyId?: string }): readonly ToolProvider[]`
  - `withheldByLock(): readonly { serverId: string; name: string; reason: string }[]` is exposed on the pool's rollup in Task 8; this task records it through the `onWithheld` callback argument.
- `src/mcp/index.ts` barrel: `export * from "./client"; export * from "./lock"; export * from "./pool"; export * from "./provider"; export * from "./types";`

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp/provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@/config";
import { schemaHash } from "@/mcp/lock";
import type { McpLockFile } from "@/mcp/lock";
import type { McpPool } from "@/mcp/pool";
import { createMcpProviders } from "@/mcp/provider";
import type { McpToolDescriptor } from "@/mcp/types";

// `JSONSchema` is `Record<string, unknown>` (src/context/engine/types.ts:79), so
// a plain object literal assigns with no cast. `as never` is lint-banned
// repo-wide (biome-plugins/no-as-never.grit) — every fixture here is typed.
const schema = { type: "object", properties: { q: { type: "string" } } };
const hash = schemaHash(schema);

const descriptors: McpToolDescriptor[] = [
  { name: "search_graph", description: "Search the graph", inputSchema: schema },
  { name: "delete_project", description: "Danger", inputSchema: schema },
];

interface Call {
  workdir: string;
  tool: string;
}

function fakePool(over: Partial<McpPool> = {}): McpPool & { calls: Call[] } {
  const calls: Call[] = [];
  const base: McpPool = {
    listTools: async () => descriptors,
    call: async (_id, workdir, tool) => {
      calls.push({ workdir, tool });
      return { content: "ok", isError: false, bytesPreTruncation: 2 };
    },
    events: () => [],
    close: async () => {},
  };
  return { ...base, ...over, calls };
}

const server: McpServerConfig = {
  command: "fake",
  args: [],
  env: {},
  stages: ["run"],
  timeoutMs: 1234,
  enabled: true,
};

const lock: McpLockFile = { version: 1, servers: { memory: { search_graph: hash, delete_project: hash } } };

const build = (over: Partial<McpServerConfig> = {}, pool = fakePool()) =>
  createMcpProviders({
    config: { servers: { memory: { ...server, ...over } } },
    pool,
    projectRoot: "/proj",
    readLock: async () => lock,
  });

describe("createMcpProviders", () => {
  test("one provider per configured server, id = server id, kind = discovered", () => {
    const [provider] = build();
    expect(provider?.id).toBe("memory");
    expect(provider?.kind).toBe("discovered");
    expect(provider?.stages).toEqual(["run"]);
  });

  test("a disabled server contributes no provider", () => {
    expect(build({ enabled: false })).toEqual([]);
  });

  test("tools() returns every locked tool when allowedTools is omitted", async () => {
    const [provider] = build();
    expect((await provider!.tools("/w")).map((t) => t.localName)).toEqual(["search_graph", "delete_project"]);
  });

  test("allowedTools narrows, and never widens past the lock", async () => {
    const [provider] = build({ allowedTools: ["search_graph", "not_advertised"] });
    expect((await provider!.tools("/w")).map((t) => t.localName)).toEqual(["search_graph"]);
  });

  test("a tool absent from the lock is withheld", async () => {
    const withheld: { name: string; reason: string }[] = [];
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({ version: 1, servers: { memory: { search_graph: hash } } }),
      onWithheld: (entry) => withheld.push(entry),
    });
    expect((await providers[0]!.tools("/w")).map((t) => t.localName)).toEqual(["search_graph"]);
    expect(withheld).toEqual([
      { serverId: "memory", name: "delete_project", reason: "absent-from-lock" },
    ]);
  });

  test("a tool whose schema changed is withheld", async () => {
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({
        version: 1,
        servers: { memory: { search_graph: "stale", delete_project: hash } },
      }),
    });
    expect((await providers[0]!.tools("/w")).map((t) => t.localName)).toEqual(["delete_project"]);
  });

  test("run() calls the pool at the workdir tools() was resolved for, not the runtime's", async () => {
    const pool = fakePool();
    const [provider] = build({}, pool);
    const [tool] = await provider!.tools("/worktree/story-3");
    await tool!.run({ q: "x" }, { root: "/worktree/story-3", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 1 });
    expect(pool.calls).toEqual([{ workdir: "/worktree/story-3", tool: "search_graph" }]);
  });

  test("run() forwards the server's timeoutMs and the hop's maxBytes", async () => {
    const seen: unknown[] = [];
    const pool = fakePool({
      call: async (_id, _w, _t, _i, opts) => {
        seen.push(opts);
        return { content: "ok", isError: false, bytesPreTruncation: 2 };
      },
    });
    const [provider] = build({}, pool);
    const [tool] = await provider!.tools("/w");
    await tool!.run({}, { root: "/w", resolvedPaths: [], maxBytes: 999, maxFileBytes: 1 });
    expect(seen).toEqual([{ timeoutMs: 1234, maxBytes: 999 }]);
  });

  test("an error result comes back as data on ToolResult, never as a throw", async () => {
    const pool = fakePool({
      call: async () => ({ content: "server unavailable", isError: true, bytesPreTruncation: 18 }),
    });
    const [provider] = build({}, pool);
    const [tool] = await provider!.tools("/w");
    const result = await tool!.run({}, { root: "/w", resolvedPaths: [], maxBytes: 10, maxFileBytes: 1 });
    expect(result).toMatchObject({ isError: true, content: "server unavailable" });
  });

  test("the lock is read once, not once per hop", async () => {
    let reads = 0;
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async () => {
        reads++;
        return lock;
      },
    });
    await providers[0]!.tools("/a");
    await providers[0]!.tools("/b");
    expect(reads).toBe(1);
  });

  test("a duplicate provider id is refused at construction", () => {
    // Two servers cannot share an id through config (object keys are unique),
    // so the guard is against a future STATIC provider colliding: the helper
    // validates its own ids and rejects a collision with a reserved prefix.
    expect(() =>
      createMcpProviders({
        config: { servers: { bad__id: server } },
        pool: fakePool(),
        projectRoot: "/proj",
        readLock: async () => lock,
      }),
    ).toThrow(/provider id/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/mcp/provider.test.ts`
Expected: FAIL — `Cannot find module '@/mcp/provider'`.

- [ ] **Step 3: Write the provider**

Create `src/mcp/provider.ts`:

```ts
/**
 * One `ToolProvider` (src/tools/provider-types.ts) per configured MCP server.
 *
 * The provider id IS the config key, which makes one identifier carry across
 * `mcp.servers.<id>`, the advertised name `<id>__<tool>`, the ledger's
 * `provider` field and every denial message. Ruling D1 of this plan: the
 * spec's `mcp__<server>__<tool>` is unreachable because `namespacedToolName`
 * owns the namespace and `validateProviderId` forbids `__` inside an id.
 *
 * WHICH WORKDIR: `tools(workdir)` receives the HOP'S PERMITTED ROOT from
 * `resolveProviderTools`, and every `run()` closure below captures THAT value.
 * Reaching for the runtime's workdir instead — which is right there on the
 * object the pool hangs off — silently reintroduces the stale-index bug spec R7
 * exists to prevent, and it passes every test that does not use two worktrees.
 */
import type { McpConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import type { ProviderTool, ToolProvider } from "@/tools";
import { validateProviderId } from "@/tools";
import { applyLock, MCP_LOCK_REFRESH_COMMAND, type McpLockFile, readMcpLock } from "./lock";
import type { McpPool } from "./pool";

export interface McpWithheldEntry {
  readonly serverId: string;
  readonly name: string;
  readonly reason: string;
}

export function createMcpProviders(args: {
  config: McpConfig | undefined;
  pool: McpPool;
  projectRoot: string;
  storyId?: string;
  /** Seam for tests; defaults to reading `.nax/mcp-lock.json` under projectRoot. */
  readLock?: (projectRoot: string) => Promise<McpLockFile | undefined>;
  onWithheld?: (entry: McpWithheldEntry) => void;
}): readonly ToolProvider[] {
  const servers = Object.entries(args.config?.servers ?? {}).filter(([, server]) => server.enabled);
  if (servers.length === 0) return [];

  // Validated once, at construction: a bad id must fail where the config is
  // read, not on the first hop that happens to reach this server.
  for (const [id] of servers) validateProviderId(id);

  const read = args.readLock ?? readMcpLock;
  // Memoized: the lock pins a capability surface, which does not change during a
  // run, and a per-hop filesystem read on the dispatch path is pure waste.
  let lockPromise: Promise<McpLockFile | undefined> | undefined;
  const lock = (): Promise<McpLockFile | undefined> => (lockPromise ??= read(args.projectRoot));

  return servers.map(([serverId, server]): ToolProvider => {
    return {
      id: serverId,
      kind: "discovered",
      stages: server.stages,
      async tools(workdir: string): Promise<readonly ProviderTool[]> {
        const discovered = await args.pool.listTools(serverId, workdir);
        if (discovered.length === 0) return [];

        const { admitted, withheld } = applyLock((await lock())?.servers[serverId], discovered);
        for (const entry of withheld) {
          args.onWithheld?.({ serverId, name: entry.name, reason: entry.reason });
          // The tool is never advertised, so no call is made and there is no
          // denial to carry a redirect. This log is where the refresh
          // instruction actually reaches a human.
          getSafeLogger()?.warn("mcp", `[provider] ${serverId}__${entry.name} withheld`, {
            storyId: args.storyId,
            serverId,
            tool: entry.name,
            reason: entry.reason,
            refresh: MCP_LOCK_REFRESH_COMMAND,
          });
        }

        const allowed = server.allowedTools;
        const selected = allowed === undefined ? admitted : admitted.filter((tool) => allowed.includes(tool.name));

        return selected.map((tool) => ({
          localName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          run: async (input, ctx) => {
            const result = await args.pool.call(serverId, workdir, tool.name, input, {
              timeoutMs: server.timeoutMs,
              maxBytes: ctx.maxBytes,
            });
            return {
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
              resultBytesPreTruncation: result.bytesPreTruncation,
            };
          },
        }));
      },
    };
  });
}
```

Append to `src/mcp/index.ts`, so the barrel is now complete:

```ts
export * from "./client";
export * from "./lock";
export * from "./pool";
export * from "./provider";
export * from "./types";
```

Note: `resultBytesPreTruncation` on the returned `ToolResult` does not exist yet — Task 8 adds it to the `ToolResult` interface. Until then `bun run typecheck` will flag it. **Either do Task 8's Step 3 (the one-line interface addition) now, or drop the field and re-add it in Task 8.** Doing the interface line now is preferred: it is two lines and keeps this task's tests honest.

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/mcp/provider.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the gates**

Run: `bun run check:all && bun run typecheck`
Expected: OK. If `check:import-cycles` reports a new cycle, the cause is `src/mcp/` importing from `@/tools`'s barrel while `@/tools` reaches back — import `@/tools/provider-types` directly instead of the barrel.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/provider.ts src/mcp/index.ts src/tools/registry.ts test/unit/mcp/provider.test.ts
git commit -m "feat(mcp): expose configured servers as discovered tool providers"
```

---

### Task 6: Runtime wiring

**Files:**
- Modify: `src/runtime/index.ts` (`NaxRuntime` interface `:150-252`, `createRuntime` `:282`, `close()` `:424-447`)
- Modify: `src/operations/call.ts:232-263` (`runOptions`)
- Test: `test/unit/runtime/mcp-wiring.test.ts`

**Interfaces:**
- Consumes: Task 3's `createMcpPool`, Task 5's `createMcpProviders`.
- Produces: `NaxRuntime.toolProviders: readonly ToolProvider[]` and `NaxRuntime.mcpPool: McpPool` (the latter for the Task 8 rollup and for tests; the pool is closed by `runtime.close()`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/runtime/mcp-wiring.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxConfigSchema } from "@/config";
import { createRuntime } from "@/runtime";

const runtimes: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const workdir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-runtime-"));
  dirs.push(dir);
  return dir;
};

const configWith = (servers: Record<string, unknown>) =>
  NaxConfigSchema.parse({ name: "probe", mcp: { servers } });

describe("createRuntime MCP wiring", () => {
  test("no mcp block means no providers", async () => {
    const runtime = createRuntime(NaxConfigSchema.parse({ name: "probe" }), await workdir());
    runtimes.push(runtime);
    expect(runtime.toolProviders).toEqual([]);
  });

  test("a configured server becomes one provider, id = server id", async () => {
    const runtime = createRuntime(
      configWith({ memory: { command: "fake", stages: ["run"] } }),
      await workdir(),
    );
    runtimes.push(runtime);
    expect(runtime.toolProviders.map((p) => p.id)).toEqual(["memory"]);
    expect(runtime.toolProviders[0]?.stages).toEqual(["run"]);
  });

  test("a disabled server contributes no provider", async () => {
    const runtime = createRuntime(
      configWith({ memory: { command: "fake", stages: ["run"], enabled: false } }),
      await workdir(),
    );
    runtimes.push(runtime);
    expect(runtime.toolProviders).toEqual([]);
  });

  test("construction spawns nothing — connection is lazy", async () => {
    // `command` cannot exist; if construction connected eagerly this would warn
    // or throw. It must simply build.
    const runtime = createRuntime(
      configWith({ memory: { command: "definitely-not-a-real-binary-xyz", stages: ["*"] } }),
      await workdir(),
    );
    runtimes.push(runtime);
    expect(runtime.toolProviders.length).toBe(1);
  });

  test("close() is idempotent with a pool attached", async () => {
    const runtime = createRuntime(configWith({ memory: { command: "fake", stages: ["run"] } }), await workdir());
    await runtime.close();
    await runtime.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/runtime/mcp-wiring.test.ts`
Expected: FAIL — `runtime.toolProviders` is undefined.

- [ ] **Step 3: Wire the runtime**

In `src/runtime/index.ts`, add to the `NaxRuntime` interface beside `routingCache` (`:250`):

```ts
  /**
   * MCP connection pool for this run, keyed by (serverId, workdir). Closed by
   * `close()`. Exposed so the run rollup can read its lifecycle events.
   */
  readonly mcpPool: import("../mcp").McpPool;
  /**
   * Tool providers advertised to every native dispatch this run. Built from
   * `config.mcp`; empty when no server is configured or all are disabled.
   */
  readonly toolProviders: readonly import("@/tools").ToolProvider[];
```

In `createRuntime`, after `const pidRegistry = ...` (`:319`):

```ts
  // Constructed synchronously and connected LAZILY: a run does not know its
  // stage set upfront, and an eager connect would pay subprocess cost for
  // servers no executed stage ever reaches.
  const mcpPool = createMcpPool({
    servers: config.mcp?.servers ?? {},
    pidRegistry,
  });
  const toolProviders = createMcpProviders({
    config: config.mcp,
    pool: mcpPool,
    projectRoot: workdir,
  });
```

Add both to the returned runtime object, and close the pool inside `close()` — before the flush/drain `Promise.allSettled` so a wedged server cannot outlive the artifacts:

```ts
      await mcpPool.close();
      const results = await Promise.allSettled([promptAuditor.flush(), reviewAuditor.flush(), costAggregator.drain()]);
```

Import at the top of the file: `import { createMcpPool, createMcpProviders, type McpPool } from "../mcp";`

- [ ] **Step 4: Deliver the providers to both hops**

Both dispatch hops (`src/operations/build-hop-callback.ts:321` and `src/runtime/session-run-hop.ts:63`) read `options.providers`, and both receive options derived from the single `runOptions` literal in `src/operations/call.ts:232`. One injection covers both — verified on `3aaa468c4`: `grep -rn "declaredTools:" src` returns exactly one producer (`call.ts:247`), and `codingToolRoot:` likewise (`:249`), so no other site builds tool-bearing run options that could miss the providers. Add after `declaredTools:` (`:249`):

```ts
    // Both hops resolve providers from this one object (build-hop-callback and
    // session-run-hop each take their options from here), so injecting once
    // cannot leave the two paths advertising different tool sets — the drift
    // both hops' comments warn about.
    ...(ctx.runtime.toolProviders.length > 0 ? { providers: ctx.runtime.toolProviders } : {}),
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/runtime/mcp-wiring.test.ts test/unit/agents/coding-tool-support-providers.test.ts`
Expected: PASS both — the second is #2031's existing provider suite and must stay green.

- [ ] **Step 6: Run the gates**

Run: `bun run check:all && bun run typecheck && bun run test`
Expected: OK, full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/index.ts src/operations/call.ts test/unit/runtime/mcp-wiring.test.ts
git commit -m "feat(runtime): build the mcp pool and advertise its providers"
```

---

### Task 7: Failure, restart and timeout, end to end

Task 3 built the mechanics; this task proves the *behaviours* spec US-006 names, against the pool and provider together, and fixes whatever they expose.

**Files:**
- Test: `test/unit/mcp/failure.test.ts`
- Modify (as the tests require): `src/mcp/pool.ts`, `src/mcp/provider.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5. Produces no new exports.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp/failure.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import type { McpLockFile } from "@/mcp/lock";
import { schemaHash } from "@/mcp/lock";
import { createMcpPool } from "@/mcp/pool";
import { createMcpProviders } from "@/mcp/provider";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

const schema = { type: "object" };
const server: McpServerConfig = { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 50, enabled: true };
const lock: McpLockFile = { version: 1, servers: { memory: { t: schemaHash(schema) } } };

function sdk(behaviour: { onCall?: () => unknown }) {
  Object.assign(_mcpClientDeps, {
    createTransport: () => ({ pid: 7, close: async () => {} }),
    createClient: () => ({
      connect: async () => {},
      listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: schema }] }),
      callTool: async () => (behaviour.onCall ? behaviour.onCall() : { content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }),
  });
}

const providerFor = (pool: ReturnType<typeof createMcpPool>) =>
  createMcpProviders({
    config: { servers: { memory: server } },
    pool,
    projectRoot: "/proj",
    readLock: async () => lock,
  })[0]!;

const ctx = { root: "/w", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 1 };

describe("US-006 failure behaviour", () => {
  test("a server whose command does not exist degrades: no tools, no throw", async () => {
    Object.assign(_mcpClientDeps, {
      createTransport: () => ({ pid: null, close: async () => {} }),
      createClient: () => ({ connect: async () => { throw new Error("spawn ENOENT"); }, close: async () => {} }),
    });
    const pool = createMcpPool({ servers: { memory: server }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
    expect(await providerFor(pool).tools("/w")).toEqual([]);
    await pool.close();
  });

  test("a server that dies mid-hop yields an error tool-result, not an exception", async () => {
    sdk({ onCall: () => { throw new Error("EPIPE"); } });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const [tool] = await provider.tools("/w");
    const result = await tool!.run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    await pool.close();
  });

  test("the advertised tool set is unchanged for the rest of the hop after a death (R9)", async () => {
    let calls = 0;
    sdk({ onCall: () => { calls++; throw new Error("EPIPE"); } });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const tools = await provider.tools("/w");
    await tools[0]!.run({}, ctx);
    // Same resolved list is still callable; a second call still answers as data.
    expect((await tools[0]!.run({}, ctx)).isError).toBe(true);
    expect(calls).toBe(2);
    await pool.close();
  });

  test("a call exceeding timeoutMs returns an error result rather than hanging", async () => {
    // Never resolves — the pool's own deadline must be what ends the call. A
    // fixed sleep is banned in tests (.nax/rules/forbidden-patterns-tests.md).
    sdk({ onCall: () => new Promise(() => {}) });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const [tool] = await provider.tools("/w");
    const started = Date.now();
    const result = await tool!.run({}, ctx);
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    await pool.close();
  }, 10_000);

  test("a degraded server never prevents a healthy one from being advertised", async () => {
    let connects = 0;
    Object.assign(_mcpClientDeps, {
      createTransport: () => ({ pid: 7, close: async () => {} }),
      createClient: () => ({
        connect: async () => {
          connects++;
          if (connects === 1) throw new Error("ENOENT");
        },
        listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: schema }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      }),
    });
    const pool = createMcpPool({
      servers: { bad: { ...server }, memory: { ...server } },
      retry: { maxAttempts: 1, baseDelayMs: 0 },
    });
    const providers = createMcpProviders({
      config: { servers: { bad: server, memory: server } },
      pool,
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({
        version: 1,
        servers: { bad: lock.servers.memory, memory: lock.servers.memory },
      }),
    });
    expect((await providers[0]!.tools("/w")).length).toBe(0);
    expect((await providers[1]!.tools("/w")).length).toBe(1);
    await pool.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/unit/mcp/failure.test.ts`
Expected: the timeout case FAILS first — the SDK's `timeout` option is honoured by a real client, but the fake in these tests is not the SDK. Fix by enforcing the deadline in the pool rather than trusting the transport, which is also the honest behaviour against a wedged real server.

- [ ] **Step 3: Enforce the deadline in the pool**

In `src/mcp/pool.ts`, wrap the call in `call()`:

```ts
      try {
        // Belt and braces: the SDK honours `timeout` per request, but a
        // transport wedged below the protocol layer (a child that accepted the
        // write and never answers) would otherwise hold the hop open. The
        // ceiling lives here so it is enforced whatever the transport does.
        const deadline = new Promise<McpCallResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: `MCP call ${serverId}__${tool} exceeded ${callOpts.timeoutMs}ms`,
                isError: true,
                bytesPreTruncation: 0,
              }),
            callOpts.timeoutMs,
          ).unref?.(),
        );
        return await Promise.race([resolved.connection.callTool(tool, input, callOpts), deadline]);
      } catch (error) {
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/mcp/failure.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the gates**

Run: `bun run check:all && bun run typecheck`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/pool.ts test/unit/mcp/failure.test.ts
git commit -m "feat(mcp): bound a wedged call and degrade a dead server"
```

---

### Task 8: Audit and telemetry

**Files:**
- Modify: `src/tools/registry.ts` (`ToolResult.resultBytesPreTruncation`)
- Modify: `src/tools/runtime.ts` (`log()` + `callTool` pass it to the sink)
- Modify: `src/agents/coding-tool-support.ts` (record advertised-schema bytes per hop)
- Create: `src/mcp/rollup.ts`
- Modify: `src/runtime/index.ts` (`close()` writes the rollup)
- Test: `test/unit/tools/result-bytes-pre-truncation.test.ts`, `test/unit/mcp/rollup.test.ts`

**Interfaces:**
- Consumes: Task 3's `McpServerEvent`, Task 5's `McpWithheldEntry`, `advertisedSchemaBytes` (`src/tools/provider-advertise.ts:63`, shipped with #2031 and currently called by nothing in `src/`).
- Produces:
  - `ToolResult.resultBytesPreTruncation?: number`
  - `interface McpRunRollup { readonly runId: string; readonly servers: readonly { serverId: string; workdirs: number; connected: number; failed: number; toolsAdvertised: number }[]; readonly withheld: readonly McpWithheldEntry[]; readonly events: readonly McpServerEvent[] }`
  - `buildMcpRollup(args: { runId: string; events: readonly McpServerEvent[]; withheld: readonly McpWithheldEntry[] }): McpRunRollup`
  - `writeMcpRollup(outputDir: string, rollup: McpRunRollup): Promise<void>` → `<outputDir>/mcp/<runId>-servers.json`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tools/result-bytes-pre-truncation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools";

function runtimeWith(result: { content: string; resultBytesPreTruncation?: number }) {
  const calls: ToolCallRecord[] = [];
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "probe__t", patterns: ["*"] }], "/w"),
    sink: { record: (entry) => calls.push(entry), flush: async () => {} },
    providerIdByTool: new Map([["probe__t", "probe"]]),
    extraTools: [
      {
        name: "probe__t",
        description: "d",
        inputSchema: { type: "object" },
        scope: { pathFields: [] },
        run: async () => result,
      },
    ],
  });
  return { runtime, calls };
}

describe("ToolCallRecord.resultBytesPreTruncation", () => {
  test("is recorded when the tool reports it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short", resultBytesPreTruncation: 2_000_000 });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]?.resultBytesPreTruncation).toBe(2_000_000);
    expect(calls[0]?.resultBytes).toBe(5);
    expect(calls[0]?.provider).toBe("probe");
  });

  test("is absent when the tool does not report it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]).not.toHaveProperty("resultBytesPreTruncation");
  });
});
```

Create `test/unit/mcp/rollup.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpRollup, writeMcpRollup } from "@/mcp/rollup";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const at = "2026-09-13T00:00:00.000Z";

describe("buildMcpRollup", () => {
  test("answers 'was this server actually attached?' per server", () => {
    const rollup = buildMcpRollup({
      runId: "r1",
      withheld: [{ serverId: "memory", name: "delete_project", reason: "absent-from-lock" }],
      events: [
        { kind: "connected", serverId: "memory", workdir: "/a", at, pid: 1, toolCount: 3 },
        { kind: "connected", serverId: "memory", workdir: "/b", at, pid: 2, toolCount: 3 },
        { kind: "connect-failed", serverId: "docs", workdir: "/a", at, reason: "ENOENT", attempt: 1 },
      ],
    });
    expect(rollup.servers).toEqual([
      { serverId: "memory", workdirs: 2, connected: 2, failed: 0, toolsAdvertised: 3 },
      { serverId: "docs", workdirs: 1, connected: 0, failed: 1, toolsAdvertised: 0 },
    ]);
    expect(rollup.withheld.length).toBe(1);
  });

  test("an empty run rolls up to nothing", () => {
    expect(buildMcpRollup({ runId: "r1", events: [], withheld: [] }).servers).toEqual([]);
  });
});

describe("writeMcpRollup", () => {
  test("writes <outputDir>/mcp/<runId>-servers.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nax-mcp-rollup-"));
    dirs.push(dir);
    await writeMcpRollup(dir, buildMcpRollup({ runId: "r1", events: [], withheld: [] }));
    expect(await Bun.file(join(dir, "mcp", "r1-servers.json")).exists()).toBe(true);
  });

  test("writes nothing when there is nothing to say", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nax-mcp-rollup-"));
    dirs.push(dir);
    await writeMcpRollup(dir, { runId: "r1", servers: [], withheld: [], events: [] });
    expect(await Bun.file(join(dir, "mcp", "r1-servers.json")).exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/tools/result-bytes-pre-truncation.test.ts test/unit/mcp/rollup.test.ts`
Expected: FAIL — `resultBytesPreTruncation` never reaches the sink; `@/mcp/rollup` does not exist.

- [ ] **Step 3: Plumb the pre-truncation size**

In `src/tools/registry.ts`, on `ToolResult` (after the `audit` field, `:36`):

```ts
  /**
   * Result size in bytes BEFORE the tool truncated to `ctx.maxBytes`. Set by
   * tools whose payload is unbounded by nature — an MCP graph query can return
   * megabytes. `resultBytes` on the ledger is measured after the slice, so
   * without this a 2 MB result and a 40 KB one are indistinguishable and "how
   * much did we discard" is unanswerable.
   */
  readonly resultBytesPreTruncation?: number;
```

In `src/tools/runtime.ts`, add a parameter to `log()` (after `audit`) and forward it to the sink:

```ts
    resultBytesPreTruncation?: number,
```

```ts
      ...(provider !== undefined ? { provider } : {}),
      ...(resultBytesPreTruncation !== undefined ? { resultBytesPreTruncation } : {}),
```

and pass it at the success call site (the `log(policyIdentity, kind, result.content.length, ...)` call):

```ts
        log(
          policyIdentity,
          kind,
          result.content.length,
          input,
          false,
          kind === "error" ? result.content : undefined,
          tool.routineErrors,
          result.audit,
          result.resultBytesPreTruncation,
        );
```

- [ ] **Step 4: Record the per-hop schema tax**

In `src/agents/coding-tool-support.ts`, immediately after `const tools = runtime.advertised(advertised);` (`:147`):

```ts
  // The fixed per-hop cost of advertising provider tools: their schemas enter
  // the prompt whether or not any is called. #2031 shipped the meter and left
  // it unread; this is its consumer, and the same instrument nax#1991's
  // context-burn report needs.
  const providerTools = tools.filter((tool) => args.providerIdByTool?.has(tool.name) === true);
  if (providerTools.length > 0) {
    getSafeLogger()?.debug("tools", "[provider] advertised", {
      storyId: args.storyId,
      count: providerTools.length,
      schemaBytes: advertisedSchemaBytes(providerTools),
    });
  }
```

Add `advertisedSchemaBytes` to the existing `@/tools` import block at the top of the file.

- [ ] **Step 5: Write the rollup**

Create `src/mcp/rollup.ts`:

```ts
/**
 * Per-run MCP server rollup.
 *
 * Server LIFECYCLE belongs here rather than in `ToolCallRecord`, whose
 * semantics are strictly per-call: a run must be able to answer "was
 * codebase-memory actually attached?" without log spelunking, and a server that
 * failed to connect made no calls to look for.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerEvent } from "./pool";
import type { McpWithheldEntry } from "./provider";

export interface McpServerSummary {
  readonly serverId: string;
  readonly workdirs: number;
  readonly connected: number;
  readonly failed: number;
  readonly toolsAdvertised: number;
}

export interface McpRunRollup {
  readonly runId: string;
  readonly servers: readonly McpServerSummary[];
  readonly withheld: readonly McpWithheldEntry[];
  readonly events: readonly McpServerEvent[];
}

export function buildMcpRollup(args: {
  runId: string;
  events: readonly McpServerEvent[];
  withheld: readonly McpWithheldEntry[];
}): McpRunRollup {
  const byServer = new Map<string, { workdirs: Set<string>; connected: number; failed: number; tools: number }>();
  for (const event of args.events) {
    const entry = byServer.get(event.serverId) ?? { workdirs: new Set<string>(), connected: 0, failed: 0, tools: 0 };
    entry.workdirs.add(event.workdir);
    if (event.kind === "connected") {
      entry.connected++;
      entry.tools = Math.max(entry.tools, event.toolCount);
    } else if (event.kind === "connect-failed") {
      entry.failed++;
    }
    byServer.set(event.serverId, entry);
  }

  return {
    runId: args.runId,
    servers: [...byServer.entries()].map(([serverId, entry]) => ({
      serverId,
      workdirs: entry.workdirs.size,
      connected: entry.connected,
      // One failed attempt per connect budget is expected noise; the count is
      // what distinguishes "retried once and recovered" from "never came up".
      failed: entry.failed,
      toolsAdvertised: entry.tools,
    })),
    withheld: args.withheld,
    events: args.events,
  };
}

export async function writeMcpRollup(outputDir: string, rollup: McpRunRollup): Promise<void> {
  if (rollup.servers.length === 0 && rollup.withheld.length === 0) return;
  const dir = join(outputDir, "mcp");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${rollup.runId}-servers.json`), `${JSON.stringify(rollup, null, 2)}\n`);
}
```

- [ ] **Step 6: Write it at close**

In `src/runtime/index.ts`, collect withheld entries by passing `onWithheld` into `createMcpProviders`:

```ts
  const mcpWithheld: import("../mcp").McpWithheldEntry[] = [];
  const toolProviders = createMcpProviders({
    config: config.mcp,
    pool: mcpPool,
    projectRoot: workdir,
    onWithheld: (entry) => mcpWithheld.push(entry),
  });
```

and in `close()`, after `await mcpPool.close();`:

```ts
      await writeMcpRollup(outputDir, buildMcpRollup({ runId, events: mcpPool.events(), withheld: mcpWithheld })).catch(
        (error: unknown) => logger.warn("runtime", "mcp rollup write failed", { error: String(error) }),
      );
```

- [ ] **Step 7: Run the tests**

Run: `bun test test/unit/tools/ test/unit/mcp/ test/unit/agents/coding-tool-support-providers.test.ts`
Expected: PASS throughout — the pre-existing tool and provider suites included.

- [ ] **Step 8: Run the gates**

Run: `bun run check:all && bun run typecheck && bun run test`
Expected: OK, full suite green.

- [ ] **Step 9: Commit**

```bash
git add src/tools/registry.ts src/tools/runtime.ts src/agents/coding-tool-support.ts \
        src/mcp/rollup.ts src/runtime/index.ts \
        test/unit/tools/result-bytes-pre-truncation.test.ts test/unit/mcp/rollup.test.ts
git commit -m "feat(mcp): ledger pre-truncation bytes and roll up server lifecycle"
```

---

### Task 9: Fake MCP server fixture and integration tests

Everything so far tests against a faked SDK. This task proves the real protocol path — a real subprocess, a real handshake — and the two properties that unit tests structurally cannot reach: R7's two-worktree case and a mid-hop death.

**Files:**
- Create: `test/fixtures/mcp/fake-server.ts`
- Test: `test/integration/mcp/stdio-server.test.ts`
- Test: `test/unit/mcp/acp-exclusion.test.ts`

**Interfaces:**
- Consumes: every prior task. Produces no `src/` exports.

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/mcp/fake-server.ts` — a real MCP server over stdio, driven by env vars:

```ts
#!/usr/bin/env bun
/**
 * Minimal real MCP server for tests: real protocol, real subprocess, no network.
 *
 * Env switches:
 *   FAKE_MCP_TOOL_SUFFIX  extra tool advertised, to simulate a server upgrade
 *   FAKE_MCP_DIE_ON_CALL  exit(1) instead of answering the first tools/call
 *   FAKE_MCP_HANG_ON_CALL never answer a tools/call (tests the deadline)
 *   FAKE_MCP_BIG_RESULT   answer with this many bytes (tests truncation)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake", version: "1" }, { capabilities: { tools: {} } });

const tools = [
  { name: "echo", description: "Echoes cwd and input", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  ...(process.env.FAKE_MCP_TOOL_SUFFIX ? [{ name: `extra_${process.env.FAKE_MCP_TOOL_SUFFIX}`, description: "Added later", inputSchema: { type: "object" } }] : []),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.FAKE_MCP_DIE_ON_CALL) process.exit(1);
  if (process.env.FAKE_MCP_HANG_ON_CALL) await new Promise(() => {});
  const big = process.env.FAKE_MCP_BIG_RESULT;
  const text = big ? "x".repeat(Number(big)) : `cwd=${process.cwd()} q=${String((request.params.arguments as { q?: string })?.q ?? "")}`;
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Write the failing integration test**

Create `test/integration/mcp/stdio-server.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpPool } from "@/mcp/pool";
import { runMcpLockCommand } from "@/cli/mcp";
import type { McpServerConfig } from "@/config";
import type { McpLockFile } from "@/mcp/lock";
import { schemaHash, writeMcpLock } from "@/mcp/lock";
import { createMcpProviders } from "@/mcp/provider";
import type { ToolRunContext } from "@/tools";

const FIXTURE = resolve(import.meta.dir, "../../fixtures/mcp/fake-server.ts");
const dirs: string[] = [];
const pools: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((p) => p.close()));
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-it-"));
  dirs.push(dir);
  return dir;
};

const serverConfig = (env: Record<string, string> = {}, over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: "bun",
  args: [FIXTURE],
  env,
  stages: ["*"],
  timeoutMs: 3_000,
  enabled: true,
  ...over,
});

/** Lock the tool set the fixture currently advertises, so `applyLock` admits it. */
async function lockFor(p: ReturnType<typeof createMcpPool>, dir: string, ids: string[] = ["memory"]): Promise<McpLockFile> {
  const servers: McpLockFile["servers"] = {};
  for (const id of ids) {
    const tools = await p.listTools(id, dir);
    servers[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
  }
  return { version: 1, servers };
}

function pool(env: Record<string, string> = {}) {
  const created = createMcpPool({ servers: { memory: serverConfig(env) }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  pools.push(created);
  return created;
}

const ctx = (root: string, maxBytes = 40_000): ToolRunContext => ({
  root,
  resolvedPaths: [],
  maxBytes,
  maxFileBytes: 1,
});

describe("real stdio MCP server", () => {
  test("discovers the advertised tool set over the real protocol", async () => {
    const tools = await pool().listTools("memory", await tempDir());
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  test("R7: two workdirs get two subprocesses, each answering from ITS OWN cwd", async () => {
    const [a, b] = [await tempDir(), await tempDir()];
    const p = pool();
    const lock = await lockFor(p, a);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig() } },
      pool: p,
      projectRoot: a,
      readLock: async () => lock,
    });

    const [toolA] = await providers[0]!.tools(a);
    const [toolB] = await providers[0]!.tools(b);
    const resultA = await toolA!.run({ q: "1" }, ctx(a));
    const resultB = await toolB!.run({ q: "2" }, ctx(b));

    // The whole point of R7: a cwd-scoped server must answer per worktree.
    expect(resultA.content).toContain(a);
    expect(resultB.content).toContain(b);
    expect(resultA.content).not.toContain(b);
  });

  test("a server that dies on call yields an error result and the run continues", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_DIE_ON_CALL: "1" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_DIE_ON_CALL: "1" }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [tool] = await providers[0]!.tools(dir);
    expect((await tool!.run({}, ctx(dir))).isError).toBe(true);
  }, 20_000);

  test("a hanging call is bounded by timeoutMs", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_HANG_ON_CALL: "1" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_HANG_ON_CALL: "1" }, { timeoutMs: 500 }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [tool] = await providers[0]!.tools(dir);
    const started = Date.now();
    expect((await tool!.run({}, ctx(dir))).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  test("a large result is truncated to maxBytes and reports its true size", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_BIG_RESULT: "500000" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_BIG_RESULT: "500000" }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [tool] = await providers[0]!.tools(dir);
    const result = await tool!.run({}, ctx(dir, 1_000));
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(1_000);
    expect(result.resultBytesPreTruncation).toBe(500_000);
  }, 20_000);

  test("nax mcp lock writes a lock, and a server upgrade is then withheld", async () => {
    const dir = await tempDir();
    await Bun.write(
      join(dir, ".nax", "config.json"),
      JSON.stringify({ name: "probe", mcp: { servers: { memory: { command: "bun", args: [FIXTURE], stages: ["*"] } } } }),
    );
    await runMcpLockCommand(dir);
    const locked = JSON.parse(await Bun.file(join(dir, ".nax", "mcp-lock.json")).text());
    expect(Object.keys(locked.servers.memory)).toEqual(["echo"]);

    // The server now advertises a second tool. It must NOT be grantable.
    const p = pool({ FAKE_MCP_TOOL_SUFFIX: "danger" });
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_TOOL_SUFFIX: "danger" }) } },
      pool: p,
      projectRoot: dir,
    });
    expect((await providers[0]!.tools(dir)).map((t) => t.localName)).toEqual(["echo"]);
  }, 30_000);
});
```

- [ ] **Step 3: Write the ACP-exclusion property test**

Create `test/unit/mcp/acp-exclusion.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { resolve } from "node:path";

/**
 * Spec section 7: ACP is out of scope by CONSTRUCTION — coding tools never reach
 * the ACP adapter — so no guard exists to test. This records the property, so a
 * future change that hands codingTools to ACP fails here and forces the MCP
 * question to be answered deliberately.
 */
describe("ACP carries no coding-tool or MCP surface", () => {
  test("no file under src/agents/acp references codingTools or mcp", async () => {
    const root = resolve(import.meta.dir, "../../../src/agents/acp");
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      const text = await Bun.file(file).text();
      if (/codingTools|toolProviders|\bmcp\b/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/mcp/acp-exclusion.test.ts && bun test test/integration/mcp/stdio-server.test.ts --timeout=60000`
Expected: PASS. Verified on `3aaa468c4`: `grep -rniE "codingTools|toolProviders|\bmcp\b" src/agents/acp/` returns zero files, so the assertion starts green rather than needing a carve-out. If a future prose match appears, narrow the regex to identifier shapes rather than deleting the test.

- [ ] **Step 5: Run the gates and the full suite**

Run: `bun run check:all && bun run typecheck && bun run test`
Expected: OK, full suite green. `check:test-mocks` in particular must stay clean — the fixture is a real subprocess, not an inline mock.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/mcp/fake-server.ts test/integration/mcp/stdio-server.test.ts test/unit/mcp/acp-exclusion.test.ts
git commit -m "test(mcp): real stdio server fixture covering R7 and mid-hop death"
```

---

### Task 10: Docs, and the measurement the feature is justified by

Spec section 6 is explicit: the premise that graph tools beat `Grep` sweeps is **plausible and unmeasured**, and nax#1990's "48% needs measuring, not assuming" applies here too. This task delivers the numbers, or states plainly that they were not collected.

**Files:**
- Create: `docs/superpowers/specs/2026-09-13-nax-mcp-client-results.md`
- Modify: `README.md` (a short `mcp` section beside the other config blocks)

- [ ] **Step 1: Write the user-facing docs**

In `README.md`, add a section documenting: the config block shape; that the id is the tool-name namespace (`codebase-memory__search_graph`); that `nax mcp lock` must be run before any tool is grantable; that MCP is advertised under the `unrestricted` profile only; and that `stages` is the attachment control.

- [ ] **Step 2: Configure the real server locally**

In this repo's `.nax/config.json`:

```json
{
  "mcp": {
    "servers": {
      "codebase-memory": {
        "command": "codebase-memory-mcp",
        "stages": ["run"],
        "allowedTools": ["search_graph", "trace_path", "get_code_snippet"]
      }
    }
  }
}
```

Then: `bun run dev mcp lock`
Expected: it prints the locked tool count and writes `.nax/mcp-lock.json`. **Commit the lockfile** — it is a pin, like `bun.lock`.

- [ ] **Step 3: STOP and ask before running**

The next step needs a real `nax run`. This repo's owner has a standing ruling: **never launch `nax run` (or `nax plan`) without explicit approval at the launch moment.** Ask, name the story you intend to run, and wait. Do not proceed on an approval given earlier in the session for something else.

- [ ] **Step 4: Run the A/B**

With approval, run one story twice — `mcp.servers.codebase-memory.enabled` `true` then `false` — and collect from the run artifacts:

- turn count and wall-clock per story,
- total tokens and cost from the cost ledger,
- `Grep`/`Glob` call counts from the tool-audit ledger,
- MCP call count and `resultBytesPreTruncation` totals (Task 8),
- advertised schema bytes per hop from the `[provider] advertised` debug lines (Task 8) — the fixed tax paid whether or not a tool is called.

- [ ] **Step 5: Write the results**

Create `docs/superpowers/specs/2026-09-13-nax-mcp-client-results.md` with the table, and a verdict sentence that is allowed to be negative. If the schema tax exceeds the turns saved, say so — the honest outcome of this measurement is a reason to narrow `allowedTools`, or to leave the server unattached by default.

- [ ] **Step 6: Commit**

```bash
git add README.md .nax/config.json .nax/mcp-lock.json docs/superpowers/specs/2026-09-13-nax-mcp-client-results.md
git commit -m "docs(mcp): configuration guide and A/B measurement results"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|---|---|
| US-001 `mcp` config block | 1 |
| US-002 pool keyed by `(serverId, workdir)` | 3 (+6 for construction and teardown) |
| US-003 discovery, adaptation, lockfile | 4 (lock), 5 (discovery + adaptation) |
| US-004 attachment and grants | 5 (`stages`, `allowedTools`), 6 (delivery to both hops). `Mcp(...)` expression **dropped — ruling D2** |
| US-005 untrusted input from servers | Inherited from `sanitizeProviderTools`, which runs for every `discovered` provider (`provider-advertise.ts:41`). Task 9's fixture exercises it end to end; no new code |
| US-006 failure, restart, timeout | 3 (retry), 7 (deadline, degradation) |
| US-007 audit and telemetry | 8 |
| R1 client only | Scope; Task 9's ACP test records the boundary |
| R2 attachment configured on the server | 1, 5 — `stages` on the server block; no `src/operations/` file is touched by any task |
| R3 bypass the declaration half | Inherited: `coding-tool-support.ts:270` appends provider names to `declared` |
| R4 `stages` honoured in every profile | **Narrowed by D2** — honoured in `unrestricted`, which is the only profile that resolves providers at all |
| R5 never wildcard-granted | Holds by construction; asserted by #2031's existing provider-gate tests |
| R6 lockfile | 4 |
| R7 pool key | 3 (unit), 9 (two real worktrees) |
| R8 failure degrades | 3, 7 |
| R9 immutable within a hop | 7 |
| R10 stdio only, behind a transport interface | 2 — `src/mcp/types.ts` is SDK-free, so HTTP later touches `client.ts` alone |
| Section 6 verification | 9 (fixtures), 10 (the real measurement) |

**Placeholder scan:** no TBDs. Every code step carries the code; every test step carries the assertions. The one deliberately open item is Task 10's result *values*, which cannot be written before the run.

**Type consistency:** `McpConnection`/`McpToolDescriptor`/`McpCallResult` (Task 2) are consumed unchanged by Tasks 3, 5 and 9. `McpPool` (Task 3) is consumed by 4, 5, 6 and 8. `applyLock` (Task 4) is called only in Task 5. `resultBytesPreTruncation` is named identically on `ToolResult` (Task 8 / Task 5 Step 3), in `ToolCallRecord` (already shipped, `tool-audit.ts:52`) and in the Task 9 assertion. The provider id is the config key at every layer.

**One cross-task hazard, stated once:** Task 5 returns `resultBytesPreTruncation` on a `ToolResult` whose interface Task 8 adds. Task 5 Step 3 says to add the two interface lines early. If you execute the tasks out of order, `bun run typecheck` catches it immediately.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute in this session with batch checkpoints.
