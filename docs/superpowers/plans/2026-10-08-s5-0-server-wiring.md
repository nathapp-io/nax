# S5-0 Server Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `nax-agent` binary in `@nathapp/nax-agent-acp` that resolves its configuration, logs to stderr, and answers ACP `initialize` over stdio. There are no session methods yet.

**Architecture:** all logic lives in `src/server/`. `main(deps)` parses the CLI, reads the `~/.nax` subset, resolves options, installs the logger and credentials, and serves an SDK `agent()` app on stdio until stdin ends or a signal arrives. `runCli(process)` adapts a real process to `MainDeps`. A three-line `bin/nax-agent.js` calls `runCli` from the built `dist/`.

**Tech Stack:** TypeScript ESM, `bun:test`, vitest (Node lane), `@agentclientprotocol/sdk` 1.7.0 (`agent`, `client`, `ndJsonStream`, `PROTOCOL_VERSION`), zod 4, `node:util` `parseArgs`.

**Spec:** `docs/superpowers/specs/2026-10-08-s5-acp-server-design.md` §3.1, §5.2, §6.1, §6.2, §6.4. **Master plan:** `docs/superpowers/plans/2026-10-08-s5-acp-server-master-plan.md` (Global Constraints, decisions M-2, M-3, M-5).

## Global Constraints

Everything in the master plan's Global Constraints applies. In particular:
- Run commands from `packages/nax-agent-acp`.
- Source files <= 600 lines; test files <= 800 lines.
- Per-file coverage >= 80%.
- No `throw new Error(` in `src/`.
- No Bun APIs in `src/`.
- Use `#src/` and `#test/` imports.
- stdout carries ACP frames only.
- S5-0 advertises only `promptCapabilities` and `agentInfo`. `loadSession` is `false`, and there are no `sessionCapabilities` and no `authMethods`.
- Env names: `NAX_AGENT_CONFIG_DIR`, `NAX_AGENT_SESSIONS_DIR`, `NAX_AGENT_MODEL`, `NAX_AGENT_MODE`, `NAX_AGENT_BASH_APPROVAL`, `NAX_AGENT_LOG`.
- Default sessions dir: `<configDir>/.agent-server/sessions`.
- Default mode: `ask`. Default bash approval: `gated`.

## Review Focus

- **A config file with an unrelated invalid section:** the server must start with defaults and one stderr warning. Task 2 tests it.
- **The legacy string model form, and the object form with extra keys** (`provider`, `pricing`, `env`): both must yield the model id. Task 2 tests them.
- **`--mode ask` with `--bash-approval raw`:** exits with code 2 and a clear message, not a later session failure. Task 2 tests it.
- **An unknown method, sent after initialize:** produces a JSON-RPC error frame, and stdout stays pure. Task 4 tests it.
- **stdin closing:** the process exits 0 rather than hanging. Task 3 and Task 4 test it.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/version.ts` | `packageVersion()`: reads `../../package.json`, which resolves from both `src/server` and `dist/server`. |
| `src/server/cli.ts` | `parseCli(argv)` and `USAGE`. |
| `src/server/nax-config.ts` | `loadNaxConfig(configDir, readFile)`: the zod-validated `~/.nax/config.json` subset. Also `credentialsFor(configDir, readFile)`. |
| `src/server/options.ts` | `resolveConfigDir(flags, env, home)` and `resolveServerOptions(...)`: flag > env > file > default. |
| `src/server/logger.ts` | `stderrLogger(level, write)`, an `AgentLogger` that writes JSON lines. |
| `src/server/capabilities.ts` | `initializeResponse(version)`. |
| `src/server/connection.ts` | `buildAgentApp({ version })` and `serveStdio(app, io)`. |
| `src/server/main.ts` | `main(deps)` and `MainDeps`. |
| `src/server/process-entry.ts` | `ProcessLike`, `mainDepsFrom(proc)`, `runCli(proc)`. |
| `src/server/index.ts` | Public `./server` entry. |
| `bin/nax-agent.js` | Published bin (M-2). |
| `scripts/lib/stage-manifest.ts`, `scripts/stage-publish.ts` | Stage the bin. |
| `test/fixtures/server/run.ts` | Runs `runCli(process)` under bun for the stdout-purity test. |
| `test/node/fixtures/server-smoke.mjs`, `test/node/pack-smoke.test.ts` | Node lane: the packed bin answers `initialize`. |

---

### Task 1: CLI parsing and package version

**Files:**
- Create: `packages/nax-agent-acp/src/server/cli.ts`
- Create: `packages/nax-agent-acp/src/server/version.ts`
- Test: `packages/nax-agent-acp/test/unit/server/cli.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/version.test.ts`

**Interfaces:**
- Produces:
  - `interface CliFlags { readonly configDir?: string; readonly sessionsDir?: string; readonly model?: string; readonly mode?: string; readonly bashApproval?: string }`
  - `type CliCommand = { kind: "acp"; flags: CliFlags } | { kind: "version" } | { kind: "help" } | { kind: "usage-error"; message: string }` (all fields readonly)
  - `function parseCli(argv: readonly string[]): CliCommand`
  - `const USAGE: string`
  - `function packageVersion(): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/server/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseCli, USAGE } from "#src/server/cli";

