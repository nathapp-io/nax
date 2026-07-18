# Built-in Reporter Plugins (webhook + OTel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two opt-in built-in reporter plugins — `webhook-reporter` and `otel-reporter` — that turn nax run telemetry into external signals with zero custom plugin code.

**Architecture:** Both plugins are factory functions returning a `NaxPlugin` that closes over its config slice (because `IReporter` methods receive only the event, no config). They consume the already-wired `IReporter` extension point and `wireReporters` subscriber. `webhook-reporter` is stateless and POSTs a JSON envelope per event. `otel-reporter` buffers each run into OTLP/HTTP-JSON traces + metrics, hand-built (no `@opentelemetry/*` dependency), and POSTs via `fetch` at run end. A new `reporters` config block is threaded into `loadPlugins`, which registers each reporter only when enabled.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, Zod config schemas, `bun:test`, Web `crypto` + `fetch` + `AbortSignal` (all Bun-native).

**Design doc:** `docs/superpowers/specs/2026-07-18-builtin-reporter-design.md`

## Global Constraints

- **Bun-native only.** Use `globalThis.fetch`, `crypto.getRandomValues`, `AbortSignal.timeout`. No Node.js APIs (`fs`, `child_process`, `setTimeout` for delays).
- **No new runtime dependencies.** OTLP payloads are hand-built.
- **TypeScript strict.** No `any` in public APIs.
- **Logging:** use `getSafeLogger()` from `src/logger` with an explicit stage string. No `console.*`. No emojis. Prefer structured fields.
- **Secrets** are supplied only via `${ENV_VAR}` interpolation in header values — never stored in config, **never logged**.
- **Config defaults live in the Zod schema** (`.default()`); `DEFAULT_CONFIG` stays schema-derived.
- **Barrel imports.** Every directory with 2+ exports gets an `index.ts`; import from barrels, never internal paths.
- **File size** < 600 lines (src), < 800 lines (test).
- **Tests:** never run bare `bun test`. Always `timeout 30 bun test <path> --timeout=5000`.
- **Commits:** conventional (`feat:`, `test:`, `docs:`), atomic.

---

## File Structure

```
src/config/
  schemas-reporters.ts          # CREATE — ReportersConfigSchema + types
  schemas.ts                    # MODIFY — wire reporters block into top-level schema
src/plugins/builtin/
  reporter-shared/
    index.ts                    # CREATE — barrel
    interpolate.ts              # CREATE — interpolateHeaders
    post-json.ts                # CREATE — postJson (bounded fetch, _deps)
  webhook-reporter/
    index.ts                    # CREATE — createWebhookReporterPlugin
  otel-reporter/
    index.ts                    # CREATE — createOtelReporterPlugin (stateful)
    ids.ts                      # CREATE — traceId/spanId generation
    otlp.ts                     # CREATE — OTLP/HTTP-JSON builders + attr helpers
src/plugins/
  loader.ts                     # MODIFY — add reporters param, register builtins
src/execution/lifecycle/
  run-setup.ts                  # MODIFY — pass config.reporters into loadPlugins
```

Test files mirror source under `test/unit/`.

---

## Task 1: Reporter config schema

**Files:**
- Create: `src/config/schemas-reporters.ts`
- Modify: `src/config/schemas.ts` (import + add `reporters` field to top-level object, next to `autoPr`)
- Test: `test/unit/config/reporters-schema.test.ts`

**Interfaces:**
- Produces:
  - `ReportersConfigSchema: z.ZodType` with `.default({})`
  - `type ReportersConfig = { webhook: WebhookReporterConfig; otel: OtelReporterConfig }`
  - `type WebhookReporterConfig = { enabled: boolean; url?: string; headers: Record<string,string>; events?: ("onRunStart"|"onStoryComplete"|"onRunEnd")[]; timeoutMs: number }`
  - `type OtelReporterConfig = { enabled: boolean; endpoint?: string; headers: Record<string,string>; serviceName: string; timeoutMs: number }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/config/reporters-schema.test.ts
import { describe, expect, test } from "bun:test";
import { ReportersConfigSchema } from "../../../src/config/schemas-reporters";

describe("ReportersConfigSchema", () => {
  test("defaults both reporters to disabled with 5000ms timeout", () => {
    const parsed = ReportersConfigSchema.parse({});
    expect(parsed.webhook.enabled).toBe(false);
    expect(parsed.otel.enabled).toBe(false);
    expect(parsed.webhook.timeoutMs).toBe(5000);
    expect(parsed.otel.timeoutMs).toBe(5000);
    expect(parsed.otel.serviceName).toBe("nax");
    expect(parsed.webhook.headers).toEqual({});
  });

  test("accepts webhook config with url, headers, and event filter", () => {
    const parsed = ReportersConfigSchema.parse({
      webhook: {
        enabled: true,
        url: "https://example.com/hook",
        headers: { Authorization: "Bearer ${TOKEN}" },
        events: ["onRunEnd"],
      },
    });
    expect(parsed.webhook.enabled).toBe(true);
    expect(parsed.webhook.url).toBe("https://example.com/hook");
    expect(parsed.webhook.events).toEqual(["onRunEnd"]);
  });

  test("rejects an unknown event name", () => {
    const res = ReportersConfigSchema.safeParse({
      webhook: { events: ["onSomething"] },
    });
    expect(res.success).toBe(false);
  });

  test("rejects a non-URL webhook url", () => {
    const res = ReportersConfigSchema.safeParse({ webhook: { url: "not-a-url" } });
    expect(res.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/reporters-schema.test.ts --timeout=5000`
Expected: FAIL — cannot find module `schemas-reporters`.

- [ ] **Step 3: Create the schema module**

