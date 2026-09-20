# Telemetry Key Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `tool-audit` a joinable identity — a file header and per-call correlation ids — so a recorded tool call can be traced to the cost row that paid for it.

**Architecture:** Three independent tiers over one mechanism. Tier 1 widens a `Pick<>` so `callId`/`scopeId` reach the tool sink. Tier 3 mints a `turnId` per turn and stamps it on both the dispatch event (→ cost row) and the tool record. Tier 2 rides tier 3's turn-context carrier to add the within-turn round-trip index. A `runId` and `schemaVersion` header is added alongside.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-20-telemetry-key-hygiene-design.md`

## Global Constraints

- **Run `bun run test`, never bare `bun test`** — bare `bun test` gives confident false signals in this repo. Targeted iteration: `bun test test/unit/path/foo.test.ts --timeout=30000`.
- **`bun run typecheck` is NOT part of `check:all`.** Run it explicitly after every task; only `tsc` catches a declared-but-unwired field.
- **`bun run test:coverage` is not in the nax pipeline.** Run it by hand after any task that adds a `src/` file — a passing suite can still fail the per-file floor.
- **Bun-native APIs only.** No Node.js equivalents where Bun has one.
- **No `any` in public APIs.** TypeScript strict.
- **400-line soft limit per file**, 800 hard. `src/tools/tool-audit.ts` is ~77 lines and has room; check before adding to larger files.
- **Conventional commits**, one logical concern per commit.
- **`_deps` pattern** for external calls (fs, spawn, fetch) — see `docs/architecture/ARCHITECTURE.md`.
- **Never edit `.claude/rules/`** — it is generated from `.nax/rules/` by `nax generate`.
- **This plan is native-path only.** Only `src/agents/native/session/turn-loop.ts` dispatches `"coding-tool"` interactions; ACP does not use that path. Tier 2 and the `turnId` on tool records apply to native sessions. The cost-row half of tier 3 is transport-agnostic and applies to both.

---

## Preconditions

> **Revised 2026-09-20 after spec-review against the merged tree.**
> `feat/native-loop-events` (#2162) **has now merged** as `f4b3bbc7a`, and this
> plan was re-audited against it. Seven corrections were applied — four of them
> would have failed at compile time or silently regressed #2162:
>
> | # | Where | What |
> |---|---|---|
> | B1 | Task 6 Step 6 | snippet used `call.input`; the merged loop uses `input` (= the `before_tool` `allow` rewrite). Using `call.input` diverges execution from the transcript. |
> | B2 | Task 5 Step 4 | `DispatchErrorEvent` has no `protocolIds`/`turnId` — "do the same for the error path" had no field to write to. The field is now created first. |
> | B3 | Task 5 Step 5 | `event.protocolIds` is TS2339 on the `DispatchEvent` union (`CompleteDispatchEvent` lacks it, deliberately). Success and error rows now use different, compiling expressions. |
> | B4 | Task 5 | `cost-rate-provenance.test.ts` pins `toBe(5)` in 3 places and was in no `Test:` list — an unauthorised collision that deadlocks the bump. Now listed. |
> | M2 | Task 0 | new Step 2b: `turn-loop.ts` left the merge at **584 of a hard 600** lines, and Tasks 5–6 both add to it. |
> | M3 | Task 2 Step 1 | the `ctx` cast crashed instead of failing; `runId` cannot be supplied to `makeTestRuntime`. Rewritten against the file's real pattern. |
> | m2 | Task 5 | "Four assertions" was five, and is eight once B4's file is counted. |
>
> Task 0's Step 3 contingency is also pre-resolved: `afterTool` carries no turn
> context, so **follow Task 6 as written**.
>
> Line numbers below that were not touched by the re-audit remain hints. Task 0
> still runs first.

This plan is written against `main` @ `13d6bfcb1` **but is intended to execute after `feat/native-loop-events` merges.** That feature restructures `src/agents/native/session/turn-loop.ts` (seven tool-result append sites collapse into one builder, plus `before_tool`/`after_tool` registrations) and `src/tools/runtime.ts`.

**Every line number in this plan is therefore a hint, not an address.** Task 0 exists to re-anchor them. Do not skip it.

---

### Task 0: Re-anchor the plan against the merged tree

**Files:**
- Read only. No changes, no commit.

**Interfaces:**
- Consumes: nothing.
- Produces: a verified set of anchors used by every later task.

- [ ] **Step 1: Confirm the merge landed**

```bash
git log --oneline -5 origin/main | grep -i "native-loop-events" || echo "NOT MERGED — STOP"
```

If `native-loop-events` has not merged, stop and report. This plan's Tasks 5 and 6 target code that feature rewrites.

- [ ] **Step 2: Re-locate every anchor**

```bash
grep -n "export interface ToolCallRecord" src/tools/tool-audit.ts
grep -n "export function createToolAuditSink" src/tools/tool-audit.ts
grep -n "JSON.stringify({ sessionName" src/tools/tool-audit.ts
grep -n "sink.record({" src/tools/runtime.ts
grep -n "callTool(name" src/tools/runtime.ts
grep -n "codingToolPackageDir\"" src/agents/coding-tool-support.ts
grep -n "createToolAuditSink({" src/agents/coding-tool-support.ts
grep -n "readonly callId" src/agents/types.ts
grep -n "buildSessionTurnEvent" src/agents/manager.ts
grep -n "protocolIds: {" src/agents/manager-dispatch.ts
grep -n "turnId" src/runtime/dispatch-events.ts
grep -n "let roundTrips\|roundTrips += 1" src/agents/native/session/turn-loop.ts
grep -n 'kind === "coding-tool"' src/agents/native/session/turn-loop.ts
grep -n "export interface SendTurnOpts" src/agents/session-types.ts
```

Write the actual line numbers down. Where a symbol has moved, trust the symbol.

- [ ] **Step 2b: Check the `turn-loop.ts` line budget BEFORE editing it**

```bash
wc -l src/agents/native/session/turn-loop.ts   # 584 on f4b3bbc7a
grep -n "const SRC_LIMIT" scripts/check-file-sizes.ts   # 600, a HARD gate
```

`src/agents/native/session/turn-loop.ts` came out of the `native-loop-events`
merge at **584 of 600 lines**, leaving 16. Tasks 5 and 6 both add to it — Task 6
Step 6 alone is roughly +8 once the guard comment is included. `check-file-sizes`
runs in `check:all` and in the pre-commit hook, so a breach blocks the commit, not
just CI, and the file is not on the grandfathered list (14 entries, none of them
this one).

If the budget will not hold, extract before you add — do **not** delete the
explanatory comments to buy lines. The natural extraction is the coding-tool
dispatch block into a helper beside `buildToolResult` in
`src/agents/native/session/tool-result.ts`, which already owns the sibling
concern. Land that as its own commit, before the stamping edit.

- [ ] **Step 3: Check whether US-002 gave us a better seam**

```bash
grep -rn "before_tool\|after_tool" src/agents/native/ | head -20
```

Task 6 threads turn context to the tool record by extending the interaction request. If `after_tool` handlers receive a context object that already carries the turn, prefer it and note the deviation in the commit message. If they do not, follow Task 6 as written.

**Already resolved against `f4b3bbc7a`:** they do not. The dispatcher's signature
is `afterTool(call: ToolCall, payload: AfterToolPayload): AfterToolPatch`
(`src/agents/native/session/loop-events.ts:83-84`) and carries no turn context,
so **follow Task 6 as written.** Re-run the grep to confirm nothing changed, but
do not expect a better seam.

- [ ] **Step 4: Confirm the `resultBytes` denominator change**

```bash
grep -n "resultBytesPreTruncation\|READ_CEILING\|readCeiling" src/tools/tool-audit.ts src/tools/runtime.ts
```

Task 1's schema comment must describe what `resultBytes` now measures. Read the merged truncation policy before writing that comment — do not guess.

---

### Task 1: Add `schemaVersion` and the header type to tool-audit

**Files:**
- Modify: `src/tools/tool-audit.ts`
- Test: `test/unit/tools/tool-audit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TOOL_AUDIT_SCHEMA_VERSION` (a `number`), and `createToolAuditSink(opts: { dir: string; sessionName: string; header?: ToolAuditHeader })` where

```ts
export interface ToolAuditHeader {
  readonly runId?: string;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly sessionRole?: string;
}
```

Later tasks pass `header`. This task makes it optional so nothing else must change yet.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tools/tool-audit.test.ts`:

```ts
test("writes schemaVersion and the header fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({
    dir,
    sessionName: "US-001-implementer",
    header: {
      runId: "run-abc",
      featureName: "telemetry-keys",
      storyId: "US-001",
      sessionRole: "implementer",
    },
  });
  sink.record({
    tool: "Read",
    outcome: "ok",
    input: { path: "a.ts" },
    resultBytes: 10,
    at: "2026-09-20T00:00:00.000Z",
  });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.schemaVersion).toBe(TOOL_AUDIT_SCHEMA_VERSION);
  expect(parsed.runId).toBe("run-abc");
  expect(parsed.featureName).toBe("telemetry-keys");
  expect(parsed.storyId).toBe("US-001");
  expect(parsed.sessionRole).toBe("implementer");
  expect(parsed.sessionName).toBe("US-001-implementer");
});