describe("parseCli", () => {
  test("no arguments and the explicit acp command both serve ACP with no flags", () => {
    expect(parseCli([])).toEqual({ kind: "acp", flags: {} });
    expect(parseCli(["acp"])).toEqual({ kind: "acp", flags: {} });
  });

  test("maps every option to its flag", () => {
    expect(
      parseCli([
        "--config-dir",
        "/c",
        "--sessions-dir",
        "/s",
        "--model",
        "minimax/MiniMax-M3",
        "--mode",
        "read",
        "--bash-approval",
        "escalate",
      ]),
    ).toEqual({
      kind: "acp",
      flags: { configDir: "/c", sessionsDir: "/s", model: "minimax/MiniMax-M3", mode: "read", bashApproval: "escalate" },
    });
  });

  test("--help wins over --version, and both win over a command", () => {
    expect(parseCli(["--version", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["acp", "--version"])).toEqual({ kind: "version" });
  });

  test("an unknown option or command is a usage error", () => {
    expect(parseCli(["--nope"])).toMatchObject({ kind: "usage-error" });
    expect(parseCli(["serve"])).toEqual({ kind: "usage-error", message: "unknown command: serve" });
    expect(parseCli(["acp", "extra"])).toEqual({ kind: "usage-error", message: "unknown command: acp extra" });
  });

  test("a string option without a value is a usage error", () => {
    expect(parseCli(["--model"])).toMatchObject({ kind: "usage-error" });
  });

  test("USAGE names every option and the env prefix", () => {
    for (const option of ["--config-dir", "--sessions-dir", "--model", "--mode", "--bash-approval", "--version"]) {
      expect(USAGE).toContain(option);
    }
    expect(USAGE).toContain("NAX_AGENT_");
  });
});
```

`test/unit/server/version.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { packageVersion } from "#src/server/version";

describe("packageVersion", () => {
  test("is the version in the package manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(packageVersion()).toBe(manifest.version);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/server/cli.test.ts ./test/unit/server/version.test.ts`
Expected: FAIL, because the modules `#src/server/cli` and `#src/server/version` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/server/cli.ts`:

```ts
/**
 * The `nax-agent` command line (S5 spec §6.1). S5-0 knows the ACP server only;
 * S5-4 adds `login <provider>`.
 */
import { parseArgs } from "node:util";

export interface CliFlags {
  readonly configDir?: string;
  readonly sessionsDir?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly bashApproval?: string;
}

export type CliCommand =
  | { readonly kind: "acp"; readonly flags: CliFlags }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };

export const USAGE = [
  "Usage: nax-agent [acp] [options]",
  "",
  "Runs the nax-agent ACP server on stdio.",
  "",
  "Options:",
  "  --config-dir <dir>                    nax config directory (default ~/.nax)",
  "  --sessions-dir <dir>                  session storage (default <config-dir>/.agent-server/sessions)",
  "  --model <provider/model[effort]>      default model for new sessions",
  "  --mode <none|read|ask|full>           default mode for new sessions (default ask)",
  "  --bash-approval <gated|escalate|raw>  default bash approval (default gated)",
  "  --version                             print the version",
  "  --help                                print this help",
  "",
  "Each option can also be set as NAX_AGENT_<OPTION>, for example NAX_AGENT_MODEL.",
].join("\n");

const OPTIONS = {
  "config-dir": { type: "string" },
  "sessions-dir": { type: "string" },
  model: { type: "string" },
  mode: { type: "string" },
  "bash-approval": { type: "string" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function flag<K extends keyof CliFlags>(key: K, value: string | undefined): Pick<CliFlags, K> {
  return (value === undefined ? {} : { [key]: value }) as Pick<CliFlags, K>;
}

export function parseCli(argv: readonly string[]): CliCommand {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return { kind: "usage-error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };
  const [command, ...rest] = positionals;
  if ((command !== undefined && command !== "acp") || rest.length > 0) {
    return { kind: "usage-error", message: `unknown command: ${positionals.join(" ")}` };
  }
  return {
    kind: "acp",
    flags: {
      ...flag("configDir", values["config-dir"]),
      ...flag("sessionsDir", values["sessions-dir"]),
      ...flag("model", values.model),
      ...flag("mode", values.mode),
      ...flag("bashApproval", values["bash-approval"]),
    },
  };
}
```

`src/server/version.ts`:

```ts
/**
 * The package version. `package.json` sits two directories above this module in
 * both layouts that run it: `src/server/` (workspace, bun) and `dist/server/`
 * (published package, Node).
 */
import { createRequire } from "node:module";
import { NaxError } from "@nathapp/nax-agent";

const requireJson = createRequire(import.meta.url);

export function packageVersion(): string {
  const manifest: unknown = requireJson("../../package.json");
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const { version } = manifest;
    if (typeof version === "string") return version;
  }
  throw new NaxError("nax-agent-acp package.json has no version", "ACP_SERVER_NO_VERSION", { stage: "acp-server" });
}
```

If `typecheck` rejects the `ReturnType<typeof parseArgs<...>>` annotation (an instantiation expression), replace it with `let parsed;` assigned inside the `try` and moved into a helper that returns `CliCommand | { values; positionals }`. Keep the behaviour identical.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/cli.test.ts ./test/unit/server/version.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/cli.ts src/server/version.ts test/unit/server/cli.test.ts test/unit/server/version.test.ts
git commit -m "feat(acp-server): nax-agent CLI parsing and package version (S5-0)"
```

---

### Task 2: `~/.nax` subset reader and option resolution

**Files:**
- Create: `packages/nax-agent-acp/src/server/nax-config.ts`
- Create: `packages/nax-agent-acp/src/server/options.ts`
- Test: `packages/nax-agent-acp/test/unit/server/nax-config.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/options.test.ts`

**Interfaces:**
- Consumes: `CliFlags` (Task 1).
- Produces:
  - `type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>`
  - `type BashApproval = "gated" | "escalate" | "raw"`
  - `interface TierModel { readonly tier: "fast" | "balanced" | "powerful"; readonly model: string; readonly contextWindow?: number }`
  - `interface AgentServerSection { readonly defaultMode?: AgentSessionProfile; readonly bashApproval?: BashApproval; readonly sessionsDir?: string }`
  - `interface NaxConfigSubset { readonly tiers: readonly TierModel[]; readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[]; readonly auth: CredentialAuthConfig; readonly agentServer: AgentServerSection }`
  - `interface LoadedNaxConfig { readonly config: NaxConfigSubset; readonly warning?: string }`
  - `const EMPTY_NAX_CONFIG: NaxConfigSubset`
  - `function loadNaxConfig(configDir: string, readFile: ReadTextFile): Promise<LoadedNaxConfig>`
  - `function credentialsFor(configDir: string, readFile: ReadTextFile): CredentialsConfig`
  - `interface ServerOptions { readonly configDir: string; readonly sessionsDir: string; readonly defaultModel?: string; readonly defaultMode: AgentSessionProfile; readonly bashApproval: BashApproval; readonly tiers: readonly TierModel[]; readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[] }`
  - `type OptionsResult = { readonly ok: true; readonly options: ServerOptions } | { readonly ok: false; readonly message: string }`
  - `type Env = Readonly<Record<string, string | undefined>>`
  - `function resolveConfigDir(flags: CliFlags, env: Env, home: string): string`
  - `function resolveServerOptions(input: { readonly flags: CliFlags; readonly env: Env; readonly file: NaxConfigSubset; readonly configDir: string }): OptionsResult`

`AgentSessionProfile`, `CredentialAuthConfig` and `CredentialsConfig` are type exports of `@nathapp/nax-agent`.

- [ ] **Step 1: Write the failing tests**

`test/unit/server/nax-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { credentialsFor, EMPTY_NAX_CONFIG, loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";

function reader(files: Readonly<Record<string, string>>): ReadTextFile {
  return async (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

const PATH = "/cfg/config.json";

describe("loadNaxConfig", () => {
  test("a missing file yields the defaults and no warning", async () => {
    expect(await loadNaxConfig("/cfg", reader({}))).toEqual({ config: EMPTY_NAX_CONFIG });
  });

  test("reads the native tiers in fast, balanced, powerful order, from both entry forms", async () => {
    const config = {
      models: {
        native: {
          powerful: "opencode-go/deepseek-v4.1-flash[high]",
          balanced: { provider: "minimax", model: "minimax/MiniMax-M3", contextWindow: 262144, pricing: { x: 1 } },
          fast: "minimax/MiniMax-M2.7",
          custom: "ignored/other",
        },
        claude: { fast: "claude-haiku" },
      },
    };
    const { config: loaded, warning } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(warning).toBeUndefined();
    expect(loaded.tiers).toEqual([
      { tier: "fast", model: "minimax/MiniMax-M2.7" },
      { tier: "balanced", model: "minimax/MiniMax-M3", contextWindow: 262144 },
      { tier: "powerful", model: "opencode-go/deepseek-v4.1-flash[high]" },
    ]);
  });

  test("reads catalog overrides, auth and the agentServer block", async () => {
    const config = {
      agent: { native: { catalogOverrides: [{ provider: "minimax", models: [{ id: "m" }] }] } },
      auth: { source: "exec", exec: { command: ["pass", "show", "nax"] } },
      agentServer: { defaultMode: "full", bashApproval: "escalate", sessionsDir: "/s" },
    };
    const { config: loaded } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.catalogOverrides).toEqual([{ provider: "minimax", models: [{ id: "m" }] }]);
    expect(loaded.auth).toEqual({
      source: "exec",
      exec: { command: ["pass", "show", "nax"], timeoutMs: 10000 },
      onChange: "warn",
    });
    expect(loaded.agentServer).toEqual({ defaultMode: "full", bashApproval: "escalate", sessionsDir: "/s" });
  });

  test("unrelated sections nax owns are ignored", async () => {
    const config = { review: { anything: true }, execution: 5, models: { native: { fast: "a/b" } } };
    const { config: loaded, warning } = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(warning).toBeUndefined();
    expect(loaded.tiers).toEqual([{ tier: "fast", model: "a/b" }]);
  });

  test("invalid JSON falls back to the defaults with a warning naming the file", async () => {
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: "{ nope" }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain(PATH);
  });

  test("an invalid section in the subset falls back to the defaults with a warning", async () => {
    const config = { agentServer: { defaultMode: "yolo" }, models: { native: { fast: "a/b" } } };
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify(config) }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("agentServer.defaultMode");
  });

  test("auth source exec without exec is invalid, as in nax", async () => {
    const loaded = await loadNaxConfig("/cfg", reader({ [PATH]: JSON.stringify({ auth: { source: "exec" } }) }));
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("exec");
  });

  test("a read error other than a missing file is a warning, not a crash", async () => {
    const failing: ReadTextFile = async () => {
      throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
    };
    const loaded = await loadNaxConfig("/cfg", failing);
    expect(loaded.config).toEqual(EMPTY_NAX_CONFIG);
    expect(loaded.warning).toContain("EACCES");
  });
});

describe("credentialsFor", () => {
  test("points the credential store at the config dir and re-reads auth per call", async () => {
    const files: Record<string, string> = { [PATH]: JSON.stringify({ auth: { onChange: "refuse" } }) };
    const creds = credentialsFor("/cfg", reader(files));
    expect(creds.configDir()).toBe("/cfg");
    expect(await creds.readAuthConfig()).toEqual({ source: "file", onChange: "refuse" });
    files[PATH] = JSON.stringify({});
    expect(await creds.readAuthConfig()).toEqual({ source: "file", onChange: "warn" });
  });
});
```

`test/unit/server/options.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { EMPTY_NAX_CONFIG, type NaxConfigSubset } from "#src/server/nax-config";
import { resolveConfigDir, resolveServerOptions } from "#src/server/options";

const FILE: NaxConfigSubset = {
  ...EMPTY_NAX_CONFIG,
  tiers: [
    { tier: "fast", model: "a/fast" },
    { tier: "balanced", model: "a/balanced", contextWindow: 1000 },
  ],
  agentServer: { defaultMode: "full", bashApproval: "escalate", sessionsDir: "/file-sessions" },
};

describe("resolveConfigDir", () => {
  test("flag > NAX_AGENT_CONFIG_DIR > NAX_GLOBAL_CONFIG_DIR > ~/.nax", () => {
    const env = { NAX_AGENT_CONFIG_DIR: "/agent", NAX_GLOBAL_CONFIG_DIR: "/global" };
    expect(resolveConfigDir({ configDir: "/flag" }, env, "/home/u")).toBe("/flag");
    expect(resolveConfigDir({}, env, "/home/u")).toBe("/agent");
    expect(resolveConfigDir({}, { NAX_GLOBAL_CONFIG_DIR: "/global" }, "/home/u")).toBe("/global");
    expect(resolveConfigDir({}, {}, "/home/u")).toBe("/home/u/.nax");
  });
});

describe("resolveServerOptions", () => {
  test("built-in defaults when nothing is set", () => {
    expect(resolveServerOptions({ flags: {}, env: {}, file: EMPTY_NAX_CONFIG, configDir: "/cfg" })).toEqual({
      ok: true,
      options: {
        configDir: "/cfg",
        sessionsDir: "/cfg/.agent-server/sessions",
        defaultMode: "ask",
        bashApproval: "gated",
        tiers: [],
        catalogOverrides: [],
      },
    });
  });

  test("the file overrides the defaults; the balanced tier is the default model", () => {
    const result = resolveServerOptions({ flags: {}, env: {}, file: FILE, configDir: "/cfg" });
    expect(result).toMatchObject({
      ok: true,
      options: {
        sessionsDir: "/file-sessions",
        defaultModel: "a/balanced",
        defaultMode: "full",
        bashApproval: "escalate",
      },
    });
  });

  test("env overrides the file; a flag overrides env", () => {
    const env = {
      NAX_AGENT_MODEL: "env/model",
      NAX_AGENT_MODE: "read",
      NAX_AGENT_BASH_APPROVAL: "raw",
      NAX_AGENT_SESSIONS_DIR: "/env-sessions",
    };
    expect(resolveServerOptions({ flags: {}, env, file: FILE, configDir: "/cfg" })).toMatchObject({
      ok: true,
      options: { defaultModel: "env/model", defaultMode: "read", bashApproval: "raw", sessionsDir: "/env-sessions" },
    });
    const flags = { model: "flag/model", mode: "none", bashApproval: "gated", sessionsDir: "/flag-sessions" };
    expect(resolveServerOptions({ flags, env, file: FILE, configDir: "/cfg" })).toMatchObject({
      ok: true,
      options: { defaultModel: "flag/model", defaultMode: "none", bashApproval: "gated", sessionsDir: "/flag-sessions" },
    });
  });

  test("an unknown mode or bash approval is an error naming the source", () => {
    expect(resolveServerOptions({ flags: { mode: "yolo" }, env: {}, file: FILE, configDir: "/c" })).toEqual({
      ok: false,
      message: 'invalid mode "yolo" (from --mode); expected one of none, read, ask, full',
    });
    expect(
      resolveServerOptions({ flags: {}, env: { NAX_AGENT_BASH_APPROVAL: "x" }, file: FILE, configDir: "/c" }),
    ).toEqual({
      ok: false,
      message: 'invalid bash approval "x" (from NAX_AGENT_BASH_APPROVAL); expected one of gated, escalate, raw',
    });
  });

  test("mode ask with raw bash approval is refused up front", () => {
    expect(
      resolveServerOptions({ flags: { mode: "ask", bashApproval: "raw" }, env: {}, file: FILE, configDir: "/c" }),
    ).toEqual({ ok: false, message: 'bash approval "raw" cannot be used with mode "ask"; use gated or escalate' });
  });

  test("no default model at all is allowed at startup (session/new reports it)", () => {
    const result = resolveServerOptions({ flags: {}, env: {}, file: EMPTY_NAX_CONFIG, configDir: "/c" });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.options.defaultModel : "not-ok").toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/server/nax-config.test.ts ./test/unit/server/options.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Write `src/server/nax-config.ts`**

```ts
/**
 * The subset of nax's global `config.json` the ACP server reads (S5 spec §6.2,
 * master plan M-3). It is a local reader, not nax's config loader: nax-agent-acp
 * does not depend on nax. Any problem falls back to the defaults with one
 * warning; the server still starts.
 */
import { join } from "node:path";
import type { AgentSessionProfile, CredentialAuthConfig, CredentialsConfig } from "@nathapp/nax-agent";
import { z } from "zod";

export type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;

export type BashApproval = "gated" | "escalate" | "raw";

export const TIERS = ["fast", "balanced", "powerful"] as const;

export interface TierModel {
  readonly tier: (typeof TIERS)[number];
  readonly model: string;
  readonly contextWindow?: number;
}

export interface AgentServerSection {
  readonly defaultMode?: AgentSessionProfile;
  readonly bashApproval?: BashApproval;
  readonly sessionsDir?: string;
}

export interface NaxConfigSubset {
  readonly tiers: readonly TierModel[];
  readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[];
  readonly auth: CredentialAuthConfig;
  readonly agentServer: AgentServerSection;
}

export interface LoadedNaxConfig {
  readonly config: NaxConfigSubset;
  readonly warning?: string;
}

export const MODES = ["none", "read", "ask", "full"] as const;
export const BASH_APPROVALS = ["gated", "escalate", "raw"] as const;

const ModelEntrySchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), contextWindow: z.number().int().positive().optional() }),
]);

