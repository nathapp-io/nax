# Codex Effort-Suffix Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nax profiles that name codex models as `gpt-5.6-luna[high]` work against acpx 0.13.x by splitting the suffix into a bare `--model` plus a once-per-session `set reasoning_effort` call, without losing the effort from any user-facing display.

**Architecture:** A new pure module parses `model[effort]` into its two parts. `SpawnAcpClient` parses its `--model` value through that helper at construction, sends only the bare id on every prompt, keeps the original string as a display label so headless and TUI still show the effort, and issues one `acpx <agent> set reasoning_effort <effort> -s <session>` when a session is acquired. To stay under a file-size ratchet, an existing pure helper is extracted from `spawn-client.ts` first, creating the line headroom the new code needs.

**Tech Stack:** TypeScript (strict), Bun 1.3.7+, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-29-codex-effort-suffix-decomposition-design.md`

**Repo root:** `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`

## Background (read this first)

You need no prior context. Here is the whole problem.

nax profiles in `~/.nax/profiles/*.json` name codex models with an effort suffix, e.g.
`"gpt-5.6-luna[high]"`. nax passes that string straight through to the `acpx` CLI as
`--model`. Eight profiles do this: `codex-luna-review`, `codex-mini-review`, `cross-agent`,
`cross-agent-cc`, `cross-agent-cd`, `cross-agent-ds`, `cross-agent-mm`, `full-agents`.

The codex ACP adapter advertises its models through two channels that disagree:

| Channel | Model ids | Effort |
|---|---|---|
| legacy `models.availableModels` | `gpt-5.6-luna[high]` | inside the id |
| `configOptions` option `model` | `gpt-5.6-luna` (bare) | separate `reasoning_effort` option |

acpx 0.10.x (currently linked) validates against the legacy list, so the bracket form works.
acpx 0.13.x prefers the config-option channel, so the bracket form is rejected outright:

```
Cannot apply --model "gpt-5.6-luna[high]": the ACP agent did not advertise that model.
Available models: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini.
```

This is not a bug in either tool. 0.13.x moved to the modern API where model and effort are
separate. The bracket is a nax-level convention, so nax decomposes it: send the bare id as
`--model`, and set the effort via `acpx <agent> set reasoning_effort <value> -s <session>`.

All of the above is verified against a real acpx 0.13.0 build; see the spec's verification log.

**Profiles are not edited.** They keep the bracket syntax. Them working unchanged is the goal.

### The display trap (why Task 3 is two-sided)

`SpawnAcpSession` uses a single field, `this.model`, for **two** different purposes:

- the `--model` argument in the prompt argv, and
- the `model:` field on the `agent.call_started` stream event.

That event is the **only** source of the concrete model id in both user-facing surfaces:

| Surface | Render site | Fed by |
|---|---|---|
| headless | `src/log-format/formatter.ts:336-337` (`agent·model` badge) | `src/runtime/middleware/agent-stream-logging.ts:42` |
| TUI | `src/tui/components/LiveActivityPanel.tsx:154` (`model:<id>`) | `src/tui/hooks/useAgentStreamEvents.ts:68` |

Today both show `gpt-5.6-luna[high]`, effort included. If Task 3 only made `this.model` bare,
both surfaces would silently start showing `gpt-5.6-luna` and the effort would vanish. So Task 3
splits the field in two: a bare `model` for argv and a `modelLabel` (the original string) for the
event. No event type, formatter, or TUI component changes — the displayed text stays byte-identical
to today.

Everything else that displays a model reads `modelDef.model` (the raw profile string) directly and
is unaffected: `src/agents/acp/adapter.ts:249-252` (cost log), `src/metrics/tracker.ts:117-127`
(`modelUsed`), `src/cli/status-cost.ts`. The TUI status bar and stories panel show the model
**tier** (`balanced`), not the model id, and are also unaffected.

## Global Constraints

- **Branch:** `feat/codex-effort-suffix-decomposition` (already created, off `main` @ `05b2a123`). nax's base branch is `main`, not `master`.
- **File-size ratchet (hard gate):** `src/agents/acp/spawn-client.ts` is grandfathered at exactly **737 lines** in `scripts/baselines/file-sizes-baseline.json`. It **must not exceed 737 lines** at any commit. New source files must be under **600** lines; new test files under **800**.
- **The line budget is tight and was computed in advance.** Start 737, Task 2 frees ~30 (→ ~708), Task 3 adds ~13 (→ ~721), Task 4 adds ~5 (→ ~726). That ~11-line margin is why `applyReasoningEffort` lives in its own module instead of as a method on `SpawnAcpClient` — inlining it costs ~25 lines and **breaches the ceiling**. Do not "simplify" it back into `spawn-client.ts`.
- **Do not run `bun run check:file-sizes:update`.** The ratchet is meant to fall, not rise. Task 2 exists to create headroom instead.
- **Never run bare `bun test`.** Scoped runs must be `timeout`-wrapped, per `.claude/rules/testing-commands.md`.
- **Bun-native only.** `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()`. No Node.js `fs`/`child_process`.
- **No `console.log` in `src/`** — use the project logger. (`bun test` also swallows `console.log` here, so debug by asserting or writing to a file.)
- **Logging:** structured, no emojis, `storyId` as the first key in the data object.
- **Errors:** `NaxError`, never plain `Error`. (No new throws in this plan.)
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`. One concern per commit. Never include `[run-release]`.
- **Test harness is pre-validated.** The `makeSpawnResult` / `installSpawn` / `calls` scaffolding in Tasks 3-4 was executed against this codebase before this plan was written: it runs green and passes `bun run typecheck` with the casts exactly as shown. Copy it verbatim.
- **Locate code by search, not by line number.** Every task shifts the file; each task gives a `grep` anchor.

### Commands

| Purpose | Command |
|---|---|
| Scoped test (iteration) | `AGENT=1 timeout 30 bun test <path> --timeout=5000` |
| Longer scoped test | `AGENT=1 timeout -k 5s 60s bun test <path> --timeout=60000` |
| Full suite | `bun run test` |
| Typecheck | `bun run typecheck` |
| Lint (includes the ratchet) | `bun run lint` |
| Ratchet only | `bun run check:file-sizes` |

Treat exit 124 (timeout), 134 (SIGABRT), and 132 (SIGILL) as terminal — investigate, do not retry.

## File Structure

| File | Responsibility |
|---|---|
| `src/agents/acp/model-spec.ts` (create) | Pure `parseModelSpec` — split `model[effort]`. No I/O, no adapter knowledge. |
| `src/agents/acp/session-ids.ts` (create) | Pure `parseSessionIds`, moved verbatim out of `spawn-client.ts` to free lines. |
| `src/agents/acp/reasoning-effort.ts` (create) | `applyReasoningEffort` — builds and runs the `set reasoning_effort` argv through an injected spawn. Kept out of `spawn-client.ts` for the line budget and to be unit-testable on its own. |
| `src/agents/acp/spawn-client.ts` (modify) | Consumes all three helpers; splits model/label; calls `applyReasoningEffort` on session acquisition. |
| `test/unit/agents/acp/model-spec.test.ts` (create) | Parser unit tests. |
| `test/unit/agents/acp/session-ids.test.ts` (create) | Extracted-helper unit tests. |
| `test/unit/agents/acp/spawn-client-reasoning-effort.test.ts` (create) | Wiring, display-label preservation, and the not-per-prompt regression guard. |

---

### Task 1: `parseModelSpec` helper

**Files:**
- Create: `src/agents/acp/model-spec.ts`
- Test: `test/unit/agents/acp/model-spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ModelSpec { readonly model: string; readonly effort?: string }` and `export function parseModelSpec(raw: string): ModelSpec`. Task 3 imports both.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/acp/model-spec.test.ts`:

```ts
/**
 * Tests for parseModelSpec - splits a nax profile model string into a bare
 * model id and an optional reasoning-effort suffix.
 *
 * Malformed suffixes are passed through untouched on purpose: acpx (and the
 * adapter behind it) owns rejecting ids it does not advertise. Silently
 * rewriting a malformed value would hide a profile typo.
 */

