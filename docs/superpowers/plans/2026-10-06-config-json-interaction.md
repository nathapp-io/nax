# `nax config --json` Interaction Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nax config --json` reports whether the resolved config's interaction plugin can start in the current environment, as a new `interaction` field, so an orchestrator (koda #207) can keep runs off a machine where every run would die at interaction-plugin init.

**Architecture:** A new `checkInteraction(config, { headless })` in `src/interaction/check.ts` builds the configured plugin with the same factory `initInteractionChain` uses, calls its `init()` (offline for every built-in plugin) and always `destroy()`, and turns a throw into `{ status: "failed", code, message }`. `configJsonCommand` calls it on the config it already resolved and adds the result to its document. Exit code and every existing field are unchanged.

**Tech Stack:** Bun 1.4, TypeScript, `bun:test`, Zod; package `packages/nax`.

**Spec:** koda repo `docs/superpowers/specs/2026-10-06-runner-interaction-probe-design.md` §1 ("nax contract") — absolute path `/Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/docs/superpowers/specs/2026-10-06-runner-interaction-probe-design.md`. The consumer is koda's runner (its own plan: koda `docs/superpowers/plans/2026-10-06-runner-interaction-probe.md`, Task 6 `parseInteraction`). Precedent for this kind of change: `docs/specs/SPEC-cli-json-output.md` (#2296) and `docs/specs/SPEC-sandbox-probe-json.md` (#2297).

## Global Constraints

- Branch `feat/config-json-interaction` (already created from `main` `b230464eb`, holds this plan). Never switch branches; never push, open a PR or release without the user's explicit approval. nax releases are PATCH and maintainer-initiated.
- Field shape, exactly: `interaction: { plugin: string | null; status: "ok" | "failed" | "skipped"; code?: string; message?: string }` — `code` and `message` only when `status === "failed"`.
- `skipped`: the config has no `interaction` section, or the plugin is `cli` and the process is headless (stdin not a TTY).
- The `cli` plugin is NEVER initialised by the check: its `init()` opens a readline on this process's stdin. On a TTY it reports `ok` (it needs nothing to start). The schema default plugin is `cli` (`src/config/schemas.ts:329`), so most configs land here.
- Failure `code`: the thrown `NaxError`'s `code`; any other throw (including a Zod parse error) is `INTERACTION_INIT_FAILED`.
- Failure `message`: `errorMessage(err)` passed through `redactSecrets`, cut to 300 characters; omitted when empty.
- No network call, no model call, no log line: the check runs inside a read-only command. `destroy()` is always awaited when a plugin was built; a rejection from it is ignored.
- `nax config --json` keeps exit code 0 on a failing plugin, prints exactly one document, and changes no other field.
- Repo rules (`packages/nax/CLAUDE.md`, `.nax/rules/`): `_deps` injection for external calls, functions ≤30 lines, no magic numbers (UPPER_SNAKE constants), `NaxError` base class, barrel imports, 400-line file limit. Never run bare `bun test` (no path) and never `bun run nax`; exercise the CLI with `bun run dev`.
- Commands run from `packages/nax` unless stated.

## Review Focus