/** nax's AuthConfigSchema (packages/nax/src/config/schemas-auth.ts), same defaults. */
const AuthSchema = z
  .object({
    source: z.enum(["file", "exec"]).default("file"),
    exec: z
      .object({
        command: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().min(1000).max(60000).default(10000),
      })
      .optional(),
    onChange: z.enum(["warn", "refuse"]).default("warn"),
  })
  .superRefine((auth, ctx) => {
    if (auth.source === "exec" && auth.exec === undefined) {
      ctx.addIssue({ code: "custom", path: ["exec"], message: 'exec is required when auth.source is "exec"' });
    }
  });

const SubsetSchema = z.object({
  models: z.object({ native: z.record(z.string(), z.unknown()).optional() }).optional(),
  agent: z
    .object({
      native: z.object({ catalogOverrides: z.array(z.record(z.string(), z.unknown())).optional() }).optional(),
    })
    .optional(),
  auth: AuthSchema.optional(),
  agentServer: z
    .object({
      defaultMode: z.enum(MODES).optional(),
      bashApproval: z.enum(BASH_APPROVALS).optional(),
      sessionsDir: z.string().min(1).optional(),
    })
    .optional(),
});

const DEFAULT_AUTH: CredentialAuthConfig = { source: "file", onChange: "warn" };

