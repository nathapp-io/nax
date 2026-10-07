# S4b-1: Move Shared nax Logic out of `agents/acp/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every piece of nax logic that S4b-2's new ACP adapter will share with the acpx adapter out of `packages/nax/src/agents/acp/`, with no behaviour change, so S4b-5 can delete that folder without losing it.

**Architecture:** Pure moves plus three small generalisations that keep behaviour identical:
- an explicit log `stage` parameter where the moved code used to hard-code `"acp-adapter"`;
- an output string instead of the acpx `AcpSessionResponse` as input to the turn-result builder;
- an injectable interaction timeout.

The acpx adapter keeps calling the same logic from its new home. acpx plumbing (argv, line parser, stderr parsing, `sessions ensure|close`, `cancel`, spawning, `acpx set` effort) stays in `agents/acp/`. It is deleted in S4b-5.

**Tech Stack:** TypeScript (ESM), Bun 1.4 (`bun:test`), Biome 2.5.10. Package `packages/nax` only.

**Spec:** `docs/superpowers/specs/2026-10-07-s4b-nax-run-acp-cutover-design.md`, §5.2 (the move table) and §10 row S4b-1. Read §1 (the governing rule: replace the transport, not the logic) before starting.

**Branch:** `feat/s4b-1-shared-logic-moves`, off main `ed33d496d`.

## Global Constraints

- No behaviour change. Every existing test in `test/unit/agents/acp/` passes unchanged, apart from the import-path edits this plan lists.
- `packages/nax-agent/` and `packages/nax-agent-acp/` are not touched. No release, no billed run.
- Run every command from `packages/nax`. Targeted tests: `timeout 30 bun test <path> --timeout=5000`. Full suite: `bun run test`. Never bare `bun test` over the whole tree, never `bun run nax`.
- `src/` code must not import an internal file through the `@/` alias (`check:alias-internals`). Inside `src/agents/` use relative paths to the new barrels (`../interaction`, `../turn`, `../errors`, `../session-naming`). Tests may import internals through `@/`.
- Every directory with two or more exports gets a barrel `index.ts` (`.nax/rules/project-conventions.md`).
- One unit test file per source file, mirroring `src/` under `test/unit/` (`.nax/rules/test-architecture.md`). Never a ticket-named test file (`check:test-satellites`).
- Source files stay under 600 lines and test files under 800 (`check:file-sizes`). The gate refuses growth of a grandfathered file; this plan only shrinks files under `agents/acp/`.
- Ratchet baselines (`complexity`, `logger-storyid`, `test-escape-hatches`, `file-sizes`) may be re-recorded only when the diff moves an existing entry to its new path at the same value, or lowers a value. Paste the baseline diff in the commit body.
- No emojis in code, comments or docs. Conventional commits.

## Decisions (made while writing this plan; D1-b deviates from the spec and needs maintainer confirmation)

| # | Decision |
|---|---|
| D1-a | `createTurnDeadline` is not moved. It already lives in `@nathapp/nax-agent` and `adapter-send-turn.ts` imports it from there. `agents/turn/turn-deadline.ts` gets the `timedOut` result builder and the wall-clock warning only. |
| D1-b | **No `agents/model-effort.ts` in S4b-1 (spec §5.2 row 6 deviation).** The effort parsing at `spawn-client.ts:76-83` is a call to `parseModelSpec`, which already lives in `@nathapp/nax-agent`. The per-agent fallback names are already duplicated into nax-agent-acp (`capabilities.ts:104-110`, S4b-0 Task 4). nax's `EFFORT_OPTION_BY_AGENT` is read only by the acpx `acpx set` path (`reasoning-effort.ts`), which is plumbing. So there is nothing shared to move. S4b-2 creates `model-effort.ts` if its model-alias probe needs a mapping table (spec §6.7). `EFFORT_OPTION_BY_AGENT` stays and is deleted with the folder in S4b-5. |
| D1-c | The abort helpers `raceWithAbort`, `throwIfAborted` and `createAbortError` move to `agents/turn/abort.ts`. The spec's table does not list them, but they are not acpx plumbing and `awaitInteractionReply` needs `raceWithAbort`. Leaving them in `agents/acp/` would make the moved interaction module import the folder S4b-5 deletes. |
| D1-d | The acpx `buildTurnResult(BuildTurnResultInput)` stays in `adapter-output.ts` as a thin wrapper over the new `assembleTurnResult`. Its input keeps `lastResponse: AcpSessionResponse \| null`, which is an acpx wire type. This keeps the `@/agents` barrel API and its existing tests unchanged. It is deleted in S4b-5. |
| D1-e | `awaitInteractionReply` and `warnWallClockTimeout` take the log `stage` as a parameter. The acpx loop passes `"acp-adapter"`, so its log records are unchanged. |
| D1-f | Names are kept (`computeAcpHandle` is not renamed). A rename is not a move and would widen the diff. |
| D1-g | Test relocation: the `computeAcpHandle` describe block moves to `test/unit/agents/session-naming.test.ts`; `context-tool-preamble.test.ts` is merged into `test/unit/agents/tool-preamble.test.ts` (325 lines together); `build-context-tool-result-escape.test.ts` is merged into `test/unit/agents/run-interaction-handler.test.ts` (243 lines); `parse-agent-error.test.ts` is moved with `git mv`. |
| D1-h | `awaitInteractionReply` accepts an optional `timeoutMs`, defaulting to `INTERACTION_TIMEOUT_MS` (5 minutes). This is only so the timeout branch can be unit-tested; every production caller omits it. |
| D1-i | `CONTEXT_TOOL_CALL_PATTERN` stays module-private in its new file. Nothing outside the parser reads it. |
| D1-j | The `buildRunInteractionHandler` and `buildContextToolPreamble` re-exports from `agents/acp/adapter.ts` and `adapter-output.ts` are removed. Every caller imports the defining file instead. |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| Create `src/agents/session-naming.ts` | `computeAcpHandle`: deterministic session name | 1 |
| Create `src/agents/interaction/output-parsing.ts` | `extractQuestion`, `extractContextToolCall`, `ContextToolCall` | 2 |
| Create `src/agents/turn/abort.ts` | `createAbortError`, `throwIfAborted`, `raceWithAbort` | 3 |
| Create `src/agents/interaction/turn-interactions.ts` | `awaitInteractionReply`, `toContextToolInteraction`, `INTERACTION_TIMEOUT_MS`, `INTERACTION_ABORT_MESSAGE` | 4 |
| Create `src/agents/interaction/index.ts` | barrel for `interaction/` | 2, extended in 4 |
| Create `src/agents/turn/turn-deadline.ts` | `assembleTurnResult`, `warnWallClockTimeout` | 5 |
| Create `src/agents/turn/index.ts` | barrel for `turn/` | 3, extended in 5 |
| Modify `src/agents/tool-preamble.ts` | gains `buildContextToolPreamble` and its two render helpers | 6 |
| Move `src/agents/acp/parse-agent-error.ts` -> `src/agents/errors/parse-agent-error.ts` | `parseAgentError`, `classifyParsedAgentError`, `classifyCompleteError` | 7 |
| Create `src/agents/errors/index.ts` | barrel for `errors/` | 7 |
| Modify `src/agents/acp/{adapter,adapter-lifecycle,adapter-output,adapter-send-turn,adapter-complete-flow,index}.ts` | import from the new homes; delete the moved bodies | 1-7 |
| Modify `src/agents/index.ts`, `src/agents/complete-exception-classifier.ts`, `src/runtime/session-run-hop.ts`, `src/operations/build-hop-callback-hop.ts` | import from the new homes | 1, 6, 7 |