import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "../../../../src/agents/acp/model-spec";

describe("parseModelSpec", () => {
  test("splits a trailing effort suffix", () => {
    expect(parseModelSpec("gpt-5.6-luna[high]")).toEqual({ model: "gpt-5.6-luna", effort: "high" });
  });

  test("splits every effort level the adapter advertises", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(parseModelSpec(`gpt-5.6-luna[${effort}]`)).toEqual({ model: "gpt-5.6-luna", effort });
    }
  });

  test("returns a bare id unchanged with no effort", () => {
    expect(parseModelSpec("gpt-5.6-luna")).toEqual({ model: "gpt-5.6-luna" });
  });

  test("leaves non-codex model names alone", () => {
    expect(parseModelSpec("opus")).toEqual({ model: "opus" });
    expect(parseModelSpec("default")).toEqual({ model: "default" });
  });

  test("passes malformed suffixes through untouched", () => {
    for (const raw of ["gpt-5.6-luna[", "gpt-5.6-luna]", "lu[x]na", "[high]", "gpt-5.6-luna[]"]) {
      expect(parseModelSpec(raw)).toEqual({ model: raw });
    }
  });

  test("does not treat a nested bracket as an effort", () => {
    expect(parseModelSpec("model[a[b]]")).toEqual({ model: "model[a[b]]" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/model-spec.test.ts --timeout=5000
```
Expected: FAIL — cannot resolve module `../../../../src/agents/acp/model-spec`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/acp/model-spec.ts`:

```ts
/**
 * Model spec parsing.
 *
 * nax profiles name codex models with a reasoning-effort suffix, e.g.
 * "gpt-5.6-luna[high]". That form is the identifier format of codex-acp's legacy
 * session/set_model API. acpx 0.13+ selects models through the config-option
 * channel instead, where the id is bare and effort is a sibling option
 * (reasoning_effort). The suffix is therefore a nax-level convention that must be
 * decomposed before the value reaches acpx.
 *
 * Only a well-formed trailing [..] is treated as a suffix. Anything else is passed
 * through as a model id so a profile typo surfaces as acpx's own
 * unadvertised-model error rather than a silent rewrite.
 */

export interface ModelSpec {
  /** Model id with any effort suffix removed. Safe to pass to acpx as --model. */
  readonly model: string;
  /** Reasoning effort from the suffix, when one was present. */
  readonly effort?: string;
}

/** Matches "<model>[<effort>]" where neither part contains a bracket. */
const EFFORT_SUFFIX = /^([^[\]]+)\[([^[\]]+)\]$/;

export function parseModelSpec(raw: string): ModelSpec {
  const match = EFFORT_SUFFIX.exec(raw);
  if (!match) return { model: raw };
  return { model: match[1] as string, effort: match[2] as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/model-spec.test.ts --timeout=5000
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp/model-spec.ts test/unit/agents/acp/model-spec.test.ts
git commit -m "feat: add parseModelSpec for codex effort suffixes"
```

---

### Task 2: Extract `parseSessionIds` to create line headroom

A pure move with no behavior change. It exists because `spawn-client.ts` sits at its 737-line ratchet ceiling and Tasks 3-4 add roughly thirty lines to it.

**Files:**
- Create: `src/agents/acp/session-ids.ts`
- Modify: `src/agents/acp/spawn-client.ts` (delete the `parseSessionIds` function and its doc comment; add one import)
- Test: `test/unit/agents/acp/session-ids.test.ts`

**Find it with** (never trust line numbers in this plan):
```bash
grep -n "function parseSessionIds" src/agents/acp/spawn-client.ts
```
The block to remove starts at the `/**` line beginning `Parse both ACP session IDs` and ends at the closing `}` of that function.

**Interfaces:**
- Consumes: nothing.
- Produces: `export function parseSessionIds(stdout: string): { sessionId: string | undefined; recordId: string | undefined }`. `spawn-client.ts` imports it; behavior is identical to the current private function.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/acp/session-ids.test.ts`:

```ts
/**
 * Tests for parseSessionIds - extracted verbatim from spawn-client.ts.
 *
 * Reads the JSON line emitted by `acpx --format json sessions ensure`, scanning
 * from the last line backwards so a banner or warning above it is ignored.
 */

import { describe, expect, test } from "bun:test";
import { parseSessionIds } from "../../../../src/agents/acp/session-ids";

describe("parseSessionIds", () => {
  test("reads both ids from the ensure line", () => {
    const line = JSON.stringify({
      action: "session_ensured",
      created: true,
      acpxRecordId: "rec-1",
      acpxSessionId: "sess-1",
      name: "s1",
    });
    expect(parseSessionIds(line)).toEqual({ sessionId: "sess-1", recordId: "rec-1" });
  });

  test("ignores non-JSON banner lines above the payload", () => {
    const line = JSON.stringify({ acpxRecordId: "rec-2", acpxSessionId: "sess-2" });
    expect(parseSessionIds(`[acpx] cwd: /tmp\n${line}`)).toEqual({ sessionId: "sess-2", recordId: "rec-2" });
  });

  test("returns undefined recordId when absent", () => {
    const line = JSON.stringify({ acpxSessionId: "sess-3" });
    expect(parseSessionIds(line)).toEqual({ sessionId: "sess-3", recordId: undefined });
  });

  test("returns undefined for both when no session id is present", () => {
    expect(parseSessionIds("no json here")).toEqual({ sessionId: undefined, recordId: undefined });
    expect(parseSessionIds(JSON.stringify({ acpxRecordId: "rec-4" }))).toEqual({
      sessionId: undefined,
      recordId: undefined,
    });
  });

  test("survives malformed JSON without throwing", () => {
    expect(parseSessionIds("{not valid json")).toEqual({ sessionId: undefined, recordId: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/session-ids.test.ts --timeout=5000
```
Expected: FAIL — cannot resolve module `../../../../src/agents/acp/session-ids`.

- [ ] **Step 3: Move the function**

Create `src/agents/acp/session-ids.ts` with the function moved out of `spawn-client.ts` verbatim, `export`ed:

```ts
/**
 * Parse both ACP session IDs from `acpx --format json sessions ensure` stdout.
 *
 * acpx --format json outputs a JSON line:
 *   {"action":"session_ensured","created":true,"acpxRecordId":"<uuid>","acpxSessionId":"<uuid>","name":"<name>"}
 *
 * - `acpxRecordId` - stable record identifier, assigned at creation, never changes across reconnects.
 * - `acpxSessionId` - volatile Claude Code session ID, updated on each Claude Code reconnect.
 *
 * Returns an object with both IDs (undefined when not present in output).
 */
export function parseSessionIds(stdout: string): { sessionId: string | undefined; recordId: string | undefined } {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = parsed.acpxSessionId;
      const recordId = parsed.acpxRecordId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        return {
          sessionId,
          recordId: typeof recordId === "string" && recordId.length > 0 ? recordId : undefined,
        };
      }
    } catch {
      // not valid JSON - skip
    }
  }
  return { sessionId: undefined, recordId: undefined };
}
```

In `src/agents/acp/spawn-client.ts`, delete that whole block (doc comment plus function) and add to the import section, next to the existing `import { buildAllowedEnv } from "../shared/env";`:

```ts
import { parseSessionIds } from "./session-ids";
```

Leave every call site unchanged — both `createSession` and `loadSession` already call `parseSessionIds(stdout)`.

- [ ] **Step 4: Verify the move is behavior-neutral and freed the needed lines**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/session-ids.test.ts --timeout=5000
AGENT=1 timeout 60 bun test test/unit/agents/acp/ --timeout=5000
bun run typecheck
wc -l src/agents/acp/spawn-client.ts
bun run check:file-sizes
```

Expected: new tests PASS; the whole existing `acp` suite PASSES unchanged; typecheck clean;
`spawn-client.ts` around **708** lines (down from 737); ratchet exits 0.

If the line count is not at least 30 below 737, stop and reduce further before continuing —
Tasks 3-4 will not fit otherwise.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp/session-ids.ts src/agents/acp/spawn-client.ts test/unit/agents/acp/session-ids.test.ts
git commit -m "refactor: extract parseSessionIds from spawn-client"
```

---

### Task 3: Send the bare model id, keep the label for display

Two-sided by design: making `--model` bare would otherwise silently drop the effort from the
headless badge and the TUI live-activity row. See "The display trap" above.

**Files:**
- Modify: `src/agents/acp/spawn-client.ts` (`SpawnAcpSession` opts/field/emit; `SpawnAcpClient` constructor and both session factories)
- Test: `test/unit/agents/acp/spawn-client-reasoning-effort.test.ts`

**Find the sites with:**
```bash
grep -n 'parts.indexOf("--model")' src/agents/acp/spawn-client.ts   # client constructor
grep -n 'kind: "agent.call_started"' src/agents/acp/spawn-client.ts # the emit to relabel
grep -n 'model: this.model' src/agents/acp/spawn-client.ts          # argv use vs emit use
```

**Interfaces:**
- Consumes: `parseModelSpec` from Task 1.
- Produces:
  - `SpawnAcpSession` constructor opts gain **optional** `modelLabel?: string`; the class gains `private readonly modelLabel: string`, defaulted to `opts.model`. `model` keeps its meaning (the `--model` argv value, now always bare).
  - Optional on purpose: `test/unit/agents/acp/spawn-client-pid-callback.test.ts` constructs `SpawnAcpSession` at **four** sites (lines ~60, ~127, ~153, ~173). A required field would break all four for no behavioral reason, and the default is semantically right — with no suffix, the model *is* the label.
  - `SpawnAcpClient` gains `private readonly rawModel: string` (original string, used as `modelLabel`) and `private readonly reasoningEffort?: string`, which Task 4 reads.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/acp/spawn-client-reasoning-effort.test.ts`:

```ts
/**
 * Tests for codex effort-suffix handling in SpawnAcpClient.
 *
 * A profile model like "gpt-5.6-luna[high]" is split three ways:
 *   - the bare id rides on every prompt via --model,
 *   - the original string stays on the agent.call_started event so headless and
 *     TUI keep showing the effort,
 *   - the effort is applied once when the session is acquired (Task 4).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "../../../../src/agents/acp/spawn-client";
import type { AgentStreamEvent } from "../../../../src/runtime";
import { withDepsRestore } from "../../../helpers/deps";

const ENSURE_JSON = JSON.stringify({
  action: "session_ensured",
  created: true,
  acpxRecordId: "rec-1",
  acpxSessionId: "sess-1",
  name: "s1",
});

const TURN_JSON = JSON.stringify({ result: "done", stopReason: "end_turn" });

function makeSpawnResult(exitCode = 0, stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
  const enc = new TextEncoder();
  const makeStream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (content) c.enqueue(enc.encode(content));
        c.close();
      },
    });
  return {
    stdout: makeStream(stdout),
    stderr: makeStream(""),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited: Promise.resolve(exitCode),
    pid: 4321,
    kill: () => {},
  } as ReturnType<typeof _spawnClientDeps.spawn>;
}

/**
 * Every argv array passed to spawn, in order.
 *
 * Captured explicitly rather than read off `mock.calls`: no other test in this
 * repo relies on `mock.calls`, and an explicit array keeps accumulating across a
 * mid-test mock reassignment, which the "not per prompt" test depends on.
 */
let calls: string[][] = [];

/** Install a spawn mock that records argv and returns `stdout`. */
function installSpawn(stdout: string, exitCode = 0): void {
  _spawnClientDeps.spawn = mock((cmd: string[]) => {
    calls.push(cmd);
    return makeSpawnResult(exitCode, stdout);
  }) as unknown as typeof _spawnClientDeps.spawn;
}

withDepsRestore(_spawnClientDeps, ["spawn"]);

beforeEach(() => {
  calls = [];
  installSpawn(ENSURE_JSON);
});

afterEach(() => {
  mock.restore();
});

describe("SpawnAcpClient - effort suffix", () => {
  test("sends the bare model id on prompts, not the bracket form", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const promptCall = calls.find((c) => c.includes("prompt"));
    expect(promptCall).toBeDefined();
    const modelIdx = (promptCall as string[]).indexOf("--model");
    expect((promptCall as string[])[modelIdx + 1]).toBe("gpt-5.6-luna");
  });

  test("keeps the effort on the call_started event for headless and TUI", async () => {
    const events: AgentStreamEvent[] = [];
    const client = new SpawnAcpClient(
      "acpx --model gpt-5.6-luna[high] codex",
      "/tmp/wd",
      undefined,
      undefined,
      undefined,
      undefined,
      { onStreamActivity: (e: AgentStreamEvent) => events.push(e) },
    );
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const started = events.find((e) => e.kind === "agent.call_started");
    expect(started).toBeDefined();
    expect((started as { model: string }).model).toBe("gpt-5.6-luna[high]");
  });

  test("leaves a suffix-free model untouched in both argv and event", async () => {
    const events: AgentStreamEvent[] = [];
    const client = new SpawnAcpClient(
      "acpx --model opus claude",
      "/tmp/wd",
      undefined,
      undefined,
      undefined,
      undefined,
      { onStreamActivity: (e: AgentStreamEvent) => events.push(e) },
    );
    const session = await client.createSession({
      agentName: "claude",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const promptCall = calls.find((c) => c.includes("prompt")) as string[];
    expect(promptCall[promptCall.indexOf("--model") + 1]).toBe("opus");
    const started = events.find((e) => e.kind === "agent.call_started");
    expect((started as { model: string }).model).toBe("opus");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/spawn-client-reasoning-effort.test.ts --timeout=5000
```
Expected: the first test FAILS (`--model` carries `gpt-5.6-luna[high]`). The second and third
pass already — they are the no-regression controls that must stay green through Step 3.

- [ ] **Step 3: Write minimal implementation**

**3a.** Add the import next to the `session-ids` import from Task 2:

```ts
import { parseModelSpec } from "./model-spec";
```

**3b.** In `SpawnAcpSession`, add the field beside `private readonly model: string;`:

```ts
  /** Original profile model string, including any [effort] suffix. Display only. */
  private readonly modelLabel: string;
```

Add to the constructor opts type, beside `model: string;` — **optional**, so the four existing
`new SpawnAcpSession({...})` sites in `spawn-client-pid-callback.test.ts` keep compiling:

```ts
    modelLabel?: string;
```

And assign it beside `this.model = opts.model;`, defaulting to the model itself:

```ts
    this.modelLabel = opts.modelLabel ?? opts.model;
```

**3c.** In the `agent.call_started` emit, switch the display field to the label. The argv use of
`this.model` a few lines above stays exactly as it is:

```ts
    emit?.({
      ...baseEvent,
      kind: "agent.call_started",
      model: this.modelLabel,
      timeoutSeconds: this.timeoutSeconds,
      timestamp: now(),
    });
```

**3d.** In `SpawnAcpClient`, add the two fields beside `private readonly model: string;`:

```ts
  /** Original --model string, including any [effort] suffix. Display only. */
  private readonly rawModel: string;
  /** Reasoning effort split off the profile's model suffix, applied once per session. */
  private readonly reasoningEffort?: string;
```

Replace these two constructor lines:

```ts
    const modelIdx = parts.indexOf("--model");
    this.model = modelIdx >= 0 && parts[modelIdx + 1] ? parts[modelIdx + 1] : "default";
```

with:

```ts
    const modelIdx = parts.indexOf("--model");
    const rawModel = modelIdx >= 0 && parts[modelIdx + 1] ? parts[modelIdx + 1] : "default";
    const spec = parseModelSpec(rawModel);
    this.rawModel = rawModel;
    this.model = spec.model;
    this.reasoningEffort = spec.effort;
```

**3e.** In **both** `createSession` and `loadSession`, add `modelLabel` beside the existing
`model: this.model,` in the `new SpawnAcpSession({ ... })` literal:

```ts
      model: this.model,
      modelLabel: this.rawModel,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/spawn-client-reasoning-effort.test.ts --timeout=5000
AGENT=1 timeout 60 bun test test/unit/agents/acp/ --timeout=5000
bun run typecheck
```
Expected: all three tests PASS; the rest of the `acp` suite still PASSES — including
`spawn-client-pid-callback.test.ts`, which must need **no edits** because `modelLabel` is optional.
If that file fails to typecheck, you made the field required; go back and add the `?`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp/spawn-client.ts test/unit/agents/acp/spawn-client-reasoning-effort.test.ts
git commit -m "feat: send bare codex model id while keeping the effort label for display"
```

---

### Task 4: Apply `reasoning_effort` once per session

**Files:**
- Create: `src/agents/acp/reasoning-effort.ts`
- Modify: `src/agents/acp/spawn-client.ts` (call the helper in `createSession` and `loadSession` after `parseSessionIds`)
- Test: `test/unit/agents/acp/spawn-client-reasoning-effort.test.ts` (append)

**Interfaces:**
- Consumes: `this.reasoningEffort` from Task 3; the existing `private async trackedSpawn(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>`, passed in as the `spawn` parameter.
- Produces:
  ```ts
  export async function applyReasoningEffort(params: {
    effort: string | undefined;
    agentName: string;
    sessionName: string;
    cwd: string;
    storyId?: string;
    spawn: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }): Promise<void>
  ```
  The observable contract is the argv `["acpx", "--cwd", <cwd>, <agent>, "set", "reasoning_effort", <effort>, "-s", <sessionName>]`, issued at most once per acquired session, and never when `effort` is undefined.

**Decision recorded:** a failed `set` logs a warning and continues rather than failing session
acquisition. Failing a whole run because an optional quality knob did not apply is worse than
running at the adapter's default effort. The warning is what keeps the downgrade visible instead
of silent.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block in `test/unit/agents/acp/spawn-client-reasoning-effort.test.ts`:

```ts
  test("issues set reasoning_effort exactly once when the session is created", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual([
      "acpx", "--cwd", "/tmp/wd", "codex", "set", "reasoning_effort", "high", "-s", "s1",
    ]);
  });

  test("issues set reasoning_effort when a session is loaded", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[medium] codex", "/tmp/wd");
    await client.loadSession("s1", "codex", "approve-all");

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.[6]).toBe("medium");
  });

  test("issues no set call when the model carries no suffix", async () => {
    const client = new SpawnAcpClient("acpx --model opus claude", "/tmp/wd");
    await client.createSession({ agentName: "claude", permissionMode: "approve-all", sessionName: "s1" });

    expect(calls.filter((c) => c.includes("set"))).toHaveLength(0);
  });

  test("does not re-issue set on every prompt", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });
    expect(calls.filter((c) => c.includes("set"))).toHaveLength(1);

    installSpawn(TURN_JSON);
    await session.prompt("one");
    await session.prompt("two");

    // Still exactly the one from session creation - prompts must not re-issue it.
    expect(calls.filter((c) => c.includes("set"))).toHaveLength(1);
  });

  test("session creation survives a failing set call", async () => {
    _spawnClientDeps.spawn = mock((cmd: string[]) => {
      calls.push(cmd);
      return cmd.includes("set") ? makeSpawnResult(1, "boom") : makeSpawnResult(0, ENSURE_JSON);
    }) as unknown as typeof _spawnClientDeps.spawn;

    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });
    expect(session).toBeDefined();
  });