export const EMPTY_NAX_CONFIG: NaxConfigSubset = { tiers: [], catalogOverrides: [], auth: DEFAULT_AUTH, agentServer: {} };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tiersFrom(native: Readonly<Record<string, unknown>> | undefined): { tiers: TierModel[]; issue?: string } {
  const tiers: TierModel[] = [];
  for (const tier of TIERS) {
    const raw = native?.[tier];
    if (raw === undefined) continue;
    const entry = ModelEntrySchema.safeParse(raw);
    if (!entry.success) return { tiers: [], issue: `models.native.${tier}: ${entry.error.issues[0]?.message}` };
    const value = entry.data;
    tiers.push(
      typeof value === "string"
        ? { tier, model: value }
        : { tier, model: value.model, ...(value.contextWindow !== undefined ? { contextWindow: value.contextWindow } : {}) },
    );
  }
  return { tiers };
}

function authFrom(auth: z.infer<typeof AuthSchema> | undefined): CredentialAuthConfig {
  if (auth === undefined) return DEFAULT_AUTH;
  return {
    source: auth.source,
    onChange: auth.onChange,
    ...(auth.exec !== undefined ? { exec: { command: auth.exec.command, timeoutMs: auth.exec.timeoutMs } } : {}),
  };
}

function fallback(path: string, reason: string): LoadedNaxConfig {
  return { config: EMPTY_NAX_CONFIG, warning: `ignoring ${path}: ${reason}; using built-in defaults` };
}

export async function loadNaxConfig(configDir: string, readFile: ReadTextFile): Promise<LoadedNaxConfig> {
  const path = join(configDir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { config: EMPTY_NAX_CONFIG };
    return fallback(path, message(error));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return fallback(path, `invalid JSON (${message(error)})`);
  }
  const parsed = SubsetSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fallback(path, `${issue?.path.join(".")}: ${issue?.message}`);
  }
  const { tiers, issue } = tiersFrom(parsed.data.models?.native);
  if (issue !== undefined) return fallback(path, issue);
  return {
    config: {
      tiers,
      catalogOverrides: parsed.data.agent?.native?.catalogOverrides ?? [],
      auth: authFrom(parsed.data.auth),
      agentServer: parsed.data.agentServer ?? {},
    },
  };
}

/** Credentials read from `configDir` with the auth block re-read per call, as nax does (M-3). */
export function credentialsFor(configDir: string, readFile: ReadTextFile): CredentialsConfig {
  return {
    configDir: () => configDir,
    readAuthConfig: async () => (await loadNaxConfig(configDir, readFile)).config.auth,
  };
}
```

`exactOptionalPropertyTypes` is not enabled in this package, but the spreads keep optional keys absent rather than `undefined`, which is what the `toEqual` tests assert.

- [ ] **Step 4: Write `src/server/options.ts`**

```ts
/**
 * Option resolution for the ACP server (S5 spec §6.1): flag > env > config file >
 * built-in default. Config dir: master plan M-5.
 */
import { join } from "node:path";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { CliFlags } from "#src/server/cli";
import { BASH_APPROVALS, type BashApproval, MODES, type NaxConfigSubset, type TierModel } from "#src/server/nax-config";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServerOptions {
  readonly configDir: string;
  readonly sessionsDir: string;
  readonly defaultModel?: string;
  readonly defaultMode: AgentSessionProfile;
  readonly bashApproval: BashApproval;
  readonly tiers: readonly TierModel[];
  readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[];
}

export type OptionsResult =
  | { readonly ok: true; readonly options: ServerOptions }
  | { readonly ok: false; readonly message: string };

interface Sourced {
  readonly value: string;
  readonly source: string;
}

function firstSet(...candidates: readonly (Sourced | undefined)[]): Sourced | undefined {
  return candidates.find((c) => c !== undefined && c.value !== "");
}

function from(value: string | undefined, source: string): Sourced | undefined {
  return value === undefined ? undefined : { value, source };
}

export function resolveConfigDir(flags: CliFlags, env: Env, home: string): string {
  return (
    firstSet(
      from(flags.configDir, "--config-dir"),
      from(env.NAX_AGENT_CONFIG_DIR, "NAX_AGENT_CONFIG_DIR"),
      from(env.NAX_GLOBAL_CONFIG_DIR, "NAX_GLOBAL_CONFIG_DIR"),
    )?.value ?? join(home, ".nax")
  );
}

function pickEnum<T extends string>(
  label: string,
  allowed: readonly T[],
  chosen: Sourced | undefined,
  fallbackValue: T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string } {
  if (chosen === undefined) return { ok: true, value: fallbackValue };
  const match = allowed.find((a) => a === chosen.value);
  if (match !== undefined) return { ok: true, value: match };
  return {
    ok: false,
    message: `invalid ${label} "${chosen.value}" (from ${chosen.source}); expected one of ${allowed.join(", ")}`,
  };
}

