# M3 Recorded Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scripted protocol tests with a suite that replays real recorded provider streams through the mapper, covering all four protocols and one error path.

**Architecture:** Fixtures capture the **input** side of the mapper — pi's `AssistantMessageEvent` stream plus the observed HTTP response — at the existing `PiDeps` seam. A replay harness stubs `deps.stream` to yield a fixture's events and feeds them through `createPiProtocol`, asserting the `ProtocolEvent`s that come out. Recording happens in the opt-in live suite; replay runs in the default suite with no network.

**Tech Stack:** TypeScript 7 strict (`exactOptionalPropertyTypes`, `nodenext`), Vitest, `@earendil-works/pi-ai` 0.84.4.

**Spec:** [`../specs/2026-08-31-nax-ai-m3-recorded-fixtures-design.md`](../specs/2026-08-31-nax-ai-m3-recorded-fixtures-design.md)

## Global Constraints

- No change to `src/`. M3 is evidence, not behaviour. If a fixture reveals a mapping bug, stop and report it — do not fix `src/` inside this plan.
- No emojis in code, comments, or documentation.
- Imports carry explicit `.ts` extensions (`nodenext`).
- `exactOptionalPropertyTypes` is on: build optional properties conditionally (`...(x !== undefined ? { x } : {})`), never assign `undefined`.
- Tests must not import pi-ai *types* into `src/`; test files may import pi-ai freely (the gate scans `src/` only).
- Recorded response headers are filtered to the allowlist `retry-after`, `content-type`, `x-request-id`. Never commit any other header.
- Gates that must pass before every commit: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
- Live recording (Task 4) needs credentials and spends money. It is operator-run, not agent-run.

---

### Task 1: Fixture format and loader

**Files:**
- Create: `test/support/fixture-types.ts`
- Create: `test/support/load-fixture.ts`
- Create: `test/fixtures/recorded/example-text.json` (hand-written, proves the loader before any live recording)
- Test: `test/support/load-fixture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RecordedFixture`, `RecordedMeta`, `loadFixture(name: string): RecordedFixture`, `fixtureNames(): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { fixtureNames, loadFixture } from "./load-fixture.ts";

describe("loadFixture", () => {
  it("reads a fixture's meta, response and events", () => {
    const f = loadFixture("example-text");
    expect(f.meta.protocol).toBe("openai-completions");
    expect(f.response.status).toBe(200);
    expect(f.events.length).toBeGreaterThan(0);
  });

  it("rejects a fixture carrying a header outside the allowlist", () => {
    expect(() => loadFixture("example-bad-header")).toThrow(/allowlist/);
  });

  it("lists every recorded fixture by name", () => {
    expect(fixtureNames()).toContain("example-text");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun x vitest --run test/support/load-fixture.test.ts`
Expected: FAIL — cannot find module `./load-fixture.ts`.

- [ ] **Step 3: Write the types**

```ts
// test/support/fixture-types.ts
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PiResponse } from "../../src/protocols/pi-client.ts";

/** Only these reach a committed fixture. `retry-after` is the one the mapper
 *  reads; the rest are provenance. Anything else is dropped rather than
 *  trusted to be harmless in a public repository. */
export const HEADER_ALLOWLIST = ["retry-after", "content-type", "x-request-id"] as const;

export interface RecordedMeta {
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly api: string;
  readonly recordedAt: string;
  /** What this fixture is evidence of, and what it is NOT. */
  readonly note: string;
}

export interface RecordedFixture {
  readonly meta: RecordedMeta;
  readonly response: PiResponse;
  readonly events: readonly AssistantMessageEvent[];
}
```

- [ ] **Step 4: Write the loader**

```ts
// test/support/load-fixture.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER_ALLOWLIST, type RecordedFixture } from "./fixture-types.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "recorded");

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadFixture(name: string): RecordedFixture {
  const parsed = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as RecordedFixture;
  const allowed = new Set<string>(HEADER_ALLOWLIST);
  for (const key of Object.keys(parsed.response.headers)) {
    if (!allowed.has(key.toLowerCase())) {
      throw new Error(`Fixture "${name}" carries header "${key}" outside the allowlist.`);
    }
  }
  return parsed;
}
```

- [ ] **Step 5: Write the two fixture files**

`test/fixtures/recorded/example-text.json` — a minimal hand-written fixture. Mark it clearly as synthetic so nobody mistakes it for evidence:

```json
{
  "meta": {
    "provider": "example",
    "protocol": "openai-completions",
    "model": "example-model",
    "api": "openai-completions",
    "recordedAt": "2026-08-31",
    "note": "SYNTHETIC. Hand-written to exercise the loader and replay harness. Not evidence of any provider's behaviour."
  },
  "response": { "status": 200, "headers": { "content-type": "text/event-stream" } },
  "events": [
    { "type": "text_start", "contentIndex": 0, "partial": { "role": "assistant", "content": [], "api": "openai-completions", "provider": "example", "model": "example-model", "usage": { "input": 3, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "stopReason": "stop", "timestamp": 0 } },
    { "type": "text_delta", "contentIndex": 0, "delta": "ok", "partial": { "role": "assistant", "content": [{ "type": "text", "text": "ok" }], "api": "openai-completions", "provider": "example", "model": "example-model", "usage": { "input": 3, "output": 1, "cacheRead": 0, "cacheWrite": 0 }, "stopReason": "stop", "timestamp": 0 } },
    { "type": "done", "reason": "stop", "message": { "role": "assistant", "content": [{ "type": "text", "text": "ok" }], "api": "openai-completions", "provider": "example", "model": "example-model", "usage": { "input": 3, "output": 1, "cacheRead": 0, "cacheWrite": 0 }, "stopReason": "stop", "timestamp": 0 } }
  ]
}
```

`test/fixtures/recorded/example-bad-header.json` — identical except `"headers": { "set-cookie": "session=abc" }`. This exists to prove the allowlist rejects, and is the one fixture the replay suite must skip.

- [ ] **Step 6: Run the tests**

Run: `bun x vitest --run test/support/load-fixture.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/support/fixture-types.ts test/support/load-fixture.ts test/support/load-fixture.test.ts test/fixtures/recorded/example-text.json test/fixtures/recorded/example-bad-header.json
git commit -m "test: fixture format and loader with a header allowlist"
```

---

### Task 2: Replay harness

**Files:**
- Create: `test/support/replay.ts`
- Test: `test/support/replay.test.ts`

**Interfaces:**
- Consumes: `RecordedFixture`, `loadFixture` from Task 1.
- Produces: `protocolFromFixture(fixture: RecordedFixture): Protocol` and `drainFixture(fixture: RecordedFixture, req?: Partial<ProtocolRequest>): Promise<ProtocolEvent[]>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadFixture } from "./load-fixture.ts";
import { drainFixture, protocolFromFixture } from "./replay.ts";

describe("replay harness", () => {
  it("maps a recorded stream to protocol events", async () => {
    const events = await drainFixture(loadFixture("example-text"));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "usage", "done"]);
  });

  it("yields a fresh stream on every call, so one fixture drives many assertions", async () => {
    const f = loadFixture("example-text");
    const a = await drainFixture(f);
    const b = await drainFixture(f);
    expect(a).toEqual(b);
  });

  it("names the protocol from the fixture", () => {
    expect(protocolFromFixture(loadFixture("example-text")).name).toBe("openai-completions");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun x vitest --run test/support/replay.test.ts`
Expected: FAIL — cannot find module `./replay.ts`.

- [ ] **Step 3: Write the harness**

```ts
// test/support/replay.ts
import type { Api, Model } from "@earendil-works/pi-ai";
import { createPiProtocol, type PiDeps } from "../../src/protocols/pi-client.ts";
import type { Protocol, ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import type { RecordedFixture } from "./fixture-types.ts";

/** The mapper reads only id, provider and api off the model, so a fixture's
 *  meta is enough — resolving a real catalog entry would put the network back
 *  into a test whose whole point is not having one. */
function stubModel(fixture: RecordedFixture): Model<Api> {
  return {
    id: fixture.meta.model,
    provider: fixture.meta.provider,
    api: fixture.meta.api,
  } as unknown as Model<Api>;
}

function depsFor(fixture: RecordedFixture): PiDeps {
  return {
    resolveModel: async () => stubModel(fixture),
    // A new generator per call: runProtocolConformance drains the same
    // protocol repeatedly, and a single consumed iterable would leave every
    // test after the first asserting on an empty stream.
    stream: (_model, _context, _options, onResponse) =>
      (async function* () {
        onResponse(fixture.response);
        for (const event of fixture.events) yield event;
      })(),
  };
}

export function protocolFromFixture(fixture: RecordedFixture): Protocol {
  return createPiProtocol(fixture.meta.protocol, depsFor(fixture));
}

export async function drainFixture(
  fixture: RecordedFixture,
  req: Partial<ProtocolRequest> = {},
): Promise<ProtocolEvent[]> {
  const request: ProtocolRequest = {
    model: fixture.meta.model,
    provider: fixture.meta.provider,
    messages: [{ role: "user", content: "replay" }],
    ...req,
  };
  const events: ProtocolEvent[] = [];
  for await (const event of protocolFromFixture(fixture).stream(request)) events.push(event);
  return events;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun x vitest --run test/support/replay.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/support/replay.ts test/support/replay.test.ts
git commit -m "test: replay recorded pi streams through the protocol mapper"
```