test("omits header keys that were not supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1" });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.schemaVersion).toBe(TOOL_AUDIT_SCHEMA_VERSION);
  expect("runId" in parsed).toBe(false);
  expect("featureName" in parsed).toBe(false);
});
```

Update the import at the top of the file:

```ts
import { createToolAuditSink, TOOL_AUDIT_SCHEMA_VERSION } from "@/tools/tool-audit";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: FAIL — `TOOL_AUDIT_SCHEMA_VERSION` is not exported.

- [ ] **Step 3: Implement**

In `src/tools/tool-audit.ts`, above `createToolAuditSink`:

```ts
/**
 * tool-audit file schema version.
 *
 * 1 — first versioned generation. Adds a file header (`runId`, `featureName`,
 *     `storyId`, `sessionRole`) and per-call correlation ids (`callId`,
 *     `scopeId`, `turnId`, `roundTrips`, `toolCallId`).
 *
 *     Files written before this field existed carry none of the above and
 *     cannot be backfilled: `runId` in particular was never in scope at the
 *     sink's construction path, so an unversioned file's only identity is its
 *     filename.
 *
 *     `sessionName` is a HUMAN LABEL from this version on, never a join key.
 *     It is constant-prefixed and stable across re-runs by construction, so it
 *     collides: 7.5% of review-audit sessionNames span more than one runId.
 *     Join on `runId` plus `callId`/`turnId` instead.
 *
 *     NOTE ON `resultBytes`: <Task 0 Step 4 — describe what the merged
 *     after_tool truncation policy makes this field measure, and state that
 *     unversioned files measured it differently. Do not leave this sentence
 *     unresolved.>
 */
export const TOOL_AUDIT_SCHEMA_VERSION = 1;

/** Run-scoped identity stamped once per tool-audit file. */
export interface ToolAuditHeader {
  readonly runId?: string;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly sessionRole?: string;
}
```

Change the factory signature and the write:

```ts
export function createToolAuditSink(opts: {
  dir: string;
  sessionName: string;
  header?: ToolAuditHeader;
}): ToolAuditSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push(entry);
    },
    async flush() {
      if (calls.length === 0) return;
      await mkdir(opts.dir, { recursive: true });
      const body = JSON.stringify(
        {
          schemaVersion: TOOL_AUDIT_SCHEMA_VERSION,
          ...(opts.header ?? {}),
          sessionName: opts.sessionName,
          calls,
        },
        null,
        2,
      );
      await writeFile(join(opts.dir, `${Date.now()}-${opts.sessionName}.json`), body);
    },
  };
}
```

The `...(opts.header ?? {})` spread is what makes unsupplied keys absent rather than `undefined` — that is what the second test pins.

- [ ] **Step 4: Run the tests**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: PASS, including the two pre-existing tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/tool-audit.ts test/unit/tools/tool-audit.test.ts
git commit -m "feat(tool-audit): add schemaVersion and an optional run-scoped header"
```

---

### Task 2: Add `runId` to `AgentRunOptions` and populate it

**Files:**
- Modify: `src/agents/types.ts` (near the existing `callId`/`scopeId` declarations)
- Modify: `src/operations/call-run-options.ts`
- Modify: `src/runtime/index.ts` (at the `createSessionRunHop(...)` wiring)
- Modify: `src/runtime/session-run-hop.ts`
- Test: `test/unit/operations/call-run-options.test.ts` (exists — append, do not recreate)

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentRunOptions.runId?: string`, populated on both production hops. Task 3 reads it.