1. **The developer's own shell has `NAX_TELEGRAM_TOKEN` set** (the koda #207 machine did): a "missing token" test passes on CI and fails locally, or the reverse. Every test that touches telegram must clear and restore `NAX_TELEGRAM_TOKEN`, `TELEGRAM_BOT_TOKEN`, `NAX_TELEGRAM_CHAT_ID`. Pinned in Task 1 (`beforeEach`/`afterEach`) and Task 2.
2. **A human runs `nax config --json` in a terminal with the default `cli` plugin**: the command must not grab the terminal or hang waiting on readline. Pinned in Task 1 (`createPlugin` is never called for `cli`) and Task 2 (TTY stub reports `ok`).
3. **A plugin whose error text carries a secret** (a bot token echoed in a message, a `TOKEN=...` assignment): it must not reach stdout. Pinned in Task 1 (redaction test).
4. **`destroy()` rejects or the factory itself throws**: the check still returns one report, never throws out of `configJsonCommand` (which would turn into the error document and exit 1). Pinned in Task 1.
5. **A profile chain changes the plugin** (base `cli`, profile sets `telegram`): the field must reflect the chain, the same config the rest of the document describes. Pinned in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/nax/src/interaction/init.ts` | export the existing `createInteractionPlugin` factory (no behaviour change) | 1 |
| `packages/nax/src/interaction/check.ts` (new) | `checkInteraction`, report type, `_interactionCheckDeps` | 1 |
| `packages/nax/src/interaction/index.ts` | barrel export of the check | 1 |
| `packages/nax/test/unit/interaction/check.test.ts` (new) | unit tests | 1 |
| `packages/nax/src/cli/config-json.ts` | add `interaction` to `ConfigJsonReport` | 2 |
| `packages/nax/test/unit/cli/config-json.test.ts` | command-level tests | 2 |
| `docs/specs/SPEC-cli-json-output.md` | document the field next to `ConfigJsonReport` | 3 |

---

### Task 1: `checkInteraction`

**Files:**
- Modify: `packages/nax/src/interaction/init.ts:20` (`function createInteractionPlugin` -> `export function createInteractionPlugin`)
- Create: `packages/nax/src/interaction/check.ts`
- Modify: `packages/nax/src/interaction/index.ts` (after the `// Initialization` export)
- Test: `packages/nax/test/unit/interaction/check.test.ts`

**Interfaces:**
- Produces (from `@/interaction`):
  - `type InteractionCheckStatus = "ok" | "failed" | "skipped"`
  - `interface InteractionCheckReport { plugin: string | null; status: InteractionCheckStatus; code?: string; message?: string }`
  - `const INTERACTION_INIT_FAILED = "INTERACTION_INIT_FAILED"`
  - `const _interactionCheckDeps: { createPlugin: (name: string) => InteractionPlugin }`
  - `function checkInteraction(config: InteractionConfig, options: { headless: boolean }): Promise<InteractionCheckReport>`

- [ ] **Step 1: Baseline**

Run (repo root): `git status -sb` — expect `## feat/config-json-interaction` and a clean tree.
Run: `cd packages/nax && bun test ./test/unit/interaction/init-headless.test.ts` — expect PASS.

- [ ] **Step 2: Write the failing tests**

Create `packages/nax/test/unit/interaction/check.test.ts`:

