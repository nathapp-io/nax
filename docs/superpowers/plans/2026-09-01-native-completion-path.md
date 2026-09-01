# Native Completion Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `native` agent that answers `AgentAdapter.complete()` through `@nathapp/nax-ai`, reachable only behind an explicit `agent.protocol` opt-in, with no change to any existing config's behaviour.

**Architecture:** `agent.protocol` widens from `z.literal("acp")` to a three-value capability gate. The registry discriminates on agent name: `native` builds a `NativeAgentAdapter`, everything else an `AcpAgentAdapter`. All nax-ai contact lives in `src/agents/native/`, enforced by a new import gate. Model strings under `native` are `"<provider>/<model>"`, the encoding the config already uses for multi-provider agents.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, zod ^4.3.6, `@nathapp/nax-ai` (exact pin).

**Spec:** [`docs/superpowers/specs/2026-09-01-native-llm-adapter-phase-a-design.md`](../specs/2026-09-01-native-llm-adapter-phase-a-design.md)

## Global Constraints

- Runtime **Bun 1.4.0**, Bun-native APIs only. Tests use `bun:test` (`describe`/`test`/`expect`).
- `SRC_LIMIT = 600` lines, `TEST_LIMIT = 800`. The gate refuses growth in already-oversized files.
- **`src/agents/acp/adapter.ts` is at 593/600 — do not touch it.**
- `@nathapp/nax-ai` is importable **only** from `src/agents/native/`.
- Every new check script must be reachable from CI (`check:gate-reachability`).
- Errors are `NaxError(message, CODE, context)` with `{ cause }` where there is one.
- Imports use the `@/` alias (`@/config/schema`, not `../../config/schema`).
- Docs land in `.nax/context.md`, never `CLAUDE.md`.
- `@nathapp/nax-ai` is pinned **exactly** — no `^`, no `~`.
- Commit after every task. Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).

---

### Task 1: `agent.protocol` capability gate

**Files:**
- Modify: `src/config/schemas-infra.ts:282`
- Modify: `src/config/schemas.ts:499` (inside the existing `.superRefine`)
- Test: `test/unit/config/agent-protocol-gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentConfigSchema.protocol` accepts `"acp" | "native" | "hybrid"`, default `"acp"`. Config containing `models.native` under `protocol: "acp"` fails validation; `protocol: "native"` with `agent.default !== "native"` fails validation.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * The `agent.protocol` capability gate.
 *
 * protocol does not route — the agent name does. It decides what is permitted,
 * because native calls hit a different billing path and must be opted into.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

function config(overrides: Record<string, unknown>) {
  return { version: 1, ...overrides };
}