- [ ] **Step 1: Write the failing test**

Append to the existing `test/unit/operations/call-run-options.test.ts` (it already has a `describe` block and imports — add the test inside it rather than duplicating the scaffolding):

Build a real `CallContext` with the helpers the file already imports. **Do not
cast a bare object** — verified on `f4b3bbc7a`, `buildRunDispatchOptions`
dereferences `ctx.packageView` (`call-run-options.ts:57`, via `storyExecRoot`)
and `ctx.runtime.toolProviders.length` (`:75`) *before* it ever reads `runId`,
so a `{ runtime: { runId } }` stub makes the test **crash** with
`Cannot read properties of undefined` rather than fail its assertion — which is
not the informative red the TDD step needs.

Note also that `runId` is minted inside `createRuntime`
(`crypto.randomUUID()`, `src/runtime/index.ts:305`) and cannot be supplied, so
assert against `runtime.runId` rather than a literal:

```ts
  test("forwards the runtime's runId onto the run options", () => {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    const packageView = runtime.packages.resolve("packages/api");
    const ctx: CallContext = {
      runtime,
      packageView,
      packageDir: "packages/api",
      config,
      agentName: "claude",
    };

    const opts = buildRunDispatchOptions(ctx, {
      prompt: "hi",
      effectiveTier: "balanced",
      dispatchModelDef: { provider: "claude", model: "sonnet" },
      // …mirror the sibling test's remaining params
    });

    expect(opts.runId).toBe(runtime.runId);
    expect(opts.runId).toBeTruthy();
  });
```

Add this **inside** the file's existing `describe` block, next to the sibling
test that already builds this exact `ctx` shape — copy its parameter object
rather than inventing one. `makeTestRuntime` self-registers its own `afterEach`
teardown (`trackRuntime`, `test/helpers/runtime.ts:30`), so no manual cleanup is
needed and `check:runtime-cleanup` stays green.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/call-run-options.test.ts --timeout=30000`
Expected: FAIL — `opts.runId` is `undefined`.

- [ ] **Step 3: Declare the field**

In `src/agents/types.ts`, directly beneath the existing `scopeId` declaration:

```ts
  /**
   * Run-level id, from `NaxRuntime.runId`. Forwarded so run-scoped sinks built
   * on the dispatch path (tool-audit) can stamp it; the cost and review-audit
   * sinks capture the same value as a constructor parameter instead.
   */
  readonly runId?: string;
```

- [ ] **Step 4: Populate at caller one**

In `src/operations/call-run-options.ts`, inside the returned options object:

```ts
    ...(ctx.runtime?.runId !== undefined ? { runId: ctx.runtime.runId } : {}),