---

### Task 1: `computeAcpHandle` -> `agents/session-naming.ts`

**Files:**
- Create: `packages/nax/src/agents/session-naming.ts`
- Create: `packages/nax/test/unit/agents/session-naming.test.ts`
- Modify: `packages/nax/src/agents/acp/adapter-lifecycle.ts` (delete `computeAcpHandle`, lines 133-163, and the `createHash` import if nothing else in the file uses it)
- Modify: `packages/nax/src/agents/acp/adapter.ts:47-55` (drop `computeAcpHandle` from the re-export list)
- Modify: `packages/nax/src/agents/acp/adapter-complete-flow.ts` (import from `../session-naming`)
- Modify: `packages/nax/src/agents/acp/index.ts:14` (delete the `computeAcpHandle` line)
- Modify: `packages/nax/src/agents/index.ts` (export `computeAcpHandle` from `./session-naming` instead of `./acp`)
- Modify: `packages/nax/test/unit/agents/acp/adapter.test.ts:15` and `:586-602` (drop the import and the describe block)

**Interfaces:**
- Produces: `export function computeAcpHandle(workdir: string, featureName?: string, storyId?: string, sessionRole?: string): string`, still reachable as `computeAcpHandle` from `@/agents` (importers: `src/operations/call-dispatch-complete.ts:13`, `test/unit/operations/call-branches.test.ts:21`, unchanged).

- [ ] **Step 1: Write the failing test**

The first two cases are the ones at `test/unit/agents/acp/adapter.test.ts:589-602`, moved verbatim. The rest are new.

```typescript
// test/unit/agents/session-naming.test.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeAcpHandle } from "@/agents/session-naming";

const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

describe("computeAcpHandle", () => {
  const workdir = "/tmp/test-project";

  test("produces stable handle for implementer role", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    const again = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    expect(actual).toBe(again);
  });

  test("includes role suffix for reviewer session", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "reviewer-semantic");
    expect(actual.endsWith("-reviewer-semantic")).toBe(true);
  });

  test("omits absent parts", () => {
    expect(computeAcpHandle("/repo")).toBe(`nax-${hash8("/repo")}`);
    expect(computeAcpHandle("/repo", undefined, "US-1")).toBe(`nax-${hash8("/repo")}-us-1`);
  });

  test("sanitises each part to lowercase dash-separated text and trims dashes", () => {
    expect(computeAcpHandle("/repo", " My Feat!! ", "US_002", "--Reviewer Semantic--")).toBe(
      `nax-${hash8("/repo")}-my-feat-us-002-reviewer-semantic`,
    );
  });

  test("different workdirs give different hashes for the same feature and story", () => {
    expect(computeAcpHandle("/a", "f", "s")).not.toBe(computeAcpHandle("/b", "f", "s"));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/session-naming.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/session-naming'`.

- [ ] **Step 3: Move the function**

Create `src/agents/session-naming.ts` with the function body copied byte for byte from `adapter-lifecycle.ts:137-163`, including its doc comment:

```typescript
/**
 * Session naming shared by every agent transport.
 *
 * Moved out of agents/acp/ in S4b-1 so the ACP SDK transport (S4b-2) and the
 * acpx transport name sessions identically.
 */

import { createHash } from "node:crypto";

/**
 * Compute a deterministic ACP session handle.
 *
 * Format: nax-<gitRootHash8>-<featureName>-<storyId>[-<sessionRole>]
 *
 * The workdir hash (first 8 chars of SHA-256) prevents cross-repo and
 * cross-worktree session name collisions. Each git worktree has a distinct
 * root path, so different worktrees of the same repo get different hashes.
 */
export function computeAcpHandle(
  workdir: string,
  featureName?: string,
  storyId?: string,
  sessionRole?: string,
): string {
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  const sanitize = (s: string) =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "");

  const parts = ["nax", hash];
  if (featureName) parts.push(sanitize(featureName));
  if (storyId) parts.push(sanitize(storyId));
  if (sessionRole) parts.push(sanitize(sessionRole));
  return parts.join("-");
}
```

Then:
- delete the `// Session naming` section and the function from `adapter-lifecycle.ts`. Run `grep -n createHash src/agents/acp/adapter-lifecycle.ts` and delete the import only if no use is left.
- `adapter-complete-flow.ts`: change `import { _fallbackDeps, computeAcpHandle } from "./adapter-lifecycle";` to `import { _fallbackDeps } from "./adapter-lifecycle";` plus `import { computeAcpHandle } from "../session-naming";`.
- `adapter.ts`: remove `computeAcpHandle,` from the `export { ... } from "./adapter-lifecycle"` block. Run `grep -n computeAcpHandle src/agents/acp/adapter.ts`. If the class body uses it, add `import { computeAcpHandle } from "../session-naming";`.
- `acp/index.ts`: delete `export { computeAcpHandle } from "./adapter-lifecycle";`.
- `agents/index.ts`: remove `computeAcpHandle,` from the `from "./acp"` value-export block and add `export { computeAcpHandle } from "./session-naming";`.
- `test/unit/agents/acp/adapter.test.ts`: remove `computeAcpHandle` from the line-15 import and delete the describe block (lines 586-602 with its section comment).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/session-naming.test.ts test/unit/agents/acp/ test/unit/operations/call-branches.test.ts --timeout=5000`
Expected: PASS, with the same number of tests in `test/unit/agents/acp/` as before minus the two moved cases.

Run: `bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.test.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents
git commit -m "refactor(nax): move computeAcpHandle to agents/session-naming (S4b-1)"
```

---

### Task 2: Output parsing -> `agents/interaction/output-parsing.ts`

**Files:**
- Create: `packages/nax/src/agents/interaction/output-parsing.ts`
- Create: `packages/nax/src/agents/interaction/index.ts`
- Create: `packages/nax/test/unit/agents/interaction/output-parsing.test.ts`
- Modify: `packages/nax/src/agents/acp/adapter-output.ts` (delete `CONTEXT_TOOL_CALL_PATTERN`, `extractQuestion`, `extractContextToolCall`)
- Modify: `packages/nax/src/agents/acp/adapter-send-turn.ts:28` (import the two parsers from `../interaction`)

**Interfaces:**
- Produces:
  - `export interface ContextToolCall { name: string; input?: unknown; error?: string }`
  - `export function extractQuestion(output: string): string | null`
  - `export function extractContextToolCall(output: string): ContextToolCall | null`
  - all three re-exported from `src/agents/interaction/index.ts`

- [ ] **Step 1: Write the failing test**

These functions had no direct unit tests. Only the acpx `sendTurn` tests reached them. These cases pin the behaviour documented in their comments (BUG-097, the two-paragraph context).

```typescript
// test/unit/agents/interaction/output-parsing.test.ts
import { describe, expect, test } from "bun:test";
import { extractContextToolCall, extractQuestion } from "@/agents/interaction/output-parsing";

