# S4b-0: Verification and Additive Package Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the five open facts S4b depends on, then ship the additive `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` changes nax's new ACP adapter needs, released as 0.3.1 together with the unreleased #2373 fixes.

**Architecture:** The work is read-only verification first (Task 1), with findings recorded in this file because they gate later tasks and slices. Then there are small additive changes (Tasks 2 to 7):
- **In nax-agent:** contract fields.
- **In nax-agent-acp:** options and events.
- **In both:** one conditional error code.

No nax (`packages/nax`) code changes in this slice. Task 8 runs every gate and prepares the release, which needs maintainer approval at each publish step.

**Tech Stack:** TypeScript (ESM), Bun 1.4 for tests (`bun:test`), vitest for the Node contract suite, zod 4, `@agentclientprotocol/sdk` 1.7.0, Biome 2.5.10.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md` (§8 package changes, §10 row S4b-0, §12 risks). Read §1 (the governing rule) and §8 before starting.

## Global Constraints

- Additive only: no breaking change to `@nathapp/nax-agent` or `@nathapp/nax-agent-acp` (B4). Every new field or option is optional.
- Both packages share one version. This release is 0.3.1 (`release patch`), which also carries the unreleased #2373 fixes already in `## [Unreleased]`.
- Release order: nax-agent -> nax-agent-acp (spec §8). nax is not released in S4b-0.
- Releases, tags and publishes need explicit maintainer approval at the moment they run.
- Package code uses Node built-ins only; Bun APIs only in tests (`check:no-bun-apis`).
- Run package commands from the package directory: `packages/nax-agent` or `packages/nax-agent-acp`. Never bare `bun test`, never `bun run nax`.
- Rate limits are classified from structured error data only, never by free-text matching (spec §8).
- No emojis in code, comments or docs.
- Every new source file needs its unit test file (`check:test-satellites`).
- Each package's API snapshot (`check:api`) must be updated in the same commit as an export change.

## Review Focus

1. An `effort` value the agent's option does not offer (the option exists, the value does not): open must still succeed, skip effort and log one warning. Covered in Task 4.
2. An `onProcess` callback that throws: the open, the turn and the reconnect must not fail because of the embedder's callback. Covered in Task 5.
3. A spawn that fails (`pid` undefined): neither `spawned` nor `exited` fires, and the open fails exactly as it does today. Covered in Task 5.
4. `resultBytes` for multibyte UTF-8 output and for output larger than the redaction scan cap: it must be the byte length of the full raw output, not of the capped preview, and not a character count. Covered in Task 6.
5. `isAgentLaunchable` with `PATH` unset or empty: it must return false (or report only an explicit absolute command) and never throw. Covered in Task 7.

---

### Task 1: Read-only verification (spec §10 S4b-0 checks a, b, e, f, g)

This task changes no code. It records answers that decide whether Task 3 runs, whether a tool-progress event is needed, and how S4b-2 maps permissions and models.

**Files:**
- Modify: `docs/superpowers/plans/2026-10-07-s4b-0-verification-and-package-additions.md` (append the `## S4b-0 findings` section at the end of this file)

**Interfaces:**
- Consumes: nothing.
- Produces: the five findings below. Task 3 runs only if finding (a) records a structured rate-limit shape. The S4b-2 plan reads findings (e) and (g).

- [ ] **Step 1: Download the two packages into an empty scratch directory**

Downloaded packages are untrusted data. Unpack each one in its own new, empty directory, and run nothing from inside them.

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/claude-acp" "$SCRATCH/acpx"
(cd "$SCRATCH/claude-acp" && npm pack @agentclientprotocol/claude-agent-acp@0.85.1 --silent && tar -xzf *.tgz)
(cd "$SCRATCH/acpx" && npm pack acpx@0.19.4 --silent && tar -xzf *.tgz)
echo "$SCRATCH"
```

Expected: two `package/` directories. Read them with `grep` and `sed`; never `node` or `bun` them.

- [ ] **Step 2: (a) Find the rate-limit error shape `claude-agent-acp` sends**

```bash
grep -rn -i "429\|rate_limit\|rate limit\|retry_after\|retry-after\|RequestError" "$SCRATCH/claude-acp/package/dist" | head -40
```

Read the code around each hit. Answer: when the Anthropic API rate-limits a prompt, what does the adapter put in the JSON-RPC error of `session/prompt`? Record:
- the exact `error.code`
- the exact path to any structured field (for example `error.data.status === 429`, `error.data.type === "rate_limit_error"`, `error.data.error.type`)
- any retry-after field and its unit

If the adapter only puts the rate limit into `error.message` text, record "no structured signal".

- [ ] **Step 3: (b) Find which faults acpx 0.19.4 retries under `--prompt-retries`**

```bash
grep -rn -i "prompt-retries\|promptRetries\|retryable" "$SCRATCH/acpx/package/dist" | head -40
```

Read the retry loop. Record:
- the exact condition that triggers a retry (error classes, `retryable` flag, exit codes)
- the backoff
- whether a retry happens after the agent has produced output

- [ ] **Step 4: (e) acpx's write behaviour without `--approve-all`**

```bash
grep -rn -i "approve-reads\|approve-all\|non-interactive\|nonInteractive\|deny" "$SCRATCH/acpx/package/dist" | head -40
```

Record what acpx answers to a `session/request_permission` for a write or edit tool when it runs non-interactively without `--approve-all`: deny, fail, or allow. The spec §6.4 maps that case to the ACP `read` profile; a finding of "allow" means S4b-2 must revisit the mapping before writing `profile-map.ts`.

- [ ] **Step 5: (f) Whether the idle watchdog tolerates a long tool call with no activity**

Read these files in `packages/nax`:

```bash
grep -n "toolCallOnlyIdleTimeoutSeconds\|idleTimeoutSeconds\|tool_call_update" -r packages/nax/src/runtime/middleware/idle-watchdog | head -30
sed -n 248,262p packages/nax/src/config/schemas-infra.ts
grep -n "in_progress" packages/nax-agent-acp/src/client/tool-events.ts
```

Answer: while a tool call is open (a `tool_call_update` was seen, no completion yet), which timeout does the watchdog use, and is it measured from the last activity of any kind? The defaults are `idleTimeoutSeconds` 900 and `toolCallOnlyIdleTimeoutSeconds` 1800.
- The new backend emits `tool_call` when a call starts and `tool_result` when it ends, nothing in between.
- If the watchdog applies the 1800 s timeout while a call is open, record "tolerated, no tool-progress event needed".
- If it applies the 900 s timeout, record "needs a tool-progress event". The S4b-2 plan then adds the additive event (spec §8 last row) before the bridge is built.

- [ ] **Step 6: (g) nax's Claude model strings against the values `claude-agent-acp` offers**

```bash
sed -n 28,36p packages/nax/src/config/agent-defaults.ts
grep -rn -i "configOptions\|category.*model\|\"sonnet\"\|\"opus\"\|\"haiku\"\|\"default\"" "$SCRATCH/claude-acp/package/dist" | head -40
```

nax's Claude tier defaults are `haiku`, `sonnet` and `opus`. Record:
- the exact `value` ids the adapter's `model` config option offers
- whether each nax default is among them

Any default that is not offered becomes a mapping row in S4b-2's `model-effort.ts`. Also record the adapter's effort option: its id, category and values. Task 4 uses this; if it differs from `effort` with category `thought_level`, adjust the test fixture in Task 4 to the real id.

- [ ] **Step 7: Append the findings to this plan and commit**

Append this section to the end of this file, with each answer filled in from Steps 2 to 6:

```markdown
## S4b-0 findings (recorded <date>, by <executor>)