```

Match the conditional-spread style already used for `callId`/`scopeId` in that file.

- [ ] **Step 5: Populate at caller two**

`src/runtime/session-run-hop.ts` receives `options: AgentRunOptions` and does not mint a runId. The run-level value is in scope at the `createSessionRunHop(...)` call in `src/runtime/index.ts`. Capture it:

```ts
// src/runtime/index.ts — at the runHop wiring
runHop: createSessionRunHop(sessionManager, () => agentManager, runId),
```

and in `src/runtime/session-run-hop.ts`, add a third parameter and merge it into the options the hop forwards:

```ts
export function createSessionRunHop(
  sessionManager: SessionManager,
  getAgentManager: () => AgentManager | undefined,
  runId?: string,
): SessionRunHopFn {
  return async (agentName, options, ...rest) => {
    const opts: AgentRunOptions = { ...options, ...(options.runId ?? runId ? { runId: options.runId ?? runId } : {}) };
    // …existing body, reading `opts` where it read `options`
```

> Do not mutate `options` — this repo forbids input mutation. Build a new
> object. Keep a caller-supplied `runId` winning over the captured one, which
> mirrors how `call.ts` preserves a caller-supplied `callId`.

- [ ] **Step 6: Run the tests**

Run: `bun test test/unit/operations/call-run-options.test.ts --timeout=30000`
Expected: PASS.

Run: `bun run test`
Expected: PASS — `createSessionRunHop`'s arity changed, so any test constructing it directly must still compile.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/agents/types.ts src/operations/call-run-options.ts src/runtime/index.ts src/runtime/session-run-hop.ts test/unit/operations/call-run-options.test.ts
git commit -m "feat(runtime): forward runId on AgentRunOptions from both production hops"
```

---

### Task 3: Widen the `Pick<>` and stamp the header (tier 1, header half)

**Files:**
- Modify: `src/agents/coding-tool-support.ts`
- Test: `test/unit/agents/coding-tool-support.test.ts`

**Interfaces:**
- Consumes: `AgentRunOptions.runId` (Task 2), `createToolAuditSink({ header })` (Task 1).
- Produces: tool-audit files carrying a populated header. Task 4 adds the per-call ids.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/coding-tool-support.test.ts`, following the existing glob-and-parse pattern used by the tests at the ledger-placement assertions:

```ts
test("the tool-audit file carries the run-scoped header", async () => {
  const root = await mkdtemp(join(tmpdir(), "cts-header-"));
  const support = await resolveCodingToolSupport({
    declaredTools: ["Read"],
    codingToolRoot: root,
    outputDir: root,
    runId: "run-header-1",
    featureName: "auth-system",
    storyId: "US-007",
    sessionRole: "implementer",
  } as never);

  support?.auditSink.record({
    tool: "Read",
    outcome: "ok",
    input: {},
    resultBytes: 1,
    at: "2026-09-20T00:00:00.000Z",
  });
  await support?.auditSink.flush();

  const written = [...new Bun.Glob("**/*.json").scanSync(join(root, "tool-audit"))];
  expect(written).toHaveLength(1);
  const parsed = JSON.parse(await readFile(join(root, "tool-audit", written[0] as string), "utf8"));
  expect(parsed.runId).toBe("run-header-1");
  expect(parsed.featureName).toBe("auth-system");
  expect(parsed.storyId).toBe("US-007");
  expect(parsed.sessionRole).toBe("implementer");
});
```

> Copy the exact `resolveCodingToolSupport` argument shape from a neighbouring
> test in this file rather than the sketch above — the real options object has
> required members this snippet omits.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/coding-tool-support.test.ts --timeout=30000`
Expected: FAIL — `parsed.runId` is `undefined`.

- [ ] **Step 3: Widen the `Pick<>`**

In `src/agents/coding-tool-support.ts`, the `resolveCodingToolSupport` parameter type is an inline `Pick<AgentRunOptions, …>` whose final member is `"codingToolPackageDir"`. Add three members:

```ts
    | "codingToolPackageDir"
    | "runId"
    | "callId"
    | "scopeId"
```

`callId` and `scopeId` are added now, in the same edit, because they are consumed by Task 4 and splitting the type change across two commits leaves a member declared and unused in between.

- [ ] **Step 4: Pass the header through**

`resolveCodingToolSupport` builds `auditDir` and `sessionName`, then calls `buildCodingToolSupport`. Thread a header alongside them. In `buildCodingToolSupport`'s args type add:

```ts
  header?: import("../tools/tool-audit").ToolAuditHeader;
  callId?: string;
  scopeId?: string;
```

and at the `createToolAuditSink` call:

```ts
      ? createToolAuditSink({
          dir: args.auditDir,
          sessionName: args.sessionName ?? "unattached",
          ...(args.header ? { header: args.header } : {}),
        })
```

In `resolveCodingToolSupport`, build the header from the options it already has:

```ts
  const header = {
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.featureName !== undefined ? { featureName: options.featureName } : {}),
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.sessionRole !== undefined ? { sessionRole: options.sessionRole } : {}),
  };
```

and pass `header` into `buildCodingToolSupport`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/agents/coding-tool-support.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/agents/coding-tool-support.ts test/unit/agents/coding-tool-support.test.ts
git commit -m "feat(tool-audit): stamp the run-scoped header on every ledger file"
```

---

### Task 4: Emit `callId` and `scopeId` on every tool record (tier 1)

**Files:**
- Modify: `src/tools/tool-audit.ts` (`ToolCallRecord`)
- Modify: `src/tools/runtime.ts` (`createCodingToolRuntime` opts, `sink.record`)
- Modify: `src/agents/coding-tool-support.ts` (pass ids into the runtime)
- Test: `test/unit/tools/tool-audit.test.ts`

**Interfaces:**
- Consumes: the widened `Pick<>` from Task 3.
- Produces: `ToolCallRecord.callId?: string`, `ToolCallRecord.scopeId?: string`. Task 6 adds `turnId`, `roundTrips`, `toolCallId` to the same interface.

- [ ] **Step 1: Write the failing test**

```ts
test("records the correlation ids supplied to the runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1" });
  sink.record({
    tool: "Read",
    outcome: "ok",
    input: {},
    resultBytes: 1,
    at: "2026-09-20T00:00:00.000Z",
    callId: "call-1",
    scopeId: "scope-1",
  });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.calls[0].callId).toBe("call-1");
  expect(parsed.calls[0].scopeId).toBe("scope-1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: FAIL — TypeScript rejects `callId` on `ToolCallRecord`.

- [ ] **Step 3: Declare the fields**

In `src/tools/tool-audit.ts`, inside `ToolCallRecord`:

```ts
  /**
   * The `callOp` invocation this tool call happened under.
   *
   * NOT unique: one callId spans every retry, agent-swap hop and turn of the
   * invocation, so it is 1:N over cost rows (10.0% of groups hold more than
   * one). It is a foreign key. Use `turnId` to select a single cost row.
   *
   * This is the OPERATION-layer callId (`DispatchEventBase.callId`), not the
   * stream-layer field of the same name in `agent-stream-events.ts` — joining
   * on that one produced nax#2045's 0-of-1,940 match rate.
   */
  readonly callId?: string;
  /** Caller-defined region spanning many callOp invocations. */
  readonly scopeId?: string;
```

- [ ] **Step 4: Run the test**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Wire the ids into the runtime**

`createCodingToolRuntime(opts)` already receives `sink`. Add the ids to its opts:

```ts
  callId?: string;
  scopeId?: string;
```

and at the `sink.record({ … })` call, spread them in:

```ts
      ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
      ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
```

In `src/agents/coding-tool-support.ts`, pass `args.callId` / `args.scopeId` from `buildCodingToolSupport` into `createCodingToolRuntime`, and pass `options.callId` / `options.scopeId` from `resolveCodingToolSupport` into `buildCodingToolSupport`.

- [ ] **Step 6: Write the wiring test**

Append to `test/unit/agents/coding-tool-support.test.ts`, mirroring the header test from Task 3 but asserting on a call rather than the header:

```ts
test("correlation ids reach the ledger from the run options", async () => {
  const root = await mkdtemp(join(tmpdir(), "cts-ids-"));
  const support = await resolveCodingToolSupport({
    declaredTools: ["Read"],
    codingToolRoot: root,
    outputDir: root,
    featureName: "auth-system",
    storyId: "US-007",
    callId: "call-wired",
    scopeId: "scope-wired",
  } as never);

  await support?.runtime.callTool("Read", { path: "nope.ts" });
  await support?.auditSink.flush();

  const written = [...new Bun.Glob("**/*.json").scanSync(join(root, "tool-audit"))];
  const parsed = JSON.parse(await readFile(join(root, "tool-audit", written[0] as string), "utf8"));
  expect(parsed.calls[0].callId).toBe("call-wired");
  expect(parsed.calls[0].scopeId).toBe("scope-wired");
});
```

> A failed `Read` still produces a record (`outcome: "error"`), which is why
> this asserts without creating the file. Confirm against the merged
> `runtime.ts` that the error path still calls `sink.record` — if the merged
> truncation work moved that call, assert on a successful read instead.

- [ ] **Step 7: Run the tests, typecheck, lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/tools/tool-audit.ts src/tools/runtime.ts src/agents/coding-tool-support.ts test/unit/tools/tool-audit.test.ts test/unit/agents/coding-tool-support.test.ts
git commit -m "feat(tool-audit): emit callId and scopeId on every recorded tool call"
```

---

### Task 5: Mint `turnId` per turn and carry it to the cost row (tier 3, producer half)

**Files:**
- Modify: `src/agents/manager.ts` (`runAsSession`)
- Modify: `src/agents/session-types.ts` (`SendTurnOpts`)
- Modify: `src/agents/manager-dispatch.ts` (`buildSessionTurnEvent` **and** `buildDispatchErrorEvent`)
- Modify: `src/runtime/dispatch-events.ts` (`DispatchErrorEvent` gains `turnId?: string` — see Step 4)
- Modify: `src/runtime/middleware/cost.ts`
- Test: `test/unit/agents/manager-dispatch-emission.test.ts`, `test/unit/runtime/middleware/cost.test.ts`, `test/unit/runtime/middleware/cost-roundtrip-attribution.test.ts`, `test/unit/runtime/middleware/cost-rate-provenance.test.ts`

> There is no `manager-dispatch.test.ts`. The suite is split:
> `manager-dispatch-emission.test.ts`, `-complete`, `-error-event`,
> `-error-event-model`, `-rates`. Emission is the right home for this.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SendTurnOpts.turnId?: string` (read by Task 6), `protocolIds.turnId` populated on every `SessionTurnDispatchEvent`, and `turnId` on every cost row.

> **Design correction — read this before implementing.** The spec says to
> populate `protocolIds.turnId` "at `manager-dispatch.ts:128`". That location
> alone is insufficient: `runAsSession` calls `sendPrompt` and only *then*
> builds the dispatch event, so a turnId minted at event-build time comes into
> existence after the tool calls it is supposed to label. The id must be minted
> **before** `sendPrompt`, passed down via `SendTurnOpts` so the turn loop can
> see it, and stamped onto the event afterwards. That is what this task does.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildSessionTurnEvent } from "@/agents/manager-dispatch";