export function resolveServerOptions(input: {
  readonly flags: CliFlags;
  readonly env: Env;
  readonly file: NaxConfigSubset;
  readonly configDir: string;
}): OptionsResult {
  const { flags, env, file, configDir } = input;
  const mode = pickEnum(
    "mode",
    MODES,
    firstSet(from(flags.mode, "--mode"), from(env.NAX_AGENT_MODE, "NAX_AGENT_MODE"), from(file.agentServer.defaultMode, "config.json agentServer.defaultMode")),
    "ask",
  );
  if (!mode.ok) return mode;
  const bash = pickEnum(
    "bash approval",
    BASH_APPROVALS,
    firstSet(
      from(flags.bashApproval, "--bash-approval"),
      from(env.NAX_AGENT_BASH_APPROVAL, "NAX_AGENT_BASH_APPROVAL"),
      from(file.agentServer.bashApproval, "config.json agentServer.bashApproval"),
    ),
    "gated",
  );
  if (!bash.ok) return bash;
  if (mode.value === "ask" && bash.value === "raw") {
    return { ok: false, message: 'bash approval "raw" cannot be used with mode "ask"; use gated or escalate' };
  }
  const sessionsDir =
    firstSet(
      from(flags.sessionsDir, "--sessions-dir"),
      from(env.NAX_AGENT_SESSIONS_DIR, "NAX_AGENT_SESSIONS_DIR"),
      from(file.agentServer.sessionsDir, "config.json"),
    )?.value ?? join(configDir, ".agent-server", "sessions");
  const defaultModel = firstSet(
    from(flags.model, "--model"),
    from(env.NAX_AGENT_MODEL, "NAX_AGENT_MODEL"),
    from(file.tiers.find((t) => t.tier === "balanced")?.model, "config.json models.native.balanced"),
  )?.value;
  return {
    ok: true,
    options: {
      configDir,
      sessionsDir,
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      defaultMode: mode.value,
      bashApproval: bash.value,
      tiers: file.tiers,
      catalogOverrides: file.catalogOverrides,
    },
  };
}
```

`MODES` is declared `as const` with exactly the `AgentSessionProfile` members. If `typecheck` reports that `"none" | "read" | "ask" | "full"` is not assignable to `AgentSessionProfile`, nax-agent's profile union has changed. Stop and report it; don't widen the type.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/nax-config.test.ts ./test/unit/server/options.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/nax-config.ts src/server/options.ts test/unit/server/nax-config.test.ts test/unit/server/options.test.ts
git commit -m "feat(acp-server): ~/.nax subset reader and option resolution (S5-0)"
```

---

### Task 3: Logger, `initialize`, stdio serving, `main`

**Files:**
- Create: `packages/nax-agent-acp/src/server/logger.ts`
- Create: `packages/nax-agent-acp/src/server/capabilities.ts`
- Create: `packages/nax-agent-acp/src/server/connection.ts`
- Create: `packages/nax-agent-acp/src/server/main.ts`
- Test: `packages/nax-agent-acp/test/unit/server/logger.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/connection.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/main.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseCli`, `USAGE`, `CliFlags`, `packageVersion`); Task 2 (`loadNaxConfig`, `credentialsFor`, `ReadTextFile`, `resolveConfigDir`, `resolveServerOptions`, `Env`).
- Produces:
  - `type LogLevel = "info" | "debug"`
  - `function stderrLogger(level: LogLevel, write: (text: string) => void): AgentLogger`
  - `function initializeResponse(version: string): InitializeResponse`
  - `interface AppDeps { readonly version: string }`
  - `function buildAgentApp(deps: AppDeps): AgentApp`
  - `function serveStdio(app: AgentApp, io: { readonly stdin: Readable; readonly stdout: Writable }): AgentConnection`
  - `interface MainDeps { readonly argv: readonly string[]; readonly env: Env; readonly homedir: string; readonly stdin: Readable; readonly stdout: Writable; readonly writeErr: (text: string) => void; readonly readFile: ReadTextFile; readonly onSignal: (handler: () => void) => void }`
  - `function main(deps: MainDeps): Promise<number>`, which returns 0 on a clean stop, 1 on connection failure, and 2 on a usage or option error.

S5-2 will extend `AppDeps` with the resolved `ServerOptions` and register the session handlers in `buildAgentApp`.

- [ ] **Step 1: Write the failing tests**

`test/unit/server/logger.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { stderrLogger } from "#src/server/logger";

function capture(level: "info" | "debug") {
  const lines: string[] = [];
  return { logger: stderrLogger(level, (text) => lines.push(text)), lines };
}

describe("stderrLogger", () => {
  test("writes one JSON line per entry with level, stage, message and data", () => {
    const { logger, lines } = capture("info");
    logger.warn("config", "ignoring file", { path: "/x" });
    expect(lines).toEqual([`${JSON.stringify({ level: "warn", stage: "config", message: "ignoring file", data: { path: "/x" } })}\n`]);
  });

  test("info drops debug; debug keeps everything", () => {
    const info = capture("info");
    info.logger.debug("s", "hidden");
    info.logger.error("s", "shown");
    expect(info.lines).toHaveLength(1);
    const debug = capture("debug");
    debug.logger.debug("s", "shown");
    debug.logger.info("s", "shown");
    expect(debug.lines).toHaveLength(2);
  });

  test("unserialisable data never throws; the message still lands", () => {
    const { logger, lines } = capture("info");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("s", "with cycle", circular)).not.toThrow();
    expect(JSON.parse(lines[0] ?? "")).toEqual({ level: "info", stage: "s", message: "with cycle", data: "[unserialisable]" });
  });
});
```

`test/unit/server/connection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { client, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { initializeResponse } from "#src/server/capabilities";
import { buildAgentApp, serveStdio } from "#src/server/connection";

describe("initialize (S5-0 capabilities)", () => {
  test("advertises only what S5-0 implements", () => {
    expect(initializeResponse("1.2.3")).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
      agentInfo: { name: "nax-agent", title: "nax-agent", version: "1.2.3" },
    });
  });

  test("an in-process client gets the response; a session method is not found yet", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp({ version: "9.9.9" }), async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const failure = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] }).catch((e: unknown) => e);
      return { init, failure };
    });
    expect(result.init.agentInfo?.version).toBe("9.9.9");
    expect(result.failure).toBeInstanceOf(RequestError);
    expect(result.failure instanceof RequestError ? result.failure.code : 0).toBe(-32601);
  });
});

describe("serveStdio", () => {
  test("answers an initialize frame on stdout and closes when stdin ends", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = serveStdio(buildAgentApp({ version: "9.9.9" }), { stdin, stdout });
    const line = new Promise<string>((resolve) => stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    const frame = JSON.parse((await line).trim());
    expect(frame).toMatchObject({ jsonrpc: "2.0", id: 1, result: { agentInfo: { name: "nax-agent" } } });
    stdin.end();
    connection.close();
    await connection.closed;
  });
});
```