```typescript
// src/config/schemas-reporters.ts
import { z } from "zod";

/** Header map; values may contain ${ENV_VAR} placeholders resolved at emit time. */
const HeadersSchema = z.record(z.string(), z.string()).default({});

const ReporterEventSchema = z.enum(["onRunStart", "onStoryComplete", "onRunEnd"]);

export const WebhookReporterConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
    headers: HeadersSchema,
    events: z.array(ReporterEventSchema).optional(),
    timeoutMs: z.number().int().positive().default(5000),
  })
  .default({});

export const OtelReporterConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().optional(),
    headers: HeadersSchema,
    serviceName: z.string().default("nax"),
    timeoutMs: z.number().int().positive().default(5000),
  })
  .default({});

export const ReportersConfigSchema = z
  .object({
    webhook: WebhookReporterConfigSchema,
    otel: OtelReporterConfigSchema,
  })
  .default({});

export type ReporterEvent = z.infer<typeof ReporterEventSchema>;
export type WebhookReporterConfig = z.infer<typeof WebhookReporterConfigSchema>;
export type OtelReporterConfig = z.infer<typeof OtelReporterConfigSchema>;
export type ReportersConfig = z.infer<typeof ReportersConfigSchema>;
```

- [ ] **Step 4: Wire into the top-level schema**

In `src/config/schemas.ts`, add the import near the other schema-module imports at the top of the file:

```typescript
import { ReportersConfigSchema } from "./schemas-reporters";
```

Then add the `reporters` field to the top-level config object, immediately after the `autoPr` field (around line 421-427):

```typescript
    autoPr: z
      .object({
        enabled: z.boolean().default(false),
        draft: z.boolean().default(true),
      })
      .optional()
      .default({ enabled: false, draft: true }),
    reporters: ReportersConfigSchema,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/config/reporters-schema.test.ts --timeout=5000`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify the top-level default derivation still parses**

Run: `timeout 30 bun test test/unit/config --timeout=5000`
Expected: PASS — `NaxConfigSchema.parse({})` now yields `config.reporters.webhook.enabled === false`.

- [ ] **Step 7: Commit**

```bash
git add src/config/schemas-reporters.ts src/config/schemas.ts test/unit/config/reporters-schema.test.ts
git commit -m "feat(config): add reporters config schema for built-in reporters"
```

---

## Task 2: Shared reporter helpers

**Files:**
- Create: `src/plugins/builtin/reporter-shared/interpolate.ts`
- Create: `src/plugins/builtin/reporter-shared/post-json.ts`
- Create: `src/plugins/builtin/reporter-shared/index.ts`
- Test: `test/unit/plugins/builtin/reporter-shared.test.ts`

**Interfaces:**
- Produces:
  - `interpolateHeaders(headers: Record<string,string>, env?: Record<string,string|undefined>): { resolved: Record<string,string>; missing: string[] }`
  - `postJson(url: string, body: unknown, opts: { headers: Record<string,string>; timeoutMs: number; stage: string; deps?: PostJsonDeps }): Promise<boolean>`
  - `interface PostJsonDeps { fetch: typeof globalThis.fetch }` and `const _postJsonDeps: PostJsonDeps`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugins/builtin/reporter-shared.test.ts
import { describe, expect, test } from "bun:test";
import {
  interpolateHeaders,
  postJson,
  type PostJsonDeps,
} from "../../../../src/plugins/builtin/reporter-shared";

describe("interpolateHeaders", () => {
  test("resolves a single env placeholder", () => {
    const { resolved, missing } = interpolateHeaders(
      { Authorization: "Bearer ${TOK}" },
      { TOK: "abc" },
    );
    expect(resolved.Authorization).toBe("Bearer abc");
    expect(missing).toEqual([]);
  });

  test("resolves multiple placeholders across headers", () => {
    const { resolved, missing } = interpolateHeaders(
      { A: "${X}", B: "p-${Y}-q" },
      { X: "1", Y: "2" },
    );
    expect(resolved).toEqual({ A: "1", B: "p-2-q" });
    expect(missing).toEqual([]);
  });

  test("reports missing env vars without throwing", () => {
    const { missing } = interpolateHeaders({ A: "${GONE}" }, {});
    expect(missing).toEqual(["GONE"]);
  });

  test("passes through literal values untouched", () => {
    const { resolved, missing } = interpolateHeaders({ A: "plain" }, {});
    expect(resolved.A).toBe("plain");
    expect(missing).toEqual([]);
  });
});