describe("buildSessionTurnEvent", () => {
  test("carries a supplied turnId on protocolIds", () => {
    const event = buildSessionTurnEvent({
      // …copy the required argument shape from a neighbouring test
      turnId: "turn-1",
    } as never);

    expect(event.protocolIds.turnId).toBe("turn-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/manager-dispatch-emission.test.ts --timeout=30000`
Expected: FAIL — `protocolIds.turnId` is `undefined`.

- [ ] **Step 3: Accept and stamp the turnId**

`protocolIds.turnId?: string` is already declared on `SessionTurnDispatchEvent` in `src/runtime/dispatch-events.ts` — it has simply never been populated. In `buildSessionTurnEvent`, extend the `protocolIds` literal:

```ts
    protocolIds: {
      sessionId: handle.protocolIds?.sessionId ?? null,
      recordId: handle.protocolIds?.recordId ?? null,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    },
```

and add `turnId?: string` to that function's argument type. The parameter is
named `input` (`buildSessionTurnEvent(input: { … })`), not `args`.

- [ ] **Step 4: Mint it in `runAsSession`, before the turn runs**

In `src/agents/manager.ts`, inside `runAsSession`, above the `sendPrompt` call:

```ts
    const turnId = newCorrelationId();
```

importing `newCorrelationId` from `src/operations/call-resolvers`. Pass it into the turn:

```ts
    const rawResult = await sendPrompt(handle, prompt, { ...opts, turnId });
```

and into the event:

```ts
      const event = buildSessionTurnEvent({
        // …existing args
        turnId,
      });
```

**The error path needs a field created first.** Verified on `f4b3bbc7a`:
`DispatchErrorEvent` (`src/runtime/dispatch-events.ts:139-181`) carries flat
`callId?` / `scopeId?` and has **no `protocolIds` object and no `turnId`** — so
"do the same" has nothing to write to. `protocolIds` is deliberately absent:
`CompleteDispatchEvent`'s own comment records that a one-shot has no record id
and no turn id (US-002), and the error event follows the flat shape.

Add a flat field, matching the `callId?`/`scopeId?` precedent rather than
introducing a `protocolIds` object on this event:

```ts
  /** Identity of the turn that failed; mirrors `protocolIds.turnId` on a
   *  successful `SessionTurnDispatchEvent`. Flat, because this event has no
   *  `protocolIds` object — see `CompleteDispatchEvent`. */
  readonly turnId?: string;
```

then stamp it in `buildDispatchErrorEvent` (`src/agents/manager-dispatch.ts:212-250`)
so a failed turn is still labelled.

Add to `SendTurnOpts` in `src/agents/session-types.ts`:

```ts
  /**
   * Identity for THIS turn, minted by `runAsSession` before the turn runs.
   *
   * One turn is one cost row, so this is the field that selects a single row —
   * `callId` spans retries and hops and cannot. Minted ahead of `sendPrompt`
   * precisely so tool calls made during the turn can carry it.
   */
  turnId?: string;
```

- [ ] **Step 5: Copy it onto the cost row**

In `src/runtime/middleware/cost.ts`, in both the success row (near the existing
`callId: event.callId`) and the error row. **The two rows need different
expressions** — the obvious single snippet does not compile in either place:

*Success row* (`cost.ts:101`, `event: DispatchEvent = SessionTurnDispatchEvent |
CompleteDispatchEvent`). `CompleteDispatchEvent` declares no `protocolIds`, so
`event.protocolIds` is **TS2339 on the union** — and `?.` does not rescue a
property that is missing from a member rather than nullable. Narrow on `kind`
first:

```ts
      ...(event.kind === "session-turn" && event.protocolIds?.turnId !== undefined
        ? { turnId: event.protocolIds.turnId }
        : {}),
```

*Error row* (`cost.ts:223`, `event: DispatchErrorEvent`). This event has no
`protocolIds` at all; read the flat field Step 4 adds:

```ts
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
```

Bump `COST_ROW_SCHEMA_VERSION` to `6` and add a changelog entry in the comment block above it, matching the style of entries 1–5:

```
 * 6 — adds `turnId`, copied from `protocolIds.turnId`. This is the first row
 *     field that identifies WHICH turn within a `callId` the row is: `callId`
 *     is per-callOp-invocation and is 1:N over rows. Absent on v5 and earlier,
 *     and not backfillable.
```

- [ ] **Step 6: Write the cost-row test**

```ts
test("a cost row carries the turnId from the dispatch event", () => {
  // Build the aggregator + subscriber the way the neighbouring tests do,
  // emit a session-turn event whose protocolIds.turnId is "turn-9",
  // and assert the written row.
  expect(row.turnId).toBe("turn-9");
  expect(row.schemaVersion).toBe(6);
});
```

> Fill this in from the existing cost middleware tests — they already have a
> helper that emits a dispatch event and captures the written row. Do not
> invent a new harness.

- [ ] **Step 7: Run the tests, typecheck, lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all clean.

Eight assertions across three files hard-pin the old version and MUST be updated
to 6 — they will not fail informatively if missed, they will simply fail:

- `test/unit/runtime/middleware/cost-roundtrip-attribution.test.ts:257` (`schemaVersion).toBe(5)`)
- `test/unit/runtime/middleware/cost-roundtrip-attribution.test.ts:258` (`COST_ROW_SCHEMA_VERSION).toBe(5)`)
- `test/unit/runtime/middleware/cost-roundtrip-attribution.test.ts:270` (error row)
- `test/unit/runtime/middleware/cost.test.ts:581` (`schemaVersion).toBe(5)`)
- `test/unit/runtime/middleware/cost.test.ts:582` (`COST_ROW_SCHEMA_VERSION).toBe(5)`)
- `test/unit/runtime/middleware/cost-rate-provenance.test.ts:131` (`schemaVersion).toBe(5)`)
- `test/unit/runtime/middleware/cost-rate-provenance.test.ts:132` (`COST_ROW_SCHEMA_VERSION).toBe(5)`)
- `test/unit/runtime/middleware/cost-rate-provenance.test.ts:144` (`schemaVersion).toBe(5)`)

`cost-rate-provenance.test.ts` was missed by this plan's first pass. Its describe
block is titled `"attachCostSubscriber — schemaVersion 5 (US-003 AC1)"` and its
file header records `schemaVersion: 5` as a prior story's acceptance criterion —
so it is an exact-equality pin that the bump breaks, and test-authorship
isolation gives an implementer no sanctioned route to it unless it is named here.
It IS named here, and in this task's `Test:` list.

`cost.test.ts:400,415` compare against the constant rather than a literal and
need no change.

- [ ] **Step 8: Commit**

```bash
git add src/agents/manager.ts src/agents/session-types.ts src/agents/manager-dispatch.ts src/runtime/middleware/cost.ts test/
git commit -m "feat(telemetry): mint a turnId per turn and stamp it on the cost row"
```

---

### Task 6: Carry turn context to the tool record (tiers 2 and 3, consumer half)

**Files:**
- Modify: `src/agents/interaction-handler.ts` (`AdapterInteraction`)
- Modify: `src/agents/native/session/turn-loop.ts`
- Modify: `src/agents/run-interaction-handler.ts`
- Modify: `src/tools/runtime.ts` (`callTool`)
- Modify: `src/tools/tool-audit.ts` (`ToolCallRecord`)
- Test: `test/unit/tools/tool-audit.test.ts`, `test/unit/agents/native/turn-loop.test.ts`

> Note the directory: the main turn-loop suite is at
> `test/unit/agents/native/turn-loop.test.ts`. Only the invalid-input tests
> live under `native/session/`.

**Interfaces:**
- Consumes: `SendTurnOpts.turnId` (Task 5).
- Produces: `ToolCallRecord.turnId`, `.roundTrips`, `.toolCallId`.

> **Check Task 0 Step 3 first.** If the merged `after_tool` seam already hands
> a handler the turn context, register there instead of widening
> `AdapterInteraction`, and say so in the commit message. The steps below are
> the fallback that works against the pre-US-002 shape.

- [ ] **Step 1: Write the failing test**

```ts
test("records turn context alongside the tool call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1" });
  sink.record({
    tool: "Read",
    outcome: "ok",
    input: {},
    resultBytes: 1,
    at: "2026-09-20T00:00:00.000Z",
    turnId: "turn-1",
    roundTrips: 3,
    toolCallId: "toolu_abc",
  });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.calls[0].turnId).toBe("turn-1");
  expect(parsed.calls[0].roundTrips).toBe(3);
  expect(parsed.calls[0].toolCallId).toBe("toolu_abc");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: FAIL — TypeScript rejects the three new fields.

- [ ] **Step 3: Declare the fields**

In `ToolCallRecord`:

```ts
  /**
   * The turn this call happened in. One turn is one cost row, so this is the
   * field that prices a tool call. Native sessions only — ACP does not route
   * coding tools through the turn loop.
   */
  readonly turnId?: string;
  /**
   * Model round-trip index WITHIN the turn, 1-based.
   *
   * Not a turn index. `turn-loop.ts` pushes an interaction field named
   * `turnIndex` whose value is this same round-trip counter; the two names
   * have been conflated before. Native sessions only.
   */
  readonly roundTrips?: number;
  /**
   * Provider-assigned `tool_use` id, passed through verbatim — nax never mints
   * or namespaces it. Unique within a session in practice, with no global
   * guarantee, and NOT stable across a retry: a retried turn produces fresh
   * ids. The unique tuple is (runId, sessionName, toolCallId).
   */
  readonly toolCallId?: string;
```

- [ ] **Step 4: Run the test**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Widen the interaction request**

In `src/agents/interaction-handler.ts`, extend the coding-tool variant:

```ts
  | {
      kind: "coding-tool";
      name: string;
      input?: Record<string, unknown>;
      /** Turn context, for the audit ledger. Native only. */
      turnId?: string;
      roundTrips?: number;
      toolCallId?: string;
    };
```

- [ ] **Step 6: Populate it at the dispatch site**

In `src/agents/native/session/turn-loop.ts`, at the `onInteraction({ kind, name, input })` call for coding tools, add the three values. `roundTrips` is the loop counter already in scope; `call.id` is the provider tool_use id; `turnId` comes from `opts.turnId` (Task 5):

```ts
          const answer = await opts.interactionHandler.onInteraction(
            kind === "coding-tool"
              ? {
                  kind,
                  name: call.name,
                  // MUST be `input`, NOT `call.input`. #2162's US-002 added a
                  // `before_tool` `allow` outcome that may REWRITE the input;
                  // the merged line is `input: (input ?? {}) as Record<...>`
                  // where `input = rewritten ?? call.input` (turn-loop.ts:448).
                  // Using `call.input` here runs the tool on the model's
                  // original arguments while `rewriteToolCallInput` has already
                  // recorded the corrected ones — execution and transcript
                  // diverge, silently, with no test in this plan covering it.
                  input: (input ?? {}) as Record<string, unknown>,
                  ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
                  roundTrips,
                  toolCallId: call.id,
                }
              : { /* …existing context-tool branch, unchanged */ },
          );
```

> **Re-anchored against the merged tree (`f4b3bbc7a`).** US-002 did NOT move this
> call out of `turn-loop.ts` — `buildToolResult` is the result *builder*, but the
> `onInteraction` dispatch is still inline, now at `turn-loop.ts:453-457`. Read it
> before editing and preserve the `input` variable exactly as the comment in the
> block above says.

- [ ] **Step 7: Forward through the handler into `callTool`**

In `src/agents/run-interaction-handler.ts`, the coding-tool branch calls `runtime.callTool(req.name, req.input ?? {})`. Add a third argument:

```ts
        const outcome = await runtime.callTool(req.name, req.input ?? {}, {
          ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
          ...(req.roundTrips !== undefined ? { roundTrips: req.roundTrips } : {}),
          ...(req.toolCallId !== undefined ? { toolCallId: req.toolCallId } : {}),
        });
```

In `src/tools/runtime.ts`, widen the interface and the implementation:

```ts
/** Per-call turn context, recorded on the audit ledger. */
export interface ToolCallContext {
  readonly turnId?: string;
  readonly roundTrips?: number;
  readonly toolCallId?: string;
}

  callTool(
    name: string,
    input: Record<string, unknown>,
    context?: ToolCallContext,
  ): Promise<CodingToolOutcome>;
```

and spread `context` into the `sink.record({ … })` literal alongside the Task 4 ids:

```ts
      ...(context ?? {}),
```

- [ ] **Step 8: Write the end-to-end wiring test**

Add a turn-loop test asserting that a coding-tool interaction carries the turn context. Model it on the existing turn-loop tests, which drive `runNativeTurn` with a stubbed `deps.complete` returning a tool call:

```ts
test("a coding-tool interaction carries turnId, roundTrips and the tool_use id", async () => {
  const seen: unknown[] = [];
  await runNativeTurn(/* handle, prompt */, {
    // …existing opts from a neighbouring test
    turnId: "turn-42",
    interactionHandler: {
      onInteraction: async (req: { kind: string }) => {
        seen.push(req);
        return { answer: "ok" };
      },
    },
  } as never);

  const codingCall = seen.find((r) => (r as { kind: string }).kind === "coding-tool");
  expect(codingCall).toMatchObject({ turnId: "turn-42", roundTrips: 1 });
  expect((codingCall as { toolCallId: string }).toolCallId).toBeTruthy();
});
```

- [ ] **Step 9: Run the tests, typecheck, lint**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all clean. `callTool`'s arity changed — the third parameter is optional, so existing callers compile, but check the test helpers for a hand-rolled `CodingToolRuntime` stub that must gain the parameter.

- [ ] **Step 10: Commit**

```bash
git add src/agents/interaction-handler.ts src/agents/native/session/turn-loop.ts src/agents/run-interaction-handler.ts src/tools/runtime.ts src/tools/tool-audit.ts test/
git commit -m "feat(tool-audit): record turnId, round-trip index and tool_use id per call"
```

---

### Task 7: Put the runId in the filename

**Files:**
- Modify: `src/tools/tool-audit.ts`
- Test: `test/unit/tools/tool-audit.test.ts`
- Check: `test/unit/agents/coding-tool-support.test.ts` (globs the ledger path)

**Interfaces:**
- Consumes: `ToolAuditHeader.runId` (Task 1).
- Produces: filenames of the form `<runId>-<epochMs>-<sessionName>.json`.

- [ ] **Step 1: Write the failing test**

```ts
test("the filename carries the runId when one is known", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1", header: { runId: "run-fn" } });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const [name] = await readdir(dir);
  expect(name).toMatch(/^run-fn-\d+-s1\.json$/);
});

test("falls back to the unprefixed name when no runId is known", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s2" });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const [name] = await readdir(dir);
  expect(name).toMatch(/^\d+-s2\.json$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/tool-audit.test.ts --timeout=30000`
Expected: the first FAILS, the second PASSES.

- [ ] **Step 3: Implement**

```ts
      const prefix = opts.header?.runId !== undefined ? `${opts.header.runId}-` : "";
      await writeFile(join(opts.dir, `${prefix}${Date.now()}-${opts.sessionName}.json`), body);
```

- [ ] **Step 4: Run the tests**

Run: `bun run test`
Expected: PASS. The `coding-tool-support` tests glob `**/*.json`, so the rename does not break them — confirm rather than assume.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/tools/tool-audit.ts test/unit/tools/tool-audit.test.ts
git commit -m "feat(tool-audit): prefix the ledger filename with the runId"
```

---

### Task 8: Extend the #1907 canary guard

**Files:**
- Create: `scripts/check-dispatch-field-forwarding.ts`
- Modify: `package.json` (`check:*` scripts and `check:all`)

> The spec calls this "extending #1907's canary guard". Verification found no
> such guard in the tree, so this task writes one. See Step 1.

**Interfaces:**
- Consumes: everything above.
- Produces: a gate that fails when a dispatch event drops a correlation id.

> This task is why the spec exists in the form it does. Four prior passes of
> this same defect class shipped; #1907's guard was meant to make a fourth
> impossible and did not catch it. Adding fields without extending the guard
> leaves pass seven exactly as likely.

- [ ] **Step 1: Locate the guard — expect NOT to find one**

> **Verified 2026-09-20 against `main` @ `13d6bfcb1`: the "#1907 canary guard"
> is not locatable in this tree.** `grep -rn "1907" src/ test/ scripts/
> --include="*.ts"` returns one unrelated hit (a string-length fixture). Every
> `canary` match in `src/` is a release-version string (`0.80.0-canary.3`).
> None of the 28 `scripts/check-*` guards is a dispatch-field-forwarding check
> — `check-dispatch-context.sh` is an ADR-020 nullable-manager guard, which is
> a different thing.
>
> The 2026-09-08 spec's work itself DID ship (`modelPassed` forwarding is live
> at `src/runtime/middleware/review-audit.ts:70`), so what is missing is the
> guard, not the fix. Treat "extend the guard" as **"write the guard"**.

Confirm the finding still holds before choosing a branch:

```bash
grep -rn "1907" src/ test/ scripts/ --include="*.ts" | head
grep -rln "canary" scripts/ | head
```

- **If a real field-forwarding guard turns up**, extend it and skip to Step 4.
- **If it does not** (expected), create one — Steps 2–4 below.

- [ ] **Step 2: Write the guard**

Create `scripts/check-dispatch-field-forwarding.ts`, following the house
pattern of the existing `scripts/check-*.ts` guards (read
`scripts/check-logger-storyid.ts` first for the idiom — plain script, prints
`OK:` on success, `ERROR:` plus offending lines and `exit 1` on failure).

It must fail when a dispatch event builder drops a correlation id. The minimum
viable check, which is what the four prior passes of this defect class would
each have been caught by: assert that `buildSessionTurnEvent` forwards every
field the plan added, by reading the source of `src/agents/manager-dispatch.ts`
and requiring the literal identifiers `callId`, `scopeId` and `turnId` inside
its `protocolIds`/event construction.

A source-text check is weak but it is the shape the other 28 guards take, it
runs in CI, and it would have fired on all four historical passes. Do not
gold-plate it into a type-level analysis.

- [ ] **Step 3: Wire it into CI**

```bash
grep -n "check:" package.json | head -40
```

Add a `check:dispatch-field-forwarding` script and include it in `check:all`.

> **This is mandatory, not optional.** The repo enforces that every check
> script is reachable from CI — the pre-commit output ends with
> `OK: all 28 check scripts are reachable from CI`. A new script that is not
> wired in will FAIL that gate, so adding the script and wiring it are one
> commit, not two.

- [ ] **Step 4: Prove the guard actually fails**

A guard that cannot fail is worse than none — it reports green forever. Prove
it by reintroducing the defect:

```bash
# temporarily delete the turnId forwarding added in Task 5
bun run check:dispatch-field-forwarding   # expect: ERROR, exit 1
git checkout src/agents/manager-dispatch.ts
bun run check:dispatch-field-forwarding   # expect: OK
```

Do not proceed until you have seen it fail. Record both outputs in the commit
message.

- [ ] **Step 5: Run the full gates**

Run: `bun run test && bun run typecheck && bun run lint && bun run check:all`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(telemetry): extend the #1907 canary guard to correlation ids"
```

---

### Task 9: Verify against a real run

**Files:**
- None. This is a verification task.

**Interfaces:**
- Consumes: every task above.

> **A `nax run` is a real, billed LLM run. Get explicit approval at the launch
> moment — do not launch one because this plan says to.** Report to the user
> and wait.

- [ ] **Step 1: Run the coverage gate first**

```bash
bun run test:coverage
```

Expected: passes the per-file floor. This is not in the nax pipeline and a green suite can still fail it.

- [ ] **Step 2: Request approval, then run a small feature end to end**

State the cost estimate and wait for an explicit yes.

- [ ] **Step 3: Verify the header**

```bash
ls ~/.nax/nax/tool-audit/<feature>/
python3 -c "
import json,glob,sys
for p in glob.glob('$HOME/.nax/nax/tool-audit/<feature>/*.json'):
    o=json.load(open(p))
    assert o.get('schemaVersion')==1, p
    for k in ('runId','featureName','storyId','sessionRole'):
        assert o.get(k), (p,k)
print('header OK')
"
```

- [ ] **Step 4: Verify the joins**

```bash
python3 -c "
import json,glob,os
R=os.path.expanduser('~/.nax/nax')
cost={}
for p in glob.glob(R+'/cost/*.jsonl'):
    for line in open(p):
        line=line.strip()
        if not line: continue
        r=json.loads(line)
        if r.get('turnId'): cost.setdefault((r['runId'],r['turnId']),[]).append(r)
tot=hit=0
for p in glob.glob(R+'/tool-audit/*/*.json'):
    o=json.load(open(p))
    for c in o.get('calls',[]):
        if not c.get('turnId'): continue
        tot+=1
        if (o.get('runId'),c['turnId']) in cost: hit+=1
print(f'tool calls with a turnId: {tot}; matching exactly one cost row: {hit}')
assert tot and hit==tot
"
```

Expected: every tool call carrying a `turnId` matches a cost row of the same run. **This is the join that does not exist today and is the whole point of the change.**

- [ ] **Step 5: Verify `callId` is present but 1:N**

Confirm every tool-record `callId` appears on *at least* one cost row of the same run — at least, not exactly. A test asserting exactly one is wrong and will flake.

- [ ] **Step 6: Report**

Report the measured numbers. Do not claim success without the output.

---

## Self-Review

**Spec coverage.** §2.1 tier 1 → Tasks 3, 4. Tier 2 → Task 6. Tier 3 → Tasks 5, 6. `schemaVersion` → Task 1. Header → Tasks 1, 3. `sessionName` demotion → Task 1 (schema comment). §3.1 filename → Task 7. §3.2 `runId` plumbing → Task 2. §3.4 caveats → encoded as doc comments in Tasks 4 and 6. §5 verification criteria 1–4 → Task 9; criterion 5 (canary) → Task 8; criterion 6 (`resultBytes` comment) → Task 1 Step 3 with its input from Task 0 Step 4.

**No deviation from the spec.** An earlier draft of §2.1 placed `turnId` minting at `manager-dispatch.ts:128`, which is after `sendPrompt` returns and therefore too late to label tool calls. That was found while reviewing the design ahead of this plan, and the spec has been corrected — §2.1 tier 3 now specifies minting in `runAsSession` before the turn. Task 5's callout repeats the reasoning so an executor who reads only the plan still understands why the obvious site is wrong.

**One verified correction to the spec**, applied in Task 8: §5 criterion 5 says
#1907's canary guard "is extended". No such guard exists in the tree — the
2026-09-08 spec's *fix* shipped (`review-audit.ts:70`) but its guard did not.
Task 8 therefore creates one and wires it into `check:all`, which the repo's
own "all N check scripts are reachable from CI" gate requires in the same
commit.

**One deliberate placeholder**, in Task 1 Step 3: the `resultBytes` sentence in the schema comment cannot be written before reading the merged truncation policy. Task 0 Step 4 produces that input and Task 1 Step 3 marks it explicitly rather than leaving a silent gap.

**Type consistency.** `ToolAuditHeader` (Task 1) is consumed by name in Tasks 3 and 7. `ToolCallContext` (Task 6) is introduced once and used once. `TOOL_AUDIT_SCHEMA_VERSION` is asserted in Tasks 1 and 9. `turnId` is spelled identically across `SendTurnOpts`, `protocolIds`, the cost row and `ToolCallRecord`. `roundTrips` matches the name already used on cost rows and deliberately avoids `turnIndex`.