```ts
/**
 * checkInteraction — the offline interaction-plugin check behind `nax config --json` `interaction` (koda #207).
 *
 * Harness: the telegram env vars are cleared before every test and restored after, so a developer's own
 * NAX_TELEGRAM_TOKEN cannot flip a result (Review focus 1). The telegram plugin's fetch is replaced with one that
 * counts calls and throws, so any network use fails the test that caused it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _interactionCheckDeps, _telegramPluginDeps, checkInteraction, INTERACTION_INIT_FAILED } from "@/interaction";
import type { InteractionPlugin } from "@/interaction/types";

const TELEGRAM_ENV = ["NAX_TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN", "NAX_TELEGRAM_CHAT_ID"] as const;
const savedEnv = new Map<string, string | undefined>();
const realCreatePlugin = _interactionCheckDeps.createPlugin;
const realFetch = _telegramPluginDeps.fetch;
let fetchCalls = 0;

function configFor(plugin: string, pluginConfig: Record<string, unknown> = {}): NaxConfig {
  return makeNaxConfig({ interaction: { plugin, config: pluginConfig, defaults: { timeout: 30000 }, triggers: {} } });
}

/** A plugin whose init and destroy are scripted; counts destroy calls. */
function stubPlugin(init: () => Promise<void>, destroy: () => Promise<void> = async () => undefined) {
  const calls = { destroy: 0 };
  const plugin: InteractionPlugin = {
    name: "stub",
    send: async () => undefined,
    receive: async () => {
      throw new Error("not used");
    },
    init,
    destroy: async () => {
      calls.destroy += 1;
      await destroy();
    },
  };
  return { plugin, calls };
}

beforeEach(() => {
  for (const name of TELEGRAM_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  fetchCalls = 0;
  _telegramPluginDeps.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("the interaction check must not use the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const name of TELEGRAM_ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _interactionCheckDeps.createPlugin = realCreatePlugin;
  _telegramPluginDeps.fetch = realFetch;
});

describe("checkInteraction — skipped and cli", () => {
  test("no interaction section is skipped with a null plugin", async () => {
    expect(await checkInteraction({} as NaxConfig, { headless: true })).toEqual({ plugin: null, status: "skipped" });
  });

  test("Review focus 2: cli is never built — skipped when headless, ok on a terminal", async () => {
    _interactionCheckDeps.createPlugin = () => {
      throw new Error("cli must not be built");
    };
    expect(await checkInteraction(configFor("cli"), { headless: true })).toEqual({ plugin: "cli", status: "skipped" });
    expect(await checkInteraction(configFor("cli"), { headless: false })).toEqual({ plugin: "cli", status: "ok" });
  });

  test("the schema default (cli) is what a config without an interaction override reports", async () => {
    expect(await checkInteraction(makeNaxConfig(), { headless: true })).toEqual({ plugin: "cli", status: "skipped" });
  });
});

describe("checkInteraction — built-in plugins, offline", () => {
  test("telegram with token and chat id in config is ok, and makes no network call", async () => {
    const report = await checkInteraction(configFor("telegram", { botToken: "123456:abc", chatId: "123456789" }), { headless: true });
    expect(report).toEqual({ plugin: "telegram", status: "ok" });
    expect(fetchCalls).toBe(0);
  });

  test("telegram with token and chat id from the environment is ok", async () => {
    process.env.NAX_TELEGRAM_TOKEN = "123456:abc";
    process.env.NAX_TELEGRAM_CHAT_ID = "123456789";
    expect(await checkInteraction(configFor("telegram"), { headless: true })).toEqual({ plugin: "telegram", status: "ok" });
  });

  test("Review focus 1: telegram without a token (the koda #207 case) fails with TELEGRAM_NOT_CONFIGURED", async () => {
    const report = await checkInteraction(configFor("telegram"), { headless: true });
    expect(report).toMatchObject({ plugin: "telegram", status: "failed", code: "TELEGRAM_NOT_CONFIGURED" });
    expect(report.message).toContain("Telegram plugin requires botToken and chatId");
    expect(fetchCalls).toBe(0);
  });

  test.each([
    ["webhook without a url", "webhook", {}, "WEBHOOK_URL_MISSING"],
    ["webhook without a secret", "webhook", { url: "https://hooks.example.test/nax" }, "WEBHOOK_SECRET_MISSING"],
    ["the removed auto plugin", "auto", {}, "INTERACTION_PLUGIN_REMOVED"],
    ["an unknown plugin", "carrier-pigeon", {}, "INTERACTION_PLUGIN_UNKNOWN"],
    ["a plugin config the schema rejects", "webhook", { url: "not a url" }, INTERACTION_INIT_FAILED],
  ])("%s fails with its code", async (_label, plugin, pluginConfig, code) => {
    expect(await checkInteraction(configFor(plugin, pluginConfig), { headless: true })).toMatchObject({ plugin, status: "failed", code });
  });

  test("webhook with a url and a secret is ok (init binds no port)", async () => {
    const config = configFor("webhook", { url: "https://hooks.example.test/nax", secret: "s" });
    expect(await checkInteraction(config, { headless: true })).toEqual({ plugin: "webhook", status: "ok" });
  });
});

describe("checkInteraction — failure handling", () => {
  test("destroy runs after a successful init and after a failed one", async () => {
    const ok = stubPlugin(async () => undefined);
    _interactionCheckDeps.createPlugin = () => ok.plugin;
    await checkInteraction(configFor("stub"), { headless: true });
    expect(ok.calls.destroy).toBe(1);

    const bad = stubPlugin(async () => {
      throw new NaxError("nope", "STUB_NOT_CONFIGURED");
    });
    _interactionCheckDeps.createPlugin = () => bad.plugin;
    expect(await checkInteraction(configFor("stub"), { headless: true })).toMatchObject({ status: "failed", code: "STUB_NOT_CONFIGURED" });
    expect(bad.calls.destroy).toBe(1);
  });

  test("Review focus 4: a rejecting destroy is ignored", async () => {
    const { plugin } = stubPlugin(
      async () => undefined,
      async () => {
        throw new Error("teardown failed");
      },
    );
    _interactionCheckDeps.createPlugin = () => plugin;
    expect(await checkInteraction(configFor("stub"), { headless: true })).toEqual({ plugin: "stub", status: "ok" });
  });

  test("Review focus 4: a factory that throws a plain Error is INTERACTION_INIT_FAILED", async () => {
    _interactionCheckDeps.createPlugin = () => {
      throw new Error("factory exploded");
    };
    expect(await checkInteraction(configFor("stub"), { headless: true })).toEqual({
      plugin: "stub",
      status: "failed",
      code: INTERACTION_INIT_FAILED,
      message: "factory exploded",
    });
  });

  test("Review focus 3: the message is redacted and cut to 300 characters", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const { plugin } = stubPlugin(async () => {
      throw new Error(`bad key ${secret} ${"x".repeat(400)}`);
    });
    _interactionCheckDeps.createPlugin = () => plugin;
    const report = await checkInteraction(configFor("stub"), { headless: true });
    expect(report.message).not.toContain(secret);
    expect(report.message).toContain("[REDACTED]");
    expect(report.message?.length).toBe(300);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test ./test/unit/interaction/check.test.ts`