```

Note on the "not per prompt" test: `calls` accumulates across the mid-test `installSpawn`
reassignment, so the count stays at **1** rather than resetting to 0. Asserting 1 (not 0) after two
prompts is what proves the `set` came from session creation and was never re-issued.

- [ ] **Step 2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/spawn-client-reasoning-effort.test.ts --timeout=5000
```
Expected: FAIL — the three `set`-expecting tests find zero `set` calls.

- [ ] **Step 3: Write minimal implementation**

**3a.** Create `src/agents/acp/reasoning-effort.ts`:

```ts
/**
 * Reasoning-effort application for codex sessions.
 *
 * acpx 0.13+ selects codex models through the config-option channel, where the
 * model id is bare and effort is a sibling option. --model is re-sent on every
 * prompt, but effort has no per-prompt carrier, so it is set once when a session
 * is acquired.
 *
 * Lives outside spawn-client.ts deliberately: that file is at its file-size
 * ratchet ceiling, and a free function with an injected spawn is unit-testable
 * without constructing a client.
 */

import { getSafeLogger } from "@/logger";

export async function applyReasoningEffort(params: {
  effort: string | undefined;
  agentName: string;
  sessionName: string;
  cwd: string;
  storyId?: string;
  spawn: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): Promise<void> {
  const { effort, agentName, sessionName, cwd, storyId, spawn } = params;
  if (!effort) return;

  const cmd = ["acpx", "--cwd", cwd, agentName, "set", "reasoning_effort", effort, "-s", sessionName];
  const { exitCode, stdout, stderr } = await spawn(cmd);

  // Best-effort: a failure leaves the session at the adapter default rather than
  // failing the whole run. The warning is what keeps that downgrade visible.
  if (exitCode !== 0) {
    getSafeLogger()?.warn("acp-adapter", "Failed to set reasoning_effort; continuing at adapter default", {
      storyId,
      effort,
      session: sessionName,
      cause: stdout || stderr,
    });
  }
}
```