`test/unit/server/main.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { type MainDeps, main } from "#src/server/main";
import { packageVersion } from "#src/server/version";

interface Harness {
  readonly deps: MainDeps;
  readonly stdin: PassThrough;
  readonly out: () => string;
  readonly err: () => string;
  readonly signal: () => void;
}

function harness(argv: readonly string[], overrides: Partial<MainDeps> = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const outChunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
  const errText: string[] = [];
  let signalHandler: () => void = () => {};
  const deps: MainDeps = {
    argv,
    env: {},
    homedir: "/home/u",
    stdin,
    stdout,
    writeErr: (text) => errText.push(text),
    readFile: async (path) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    onSignal: (handler) => {
      signalHandler = handler;
    },
    ...overrides,
  };
  return {
    deps,
    stdin,
    out: () => Buffer.concat(outChunks).toString("utf8"),
    err: () => errText.join(""),
    signal: () => signalHandler(),
  };
}

afterEach(() => setAgentLogger(null));

describe("main", () => {
  test("--version prints the package version on stdout and exits 0", async () => {
    const h = harness(["--version"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe(`${packageVersion()}\n`);
  });

  test("--help prints usage and exits 0", async () => {
    const h = harness(["--help"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("Usage: nax-agent");
  });

  test("a usage error goes to stderr with usage and exits 2; stdout stays empty", async () => {
    const h = harness(["serve"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("unknown command: serve");
    expect(h.err()).toContain("Usage: nax-agent");
    expect(h.out()).toBe("");
  });

  test("an invalid option exits 2 before serving", async () => {
    const h = harness(["--mode", "ask", "--bash-approval", "raw"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain('cannot be used with mode "ask"');
    expect(h.out()).toBe("");
  });

  test("serves initialize and exits 0 when stdin ends; logs only to stderr", async () => {
    const h = harness([]);
    const exit = main(h.deps);
    h.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.stdin.end();
    expect(await exit).toBe(0);
    const frames = h.out().trim().split("\n").map((line) => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 1, result: { agentInfo: { name: "nax-agent" } } });
    expect(h.err()).toContain("nax-agent ACP server started");
  });

  test("a signal stops the server with exit 0", async () => {
    const h = harness([]);
    const exit = main(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.signal();
    expect(await exit).toBe(0);
  });

  test("a config warning is logged to stderr and the server still starts", async () => {
    const h = harness([], { readFile: async () => "{ nope" });
    const exit = main(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.stdin.end();
    expect(await exit).toBe(0);
    expect(h.err()).toContain("invalid JSON");
  });

  test("NAX_AGENT_LOG=debug enables debug lines", async () => {
    const h = harness([], { env: { NAX_AGENT_LOG: "debug" } });
    const exit = main(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.stdin.end();
    expect(await exit).toBe(0);
    expect(h.err()).toContain('"level":"debug"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/server/logger.test.ts ./test/unit/server/connection.test.ts ./test/unit/server/main.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Write `src/server/logger.ts`**

```ts
/**
 * The server's logger (S5 spec §6.4): JSON lines on stderr, never stdout, which
 * carries ACP frames only. A log call never throws.
 */
import type { AgentLogger } from "@nathapp/nax-agent";

export type LogLevel = "info" | "debug";

type Severity = keyof AgentLogger;

const RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

function line(level: Severity, stage: string, message: string, data: Record<string, unknown> | undefined): string {
  const base = { level, stage, message };
  if (data === undefined) return `${JSON.stringify(base)}\n`;
  try {
    return `${JSON.stringify({ ...base, data })}\n`;
  } catch {
    return `${JSON.stringify({ ...base, data: "[unserialisable]" })}\n`;
  }
}

export function stderrLogger(level: LogLevel, write: (text: string) => void): AgentLogger {
  const at =
    (severity: Severity) =>
    (stage: string, message: string, data?: Record<string, unknown>): void => {
      if (RANK[severity] > RANK[level]) return;
      try {
        write(line(severity, stage, message, data));
      } catch {
        // A broken stderr must not take the server down.
      }
    };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
}
```

- [ ] **Step 4: Write `src/server/capabilities.ts` and `src/server/connection.ts`**

`src/server/capabilities.ts`:

```ts
/**
 * The `initialize` response (S5 spec §5.2). Each slice advertises a capability in
 * the same change that implements it (master plan Review Focus); S5-0 serves no
 * session methods yet.
 */
import { type InitializeResponse, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

export function initializeResponse(version: string): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
    },
    authMethods: [],
    agentInfo: { name: "nax-agent", title: "nax-agent", version },
  };
}
```

`src/server/connection.ts`:

```ts
/**
 * The ACP agent app and its stdio transport (S5 spec §3.1). Uses the SDK's
 * `agent()` builder, not the deprecated AgentSideConnection.
 */
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentConnection, agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { initializeResponse } from "#src/server/capabilities";

export interface AppDeps {
  readonly version: string;
}

export function buildAgentApp(deps: AppDeps): AgentApp {
  return agent({ name: "nax-agent" }).onRequest("initialize", () => initializeResponse(deps.version));
}

export function serveStdio(
  app: AgentApp,
  io: { readonly stdin: Readable; readonly stdout: Writable },
): AgentConnection {
  return app.connect(ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin)));
}
```

- [ ] **Step 5: Write `src/server/main.ts`**

```ts
/**
 * The `nax-agent` entry point as a function of its environment (S5 spec §6.1), so
 * the unit suite covers it without spawning a process. Exit codes: 0 clean stop,
 * 1 connection failure, 2 usage or option error.
 */