describe("extractQuestion", () => {
  test("returns null for empty or whitespace output", () => {
    expect(extractQuestion("")).toBeNull();
    expect(extractQuestion("  \n\n ")).toBeNull();
  });

  test("detects a last line ending in ? longer than 10 chars", () => {
    expect(extractQuestion("Done.\n\nShould the cache be cleared first?")).toBe(
      "Done.\n\nShould the cache be cleared first?",
    );
  });

  test("ignores a last line of 10 chars or fewer ending in ?", () => {
    expect(extractQuestion("Finished the change.\nOk?")).toBeNull();
  });

  test("BUG-097: a ? mid-output (optional chaining) is not a question", () => {
    expect(extractQuestion("const a = b?.c ?? d;\nImplemented the change.")).toBeNull();
  });

  test("detects keyword markers on the last line, case-insensitively", () => {
    expect(extractQuestion("Two options exist.\nPlease confirm the target branch.")).toBe(
      "Two options exist.\nPlease confirm the target branch.",
    );
    expect(extractQuestion("x\nDo You Want me to proceed with the migration")).toBe(
      "x\nDo You Want me to proceed with the migration",
    );
  });

  test("a marker on an earlier line does not count", () => {
    expect(extractQuestion("Please confirm later.\nImplemented everything.")).toBeNull();
  });

  test("returns only the last two paragraphs", () => {
    const out = "Table here\n\nConclusion: both paths work.\n\nWhich would you prefer, A or B?";
    expect(extractQuestion(out)).toBe("Conclusion: both paths work.\n\nWhich would you prefer, A or B?");
  });
});