**3b.** In `src/agents/acp/spawn-client.ts`, add the import beside the other two new ones:

```ts
import { applyReasoningEffort } from "./reasoning-effort";
```

**3c.** In `createSession`, after `const { sessionId, recordId } = parseSessionIds(stdout);` and
before `return new SpawnAcpSession({`:

```ts
    await applyReasoningEffort({
      effort: this.reasoningEffort,
      agentName: opts.agentName,
      sessionName,
      cwd: this.cwd,
      storyId: this.storyId,
      spawn: (c) => this.trackedSpawn(c),
    });
```

**3d.** In `loadSession`, after its `const { sessionId, recordId } = parseSessionIds(stdout);` —
note `agentName` here is the function parameter, not `opts.agentName`:

```ts
    await applyReasoningEffort({
      effort: this.reasoningEffort,
      agentName,
      sessionName,
      cwd: this.cwd,
      storyId: this.storyId,
      spawn: (c) => this.trackedSpawn(c),
    });
```

- [ ] **Step 4: Run the full gate**

```bash
AGENT=1 timeout 30 bun test test/unit/agents/acp/spawn-client-reasoning-effort.test.ts --timeout=5000
bun run typecheck
bun run lint
wc -l src/agents/acp/spawn-client.ts
bun run check:file-sizes
bun run test
```