- (a) Rate-limit shape: <code, structured field path, retry-after field and unit | "no structured signal">. Task 3: <RUN | SKIP>.
- (b) acpx --prompt-retries retries: <condition>; backoff <...>; after output: <yes|no>.
- (e) acpx without --approve-all, non-interactive, write tool: <deny|fail|allow>. Spec §6.4 mapping: <stands | revisit>.
- (f) Watchdog while a tool call is open: <timeout used>. Tool-progress event: <not needed | needed>.
- (g) claude-agent-acp model values: <list>. nax defaults offered: haiku <y/n>, sonnet <y/n>, opus <y/n>. Effort option: id <...>, category <...>, values <...>.
```

```bash
git add docs/superpowers/plans/2026-10-07-s4b-0-verification-and-package-additions.md
git commit -m "docs(plan): S4b-0 verification findings"
rm -rf "$SCRATCH"
```

---

### Task 2: nax-agent contract additions (`toolAudit`, `ToolAuditHeader`, `resultBytes`)

**Files:**
- Modify: `packages/nax-agent/src/session/session-types.ts` (the `OpenSessionOpts` interface, beside `transcriptDir` near line 144)
- Modify: `packages/nax-agent/src/session/turn-event.ts:29` (the `tool_result` member)
- Modify: `packages/nax-agent/src/index.ts` (the export block that exports `createToolAuditSink`, near line 367)
- Modify: `packages/nax-agent/api/` (snapshot, regenerated)
- Modify: `packages/nax-agent/CHANGELOG.md` (`## [Unreleased]`)
- Test: `packages/nax-agent/test/unit/session/s4b-contract.test.ts` (new; type-level and runtime-shape checks)

**Interfaces:**
- Consumes: `ToolAuditHeader` from `packages/nax-agent/src/tools/tool-audit.ts:231`.
- Produces:
  - `OpenSessionOpts.toolAudit?: { readonly dir: string; readonly header: ToolAuditHeader }`
  - `TurnEvent` `tool_result` gains `readonly resultBytes?: number`
  - `ToolAuditHeader` exported from `@nathapp/nax-agent`

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/session/s4b-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { OpenSessionOpts, ToolAuditHeader, TurnEvent } from "@nathapp/nax-agent";

describe("S4b additive contract (spec §7.4, §8)", () => {
  test("OpenSessionOpts accepts an optional toolAudit with a dir and a header", () => {
    const header: ToolAuditHeader = { runId: "r-1", featureName: "f", storyId: "US-001", sessionRole: "implementer" };
    const audit: OpenSessionOpts["toolAudit"] = { dir: "/tmp/audit", header };
    expect(audit).toEqual({ dir: "/tmp/audit", header });
    const absent: OpenSessionOpts["toolAudit"] = undefined;
    expect(absent).toBeUndefined();
  });

  test("a tool_result event may carry resultBytes, and may omit it", () => {
    const withBytes: TurnEvent = { type: "tool_result", callId: "c1", isError: false, preview: "ok", resultBytes: 2 };
    const without: TurnEvent = { type: "tool_result", callId: "c1", isError: false, preview: "ok" };
    expect(withBytes.type === "tool_result" ? withBytes.resultBytes : -1).toBe(2);
    expect(without.type === "tool_result" ? without.resultBytes : -1).toBeUndefined();
  });
});
```

If `OpenSessionOpts` or `TurnEvent` is not exported from `@nathapp/nax-agent`'s `.` entry, import it from the path the package's other session tests use (`grep -rn "OpenSessionOpts" packages/nax-agent/test | head -3`), and keep the `ToolAuditHeader` import from `@nathapp/nax-agent`.

- [ ] **Step 2: Run the test and the typecheck to verify they fail**

```bash
cd packages/nax-agent && bun test ./test/unit/session/s4b-contract.test.ts && bun run typecheck
```

Expected: the typecheck FAILS, reporting that `ToolAuditHeader` is not exported, `toolAudit` does not exist on `OpenSessionOpts`, and `resultBytes` does not exist on the `tool_result` member.

- [ ] **Step 3: Implement**

In `packages/nax-agent/src/session/session-types.ts`, inside `interface OpenSessionOpts`, directly after the `transcriptDir?: string;` member and its comment:

```ts
  /**
   * ACP (S4b spec 7.4): where this session's tool-audit ledger is written and the
   * run-scoped header stamped on it. nax fills it from the same resolution the
   * native coding tools use. Native ignores it: its sink comes from coding-tool
   * support. Absent: the session writes no ledger.
   */
  toolAudit?: { readonly dir: string; readonly header: import("#src/tools/tool-audit").ToolAuditHeader };
```

In `packages/nax-agent/src/session/turn-event.ts`, replace the `tool_result` member:

```ts
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly isError: boolean;
      readonly preview: string;
      /** UTF-8 byte length of the full result before the preview cap (S4b spec 7.4). Absent when unknown. */
      readonly resultBytes?: number;
    }