---

### Task 3: Recording deps wrapper

**Files:**
- Modify: `test/live/support/record.ts` (replace its contents entirely)
- Test: `test/live/support/record.test.ts` — a unit test with a fake inner `PiDeps`, so it runs in the DEFAULT suite with no network

**Interfaces:**
- Consumes: `HEADER_ALLOWLIST`, `RecordedFixture` from Task 1.
- Produces: `recordingDeps(inner: PiDeps, meta: Omit<RecordedMeta, "recordedAt">): { deps: PiDeps; write: (name: string) => void }`.

Note the filename: `record.test.ts`, not `record.live.test.ts`, so the default suite covers the recorder itself. The recorder is the one piece whose bugs would silently corrupt every fixture.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PiDeps } from "../../../src/protocols/pi-client.ts";
import { recordingDeps } from "./record.ts";

const META = { provider: "p", protocol: "openai-completions", model: "m", api: "openai-completions", note: "test" };

function fakeInner(events: unknown[], headers: Record<string, string>): PiDeps {
  return {
    resolveModel: async () => ({ id: "m", provider: "p", api: "openai-completions" }) as never,
    stream: (_m, _c, _o, onResponse) =>
      (async function* () {
        onResponse({ status: 200, headers });
        for (const e of events) yield e as never;
      })(),
  };
}

describe("recordingDeps", () => {
  it("captures the events and response that passed through", async () => {
    const rec = recordingDeps(fakeInner([{ type: "done" }], { "content-type": "text/event-stream" }), META);
    for await (const _ of rec.deps.stream({} as never, {} as never, {}, () => {})) {
      // drain
    }
    rec.write("unit-probe");
    const path = join(import.meta.dirname, "..", "..", "fixtures", "recorded", "unit-probe.json");
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.events).toEqual([{ type: "done" }]);
    expect(f.response.status).toBe(200);
    expect(f.meta.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    rmSync(path);
  });

  it("drops headers outside the allowlist before they can be committed", async () => {
    const rec = recordingDeps(
      fakeInner([{ type: "done" }], { "set-cookie": "s=1", "retry-after": "30" }),
      META,
    );
    for await (const _ of rec.deps.stream({} as never, {} as never, {}, () => {})) {
      // drain
    }
    rec.write("unit-headers");
    const path = join(import.meta.dirname, "..", "..", "fixtures", "recorded", "unit-headers.json");
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.response.headers).toEqual({ "retry-after": "30" });
    rmSync(path);
  });

  it("still forwards the response to the caller's onResponse", async () => {
    let seen: unknown;
    const rec = recordingDeps(fakeInner([], { "content-type": "x" }), META);
    for await (const _ of rec.deps.stream({} as never, {} as never, {}, (r) => { seen = r; })) {
      // drain
    }
    expect(seen).toEqual({ status: 200, headers: { "content-type": "x" } });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun x vitest --run test/live/support/record.test.ts`
Expected: FAIL — `recordingDeps` is not exported.

- [ ] **Step 3: Replace the recorder**

```ts
// test/live/support/record.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PiDeps, PiResponse } from "../../../src/protocols/pi-client.ts";
import { HEADER_ALLOWLIST, type RecordedMeta } from "../../support/fixture-types.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "recorded");

function filterHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = new Set<string>(HEADER_ALLOWLIST);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => allowed.has(k.toLowerCase())));
}

/**
 * Wraps PiDeps to capture what pi actually sent, at the seam the mapper reads
 * from. Recording the mapper's OUTPUT instead — which is what M2 did — cannot
 * catch a mapping regression: a wrong mapping would simply be re-recorded as
 * the new expectation.
 */