Expected: all eight tests in the file PASS; typecheck and lint clean; `spawn-client.ts` around
**726** lines, under the 737 ceiling; ratchet exits 0; full suite green.

If `check:file-sizes` fails, do **not** update the baseline. Move code *out* of `spawn-client.ts`
instead — the effort helper is already external, so the next candidate is another pure function.

- [ ] **Step 5: Commit**

```bash
git add src/agents/acp/reasoning-effort.ts src/agents/acp/spawn-client.ts \
        test/unit/agents/acp/spawn-client-reasoning-effort.test.ts
git commit -m "feat: apply codex reasoning_effort once per session"
```

---

### Task 5: Verify against a real acpx 0.13.x

Unit tests prove the argv shape. This proves the argv is one acpx actually accepts. No source
changes expected.

- [ ] **Step 1: Get a 0.13.x build**

If `<scratchpad>/acpx-upstream` still exists, use it. Otherwise build one anywhere convenient:

```bash
git clone --depth 200 https://github.com/openclaw/acpx.git acpx-upstream
cd acpx-upstream
pnpm install --ignore-scripts --frozen-lockfile
pnpm run build
node dist/cli.js --version    # expect 0.13.0
```

Do **not** `npm link` or otherwise install this build globally. The global `acpx` must stay
pointed at the 0.10.x fork until a separate, deliberate cutover.