Expected: FAIL — `checkInteraction`, `_interactionCheckDeps`, `INTERACTION_INIT_FAILED` are not exported from `@/interaction`.

- [ ] **Step 4: Export the factory**

In `packages/nax/src/interaction/init.ts`, change `function createInteractionPlugin(pluginName: string): InteractionPlugin {` to:

```ts
export function createInteractionPlugin(pluginName: string): InteractionPlugin {
```

and change its doc comment to `/** Create interaction plugin based on config. Shared with checkInteraction (check.ts). */`. No other change.

- [ ] **Step 5: Implement the check**

Create `packages/nax/src/interaction/check.ts`:

```ts
/**
 * Interaction Check
 *
 * Starts the configured interaction plugin once, offline, and reports whether it could, so an orchestrator
 * can tell before dispatch that a run would fail at interaction-plugin init (koda #207). Every built-in
 * plugin's init() only validates config and env; the cli plugin is never started (see checkInteraction).
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { InteractionConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { redactSecrets } from "../logger";
import { createInteractionPlugin } from "./init";
import type { InteractionPlugin } from "./types";

export const INTERACTION_INIT_FAILED = "INTERACTION_INIT_FAILED";
const MAX_CHECK_MESSAGE_CHARS = 300;
const CLI_PLUGIN_NAME = "cli";

export type InteractionCheckStatus = "ok" | "failed" | "skipped";

/** The `interaction` field of `nax config --json`. `code` and `message` are set only when `status` is "failed". */
export interface InteractionCheckReport {
  plugin: string | null;
  status: InteractionCheckStatus;
  code?: string;
  message?: string;
}

export const _interactionCheckDeps: { createPlugin: (pluginName: string) => InteractionPlugin } = {
  createPlugin: createInteractionPlugin,
};

/**
 * Report whether `config`'s interaction plugin can start here. Never throws: a failure is data.
 * The cli plugin's init opens a readline on this process's stdin, so it is never started: headless it is
 * "skipped" (initInteractionChain skips it too), on a terminal "ok" (it needs no config or env).
 */
export async function checkInteraction(
  config: InteractionConfig,
  options: { headless: boolean },
): Promise<InteractionCheckReport> {
  const interaction = config.interaction;
  if (!interaction) return { plugin: null, status: "skipped" };
  const name = interaction.plugin;
  if (name === CLI_PLUGIN_NAME) return { plugin: name, status: options.headless ? "skipped" : "ok" };
  let plugin: InteractionPlugin | undefined;
  try {
    plugin = _interactionCheckDeps.createPlugin(name);
    await plugin.init?.(interaction.config ?? {});
    return { plugin: name, status: "ok" };
  } catch (err) {
    return failedReport(name, err);
  } finally {
    await plugin?.destroy?.().catch(() => undefined);
  }
}

function failedReport(plugin: string, err: unknown): InteractionCheckReport {
  const code = err instanceof NaxError ? err.code : INTERACTION_INIT_FAILED;
  const message = redactSecrets(errorMessage(err)).slice(0, MAX_CHECK_MESSAGE_CHARS);
  return { plugin, status: "failed", code, ...(message ? { message } : {}) };
}
```