import type { Readable, Writable } from "node:stream";
import { configureCredentials, setAgentLogger } from "@nathapp/nax-agent";
import { type CliFlags, parseCli, USAGE } from "#src/server/cli";
import { buildAgentApp, serveStdio } from "#src/server/connection";
import { stderrLogger } from "#src/server/logger";
import { credentialsFor, loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";
import { type Env, resolveConfigDir, resolveServerOptions } from "#src/server/options";
import { packageVersion } from "#src/server/version";

export interface MainDeps {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly homedir: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly writeErr: (text: string) => void;
  readonly readFile: ReadTextFile;
  readonly onSignal: (handler: () => void) => void;
}

export async function main(deps: MainDeps): Promise<number> {
  const command = parseCli(deps.argv);
  switch (command.kind) {
    case "help":
      deps.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      deps.stdout.write(`${packageVersion()}\n`);
      return 0;
    case "usage-error":
      deps.writeErr(`nax-agent: ${command.message}\n\n${USAGE}\n`);
      return 2;
    case "acp":
      return serveAcp(command.flags, deps);
  }
}

async function serveAcp(flags: CliFlags, deps: MainDeps): Promise<number> {
  const logger = stderrLogger(deps.env.NAX_AGENT_LOG === "debug" ? "debug" : "info", deps.writeErr);
  setAgentLogger(logger);
  const configDir = resolveConfigDir(flags, deps.env, deps.homedir);
  const loaded = await loadNaxConfig(configDir, deps.readFile);
  if (loaded.warning !== undefined) logger.warn("config", loaded.warning);
  const resolved = resolveServerOptions({ flags, env: deps.env, file: loaded.config, configDir });
  if (!resolved.ok) {
    deps.writeErr(`nax-agent: ${resolved.message}\n`);
    return 2;
  }
  configureCredentials(credentialsFor(configDir, deps.readFile));
  const connection = serveStdio(buildAgentApp({ version: packageVersion() }), deps);
  const stop = (): void => connection.close();
  deps.onSignal(stop);
  deps.stdin.once("end", stop);
  logger.info("server", "nax-agent ACP server started", { configDir, sessionsDir: resolved.options.sessionsDir });
  logger.debug("server", "resolved options", { ...resolved.options });
  try {
    await connection.closed;
    return 0;
  } catch (error) {
    logger.error("server", "connection failed", { error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}
```

If `connection.closed` does not settle after `close()` (the main tests time out), read the SDK's `AcpConnection.closed` contract in `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` and the S4 client's `src/client/connection.ts`, which already awaits it. Mirror what the client does.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/logger.test.ts ./test/unit/server/connection.test.ts ./test/unit/server/main.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run lint:biome
git add src/server/logger.ts src/server/capabilities.ts src/server/connection.ts src/server/main.ts test/unit/server/logger.test.ts test/unit/server/connection.test.ts test/unit/server/main.test.ts
git commit -m "feat(acp-server): stderr logger, initialize and stdio serving (S5-0)"
```

---

### Task 4: Process entry, public `./server` exports, stdout purity

**Files:**
- Create: `packages/nax-agent-acp/src/server/process-entry.ts`
- Modify: `packages/nax-agent-acp/src/server/index.ts` (replace the empty scaffold)
- Modify: `packages/nax-agent-acp/api/nax-agent-acp.api.txt` (via `bun run api:update`)
- Create: `packages/nax-agent-acp/test/fixtures/server/run.ts`
- Test: `packages/nax-agent-acp/test/unit/server/process-entry.test.ts`
- Test: `packages/nax-agent-acp/test/unit/server/stdout-purity.test.ts`

**Interfaces:**
- Consumes: `main`, `MainDeps` (Task 3).
- Produces:
  - `interface ProcessLike { readonly argv: readonly string[]; readonly env: Env; readonly stdin: Readable; readonly stdout: Writable; readonly stderr: Writable; once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown }`
  - `function mainDepsFrom(proc: ProcessLike): MainDeps`
  - `function runCli(proc: ProcessLike): Promise<number>`
  - `./server` public names: `main`, `type MainDeps`, `runCli`, `type ProcessLike`.

- [ ] **Step 1: Write the failing tests and the fixture**

`test/fixtures/server/run.ts`:

```ts
/** Runs the server exactly as the published bin does, under bun, for the stdout-purity test. */
import { runCli } from "#src/server/process-entry";

process.exitCode = await runCli(process);
```

`test/unit/server/process-entry.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { mainDepsFrom, type ProcessLike, runCli } from "#src/server/process-entry";
import { packageVersion } from "#src/server/version";

function fakeProcess(argv: readonly string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners: Array<{ event: string; listener: () => void }> = [];
  const proc: ProcessLike = {
    argv: ["node", "nax-agent", ...argv],
    env: { NAX_AGENT_CONFIG_DIR: "/nonexistent-nax-agent-config" },
    stdin: new PassThrough(),
    stdout,
    stderr,
    once: (event, listener) => {
      listeners.push({ event, listener });
      return proc;
    },
  };
  const read = (stream: PassThrough) => () => String(stream.read() ?? "");
  return { proc, listeners, out: read(stdout), err: read(stderr) };
}

afterEach(() => setAgentLogger(null));

describe("mainDepsFrom", () => {
  test("drops node and script from argv and wires both signals to one handler", () => {
    const { proc, listeners } = fakeProcess(["--version"]);
    const deps = mainDepsFrom(proc);
    expect(deps.argv).toEqual(["--version"]);
    const handler = () => {};
    deps.onSignal(handler);
    expect(listeners.map((l) => l.event)).toEqual(["SIGINT", "SIGTERM"]);
    expect(listeners.every((l) => l.listener === handler)).toBe(true);
  });

  test("writeErr goes to stderr; readFile reads real files", async () => {
    const { proc, err } = fakeProcess([]);
    const deps = mainDepsFrom(proc);
    deps.writeErr("oops\n");
    expect(err()).toBe("oops\n");
    expect(await deps.readFile(new URL("../../../package.json", import.meta.url).pathname, "utf8")).toContain(
      "@nathapp/nax-agent-acp",
    );
  });
});

describe("runCli", () => {
  test("runs main against the process", async () => {
    const { proc, out } = fakeProcess(["--version"]);
    expect(await runCli(proc)).toBe(0);
    expect(out()).toBe(`${packageVersion()}\n`);
  });
});
```

`test/unit/server/stdout-purity.test.ts`:

```ts
/**
 * S5 spec §8: stdout of the real server process carries JSON-RPC frames only.
 * Spawns the bin's code path under bun with an empty config dir.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const ENTRY = fileURLToPath(new URL("../../fixtures/server/run.ts", import.meta.url));
const PKG = fileURLToPath(new URL("../../..", import.meta.url));

function frame(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

describe("the server process", () => {
  test("writes only JSON-RPC frames to stdout and exits 0 when stdin closes", async () => {
    const configDir = makeTempDir("acp-server-purity-");
    try {
      const child = spawn("bun", [ENTRY], {
        cwd: PKG,
        env: { ...process.env, NAX_AGENT_CONFIG_DIR: configDir, NAX_AGENT_LOG: "debug" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.resume();
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin.write(frame(1, "initialize", { protocolVersion: 1 }));
      child.stdin.write(frame(2, "session/new", { cwd: configDir, mcpServers: [] }));
      child.stdin.write(frame(3, "no/such_method", {}));
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.stdin.end();
      expect(await exited).toBe(0);
      const lines = Buffer.concat(out).toString("utf8").split("\n").filter((l) => l !== "");
      const frames = lines.map((l) => JSON.parse(l));
      expect(frames.every((f) => f.jsonrpc === "2.0")).toBe(true);
      expect(frames.find((f) => f.id === 1)?.result?.agentInfo?.name).toBe("nax-agent");
      expect(frames.find((f) => f.id === 2)?.error?.code).toBe(-32601);
      expect(frames.find((f) => f.id === 3)?.error?.code).toBe(-32601);
    } finally {
      cleanupTempDir(configDir);
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/server/process-entry.test.ts ./test/unit/server/stdout-purity.test.ts`
Expected: FAIL. `#src/server/process-entry` is not found, and the spawned child exits non-zero for the same reason.

- [ ] **Step 3: Write `src/server/process-entry.ts` and the public entry**

`src/server/process-entry.ts`:

```ts
/**
 * Adapts a real process to `MainDeps` (master plan M-2): the published bin is a
 * three-line file that calls `runCli(process)`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { type MainDeps, main } from "#src/server/main";
import type { Env } from "#src/server/options";

export interface ProcessLike {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function mainDepsFrom(proc: ProcessLike): MainDeps {
  return {
    argv: proc.argv.slice(2),
    env: proc.env,
    homedir: homedir(),
    stdin: proc.stdin,
    stdout: proc.stdout,
    writeErr: (text) => {
      proc.stderr.write(text);
    },
    readFile: (path, encoding) => readFile(path, encoding),
    onSignal: (handler) => {
      proc.once("SIGINT", handler);
      proc.once("SIGTERM", handler);
    },
  };
}

export function runCli(proc: ProcessLike): Promise<number> {
  return main(mainDepsFrom(proc));
}
```

`src/server/index.ts` replaces the whole file:

```ts
/**
 * `@nathapp/nax-agent-acp/server`: the nax-agent ACP server (S5). `runCli(process)`
 * is what the `nax-agent` bin runs; `main(deps)` runs it on any streams.
 */
export { type MainDeps, main } from "#src/server/main";
export { type ProcessLike, runCli } from "#src/server/process-entry";
```

If `typecheck` rejects `runCli(process)` in `test/fixtures/server/run.ts` because of the `once` overloads, change `ProcessLike.once`'s listener parameter type to `(signal: NodeJS.Signals) => void`. Update the fake process in `process-entry.test.ts` to match, and change nothing else.

- [ ] **Step 4: Update the API snapshot**

Run: `bun run api:update`
Expected: the `[./server]` section of `api/nax-agent-acp.api.txt` lists exactly:

```
[./server]
type MainDeps
type ProcessLike
main
runCli
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/server/ && bun run check:api`
Expected: all server tests PASS, and `check:api` reports the snapshot is current.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint:fix && bun run check:all
git add src/server/process-entry.ts src/server/index.ts api/nax-agent-acp.api.txt test/fixtures/server/run.ts test/unit/server/process-entry.test.ts test/unit/server/stdout-purity.test.ts
git commit -m "feat(acp-server): runCli process entry and public ./server exports (S5-0)"
```

---

### Task 5: Published bin, staging, Node pack smoke

**Files:**
- Create: `packages/nax-agent-acp/bin/nax-agent.js`
- Modify: `packages/nax-agent-acp/scripts/lib/stage-manifest.ts` (`STAGE_INPUTS`, `buildStagedManifest`)
- Modify: `packages/nax-agent-acp/scripts/stage-publish.ts` (copy `bin/`)
- Modify: `packages/nax-agent-acp/test/unit/packaging/stage-manifest.test.ts`
- Create: `packages/nax-agent-acp/test/node/fixtures/server-smoke.mjs`
- Modify: `packages/nax-agent-acp/test/node/pack-smoke.test.ts` (`stageAcp` copies `bin/`; new test)
- Modify: `packages/nax-agent-acp/CHANGELOG.md` (Unreleased entry)

**Interfaces:**
- Consumes: `runCli` from `dist/server/index.js` (built by `bun run build`).
- Produces:
  - the staged manifest gains `bin: { "nax-agent": "./bin/nax-agent.js" }`;
  - `STAGE_INPUTS` gains `"bin/nax-agent.js"`.

- [ ] **Step 1: Write the failing manifest test**

In `test/unit/packaging/stage-manifest.test.ts`, inside `describe("buildStagedManifest", ...)`, add:

```ts
  test("ships the nax-agent bin", () => {
    expect(staged.bin).toEqual({ "nax-agent": "./bin/nax-agent.js" });
  });
```

In `describe("staging inputs and repository", ...)`, add:

```ts
  test("the bin is a staging input", () => {
    expect(STAGE_INPUTS).toContain("bin/nax-agent.js");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/unit/packaging/stage-manifest.test.ts`
Expected: FAIL. `staged.bin` is `undefined`, and `STAGE_INPUTS` lacks the bin.

- [ ] **Step 3: Implement the staging changes and the bin**

In `scripts/lib/stage-manifest.ts`:
- Add `"bin/nax-agent.js",` to `STAGE_INPUTS`, after `"dist/server/index.d.ts",`.
- In `buildStagedManifest`'s returned object, add `bin: { "nax-agent": "./bin/nax-agent.js" },` directly after the `exports` line.

In `scripts/stage-publish.ts`, after the line that copies `dist`, add:

```ts
  cpSync(join(PKG, "bin"), join(OUT, "bin"), { recursive: true });
```

Create `bin/nax-agent.js`:

```js
#!/usr/bin/env node
import { runCli } from "../dist/server/index.js";

process.exitCode = await runCli(process);
```

Then make it executable: `chmod +x bin/nax-agent.js`.

- [ ] **Step 4: Run the manifest test to verify it passes**

Run: `bun test ./test/unit/packaging/stage-manifest.test.ts`
Expected: PASS. The existing test `lists both entries' JS and declarations plus the docs` still passes, because it compares against `STAGE_INPUTS` itself.

- [ ] **Step 5: Add the Node-lane server smoke**

`test/node/fixtures/server-smoke.mjs`:

```js
/**
 * S5 spec §8 Node lane: the packed package's `nax-agent` bin starts under Node,
 * prints its version, answers initialize and exits 0 when stdin closes.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(process.cwd(), "node_modules/.bin/nax-agent");
const configDir = mkdtempSync(join(tmpdir(), "acp-server-smoke-"));
const env = { ...process.env, NAX_AGENT_CONFIG_DIR: configDir };

try {
  const version = spawnSync(BIN, ["--version"], { env, encoding: "utf8" });
  if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout)) {
    throw new Error(`--version failed: ${version.status} ${version.stdout} ${version.stderr}`);
  }
  const child = spawn(BIN, [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const firstLine = new Promise((resolve) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end !== -1) resolve(buffered.slice(0, end));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
  const response = JSON.parse(await firstLine);
  if (response.result?.agentInfo?.name !== "nax-agent") throw new Error(`bad initialize: ${JSON.stringify(response)}`);
  child.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`server exited ${code}`);
  console.log("server smoke ok");
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
```

In `test/node/pack-smoke.test.ts`:
- In `stageAcp`, after the `cpSync(join(PKG, "dist"), ...)` line, add `cpSync(join(PKG, "bin"), join(out, "bin"), { recursive: true });`.
- Inside `describe("the packed tarballs", ...)`, add:

```ts
  test("the nax-agent bin starts under Node and answers initialize", () => {
    cpSync(join(PKG, "test/node/fixtures/server-smoke.mjs"), join(consumer, "server-smoke.mjs"));
    expect(run("node", ["server-smoke.mjs"], consumer, 60_000)).toContain("server smoke ok");
  }, 120_000);
```

- [ ] **Step 6: Run the Node lane**

Run: `bun run test:node`
Expected: PASS, including `the nax-agent bin starts under Node and answers initialize`.

If the bin fails under Node with `ERR_PACKAGE_IMPORT_NOT_DEFINED` for `#src/...`, the staged manifest's `imports` map is not reaching `dist`. Compare it with the client entry, which already works the same way through `buildStagedManifest`'s `imports`. Fix the staging, not the bin.

- [ ] **Step 7: Changelog, full gates, commit**

Add to `CHANGELOG.md` under an `## Unreleased` heading (create it at the top if absent):

```md
- `nax-agent` binary (S5-0): an ACP server on stdio. This slice answers `initialize` only; session methods arrive in later S5 slices.
```

Run:

```bash
bun run typecheck && bun run lint:fix && bun run check:all && bun test ./test/unit/ --timeout=60000 && bun run test:coverage
```

Expected: all green. Coverage lists every `src/server/*.ts` file at or above 80%. If `test:coverage` reports a new file below the floor, add the missing branch test to that file's test module. Never update the baseline to pass.

```bash
git add bin/nax-agent.js scripts/lib/stage-manifest.ts scripts/stage-publish.ts test/unit/packaging/stage-manifest.test.ts test/node/fixtures/server-smoke.mjs test/node/pack-smoke.test.ts CHANGELOG.md
git commit -m "feat(acp-server): publish the nax-agent bin and smoke it under Node (S5-0)"
```

---

## Done when

- `bun run typecheck`, `bun run check:all`, `bun test ./test/unit/ --timeout=60000`, `bun run test:coverage` and `bun run test:node` are green from `packages/nax-agent-acp`.
- `api/nax-agent-acp.api.txt` lists the four `./server` names.
- `bun run build && node bin/nax-agent.js --version` prints the package version.
- PR title: `feat(acp-server): S5-0 nax-agent binary wiring`. No release.