```

In `packages/nax-agent/src/index.ts`, add `type ToolAuditHeader,` to the export block that contains `createToolAuditSink` (alphabetical position). If that block re-exports from a barrel that does not export `ToolAuditHeader`, add `type ToolAuditHeader` to that barrel's export of `tool-audit` too.

- [ ] **Step 4: Run the test, typecheck and the API snapshot**

```bash
cd packages/nax-agent && bun test ./test/unit/session/s4b-contract.test.ts && bun run typecheck && bun run check:api
```

Expected: the test PASSES and the typecheck passes. `check:api` FAILS with a snapshot diff showing exactly the three additions.

```bash
cd packages/nax-agent && bun run api:update && bun run check:api
```

Expected: PASS. Inspect `git diff api/` and confirm it shows only `toolAudit`, `resultBytes` and `ToolAuditHeader`.

- [ ] **Step 5: Changelog**

Under `## [Unreleased]` in `packages/nax-agent/CHANGELOG.md`, add to `### Added` (create the heading if absent):

```markdown
- `OpenSessionOpts.toolAudit` (optional `{ dir, header }`): where an ACP session writes its tool-audit ledger. Native ignores it.
- `resultBytes` (optional) on the `tool_result` turn event: the UTF-8 byte length of the full result before the preview cap.
- `ToolAuditHeader` is exported from the package entry.
```

- [ ] **Step 6: Run the package suite and gates, then commit**

```bash
cd packages/nax-agent && bun run test && bun run check:all
```

Expected: PASS.

```bash
git add packages/nax-agent/src/session/session-types.ts packages/nax-agent/src/session/turn-event.ts packages/nax-agent/src/index.ts packages/nax-agent/api packages/nax-agent/CHANGELOG.md packages/nax-agent/test/unit/session/s4b-contract.test.ts
git commit -m "feat(nax-agent): toolAudit open option, tool_result resultBytes, export ToolAuditHeader"
```

---

### Task 3 (CONDITIONAL): `AGENT_SESSION_RATE_LIMITED`

**Run this task only if Task 1 finding (a) records a structured rate-limit shape. If it records "no structured signal", skip it, and add one line to `packages/nax-agent-acp/README.md` under its errors section: "A rate limit surfaces as `AGENT_SESSION_TURN_FAILED`; the adapter sends no structured rate-limit signal."**

**Files:**
- Modify: `packages/nax-agent/src/session/agent-session-errors.ts:9-22` (the code union)
- Modify: `packages/nax-agent-acp/src/client/errors.ts` (`promptRequestError`, near line 101)
- Modify: `packages/nax-agent/api/`, `packages/nax-agent/CHANGELOG.md`, `packages/nax-agent-acp/CHANGELOG.md`, `packages/nax-agent-acp/README.md`
- Test: `packages/nax-agent-acp/test/unit/client/errors.test.ts`

**Interfaces:**
- Consumes: Task 1 finding (a): the exact field path.
- Produces:
  - `"AGENT_SESSION_RATE_LIMITED"` in `AgentSessionErrorCode`
  - `promptRequestError` throws it with context `{ step: "session/prompt", retryAfterSeconds?: number }`
  - `rateLimitOf(data: unknown): { readonly retryAfterSeconds?: number } | undefined`, exported from `#src/client/errors`

- [ ] **Step 1: Write the failing tests**

Add to `packages/nax-agent-acp/test/unit/client/errors.test.ts`. Adjust the `data` objects to the exact shape recorded in finding (a), and keep one test per recorded shape:

```ts
import { RequestError } from "@agentclientprotocol/sdk";
import { promptRequestError, rateLimitOf } from "#src/client/errors";

describe("rate limits (S4b spec §8: structured data only)", () => {
  test.each([
    [{ status: 429 }, {}],
    [{ type: "rate_limit_error" }, {}],
    [{ error: { type: "rate_limit_error" } }, {}],
    [{ status: 429, retry_after: 30 }, { retryAfterSeconds: 30 }],
    [{ status: 429, retry_after: "12" }, { retryAfterSeconds: 12 }],
  ])("rateLimitOf(%p) is a rate limit", (data, expected) => {
    expect(rateLimitOf(data)).toEqual(expected);
  });

  test.each([undefined, null, "429", { status: 500 }, { message: "rate limit exceeded" }, { status: 429, retry_after: -1 }])(
    "rateLimitOf(%p): only a structured signal counts; a bad retry_after is dropped",
    (data) => {
      const result = rateLimitOf(data);
      if (typeof data === "object" && data !== null && "status" in data && data.status === 429) {
        expect(result).toEqual({});
      } else {
        expect(result).toBeUndefined();
      }
    },
  );

  test("a rate-limited session/prompt is AGENT_SESSION_RATE_LIMITED with retryAfterSeconds", () => {
    const err = promptRequestError(new RequestError(-32603, "Too many requests", { status: 429, retry_after: 7 }), []);
    expect(err.code).toBe("AGENT_SESSION_RATE_LIMITED");
    expect(err.context).toMatchObject({ step: "session/prompt", retryAfterSeconds: 7 });
  });

  test("message text alone never classifies as a rate limit", () => {
    const err = promptRequestError(new RequestError(-32603, "rate limit exceeded, retry later"), []);
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
  });
});
```