export function recordingDeps(
  inner: PiDeps,
  meta: Omit<RecordedMeta, "recordedAt">,
): { deps: PiDeps; write: (name: string) => void } {
  const events: AssistantMessageEvent[] = [];
  let response: PiResponse = { status: 0, headers: {} };

  const deps: PiDeps = {
    resolveModel: inner.resolveModel,
    stream: (model, context, options, onResponse) =>
      (async function* () {
        for await (const event of inner.stream(model, context, options, (r) => {
          response = { status: r.status, headers: filterHeaders(r.headers) };
          onResponse(r);
        })) {
          events.push(event);
          yield event;
        }
      })(),
  };

  const write = (name: string): void => {
    const file = join(DIR, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    const body = {
      meta: { ...meta, recordedAt: new Date().toISOString().slice(0, 10) },
      response,
      events,
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  };

  return { deps, write };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun x vitest --run test/live/support/record.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Delete the two output-level fixtures**

They are at the wrong level and cannot be salvaged.

```bash
git rm test/fixtures/recorded/deepseek-text.json test/fixtures/recorded/deepseek-tool.json
```

- [ ] **Step 6: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/live/support/record.ts test/live/support/record.test.ts
git commit -m "test: record at the deps seam instead of the mapper output"
```

---

### Task 4: Credential store for recording

**Files:**
- Create: `test/live/support/pi-auth-store.ts`
- Test: `test/live/support/pi-auth-store.test.ts` (runs in the DEFAULT suite against a temp file, no real credentials)

**Interfaces:**
- Consumes: `CredentialStore`, `StoredCredential` from `src/types.ts`.
- Produces: `piAuthStore(path?: string): CredentialStore`.

**Why this task exists.** `createPiDeps({})` passes no credential store, so pi falls back to **ambient environment variables only**. The `openai-codex` credential is OAuth and lives in `~/.pi/agent/auth.json`; no environment variable can carry it, so without a store that fixture cannot be recorded at all. nax-ai ships no `CredentialStore` implementation — it is a bare port — so the live suite must supply one.

The agent never handles a secret: the store reads the file at run time and hands pi an opaque value.

**Two rulings, both about not damaging the operator's real credential file:**

- `modify` and `delete` **throw**. pi runs OAuth refresh inside `modify`, and a silent no-op would drop a rotated refresh token on the floor — which can invalidate the operator's pi CLI login, not just this run. Failing loudly tells them to refresh through pi first.
- The `key` is opaque. Never log, compare, or inspect it. pi's stored format also permits `"$VAR"` templates and `"!command"` values; this store passes them through verbatim rather than resolving them, because executing a command out of a credential file is not something a test should do.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piAuthStore } from "./pi-auth-store.ts";

function fixtureFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-ai-auth-"));
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(contents), "utf8");
  return file;
}

describe("piAuthStore", () => {
  it("maps pi's api_key entry onto the api-key credential", async () => {
    const store = piAuthStore(fixtureFile({ "opencode-go": { type: "api_key", key: "literal-value" } }));
    expect(await store.read("opencode-go")).toEqual({ kind: "api-key", key: "literal-value" });
  });

  it("maps pi's oauth entry onto the oauth credential", async () => {
    const store = piAuthStore(
      fixtureFile({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 123, accountId: "acc" } }),
    );
    expect(await store.read("openai-codex")).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 123 });
  });

  it("returns undefined for a provider with no stored credential", async () => {
    const store = piAuthStore(fixtureFile({}));
    expect(await store.read("nobody")).toBeUndefined();
  });

  it("refuses to write, so a rotated token is never silently lost", async () => {
    const store = piAuthStore(fixtureFile({}));
    await expect(store.modify("x", async () => undefined)).rejects.toThrow(/read-only/);
    await expect(store.delete("x")).rejects.toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun x vitest --run test/live/support/pi-auth-store.test.ts`
Expected: FAIL — cannot find module `./pi-auth-store.ts`.

- [ ] **Step 3: Write the store**

```ts
// test/live/support/pi-auth-store.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, StoredCredential } from "../../../src/types.ts";

const DEFAULT_PATH = join(homedir(), ".pi", "agent", "auth.json");

/** pi's on-disk shape. `type` is snake_case there and kebab-case in nax-ai. */
interface PiEntry {
  readonly type?: string;
  readonly key?: string;
  readonly access?: string;
  readonly refresh?: string;
  readonly expires?: number;
  readonly env?: Readonly<Record<string, string>>;
}

function toStored(entry: PiEntry | undefined): StoredCredential | undefined {
  if (entry === undefined) return undefined;
  if (entry.type === "api_key" && typeof entry.key === "string") {
    return { kind: "api-key", key: entry.key, ...(entry.env !== undefined ? { env: entry.env } : {}) };
  }
  if (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    typeof entry.refresh === "string" &&
    typeof entry.expires === "number"
  ) {
    // pi carries provider extras such as accountId alongside these three. They
    // are dropped because nax-ai's StoredCredential does not model them, which
    // is safe for openai-codex specifically: pi re-derives the account id from
    // the access token's JWT claim rather than reading the stored field.
    return { kind: "oauth", access: entry.access, refresh: entry.refresh, expires: entry.expires };
  }
  return undefined;
}

/**
 * Reads pi's own credential file so the live suite can record against
 * providers the operator has already authenticated, including OAuth ones no
 * environment variable can carry.
 */
export function piAuthStore(path: string = DEFAULT_PATH): CredentialStore {
  const readAll = (): Record<string, PiEntry> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, PiEntry>;
    } catch {
      return {};
    }
  };

  const refuse = (): never => {
    throw new Error(
      "piAuthStore is read-only: pi runs OAuth refresh inside modify(), and writing back from a test could drop a rotated refresh token and break the operator's pi login. Refresh through pi's own CLI first, then re-run.",
    );
  };

  return {
    read: async (providerId) => toStored(readAll()[providerId]),
    modify: async () => refuse(),
    delete: async () => refuse(),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun x vitest --run test/live/support/pi-auth-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/live/support/pi-auth-store.ts test/live/support/pi-auth-store.test.ts
git commit -m "test: read pi's credential file so live recording can reach oauth providers"
```

---

### Task 5: Live recording run (operator-run)

**Files:**
- Modify: `test/live/complete.live.test.ts` (rewrite to drive recording through `recordingDeps`)
- Create: `test/fixtures/recorded/*.json` — the real fixtures, produced by running this

**Interfaces:**
- Consumes: `recordingDeps` from Task 3.
- Produces: the committed fixture files that Task 6 asserts against.

**This task needs provider credentials and spends money. An agent should prepare the code and stop; a human runs the recording.**

Credentials come from `piAuthStore()` (Task 4), which reads `~/.pi/agent/auth.json`. Nothing is passed on the command line and no key is ever printed. Before running, confirm the operator has authenticated the providers through pi's own CLI — `opencode-go` (api key) and `openai-codex` (OAuth). If the Codex token has expired, refresh it through pi first: this store deliberately refuses to write, so pi cannot rotate it from inside the recording run.

- [ ] **Step 1: Rewrite the live test to record at the seam**

```ts
import { describe, expect, it } from "vitest";
import { createPiDeps, createPiProtocol } from "../../src/protocols/pi-client.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { piAuthStore } from "./support/pi-auth-store.ts";
import { recordingDeps } from "./support/record.ts";

interface Target {
  readonly fixture: string;
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly api: string;
  readonly request: Omit<ProtocolRequest, "model" | "provider">;
}

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const;

// Model ids probed from pi-ai 0.84.4's bundled catalog on 2026-08-31. Re-probe with:
//   node -e "import('./dist/providers/pi-catalog.js').then(async m => console.log((await m.piProviders(['opencode-go']))[0].models.map(x => x.id + ' ' + x.protocol)))"
const TARGETS: readonly Target[] = [
  {
    fixture: "opencode-go-anthropic-messages-text",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    fixture: "opencode-go-anthropic-messages-tool",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: {
      messages: [{ role: "user", content: "Read the file a.ts using the read tool." }],
      tools: [READ_TOOL],
      maxTokens: 128,
    },
  },
  {
    fixture: "opencode-go-anthropic-messages-thinking",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: {
      messages: [{ role: "user", content: "Think step by step, then read a.ts with the read tool." }],
      tools: [READ_TOOL],
      thinking: "medium",
      maxTokens: 512,
    },
  },
  {
    fixture: "opencode-go-openai-completions-text",
    provider: "opencode-go",
    protocol: "openai-completions",
    model: "deepseek-v4-flash",
    api: "openai-completions",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    fixture: "opencode-go-openai-responses-text",
    provider: "opencode-go",
    protocol: "openai-responses",
    model: "gpt-5.6-luna",
    api: "openai-responses",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    fixture: "openai-codex-responses-text",
    provider: "openai-codex",
    protocol: "openai-codex-responses",
    model: "gpt-5.4-mini",
    api: "openai-codex-responses",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
];

describe("record fixtures from live providers", () => {
  for (const t of TARGETS) {
    it(`records ${t.fixture}`, async () => {
      const rec = recordingDeps(createPiDeps({ credentials: piAuthStore() }), {
        provider: t.provider,
        protocol: t.protocol,
        model: t.model,
        api: t.api,
        note: `Recorded from ${t.provider}. Evidence of ${t.protocol} event shape only.`,
      });
      const protocol = createPiProtocol(t.protocol, rec.deps);

      const events: ProtocolEvent[] = [];
      for await (const e of protocol.stream({ ...t.request, model: t.model, provider: t.provider })) {
        events.push(e);
      }

      rec.write(t.fixture);
      expect(events.at(-1)?.type).toBe("done");
    }, 120_000);
  }
});
```

- [ ] **Step 2: Confirm the model ids still exist**

The ids above were probed from pi-ai 0.84.4's bundled catalog on 2026-08-31 and were real as of that date, but provider catalogs move. Re-run the probe and correct any id that has gone:

```
node -e "import('./dist/providers/pi-catalog.js').then(async m => { for (const p of await m.piProviders(['opencode-go','openai-codex'])) for (const x of p.models) console.log(p.id, x.protocol, x.id) })"
```

An unknown id throws from `resolveModel` and records nothing, so a stale id costs a run rather than corrupting a fixture.

- [ ] **Step 3: Operator runs the recording**

Run: `bun run test:live`
Expected: six fixtures written under `test/fixtures/recorded/`.

- [ ] **Step 4: Read every fixture's `note` and correct it**

For the thinking fixture specifically, check whether any recorded `thinking` block carries a non-empty `thinkingSignature`:

```bash
node -e "const f=require('./test/fixtures/recorded/opencode-go-anthropic-messages-thinking.json'); const sigs=JSON.stringify(f).match(/thinkingSignature/g); console.log('signature mentions:', sigs ? sigs.length : 0)"
```

If the count is zero, edit that fixture's `note` to say so explicitly — for example: `"Gateway emitted no thinkingSignature. This fixture is evidence of thinking event SHAPE only, not of signature round-trip."` Do not leave a note implying coverage the fixture does not have.

- [ ] **Step 5: Commit the fixtures**

```bash
git add test/live/complete.live.test.ts test/fixtures/recorded/
git commit -m "test: record fixtures for all four protocols"
```

---

### Task 6: Replay suite

**Files:**
- Create: `test/protocols/replay.test.ts`

**Interfaces:**
- Consumes: `fixtureNames`, `loadFixture` (Task 1), `drainFixture`, `protocolFromFixture` (Task 2), `runProtocolConformance` and `sequenceViolations` (existing, `test/support/conformance.ts`).
- Produces: nothing.

- [ ] **Step 1: Write the suite**

```ts
import { describe, expect, it } from "vitest";
import { sequenceViolations } from "../support/conformance.ts";
import { fixtureNames, loadFixture } from "../support/load-fixture.ts";
import { drainFixture } from "../support/replay.ts";

// `example-bad-header` exists to prove the loader rejects it, so it is not
// replayable by construction.
const REPLAYABLE = fixtureNames().filter((n) => n !== "example-bad-header");

describe("recorded fixtures", () => {
  it("has at least one fixture per protocol", () => {
    const protocols = new Set(REPLAYABLE.map((n) => loadFixture(n).meta.protocol));
    expect([...protocols].sort()).toEqual(
      ["anthropic-messages", "openai-codex-responses", "openai-completions", "openai-responses"].sort(),
    );
  });

  for (const name of REPLAYABLE) {
    describe(name, () => {
      it("satisfies the protocol sequence contract", async () => {
        const fixture = loadFixture(name);
        const events = await drainFixture(fixture);

        // An error fixture legitimately ends in an error rather than done.
        if (fixture.response.status >= 400) {
          expect(events.at(-1)?.type).toBe("error");
          return;
        }

        // sequenceViolations always reports "emitted no text delta", because
        // it was written for the text case. A turn that only calls a tool has
        // no prose and is not in violation of anything, so that one line is
        // excused when a tool call is present. Excusing it structurally rather
        // than by fixture name keeps the rule true if fixtures are renamed.
        const hasToolCall = events.some((e) => e.type === "tool-call");
        const excused = hasToolCall ? new Set(["emitted no text delta"]) : new Set<string>();
        expect(sequenceViolations(events).filter((v) => !excused.has(v))).toEqual([]);
      });

      it("carries a note saying what it is evidence of", () => {
        expect(loadFixture(name).meta.note.length).toBeGreaterThan(20);
      });
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `bun x vitest --run test/protocols/replay.test.ts`
Expected: PASS. If the per-protocol assertion fails, a fixture from Task 5 is missing — record it rather than weakening the assertion.

- [ ] **Step 3: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/protocols/replay.test.ts
git commit -m "test: replay every recorded fixture against the sequence contract"
```

---

### Task 7: Error-path fixture

**Files:**
- Create: `test/fixtures/recorded/error-rate-limit.json` (hand-written if no live 429 can be provoked — and labelled as such)
- Create: `test/protocols/replay-errors.test.ts`

**Interfaces:**
- Consumes: `loadFixture`, `drainFixture`.
- Produces: nothing.

The `onResponse` capture that `classifyHttpError` and `parseRetryAfter` depend on has never met a real failure response. A live 429 cannot be provoked on demand, so this fixture is hand-written from the recorded shape and says so.

- [ ] **Step 1: Write the fixture**

```json
{
  "meta": {
    "provider": "example",
    "protocol": "openai-completions",
    "model": "example-model",
    "api": "openai-completions",
    "recordedAt": "2026-08-31",
    "note": "SYNTHETIC rate-limit response. A live 429 cannot be provoked on demand. Evidence that the error path maps status and retry-after correctly, NOT evidence of any provider's real 429 shape."
  },
  "response": { "status": 429, "headers": { "retry-after": "30" } },
  "events": [
    {
      "type": "error",
      "reason": "error",
      "error": {
        "role": "assistant",
        "content": [],
        "api": "openai-completions",
        "provider": "example",
        "model": "example-model",
        "usage": { "input": 5, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "stopReason": "stop",
        "timestamp": 0,
        "errorMessage": "rate limited"
      }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { loadFixture } from "../support/load-fixture.ts";
import { drainFixture } from "../support/replay.ts";

describe("error path", () => {
  it("classifies a 429 as rate-limit and carries retry-after through", async () => {
    const events = await drainFixture(loadFixture("error-rate-limit"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") throw new Error("no error event");
    expect(err.error.kind).toBe("rate-limit");
    expect(err.error.status).toBe(429);
    expect(err.error.retryAfter).toBe(30);
  });

  it("still reports usage the failed request burned", async () => {
    const events = await drainFixture(loadFixture("error-rate-limit"));
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it**

Run: `bun x vitest --run test/protocols/replay-errors.test.ts`
Expected: PASS. If `kind` is `unknown` rather than `rate-limit`, the `onResponse` capture is not reaching the classifier — STOP and report it as a `src/` defect rather than adjusting the test.

- [ ] **Step 4: Run all gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add test/fixtures/recorded/error-rate-limit.json test/protocols/replay-errors.test.ts
git commit -m "test: cover the error path through a recorded 429"
```

---

### Task 8: Close M3 on the roadmap

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update the position table and the M3 section**

Mark M3 done. State exactly what is now proven and what is not, in these terms:

- Which protocols have fixtures, and that they were recorded through gateways rather than first-party providers where that is the case.
- Whether the thinking-signature round-trip was observed. If it was not, say so plainly and record that closing it needs a first-party Anthropic API key, as a named follow-up rather than an implied one.
- That the error fixture is synthetic.

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: M3 complete, with its remaining evidence gaps named"
```

---

## Notes for the executor

- `sequenceViolations` treats "a text request must produce text" as a universal
  invariant, which it is not — see the excusal in Task 6. Narrowing that helper to
  take the case shape would be a tidier fix, but it changes a file the conformance
  suite depends on, so it belongs in its own change rather than inside M3.

- If any fixture reveals that `src/` maps something wrongly, that is a **success** of this plan. Stop, report it, and let it be fixed in its own change with its own regression test. Do not adjust a fixture to match current behaviour.
- Nothing in this plan should make `bun run test` reach the network. If a replay test starts needing credentials, the harness is wired wrong.