describe("extractContextToolCall", () => {
  test("returns null when no call block is present", () => {
    expect(extractContextToolCall("plain output")).toBeNull();
  });

  test("parses the name and JSON input", () => {
    const out = 'text\n<nax_tool_call name="query_neighbor">\n{"filePath": "src/a.ts"}\n</nax_tool_call>';
    expect(extractContextToolCall(out)).toEqual({ name: "query_neighbor", input: { filePath: "src/a.ts" } });
  });

  test("an empty body becomes an empty object", () => {
    expect(extractContextToolCall('<nax_tool_call name="t">  </nax_tool_call>')).toEqual({ name: "t", input: {} });
  });

  test("invalid JSON yields an error, not a throw", () => {
    const result = extractContextToolCall('<nax_tool_call name="t">{bad</nax_tool_call>');
    expect(result?.name).toBe("t");
    expect(result?.input).toBeUndefined();
    expect(result?.error).toStartWith("Invalid JSON tool input: ");
  });

  test("the tag match is case-insensitive and takes the first block", () => {
    const out = '<NAX_TOOL_CALL name="first">{}</NAX_TOOL_CALL>\n<nax_tool_call name="second">{}</nax_tool_call>';
    expect(extractContextToolCall(out)?.name).toBe("first");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/interaction/output-parsing.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/interaction/output-parsing'`.

- [ ] **Step 3: Move the functions**

Create `src/agents/interaction/output-parsing.ts`. Copy `CONTEXT_TOOL_CALL_PATTERN` (not exported), `extractQuestion` and `extractContextToolCall` byte for byte from `adapter-output.ts:13` and `:28-89`, keeping every comment. Change only the return type of `extractContextToolCall` to the named `ContextToolCall | null`. File header:

```typescript
/**
 * Parsing of agent output for mid-turn interactions: a human question or a
 * `<nax_tool_call>` context-tool request (the text protocol, spec B5).
 *
 * Moved out of agents/acp/ in S4b-1. Both ACP transports read the same
 * reply text, so they share one parser.
 */

/** A `<nax_tool_call>` request parsed from agent output. `error` is set when the JSON body is invalid. */
export interface ContextToolCall {
  name: string;
  input?: unknown;
  error?: string;
}
```

Create `src/agents/interaction/index.ts`:

```typescript
export type { ContextToolCall } from "./output-parsing";
export { extractContextToolCall, extractQuestion } from "./output-parsing";
```

In `adapter-output.ts`, delete the pattern constant, the `// Context tool helpers` banner's `extractContextToolCall`, and `extractQuestion`. Keep `extractOutput`, which reads the acpx response shape. In `adapter-send-turn.ts`, replace line 28 with:

```typescript
import { extractContextToolCall, extractQuestion } from "../interaction";
import { buildTurnResult, extractOutput } from "./adapter-output";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/interaction/ test/unit/agents/acp/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents
git commit -m "refactor(nax): move question and context-tool parsing to agents/interaction (S4b-1)"
```

---

### Task 3: Abort helpers -> `agents/turn/abort.ts`

**Files:**
- Create: `packages/nax/src/agents/turn/abort.ts`
- Create: `packages/nax/src/agents/turn/index.ts`
- Create: `packages/nax/test/unit/agents/turn/abort.test.ts`
- Modify: `packages/nax/src/agents/acp/adapter-lifecycle.ts:88-130` (delete the `// Abort helpers` section)
- Modify: `packages/nax/src/agents/acp/adapter.ts:30-37` and `packages/nax/src/agents/acp/adapter-send-turn.ts:20-26` (import `raceWithAbort` / `throwIfAborted` from `../turn`)

**Interfaces:**
- Produces:
  - `export function createAbortError(signal?: AbortSignal, fallback?: string): Error`
  - `export function throwIfAborted(signal?: AbortSignal, fallback?: string): void`
  - `export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, fallback?: string): Promise<T>`
  - all three re-exported from `src/agents/turn/index.ts`
- Consumed by: Task 4 (`raceWithAbort`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/turn/abort.test.ts
import { describe, expect, test } from "bun:test";
import { createAbortError, raceWithAbort, throwIfAborted } from "@/agents/turn/abort";

describe("createAbortError", () => {
  test("returns an Error reason as is", () => {
    const reason = new Error("boom");
    const ctl = new AbortController();
    ctl.abort(reason);
    expect(createAbortError(ctl.signal)).toBe(reason);
  });

  test("wraps a non-empty string reason", () => {
    const ctl = new AbortController();
    ctl.abort("shutdown");
    expect(createAbortError(ctl.signal).message).toBe("shutdown");
  });

  test("falls back for an empty or non-string reason, default 'Run aborted'", () => {
    const ctl = new AbortController();
    ctl.abort("");
    expect(createAbortError(ctl.signal, "custom").message).toBe("custom");
    expect(createAbortError(undefined).message).toBe("Run aborted");
  });
});

describe("throwIfAborted", () => {
  test("does nothing without a signal or when not aborted", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  test("throws the abort error when aborted", () => {
    const ctl = new AbortController();
    ctl.abort("stop");
    expect(() => throwIfAborted(ctl.signal)).toThrow("stop");
  });
});

describe("raceWithAbort", () => {
  test("passes the promise through without a signal", async () => {
    expect(await raceWithAbort(Promise.resolve(7))).toBe(7);
  });

  test("rejects at once when the signal is already aborted", async () => {
    // An empty-string reason selects the fallback message; a bare abort() would
    // carry a DOMException reason, which createAbortError returns as is.
    const ctl = new AbortController();
    ctl.abort("");
    await expect(raceWithAbort(new Promise(() => {}), ctl.signal, "fb")).rejects.toThrow("fb");
  });

  test("rejects when the signal aborts before the promise settles", async () => {
    const ctl = new AbortController();
    const raced = raceWithAbort(new Promise(() => {}), ctl.signal, "fb");
    ctl.abort("late");
    await expect(raced).rejects.toThrow("late");
  });

  test("propagates the promise's own rejection", async () => {
    const ctl = new AbortController();
    await expect(raceWithAbort(Promise.reject(new Error("inner")), ctl.signal)).rejects.toThrow("inner");
  });

  test("an abort after resolution has no effect", async () => {
    const ctl = new AbortController();
    expect(await raceWithAbort(Promise.resolve("ok"), ctl.signal)).toBe("ok");
    expect(() => ctl.abort()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/turn/abort.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/turn/abort'`.

- [ ] **Step 3: Move the helpers**

Create `src/agents/turn/abort.ts`. Copy `createAbortError` (now exported), `throwIfAborted` and `raceWithAbort` byte for byte from `adapter-lifecycle.ts:88-130`. Header:

```typescript
/**
 * Abort helpers shared by every agent transport's turn loop.
 *
 * Moved out of agents/acp/adapter-lifecycle.ts in S4b-1 (decision D1-c): the
 * interaction race in agents/interaction needs raceWithAbort, and nothing
 * here is acpx plumbing.
 */
```

Create `src/agents/turn/index.ts`:

```typescript
export { createAbortError, raceWithAbort, throwIfAborted } from "./abort";
```

Delete the section from `adapter-lifecycle.ts`. Run `grep -n "raceWithAbort\|throwIfAborted\|createAbortError" src/agents/acp/*.ts`. For every remaining use in `adapter-lifecycle.ts` itself, add `import { raceWithAbort, throwIfAborted } from "../turn";` (only the names used). In `adapter.ts` and `adapter-send-turn.ts`, remove the names from the `./adapter-lifecycle` import and add `import { raceWithAbort, throwIfAborted } from "../turn";`, again only the names each file uses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/turn/ test/unit/agents/acp/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents
git commit -m "refactor(nax): move abort helpers to agents/turn (S4b-1)"
```

---

### Task 4: Interaction reply race -> `agents/interaction/turn-interactions.ts`

**Files:**
- Create: `packages/nax/src/agents/interaction/turn-interactions.ts`
- Modify: `packages/nax/src/agents/interaction/index.ts`
- Create: `packages/nax/test/unit/agents/interaction/turn-interactions.test.ts`
- Modify: `packages/nax/src/agents/acp/adapter-send-turn.ts` (delete `INTERACTION_TIMEOUT_MS`, `ABORT_MESSAGE`, `InteractionReply`, `awaitInteractionReply` and the inline interaction shaping in `handleContextToolCall`; call the moved versions)

**Interfaces:**
- Consumes: `raceWithAbort` from `../turn` (Task 3).
- Produces:

```typescript
export const INTERACTION_TIMEOUT_MS: number; // 5 * 60 * 1000
export const INTERACTION_ABORT_MESSAGE: string; // "Run aborted — shutdown in progress"
export type InteractionReply = { kind: "answered"; answer: string } | { kind: "aborted" } | { kind: "no-reply" };
export interface InteractionReplyContext {
  readonly interactionHandler: InteractionHandler; // from @nathapp/nax-agent
  readonly signal?: AbortSignal;
  /** Logger stage for the failure warning; the acpx loop passes "acp-adapter" (D1-e). */
  readonly stage: string;
  /** Test seam (D1-h); production callers omit it. */
  readonly timeoutMs?: number;
}
export function awaitInteractionReply(
  ctx: InteractionReplyContext,
  interaction: AdapterInteraction,
  warnSuffix: string,
): Promise<InteractionReply>;
export function toContextToolInteraction(toolCall: ContextToolCall): AdapterInteraction;
```

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/interaction/turn-interactions.test.ts
import { describe, expect, test } from "bun:test";
import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { withWarnSpy } from "@test/helpers";
import { awaitInteractionReply, toContextToolInteraction } from "@/agents/interaction/turn-interactions";

const handler = (fn: InteractionHandler["onInteraction"]): InteractionHandler => ({ onInteraction: fn });
const question: AdapterInteraction = { kind: "question", text: "Which branch?" };

describe("awaitInteractionReply", () => {
  test("answered when the handler replies", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(async () => ({ answer: "main" })), stage: "acp-adapter" },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "answered", answer: "main" });
  });

  test("no-reply when the handler returns null", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(async () => null), stage: "acp-adapter" },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "no-reply" });
  });

  test("no-reply when the human-reply timeout fires first", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(() => new Promise(() => {})), stage: "acp-adapter", timeoutMs: 10 },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "no-reply" });
  });

  test("a handler failure is logged under the given stage with the suffix, then no-reply", async () => {
    await withWarnSpy(async (warnSpy) => {
      const reply = await awaitInteractionReply(
        {
          interactionHandler: handler(async () => {
            throw new Error("webhook down");
          }),
          stage: "acp-adapter",
        },
        question,
        " for context-tool: ",
      );
      expect(reply).toEqual({ kind: "no-reply" });
      expect(warnSpy.mock.calls[0]?.[0]).toBe("acp-adapter");
      expect(warnSpy.mock.calls[0]?.[1]).toBe("InteractionHandler.onInteraction failed for context-tool: webhook down");
    });
  });

  test("aborted when the signal aborts during the wait", async () => {
    const ctl = new AbortController();
    const pending = awaitInteractionReply(
      { interactionHandler: handler(() => new Promise(() => {})), signal: ctl.signal, stage: "acp-adapter" },
      question,
      ": ",
    );
    ctl.abort();
    expect(await pending).toEqual({ kind: "aborted" });
  });
});

describe("toContextToolInteraction", () => {
  test("carries the input when there is no error", () => {
    expect(toContextToolInteraction({ name: "q", input: { a: 1 } })).toEqual({
      kind: "context-tool",
      name: "q",
      input: { a: 1 },
    });
  });

  test("carries only the error when parsing failed", () => {
    expect(toContextToolInteraction({ name: "q", error: "Invalid JSON tool input: x" })).toEqual({
      kind: "context-tool",
      name: "q",
      error: "Invalid JSON tool input: x",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/interaction/turn-interactions.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/interaction/turn-interactions'`.

- [ ] **Step 3: Move the race**

Create `src/agents/interaction/turn-interactions.ts`. The body of `awaitInteractionReply` is the one at `adapter-send-turn.ts:232-259`, with three substitutions: `frame.opts.interactionHandler` -> `ctx.interactionHandler`, `frame.opts.signal` -> `ctx.signal`, the literal `"acp-adapter"` -> `ctx.stage`, and `INTERACTION_TIMEOUT_MS` -> `ctx.timeoutMs ?? INTERACTION_TIMEOUT_MS`. Keep its doc comment and add the move note.

```typescript
/**
 * The mid-turn interaction race shared by both ACP transports' turn loops:
 * the interaction handler's reply against the fixed human-reply timeout and
 * the run's abort signal.
 *
 * Moved out of agents/acp/adapter-send-turn.ts in S4b-1.
 */

import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import { raceWithAbort } from "../turn";
import type { ContextToolCall } from "./output-parsing";

/** Time a human has to answer a mid-turn question or context-tool call. */
export const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;
export const INTERACTION_ABORT_MESSAGE = "Run aborted — shutdown in progress";

export type InteractionReply = { kind: "answered"; answer: string } | { kind: "aborted" } | { kind: "no-reply" };

export interface InteractionReplyContext {
  readonly interactionHandler: InteractionHandler;
  readonly signal?: AbortSignal;
  /** Logger stage for the failure warning; the acpx loop passes "acp-adapter". */
  readonly stage: string;
  /** Test seam only; production callers omit it and get INTERACTION_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * The interaction race shared by the context-tool and question branches:
 * handler reply vs. the fixed human-response timeout, with the abort check
 * and the failure warn. `warnSuffix` completes the warn message verbatim
 * (" for context-tool: ..." vs ": ...").
 */
export async function awaitInteractionReply(
  ctx: InteractionReplyContext,
  interaction: AdapterInteraction,
  warnSuffix: string,
): Promise<InteractionReply> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      raceWithAbort(ctx.interactionHandler.onInteraction(interaction), ctx.signal, INTERACTION_ABORT_MESSAGE),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), ctx.timeoutMs ?? INTERACTION_TIMEOUT_MS);
      }),
    ]);
    if (response) {
      return { kind: "answered", answer: response.answer };
    }
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { kind: "aborted" };
    }
    getSafeLogger()?.warn(
      ctx.stage,
      `InteractionHandler.onInteraction failed${warnSuffix}${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
  return { kind: "no-reply" };
}

/** Shape a parsed `<nax_tool_call>` into the handler's context-tool interaction. */
export function toContextToolInteraction(toolCall: ContextToolCall): AdapterInteraction {
  return toolCall.error
    ? { kind: "context-tool", name: toolCall.name, error: toolCall.error }
    : { kind: "context-tool", name: toolCall.name, input: toolCall.input };
}
```

Extend `src/agents/interaction/index.ts`:

```typescript
export type { ContextToolCall } from "./output-parsing";
export { extractContextToolCall, extractQuestion } from "./output-parsing";
export type { InteractionReply, InteractionReplyContext } from "./turn-interactions";
export {
  awaitInteractionReply,
  INTERACTION_ABORT_MESSAGE,
  INTERACTION_TIMEOUT_MS,
  toContextToolInteraction,
} from "./turn-interactions";
```

In `adapter-send-turn.ts`:
- delete `INTERACTION_TIMEOUT_MS`, `ABORT_MESSAGE`, `type InteractionReply` and `awaitInteractionReply`;
- extend the `../interaction` import with `awaitInteractionReply` and `toContextToolInteraction`;
- add one private helper and use it at both call sites:

```typescript
function replyContext(frame: SendTurnFrame): InteractionReplyContext {
  return { interactionHandler: frame.opts.interactionHandler, signal: frame.opts.signal, stage: "acp-adapter" };
}
```

- in `handleContextToolCall`, keep the BUG-18 comment. Replace the inline ternary with `const interaction = toContextToolInteraction(toolCall);` and the call with `awaitInteractionReply(replyContext(frame), interaction, " for context-tool: ")`. Type the `toolCall` parameter as `ContextToolCall` (type-only import from `../interaction`).
- in `handleQuestion`: `awaitInteractionReply(replyContext(frame), { kind: "question", text: question }, ": ")`.
- remove `raceWithAbort` from the file's imports if nothing else uses it there, and the `AdapterInteraction` type import if it is now unused.

`SendTurnOpts.interactionHandler` is required (`packages/nax-agent/src/session/session-types.ts:203`) and `signal` is optional, which matches `InteractionReplyContext`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/interaction/ test/unit/agents/acp/ --timeout=5000`
Expected: PASS. `adapter-send-turn-edges.test.ts` and `adapter-phase-a.test.ts` exercise both interaction branches through `sendTurn`.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents
git commit -m "refactor(nax): move the interaction reply race to agents/interaction (S4b-1)"
```

---

### Task 5: Turn result builder and wall-clock warning -> `agents/turn/turn-deadline.ts`

**Files:**
- Create: `packages/nax/src/agents/turn/turn-deadline.ts`
- Modify: `packages/nax/src/agents/turn/index.ts`
- Create: `packages/nax/test/unit/agents/turn/turn-deadline.test.ts`
- Modify: `packages/nax/src/agents/acp/adapter-output.ts` (`buildTurnResult` becomes a wrapper, D1-d)
- Modify: `packages/nax/src/agents/acp/adapter-lifecycle.ts` (delete `warnWallClockTimeout`)
- Modify: `packages/nax/src/agents/acp/adapter-send-turn.ts` (call `warnWallClockTimeout(..., "acp-adapter")` from `../turn`)

**Interfaces:**
- Produces:

```typescript
export interface AssembleTurnResultInput {
  /** The last response's assistant text; ignored (forced to "") when timedOut. */
  output: string;
  totalTokenUsage: TokenUsage;
  totalExactCostUsd: number | undefined;
  turnCount: number;
  interactions: readonly InteractionExchange[];
  timedOut: boolean;
  rateCard: RateCard;
}
export function assembleTurnResult(input: AssembleTurnResultInput): TurnResult;
export function warnWallClockTimeout(sessionName: string, timeoutSeconds: number, stage: string): void;
```

- Unchanged for callers: `buildTurnResult(input: BuildTurnResultInput): TurnResult` in `agents/acp/adapter-output.ts`, still exported from `@/agents`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/agents/turn/turn-deadline.test.ts
import { describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import type { RateCard } from "@/agents/cost";
import { assembleTurnResult, warnWallClockTimeout } from "@/agents/turn/turn-deadline";
import { toPricing } from "@/config/schema-types";

const card: RateCard = { rates: toPricing({ inputPer1M: 2, outputPer1M: 10 }), source: "catalog-rates" };
const base = {
  output: "final text",
  totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
  totalExactCostUsd: undefined,
  turnCount: 1,
  interactions: [],
  timedOut: false,
  rateCard: card,
};

describe("assembleTurnResult", () => {
  test("a timed-out turn returns empty output and timedOut=true", () => {
    const result = assembleTurnResult({ ...base, timedOut: true });
    expect(result.output).toBe("");
    expect(result.timedOut).toBe(true);
  });

  test("zero usage prices nothing: cost 0, rates omitted, source still stamped", () => {
    const result = assembleTurnResult(base);
    expect(result.output).toBe("final text");
    expect(result.estimatedCostUsd).toBe(0);
    expect("rates" in result).toBe(false);
    expect(result.pricingSource).toBe("catalog-rates");
  });

  test("nonzero usage is priced from the card and forwards the rates", () => {
    const result = assembleTurnResult({
      ...base,
      totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(result.estimatedCostUsd).toBeCloseTo(12, 10);
    expect(result.rates?.input).toBe(2);
    expect(result.rates?.output).toBe(10);
  });

  test("exact cost and round trips pass through; interactions only when non-empty", () => {
    const withNone = assembleTurnResult({ ...base, totalExactCostUsd: 0.5, turnCount: 3 });
    expect(withNone.exactCostUsd).toBe(0.5);
    expect(withNone.internalRoundTrips).toBe(3);
    expect("interactions" in withNone).toBe(false);

    const exchange = { turnIndex: 1, question: "q?", reply: "a" };
    expect(assembleTurnResult({ ...base, interactions: [exchange] }).interactions).toEqual([exchange]);
  });
});

describe("warnWallClockTimeout", () => {
  test("logs under the given stage with the session and limit", async () => {
    await withWarnSpy(async (warnSpy) => {
      warnWallClockTimeout("nax-abc-f-s", 600, "acp-adapter");
      expect(warnSpy.mock.calls[0]).toEqual([
        "acp-adapter",
        "wall-clock timeout exceeded — session terminated",
        { sessionName: "nax-abc-f-s", timeoutSeconds: 600 },
      ]);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/turn/turn-deadline.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/turn/turn-deadline'`.

- [ ] **Step 3: Move the builder and the warning**

Create `src/agents/turn/turn-deadline.ts`:
- `assembleTurnResult` is the body of `buildTurnResult` (`adapter-output.ts:280-302`). The only change is `const output = timedOut ? "" : input.output;` in place of `extractOutput(lastResponse)`. Keep the full US-001 and US-002 doc comment.
- `warnWallClockTimeout` is copied from `adapter-lifecycle.ts:270-280`, with the stage taken from the new third parameter.

```typescript
/**
 * Turn-result assembly and the wall-clock timeout warning, shared by both ACP
 * transports. The deadline itself is createTurnDeadline from
 * @nathapp/nax-agent (decision D1-a).
 *
 * Moved out of agents/acp/ in S4b-1.
 */

import { getSafeLogger } from "@/logger";
import type { RateCard, TokenUsage } from "../cost";
import { priceCall } from "../cost";
import type { InteractionExchange, TurnResult } from "../types";

export interface AssembleTurnResultInput {
  /** The last response's assistant text; ignored (forced to "") when timedOut. */
  output: string;
  /** Accumulated token usage across all turns. */
  totalTokenUsage: TokenUsage;
  /** Accumulated wire-reported exact cost (undefined when the transport never reported one). */
  totalExactCostUsd: number | undefined;
  /** Number of prompt round trips made. */
  turnCount: number;
  /** Mid-turn human-in-the-loop exchanges (issue #1226). */
  interactions: readonly InteractionExchange[];
  /** True when the turn returned because the wall-clock timeout elapsed (US-001). */
  timedOut: boolean;
  /** Resolved rate card (US-002). */
  rateCard: RateCard;
}

/** <the full doc comment from adapter-output.ts:259-279, unchanged> */
export function assembleTurnResult(input: AssembleTurnResultInput): TurnResult {
  const { totalTokenUsage, totalExactCostUsd, turnCount, interactions, timedOut, rateCard } = input;
  const output = timedOut ? "" : input.output;
  const hasUsage = totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0;
  // Single `priceCall` invocation: both `costUsd` and `resolvedRates` come
  // from the same call so they cannot diverge — the verifiability property
  // the story names ("recorded rates reproduce recorded cost") would
  // silently break if tier selection ever grew a side channel.
  const priced = hasUsage ? priceCall(totalTokenUsage, rateCard.rates) : undefined;
  return {
    output,
    tokenUsage: totalTokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    exactCostUsd: totalExactCostUsd,
    internalRoundTrips: turnCount,
    ...(interactions.length > 0 ? { interactions } : {}),
    timedOut,
    pricingSource: rateCard.source,
    // US-002: forward the four per-1M rates that priced the turn. Omitted
    // when the nonzero-usage guard skipped pricing — see comment above.
    ...(priced?.resolvedRates !== undefined ? { rates: priced.resolvedRates } : {}),
  };
}

/**
 * Explicit log to distinguish a wall-clock timeout from the idle watchdog
 * (fail-stale). Shared by sendTurn's pre-flight deadline check and its
 * per-turn prompt timeout branch.
 */
export function warnWallClockTimeout(sessionName: string, timeoutSeconds: number, stage: string): void {
  getSafeLogger()?.warn(stage, "wall-clock timeout exceeded — session terminated", {
    sessionName,
    timeoutSeconds,
  });
}
```

Extend `src/agents/turn/index.ts`:

```typescript
export { createAbortError, raceWithAbort, throwIfAborted } from "./abort";
export type { AssembleTurnResultInput } from "./turn-deadline";
export { assembleTurnResult, warnWallClockTimeout } from "./turn-deadline";
```

In `adapter-output.ts`, keep `BuildTurnResultInput` and its doc comment. Replace the `buildTurnResult` body with the wrapper, and drop the `priceCall` import only if `deriveTokenUsage` no longer uses it (it does, so it stays):

```typescript
/**
 * acpx wrapper over the shared `assembleTurnResult` (S4b-1, D1-d): reads the
 * assistant text off the acpx response shape. Deleted with agents/acp/ in S4b-5.
 */
export function buildTurnResult(input: BuildTurnResultInput): TurnResult {
  const { lastResponse, ...rest } = input;
  return assembleTurnResult({ ...rest, output: extractOutput(lastResponse) });
}
```

Add `import { assembleTurnResult } from "../turn";`. `extractOutput(null)` returns `""` and is pure, so calling it on a timed-out turn changes nothing.

Delete `warnWallClockTimeout` from `adapter-lifecycle.ts`. In `adapter-send-turn.ts`, remove it from the `./adapter-lifecycle` import, add it to the `../turn` import, and pass `"acp-adapter"` as the third argument at both call sites (the deadline-expired branch and the `turnResult.timedOut` branch).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/turn/ test/unit/agents/acp/ --timeout=5000`
Expected: PASS. The existing `buildTurnResult` describes in `adapter-complete-rates.test.ts:375` and `adapter-rate-card-pricing.test.ts:548` now pin the wrapper.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents
git commit -m "refactor(nax): move turn-result assembly and wall-clock warning to agents/turn (S4b-1)"
```

---

### Task 6: `buildContextToolPreamble` -> `agents/tool-preamble.ts`, and removal of the `buildRunInteractionHandler` re-export

**Files:**
- Modify: `packages/nax/src/agents/tool-preamble.ts` (receives `buildContextToolPreamble`, `renderCallExample`, `renderToolArguments`)
- Modify: `packages/nax/src/agents/acp/adapter-output.ts` (delete the three functions and `export { buildRunInteractionHandler } from "../run-interaction-handler";` at line 198)
- Modify: `packages/nax/src/agents/acp/adapter.ts:56-62` (drop `buildContextToolPreamble` and `buildRunInteractionHandler` from the re-export list)
- Modify: `packages/nax/src/runtime/session-run-hop.ts:1` -> `import { buildRunInteractionHandler } from "../agents/run-interaction-handler";`
- Modify: `packages/nax/src/operations/build-hop-callback-hop.ts:24` -> same import path from `../agents/run-interaction-handler`
- Modify: `packages/nax/test/helpers/fake-agent-manager.ts:2` -> two imports: `buildContextToolPreamble` from `@/agents/tool-preamble`, `buildRunInteractionHandler` from `@/agents/run-interaction-handler`
- Merge: `packages/nax/test/unit/agents/acp/context-tool-preamble.test.ts` into `packages/nax/test/unit/agents/tool-preamble.test.ts`, then delete the old file
- Merge: `packages/nax/test/unit/agents/acp/build-context-tool-result-escape.test.ts` into `packages/nax/test/unit/agents/run-interaction-handler.test.ts`, then delete the old file

**Interfaces:**
- Produces: `export function buildContextToolPreamble(options: AgentRunOptions): string` in `src/agents/tool-preamble.ts`, same behaviour. `promptWithToolPreamble` (same file) now calls it locally.

- [ ] **Step 1: Re-point the tests first (they become the failing tests)**

Append the describe blocks of `test/unit/agents/acp/context-tool-preamble.test.ts` to `test/unit/agents/tool-preamble.test.ts`. Merge its imports into the existing import block and change the import of `buildContextToolPreamble` to `@/agents/tool-preamble`. Keep the old file's header comment as a comment above the moved blocks. Delete the old file with `git rm`.

Do the same for `test/unit/agents/acp/build-context-tool-result-escape.test.ts` into `test/unit/agents/run-interaction-handler.test.ts`, importing `buildRunInteractionHandler` from `@/agents/run-interaction-handler`. Delete the old file with `git rm`.

If a merged file reuses a helper name the target already declares, rename the moved helper with a suffix and keep both.

- [ ] **Step 2: Run them to verify the preamble test fails**

Run: `timeout 30 bun test test/unit/agents/tool-preamble.test.ts test/unit/agents/run-interaction-handler.test.ts --timeout=5000`
Expected: `tool-preamble.test.ts` FAILS with an import error (`buildContextToolPreamble` is not exported from `@/agents/tool-preamble`). `run-interaction-handler.test.ts` PASSES, since the handler already lives there.

- [ ] **Step 3: Move the preamble**

Move `renderCallExample`, `renderToolArguments` and `buildContextToolPreamble` byte for byte from `adapter-output.ts:94-196` into `src/agents/tool-preamble.ts`, below the imports and above `promptWithToolPreamble`. Keep every comment, including the orphaned "Render a pull tool's JSON Schema" doc block. It sits above `renderCallExample` today, but it describes `renderToolArguments`, so move it to sit directly above `renderToolArguments`. Export `buildContextToolPreamble` only. Add `import type { ToolDescriptor } from "@/context/engine";` (type-only, so `check:alias-internals` allows it). Delete `import { buildContextToolPreamble } from "./acp/adapter-output";`.

Update the file's header comment. The sentence "Imports are relative because `@/agents/acp/adapter-output` is an internal file ..." no longer applies. Replace it with: "The text-protocol catalogue renderer (`buildContextToolPreamble`) lives here, beside its only production caller; it moved out of agents/acp/ in S4b-1."

Then in `adapter-output.ts`, delete the three functions, the re-export line and the `ToolDescriptor` and `AgentRunOptions` imports if now unused. In `adapter.ts`, drop the two names from the re-export block. Update the three importers listed under Files. Run `grep -rn "buildContextToolPreamble\|buildRunInteractionHandler" src test | grep "acp/"`. It must print nothing except comments. Then update any comment that names the old path (`src/agents/run-interaction-handler.ts:6` mentions the Phase B trap; leave historical comments that describe the past as they are).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/ test/unit/runtime/ test/unit/operations/ --timeout=5000`
Expected: PASS. If it hits the 30 s cap, run the three directories one at a time.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src test
git add src test
git commit -m "refactor(nax): move the context-tool preamble beside its caller, drop acp re-exports (S4b-1)"
```

---

### Task 7: `parse-agent-error.ts` -> `agents/errors/`

**Files:**
- Move: `packages/nax/src/agents/acp/parse-agent-error.ts` -> `packages/nax/src/agents/errors/parse-agent-error.ts` (`git mv`; its only import, `../types`, resolves unchanged from the new folder)
- Create: `packages/nax/src/agents/errors/index.ts`
- Move: `packages/nax/test/unit/agents/acp/parse-agent-error.test.ts` -> `packages/nax/test/unit/agents/errors/parse-agent-error.test.ts` (`git mv`)
- Modify: `packages/nax/src/agents/acp/adapter-lifecycle.ts:15`, `packages/nax/src/agents/acp/adapter-complete-flow.ts` (import from `../errors`)
- Modify: `packages/nax/src/agents/acp/index.ts:16` (delete the `parseAgentError` re-export)
- Modify: `packages/nax/src/agents/complete-exception-classifier.ts:4` -> `import { parseAgentError } from "./errors";`
- Modify: `packages/nax/test/unit/agents/acp/adapter-rate-card-pricing.test.ts` (its `parse-agent-error` import path)
- Modify: `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` (move the `looseCast: 1` entry to the new test path)

**Interfaces:**
- Produces: `parseAgentError(stderr: string): AgentError`, `classifyParsedAgentError(...)`, `classifyCompleteError(error: CompleteError, pricingSource?)`, re-exported from `src/agents/errors/index.ts`. Signatures unchanged.

- [ ] **Step 1: Move the test first**

```bash
mkdir -p test/unit/agents/errors
git mv test/unit/agents/acp/parse-agent-error.test.ts test/unit/agents/errors/parse-agent-error.test.ts
```

Change its import to `from "@/agents/errors/parse-agent-error"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/agents/errors/parse-agent-error.test.ts --timeout=5000`
Expected: FAIL, `Cannot find module '@/agents/errors/parse-agent-error'`.

- [ ] **Step 3: Move the source**

```bash
mkdir -p src/agents/errors
git mv src/agents/acp/parse-agent-error.ts src/agents/errors/parse-agent-error.ts
```

Create `src/agents/errors/index.ts`:

```typescript
export { classifyCompleteError, classifyParsedAgentError, parseAgentError } from "./parse-agent-error";
```

Update the importers listed under Files. In `adapter-lifecycle.ts` and `adapter-complete-flow.ts` the import becomes `from "../errors"`. Run `grep -rn "parse-agent-error\|parseAgentError" src test | grep -v "^src/agents/errors/"` and fix every remaining import path. Comment mentions in `transport-failure-message.ts` and `turn-failure-classification.ts` name the function, not the path, so leave them.

Update the escape-hatch baseline: in `scripts/baselines/test-escape-hatches-baseline.json`, rename the key `"test/unit/agents/acp/parse-agent-error.test.ts"` to `"test/unit/agents/errors/parse-agent-error.test.ts"` (value unchanged), keeping the file's key order as the gate writes it. Then run `bun run check:test-escape-hatches`. If the gate wants a different key order, run `bun run check:test-escape-hatches:update`. Check that `git diff scripts/baselines/test-escape-hatches-baseline.json` shows only that key moving.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 30 bun test test/unit/agents/errors/ test/unit/agents/acp/ test/unit/agents/complete-exception-classifier.test.ts test/unit/agents/transport-failure-message.test.ts test/unit/agents/native/adapter.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun x biome check --write src/agents test/unit/agents
git add src/agents test/unit/agents scripts/baselines/test-escape-hatches-baseline.json
git commit -m "refactor(nax): move parseAgentError to agents/errors (S4b-1)"
```

---

### Task 8: Boundary audit, full gates, review, PR

**Files:** none new. Baseline JSON files only if a gate requires it (Global Constraints rule).

- [ ] **Step 1: Audit that nothing shared is left behind and nothing new depends on `agents/acp/`**

Run:

```bash
grep -rn "from \"\.\./acp\|from \"\./acp\|agents/acp" src/agents/interaction src/agents/turn src/agents/errors src/agents/session-naming.ts src/agents/tool-preamble.ts
```

Expected: no output. The moved modules must not import the folder S4b-5 deletes.

Run:

```bash
grep -rln "computeAcpHandle\|extractQuestion\|extractContextToolCall\|awaitInteractionReply\|raceWithAbort\|warnWallClockTimeout\|buildContextToolPreamble\|parseAgentError" src/agents/acp
```

Expected: only consumers (`import` lines and call sites), no definitions. Check with `grep -n "^export function\|^function\|^export async function" <each file listed>`.

Run: `wc -l src/agents/acp/*.ts | tail -1`
Expected: below the 4,306 lines the spec records.

- [ ] **Step 2: Run every gate**

Run, from `packages/nax`, in order, and stop at the first failure:

```bash
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.test.json
bun run lint
bun run check:all
bun run test
bun run test:coverage
bun run build
```

Then the dist smoke: `node dist/nax.js --version` (or `bun dist/nax.js --version` if the bundle targets Bun; check `package.json` `bin`). It must print the version and exit 0.

Gate-specific handling. Each time, follow the Global Constraints rule: re-record a baseline only to move an entry at the same value or to lower one, and paste the diff into the commit body.
- `check:complexity`: if a moved function scores over 20, its old-path entry moves to the new path at the same score.
- `check:logger-storyid`: the warn calls moved in Tasks 4 and 5 may be counted under their new files.
- `check:file-sizes`: the gate may print a hint that baselines can be lowered for the shrunk `agents/acp/` files. Lower them with `bun run check:file-sizes:update`.
- `check:import-cycles`: a new cycle means a moved module imports something that imports it back. Fix the import; never raise the baseline.

- [ ] **Step 3: Commit any baseline updates**

```bash
git add scripts/baselines
git commit -m "chore(nax): re-record ratchet baselines for the S4b-1 moves"
```

(Skip this step if Step 2 changed no baseline.)

- [ ] **Step 4: Code review before push**

Dispatch one read-only reviewer over `git diff main...HEAD`. Brief: verify every moved body is byte-identical to its original apart from the substitutions this plan names (D1-d, D1-e, D1-h), that no log stage or message changed for the acpx path, that no shared module imports `agents/acp/`, and that no test assertion was weakened during the merges. Fix CRITICAL and IMPORTANT findings. At most two fix rounds.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/s4b-1-shared-logic-moves
gh pr create --title "refactor(nax): S4b-1 move shared logic out of agents/acp" --body "<summary of the seven moves, decisions D1-a..D1-j (call out D1-b as a spec deviation), gate results, Refs the S4b spec §5.2>"
```

Done when (spec §10): the nax suite, `typecheck` and `check:all` are green, and the acpx transport behaves the same, meaning the whole `test/unit/agents/acp/` suite passes with only import-path edits.

## Review Focus

1. **A log stage or message that drifted for the acpx path.** Operators grep `"acp-adapter"` warnings. The moved `warnWallClockTimeout` and `awaitInteractionReply` must emit byte-identical records when the acpx loop calls them. Pinned in Tasks 4 and 5 by exact-match spy assertions.
2. **A timed-out turn leaking partial output.** The `timedOut` contract forces `output: ""` even when the last response had text. Pinned for the new builder in Task 5. The existing `buildTurnResult` AC1 test pins the acpx wrapper.
3. **A context-tool call with invalid JSON.** It must reach the handler as an `error` interaction, not throw and not be dropped. Pinned in Task 2 (parser) and Task 4 (`toContextToolInteraction`).
4. **An abort while a human-reply wait is pending.** It must return `aborted`, not log a handler failure. Pinned in Task 4.
5. **A moved module that imports back into `agents/acp/`.** It would make S4b-5's deletion break the new transport. Checked by the Task 8 Step 1 grep. There is no runtime test for this, so the grep is the gate.