describe("postJson", () => {
  const okFetch: PostJsonDeps["fetch"] = async () =>
    new Response(null, { status: 200 });

  test("returns true and POSTs JSON with merged headers on 2xx", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const deps: PostJsonDeps = {
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(null, { status: 204 });
      },
    };
    const ok = await postJson("https://h/x", { a: 1 }, {
      headers: { "X-Api": "k" },
      timeoutMs: 1000,
      stage: "test",
      deps,
    });
    expect(ok).toBe(true);
    expect(capturedUrl).toBe("https://h/x");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api")).toBe("k");
    expect(capturedInit?.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("returns false on non-2xx", async () => {
    const deps: PostJsonDeps = { fetch: async () => new Response(null, { status: 500 }) };
    const ok = await postJson("https://h/x", {}, {
      headers: {}, timeoutMs: 1000, stage: "test", deps,
    });
    expect(ok).toBe(false);
  });

  test("returns false when fetch throws (network/timeout)", async () => {
    const deps: PostJsonDeps = { fetch: async () => { throw new Error("boom"); } };
    const ok = await postJson("https://h/x", {}, {
      headers: {}, timeoutMs: 1000, stage: "test", deps,
    });
    expect(ok).toBe(false);
  });

  test("uses the ok fetch by default deps arg", async () => {
    const ok = await postJson("https://h/x", {}, {
      headers: {}, timeoutMs: 1000, stage: "test", deps: { fetch: okFetch },
    });
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/builtin/reporter-shared.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `interpolate.ts`**

```typescript
// src/plugins/builtin/reporter-shared/interpolate.ts

/** Matches ${VAR_NAME} — uppercase, digits, underscore. */
const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Resolve ${ENV_VAR} placeholders in header values from `env` (default
 * `process.env`). Returns the resolved header map and the de-duplicated list
 * of variable names that were referenced but not set. Never throws.
 */
export function interpolateHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): { resolved: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(ENV_PLACEHOLDER, (_match, name: string) => {
      const v = env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  return { resolved, missing: [...missing] };
}
```

- [ ] **Step 4: Implement `post-json.ts`**

```typescript
// src/plugins/builtin/reporter-shared/post-json.ts
import { getSafeLogger } from "../../../logger";
import { errorMessage } from "../../../utils/errors";

export interface PostJsonDeps {
  fetch: typeof globalThis.fetch;
}

/** Default deps — injectable for tests. */
export const _postJsonDeps: PostJsonDeps = { fetch: globalThis.fetch };

/**
 * POST `body` as JSON to `url` with a bounded timeout. Fire-and-forget:
 * non-2xx responses and thrown errors are logged at `warn` (under `stage`)
 * and swallowed — returns `true` only on a 2xx response. Resolved header
 * values are never logged.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: { headers: Record<string, string>; timeoutMs: number; stage: string; deps?: PostJsonDeps },
): Promise<boolean> {
  const deps = opts.deps ?? _postJsonDeps;
  const logger = getSafeLogger();
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      logger?.warn(opts.stage, "Telemetry POST returned non-2xx", { url, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger?.warn(opts.stage, "Telemetry POST failed", { url, error: errorMessage(err) });
    return false;
  }
}
```

- [ ] **Step 5: Create the barrel**

```typescript
// src/plugins/builtin/reporter-shared/index.ts
export { interpolateHeaders } from "./interpolate";
export { postJson, _postJsonDeps, type PostJsonDeps } from "./post-json";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/plugins/builtin/reporter-shared.test.ts --timeout=5000`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/plugins/builtin/reporter-shared test/unit/plugins/builtin/reporter-shared.test.ts
git commit -m "feat(reporter): shared env-interpolation and bounded POST helpers"
```

---

## Task 3: webhook-reporter plugin

**Files:**
- Create: `src/plugins/builtin/webhook-reporter/index.ts`
- Test: `test/unit/plugins/builtin/webhook-reporter.test.ts`

**Interfaces:**
- Consumes: `interpolateHeaders`, `postJson`, `PostJsonDeps` (Task 2); `WebhookReporterConfig` (Task 1); `NaxPlugin`, `IReporter` from `src/plugins` types.
- Produces: `createWebhookReporterPlugin(cfg: WebhookReporterConfig, deps?: PostJsonDeps): NaxPlugin`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugins/builtin/webhook-reporter.test.ts
import { describe, expect, test } from "bun:test";
import { createWebhookReporterPlugin } from "../../../../src/plugins/builtin/webhook-reporter";
import type { PostJsonDeps } from "../../../../src/plugins/builtin/reporter-shared";
import type { WebhookReporterConfig } from "../../../../src/config/schemas-reporters";

const baseCfg: WebhookReporterConfig = {
  enabled: true,
  url: "https://hook.example.com",
  headers: { "X-Token": "${WH_TOKEN}" },
  timeoutMs: 1000,
};

function capturing() {
  const calls: Array<{ url: string; body: any; headers: Headers }> = [];
  const deps: PostJsonDeps = {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(null, { status: 200 });
    },
  };
  return { calls, deps };
}

describe("webhook-reporter", () => {
  test("declares the reporter extension point", () => {
    const plugin = createWebhookReporterPlugin(baseCfg);
    expect(plugin.name).toBe("webhook-reporter");
    expect(plugin.provides).toContain("reporter");
    expect(plugin.extensions.reporter?.name).toBe("webhook-reporter");
  });

  test("POSTs an envelope with type, emittedAt, and data on onRunStart", async () => {
    const { calls, deps } = capturing();
    process.env.WH_TOKEN = "secret";
    const plugin = createWebhookReporterPlugin(baseCfg, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1", feature: "f", totalStories: 3, startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hook.example.com");
    expect(calls[0].body.type).toBe("onRunStart");
    expect(typeof calls[0].body.emittedAt).toBe("string");
    expect(calls[0].body.data.feature).toBe("f");
    expect(calls[0].headers.get("x-token")).toBe("secret");
    delete process.env.WH_TOKEN;
  });

  test("respects the events filter — filtered event does not POST", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ ...baseCfg, headers: {}, events: ["onRunEnd"] }, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1", feature: "f", totalStories: 1, startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(0);
    await plugin.extensions.reporter?.onRunEnd?.({
      runId: "r1", totalDurationMs: 10, totalCost: 0,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe("onRunEnd");
  });

  test("skips POST when a required env var is missing", async () => {
    const { calls, deps } = capturing();
    delete process.env.WH_TOKEN;
    const plugin = createWebhookReporterPlugin(baseCfg, deps);
    await plugin.extensions.reporter?.onRunStart?.({
      runId: "r1", feature: "f", totalStories: 1, startTime: "2026-07-18T00:00:00.000Z",
    });
    expect(calls).toHaveLength(0);
  });

  test("does nothing when url is unset", async () => {
    const { calls, deps } = capturing();
    const plugin = createWebhookReporterPlugin({ enabled: true, headers: {}, timeoutMs: 1000 }, deps);
    await plugin.extensions.reporter?.onStoryComplete?.({
      runId: "r1", storyId: "s1", status: "completed", runElapsedMs: 5, cost: 0.1, tier: "fast", testStrategy: "tdd-simple",
    });
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/builtin/webhook-reporter.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the plugin**

```typescript
// src/plugins/builtin/webhook-reporter/index.ts
import type { WebhookReporterConfig, ReporterEvent } from "../../../config/schemas-reporters";
import { getSafeLogger } from "../../../logger";
import type { IReporter, NaxPlugin } from "../../types";
import { interpolateHeaders, postJson, type PostJsonDeps } from "../reporter-shared";

const STAGE = "webhook-reporter";

/**
 * Built-in reporter that POSTs a JSON envelope per run/story event to a
 * configured webhook URL. Stateless and fire-and-forget.
 *
 * @param cfg  - resolved webhook reporter config (closed over by the reporter)
 * @param deps - injectable fetch deps (tests only)
 */
export function createWebhookReporterPlugin(
  cfg: WebhookReporterConfig,
  deps?: PostJsonDeps,
): NaxPlugin {
  const enabledEvent = (event: ReporterEvent): boolean =>
    cfg.events === undefined || cfg.events.includes(event);

  const emit = async (type: ReporterEvent, data: unknown): Promise<void> => {
    if (!cfg.url || !enabledEvent(type)) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping webhook — unresolved env vars", { missing });
      return;
    }
    await postJson(
      cfg.url,
      { type, emittedAt: new Date().toISOString(), data },
      { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps },
    );
  };

  const reporter: IReporter = {
    name: STAGE,
    onRunStart: (event) => emit("onRunStart", event),
    onStoryComplete: (event) => emit("onStoryComplete", event),
    onRunEnd: (event) => emit("onRunEnd", event),
  };

  return {
    name: STAGE,
    version: "1.0.0",
    provides: ["reporter"],
    extensions: { reporter },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/plugins/builtin/webhook-reporter.test.ts --timeout=5000`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/builtin/webhook-reporter test/unit/plugins/builtin/webhook-reporter.test.ts
git commit -m "feat(reporter): built-in webhook-reporter plugin"
```

---

## Task 4: OTLP builders + id generation

**Files:**
- Create: `src/plugins/builtin/otel-reporter/ids.ts`
- Create: `src/plugins/builtin/otel-reporter/otlp.ts`
- Test: `test/unit/plugins/builtin/otel-otlp.test.ts`

**Interfaces:**
- Produces:
  - `newTraceId(): string` (32 hex chars), `newSpanId(): string` (16 hex chars)
  - `msToUnixNano(ms: number): string`
  - `attr(key: string, value: string | number): KeyValue`
  - `interface SpanEvent { timeUnixNano: string; name: string; attributes: KeyValue[] }`
  - `interface KeyValue { key: string; value: { stringValue?: string; doubleValue?: number } }`
  - `buildTracesPayload(p: TracesInput): object` and `buildMetricsPayload(p: MetricsInput): object`
  - `interface TracesInput { serviceName; traceId; spanId; startUnixNano: string; endUnixNano: string; feature; runId; storySummary; totalCost; events: SpanEvent[] }`
  - `interface MetricsInput { serviceName; runId; timeUnixNano: string; storySummary; totalCost; totalDurationMs }`
  - `type StorySummary = { completed: number; failed: number; skipped: number; paused: number }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugins/builtin/otel-otlp.test.ts
import { describe, expect, test } from "bun:test";
import { newSpanId, newTraceId } from "../../../../src/plugins/builtin/otel-reporter/ids";
import {
  attr,
  buildMetricsPayload,
  buildTracesPayload,
  msToUnixNano,
  type SpanEvent,
} from "../../../../src/plugins/builtin/otel-reporter/otlp";

describe("ids", () => {
  test("newTraceId is 32 lowercase hex chars", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
  test("newSpanId is 16 lowercase hex chars", () => {
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("msToUnixNano", () => {
  test("converts milliseconds to nanosecond string", () => {
    expect(msToUnixNano(1500)).toBe("1500000000");
  });
});

describe("attr", () => {
  test("maps strings to stringValue and numbers to doubleValue", () => {
    expect(attr("k", "v")).toEqual({ key: "k", value: { stringValue: "v" } });
    expect(attr("n", 3.5)).toEqual({ key: "n", value: { doubleValue: 3.5 } });
  });
});

const summary = { completed: 2, failed: 1, skipped: 0, paused: 0 };
const events: SpanEvent[] = [
  { timeUnixNano: "1000000", name: "story.complete", attributes: [attr("storyId", "s1")] },
];

describe("buildTracesPayload", () => {
  const payload: any = buildTracesPayload({
    serviceName: "nax", traceId: "a".repeat(32), spanId: "b".repeat(16),
    startUnixNano: "1000", endUnixNano: "2000",
    feature: "feat", runId: "r1", storySummary: summary, totalCost: 0.42, events,
  });

  test("nests one resource span with service.name resource attr", () => {
    const rs = payload.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual(attr("service.name", "nax"));
  });

  test("root span carries ids, timing, run attrs, and buffered events", () => {
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("a".repeat(32));
    expect(span.spanId).toBe("b".repeat(16));
    expect(span.name).toBe("nax.run");
    expect(span.startTimeUnixNano).toBe("1000");
    expect(span.endTimeUnixNano).toBe("2000");
    expect(span.attributes).toContainEqual(attr("feature", "feat"));
    expect(span.attributes).toContainEqual(attr("runId", "r1"));
    expect(span.events).toEqual(events);
  });

  test("status code is ERROR (2) when any story failed", () => {
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status).toEqual({ code: 2 });
  });

  test("status code is OK (1) when nothing failed", () => {
    const ok: any = buildTracesPayload({
      serviceName: "nax", traceId: "a".repeat(32), spanId: "b".repeat(16),
      startUnixNano: "1000", endUnixNano: "2000",
      feature: "f", runId: "r", storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0, events: [],
    });
    expect(ok.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 1 });
  });
});

describe("buildMetricsPayload", () => {
  const payload: any = buildMetricsPayload({
    serviceName: "nax", runId: "r1", timeUnixNano: "2000",
    storySummary: summary, totalCost: 0.42, totalDurationMs: 1234,
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  const byName = (n: string) => metrics.find((m: any) => m.name === n);

  test("emits a stories.total counter with one data point per non-zero status", () => {
    const sum = byName("nax.stories.total").sum;
    expect(sum.isMonotonic).toBe(true);
    expect(sum.aggregationTemporality).toBe(2);
    const statuses = sum.dataPoints.map((d: any) => d.attributes[0].value.stringValue).sort();
    expect(statuses).toEqual(["completed", "failed"]);
    const completed = sum.dataPoints.find((d: any) => d.attributes[0].value.stringValue === "completed");
    expect(completed.asInt).toBe("2");
  });

  test("emits run.cost and run.duration_ms gauges", () => {
    expect(byName("nax.run.cost").gauge.dataPoints[0].asDouble).toBe(0.42);
    expect(byName("nax.run.duration_ms").gauge.dataPoints[0].asDouble).toBe(1234);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/builtin/otel-otlp.test.ts --timeout=5000`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `ids.ts`**

```typescript
// src/plugins/builtin/otel-reporter/ids.ts

/** Generate `bytes` random bytes as a lowercase hex string. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 16-byte (32 hex char) OTLP trace id. */
export const newTraceId = (): string => randomHex(16);

/** 8-byte (16 hex char) OTLP span id. */
export const newSpanId = (): string => randomHex(8);
```

- [ ] **Step 4: Implement `otlp.ts`**

```typescript
// src/plugins/builtin/otel-reporter/otlp.ts

/** OTLP/JSON attribute value (subset — string and double only). */
export interface KeyValue {
  key: string;
  value: { stringValue?: string; doubleValue?: number };
}

/** OTLP/JSON span event. */
export interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: KeyValue[];
}

export type StorySummary = {
  completed: number;
  failed: number;
  skipped: number;
  paused: number;
};

/** Build an OTLP attribute. Strings -> stringValue; numbers -> doubleValue. */
export function attr(key: string, value: string | number): KeyValue {
  return typeof value === "number"
    ? { key, value: { doubleValue: value } }
    : { key, value: { stringValue: value } };
}

/** Convert milliseconds to an OTLP nanosecond timestamp string. */
export function msToUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

export interface TracesInput {
  serviceName: string;
  traceId: string;
  spanId: string;
  startUnixNano: string;
  endUnixNano: string;
  feature: string;
  runId: string;
  storySummary: StorySummary;
  totalCost: number;
  events: SpanEvent[];
}

/** Build an OTLP/HTTP-JSON ResourceSpans payload with one root `nax.run` span. */
export function buildTracesPayload(p: TracesInput): object {
  const span = {
    traceId: p.traceId,
    spanId: p.spanId,
    name: "nax.run",
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: p.startUnixNano,
    endTimeUnixNano: p.endUnixNano,
    attributes: [
      attr("feature", p.feature),
      attr("runId", p.runId),
      attr("stories.completed", p.storySummary.completed),
      attr("stories.failed", p.storySummary.failed),
      attr("stories.skipped", p.storySummary.skipped),
      attr("stories.paused", p.storySummary.paused),
      attr("cost.total", p.totalCost),
    ],
    events: p.events,
    status: { code: p.storySummary.failed > 0 ? 2 : 1 }, // 2=ERROR, 1=OK
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", p.serviceName)] },
        scopeSpans: [{ scope: { name: "nax" }, spans: [span] }],
      },
    ],
  };
}

export interface MetricsInput {
  serviceName: string;
  runId: string;
  timeUnixNano: string;
  storySummary: StorySummary;
  totalCost: number;
  totalDurationMs: number;
}

/** Build an OTLP/HTTP-JSON ResourceMetrics payload (stories counter + gauges). */
export function buildMetricsPayload(p: MetricsInput): object {
  const statusEntries = Object.entries(p.storySummary).filter(([, n]) => n > 0);
  const storiesSum = {
    name: "nax.stories.total",
    sum: {
      aggregationTemporality: 2, // CUMULATIVE
      isMonotonic: true,
      dataPoints: statusEntries.map(([status, count]) => ({
        asInt: String(count),
        timeUnixNano: p.timeUnixNano,
        attributes: [attr("status", status)],
      })),
    },
  };
  const gauge = (name: string, value: number) => ({
    name,
    gauge: { dataPoints: [{ asDouble: value, timeUnixNano: p.timeUnixNano }] },
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr("service.name", p.serviceName)] },
        scopeMetrics: [
          {
            scope: { name: "nax" },
            metrics: [
              storiesSum,
              gauge("nax.run.cost", p.totalCost),
              gauge("nax.run.duration_ms", p.totalDurationMs),
            ],
          },
        ],
      },
    ],
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/plugins/builtin/otel-otlp.test.ts --timeout=5000`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/builtin/otel-reporter/ids.ts src/plugins/builtin/otel-reporter/otlp.ts test/unit/plugins/builtin/otel-otlp.test.ts
git commit -m "feat(reporter): OTLP/HTTP-JSON payload builders and id generation"
```

---

## Task 5: otel-reporter plugin (stateful factory)

**Files:**
- Create: `src/plugins/builtin/otel-reporter/index.ts`
- Test: `test/unit/plugins/builtin/otel-reporter.test.ts`

**Interfaces:**
- Consumes: `newTraceId`, `newSpanId`, `msToUnixNano`, `attr`, `buildTracesPayload`, `buildMetricsPayload`, `SpanEvent` (Task 4); `interpolateHeaders`, `postJson`, `PostJsonDeps` (Task 2); `OtelReporterConfig` (Task 1); `NaxPlugin`, `IReporter`.
- Produces: `createOtelReporterPlugin(cfg: OtelReporterConfig, deps?: PostJsonDeps): NaxPlugin`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugins/builtin/otel-reporter.test.ts
import { describe, expect, test } from "bun:test";
import { createOtelReporterPlugin } from "../../../../src/plugins/builtin/otel-reporter";
import type { PostJsonDeps } from "../../../../src/plugins/builtin/reporter-shared";
import type { OtelReporterConfig } from "../../../../src/config/schemas-reporters";

const cfg: OtelReporterConfig = {
  enabled: true,
  endpoint: "https://otlp.example.com/",
  headers: {},
  serviceName: "nax",
  timeoutMs: 1000,
};

function capturing() {
  const posts: Array<{ url: string; body: any }> = [];
  const deps: PostJsonDeps = {
    fetch: async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    },
  };
  return { posts, deps };
}

async function runOnce(plugin: ReturnType<typeof createOtelReporterPlugin>) {
  const r = plugin.extensions.reporter!;
  await r.onRunStart?.({ runId: "r1", feature: "f", totalStories: 2, startTime: "2026-07-18T00:00:00.000Z" });
  await r.onStoryComplete?.({ runId: "r1", storyId: "s1", status: "completed", runElapsedMs: 100, cost: 0.1, tier: "fast", testStrategy: "tdd-simple" });
  await r.onStoryComplete?.({ runId: "r1", storyId: "s2", status: "failed", runElapsedMs: 200, cost: 0.2, tier: "balanced", testStrategy: "tdd-simple" });
  await r.onRunEnd?.({ runId: "r1", totalDurationMs: 300, totalCost: 0.3, storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 } });
}

describe("otel-reporter", () => {
  test("declares the reporter extension point", () => {
    const plugin = createOtelReporterPlugin(cfg);
    expect(plugin.name).toBe("otel-reporter");
    expect(plugin.provides).toContain("reporter");
  });

  test("POSTs traces then metrics to the normalized endpoints at run end", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(cfg, deps));
    expect(posts.map((p) => p.url)).toEqual([
      "https://otlp.example.com/v1/traces",
      "https://otlp.example.com/v1/metrics",
    ]);
  });

  test("buffers story completions as span events on the root span", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(cfg, deps));
    const span = posts[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("story.complete");
    // startMs(0) + runElapsedMs(100) -> 100ms -> 100_000_000 ns
    expect(span.events[0].timeUnixNano).toBe("100000000");
    expect(span.status.code).toBe(2); // one failed
  });

  test("emits no story events before onRunStart is dropped (no state)", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
    // onStoryComplete with no prior onRunStart is a no-op, not a throw
    await r.onStoryComplete?.({ runId: "x", storyId: "s", status: "completed", runElapsedMs: 5, cost: 0, tier: "fast", testStrategy: "tdd-simple" });
    expect(posts).toHaveLength(0);
  });

  test("onRunEnd without a prior onRunStart still flushes a best-effort span", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
    await r.onRunEnd?.({ runId: "orphan", totalDurationMs: 300, totalCost: 0.3, storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 } });
    expect(posts).toHaveLength(2);
    const span = posts[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events).toEqual([]);
    expect(span.status.code).toBe(1);
  });

  test("deletes run state after onRunEnd (second onRunEnd is inert best-effort)", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(cfg, deps);
    await runOnce(plugin);
    const afterFirst = posts.length;
    // A stray late story event for the same run must not append to a live buffer.
    await plugin.extensions.reporter?.onStoryComplete?.({ runId: "r1", storyId: "s3", status: "completed", runElapsedMs: 400, cost: 0, tier: "fast", testStrategy: "tdd-simple" });
    expect(posts.length).toBe(afterFirst); // no new POST; state gone
  });

  test("skips both POSTs when a required env var is missing", async () => {
    const { posts, deps } = capturing();
    delete process.env.OTLP_TOKEN;
    const plugin = createOtelReporterPlugin({ ...cfg, headers: { Authorization: "Bearer ${OTLP_TOKEN}" } }, deps);
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });

  test("does nothing when endpoint is unset", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ enabled: true, headers: {}, serviceName: "nax", timeoutMs: 1000 }, deps);
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/builtin/otel-reporter.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the plugin**

```typescript
// src/plugins/builtin/otel-reporter/index.ts
import type { OtelReporterConfig } from "../../../config/schemas-reporters";
import { getSafeLogger } from "../../../logger";
import type { IReporter, NaxPlugin } from "../../types";
import { interpolateHeaders, postJson, type PostJsonDeps } from "../reporter-shared";
import { newSpanId, newTraceId } from "./ids";
import { attr, buildMetricsPayload, buildTracesPayload, msToUnixNano, type SpanEvent } from "./otlp";

const STAGE = "otel-reporter";

interface RunState {
  traceId: string;
  spanId: string;
  startMs: number;
  events: SpanEvent[];
}

/**
 * Built-in reporter that emits OTLP/HTTP-JSON traces + metrics per run.
 * Buffers each run's story completions as span events and flushes one traces
 * POST + one metrics POST at run end. Fire-and-forget.
 *
 * @param cfg  - resolved OTel reporter config (closed over by the reporter)
 * @param deps - injectable fetch deps (tests only)
 */
export function createOtelReporterPlugin(
  cfg: OtelReporterConfig,
  deps?: PostJsonDeps,
): NaxPlugin {
  const states = new Map<string, RunState>();
  const base = cfg.endpoint?.replace(/\/$/, "");

  const flush = async (
    st: RunState,
    endMs: number,
    e: { runId: string; totalDurationMs: number; totalCost: number; storySummary: RunEndSummary },
  ): Promise<void> => {
    if (!base) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
      return;
    }
    const startUnixNano = msToUnixNano(st.startMs);
    const endUnixNano = msToUnixNano(endMs);
    const traces = buildTracesPayload({
      serviceName: cfg.serviceName,
      traceId: st.traceId,
      spanId: st.spanId,
      startUnixNano,
      endUnixNano,
      feature: "",
      runId: e.runId,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      events: st.events,
    });
    const metrics = buildMetricsPayload({
      serviceName: cfg.serviceName,
      runId: e.runId,
      timeUnixNano: endUnixNano,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      totalDurationMs: e.totalDurationMs,
    });
    const opts = { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps };
    await postJson(`${base}/v1/traces`, traces, opts);
    await postJson(`${base}/v1/metrics`, metrics, opts);
  };

  const reporter: IReporter = {
    name: STAGE,
    async onRunStart(event) {
      states.set(event.runId, {
        traceId: newTraceId(),
        spanId: newSpanId(),
        startMs: Date.parse(event.startTime),
        events: [],
      });
    },
    async onStoryComplete(event) {
      const st = states.get(event.runId);
      if (!st) return;
      st.events.push({
        timeUnixNano: msToUnixNano(st.startMs + event.runElapsedMs),
        name: "story.complete",
        attributes: [
          attr("storyId", event.storyId),
          attr("status", event.status),
          attr("cost", event.cost),
          attr("tier", event.tier),
          attr("testStrategy", event.testStrategy),
        ],
      });
    },
    async onRunEnd(event) {
      // Normal path: state exists. Early-abort path: synthesize a best-effort
      // span whose start is back-computed from the reported duration.
      const existing = states.get(event.runId);
      const startMs = existing?.startMs ?? Date.now() - event.totalDurationMs;
      const st: RunState = existing ?? {
        traceId: newTraceId(),
        spanId: newSpanId(),
        startMs,
        events: [],
      };
      states.delete(event.runId);
      await flush(st, startMs + event.totalDurationMs, event);
    },
  };

  return {
    name: STAGE,
    version: "1.0.0",
    provides: ["reporter"],
    extensions: { reporter },
  };
}

type RunEndSummary = { completed: number; failed: number; skipped: number; paused: number };
```

Note: `feature` is not present on `RunEndEvent`, so the root-span `feature` attribute is emitted as an empty string. If a later change threads feature through, populate it from the buffered state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/plugins/builtin/otel-reporter.test.ts --timeout=5000`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/builtin/otel-reporter/index.ts test/unit/plugins/builtin/otel-reporter.test.ts
git commit -m "feat(reporter): built-in otel-reporter plugin (OTLP traces + metrics)"
```

---

## Task 6: Loader integration + config example doc

**Files:**
- Modify: `src/plugins/loader.ts` (add `reporters` param; register builtins in section 0)
- Modify: `src/execution/lifecycle/run-setup.ts` (pass `config.reporters` into `loadPlugins`)
- Test: `test/unit/plugins/loader-reporters.test.ts`

**Interfaces:**
- Consumes: `createWebhookReporterPlugin` (Task 3), `createOtelReporterPlugin` (Task 5), `ReportersConfig` (Task 1).
- Produces: `loadPlugins(..., reporters?: ReportersConfig)` — registers each reporter as a full plugin (`loadedPlugins`) only when its `enabled === true` and its name is not in `disabledPlugins`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugins/loader-reporters.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { loadPlugins } from "../../../src/plugins/loader";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

describe("loadPlugins — built-in reporters", () => {
  let dir = "";
  afterEach(async () => { if (dir) await cleanupTempDir(dir); dir = ""; });

  const enabled = {
    webhook: { enabled: true, url: "https://h/x", headers: {}, timeoutMs: 5000 },
    otel: { enabled: false, headers: {}, serviceName: "nax", timeoutMs: 5000 },
  } as const;

  test("registers webhook-reporter when enabled, exposed via getReporters()", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, [], undefined, enabled);
    const names = reg.getReporters().map((r) => r.name);
    expect(names).toContain("webhook-reporter");
    expect(names).not.toContain("otel-reporter");
  });

  test("does not register a reporter that is disabled in config", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, [], undefined, {
      webhook: { enabled: false, headers: {}, timeoutMs: 5000 },
      otel: { enabled: false, headers: {}, serviceName: "nax", timeoutMs: 5000 },
    });
    expect(reg.getReporters()).toHaveLength(0);
  });

  test("disabledPlugins overrides enabled config", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, ["webhook-reporter"], undefined, enabled);
    expect(reg.getReporters().map((r) => r.name)).not.toContain("webhook-reporter");
  });

  test("registers nothing when reporters arg is omitted", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, []);
    expect(reg.getReporters()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/loader-reporters.test.ts --timeout=5000`
Expected: FAIL — `loadPlugins` has no 7th param; reporters not registered.

- [ ] **Step 3: Add the `reporters` param to `loadPlugins`**

In `src/plugins/loader.ts`, add the imports near the other builtin imports (lines 15-17):

```typescript
import { createWebhookReporterPlugin } from "./builtin/webhook-reporter";
import { createOtelReporterPlugin } from "./builtin/otel-reporter";
import type { ReportersConfig } from "../config/schemas-reporters";
```

Extend the signature (after `isTestFileFn`):

```typescript
export async function loadPlugins(
  globalDir: string,
  projectDir: string,
  configPlugins: PluginConfigEntry[],
  projectRoot?: string,
  disabledPlugins?: string[],
  isTestFileFn?: (filename: string) => boolean,
  reporters?: ReportersConfig,
): Promise<PluginRegistry> {
```

- [ ] **Step 4: Register the reporters in section 0**

In `src/plugins/loader.ts`, at the end of the "0. Load built-in plugins" block (after the `autoRoutePlugin` registration, before "1. Load plugins from global directory"), add:

```typescript
  // Built-in reporters — opt-in via config.reporters.<name>.enabled. Registered
  // as full reporter-providing plugins (surface through getReporters()), not
  // side-channel actions. `disabledPlugins` still wins.
  const reporterFactories: Array<{ name: string; enabled: boolean; make: () => import("./types").NaxPlugin }> = [
    { name: "webhook-reporter", enabled: reporters?.webhook.enabled ?? false, make: () => createWebhookReporterPlugin(reporters!.webhook) },
    { name: "otel-reporter", enabled: reporters?.otel.enabled ?? false, make: () => createOtelReporterPlugin(reporters!.otel) },
  ];
  for (const { name, enabled, make } of reporterFactories) {
    if (!enabled) continue;
    if (disabledSet.has(name)) {
      logger?.info("plugins", `Skipping disabled plugin: '${name}' (built-in)`);
      continue;
    }
    const plugin = make();
    if (plugin.setup) {
      await plugin.setup({}, createPluginLogger(plugin.name));
    }
    loadedPlugins.push({ plugin, source: { type: "builtin", path: plugin.name } });
    pluginNames.add(plugin.name);
  }
```

- [ ] **Step 5: Thread config into the run-setup call**

In `src/execution/lifecycle/run-setup.ts`, extend the `loadPlugins(...)` call (around line 413) to pass `config.reporters` as the 7th argument:

```typescript
    const pluginRegistry = await loadPlugins(
      globalPluginsDir,
      projectPluginsDir,
      configPlugins,
      workdir,
      config.disabledPlugins,
      isTestFileFn,
      config.reporters,
    );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/plugins/loader-reporters.test.ts --timeout=5000`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full plugins + config suites for regressions**

Run: `timeout 60 bun test test/unit/plugins test/unit/config --timeout=10000`
Expected: PASS — existing loader/registry tests unaffected (7th param is optional).

- [ ] **Step 8: Document the config in the plugins doc**

Locate the config-reference doc that documents `autoPr` (run `grep -rl "autoPr" docs/`) and add a `reporters` subsection there, using the example from the design doc's "Config surface" section (both plugins, `${ENV}` headers, `events` filter, `timeoutMs`). Also locate the plugin-extension doc that documents `IReporter` (run `grep -rl "IReporter" docs/`) and add a one-line note that `webhook-reporter` and `otel-reporter` are now shipped built-ins. If neither doc exists, skip this step — the design doc already carries the reference.

- [ ] **Step 9: Commit**

```bash
git add src/plugins/loader.ts src/execution/lifecycle/run-setup.ts test/unit/plugins/loader-reporters.test.ts docs/
git commit -m "feat(reporter): register built-in reporters via config.reporters"
```

---

## Task 7: Full-suite gate

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint (includes file-size + import checks)**

Run: `bun run lint`
Expected: clean. If `check:file-sizes` flags a new file, split it by concern.

- [ ] **Step 3: Full test suite**

Run: `bun run test`
Expected: PASS, no regressions.

- [ ] **Step 4: Final commit (only if lint/format changed files)**

```bash
git add -A
git commit -m "chore(reporter): lint and format pass"
```

---

## Self-Review

**Spec coverage:**
- Two separate opt-in plugins → Tasks 3 (webhook), 5 (otel); registration Task 6. ✓
- Config surface (`reporters` block, defaults, `${ENV}`, timeouts, events filter) → Task 1. ✓
- Shared helpers (`interpolateHeaders`, `postJson` with `_deps`, redaction, bounded timeout) → Task 2. ✓
- OTLP/HTTP-JSON via fetch, root span + span-events + metrics → Tasks 4, 5. ✓
- Event delivery guarantees + early-abort (`onRunEnd` without `onRunStart`) edge case → Task 5 Step 1 (test) + Step 3 (impl). ✓
- Integration seam (thread `reporters` into `loadPlugins`, register when enabled, `disabledPlugins` wins) → Task 6. ✓
- Error handling (fire-and-forget, never throw, no secret logging) → Tasks 2, 3, 5. ✓
- Testing matrix (interpolate, postJson, webhook, otel golden + buffering + cleanup + missing-env, loader) → Tasks 2-6. ✓
- Out-of-scope items (batching, retry, OTel logs, histograms, synthetic child spans, plugins CLI) → not implemented. ✓

**Placeholder scan:** No TBD/TODO. Task 6 Step 8 gives a concrete `grep` to locate the doc target rather than a vague "update docs". All code steps show full code.

**Type consistency:** `createWebhookReporterPlugin(cfg, deps?)` / `createOtelReporterPlugin(cfg, deps?)` consistent across Tasks 3, 5, 6. `postJson(url, body, { headers, timeoutMs, stage, deps })` consistent Tasks 2, 3, 5. `attr` / `msToUnixNano` / `SpanEvent` consistent Tasks 4, 5. `ReportersConfig` shape consistent Tasks 1, 6. `loadPlugins` 7-arg signature consistent Task 6 Steps 3-5.