If `RequestError`'s constructor signature differs in SDK 1.7.0, build the error the way the existing `errors.test.ts` cases do (`grep -n "RequestError" packages/nax-agent-acp/test/unit/client/errors.test.ts`).

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/errors.test.ts
```

Expected: FAIL. `rateLimitOf` is not exported, and the code is `AGENT_SESSION_TURN_FAILED`.

- [ ] **Step 3: Implement**

In `packages/nax-agent/src/session/agent-session-errors.ts`, add `| "AGENT_SESSION_RATE_LIMITED"` after `| "AGENT_SESSION_AUTH_REQUIRED"`.

In `packages/nax-agent-acp/src/client/errors.ts`, add above `promptRequestError`:

```ts
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterOf(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** A rate limit read from structured JSON-RPC error data only (S4b spec §8); never from message text. */
export function rateLimitOf(data: unknown): { readonly retryAfterSeconds?: number } | undefined {
  if (!isObject(data)) return undefined;
  const nested = isObject(data.error) ? data.error : undefined;
  const limited = data.status === 429 || data.type === "rate_limit_error" || nested?.type === "rate_limit_error";
  if (!limited) return undefined;
  const retryAfterSeconds = retryAfterOf(data.retry_after ?? nested?.retry_after);
  return retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
}
```

If finding (a) recorded a different field path, add that path to `limited` and `retryAfterOf`'s input, and add its case to the Step 1 table. Do not add free-text matching.

In `promptRequestError`, before the final `return new NaxError(...)`:

```ts
  const limit = rateLimitOf(err.data);
  if (limit !== undefined) {
    return new AgentSessionError(`The ACP agent was rate-limited: ${excerpt}`, "AGENT_SESSION_RATE_LIMITED", {
      step: "session/prompt",
      ...limit,
    });
  }
```

If `isObject` already exists in `errors.ts`, reuse it rather than adding a second one.

- [ ] **Step 4: Run tests, typecheck, snapshot**

```bash
cd packages/nax-agent && bun run typecheck && bun run check:api || bun run api:update
cd ../nax-agent-acp && bun test ./test/unit/client/errors.test.ts && bun run typecheck
```

Expected: PASS. The nax-agent snapshot diff shows only the new union member.

- [ ] **Step 5: Docs and changelogs**

- `packages/nax-agent/CHANGELOG.md` `### Added`: `- \`AGENT_SESSION_RATE_LIMITED\` error code, with optional \`retryAfterSeconds\` in its context.`
- `packages/nax-agent-acp/CHANGELOG.md` `### Added`: `- A rate-limited prompt is \`AGENT_SESSION_RATE_LIMITED\` (with \`retryAfterSeconds\` when the agent sends one), classified from structured error data only.`
- `packages/nax-agent-acp/README.md`, errors section: one line with the same sentence.

- [ ] **Step 6: Gates and commit**

```bash
cd packages/nax-agent && bun run test && bun run check:all
cd ../nax-agent-acp && bun run test && bun run check:all
git add packages/nax-agent packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): classify structured rate limits as AGENT_SESSION_RATE_LIMITED"
```

---

### Task 4: `effort` option

**Files:**
- Modify: `packages/nax-agent-acp/src/client/options.ts` (`AcpBackendOptions`, `ResolvedAcpOptions`, `SCHEMA`, `resolved`)
- Modify: `packages/nax-agent-acp/src/client/capabilities.ts` (add `EFFORT_FALLBACK_IDS`, `effortOptionId`)
- Modify: `packages/nax-agent-acp/src/client/open.ts` (`applyConfig`, near line 196)
- Modify: `packages/nax-agent-acp/README.md` (options section), `packages/nax-agent-acp/CHANGELOG.md`, `packages/nax-agent-acp/api/` if the package has one (`bun run check:api`)
- Test: `packages/nax-agent-acp/test/unit/client/options.test.ts`, `capabilities.test.ts`, `open.test.ts`

**Interfaces:**
- Consumes: Task 1 finding (g), the real effort option id, category and values.
- Produces:
  - `AcpBackendOptions.effort?: string`
  - `ResolvedAcpOptions.effort: string | undefined`
  - `effortOptionId(options: readonly SessionConfigOption[], agentName: string, effort: string): string | undefined`
  - `EFFORT_FALLBACK_IDS`

- [ ] **Step 1: Write the failing tests**

In `options.test.ts`:

```ts
describe("resolveAcpOptions: effort (S4b spec §8)", () => {
  test("absent by default; a non-empty string is kept", () => {
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE).effort).toBeUndefined();
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, effort: "high" }, SOURCE).effort).toBe("high");
  });

  test("an empty effort is AGENT_SESSION_INVALID_OPTIONS at effort", () => {
    expect(invalid({ agent: "claude", allowUnsandboxed: true, effort: "" })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path: "effort",
    });
  });
});
```

In `capabilities.test.ts` (add `effortOptionId` to the existing import from `#src/client/capabilities`, and import `type SessionConfigOption` from `@agentclientprotocol/sdk` if not already):

```ts
const select = (id: string, category: string | undefined, values: string[]): SessionConfigOption =>
  ({
    id,
    name: id,
    ...(category === undefined ? {} : { category }),
    type: "select",
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
  }) as SessionConfigOption;

describe("effortOptionId (S4b spec §6.7, §8)", () => {
  test("category thought_level wins when it offers the value", () => {
    const options = [select("effort", undefined, ["high"]), select("thinking", "thought_level", ["low", "high"])];
    expect(effortOptionId(options, "claude", "high")).toBe("thinking");
  });

  test("falls back to the agent's id when no thought_level option offers the value", () => {
    expect(effortOptionId([select("reasoning_effort", undefined, ["low", "high"])], "codex", "high")).toBe(
      "reasoning_effort",
    );
    expect(effortOptionId([select("effort", undefined, ["high"])], "claude", "high")).toBe("effort");
  });

  test("undefined when the value is not offered, the agent has no fallback, or there are no options", () => {
    expect(effortOptionId([select("effort", "thought_level", ["low"])], "claude", "high")).toBeUndefined();
    expect(effortOptionId([select("effort", undefined, ["high"])], "gemini", "high")).toBeUndefined();
    expect(effortOptionId([], "claude", "high")).toBeUndefined();
  });
});
```

In `open.test.ts`. Use the effort option recorded in finding (g); the fixture below assumes id `effort` with category `thought_level`:

```ts
const EFFORT_OPTION = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} as const;
const EFFORT_SCRIPT: FakeScript = { ...CLAUDE_SCRIPT, configOptions: [...CLAUDE_CONFIG_OPTIONS, EFFORT_OPTION] };

describe("openAcpSession: effort (S4b spec §8)", () => {
  test("applied after the mode and the model, through the thought-level option", async () => {
    const { fake, opened } = await openWith(EFFORT_SCRIPT, { model: "sonnet", effort: "high" });
    await opened;
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
      { sessionId: "fake-session-1", configId: "model", value: "sonnet" },
      { sessionId: "fake-session-1", configId: "effort", value: "high" },
    ]);
  });

  test("applied without a model", async () => {
    const { fake, opened } = await openWith(EFFORT_SCRIPT, { effort: "low" });
    await opened;
    expect(fake.callsTo("session/set_config_option").at(-1)).toEqual({
      sessionId: "fake-session-1",
      configId: "effort",
      value: "low",
    });
  });

  test("Review Focus 1: a value the option does not offer is skipped; the open succeeds", async () => {
    const { fake, opened } = await openWith(EFFORT_SCRIPT, { effort: "max" });
    await opened;
    const configIds = fake.callsTo("session/set_config_option").map((call) => (call as { configId: string }).configId);
    expect(configIds).not.toContain("effort");
  });

  test("an agent with no effort option: skipped, the open succeeds", async () => {
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, { effort: "high" });
    await opened;
    const configIds = fake.callsTo("session/set_config_option").map((call) => (call as { configId: string }).configId);
    expect(configIds).toEqual(["mode"]);
  });

  test("a model the agent does not offer still fails first", async () => {
    const { opened } = await openWith(EFFORT_SCRIPT, { model: "gpt-9", effort: "high" });
    const err = sessionError(await rejection(opened));
    expect(err.context).toMatchObject({ capability: "model" });
  });
});
```

If the fake agent's `session/set_config_option` handler returns no `configOptions`, check `test/fixtures/fake-agent/agent.ts`. The effort lookup in Step 3 falls back to the options it already had, so the tests above still hold.

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/options.test.ts ./test/unit/client/capabilities.test.ts ./test/unit/client/open.test.ts
```

Expected: FAIL. `effort` is rejected by the strict schema, `effortOptionId` is not exported, and no `effort` config call is made.

- [ ] **Step 3: Implement**

`options.ts`:
- In `AcpBackendOptions`, after `model`:

```ts
  /** Reasoning effort, set via session/set_config_option after the model (S4b spec 8). Skipped when not offered. */
  readonly effort?: string;
```

- In `ResolvedAcpOptions`, after `model`: `readonly effort: string | undefined;`.
- In `SCHEMA`, after `model`: `effort: z.string().min(1).optional(),`.
- In `resolved()`, after `model: data.model,`: `effort: data.effort,`.

`capabilities.ts`, after `modelOptionId`:

```ts
/** Per-agent effort option ids, tried when no option has category "thought_level" (nax's EFFORT_OPTION_BY_AGENT). */
export const EFFORT_FALLBACK_IDS: Readonly<Record<string, string>> = Object.freeze({
  claude: "effort",
  codex: "reasoning_effort",
  opencode: "effort",
  pi: "thought_level",
});

/** The option that sets `effort`: a "thought_level" option offering it, else the agent's fallback id offering it. */
export function effortOptionId(
  options: readonly SessionConfigOption[],
  agentName: string,
  effort: string,
): string | undefined {
  const offering = options.filter((option) => selectValues(option).includes(effort));
  const byCategory = offering.find((option) => option.category === "thought_level");
  if (byCategory !== undefined) return byCategory.id;
  const fallback = Object.hasOwn(EFFORT_FALLBACK_IDS, agentName) ? EFFORT_FALLBACK_IDS[agentName] : undefined;
  return fallback === undefined ? undefined : offering.find((option) => option.id === fallback)?.id;
}
```

If finding (g) recorded a different Claude effort id, change the `claude` entry to it.

`open.ts`: add `effortOptionId` to the import from `#src/client/capabilities`, add `getLogger` to the import from `@nathapp/nax-agent`, and replace `applyConfig` with:

```ts
/** §6.3 step 5: the profile's mode, then the model, then the effort (S4b). Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const afterMode = await applyMode(o, sessionId, offered);
  const afterModel = await applyModel(o, sessionId, afterMode);
  await applyEffort(o, sessionId, afterModel);
}

async function applyMode(
  o: Opening,
  sessionId: string,
  offered: readonly SessionConfigOption[],
): Promise<readonly SessionConfigOption[]> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode === undefined) return offered;
  if (!offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }));
  return set.configOptions ?? offered;
}

async function applyModel(
  o: Opening,
  sessionId: string,
  offered: readonly SessionConfigOption[],
): Promise<readonly SessionConfigOption[]> {
  const model = o.options.model;
  if (model === undefined) return offered;
  const configId = modelOptionId(offered, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  const set = await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
  return set.configOptions ?? offered;
}

/** S4b spec §6.7: an effort the agent does not offer is skipped with a warning, as acpx does. */
async function applyEffort(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const effort = o.options.effort;
  if (effort === undefined) return;
  const configId = effortOptionId(offered, o.options.agentName, effort);
  if (configId === undefined) {
    getLogger().warn("acp", "The agent offers no effort option for this value; effort skipped", {
      agent: o.options.agentName,
      effort,
    });
    return;
  }
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: effort }));
}
```

The behaviour of mode and model is unchanged: the same checks, the same order, the same errors. The existing `open.test.ts` cases prove it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/options.test.ts ./test/unit/client/capabilities.test.ts ./test/unit/client/open.test.ts && bun run typecheck
```

Expected: PASS, including every pre-existing case in those files.

- [ ] **Step 5: Docs, snapshot, commit**

- README options table or list: add `effort?: string`: "Reasoning effort, set through the agent's `thought_level` config option (or its known effort option) after the model. Skipped with a warning when the agent does not offer the value."
- CHANGELOG `### Added`: `- \`effort\` option: sets the agent's reasoning effort after the model; skipped with a warning when not offered.`
- `bun run check:api` (run `bun run api:update` if it reports the new option), then:

```bash
cd packages/nax-agent-acp && bun run test && bun run check:all
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): effort option applied after the model"
```

---

### Task 5: `onProcess` option

**Files:**
- Modify: `packages/nax-agent-acp/src/client/options.ts`
- Modify: `packages/nax-agent-acp/src/client/open.ts` (`openAcpSession`, after `launch(...)`, near line 101)
- Modify: `packages/nax-agent-acp/test/helpers/in-memory-launch.ts` (optional pids)
- Modify: `packages/nax-agent-acp/README.md`, `CHANGELOG.md`, the API snapshot
- Test: `packages/nax-agent-acp/test/unit/client/options.test.ts`, `open.test.ts`, `backend-reconnect.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AcpProcessHooks { spawned?(pid: number): void; exited?(pid: number): void }`
  - `AcpBackendOptions.onProcess?: AcpProcessHooks`
  - `ResolvedAcpOptions.onProcess: AcpProcessHooks | undefined`
  - `inMemoryAgent(script, { pids?: readonly number[] })`
- `AcpProcessHooks` is exported as a type from `./client`.

- [ ] **Step 1: Extend the in-memory test helper**

In `test/helpers/in-memory-launch.ts`, change the signature and the `pid` line:

```ts
export function inMemoryAgent(script: FakeScript = {}, extra: { readonly pids?: readonly number[] } = {}): InMemoryAgent {
```

```ts
      pid: extra.pids?.[requests.length - 1],
```

`requests.length - 1` is the index of the launch being built, because `requests.push(request)` runs first.

- [ ] **Step 2: Write the failing tests**

`options.test.ts`:

```ts
describe("resolveAcpOptions: onProcess (S4b spec §8)", () => {
  test("hooks are kept by reference; absent by default", () => {
    const hooks = { spawned: () => {}, exited: () => {} };
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE).onProcess).toBeUndefined();
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, onProcess: hooks }, SOURCE).onProcess).toBe(hooks);
  });

  test.each([{ spawned: 1 }, "x", { exited: "no" }])("onProcess %p is AGENT_SESSION_INVALID_OPTIONS", (onProcess) => {
    expect(invalid({ agent: "claude", allowUnsandboxed: true, onProcess })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path: "onProcess",
    });
  });
});
```

`open.test.ts`. Give `openWith` a `pids` pass-through by adding a fourth parameter, `pids?: readonly number[]`, used as `inMemoryAgent(script, pids === undefined ? {} : { pids })`:

```ts
describe("openAcpSession: onProcess (S4b spec §8)", () => {
  test("spawned fires with the pid; exited fires when the process ends", async () => {
    const seen: string[] = [];
    const hooks = { spawned: (pid: number) => seen.push(`spawned ${pid}`), exited: (pid: number) => seen.push(`exited ${pid}`) };
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, { onProcess: hooks }, undefined, [4242]);
    await opened;
    expect(seen).toEqual(["spawned 4242"]);
    fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["spawned 4242", "exited 4242"]);
  });

  test("Review Focus 3: no pid (spawn failed) means no hook calls", async () => {
    const seen: string[] = [];
    const hooks = { spawned: () => seen.push("spawned"), exited: () => seen.push("exited") };
    const { fake, opened } = await openWith(CLAUDE_SCRIPT, { onProcess: hooks });
    await opened;
    fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });

  test("Review Focus 2: a throwing hook does not fail the open", async () => {
    const hooks = {
      spawned: () => {
        throw new Error("embedder bug");
      },
    };
    const { opened } = await openWith(CLAUDE_SCRIPT, { onProcess: hooks }, undefined, [7]);
    await expect(opened).resolves.toBeDefined();
  });
});
```

`backend-reconnect.test.ts`: add an `onProcess` parameter to `open()` (pass it into `acpBackend({...})`), and a `pids` parameter passed to `inMemoryAgent`. Then:

```ts
  test("S4b: onProcess fires for the reconnect's new process too", async () => {
    const seen: string[] = [];
    const onProcess = { spawned: (pid: number) => seen.push(`spawned ${pid}`), exited: (pid: number) => seen.push(`exited ${pid}`) };
    const { fake, session } = await open({ relaunch: { turns: [{ steps: [text("back")] }] } }, [], undefined, onProcess, [11, 12]);
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    await driveTurn(session, "two");
    expect(seen).toEqual(["spawned 11", "exited 11", "spawned 12"]);
  });
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/options.test.ts ./test/unit/client/open.test.ts ./test/unit/client/backend-reconnect.test.ts
```

Expected: FAIL. `onProcess` is rejected by the strict schema, and no hook calls happen.

- [ ] **Step 4: Implement**

`options.ts`:
- Add above `AcpBackendOptions`:

```ts
/** Called for every agent process the backend spawns, including a reconnect's (S4b spec §8). Errors are logged and ignored. */
export interface AcpProcessHooks {
  spawned?(pid: number): void;
  exited?(pid: number): void;
}
```

- In `AcpBackendOptions`: `readonly onProcess?: AcpProcessHooks;`.
- In `ResolvedAcpOptions`: `readonly onProcess: AcpProcessHooks | undefined;`.

Zod cannot usefully validate functions here, so validate `onProcess` by hand and parse the rest. In `resolveAcpOptions`, after the `allowUnsandboxed` check:

```ts
  const { onProcess, ...rest } = input;
  if (onProcess !== undefined && !isProcessHooks(onProcess)) {
    throw new AgentSessionError("Invalid acpBackend options: onProcess: spawned and exited must be functions", "AGENT_SESSION_INVALID_OPTIONS", {
      path: "onProcess",
    });
  }
  const parsed = SCHEMA.safeParse(rest);
```

Here `isProcessHooks` is:

```ts
function isProcessHooks(value: unknown): value is AcpProcessHooks {
  if (!isRecord(value)) return false;
  const fnOrAbsent = (v: unknown) => v === undefined || typeof v === "function";
  return fnOrAbsent(value.spawned) && fnOrAbsent(value.exited);
}
```

Then change `return resolved(parsed.data, source);` to `return resolved(parsed.data, source, onProcess);`. Add a third parameter `onProcess: AcpProcessHooks | undefined` to `resolved()`, and `onProcess,` to its returned object.

`open.ts`, in `openAcpSession`, directly after `const launched = launch({...});`:

```ts
  watchProcess(options.onProcess, launched);
```

And add:

```ts
/** S4b spec §8: report the agent process to the embedder; a throwing hook is logged, never propagated. */
function watchProcess(hooks: AcpProcessHooks | undefined, launched: LaunchedAgent): void {
  const pid = launched.pid;
  if (hooks === undefined || pid === undefined) return;
  const call = (name: "spawned" | "exited") => {
    try {
      hooks[name]?.(pid);
    } catch (err) {
      getLogger().warn("acp", `onProcess.${name} threw; ignored`, { error: err instanceof Error ? err.message : String(err) });
    }
  };
  call("spawned");
  void launched.exited.then(() => call("exited"));
}
```

Import `type AcpProcessHooks` from `#src/client/options`, and `getLogger` from `@nathapp/nax-agent` if Task 4 did not already. Reconnects call `connect()` -> `openAcpSession()`, so the hook covers them with no other change.

`index.ts`: change the options type export to `export type { AcpAgentSpec, AcpBackendOptions, AcpProcessHooks } from "#src/client/options";`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/options.test.ts ./test/unit/client/open.test.ts ./test/unit/client/backend-reconnect.test.ts && bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Docs, snapshot, commit**

- README options: `onProcess?: { spawned?(pid), exited?(pid) }`: "Called for every agent process, including a reconnect's. A throwing hook is logged and ignored. Not called when the spawn fails."
- CHANGELOG `### Added`: `- \`onProcess\` option: \`spawned(pid)\` and \`exited(pid)\` for every agent process, including after a reconnect.`
- `bun run check:api` (then `api:update` if it reports the additions).

```bash
cd packages/nax-agent-acp && bun run test && bun run check:all
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): onProcess hooks for every agent process"
```

---

### Task 6: `resultBytes` on `tool_result`

**Files:**
- Modify: `packages/nax-agent-acp/src/client/tool-events.ts` (`previewOf` neighbourhood near line 150; `resolve` near line 184; the unanswered path near line 203)
- Modify: the existing exact-equality assertions on `tool_result` in `test/unit/client/tool-events.test.ts` and `test/unit/client/backend-events.test.ts`
- Modify: `packages/nax-agent-acp/CHANGELOG.md`
- Test: `packages/nax-agent-acp/test/unit/client/tool-events.test.ts`

**Interfaces:**
- Consumes: Task 2 `TurnEvent` `tool_result.resultBytes?: number`.
- Produces:
  - `resultBytesOf(call: { content?: unknown; rawOutput?: unknown }): number`, exported from `#src/client/tool-events`
  - every agent-tool `tool_result` emitted by `createToolEvents` carries `resultBytes`

- [ ] **Step 1: Write the failing tests**

In `tool-events.test.ts` (add `resultBytesOf` to the import):

```ts
describe("resultBytes (S4b spec §7.4)", () => {
  test("a completed call carries the UTF-8 byte length of its full result", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c1", name: "Read", status: "completed", rawInput: {}, content: [text("héllo")] });
    expect(events.at(-1)).toEqual({ type: "tool_result", callId: "c1", isError: false, preview: "héllo", resultBytes: 6 });
  });

  test("Review Focus 4: bytes count the raw output, not the capped preview", () => {
    const big = "é".repeat(100_000);
    expect(resultBytesOf({ content: [text(big)] })).toBe(200_000);
    expect(resultBytesOf({ rawOutput: "abc" })).toBe(3);
    expect(resultBytesOf({})).toBe(0);
  });

  test("an unanswered call reports 0 bytes", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c9", name: "Bash", status: "in_progress", rawInput: {} });
    tools.finish();
    expect(events.at(-1)).toMatchObject({ type: "tool_result", callId: "c9", isError: true, resultBytes: 0 });
  });
});
```

If the method that answers unannounced calls at turn end is not named `finish`, use the name the `UNANSWERED_PREVIEW` path is reached through (`grep -n "UNANSWERED_PREVIEW" -B12 src/client/tool-events.ts`).

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/tool-events.test.ts
```

Expected: FAIL. `resultBytesOf` is not exported, and events lack `resultBytes`.

- [ ] **Step 3: Implement**

In `tool-events.ts`, after `previewOf`:

```ts
const UTF8 = new TextEncoder();

/** UTF-8 byte length of the full result text, before any cap (S4b spec §7.4). */
export function resultBytesOf(call: { readonly content?: unknown; readonly rawOutput?: unknown }): number {
  const fromContent = contentText(call.content);
  const raw = fromContent !== "" ? fromContent : typeof call.rawOutput === "string" ? call.rawOutput : "";
  return UTF8.encode(raw).byteLength;
}
```

Change `resolve` to take and emit the bytes:

```ts
  const resolve = (state: CallState, isError: boolean, preview: string, resultBytes: number): void => {
    if (state.resolved) return;
    calls.set(state.id, { ...state, resolved: true });
    emit({ type: "tool_result", callId: state.id, isError, preview, resultBytes });
  };
```

Update its two call sites:
- completion: `resolve(shown, status === "failed", previewOf(shown, secrets), resultBytesOf(shown));`
- unanswered: `resolve(state, true, UNANSWERED_PREVIEW, 0);`

If `contentText` caps its output, compute the bytes from the uncapped text. `previewOf` already applies its caps after `contentText` (`capBytes(raw, REDACTION_SCAN_BYTES)`), which indicates `contentText` itself is uncapped. Confirm by reading it. The Review Focus 4 test fails if it is not.

- [ ] **Step 4: Update the existing exact assertions**

```bash
cd packages/nax-agent-acp && bun run test 2>&1 | grep -B2 -A12 "resultBytes" | head -80
```

Every pre-existing `toEqual` on a `tool_result` event now fails only because of the new key. Add the exact `resultBytes` to each: the byte length of that test's result text, or `0` for an unanswered call. Do not switch these assertions to `toMatchObject`, because the exact shape is the contract.

- [ ] **Step 5: Run the suite**

```bash
cd packages/nax-agent-acp && bun run test && bun run test:node && bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Changelog and commit**

CHANGELOG `### Added`: `- \`tool_result\` events carry \`resultBytes\`: the UTF-8 byte length of the full result before the preview cap (0 for a call the turn never answered).`

```bash
cd packages/nax-agent-acp && bun run check:all
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): resultBytes on tool_result events"
```

---

### Task 7: `isAgentLaunchable` and `launchCandidateKind`

**Files:**
- Create: `packages/nax-agent-acp/src/client/launchable.ts`
- Modify: `packages/nax-agent-acp/src/client/index.ts`
- Modify: `packages/nax-agent-acp/README.md`, `CHANGELOG.md`, the API snapshot
- Test: `packages/nax-agent-acp/test/unit/client/launchable.test.ts` (new)

**Interfaces:**
- Consumes: `pickCandidate` from `#src/client/launch`, `registryEntry` and `AcpAgentName` from `#src/client/registry`.
- Produces:
  - `isAgentLaunchable(agent: AcpAgentName, env?: Readonly<Record<string, string | undefined>>): boolean`
  - `launchCandidateKind(agent: AcpAgentName, env?): "local" | "npx" | undefined`
  - both exported from `@nathapp/nax-agent-acp/client`

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/launchable.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { isAgentLaunchable, launchCandidateKind } from "#src/client/launchable";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-launchable-");
});