describe("agent.protocol gate", () => {
  test("defaults to acp so existing config is unchanged", () => {
    const parsed = NaxConfigSchema.parse(config({}));
    expect(parsed.agent.protocol).toBe("acp");
  });

  test("rejects a native model entry under protocol acp", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("protocol");
  });

  test("accepts a native model entry under protocol hybrid", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "hybrid", default: "claude" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects an acpx model entry under protocol native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects protocol native when agent.default is not native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "claude" },
        models: { native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("agent.default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config/agent-protocol-gate.test.ts --timeout=30000`
Expected: FAIL — `protocol: "hybrid"` is rejected by `z.literal("acp")`, so even the passing cases fail.

- [ ] **Step 3: Widen the enum**

In `src/config/schemas-infra.ts`, replace line 282:

```typescript
  // A capability gate, not a router: the agent name routes (ADR-027 §2).
  // Native calls bill on a different path, so reaching them is an explicit
  // opt-in rather than the consequence of a typo in `models`.
  protocol: z.enum(["acp", "native", "hybrid"]).default("acp"),
```

- [ ] **Step 4: Add the cross-section validation**

In `src/config/schemas.ts`, inside the existing `.superRefine((data, ctx) => { ... })`, after the `tierOrder` loop:

```typescript
    // Cross-section: the protocol gate decides which agents `models` may name.
    const protocol = data.agent?.protocol ?? "acp";
    const modelAgents = Object.keys(data.models ?? {});
    const NATIVE = "native";

    if (protocol === "acp" && modelAgents.includes(NATIVE)) {
      ctx.addIssue({
        code: "custom",
        path: ["models", NATIVE],
        message:
          'models.native requires agent.protocol "hybrid" or "native" (it is "acp"). Set agent.protocol, or remove the native entry.',
      });
    }

    if (protocol === "native") {
      for (const agent of modelAgents) {
        if (agent === NATIVE) continue;
        ctx.addIssue({
          code: "custom",
          path: ["models", agent],
          message: `agent.protocol "native" permits only models.native; "${agent}" is an acpx agent. Use "hybrid" to run both.`,
        });
      }
      if ((data.agent?.default ?? "claude") !== NATIVE) {
        ctx.addIssue({
          code: "custom",
          path: ["agent", "default"],
          message: 'agent.protocol "native" requires agent.default "native".',
        });
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/config/agent-protocol-gate.test.ts --timeout=30000`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the config suite for regressions**

Run: `bun test test/unit/config --timeout=60000`
Expected: PASS. Existing configs default to `"acp"` and name no `native` entry, so none of them change.

- [ ] **Step 7: Commit**

```bash
git add src/config/schemas-infra.ts src/config/schemas.ts test/unit/config/agent-protocol-gate.test.ts
git commit -m "feat(config): widen agent.protocol into a capability gate

protocol was z.literal(\"acp\"), a reserved extension point. It now accepts
acp|native|hybrid and decides what is permitted rather than what routes — the
agent name already routes (ADR-027 section 2).

It defaults to acp, so no existing config changes behaviour, and a native model
entry is a config error until someone opts in. Native calls bill on a different
path; reaching that path should not be the consequence of a typo in models."
```

---

### Task 2: nax-ai dependency and the wire-isolation gate

**Files:**
- Modify: `package.json` (dependency + `check:nax-ai-imports` script + `lint` chain)
- Create: `scripts/check-nax-ai-imports.ts`
- Create: `src/agents/native/index.ts`
- Test: `test/unit/scripts/check-nax-ai-imports.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/agents/native/` exists and is the only directory permitted to import `@nathapp/nax-ai`; `bun run check:nax-ai-imports` exits non-zero on a violation.

- [ ] **Step 1: Install the dependency at an exact pin**

```bash
bun add @nathapp/nax-ai@0.1.1
```

Then edit `package.json` so the version has no range prefix:

```json
"@nathapp/nax-ai": "0.1.1"
```

- [ ] **Step 2: Write the failing test**

```typescript
/**
 * The wire-isolation gate.
 *
 * nax-ai is replaceable only while every import of it sits behind one
 * directory. This mirrors check-adapter-no-config-import.sh, and nax-ai's own
 * check-pi-ai-imports, for the same reason.
 *
 * The gate is proven by violating it: a gate never seen to fail is not a gate.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-nax-ai-imports.ts");

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

describe("check-nax-ai-imports", () => {
  test("passes when nax-ai is imported only from src/agents/native", () => {
    const root = tree({
      "src/agents/native/client.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
      "src/agents/registry.ts": 'import { NativeAgentAdapter } from "./native";\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });

  test("fails when nax-ai is imported from outside that directory", () => {
    const root = tree({
      "src/agents/manager.ts": 'import { createClient } from "@nathapp/nax-ai";\n',
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("src/agents/manager.ts");
  });

  test("ignores the import name inside a comment", () => {
    const root = tree({
      "src/agents/manager.ts": '// see @nathapp/nax-ai for the client\nexport const x = 1;\n',
    });
    const { code } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/unit/scripts/check-nax-ai-imports.test.ts --timeout=30000`
Expected: FAIL — `scripts/check-nax-ai-imports.ts` does not exist.

- [ ] **Step 4: Write the gate**

`scripts/check-nax-ai-imports.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Fails if @nathapp/nax-ai is imported anywhere but src/agents/native/.
 *
 * The package is swappable only while its surface has one consumer. Mirrors
 * scripts/check-adapter-no-config-import.sh, and nax-ai's own
 * check-pi-ai-imports gate.
 *
 * Takes an optional root so the gate can be tested against a fixture tree.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const SCAN = join(ROOT, "src");
const ALLOWED_PREFIX = join("src", "agents", "native") + sep;
const IMPORT = /@nathapp\/nax-ai/;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Awaited<ReturnType<typeof readdir>>;
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

const violations: { file: string; line: number; text: string }[] = [];

for await (const file of walk(SCAN)) {
  const rel = relative(ROOT, file);
  if (rel.startsWith(ALLOWED_PREFIX)) continue;

  const source = await readFile(file, "utf8");
  source.split("\n").forEach((text, index) => {
    const stripped = text.trim();
    if (stripped.startsWith("*") || stripped.startsWith("//")) return;
    if (IMPORT.test(text)) violations.push({ file: rel, line: index + 1, text: stripped });
  });
}

if (violations.length > 0) {
  console.error("@nathapp/nax-ai may only be imported from src/agents/native/:");
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}

console.log("check-nax-ai-imports: clean");
```

- [ ] **Step 5: Create the directory the gate guards**

`src/agents/native/index.ts`:

```typescript
/**
 * The native LLM path: nax's own client, in-process, over @nathapp/nax-ai.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts). Everything outside it consumes the
 * AgentAdapter interface, so the wire library stays replaceable.
 *
 * The barrel re-exports only; it owns no values. NATIVE_AGENT lives in
 * models.ts (a leaf) so adapter.ts can import it without a cycle back through
 * this file — `check:import-cycles` runs against a baseline and a new cycle
 * fails it.
 */

export {};
```

- [ ] **Step 6: Wire the gate into CI**

In `package.json`, add the script and append it to the `lint` chain so
`check:gate-reachability` can see it:

```json
"check:nax-ai-imports": "bun run scripts/check-nax-ai-imports.ts",
```

and in `lint`, append ` && bun run check:nax-ai-imports` to the existing chain.

- [ ] **Step 7: Run tests and the gate**

Run: `bun test test/unit/scripts/check-nax-ai-imports.test.ts --timeout=30000 && bun run check:nax-ai-imports && bun run check:gate-reachability`
Expected: PASS, 3 tests; `check-nax-ai-imports: clean`; gate-reachability reports the new script as reachable.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock scripts/check-nax-ai-imports.ts src/agents/native/index.ts test/unit/scripts/check-nax-ai-imports.test.ts
git commit -m "chore(agents): add nax-ai and the gate that keeps it behind one directory

The gate lands with the directory rather than after it: a boundary added later
is a boundary that has already been crossed. It mirrors
check-adapter-no-config-import.sh and nax-ai's own check-pi-ai-imports.

Proven by violating it — the test asserts a fixture importing nax-ai from
src/agents/manager.ts exits non-zero. A gate never seen to fail is not a gate.

The dependency is pinned exactly: nax-ai is pre-1.0 and its surface is still
moving."
```

---

### Task 3: model reference, usage and cost

**Files:**
- Create: `src/agents/native/models.ts`
- Test: `test/unit/agents/native/models.test.ts`

**Interfaces:**
- Consumes: `NATIVE_AGENT` from `src/agents/native/index.ts`.
- Produces:
  - `parseNativeModel(raw: string): { provider: string; model: string }` — throws `NaxError` code `NATIVE_MODEL_MALFORMED` when `raw` has no `/`.
  - `toNaxTokenUsage(usage: NaxAiTokenUsage): TokenUsage`
  - `estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * Model reference parsing, usage mapping and cost for the native path.
 *
 * The provider travels in the model string because a multi-provider agent needs
 * it there — opencode already does this (ADR-027 section 1).
 */

import { describe, expect, test } from "bun:test";
import { estimateCostUsd, parseNativeModel, toNaxTokenUsage } from "@/agents/native/models";

describe("parseNativeModel", () => {
  test("splits provider from model", () => {
    expect(parseNativeModel("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
  });

  test("splits on the first slash so multi-segment model ids survive", () => {
    expect(parseNativeModel("huggingface/MiniMaxAI/MiniMax-M2.7")).toEqual({
      provider: "huggingface",
      model: "MiniMaxAI/MiniMax-M2.7",
    });
  });

  test("rejects a string with no provider, naming the remedy", () => {
    expect(() => parseNativeModel("claude-sonnet-5")).toThrow(/provider\/model/);
  });

  test("rejects an empty provider or model half", () => {
    expect(() => parseNativeModel("/deepseek-v4-flash")).toThrow();
    expect(() => parseNativeModel("openai/")).toThrow();
  });
});

describe("toNaxTokenUsage", () => {
  test("renames the cache fields to nax's names", () => {
    expect(
      toNaxTokenUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
    });
  });

  test("leaves absent cache fields absent rather than zero", () => {
    const mapped = toNaxTokenUsage({ inputTokens: 10, outputTokens: 5 });
    expect(mapped).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect("cacheReadInputTokens" in mapped).toBe(false);
  });
});

describe("estimateCostUsd", () => {
  test("bills input and output at rates per 1M tokens", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { inputPer1M: 3, outputPer1M: 15 },
    );
    expect(cost).toBeCloseTo(3 + 7.5, 6);
  });

  test("counts cache tokens as input when present", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      { inputPer1M: 3, outputPer1M: 15 },
    );
    expect(cost).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/models.test.ts --timeout=30000`
Expected: FAIL — `@/agents/native/models` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/agents/native/models.ts`:

```typescript
/**
 * Model reference, usage and cost for the native path.
 *
 * The provider travels inside the model string, not beside it: a multi-provider
 * agent needs it there, and opencode's entries already encode it that way
 * (ADR-027 section 1). Under acpx the same string stays opaque.
 */

import type { TokenPricing } from "@/config/schema-types";
import type { TokenUsage } from "@/agents/cost";
import { NaxError } from "@/errors";

/** nax-ai's usage shape. Declared locally: this file must not import nax-ai types into nax's surface. */
export interface NativeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** The one agent name that routes to this transport. Lives here, not in the
 *  barrel, so adapter.ts can import it without an index -> adapter -> index cycle. */
export const NATIVE_AGENT = "native";

export interface NativeModelRef {
  readonly provider: string;
  readonly model: string;
}

/**
 * Split on the FIRST slash: a provider id never contains one, a model id often
 * does (`huggingface/MiniMaxAI/MiniMax-M2.7`).
 */
export function parseNativeModel(raw: string): NativeModelRef {
  const slash = raw.indexOf("/");
  const provider = slash === -1 ? "" : raw.slice(0, slash);
  const model = slash === -1 ? "" : raw.slice(slash + 1);

  if (provider === "" || model === "") {
    throw new NaxError(
      `Native model "${raw}" must be written "provider/model" (e.g. "openai/gpt-5.4-mini"). There is no default provider.`,
      "NATIVE_MODEL_MALFORMED",
      { stage: "complete", model: raw },
    );
  }
  return { provider, model };
}

/**
 * The two sides name the cache fields differently. An absent field stays
 * absent rather than becoming 0, so "no cache data" and "zero cache tokens"
 * stay distinguishable downstream.
 */
export function toNaxTokenUsage(usage: NativeUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheCreationInputTokens: usage.cacheWriteTokens } : {}),
  };
}

const PER_MILLION = 1_000_000;

/**
 * Both sides express rates per 1M tokens (nax-ai's PricingRates is documented
 * so, and nax's TokenPricing is inputPer1M), so there is no unit conversion.
 *
 * Cache tokens bill at the input rate. Phase A does not model separate
 * cache-read / cache-write rates, and over-reporting a cache read as full input
 * is the safer direction of error.
 */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number {
  const input = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return (input / PER_MILLION) * rates.inputPer1M + (usage.outputTokens / PER_MILLION) * rates.outputPer1M;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/agents/native/models.test.ts --timeout=30000`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/models.ts test/unit/agents/native/models.test.ts
git commit -m "feat(native): parse provider/model, map usage, compute cost

Splits on the first slash, because a provider id never contains one and a model
id often does (huggingface/MiniMaxAI/MiniMax-M2.7). A string with no slash is an
error naming the remedy — there is no default provider to fall back on, and
treating a bare id as a provider would fail later and further away.

The two TokenUsage shapes name their cache fields differently. An absent field
stays absent rather than becoming 0, so \"no cache data\" and \"zero cache
tokens\" remain distinguishable.

Both sides express rates per 1M tokens, so cost needs no unit conversion."
```

---

### Task 4: error mapping

**Files:**
- Create: `src/agents/native/errors.ts`
- Test: `test/unit/agents/native/errors.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `toAdapterFailure(kind: string, retryAfter?: number): AdapterFailure`
  - `class NativeSessionUnsupportedError extends NaxError`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * nax-ai error kinds to nax's failure taxonomy.
 *
 * Four of six kinds must be "availability", because that is the only category
 * shouldSwap's fallback branch accepts. A blanket quality/fail-unknown once
 * made every transient failure terminal for exactly these complete-kind ops;
 * this table is what stops that returning.
 */

import { describe, expect, test } from "bun:test";
import { NativeSessionUnsupportedError, toAdapterFailure } from "@/agents/native/errors";

describe("toAdapterFailure", () => {
  test.each([
    ["rate-limit", "availability", "fail-rate-limit"],
    ["auth", "availability", "fail-auth"],
    ["overloaded", "availability", "fail-service-down"],
    ["transport", "availability", "fail-service-down"],
    ["bad-request", "quality", "fail-adapter-error"],
    ["unknown", "quality", "fail-unknown"],
  ])("maps %s to %s/%s", (kind, category, outcome) => {
    const failure = toAdapterFailure(kind);
    expect(failure.category).toBe(category as "availability" | "quality");
    expect(failure.outcome).toBe(outcome);
  });

  test("keeps four of six kinds swappable", () => {
    const kinds = ["rate-limit", "auth", "overloaded", "transport", "bad-request", "unknown"];
    const availability = kinds.filter((k) => toAdapterFailure(k).category === "availability");
    expect(availability).toHaveLength(4);
  });

  test("treats an unrecognised kind as unknown rather than throwing", () => {
    expect(toAdapterFailure("something-new").outcome).toBe("fail-unknown");
  });
});

describe("NativeSessionUnsupportedError", () => {
  test("names the method and the phase that will add it", () => {
    const err = new NativeSessionUnsupportedError("openSession");
    expect(err.message).toContain("openSession");
    expect(err.message).toContain("Phase B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/errors.test.ts --timeout=30000`
Expected: FAIL — `@/agents/native/errors` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/agents/native/errors.ts`:

```typescript
/**
 * nax-ai's typed error kinds mapped to nax's failure taxonomy.
 *
 * nax-ai returns a discriminated kind, so nothing here parses a message. The
 * acpx path has to (parseAgentError); this one must not start.
 *
 * The category split is load-bearing: shouldSwap's fallback branch only accepts
 * "availability", so a kind filed under "quality" is terminal for the op.
 */

import type { AdapterFailure } from "@/context/engine";
import { NaxError } from "@/errors";

const FAILURES: Readonly<Record<string, AdapterFailure>> = Object.freeze({
  "rate-limit": { category: "availability", outcome: "fail-rate-limit", retriable: true },
  auth: { category: "availability", outcome: "fail-auth", retriable: false },
  overloaded: { category: "availability", outcome: "fail-service-down", retriable: true },
  // nax-ai already retried transport faults before the first event. Reaching
  // here means the retries were exhausted, so the service is unreachable.
  transport: { category: "availability", outcome: "fail-service-down", retriable: true },
  // Our request is malformed. A different agent would build the same one.
  "bad-request": { category: "quality", outcome: "fail-adapter-error", retriable: false },
  unknown: { category: "quality", outcome: "fail-unknown", retriable: false },
});

const UNKNOWN: AdapterFailure = FAILURES.unknown as AdapterFailure;

/**
 * An unrecognised kind degrades to unknown rather than throwing: a new nax-ai
 * kind should downgrade one call, not crash the run.
 */
export function toAdapterFailure(kind: string): AdapterFailure {
  return FAILURES[kind] ?? UNKNOWN;
}

export class NativeSessionUnsupportedError extends NaxError {
  constructor(method: string) {
    super(
      `The native agent cannot ${method}: it is one-shot until Phase B adds session support. Use an acpx agent for session work.`,
      "NATIVE_SESSION_UNSUPPORTED",
      { stage: "session", method },
    );
    this.name = "NativeSessionUnsupportedError";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/agents/native/errors.test.ts --timeout=30000`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/errors.ts test/unit/agents/native/errors.test.ts
git commit -m "feat(native): map nax-ai error kinds to nax's failure taxonomy

nax-ai returns a discriminated kind, so nothing here parses a message. The acpx
path has to; this one must not start.

The category split is load-bearing rather than cosmetic: shouldSwap's fallback
branch only accepts \"availability\", so a kind filed under \"quality\" is
terminal for the op. Four of six kinds are availability, and a test pins that
count — a blanket quality/fail-unknown once made every transient failure
terminal for exactly these complete-kind ops.

An unrecognised kind degrades to unknown rather than throwing: a new nax-ai kind
should downgrade one call, not crash the run."
```

---

### Task 5: the nax-ai client

**Files:**
- Create: `src/agents/native/client.ts`
- Test: `test/unit/agents/native/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getNativeClient(): Promise<Client>` — memoised; builds once per process.
  - `_clientDeps: { build: () => Promise<Client> }` — the test seam.
  - `_resetNativeClient(): void` — clears the memo between tests.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * Construction of the nax-ai client.
 *
 * piProviders() loads a ~650KB bundled catalog, so the client is built once and
 * memoised. Tests replace the builder through _clientDeps rather than reaching
 * the network or the catalog.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _clientDeps, _resetNativeClient, getNativeClient } from "@/agents/native/client";

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

describe("getNativeClient", () => {
  test("builds the client once and reuses it", async () => {
    let built = 0;
    const fake = { pricing: () => ({}) } as unknown as Awaited<ReturnType<typeof getNativeClient>>;
    _clientDeps.build = async () => {
      built += 1;
      return fake;
    };

    const a = await getNativeClient();
    const b = await getNativeClient();

    expect(built).toBe(1);
    expect(a).toBe(b);
  });

  test("does not memoise a failed build, so a later call can succeed", async () => {
    let attempt = 0;
    const fake = { pricing: () => ({}) } as unknown as Awaited<ReturnType<typeof getNativeClient>>;
    _clientDeps.build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("catalog unavailable");
      return fake;
    };

    await expect(getNativeClient()).rejects.toThrow("catalog unavailable");
    await expect(getNativeClient()).resolves.toBe(fake);
    expect(attempt).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/client.test.ts --timeout=30000`
Expected: FAIL — `@/agents/native/client` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/agents/native/client.ts`:

```typescript
/**
 * The nax-ai client, built once per process.
 *
 * piProviders() loads nax-ai's bundled catalog (~1290 models), so building per
 * call would pay that cost on every completion. The build is memoised, but a
 * FAILED build is not: a transient failure must not poison the process.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts).
 */

import { type Client, createClient, piProtocols, piProviders } from "@nathapp/nax-ai";

/** Test seam: replaced in tests so no catalog is loaded and no network is reached. */
export const _clientDeps = {
  build: async (): Promise<Client> =>
    createClient({
      providers: await piProviders(),
      protocols: piProtocols(),
    }),
};

let cached: Promise<Client> | undefined;

export async function getNativeClient(): Promise<Client> {
  if (cached === undefined) {
    // Cache the promise, not the value, so concurrent callers share one build.
    // Drop it on rejection: a failed catalog load should not be permanent.
    cached = _clientDeps.build().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetNativeClient(): void {
  cached = undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/agents/native/client.test.ts --timeout=30000`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify the gate still passes**

Run: `bun run check:nax-ai-imports`
Expected: `check-nax-ai-imports: clean` — the import is inside `src/agents/native/`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/client.ts test/unit/agents/native/client.test.ts
git commit -m "feat(native): build the nax-ai client once, and not on failure

piProviders() loads a bundled catalog of ~1290 models, so building per call
would pay that cost on every completion. The promise is memoised rather than the
value, so concurrent callers share one build.

A rejected build clears the memo. Caching a failure would turn one transient
catalog load error into a permanently broken process."
```

---

### Task 6: the adapter

**Files:**
- Create: `src/agents/native/adapter.ts`
- Modify: `src/agents/native/index.ts`
- Test: `test/unit/agents/native/adapter.test.ts`

**Interfaces:**
- Consumes: `parseNativeModel`, `toNaxTokenUsage`, `estimateCostUsd` (Task 3); `toAdapterFailure`, `NativeSessionUnsupportedError` (Task 4); `getNativeClient`, `_clientDeps` (Task 5).
- Produces: `NativeAgentAdapter implements AgentAdapter`, exported from `src/agents/native/index.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * The native adapter.
 *
 * complete() catches nax-ai's ProtocolStreamError and returns an adapterFailure
 * rather than rethrowing: rethrowing would route through
 * classifyCompleteException -> parseAgentError, which parses ACP strings and
 * would discard the typed kind nax-ai just handed us.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL_BUILD = _clientDeps.build;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const MODEL = { id: "gpt-5.4-mini", provider: "openai", protocol: "openai-responses" };

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    model: async () => MODEL,
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      stopReason: "stop",
    }),
    ...over,
  };
}

function options(): ResolvedCompleteOptions {
  return {
    // provider is what resolveModel() infers for this string: "unknown".
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  } as unknown as ResolvedCompleteOptions;
}

describe("NativeAgentAdapter.complete", () => {
  test("returns the text, mapped usage and a computed cost", async () => {
    _clientDeps.build = async () => fakeClient() as never;
    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.output).toBe("ok");
    expect(result.tokenUsage.inputTokens).toBe(1_000_000);
    expect(result.estimatedCostUsd).toBeCloseTo(3, 6);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("ignores modelDef.provider, which resolveModel only guessed", async () => {
    // resolveModel infers "unknown" for "openai/gpt-5.4-mini" and would infer
    // "anthropic" for anything starting "claude". Neither is configuration.
    let asked: [string, string] | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        model: async (p: string, m: string) => {
          asked = [p, m];
          return MODEL;
        },
      }) as never;

    const opts = options();
    (opts.modelDef as { provider: string }).provider = "unknown";
    await new NativeAgentAdapter().complete("hi", opts);

    expect(asked).toEqual(["openai", "gpt-5.4-mini"]);
  });

  test("never sets exactCostUsd, because nax-ai supplies rates and not cost", async () => {
    _clientDeps.build = async () => fakeClient() as never;
    const result = await new NativeAgentAdapter().complete("hi", options());
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("turns a rate limit into a swappable availability failure", async () => {
    class ProtocolStreamError extends Error {
      constructor(readonly protocolError: { kind: string; message: string }) {
        super(protocolError.message);
        this.name = "ProtocolStreamError";
      }
    }
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429" });
        },
      }) as never;

    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(result.output).toBe("");
  });
});

describe("NativeAgentAdapter shape", () => {
  test("declares no binary and builds no command", () => {
    const adapter = new NativeAgentAdapter();
    expect(adapter.binary).toBe("");
    expect(adapter.buildCommand()).toEqual([]);
  });

  test("refuses session methods, naming the phase that adds them", async () => {
    const adapter = new NativeAgentAdapter();
    await expect(adapter.openSession()).rejects.toThrow(/Phase B/);
    await expect(adapter.sendTurn()).rejects.toThrow(/Phase B/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/adapter.test.ts --timeout=30000`
Expected: FAIL — `@/agents/native/adapter` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/agents/native/adapter.ts`:

```typescript
/**
 * The native AgentAdapter: one-shot completions over nax-ai, no subprocess.
 *
 * Members that describe a process are answered honestly rather than faked:
 * there is no binary, no command and no pid. Session methods throw until
 * Phase B, which is a storage feature rather than a mapping over complete()
 * (ADR-027 section 10).
 */

import type { AgentAdapter, AgentCapabilities, CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import { getNativeClient } from "./client";
import { NativeSessionUnsupportedError, toAdapterFailure } from "./errors";
import { estimateCostUsd, NATIVE_AGENT, parseNativeModel, toNaxTokenUsage } from "./models";

/** Conservative until capabilities become model-derived (ADR-027 Open Question 3). */
const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } } {
  return typeof err === "object" && err !== null && "protocolError" in err;
}

export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  /** Nothing to spawn. Not a placeholder — the absence is the fact. */
  readonly binary = "";
  readonly capabilities: AgentCapabilities = {
    supportedTiers: [],
    maxContextTokens: CONSERVATIVE_CONTEXT_TOKENS,
    features: new Set(["review", "batch"] as const),
  };

  /** "Installed" can only mean "credentials resolve" with no binary to find. */
  async isInstalled(): Promise<boolean> {
    return this.hasCredentials();
  }

  async hasCredentials(): Promise<boolean> {
    // Phase A resolves ambient environment keys only; a store arrives in plan 2.
    try {
      await getNativeClient();
      return true;
    } catch {
      return false;
    }
  }

  /** Dry-run display shows no process, because there is none. */
  buildCommand(): string[] {
    return [];
  }

  async complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> {
    // modelDef.provider is deliberately ignored. resolveModel() INFERS it from
    // the model name for string entries ("claude..." -> anthropic, else
    // "unknown"), so it is a guess rather than configuration — and routing a
    // billed call on a guess is what the protocol gate exists to prevent. The
    // string is the only source of truth.
    const { provider, model } = parseNativeModel(options.modelDef.model);
    const client = await getNativeClient();
    const resolved = await client.model(provider, model);

    const controller = new AbortController();
    const timer =
      options.timeoutMs !== undefined ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

    try {
      const result = await client.complete(resolved, {
        messages: [{ role: "user", content: prompt }],
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        signal: controller.signal,
      });

      const tokenUsage = toNaxTokenUsage(result.usage);
      const catalog = client.pricing(resolved);
      const rates = options.modelDef.pricing ?? {
        inputPer1M: catalog.input,
        outputPer1M: catalog.output,
      };

      return {
        output: result.text,
        tokenUsage,
        estimatedCostUsd: estimateCostUsd(tokenUsage, rates),
        // exactCostUsd is deliberately unset: nax-ai supplies rates and
        // computes no cost, so nothing here is exact.
      };
    } catch (err) {
      // Returned, not rethrown: rethrowing routes through
      // classifyCompleteException -> parseAgentError, which parses ACP strings
      // and would discard the typed kind nax-ai just gave us.
      if (isProtocolStreamError(err)) {
        return {
          output: "",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          adapterFailure: toAdapterFailure(err.protocolError.kind),
        };
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  openSession(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("openSession"));
  }

  sendTurn(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("sendTurn"));
  }

  closeSession(): Promise<never> {
    return Promise.reject(new NativeSessionUnsupportedError("closeSession"));
  }
}
```

- [ ] **Step 4: Re-export from the barrel**

Replace the body of `src/agents/native/index.ts` below its header comment with:

```typescript
export { NativeAgentAdapter } from "./adapter";
export { NativeSessionUnsupportedError } from "./errors";
export { NATIVE_AGENT } from "./models";
```

`NATIVE_AGENT` already lives in `models.ts` (Task 3), so the barrel only
re-exports — no value moves and no cycle is introduced.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/agents/native --timeout=60000`
Expected: PASS — all four native test files.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/adapter.ts src/agents/native/index.ts src/agents/native/models.ts test/unit/agents/native/adapter.test.ts
git commit -m "feat(native): the one-shot AgentAdapter over nax-ai

Members describing a process are answered honestly rather than faked: no
binary, no command, no pid callbacks. Session methods throw and name Phase B.

complete() catches nax-ai's ProtocolStreamError and returns an adapterFailure
instead of rethrowing. Rethrowing would route through
classifyCompleteException -> parseAgentError, which parses ACP error strings and
would discard the typed kind nax-ai just handed us — the classification that
decides whether the op can swap agents at all.

exactCostUsd stays unset: nax-ai supplies rates and computes no cost, so
nothing on this path is exact."
```

---

### Task 7: registry discrimination

**Files:**
- Modify: `src/agents/registry.ts:13` (`KNOWN_AGENT_NAMES`), `:36` (`buildAdapterList`), `:100` (the log line), and `createAgentRegistry`'s adapter construction
- Test: `test/unit/agents/registry-native.test.ts`

**Interfaces:**
- Consumes: `NATIVE_AGENT`, `NativeAgentAdapter` from `@/agents/native`.
- Produces: `getAgent("native")` returns a `NativeAgentAdapter`; every other name still returns an `AcpAgentAdapter`.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * The registry discriminates by agent name (ADR-027 section 3).
 *
 * Note the deliberate wrinkle: getAllAgents/getInstalledAgents are config-less
 * by design and cannot consult the protocol gate, so native appears in their
 * listings regardless. The gate bites at config validation and
 * createAgentRegistry.
 */

import { describe, expect, test } from "bun:test";
import { NativeAgentAdapter } from "@/agents/native";
import { AcpAgentAdapter } from "@/agents/acp/adapter";
import { getAllAgents, KNOWN_AGENT_NAMES } from "@/agents/registry";

describe("registry discrimination", () => {
  test("knows the native agent", () => {
    expect(KNOWN_AGENT_NAMES).toContain("native");
  });

  test("builds a NativeAgentAdapter for native and AcpAgentAdapter for the rest", () => {
    const byName = new Map(getAllAgents().map((a) => [a.name, a]));

    expect(byName.get("native")).toBeInstanceOf(NativeAgentAdapter);
    expect(byName.get("claude")).toBeInstanceOf(AcpAgentAdapter);
    expect(byName.get("codex")).toBeInstanceOf(AcpAgentAdapter);
  });

  test("the native adapter reports no binary, so nothing tries to spawn it", () => {
    const native = getAllAgents().find((a) => a.name === "native");
    expect(native?.binary).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/registry-native.test.ts --timeout=30000`
Expected: FAIL — `KNOWN_AGENT_NAMES` does not contain `"native"`.

- [ ] **Step 3: Add native to the known names and discriminate**

In `src/agents/registry.ts`, import the native surface:

```typescript
import { NATIVE_AGENT, NativeAgentAdapter } from "./native";
```

Extend the known names:

```typescript
/** Known agent names (used for name validation and health checks) */
export const KNOWN_AGENT_NAMES = ["claude", "codex", "opencode", "gemini", "aider", "pi", NATIVE_AGENT];
```

Replace `buildAdapterList`'s construction:

```typescript
/**
 * The registry is a routing decision, not one adapter kind repeated: the agent
 * name selects the transport (ADR-027 section 3).
 */
function adapterFor(name: string): AgentAdapter {
  return name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
}

function buildAdapterList(): AgentAdapter[] {
  return [...Array.from(_registryTestAdapters.values()), ...KNOWN_AGENT_NAMES.map(adapterFor)];
}
```

- [ ] **Step 4: Apply the same discrimination inside `createAgentRegistry`**

`createAgentRegistry` keeps its own `acpCache`. Adapt its `getAgent` path so a
request for `native` returns a `NativeAgentAdapter` rather than a cached
`AcpAgentAdapter`, and fix the hard-coded log line:

```typescript
  const protocol = config.agent?.protocol ?? "acp";
  logger?.info("agents", `Agent protocol: ${protocol}`, { protocol, hasConfig: !!config.agent });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/agents/registry-native.test.ts --timeout=30000`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole agents suite for regressions**

Run: `bun test test/unit/agents test/integration/agents --timeout=120000`
Expected: PASS. The 86 existing agent test files must stay green — Phase A
changes no acpx behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/agents/registry.ts test/unit/agents/registry-native.test.ts
git commit -m "feat(agents): discriminate the adapter by agent name

registry.ts hard-coded new AcpAgentAdapter(name) for every known agent. It now
picks by name: native builds the native adapter, everything else acpx.

Also fixes the hard-coded 'Agent protocol: acp' log line, which becomes a lie
the moment the gate accepts another value.

Known and deliberate: getAllAgents/getInstalledAgents are config-less by design
and cannot consult the protocol gate, so native appears in those listings
whatever the gate says, and its isInstalled() answers about credentials rather
than permission. The gate bites at config validation and createAgentRegistry
(ADR-027 section 3, Open Question 4)."
```

---

### Task 8: documentation

**Files:**
- Modify: `.nax/context.md`
- Modify: `.nax/rules/adapter-wiring.md`
- Regenerate: `CLAUDE.md`, `.claude/rules/*` (via `nax generate`)

**Interfaces:**
- Consumes: everything above.
- Produces: no code. Generated agent files describe the native path.

- [ ] **Step 1: Update the source of truth**

In `.nax/context.md`, replace the "Single protocol: ACP … the registry
hard-codes it" claim under **Agent Adapter & LLM Calls** with:

```markdown
- **Two transports, selected by agent name:** ACP via `acpx` for every named CLI
  agent, and the in-process native path (`@nathapp/nax-ai`) for the `native`
  agent. `agent.protocol` (`acp` | `native` | `hybrid`, default `acp`) is a
  capability gate, not a router — it decides which are permitted. See ADR-027.
- **nax-ai is importable only from `src/agents/native/`**, enforced by
  `bun run check:nax-ai-imports`.
```

Add `src/agents/native/` to the Key Source Directories table:

```markdown
| `src/agents/native/` | Native in-process LLM path over `@nathapp/nax-ai` (one-shot `complete()`; sessions are Phase B) |
```

- [ ] **Step 2: Update the path-scoped rule**

In `.nax/rules/adapter-wiring.md`, add:

```markdown
## Native path

`src/agents/native/` is the only directory that may import `@nathapp/nax-ai`.
Its adapter answers `complete()` only — `openSession`/`sendTurn`/`closeSession`
throw `NativeSessionUnsupportedError` until Phase B. Model entries under
`models.native` are `"provider/model"`; a string with no `/` is a config error.
```

- [ ] **Step 3: Regenerate the agent files**

Run: `bun run nax generate` (or the repo's documented generate command)
Expected: `CLAUDE.md` and `.claude/rules/*` are rewritten from `.nax/`.

- [ ] **Step 4: Verify no drift**

Run: `bun run check:rules-drift`
Expected: `[OK] .claude/rules/ is up to date with .nax/rules/`

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add .nax/context.md .nax/rules/adapter-wiring.md CLAUDE.md .claude/rules
git commit -m "docs: describe the native transport in the generated agent files

.nax/context.md said 'Single protocol: ACP ... the registry hard-codes it',
which stopped being true when the registry started discriminating. Edited at the
source: CLAUDE.md and .claude/rules are generated, and check:rules-drift fails
if they are edited directly."
```

---

## Definition of Done

- [ ] `bun run typecheck`, `bun run lint`, `bun run test` all pass.
- [ ] `bun run check:nax-ai-imports` passes and its failure case is covered by a test.
- [ ] `bun run check:gate-reachability` sees the new script.
- [ ] `bun run check:rules-drift` passes.
- [ ] `bun run check:file-sizes` passes; no file in `src/agents/native/` exceeds 600 lines and `src/agents/acp/adapter.ts` is untouched.
- [ ] The 86 existing test files under `test/**/agents/**` are green.
- [ ] A config with `protocol: "acp"` and no `native` entry behaves exactly as before.

## What this plan does not deliver

Deliberately, per the spec's §10:

- **Credentials beyond ambient env** — plan 2 (`~/.nax/credentials`, `nax auth`).
- **The routing amendments** — plan 3 (fallback `(agent, tier)` targets, `modelTier` attribution for non-builtin tiers).
- **Any op actually using the native path** — plan 4. No op's default agent changes here; the path exists and is reachable only by explicit config.