In `packages/nax/src/interaction/index.ts`, directly after `export { initInteractionChain } from "./init";` add:

```ts
// Offline plugin check (`nax config --json` `interaction`)
export type { InteractionCheckReport, InteractionCheckStatus } from "./check";
export { _interactionCheckDeps, checkInteraction, INTERACTION_INIT_FAILED } from "./check";
```

- [ ] **Step 6: Run to verify they pass**

Run: `bun test ./test/unit/interaction/check.test.ts ./test/unit/interaction/init-headless.test.ts ./test/unit/interaction/interaction-plugins.test.ts`
Expected: PASS.
Run: `bun run typecheck && bun run lint`
Expected: clean. If `lint:checks` flags `check:import-cycles` or `check:alias-internals` for the new file, report the exact message and fix the import it names (do not update a baseline without asking).

- [ ] **Step 7: Commit**

```bash
git add packages/nax/src/interaction/init.ts packages/nax/src/interaction/check.ts packages/nax/src/interaction/index.ts packages/nax/test/unit/interaction/check.test.ts
git commit -m "feat(interaction): offline interaction-plugin check (koda #207)"
```

---

### Task 2: `interaction` on `nax config --json`

**Files:**
- Modify: `packages/nax/src/cli/config-json.ts`
- Test: `packages/nax/test/unit/cli/config-json.test.ts`

**Interfaces:**
- Consumes: `checkInteraction`, `InteractionCheckReport` from `../interaction` (Task 1).
- Produces: `ConfigJsonReport.interaction: InteractionCheckReport`; `_configJsonDeps.checkInteraction`, `_configJsonDeps.isHeadless: () => boolean`.

- [ ] **Step 1: Write the failing tests**

In `packages/nax/test/unit/cli/config-json.test.ts`:

Add to the module-level constants (after `const realBuildConfigRequirements = ...`):

```ts
const realIsHeadless = _configJsonDeps.isHeadless;
const TELEGRAM_ENV = ["NAX_TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN", "NAX_TELEGRAM_CHAT_ID"] as const;
const savedTelegramEnv = new Map<string, string | undefined>();
const TELEGRAM_INTERACTION = { plugin: "telegram", config: {}, defaults: { timeout: 600000 }, triggers: {} };
```

At the end of the existing `beforeEach` body add:

```ts
  _configJsonDeps.isHeadless = () => true;
  for (const name of TELEGRAM_ENV) {
    savedTelegramEnv.set(name, process.env[name]);
    delete process.env[name];
  }
```

At the end of the existing `afterEach` body add:

```ts
  _configJsonDeps.isHeadless = realIsHeadless;
  for (const name of TELEGRAM_ENV) {
    const value = savedTelegramEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
```

Add a new `describe` at the end of the file:

```ts
describe("configJsonCommand — interaction (koda #207)", () => {
  test("the default cli plugin is skipped when headless", async () => {
    const exitCode = await configJsonCommand({ dir: tempProject });

    expect(exitCode).toBe(0);
    expect(document().interaction).toEqual({ plugin: "cli", status: "skipped" });
  });

  test("Review focus 2: on a terminal the cli plugin is ok and nothing reads stdin", async () => {
    _configJsonDeps.isHeadless = () => false;

    await configJsonCommand({ dir: tempProject });

    expect(document().interaction).toEqual({ plugin: "cli", status: "ok" });
  });

  test("a telegram plugin without its token fails in the field, and the command still exits 0 with one document", async () => {
    writeGlobalConfig({ interaction: TELEGRAM_INTERACTION });

    const exitCode = await configJsonCommand({ dir: tempProject });

    expect(exitCode).toBe(0);
    expect(out).toHaveLength(1);
    expect(document().error).toBeUndefined();
    expect(document().interaction).toMatchObject({ plugin: "telegram", status: "failed", code: "TELEGRAM_NOT_CONFIGURED" });
  });

  test("Review focus 5: the field follows the profile chain", async () => {
    writeGlobalProfile("tg", { interaction: TELEGRAM_INTERACTION });

    await configJsonCommand({ dir: tempProject, profile: ["tg"] });

    expect(document().profileChain).toEqual(["tg"]);
    expect(document().interaction).toMatchObject({ plugin: "telegram", status: "failed" });
  });

  test("telegram with its env present is ok", async () => {
    writeGlobalConfig({ interaction: TELEGRAM_INTERACTION });
    process.env.NAX_TELEGRAM_TOKEN = "123456:abc";
    process.env.NAX_TELEGRAM_CHAT_ID = "123456789";

    await configJsonCommand({ dir: tempProject });

    expect(document().interaction).toEqual({ plugin: "telegram", status: "ok" });
  });

  test("the error document (a failing load) carries no interaction field", async () => {
    await configJsonCommand({ dir: tempProject, explain: true });

    expect(document().error?.code).toBe("CONFIG_FLAGS_CONFLICT");
    expect(document().interaction).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test ./test/unit/cli/config-json.test.ts`
Expected: FAIL — type error on `_configJsonDeps.isHeadless`, and `document().interaction` is undefined.

- [ ] **Step 3: Implement**

In `packages/nax/src/cli/config-json.ts`:

Add to the imports (keep the existing ones):

```ts
import { checkInteraction, type InteractionCheckReport } from "../interaction";
```

Add the field to `ConfigJsonReport`, after `requirements`:

```ts
  /** Whether the resolved config's interaction plugin can start in this environment (koda #207). */
  interaction: InteractionCheckReport;
```

Replace `_configJsonDeps` with:

```ts
export const _configJsonDeps: {
  log: (text: string) => void;
  buildConfigRequirements: typeof buildConfigRequirements;
  checkInteraction: typeof checkInteraction;
  /** Same rule as the run path: stdin that is not a TTY means no cli prompts. */
  isHeadless: () => boolean;
} = {
  log: (text: string) => console.log(text),
  buildConfigRequirements,
  checkInteraction,
  isHeadless: () => !process.stdin.isTTY,
};
```

In `configJsonCommand`, after `const requirements = _configJsonDeps.buildConfigRequirements(config);` add:

```ts
    const interaction = await _configJsonDeps.checkInteraction(config, { headless: _configJsonDeps.isHeadless() });
```

and add `interaction,` to the `report` object directly after `requirements,`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test ./test/unit/cli/config-json.test.ts`
Expected: PASS (the new tests and every existing US-005 test).
Run: `bun run typecheck && bun run lint`
Expected: clean. If `check:import-cycles` reports a new cycle through the `../interaction` barrel, change the import to `../interaction/check` and re-run (that module imports only `init`, `types`, config selectors, errors and logger).

- [ ] **Step 5: CLI smoke (source, not dist)**

Run (in a scratch dir, never inside a real project): 
```bash
SCRATCH=$(mktemp -d) && mkdir -p "$SCRATCH/g" && cd "$SCRATCH" \
  && printf '{"interaction":{"plugin":"telegram","config":{},"defaults":{"timeout":600000},"triggers":{}}}' > g/config.json \
  && env -u NAX_TELEGRAM_TOKEN -u TELEGRAM_BOT_TOKEN -u NAX_TELEGRAM_CHAT_ID NAX_GLOBAL_CONFIG_DIR="$SCRATCH/g" \
     bun run --cwd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/packages/nax dev config -d "$SCRATCH" --json < /dev/null; echo "exit=$?"