afterEach(() => cleanupTempDir(dir));

function binDir(...names: string[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return bin;
}

describe("launchCandidateKind / isAgentLaunchable (S4b spec §6.8, §8)", () => {
  test("the local launcher on PATH is local", () => {
    const env = { PATH: binDir("claude-agent-acp", "npx") };
    expect(launchCandidateKind("claude", env)).toBe("local");
    expect(isAgentLaunchable("claude", env)).toBe(true);
  });

  test("only npx on PATH is the npx fallback, still launchable", () => {
    const env = { PATH: binDir("npx") };
    expect(launchCandidateKind("claude", env)).toBe("npx");
    expect(isAgentLaunchable("claude", env)).toBe(true);
  });

  test("an agent with no npx candidate and no launcher is not launchable", () => {
    const env = { PATH: binDir("npx") };
    expect(launchCandidateKind("opencode", env)).toBeUndefined();
    expect(isAgentLaunchable("opencode", env)).toBe(false);
  });

  test("Review Focus 5: PATH unset or empty is not launchable and does not throw", () => {
    expect(isAgentLaunchable("claude", {})).toBe(false);
    expect(isAgentLaunchable("claude", { PATH: "" })).toBe(false);
    expect(launchCandidateKind("claude", {})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/launchable.test.ts
```

Expected: FAIL, because the module `#src/client/launchable` does not exist.

- [ ] **Step 3: Implement**

Create `src/client/launchable.ts`:

```ts
/**
 * Whether a registered agent can be launched on this machine (S4b spec §6.8):
 * the same candidate resolution the backend uses at spawn (§6.10), exposed so an
 * embedder's "is installed" check never duplicates the candidate list. "npx"
 * means only the npx fallback resolves: the first open downloads the launcher.
 */
import { pickCandidate } from "#src/client/launch";
import { type AcpAgentName, registryEntry } from "#src/client/registry";

export type LaunchCandidateKind = "local" | "npx";

export function launchCandidateKind(
  agent: AcpAgentName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LaunchCandidateKind | undefined {
  const found = pickCandidate(registryEntry(agent)?.launch ?? [], env.PATH);
  if (found === undefined) return undefined;
  return found.command === "npx" ? "npx" : "local";
}

export function isAgentLaunchable(
  agent: AcpAgentName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return launchCandidateKind(agent, env) !== undefined;
}
```

In `src/client/index.ts` add:

```ts
export { isAgentLaunchable, type LaunchCandidateKind, launchCandidateKind } from "#src/client/launchable";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/nax-agent-acp && bun test ./test/unit/client/launchable.test.ts && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Docs, snapshot, satellites, commit**

- README: add a short "Is the agent installed?" subsection describing `isAgentLaunchable` and `launchCandidateKind` ("`npx` means only the npx fallback resolves; the first open downloads the launcher").
- CHANGELOG `### Added`: `- \`isAgentLaunchable\` and \`launchCandidateKind\`: whether a registered agent's launcher resolves on PATH, and whether only the npx fallback does.`
- `bun run check:api` (then `api:update` if it reports the exports).

```bash
cd packages/nax-agent-acp && bun run test && bun run check:all
git add packages/nax-agent-acp
git commit -m "feat(nax-agent-acp): isAgentLaunchable and launchCandidateKind"
```

---

### Task 8: Full gates, PR, and release (approval at each publish step)

**Files:**
- No source changes. The release helper edits `package.json` versions, the changelogs and the lockfile in its own PR.

**Interfaces:**
- Consumes: Tasks 2 to 7 (Task 3 only if it ran).
- Produces: `@nathapp/nax-agent@0.3.1` and `@nathapp/nax-agent-acp@0.3.1` on npm `latest`. S4b-2 depends on these.

- [ ] **Step 1: Run every gate from the repo root**

```bash
bun run typecheck && bun run check:all && bun run test
cd packages/nax-agent-acp && bun run test:node && bun run test:coverage
cd ../nax-agent && bun run test:coverage
```

Expected: all PASS, with coverage at or above each package's baseline. Fix any failure in the task that introduced it before continuing.

- [ ] **Step 2: Confirm the changelogs**

```bash
sed -n '/## \[Unreleased\]/,/^## \[/p' packages/nax-agent/CHANGELOG.md packages/nax-agent-acp/CHANGELOG.md
```

Expected: both `## [Unreleased]` sections contain the #2373 fixes (already present) and this slice's `### Added` entries.

- [ ] **Step 3: Push the branch and open the PR (code review before push)**

Request a code review of the branch diff first (superpowers:requesting-code-review), and fix any CRITICAL or HIGH finding, within two fix rounds at most. Then:

```bash
git push -u origin <branch>
gh pr create --title "feat(nax-agent, nax-agent-acp): S4b-0 additive changes for the nax run ACP cutover" --body "<summary of Tasks 2-7, the S4b-0 findings, and the test plan>"
```

- [ ] **Step 4: STOP: maintainer approval to merge, then to release**

Ask the maintainer to merge the PR. Then ask for explicit approval to release. After approval, from `packages/nax-agent` on clean, updated main:

```bash
rtk bun run release --dry-run patch
rtk bun run release patch
```

The helper opens a version PR bumping both packages to 0.3.1. After it merges, ask for approval again before each tag:

```bash
rtk bun run release tag
rtk bun run release tag-acp
```

`tag-acp` runs only after `@nathapp/nax-agent@0.3.1` is visible on npm (`npm view @nathapp/nax-agent@0.3.1 version`).

- [ ] **Step 5: Verify the publish**

```bash
npm view @nathapp/nax-agent@0.3.1 version dist-tags --json
npm view @nathapp/nax-agent-acp@0.3.1 version dist-tags --json
```

Expected: both at 0.3.1 under `latest`. Record the release in the master plan's S4b row.