- [ ] **Step 2: Replay the exact argv the adapter now emits**

```bash
UP=<path-to>/acpx-upstream/dist/cli.js
cd /tmp
node $UP codex sessions new --name efforttest
node $UP codex set reasoning_effort high -s efforttest
node $UP --approve-all --model gpt-5.6-luna codex prompt -s efforttest 'reply OK'
```

Expected: the `set` prints `config set: reasoning_effort=high`; the prompt completes.

- [ ] **Step 3: Confirm both settings landed on the session**

```bash
python3 -c "
import json,glob,os
f=sorted(glob.glob(os.path.expanduser('~/.acpx/sessions/*.json')), key=os.path.getmtime)[-1]
a=json.load(open(f))['acpx']
print('model  :', a.get('current_model_id'))
print('desired:', a.get('desired_config_options'))
"
```

Expected: `model : gpt-5.6-luna` and `desired: {'reasoning_effort': 'high'}`.

- [ ] **Step 4: Clean up**

```bash
node $UP codex sessions close efforttest
```

- [ ] **Step 5: Nothing to commit**

The design doc and this plan were already committed to this branch before implementation started.
Verify with:

```bash
git log --oneline -1 -- docs/superpowers/plans/2026-07-29-codex-effort-suffix-decomposition.md
```

If you changed either document while implementing (e.g. recording a decision that turned out
differently), commit that separately with a `docs:` message.

---

## Not in this plan

- **Relinking the global `acpx`.** Cutover is section 7 of the design doc and is a separate,
  sequenced step. A `nax run` may be live against the 0.10.x fork; nothing gets relinked while
  one is running.
- **The acpx per-agent/per-node model feature.** Independent, designed in the acpx worktree,
  neither blocks the other.
- **Profile edits.** The eight bracket profiles are the fixture, not the change.
- **Showing a model anywhere it is not shown today.** The headless run header and JSONL run-start
  formatter carry no model or agent field at all. Task 3 preserves existing display; adding new
  display surfaces is out of scope.