```
Expected: one JSON document whose `interaction` is `{"plugin":"telegram","status":"failed","code":"TELEGRAM_NOT_CONFIGURED","message":"Telegram plugin requires botToken and chatId (env: ...)"}`, and `exit=0`. `< /dev/null` makes stdin a non-TTY, as under a service. If `bun run --cwd` is not supported by the installed Bun, `cd` into `packages/nax` and run `bun run dev config -d "$SCRATCH" --json < /dev/null` with the same env. Delete `$SCRATCH` afterwards.

- [ ] **Step 6: Commit**

```bash
git add packages/nax/src/cli/config-json.ts packages/nax/test/unit/cli/config-json.test.ts
git commit -m "feat(cli): nax config --json reports whether the interaction plugin can start (koda #207)"
```

---

### Task 3: Docs, full gates, review

**Files:**
- Modify: `docs/specs/SPEC-cli-json-output.md` (the `### Output format: \`ConfigJsonReport\`` section, line ~101)

- [ ] **Step 1: Document the field**

In `docs/specs/SPEC-cli-json-output.md`, in the `ConfigJsonReport` JSON example add after the `"requirements": { ... },` block:

```json
  "interaction": { "plugin": "telegram", "status": "failed", "code": "TELEGRAM_NOT_CONFIGURED", "message": "Telegram plugin requires botToken and chatId (env: NAX_TELEGRAM_TOKEN or TELEGRAM_BOT_TOKEN, NAX_TELEGRAM_CHAT_ID)" },
```

and add this bullet after the `sources` bullet:

```markdown
- `interaction` (added for koda #207, after this spec shipped) — `checkInteraction(config, { headless: !process.stdin.isTTY })` (`src/interaction/check.ts`): the resolved config's interaction plugin is built with the same factory as `initInteractionChain`, `init()` is called (offline for every built-in plugin) and `destroy()` always follows. `status` is `ok`, `failed` (with the thrown `NaxError` code, or `INTERACTION_INIT_FAILED`, and a redacted message of at most 300 characters) or `skipped` (no interaction section, or `cli` while headless). The `cli` plugin is never started, since its init opens a readline on stdin; on a terminal it reports `ok`. A failing plugin does not change the exit code.
```

- [ ] **Step 2: Full gates (from `packages/nax`)**

Run: `bun run typecheck`, `bun run check:all`, `bun run test`
Expected: all green. `bun run test` is the phased runner (unit, integration, ui); do not substitute bare `bun test`.

- [ ] **Step 3: Commit**

```bash
git add docs/specs/SPEC-cli-json-output.md
git commit -m "docs(specs): document the interaction field of nax config --json"
```

- [ ] **Step 4: Whole-branch review**

Dispatch one fresh reviewer (code-reviewer agent) over `git diff main...HEAD` with this plan and the koda spec §1, asking for: Review Focus 1-5, that no code path in `checkInteraction` can throw or log, that `cli` is never constructed, and that the field shape matches the Global Constraints exactly (koda's runner parses it: unknown `status` reads as unknown, a failed status without a matching `^[A-Z0-9_]{1,64}$` code is coerced to `INTERACTION_INIT_FAILED` on the koda side). Fix CRITICAL/HIGH findings, max 2 fix rounds, re-run Step 2.

- [ ] **Step 5: Hand back**

Do NOT push, open a PR or release. Report to the user: the commits on `feat/config-json-interaction`, gate results, the CLI smoke output from Task 2 Step 5, the review outcome, and the proposed PR title `feat(cli): nax config --json reports whether the interaction plugin can start` with body linking koda #207. Push/PR and the patch release happen only on the user's explicit approval.
