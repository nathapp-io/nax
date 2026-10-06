# S4-6: ACP resume, reconnect, packed smoke and S4 acceptance: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `resumeAgentSession` reopens a stored ACP session in a new process with `session/resume` (else `session/load`), a crashed or killed agent reconnects once on the next `send()`, both packages pass a packed-tarball smoke, and the billed live Claude smoke plus the S4 release procedure are ready for the maintainer (spec §6.9, §6.3 step 5, §10 S4-6 row, §11).

**Architecture:**
- New module `packages/nax-agent-acp/src/client/resume.ts`: checks the stored document before anything is spawned (§6.9 step 1), restores the agent session with `session/resume` or `session/load` (steps 2 and 3), and checks the restored session's identity.
- `open.ts` takes an optional `Restore`. With one, it calls `restoreSession` instead of `session/new`, then re-applies the mode and model. It writes no initial document.
- `backend.ts` splits "one agent process" (`Live`) from "the session" (`AcpSession`). `openBackend` restores when `ctx.resume` is set. `sendTurn` reconnects a disconnected session once, replacing the whole `Live`: new process, new router and new tool host token. The cost baseline is carried over.
- The cost meter can start from a baseline. After each priced turn the backend writes the baseline into the transcript document (`acp.costUsd`, a new optional nax-agent field), so a resume in a new process prices its first turn correctly (D6-a, maintainer ruling 2026-10-06).
- `connection.ts` gains `resumeSession` and `loadSession`. `errors.ts` maps a lost session to `AGENT_SESSION_NOT_FOUND` and adds `sessionLost` (`AGENT_SESSION_CLOSED`).
- The fake agent answers `session/resume` and `session/load`, can replay history during a load, and takes per-launch overrides (`relaunch`).
- Node: a cross-process resume contract test, and a packed smoke that installs both tarballs into a clean Node project.
- Two maintainer-run fixtures: the billed live Claude smoke (§11.2) and the initialize-only smoke (§11.3). RELEASING.md gains "S4 acceptance".

**Tech Stack:**
- `@agentclientprotocol/sdk` 1.7.0: `methods.agent.session.resume`, `methods.agent.session.load`, `ResumeSessionRequest`, `ResumeSessionResponse`, `LoadSessionRequest`, `LoadSessionResponse`, `RequestError` (`resourceNotFound` = -32002)
- `@nathapp/nax-agent` public `.`: `BackendOpenContext`, `BackendInfo`, `TranscriptDoc`, `TranscriptAcpRecord`, `AgentSessionError`, `NaxError`, `getLogger`, `createFileTranscriptStore`, `resumeAgentSession`
- bun:test (unit), vitest on Node 22/24 (contract and packed smoke)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`. Sections used:
- §6.9 Resume and reconnect (the whole section)
- §6.3 step 5 (crash and reconnect), step 1 (open), step 4 (close), "Inbound requests with no active turn" ("any inbound request during `session/load` replay → the same")
- §6.6 "Close and resume" (a new host with a new token, `mcpServers` and `_meta` re-supplied)
- §6.7 usage (cost baseline; amended here by D6-a)
- §6.7 table row "any update during `session/load`: suppressed"
- §5.5 `TranscriptDoc.acp` (gains `costUsd`, D6-a)
- §7 Errors (resume rows)
- §8 Package and release; §9 Testing (fake agent resume/load matrix, conformance, packed smoke); §10 S4-6 row; §11 Acceptance

## Global Constraints

- nax-agent-acp imports nax-agent only as `@nathapp/nax-agent` (public `.`), never `./internal` or a deep path, in `src/` or `test/` (§4).
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental` or `/v2`), `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/` (`check:no-bun-apis`).
- `src/` imports its own modules as `#src/client/<module>`.
- No `throw new Error(` in `src/` (`check-nax-error`, baseline 0).
- The backend never silently creates a fresh session for a stored one (§6.9 step 2).
- Every check of the stored document runs before anything is spawned (§6.9 step 1).
- Every failure after a spawn kills that process before it propagates (S4-2 Review Focus 1).
- Reconnect and resume start a new tool host with a new token, and re-supply `mcpServers` and `_meta` (§6.6).
- Gates (from `packages/nax-agent-acp`):
  - file sizes: 600 lines per src file, 800 per test file
  - complexity: 20 per function
  - coverage: 80% overall and per src file; the per-file baseline stays empty
  - import cycles: none
  - test satellites: the new `src/client/resume.ts` gets `test/unit/client/resume.test.ts`; other test files are `<module>-<concern>.test.ts`, never named after a ticket
  - no `as unknown as`, `as any` or `@ts-ignore` in tests: build malformed input with `JSON.parse`, as earlier stages do
- nax-agent (Task 0 only): the change stays inside `src/native/session/transcript-types.ts`, `test/unit/native/transcript-store.test.ts` and `CHANGELOG.md`. The API snapshot does not change: it lists `type TranscriptAcpRecord` by name only.
- `packages/nax/` does not change.
- Nothing is published or tagged without the maintainer's approval at that moment (Tasks 11 and 12). Billed runs need approval at launch (Task 10 step 4, Task 11).
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code in this plan is not pre-formatted: run `bun run lint:fix` in the package before every `check:all`.
- No emojis in code, comments or docs. Edit `.nax/**/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.
- Where this plan changes an existing file, it gives the whole new file or an exact old/new edit. Nothing is elided: do not merge from fragments.

## Review Focus

1. **A workdir spelled differently on resume.** The session was created with `/tmp/x` and is resumed with `/private/tmp/x` (macOS symlink), or the reverse. The resume must be accepted, and the agent must get the stored spelling, because Claude finds its session files by the cwd it was created with. A genuinely different directory must be refused before spawning. Pinned in Task 4 (`storedSessionOf`) and Task 6 (end to end with a symlink).
2. **Cancel or close while a reconnect is starting.** The relaunched agent hangs in `initialize`, and the caller cancels, or closes the session. The turn must end `cancelled` at once and the half-started process must be killed. After a cancel the session is not lost: the next `send()` tries again. After a close, nothing is left running. Pinned in Task 6.
3. **Cost after a resume.** Claude's adapter keeps its running totals across a resume (acp-agent.js 4061-4063: "A resumed session's first reading ... already contains the pre-resume history"). Turn 1 costs 0.01 in process 1. After a resume, process 2 reports 0.025 for its first turn. That turn must cost 0.015, not 0.025. A counter that restarted at zero (reading 0.004) must report 0.004, never a negative cost. Pinned in Task 1 (meter) and Task 6 (resume and reconnect).
4. **History replayed during `session/load`.** The agent replays old text and sends a permission request while the load runs. None of it may appear in the next turn's events, and the permission request must be rejected locally. Pinned in Task 6.
5. **A stored document that is wrong.** `acp` missing; `agentSessionId` empty, non-string or 10 kB long; `acp.agent` naming another agent; `costUsd` negative or a string. Each must give `TRANSCRIPT_CORRUPT` before a spawn, or, for `costUsd`, a baseline of 0. None may spawn an agent with garbage. Pinned in Task 4.

## Decisions taken in this plan (for review)

Evidence for D6-a, D6-d and D6-e comes from `@agentclientprotocol/claude-agent-acp` 0.85.1 (the registry pin, unpacked from `npm pack`) and `@agentclientprotocol/sdk` 1.7.0.

- **D6-a. The cost baseline is persisted (maintainer ruling 2026-10-06; amends §6.7 and §6.9 step 4).** The spec reset the meter to 0 on reconnect and resume. Claude's adapter carries its running totals across a resume: `acp-agent.js` 4061-4063, "A resumed session's first reading has no predecessor and already contains the pre-resume history". `total_cost_usd` comes from the same query, so a reset would bill the first resumed turn for the whole earlier session. Instead:
  - nax-agent's `TranscriptAcpRecord` gains an optional `costUsd`: the cumulative reading at the end of the last priced turn. Type only; `schemaVersion` stays 1.
  - After every turn whose baseline moved, the backend load-merges it into the document. This is best effort: a failed write is logged through `getLogger` and never fails the turn.
  - Resume seeds the meter from `acp.costUsd`. A missing, negative or non-number value seeds 0.
  - A same-process reconnect seeds the meter from the old meter's baseline.
  - The existing negative-difference rule (S4-5 D5-b) still covers an agent whose counter restarts at 0. The live smoke records the first resumed turn's cost.
  - This touches nax-agent `native/`, so the S4-0 Done-when applies: the billed `nax run` S1-recipe smoke runs before merge (Task 10 step 4).
- **D6-b. What the document check refuses, and with what code (§6.9 step 1, all before spawning).**
  - `backend` other than this backend's kind: `AGENT_SESSION_BACKEND_MISMATCH`. The facade checks this too; the backend repeats it because `open()` can be called directly.
  - `acp` missing, or `agentSessionId` not a usable id (a non-empty string of at most 512 characters, the rule S4-2 applies to `session/new`), or `agent` / `cwd` not non-empty strings: `TRANSCRIPT_CORRUPT` (`NaxError`, as nax-agent raises it).
  - `acp.agent` not this backend's agent name: `TRANSCRIPT_CORRUPT`. The kind already matched, so the document contradicts itself.
  - `acp.cwd` not the same directory as `workdir`: `AGENT_SESSION_INVALID_OPTIONS` (`path: "workdir"`).
- **D6-c. The cwd is compared canonically and sent as stored.** Both paths are resolved and passed through `realpathSync.native`, falling back to the resolved path when that throws. The agent is given the stored spelling, because Claude keys its session store by the cwd the session was created with. A `none` session without `workdir` runs in a fresh scratch root each time, so it cannot be resumed. The error message says to pass the original `workdir`.
- **D6-d. Identity is the session id the agent echoes, when it echoes one (§6.9 step 3).** `ResumeSessionResponse` and `LoadSessionResponse` have no `sessionId` field. Claude's adapter adds one anyway (`getOrCreateSession`, `acp-agent.js` 6559-6596: `return { sessionId: response.sessionId, ... }`). The SDK client does not parse responses against a schema: `acp.js` has no response schema for `session/resume`, and a connection test pins the pass-through. A string `sessionId` other than the stored one → `NaxError` `AGENT_SESSION_TURN_FAILED` with `{ stage: "acp", detail: "identity" }`, the same code-and-detail shape nax-agent uses for `no-turn`. When no id is echoed, the restore is accepted.
- **D6-e. A lost session is `AGENT_SESSION_NOT_FOUND` (§6.9 step 2, §7).** On `session/resume` and `session/load` only:
  - JSON-RPC code -32002. Claude raises `RequestError.resourceNotFound` when the Claude CLI reports "No conversation found with session ID" or closes first (`acp-agent.js` 6999-7003).
  - Or agent text matching `/session not found|no conversation found/i`, for agents that use another code.

  Classification runs on the raw message; only the redacted excerpt escapes (§7). An auth error is still `AGENT_SESSION_AUTH_REQUIRED`.
- **D6-f. A restored session keeps its document, and sends instructions only if it never ran a turn.**
  - Restoring writes no initial document. The facade has already read the document, including an `interrupted` marker, and `close()`'s load-merge keeps it.
  - `instructions` go with the first prompt only when the stored document has no `turn` marker, that is, when no turn ever started. Otherwise the agent's own history already holds them.
  - A reconnect inside one session keeps the in-memory "sent" flag.
- **D6-g. A reconnect replaces the whole process (§6.3 step 5).** Before reconnecting:
  - the old process is killed (a no-op when it is gone)
  - its link is closed
  - its tool host is stopped, which revokes its token

  The new process gets a new router, a new tool host with a new token, and a meter seeded with the old baseline. Retired tokens stay in the redaction set, so a token the dead agent printed is still scrubbed. Then:
  - Agent without resume or load: `send()` throws `AGENT_SESSION_CLOSED` without spawning.
  - The reconnect runs under `initializeTimeoutMs` per request, `openSignal` (close) and the turn signal (cancel, timeout).
  - Any other failure marks the session lost, and later turns end `AGENT_SESSION_CLOSED`.
  - A cancel, timeout or close during the attempt does not mark it lost: the next `send()` tries again, and after a close the facade refuses sends anyway.
- **D6-h. `AgentSession.backend` reports the live process.** `OpenedBackend.info` becomes a getter, which the facade already reads at every access. Its `capabilities` are the current process's capability record. A restored process (resume or reconnect) adds `restoredWith: "resume" | "load"`. The live smoke asserts `restoredWith === "resume"` (§11.2 "asserting `session/resume` was used"), and S6 can show it.
- **D6-i. The packed smoke stages both packages at one version.** nax-agent is 0.2.0 in the workspace and nax-agent-acp is 0.3.0 until the release PR bumps both (R10). `stage-publish` therefore refuses nax-agent-acp today.
  - The smoke stages copies in temporary directories, not `.publish/`, and gives the staged nax-agent copy the acp version. Nothing in the source tree changes.
  - It builds the acp manifest with the same `buildStagedManifest` that `stage-publish` uses.
  - After the release bump the version override is a no-op.
- **D6-j. Conformance (amends §9).** Spec §9 describes a conformance suite parameterised by target. It is realised as:
  - the fake-agent suites: in process, over real subprocesses, and on Node
  - the live Claude fixture (Task 8) as the Claude target, run by the maintainer before release

  A separate parameterised harness would duplicate both for one live target, so none is built.
- **D6-k. `session/load` answered with `null` is tolerated.** The SDK's agent side lets `loadSession` return `void`, which arrives as `null`. It is read as "no config options".
- **D6-l. The fake agent's restore support.**
  - Handlers for `session/resume` and `session/load`. Sessions not in `knownSessions` (default: its own id) get `resourceNotFound`. `restoreFailure` fails either with a given JSON-RPC error.
  - `restoredSessionId` is echoed as Claude does.
  - `loadReplay` sends updates during a load. `loadPermission` sends one permission request during a load and records `load-permission-outcome`.
  - `relaunch` overrides the script for every launch after the first. The subprocess entry counts earlier `start` records in its record file; the in-memory launcher counts its launches.

---

## File structure

**Create (package `packages/nax-agent-acp/`):**

| Path | Responsibility |
|---|---|
| `src/client/resume.ts` | `storedSessionOf`, `restoreSession`, `checkRestored`, `canRestore`, `isUsableSessionId`; types `Restore`, `RestoredWith`, `RestoredSession`, `SessionSetup`, `OpenStep`; `MAX_SESSION_ID_CHARS` |
| `test/unit/client/resume.test.ts` | the document check, identity and helpers |
| `test/unit/client/backend-resume.test.ts` | resume end to end in process |
| `test/unit/client/backend-reconnect.test.ts` | reconnect end to end in process |
| `test/helpers/smoke-command.ts` | `runSmokeCommand` for the packed smoke |
| `test/node/pack-smoke.test.ts` | both tarballs into a clean Node project |
| `test/node/fixtures/packed-smoke.mjs` | the consumer script the pack smoke runs |
| `test/node/fixtures/live-claude-smoke.mjs` | billed §11.2 fixture (maintainer only) |
| `test/node/fixtures/init-smoke.mjs` | §11.3 initialize-only fixture (maintainer only) |

**Modify:**

| Path | Change |
|---|---|
| `packages/nax-agent/src/native/session/transcript-types.ts` | `TranscriptAcpRecord.costUsd?` |
| `packages/nax-agent/test/unit/native/transcript-store.test.ts` | ACP record round trip |
| `packages/nax-agent/CHANGELOG.md` | one Added line |
| `src/client/usage.ts` | meter baseline (seed and read) |
| `src/client/errors.ts` | NOT_FOUND on restore, `sessionLost` |
| `src/client/connection.ts` | `resumeSession`, `loadSession` |
| `src/client/open.ts` | the restore path, `OpenedAcp.cwd` / `restoredWith` |
| `src/client/backend.ts` | whole file: resume, reconnect, baseline persistence |
| `src/client/index.ts` | doc comment |
| `test/fixtures/fake-agent/script.ts`, `agent.ts`, `main.ts` | restore support, `relaunch` |
| `test/helpers/in-memory-launch.ts` | per-launch script |
| `test/unit/client/usage.test.ts`, `errors.test.ts`, `connection.test.ts`, `open.test.ts`, `backend.test.ts`, `backend-process.test.ts` | new cases; the S4-2 resume refusal test removed |
| `test/node/acp-backend.test.ts` | cross-process resume over Node |
| `.github/workflows/ci.yml` | node job timeout 10 → 20 minutes |
| `README.md`, `CHANGELOG.md`, `RELEASING.md` | resume docs, notes, S4 acceptance |
| `.nax/mono/packages/nax-agent-acp/context.md` | status (then `nax generate`) |
| `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` | D6 amendments |

---

### Task 0: nax-agent `TranscriptAcpRecord.costUsd` (D6-a)

**Files:**
- Modify: `packages/nax-agent/src/native/session/transcript-types.ts:17-22`
- Test: `packages/nax-agent/test/unit/native/transcript-store.test.ts`
- Modify: `packages/nax-agent/CHANGELOG.md`

**Interfaces:**
- Produces: `TranscriptAcpRecord.costUsd?: number`, used by Task 4 (`storedSessionOf`) and Task 6 (`saveBaseline`).

- [ ] **Step 1: Write the round-trip test**

In `test/unit/native/transcript-store.test.ts`, inside `describe("createFileTranscriptStore", () => {`, after the test `"save then load round-trips the document, turn and schemaVersion included"`, add:

```ts
  test("an ACP document round-trips its backend and acp record, cost baseline included (S4-6 D6-a)", async () => {
    const store = createFileTranscriptStore(dir);
    const doc = {
      backend: "acp:claude",
      acp: { agentSessionId: "a-1", agent: "claude", agentVersion: "0.85.1", cwd: "/w", costUsd: 0.0125 },
      savedAt: "t",
      messages: [],
    };
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
  });
```

- [ ] **Step 2: Run it: it fails to typecheck**

Run (from `packages/nax-agent`): `bun run typecheck`
Expected: FAIL. TS2353 reports that `costUsd` does not exist in `TranscriptAcpRecord` (the doc literal is passed to `save`).

- [ ] **Step 3: Add the field**

In `src/native/session/transcript-types.ts` replace:

```ts
export interface TranscriptAcpRecord {
  readonly agentSessionId: string;
  readonly agent: string;
  readonly agentVersion?: string;
  readonly cwd: string;
}
```

with:

```ts
export interface TranscriptAcpRecord {
  readonly agentSessionId: string;
  readonly agent: string;
  readonly agentVersion?: string;
  readonly cwd: string;
  /**
   * The agent's cumulative cost reading (USD) at the end of the session's last
   * priced turn. A resumed ACP session measures its next turn's cost from it,
   * because the agent's running total survives a resume (S4-6 D6-a).
   */
  readonly costUsd?: number;
}
```

- [ ] **Step 4: Run typecheck and the test**

Run (from `packages/nax-agent`):
```bash
bun run typecheck
bun test test/unit/native/transcript-store.test.ts --timeout=60000
bun run check:api
```
Expected: all pass. `check:api` reports no change.

- [ ] **Step 5: CHANGELOG**

In `packages/nax-agent/CHANGELOG.md`, under `## [Unreleased]` → `### Added`, after the line that starts with ``- `TranscriptDoc.backend` and `TranscriptDoc.acp` ``, add:

```md
- `TranscriptAcpRecord.costUsd`: the ACP agent's cumulative cost reading at the session's last priced turn, so a resumed ACP session prices its next turn from it.
```

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/native/session/transcript-types.ts packages/nax-agent/test/unit/native/transcript-store.test.ts packages/nax-agent/CHANGELOG.md
git commit -m "feat(nax-agent): TranscriptAcpRecord.costUsd for ACP resume pricing (S4-6 D6-a)"
```

---

### Task 1: The cost meter's baseline (D6-a)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/usage.ts`
- Test: `packages/nax-agent-acp/test/unit/client/usage.test.ts`

**Interfaces:**
- Produces: `createCostMeter(initialBaseline?: number): CostMeter`; `CostMeter.baseline(): number`. Used by Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/usage.test.ts`:

```ts
describe("createCostMeter: a seeded baseline (S4-6 D6-a)", () => {
  test("a resumed agent whose total includes earlier turns: the turn costs its own share", () => {
    const meter = createCostMeter(0.01);
    expect(meter.baseline()).toBe(0.01);
    meter.beginTurn();
    meter.observe(usd(0.025));
    const turn = meter.settle();
    expect(turn.costSource).toBe("reported");
    expect(turn.costUsd).toBeCloseTo(0.015, 10);
    expect(meter.baseline()).toBe(0.025);
  });

  test("an agent whose counter restarted below the seed: the raw reading, never negative", () => {
    const meter = createCostMeter(0.5);
    meter.beginTurn();
    meter.observe(usd(0.004));
    expect(meter.settle()).toEqual({ costUsd: 0.004, costSource: "reported" });
    expect(meter.baseline()).toBe(0.004);
  });

  test("an unpriced turn keeps the seed", () => {
    const meter = createCostMeter(0.2);
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    expect(meter.baseline()).toBe(0.2);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a seed of %p is 0", (seed) => {
    expect(createCostMeter(seed).baseline()).toBe(0);
  });

  test("no seed is 0", () => {
    expect(createCostMeter().baseline()).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run (from `packages/nax-agent-acp`): `bun test ./test/unit/client/usage.test.ts --timeout=60000`
Expected: FAIL, `meter.baseline is not a function`.

- [ ] **Step 3: Implement**

In `src/client/usage.ts`, replace the header comment's last two sentences:

```ts
 * reading: the session's meter remembers the reading at the end of the last priced
 * turn (0 for a new agent process), and a turn's cost is its latest reading minus
 * that. A reading below the baseline means the agent's counter restarted, so the
 * raw reading is the turn's cost. No reading: costUsd 0, "unpriced", baseline kept.
 */
```

with:

```ts
 * reading: the session's meter remembers the reading at the end of the last priced
 * turn, and a turn's cost is its latest reading minus that. A new session starts at
 * 0; a resumed or reconnected one starts at the stored baseline, because the agent's
 * running total survives a resume (S4-6 D6-a). A reading below the baseline means
 * the agent's counter restarted, so the raw reading is the turn's cost. No reading:
 * costUsd 0, "unpriced", baseline kept.
 */
```

Replace the `CostMeter` interface:

```ts
export interface CostMeter {
  /** Starts a turn: forgets readings of a turn that never settled. */
  beginTurn(): void;
  /** A usage_update's `cost`: kept when it is a finite, non-negative USD amount. */
  observe(cost: unknown): void;
  /** The turn's cost; a priced turn moves the baseline to its latest reading. */
  settle(): TurnCost;
}
```

with:

```ts
export interface CostMeter {
  /** Starts a turn: forgets readings of a turn that never settled. */
  beginTurn(): void;
  /** A usage_update's `cost`: kept when it is a finite, non-negative USD amount. */
  observe(cost: unknown): void;
  /** The turn's cost; a priced turn moves the baseline to its latest reading. */
  settle(): TurnCost;
  /** The reading the next priced turn is measured from (D6-a). */
  baseline(): number;
}
```

Replace:

```ts
export function createCostMeter(): CostMeter {
  let baseline = 0;
  let latest: number | undefined;
  return {
```

with:

```ts
/** `initialBaseline`: the stored reading of a resumed session; anything but a finite, non-negative number is 0. */
export function createCostMeter(initialBaseline = 0): CostMeter {
  let baseline = Number.isFinite(initialBaseline) && initialBaseline >= 0 ? initialBaseline : 0;
  let latest: number | undefined;
  return {
```

and inside the returned object, after the `settle()` method's closing `},`, add:

```ts
    baseline: () => baseline,
```

- [ ] **Step 4: Run the tests**

Run: `bun test ./test/unit/client/usage.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/usage.ts packages/nax-agent-acp/test/unit/client/usage.test.ts
git commit -m "feat(nax-agent-acp): cost meter seeds and reports its baseline (S4-6 D6-a)"
```

---

### Task 2: Errors: a lost session and a closed session (D6-e, D6-g)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/errors.ts`
- Test: `packages/nax-agent-acp/test/unit/client/errors.test.ts`

**Interfaces:**
- Produces: `openRequestError(step, err, secrets)` returns `AGENT_SESSION_NOT_FOUND` for a lost session on `session/resume` / `session/load`; `sessionLost(sessionId: string, reason: string): AgentSessionError` (`AGENT_SESSION_CLOSED`). Used by Tasks 5 and 6.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/errors.test.ts` (it already imports from `#src/client/errors`; add `openRequestError` and `sessionLost` to that import if missing, and `RequestError` from `@agentclientprotocol/sdk`):

```ts
describe("openRequestError on a restore (S4-6 D6-e)", () => {
  test("resourceNotFound on session/resume or session/load: AGENT_SESSION_NOT_FOUND", () => {
    for (const step of ["session/resume", "session/load"]) {
      const err = openRequestError(step, RequestError.resourceNotFound("fake-session-1"), []);
      expect(err.code).toBe("AGENT_SESSION_NOT_FOUND");
      expect(err.context).toMatchObject({ step });
    }
  });

  test("an agent's own 'session not found' text on a restore is NOT_FOUND too", () => {
    const err = openRequestError("session/load", new RequestError(-32603, "Session not found: abc"), []);
    expect(err.code).toBe("AGENT_SESSION_NOT_FOUND");
  });

  test("-32002 on another step stays BACKEND_UNAVAILABLE", () => {
    expect(openRequestError("session/new", RequestError.resourceNotFound("x"), []).code).toBe(
      "AGENT_SESSION_BACKEND_UNAVAILABLE",
    );
  });

  test("auth on a restore stays AUTH_REQUIRED; the excerpt is redacted", () => {
    const secret = "s3cr3t-token-value-0123";
    const err = openRequestError("session/resume", new RequestError(-32000, `login needed ${secret}`), [secret]);
    expect(err.code).toBe("AGENT_SESSION_AUTH_REQUIRED");
    expect(err.message).not.toContain(secret);
  });
});

describe("sessionLost (S4-6 D6-g)", () => {
  test("AGENT_SESSION_CLOSED with the session id", () => {
    const err = sessionLost("s-1", "its agent process is gone");
    expect(err.code).toBe("AGENT_SESSION_CLOSED");
    expect(err.message).toContain("its agent process is gone");
    expect(err.context).toMatchObject({ sessionId: "s-1" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ./test/unit/client/errors.test.ts --timeout=60000`
Expected: FAIL. `sessionLost` is not exported, and the NOT_FOUND cases return `AGENT_SESSION_BACKEND_UNAVAILABLE`.

- [ ] **Step 3: Implement**

In `src/client/errors.ts`, after:

```ts
/** JSON-RPC code of `RequestError.authRequired()`. */
const AUTH_REQUIRED_CODE = -32000;
```

add:

```ts
/** JSON-RPC code of `RequestError.resourceNotFound()`: Claude's adapter answers an unknown session with it (D6-e). */
const RESOURCE_NOT_FOUND_CODE = -32002;

/** The steps whose not-found answer means the agent lost the stored session (§6.9 step 2). */
const RESTORE_STEPS: ReadonlySet<string> = new Set(["session/resume", "session/load"]);

/** Agent text reporting a lost session, for agents that answer with another code. */
const SESSION_NOT_FOUND_TEXT = /session not found|no conversation found/i;

function lostOnRestore(step: string, err: RequestError): boolean {
  return RESTORE_STEPS.has(step) && (err.code === RESOURCE_NOT_FOUND_CODE || SESSION_NOT_FOUND_TEXT.test(err.message));
}
```

Replace the body of `openRequestError`:

```ts
/** A rejected open-phase request: initialize, session/new or session/set_config_option. */
export function openRequestError(step: string, err: RequestError, secrets: readonly string[]): AgentSessionError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(
      `The ACP agent requires authentication (${step}): ${excerpt}`,
      "AGENT_SESSION_AUTH_REQUIRED",
      { step },
    );
  }
  return backendUnavailable(`${step} failed: ${excerpt}`, { step, rpcCode: err.code });
}
```

with:

```ts
/**
 * A rejected open-phase request: initialize, session/new, session/resume,
 * session/load or session/set_config_option. Classification runs on the raw
 * message; only the redacted excerpt escapes (§7).
 */
export function openRequestError(step: string, err: RequestError, secrets: readonly string[]): AgentSessionError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(
      `The ACP agent requires authentication (${step}): ${excerpt}`,
      "AGENT_SESSION_AUTH_REQUIRED",
      { step },
    );
  }
  if (lostOnRestore(step, err)) {
    return new AgentSessionError(
      `The ACP agent no longer has this session (${step}): ${excerpt}`,
      "AGENT_SESSION_NOT_FOUND",
      { step },
    );
  }
  return backendUnavailable(`${step} failed: ${excerpt}`, { step, rpcCode: err.code });
}
```

After `closedDuringOpen`, add:

```ts
/** The session cannot run another turn: closed, or its agent is gone and cannot be reconnected (§6.3 step 5). */
export function sessionLost(sessionId: string, reason: string): AgentSessionError {
  return new AgentSessionError(`ACP session "${sessionId}" is closed: ${reason}`, "AGENT_SESSION_CLOSED", {
    sessionId,
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test ./test/unit/client/errors.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/errors.ts packages/nax-agent-acp/test/unit/client/errors.test.ts
git commit -m "feat(nax-agent-acp): NOT_FOUND for a lost session on restore, sessionLost (S4-6 D6-e)"
```

---

### Task 3: Connection and fake agent: `session/resume`, `session/load`, per-launch scripts (D6-l)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/connection.ts`
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/main.ts` (whole file)
- Modify: `packages/nax-agent-acp/test/helpers/in-memory-launch.ts`
- Test: `packages/nax-agent-acp/test/unit/client/connection.test.ts`

**Interfaces:**
- Produces:
  - `AcpLink.resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>`
  - `AcpLink.loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>`
  - `FakeScript` fields `knownSessions`, `restoredSessionId`, `restoreFailure`, `loadReplay`, `loadPermission`, `relaunch`
  - `scriptFor(script: FakeScript, launchIndex: number): FakeScript`
  - fake records `session/resume`, `session/load`, `load-permission-outcome`

- [ ] **Step 1: Write the failing connection tests**

Append to `test/unit/client/connection.test.ts`:

```ts
describe("openConnection: restoring a session (S4-6, spec §6.9)", () => {
  test("session/resume and session/load reach the agent; the agent's extra sessionId passes through (D6-d)", async () => {
    const { link, callsTo } = pair({ restoredSessionId: "fake-session-1" });
    const params = { sessionId: "fake-session-1", cwd: "/w", mcpServers: [] };
    const resumed: unknown = await link.resumeSession(params);
    const loaded: unknown = await link.loadSession(params);
    expect(resumed).toEqual({ sessionId: "fake-session-1" });
    expect(loaded).toEqual({ sessionId: "fake-session-1" });
    expect(callsTo("session/resume")).toEqual([params]);
    expect(callsTo("session/load")).toEqual([params]);
  });

  test("an unknown session is the JSON-RPC error resourceNotFound", async () => {
    const { link } = pair({ knownSessions: [] });
    const err = await link.resumeSession({ sessionId: "gone", cwd: "/w" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ code: -32002 });
  });

  test("a load replays history as session/update before it answers", async () => {
    const { link, updates } = pair({
      loadReplay: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } }],
    });
    await link.loadSession({ sessionId: "fake-session-1", cwd: "/w", mcpServers: [] });
    expect(updates.map((n) => n.update.sessionUpdate)).toEqual(["agent_message_chunk"]);
  });
});
```

Run: `bun test ./test/unit/client/connection.test.ts --timeout=60000`
Expected: FAIL to typecheck or run: `link.resumeSession is not a function`, and the `FakeScript` fields do not exist.

- [ ] **Step 2: Add the link methods**

In `src/client/connection.ts`, add to the SDK type import list (keep it sorted as biome orders it): `type LoadSessionRequest`, `type LoadSessionResponse`, `type ResumeSessionRequest`, `type ResumeSessionResponse`.

In `interface AcpLink`, after `newSession(...)`:

```ts
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
```

In the object `openConnection` returns, after `newSession: ...`:

```ts
    resumeSession: (params) => agent.request(methods.agent.session.resume, params),
    loadSession: (params) => agent.request(methods.agent.session.load, params),
```

In the header comment, replace `Outbound calls use the connection's request API directly;` with `Outbound calls (including session/resume and session/load, S4-6) use the connection's request API directly;`.

- [ ] **Step 3: Extend the fake's script**

In `test/fixtures/fake-agent/script.ts`, in `interface FakeScript`, after `readonly recordEnv?: readonly string[];`, add:

```ts
  /** session/resume and session/load find these agent sessions; default [the script's sessionId]. Others: resourceNotFound. */
  readonly knownSessions?: readonly string[];
  /** Echoed as a top-level `sessionId` in resume/load answers, as Claude's adapter does (S4-6 D6-d). */
  readonly restoredSessionId?: string;
  /** session/resume and session/load fail with this JSON-RPC error. */
  readonly restoreFailure?: RpcFailure;
  /** session/update notifications sent while session/load runs: the history replay. */
  readonly loadReplay?: readonly SessionUpdate[];
  /** One session/request_permission while session/load runs; its answer is recorded as `load-permission-outcome`. */
  readonly loadPermission?: boolean;
  /** Overrides for every launch after the first (reconnect and resume tests, S4-6 D6-l). */
  readonly relaunch?: Omit<FakeScript, "relaunch">;
```

At the end of the file add:

```ts
/** The script one launch runs: `relaunch` overrides every launch after the first (S4-6 D6-l). */
export function scriptFor(script: FakeScript, launchIndex: number): FakeScript {
  return launchIndex > 0 && script.relaunch !== undefined ? { ...script, ...script.relaunch } : script;
}
```

- [ ] **Step 4: The fake answers restores**

In `test/fixtures/fake-agent/agent.ts`:

Add to the `@agentclientprotocol/sdk` import list: `type ResumeSessionResponse`, `type SessionConfigOption`.

Update the header comment's first sentence to: `The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize, session/new, session/resume, session/load, session/set_config_option, session/prompt and session/close from a FakeScript,`.

Before `export function buildFakeAgent(`, add:

```ts
/** Resume and load fail as scripted, or with resourceNotFound for a session the agent does not hold (D6-l). */
function checkRestore(script: FakeScript, ownId: string, requested: string): void {
  if (script.restoreFailure !== undefined) throw rpcError(script.restoreFailure);
  if (!(script.knownSessions ?? [ownId]).includes(requested)) throw RequestError.resourceNotFound(requested);
}

/** A resume/load answer. Claude's adapter also echoes the session id, outside the protocol's schema (D6-d). */
function restoredResponse(script: FakeScript, configOptions: readonly SessionConfigOption[]): ResumeSessionResponse {
  const response = {
    ...(script.configOptions === undefined ? {} : { configOptions: [...configOptions] }),
    ...(script.restoredSessionId === undefined ? {} : { sessionId: script.restoredSessionId }),
  };
  return response;
}

/** session/load's history replay: updates, then optionally one permission request. */
async function replay(script: FakeScript, sessionId: string, client: AgentContext, hooks: FakeHooks): Promise<void> {
  for (const update of script.loadReplay ?? []) {
    await client.notify(methods.client.session.update, { sessionId, update });
  }
  if (script.loadPermission !== true) return;
  const response = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: "replay-permission", title: "Replay an edit", kind: "edit", status: "pending" },
    options: [
      { optionId: "opt-allow_once", name: "allow_once", kind: "allow_once" },
      { optionId: "opt-reject_once", name: "reject_once", kind: "reject_once" },
    ],
  });
  hooks.record("load-permission-outcome", response.outcome);
}
```

In `buildFakeAgent`, after the `.onRequest(methods.agent.session.new, ...)` block (which ends with `return { sessionId, ...(script.configOptions === undefined ? {} : { configOptions }) };\n    })`), add:

```ts
    .onRequest(methods.agent.session.resume, async (ctx) => {
      hooks.record("session/resume", ctx.params);
      mcpServers = ctx.params.mcpServers ?? [];
      checkRestore(script, sessionId, ctx.params.sessionId);
      return restoredResponse(script, configOptions);
    })
    .onRequest(methods.agent.session.load, async (ctx) => {
      hooks.record("session/load", ctx.params);
      mcpServers = ctx.params.mcpServers;
      checkRestore(script, sessionId, ctx.params.sessionId);
      await replay(script, ctx.params.sessionId, ctx.client, hooks);
      return restoredResponse(script, configOptions);
    })
```

If `ctx.client` is not available on an agent request handler context at this point, use the same accessor the `session/prompt` handler uses (`ctx.client`). That handler already passes it to `runTurn`.

- [ ] **Step 5: Per-launch scripts**

Replace `test/fixtures/fake-agent/main.ts` with:

```ts
/**
 * Subprocess entry of the fake ACP agent. FAKE_AGENT_SCRIPT holds the JSON
 * FakeScript. FAKE_AGENT_RECORD, when set, names a file every received request
 * is appended to as one JSON line, after a "start" record with the pid, cwd and
 * which of `recordEnv` are set. The number of "start" records already in that
 * file is this launch's index, so `relaunch` applies from the second launch on
 * (S4-6 D6-l). Runs under Bun (unit suite) and Node 22+ (contract suite, type
 * stripping), so it uses erasable TypeScript only and writes stderr synchronously
 * (pipes are asynchronous on macOS).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { buildFakeAgent } from "./agent.ts";
import { type FakeScript, scriptFor } from "./script.ts";

const recordPath = process.env.FAKE_AGENT_RECORD;

/** Launches before this one: the "start" records already written. */
function priorLaunches(path: string | undefined): number {
  if (path === undefined || !existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith('{"method":"start"')).length;
}

const script: FakeScript = scriptFor(JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? "{}"), priorLaunches(recordPath));

function record(method: string, params: unknown): void {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ method, params })}\n`);
}

function exit(code: number, stderr?: string): never {
  if (stderr !== undefined) writeSync(2, stderr);
  process.exit(code);
}

const startup = script.startup ?? {};
if (startup.ignoreSigterm === true) process.on("SIGTERM", () => {});
record("start", {
  pid: process.pid,
  cwd: process.cwd(),
  env: Object.fromEntries((script.recordEnv ?? []).map((key) => [key, process.env[key] !== undefined])),
});
if (startup.spawnChild === true) record("child", { pid: spawn("sleep", ["30"], { stdio: "ignore" }).pid });
if (startup.stderr !== undefined) writeSync(2, startup.stderr);
if (startup.exitCode !== undefined) exit(startup.exitCode);
if (startup.hang === true) {
  setInterval(() => {}, 60_000);
} else {
  if (startup.garbageLine === true) writeSync(1, "this line is not JSON\n");
  if (startup.oversizedLineBytes !== undefined) writeSync(1, `${"x".repeat(startup.oversizedLineBytes)}\n`);
  buildFakeAgent(script, { record, exit }).connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
}
```

In `test/helpers/in-memory-launch.ts`:
- change the import `import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";` to `import { type FakeRecord, type FakeScript, scriptFor } from "#test/fixtures/fake-agent/script";`
- replace `const app = buildFakeAgent(script, {` with `const app = buildFakeAgent(scriptFor(script, requests.length - 1), {`
- add to the header comment: `Each launch runs scriptFor(script, n), so \`relaunch\` applies from the second launch on (S4-6).`

- [ ] **Step 6: Run the connection tests and the whole unit suite**

Run:
```bash
bun test ./test/unit/client/connection.test.ts --timeout=60000
bun test ./test/unit/ --timeout=60000
bun run typecheck
```
Expected: PASS. The resume test passing proves the SDK client keeps the non-schema `sessionId` (D6-d). If it fails because the field was stripped, stop and report: D6-d's identity check would then need another source.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent-acp/src/client/connection.ts packages/nax-agent-acp/test/fixtures/fake-agent packages/nax-agent-acp/test/helpers/in-memory-launch.ts packages/nax-agent-acp/test/unit/client/connection.test.ts
git commit -m "feat(nax-agent-acp): session/resume and session/load on the link; fake agent restores (S4-6 D6-l)"
```

---

### Task 4: `resume.ts`: the stored document, the restore and identity (D6-b to D6-e, D6-k)

**Files:**
- Create: `packages/nax-agent-acp/src/client/resume.ts`
- Test: `packages/nax-agent-acp/test/unit/client/resume.test.ts`

**Interfaces:**
- Consumes: `AcpLink.resumeSession` / `loadSession` (Task 3), `capabilityUnsupported` (errors.ts), `CapabilityRecord` (capabilities.ts), `ResolvedAcpOptions` (`kind`, `agentName`), `isRecord` (text.ts)
- Produces:
  ```ts
  export const MAX_SESSION_ID_CHARS = 512;
  export interface Restore { readonly agentSessionId: string; readonly cwd: string; readonly costUsd: number }
  export type RestoredWith = "resume" | "load";
  export interface RestoredSession {
    readonly agentSessionId: string; readonly cwd: string;
    readonly configOptions: readonly SessionConfigOption[]; readonly restoredWith: RestoredWith;
  }
  export interface SessionSetup { readonly mcpServers: McpServer[]; readonly _meta?: Record<string, unknown> }
  export type OpenStep = <T>(label: string, request: Promise<T>) => Promise<T>;
  export function isUsableSessionId(value: unknown): value is string;
  export function canRestore(record: CapabilityRecord): boolean;
  export function storedSessionOf(doc: TranscriptDoc, ctx: BackendOpenContext, options: ResolvedAcpOptions): Restore;
  export function checkRestored(restore: Restore, via: RestoredWith, response: ResumeSessionResponse | LoadSessionResponse): RestoredSession;
  export function restoreSession(restore: Restore, record: CapabilityRecord, setup: SessionSetup, link: AcpLink, step: OpenStep): Promise<RestoredSession>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/resume.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptDoc } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { CapabilityRecord } from "#src/client/capabilities";
import { resolveAcpOptions } from "#src/client/options";
import {
  canRestore,
  checkRestored,
  isUsableSessionId,
  MAX_SESSION_ID_CHARS,
  type Restore,
  storedSessionOf,
} from "#src/client/resume";
import { CLAUDE_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";
import { naxError, sessionError, thrown } from "#test/helpers/errors";
import { openContext } from "#test/helpers/open-context";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-resume-unit-");
});
afterEach(() => cleanupTempDir(dir));

const OPTIONS = resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, command: "fake-claude" }, { PATH: "" });

function docWith(acp: unknown, backend = "acp:claude"): TranscriptDoc {
  return JSON.parse(JSON.stringify({ backend, acp, messages: [], savedAt: "t" }));
}

const RECORD: CapabilityRecord = {
  protocolVersion: 1,
  loadSession: false,
  resume: false,
  close: false,
  mcpHttp: false,
  readOnlyMode: true,
  preApproval: true,
};

describe("storedSessionOf (spec §6.9 step 1, S4-6 D6-b, D6-c)", () => {
  test("a valid record: the stored id, the stored cwd spelling and the cost baseline", () => {
    const restore = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir, costUsd: 0.02 }),
      openContext(dir),
      OPTIONS,
    );
    expect(restore).toEqual({ agentSessionId: "a-1", cwd: dir, costUsd: 0.02 });
  });

  test("another backend kind: BACKEND_MISMATCH", () => {
    const err = sessionError(
      thrown(() =>
        storedSessionOf(docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir }, "native"), openContext(dir), OPTIONS),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_MISMATCH");
  });

  test("a document without backend reads as native: BACKEND_MISMATCH", () => {
    const doc: TranscriptDoc = JSON.parse(JSON.stringify({ messages: [], savedAt: "t" }));
    expect(sessionError(thrown(() => storedSessionOf(doc, openContext(dir), OPTIONS))).code).toBe(
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
  });

  test.each([
    ["no acp record", undefined],
    ["acp is not an object", "x"],
    ["empty agentSessionId", { agentSessionId: "", agent: "claude", cwd: "/w" }],
    ["non-string agentSessionId", { agentSessionId: 7, agent: "claude", cwd: "/w" }],
    ["oversized agentSessionId", { agentSessionId: "a".repeat(MAX_SESSION_ID_CHARS + 1), agent: "claude", cwd: "/w" }],
    ["no agent", { agentSessionId: "a-1", cwd: "/w" }],
    ["empty cwd", { agentSessionId: "a-1", agent: "claude", cwd: "" }],
    ["another agent under the same kind", { agentSessionId: "a-1", agent: "codex", cwd: "/w" }],
  ])("%s: TRANSCRIPT_CORRUPT (Review Focus 5)", (_label, acp) => {
    const err = naxError(thrown(() => storedSessionOf(docWith(acp), openContext(dir), OPTIONS)));
    expect(err.code).toBe("TRANSCRIPT_CORRUPT");
  });

  test.each([-1, "0.5", Number.NaN, null])("a costUsd of %p seeds 0 (Review Focus 5)", (costUsd) => {
    const restore = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir, costUsd }),
      openContext(dir),
      OPTIONS,
    );
    expect(restore.costUsd).toBe(0);
  });

  test("another directory: INVALID_OPTIONS on workdir", () => {
    const other = join(dir, "other");
    mkdirSync(other);
    const err = sessionError(
      thrown(() => storedSessionOf(docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir }), openContext(other), OPTIONS)),
    );
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.context).toMatchObject({ path: "workdir" });
  });

  test("the same directory through a symlink or a trailing slash is accepted; the stored spelling is kept (Review Focus 1)", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    const viaLink = storedSessionOf(docWith({ agentSessionId: "a-1", agent: "claude", cwd: link }), openContext(real), OPTIONS);
    expect(viaLink.cwd).toBe(link);
    const slashed = storedSessionOf(docWith({ agentSessionId: "a-1", agent: "claude", cwd: `${real}/` }), openContext(real), OPTIONS);
    expect(slashed.cwd).toBe(`${real}/`);
  });
});

describe("checkRestored (spec §6.9 step 3, S4-6 D6-d, D6-k)", () => {
  const restore: Restore = { agentSessionId: "a-1", cwd: "/w", costUsd: 0 };

  test("the stored id echoed, or none echoed: accepted with the agent's config options", () => {
    const options = [...CLAUDE_CONFIG_OPTIONS];
    expect(checkRestored(restore, "resume", JSON.parse('{"sessionId": "a-1"}'))).toEqual({
      agentSessionId: "a-1",
      cwd: "/w",
      configOptions: [],
      restoredWith: "resume",
    });
    expect(checkRestored(restore, "load", { configOptions: options }).configOptions).toEqual(options);
  });

  test("another id echoed: AGENT_SESSION_TURN_FAILED, detail identity", () => {
    const err = naxError(thrown(() => checkRestored(restore, "resume", JSON.parse('{"sessionId": "someone-else"}'))));
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(err.context).toMatchObject({ detail: "identity" });
  });

  test("a load answered with null: no config options (D6-k)", () => {
    expect(checkRestored(restore, "load", JSON.parse("null")).configOptions).toEqual([]);
  });
});

describe("helpers", () => {
  test("isUsableSessionId", () => {
    expect(isUsableSessionId("a")).toBe(true);
    expect(isUsableSessionId("")).toBe(false);
    expect(isUsableSessionId(3)).toBe(false);
    expect(isUsableSessionId("a".repeat(MAX_SESSION_ID_CHARS + 1))).toBe(false);
  });

  test("canRestore: session/resume or session/load", () => {
    expect(canRestore(RECORD)).toBe(false);
    expect(canRestore({ ...RECORD, resume: true })).toBe(true);
    expect(canRestore({ ...RECORD, loadSession: true })).toBe(true);
  });
});
```

`thrown` and `naxError` already exist in `test/helpers/errors.ts`. Check that `resolveAcpOptions(input, env)` accepts the second argument as `open.test.ts` uses it; that test passes `{ PATH: "/usr/bin" }`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ./test/unit/client/resume.test.ts --timeout=60000`
Expected: FAIL, `Cannot find module '#src/client/resume'`.

- [ ] **Step 3: Implement `resume.ts`**

Create `src/client/resume.ts`:

```ts
/**
 * Resume and reconnect (S4 spec §6.9). Before anything is spawned, the stored
 * document's ACP record is checked against this backend and workdir (step 1).
 * After initialize, the agent session is restored with session/resume when the
 * agent advertises it (no replay), else session/load (its replayed updates and
 * requests reach no turn and are dropped or refused by the router), never as a
 * fresh session (step 2). Claude's adapter echoes the restored session's id
 * outside the protocol's schema; another id than the stored one is refused
 * (step 3, D6-d). The cwd is compared canonically and sent to the agent as
 * stored, because Claude keys its session store by it (D6-c). The stored cost
 * baseline seeds the session's meter (D6-a).
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LoadSessionResponse,
  McpServer,
  ResumeSessionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { AgentSessionError, type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import type { CapabilityRecord } from "#src/client/capabilities";
import type { AcpLink } from "#src/client/connection";
import { capabilityUnsupported } from "#src/client/errors";
import type { ResolvedAcpOptions } from "#src/client/options";
import { isRecord } from "#src/client/text";

/** An agent session id longer than this is not trusted (S4-2 Review Focus 5). */
export const MAX_SESSION_ID_CHARS = 512;

/** A stored agent session to restore: from the document (resume) or the live session (reconnect). */
export interface Restore {
  readonly agentSessionId: string;
  /** The cwd the agent session was created with, spelled as stored. */
  readonly cwd: string;
  /** The meter's starting baseline (D6-a). */
  readonly costUsd: number;
}

export type RestoredWith = "resume" | "load";

export interface RestoredSession {
  readonly agentSessionId: string;
  readonly cwd: string;
  readonly configOptions: readonly SessionConfigOption[];
  readonly restoredWith: RestoredWith;
}

/** What session/new, session/resume and session/load add to `cwd`: the tool host's entry and the pre-approval `_meta` (§6.6). */
export interface SessionSetup {
  readonly mcpServers: McpServer[];
  readonly _meta?: Record<string, unknown>;
}

/** One open-phase request, bounded by initializeTimeoutMs and openSignal (open.ts). */
export type OpenStep = <T>(label: string, request: Promise<T>) => Promise<T>;

export function isUsableSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_SESSION_ID_CHARS;
}

export function canRestore(record: CapabilityRecord): boolean {
  return record.resume || record.loadSession;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function canonicalDir(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function costOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function corrupt(sessionId: string, reason: string): NaxError {
  return new NaxError(`transcript for session "${sessionId}" is unreadable: ${reason}`, "TRANSCRIPT_CORRUPT", {
    stage: "acp",
    sessionId,
  });
}

/** §6.9 step 1 (D6-b, D6-c). Throws before anything is spawned. */
export function storedSessionOf(doc: TranscriptDoc, ctx: BackendOpenContext, options: ResolvedAcpOptions): Restore {
  const sessionId = ctx.sessionId;
  const stored = doc.backend ?? "native";
  if (stored !== options.kind) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by backend "${stored}"; it cannot be resumed with "${options.kind}"`,
      "AGENT_SESSION_BACKEND_MISMATCH",
      { sessionId, stored, kind: options.kind },
    );
  }
  const acp: unknown = doc.acp;
  if (!isRecord(acp) || !isUsableSessionId(acp.agentSessionId) || !nonEmptyString(acp.agent) || !nonEmptyString(acp.cwd)) {
    throw corrupt(sessionId, "its ACP record is missing or malformed");
  }
  if (acp.agent !== options.agentName) throw corrupt(sessionId, "its ACP record names another agent");
  if (canonicalDir(acp.cwd) !== canonicalDir(ctx.workdir)) {
    throw new AgentSessionError(
      `Invalid agent session options: workdir "${ctx.workdir}" is not the directory session "${sessionId}" was created in; resume it with that workdir`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "workdir" },
    );
  }
  return { agentSessionId: acp.agentSessionId, cwd: acp.cwd, costUsd: costOf(acp.costUsd) };
}

/** §6.9 step 3 (D6-d): an echoed id must be the stored one. A null answer (D6-k) has no config options. */
export function checkRestored(
  restore: Restore,
  via: RestoredWith,
  response: ResumeSessionResponse | LoadSessionResponse,
): RestoredSession {
  const raw: unknown = response;
  const echoed = isRecord(raw) ? raw.sessionId : undefined;
  if (echoed !== undefined && echoed !== restore.agentSessionId) {
    throw new NaxError("The ACP agent restored a different session than the stored one", "AGENT_SESSION_TURN_FAILED", {
      stage: "acp",
      detail: "identity",
    });
  }
  return {
    agentSessionId: restore.agentSessionId,
    cwd: restore.cwd,
    configOptions: isRecord(raw) ? (response.configOptions ?? []) : [],
    restoredWith: via,
  };
}

/** §6.9 step 2: session/resume when advertised, else session/load; never a fresh session. */
export async function restoreSession(
  restore: Restore,
  record: CapabilityRecord,
  setup: SessionSetup,
  link: AcpLink,
  step: OpenStep,
): Promise<RestoredSession> {
  const params = { sessionId: restore.agentSessionId, cwd: restore.cwd, ...setup };
  if (record.resume) return checkRestored(restore, "resume", await step("session/resume", link.resumeSession(params)));
  if (record.loadSession) return checkRestored(restore, "load", await step("session/load", link.loadSession(params)));
  throw capabilityUnsupported("resume", "the agent supports neither session/resume nor session/load");
}
```

If `response.configOptions` does not narrow after `isRecord(raw)` (it should, since `response` keeps its declared type), write `configOptions: isRecord(raw) ? (response?.configOptions ?? []) : []`.

- [ ] **Step 4: Run the tests**

Run:
```bash
bun test ./test/unit/client/resume.test.ts --timeout=60000
bun run typecheck
```
Expected: PASS. `restoreSession` is covered through `open.ts` in Task 5.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/resume.ts packages/nax-agent-acp/test/unit/client/resume.test.ts
git commit -m "feat(nax-agent-acp): resume.ts: stored document check, restore and identity (S4-6 §6.9)"
```

---

### Task 5: `open.ts`: the restore path

**Files:**
- Modify: `packages/nax-agent-acp/src/client/open.ts` (whole file below)
- Test: `packages/nax-agent-acp/test/unit/client/open.test.ts`

**Interfaces:**
- Consumes: `restoreSession`, `isUsableSessionId`, `Restore`, `RestoredWith`, `SessionSetup` (Task 4)
- Produces:
  - `openAcpSession(options, ctx, handlers, launch, host?: ToolHost, restore?: Restore): Promise<OpenedAcp>`
  - `OpenedAcp.cwd: string`
  - `OpenedAcp.restoredWith?: RestoredWith`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/open.test.ts`:

```ts
describe("openAcpSession: restoring a stored session (spec §6.9, S4-6)", () => {
  function restoreWith(script: FakeScript, restore: Partial<Restore> = {}) {
    const fake = inMemoryAgent({ ...CLAUDE_SCRIPT, ...script });
    const ctx = openContext(dir);
    const opened = openAcpSession(
      options(),
      ctx,
      createInboundRouter(async (r) => rejectLocally(r)).handlers,
      fake.launch,
      undefined,
      { agentSessionId: "fake-session-1", cwd: dir, costUsd: 0, ...restore },
    );
    return { fake, ctx, opened };
  }

  test("session/resume when advertised: no session/new, the mode re-applied, the document untouched", async () => {
    const { fake, ctx, opened } = restoreWith({ capabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    const acp = await opened;
    expect(fake.callsTo("session/new")).toEqual([]);
    expect(fake.callsTo("session/load")).toEqual([]);
    expect(fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: dir, mcpServers: [] }]);
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    expect(acp).toMatchObject({ agentSessionId: "fake-session-1", cwd: dir, restoredWith: "resume" });
    expect(await ctx.transcriptStore.load("session-1")).toBeNull();
  });

  test("session/load when only loadSession is advertised", async () => {
    const { fake, opened } = restoreWith({ capabilities: { loadSession: true } });
    expect((await opened).restoredWith).toBe("load");
    expect(fake.callsTo("session/load")).toEqual([{ sessionId: "fake-session-1", cwd: dir, mcpServers: [] }]);
  });

  test("a new session reports its cwd and no restoredWith", async () => {
    const { opened } = await openWith(CLAUDE_SCRIPT);
    const acp = await opened;
    expect(acp.cwd).toBe(dir);
    expect(acp.restoredWith).toBeUndefined();
  });

  test.each([
    ["neither resume nor load", {}, "AGENT_SESSION_CAPABILITY_UNSUPPORTED"],
    ["the agent lost the session", { capabilities: { sessionCapabilities: { resume: {} } }, knownSessions: [] }, "AGENT_SESSION_NOT_FOUND"],
    [
      "auth on resume",
      { capabilities: { sessionCapabilities: { resume: {} } }, restoreFailure: { code: -32000, message: "login" } },
      "AGENT_SESSION_AUTH_REQUIRED",
    ],
  ] as const)("%s: %s after initialize; the process is killed", async (_label, script, code) => {
    const { fake, opened } = restoreWith(script);
    expect(sessionError(await rejection(opened)).code).toBe(code);
    expect(fake.kills()).toBe(1);
    expect(fake.callsTo("session/new")).toEqual([]);
  });

  test("another session restored: TURN_FAILED identity; the process is killed", async () => {
    const { fake, opened } = restoreWith({
      capabilities: { sessionCapabilities: { resume: {} } },
      restoredSessionId: "someone-else",
    });
    const err = naxError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(err.context).toMatchObject({ detail: "identity" });
    expect(fake.kills()).toBe(1);
  });

  test("the model is re-applied after the mode", async () => {
    const fake = inMemoryAgent({ ...CLAUDE_SCRIPT, capabilities: { sessionCapabilities: { resume: {} } } });
    await openAcpSession(
      options({ model: "sonnet" }),
      openContext(dir),
      createInboundRouter(async (r) => rejectLocally(r)).handlers,
      fake.launch,
      undefined,
      { agentSessionId: "fake-session-1", cwd: dir, costUsd: 0 },
    );
    expect(fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
      { sessionId: "fake-session-1", configId: "model", value: "sonnet" },
    ]);
  });
});
```

Add to the file's imports: `import type { Restore } from "#src/client/resume";`, and `naxError` to the `#test/helpers/errors` import.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ./test/unit/client/open.test.ts --timeout=60000`
Expected: FAIL. `openAcpSession` ignores the sixth argument, so `session/new` is called and `restoredWith` is undefined.

- [ ] **Step 3: Replace `src/client/open.ts`**

```ts
/**
 * Opening an ACP session (S4 spec §6.3 step 1, §6.9): spawn, initialize (form
 * elicitation advertised under ask and full, S4-5 D5-l), capability check, the
 * tool host when the session has tools, then session/new (with the host's server
 * entry and the pre-approval _meta, §6.6) or, for a stored session, session/resume
 * or session/load with the same entry and _meta (resume.ts), then the profile's
 * mode and the model. A new session writes its initial transcript document; a
 * restored one leaves the document as it is (D6-f). Every failure after the spawn
 * kills the agent's process group before it propagates, so a failed open leaves
 * no process behind; the caller stops the tool host. Each agent request is
 * bounded by initializeTimeoutMs (D-c) and by openSignal: close() during open
 * rejects AGENT_SESSION_CLOSED.
 */
import { type ClientCapabilities, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type AgentSessionProfile, type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
  unmetRequirement,
} from "#src/client/capabilities";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import {
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  rpcErrorOf,
} from "#src/client/errors";
import { agentGoneError, type LaunchedAgent, type LaunchFn, pickCandidate } from "#src/client/launch";
import type { ResolvedAcpOptions } from "#src/client/options";
import { preApprovalMeta } from "#src/client/pre-approval";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";
import {
  isUsableSessionId,
  type Restore,
  type RestoredWith,
  restoreSession,
  type SessionSetup,
} from "#src/client/resume";
import type { ToolHost } from "#src/client/tool-host";

export interface OpenedAcp {
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly record: CapabilityRecord;
  readonly agentSessionId: string;
  /** The cwd the agent session was created with; a reconnect restores it with this spelling (D6-c). */
  readonly cwd: string;
  /** How a stored session was restored (§6.9); undefined for a new session. */
  readonly restoredWith?: RestoredWith;
}

interface Opening {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly launched: LaunchedAgent;
  readonly link: AcpLink;
  readonly host: ToolHost | undefined;
  readonly restore: Restore | undefined;
}

/** The agent session before the mode and model are applied. */
interface Established {
  readonly agentSessionId: string;
  readonly cwd: string;
  readonly configOptions: readonly SessionConfigOption[];
  readonly restoredWith?: RestoredWith;
}

function chooseLaunch(options: ResolvedAcpOptions): LaunchCandidate {
  if (options.launch.kind === "explicit") return options.launch.candidate;
  const found = pickCandidate(options.launch.candidates, options.env.PATH);
  if (found !== undefined) return found;
  const tried = options.launch.candidates.map((candidate) => candidate.command);
  throw backendUnavailable(
    `no launch command for "${options.agentName}" was found on PATH (tried ${tried.join(", ")})`,
    {
      tried,
    },
  );
}

/** `restore`: restore that stored agent session instead of creating one (§6.9). */
export async function openAcpSession(
  options: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  handlers: InboundHandlers,
  launch: LaunchFn,
  host?: ToolHost,
  restore?: Restore,
): Promise<OpenedAcp> {
  if (ctx.openSignal.aborted) throw closedDuringOpen(ctx.sessionId);
  const candidate = chooseLaunch(options);
  const launched = launch({ command: candidate.command, args: candidate.args, cwd: ctx.workdir, env: options.env });
  const link = openConnection(launched.target, handlers);
  void launched.exited.then(() =>
    link.close(new NaxError("The ACP agent process exited", "ACP_AGENT_EXITED", { stage: "acp" })),
  );
  try {
    return await establish({ options, ctx, launched, link, host, restore });
  } catch (err) {
    launched.kill();
    link.close();
    throw err;
  }
}

async function step<T>(o: Opening, label: string, request: Promise<T>): Promise<T> {
  const result = await race(request, { timeoutMs: o.options.initializeTimeoutMs, signal: o.ctx.openSignal });
  switch (result.kind) {
    case "ok":
      return result.value;
    case "aborted":
      throw closedDuringOpen(o.ctx.sessionId);
    case "timeout":
      throw backendUnavailable(`${label} timed out after ${o.options.initializeTimeoutMs} ms`, {
        during: label,
        stderr: o.launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets: o.options.secrets }),
      });
    case "failed": {
      const rpc = rpcErrorOf(result.error);
      if (rpc !== undefined) throw openRequestError(label, rpc, o.options.secrets);
      throw await agentGoneError(label, o.launched, o.options.secrets);
    }
  }
}

/** §6.3 step 1.1: no fs and no terminal (R11); form elicitation under ask and full (§6.8, D5-l). */
export function clientCapabilitiesFor(profile: AgentSessionProfile): ClientCapabilities {
  return profile === "ask" || profile === "full" ? { elicitation: { form: {} } } : {};
}

async function establish(o: Opening): Promise<OpenedAcp> {
  const init = await step(
    o,
    "initialize",
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: clientCapabilitiesFor(o.ctx.profile) }),
  );
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    throw backendUnavailable(
      `the agent speaks ACP protocol version ${String(init.protocolVersion)}; this client speaks ${PROTOCOL_VERSION}`,
      { protocolVersion: String(init.protocolVersion).slice(0, 32) },
    );
  }
  const record = buildCapabilityRecord(init, o.options.entry);
  const unmet = unmetRequirement(record, {
    profile: o.ctx.profile,
    toolCount: o.ctx.tools.length,
    resume: o.restore !== undefined,
  });
  if (unmet !== undefined) throw capabilityUnsupported(unmet.capability, unmet.reason);
  const setup = await sessionSetup(o);
  const session =
    o.restore === undefined
      ? await newSession(o, setup)
      : await restoreSession(o.restore, record, setup, o.link, (label, request) => step(o, label, request));
  await applyConfig(o, session.agentSessionId, session.configOptions);
  if (o.restore === undefined) {
    await o.ctx.transcriptStore.save(o.ctx.sessionId, initialDoc(o, record, session.agentSessionId));
  }
  return {
    launched: o.launched,
    link: o.link,
    record,
    agentSessionId: session.agentSessionId,
    cwd: session.cwd,
    ...(session.restoredWith === undefined ? {} : { restoredWith: session.restoredWith }),
  };
}

async function newSession(o: Opening, setup: SessionSetup): Promise<Established> {
  const created = await step(o, "session/new", o.link.newSession({ cwd: o.ctx.workdir, ...setup }));
  if (!isUsableSessionId(created.sessionId)) throw backendUnavailable("session/new returned no usable session id");
  return { agentSessionId: created.sessionId, cwd: o.ctx.workdir, configOptions: created.configOptions ?? [] };
}

/** §6.3 step 3: start the tool host when the session has tools; its entry and the pre-approval `_meta` (§6.6). */
async function sessionSetup(o: Opening): Promise<SessionSetup> {
  if (o.host === undefined) return { mcpServers: [] };
  const meta = preApprovalMeta(
    o.options.entry?.preApproval,
    o.ctx.tools.map((tool) => tool.name),
  );
  if (meta === undefined) throw capabilityUnsupported("tools", "the agent has no way to pre-approve embedder tools");
  const server = await o.host.start().catch((err: unknown) => {
    throw backendUnavailable(`the tool host could not start: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { mcpServers: [server], _meta: { ...meta } };
}

/** §6.3 step 5: the profile's mode, then the model. Only values the agent offered are set. */
async function applyConfig(o: Opening, sessionId: string, offered: readonly SessionConfigOption[]): Promise<void> {
  const mode = modeFor(o.ctx.profile, o.options.entry);
  if (mode !== undefined && !offersValue(offered, mode.configId, mode.value)) {
    throw capabilityUnsupported("profile", `the agent does not offer ${mode.configId} "${mode.value}"`);
  }
  const afterMode =
    mode === undefined
      ? offered
      : ((await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, ...mode }))).configOptions ??
        offered);
  const model = o.options.model;
  if (model === undefined) return;
  const configId = modelOptionId(afterMode, model);
  if (configId === undefined) throw capabilityUnsupported("model", `the agent offers no model option "${model}"`);
  await step(o, "session/set_config_option", o.link.setConfigOption({ sessionId, configId, value: model }));
}

function initialDoc(o: Opening, record: CapabilityRecord, agentSessionId: string): TranscriptDoc {
  return {
    backend: o.options.kind,
    acp: {
      agentSessionId,
      agent: o.options.agentName,
      ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
      cwd: o.ctx.workdir,
    },
    messages: [],
    savedAt: new Date().toISOString(),
  };
}
```

Note the deliberate removals: `MAX_SESSION_ID_CHARS` moved to `resume.ts`, `SessionSetup` moved to `resume.ts`, and `McpServer` is no longer imported here.

- [ ] **Step 4: Run the tests**

Run:
```bash
bun test ./test/unit/client/open.test.ts --timeout=60000
bun test ./test/unit/ --timeout=60000
bun run typecheck
```
Expected: PASS. The S4-2 test `"resume -> CAPABILITY_UNSUPPORTED resume"` in `backend.test.ts` still passes at this point, because `backend.ts` still refuses before spawning. Task 6 removes it.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/open.ts packages/nax-agent-acp/test/unit/client/open.test.ts
git commit -m "feat(nax-agent-acp): open restores a stored agent session (S4-6 §6.9)"
```

---

### Task 6: `backend.ts`: resume, reconnect and the persisted baseline (D6-a, D6-f, D6-g, D6-h)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/backend.ts` (whole file below)
- Create: `packages/nax-agent-acp/test/unit/client/backend-resume.test.ts`
- Create: `packages/nax-agent-acp/test/unit/client/backend-reconnect.test.ts`
- Modify: `packages/nax-agent-acp/test/unit/client/backend.test.ts` (remove the refusal)
- Modify: `packages/nax-agent-acp/test/unit/client/backend-process.test.ts` (subprocess reconnect)

**Interfaces:**
- Consumes:
  - `storedSessionOf`, `canRestore`, `Restore` (Task 4)
  - `openAcpSession(..., host, restore)`, `OpenedAcp.cwd` / `restoredWith` (Task 5)
  - `createCostMeter(seed)`, `meter.baseline()` (Task 1)
  - `sessionLost` (Task 2)
  - fake `relaunch`, `knownSessions`, `restoredSessionId`, `loadReplay`, `loadPermission` (Task 3)
- Produces: `AgentSession.backend.capabilities.restoredWith` for restored processes. The reconnect behaviour of §6.3 step 5.

- [ ] **Step 1: Write the resume tests**

Create `test/unit/client/backend-resume.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createMemoryTranscriptStore,
  resumeAgentSession,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { naxError, rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
let workdir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-resume-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const RESUMABLE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { sessionCapabilities: { resume: {} } },
};

const text = (t: string): FakeStep => ({ kind: "text", text: t });
const usd = (amount: number): FakeStep => ({
  kind: "update",
  update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } },
});

interface Harness {
  readonly fake: InMemoryAgent;
  readonly store: TranscriptStore;
}

function harness(script: FakeScript = {}): Harness {
  const fake = inMemoryAgent({ ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  return { fake, store: createMemoryTranscriptStore() };
}

function optionsFor(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return {
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude" }),
    profile: "full",
    workdir,
    transcriptStore: h.store,
    sessionId: "s-1",
    ...extra,
  };
}

async function create(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
  const session = await createAgentSession(optionsFor(h, extra));
  sessions.push(session);
  return session;
}

async function resume(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
  const session = await resumeAgentSession("s-1", optionsFor(h, extra));
  sessions.push(session);
  return session;
}

const promptTexts = (fake: InMemoryAgent) =>
  fake.callsTo("session/prompt").map((p) => JSON.parse(JSON.stringify(p)).prompt[0].text);

describe("resumeAgentSession over ACP: session/resume (spec §6.9)", () => {
  test("a new process resumes the stored agent session; mode re-applied; restoredWith reported", async () => {
    const h = harness({ turns: [{ steps: [text("first")] }], relaunch: { turns: [{ steps: [text("again")] }] } });
    const first = await create(h);
    expect(endOf(await driveTurn(first, "one")).output).toBe("first");
    expect(first.backend.capabilities).not.toHaveProperty("restoredWith");
    await first.close();
    const second = await resume(h);
    expect(h.fake.requests).toHaveLength(2);
    expect(h.fake.callsTo("session/new")).toHaveLength(1);
    expect(h.fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: workdir, mcpServers: [] }]);
    expect(h.fake.callsTo("session/set_config_option")).toHaveLength(2);
    expect(second.backend.capabilities).toMatchObject({ resume: true, restoredWith: "resume" });
    expect(endOf(await driveTurn(second, "two"))).toMatchObject({ status: "completed", output: "again" });
  });

  test("instructions are not sent again once a turn ran (D6-f)", async () => {
    const h = harness();
    const first = await create(h, { instructions: "Be brief." });
    await driveTurn(first, "one");
    await first.close();
    const second = await resume(h, { instructions: "Be brief." });
    await driveTurn(second, "two");
    expect(promptTexts(h.fake)).toEqual(["Be brief.\n\none", "two"]);
  });

  test("a session that never ran a turn sends its instructions with the first prompt after resume (D6-f)", async () => {
    const h = harness();
    const first = await create(h, { instructions: "Be brief." });
    await first.close();
    const second = await resume(h, { instructions: "Be brief." });
    await driveTurn(second, "hello");
    expect(promptTexts(h.fake)).toEqual(["Be brief.\n\nhello"]);
  });

  test("a turn left running by a dead process resumes as interrupted", async () => {
    const h = harness();
    const first = await create(h);
    await first.close();
    await h.store.markTurn("s-1", { turnId: "t-dead", state: "running" });
    const second = await resume(h);
    expect(second.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect(endOf(await driveTurn(second, "go")).status).toBe("completed");
  });
});

describe("resume prices from the stored baseline (D6-a, Review Focus 3)", () => {
  test("turn 1 costs 0.01; after resume the agent reports 0.025: the turn costs 0.015", async () => {
    const h = harness({
      turns: [{ steps: [usd(0.01), text("a")] }],
      relaunch: { turns: [{ steps: [usd(0.025), text("b")] }] },
    });
    const first = await create(h);
    expect(endOf(await driveTurn(first, "one")).costUsd).toBeCloseTo(0.01, 10);
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.01);
    await first.close();
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.01);
    const second = await resume(h);
    const end = endOf(await driveTurn(second, "two"));
    expect(end.costSource).toBe("reported");
    expect(end.costUsd).toBeCloseTo(0.015, 10);
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.025);
  });

  test("a failing baseline write is logged, not fatal", async () => {
    const h = harness({ turns: [{ steps: [usd(0.01), text("a")] }] });
    const inner = h.store;
    const store: TranscriptStore = {
      ...inner,
      save: async (id, doc) => {
        if (doc.acp?.costUsd !== undefined) throw new Error("disk full");
        await inner.save(id, doc);
      },
    };
    const session = await create({ fake: h.fake, store });
    expect(endOf(await driveTurn(session, "one")).status).toBe("completed");
  });
});

describe("resume falls back to session/load (spec §6.9 step 2, Review Focus 4)", () => {
  test("replayed history and a replayed permission request never reach the next turn", async () => {
    const replay: SessionUpdate[] = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } },
      { sessionUpdate: "tool_call", toolCallId: "old-1", title: "Read", kind: "read", status: "completed" },
    ];
    const h = harness({
      capabilities: { loadSession: true },
      relaunch: { loadReplay: replay, loadPermission: true, turns: [{ steps: [text("fresh")] }] },
    });
    const first = await create(h);
    await first.close();
    const second = await resume(h);
    expect(second.backend.capabilities).toMatchObject({ restoredWith: "load" });
    expect(h.fake.callsTo("load-permission-outcome")).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    const events = await driveTurn(second, "go");
    expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []))).toEqual(["fresh"]);
    expect(events.some((e) => e.type === "tool_call" || e.type === "approval_requested")).toBe(false);
  });
});

describe("resume failures (spec §6.9, §7)", () => {
  test("the agent lost the session: AGENT_SESSION_NOT_FOUND; the new process is killed", async () => {
    const h = harness({ relaunch: { knownSessions: [] } });
    await (await create(h)).close();
    expect(sessionError(await rejection(resume(h))).code).toBe("AGENT_SESSION_NOT_FOUND");
    expect(h.fake.kills()).toBe(1);
    expect(h.fake.callsTo("session/new")).toHaveLength(1);
  });

  test("another session restored: TURN_FAILED identity", async () => {
    const h = harness({ relaunch: { restoredSessionId: "someone-else" } });
    await (await create(h)).close();
    const err = naxError(await rejection(resume(h)));
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(err.context).toMatchObject({ detail: "identity" });
  });

  test("an agent with neither resume nor load: CAPABILITY_UNSUPPORTED resume", async () => {
    const h = harness({ capabilities: {} });
    await (await create(h)).close();
    const err = sessionError(await rejection(resume(h)));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "resume" });
  });

  test("a document without its ACP record: TRANSCRIPT_CORRUPT before any spawn", async () => {
    const h = harness();
    await h.store.save("s-1", { backend: "acp:claude", messages: [], savedAt: "t" });
    expect(naxError(await rejection(resume(h))).code).toBe("TRANSCRIPT_CORRUPT");
    expect(h.fake.requests).toHaveLength(0);
  });

  test("another workdir: INVALID_OPTIONS before any spawn", async () => {
    const h = harness();
    await (await create(h)).close();
    const other = join(workdir, "other");
    mkdirSync(other);
    const err = sessionError(await rejection(resume(h, { workdir: other })));
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(h.fake.requests).toHaveLength(1);
  });

  test("the same directory through a symlink resumes, with the stored spelling sent (Review Focus 1)", async () => {
    const real = join(workdir, "real");
    mkdirSync(real);
    const link = join(workdir, "link");
    symlinkSync(real, link);
    const h = harness();
    await (await create(h, { workdir: link })).close();
    await resume(h, { workdir: real });
    expect(h.fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: link, mcpServers: [] }]);
  });
});
```

The `TranscriptStore.save` override in "a failing baseline write" throws a plain `Error`. That is test code, which `check-nax-error` does not scan (it scans `src/`).

- [ ] **Step 2: Write the reconnect tests**

Create `test/unit/client/backend-reconnect.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
let workdir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-reconnect-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const RESUMABLE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
};

const text = (t: string): FakeStep => ({ kind: "text", text: t });
const usd = (amount: number): FakeStep => ({
  kind: "update",
  update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } },
});
/** Lets the backend observe the in-memory process exit. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function open(script: FakeScript, tools: EmbedderTool[] = []): Promise<{ fake: InMemoryAgent; session: AgentSession }> {
  const fake = inMemoryAgent({ ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", initializeTimeoutMs: 30_000 }),
    profile: "full",
    workdir,
    tools,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

/** Starts a turn and returns its iterator once `ready` holds. */
async function startTurn(session: AgentSession, ready: () => boolean): Promise<AsyncIterator<SessionEvent>> {
  const iterator = session.send("go")[Symbol.asyncIterator]();
  void iterator.next();
  await waitForCondition(ready, 2_000);
  return iterator;
}

async function rest(iterator: AsyncIterator<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) out.push(next.value);
  return out;
}

describe("reconnect after a crash (spec §6.3 step 5, S4-6 D6-g)", () => {
  test("a crash between turns: the next turn reconnects with session/resume in a new process", async () => {
    const { fake, session } = await open({ relaunch: { turns: [{ steps: [text("back")] }] } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two"))).toMatchObject({ status: "completed", output: "back" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: workdir, mcpServers: [] }]);
    expect(session.backend.capabilities).toMatchObject({ restoredWith: "resume" });
  });

  test("a crash mid-turn errors that turn; the next one reconnects", async () => {
    const { fake, session } = await open({
      turns: [{ steps: [{ kind: "hang" }] }],
      relaunch: { turns: [{ steps: [text("back")] }] },
    });
    const iterator = await startTurn(session, () => fake.callsTo("session/prompt").length === 1);
    fake.crash();
    expect(endOf(await rest(iterator))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_BACKEND_UNAVAILABLE" },
    });
    expect(endOf(await driveTurn(session, "two")).output).toBe("back");
  });

  test("the cost baseline carries over: 0.01 then 0.03 after a reconnect is 0.02 (Review Focus 3)", async () => {
    const { fake, session } = await open({
      turns: [{ steps: [usd(0.01), text("a")] }],
      relaunch: { turns: [{ steps: [usd(0.03), text("b")] }] },
    });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two")).costUsd).toBeCloseTo(0.02, 10);
  });

  test("an agent without resume or load: AGENT_SESSION_CLOSED, nothing spawned", async () => {
    const { fake, session } = await open({ capabilities: {} });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two"))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
    expect(fake.requests).toHaveLength(1);
  });

  test("a failed reconnect errors the turn; later turns are CLOSED without another spawn", async () => {
    const { fake, session } = await open({ relaunch: { knownSessions: [] } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two")).error?.code).toBe("AGENT_SESSION_NOT_FOUND");
    expect(endOf(await driveTurn(session, "three")).error?.code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.requests).toHaveLength(2);
  });

  test("tools: the reconnect gets a new tool host token and the same pre-approval (spec §6.6)", async () => {
    const tool: EmbedderTool = {
      name: "lookup",
      description: "Look a word up",
      inputSchema: { type: "object", properties: {} },
      approval: "never",
      run: async () => ({ content: "found" }),
    };
    const { fake, session } = await open({}, [tool]);
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    await driveTurn(session, "two");
    const created = JSON.parse(JSON.stringify(fake.callsTo("session/new")[0]));
    const resumed = JSON.parse(JSON.stringify(fake.callsTo("session/resume")[0]));
    expect(resumed._meta).toEqual(created._meta);
    // A new token; the port may be reused by the OS, so the URL is not compared.
    expect(resumed.mcpServers[0].headers).not.toEqual(created.mcpServers[0].headers);
  });
});

describe("cancel or close while reconnecting (Review Focus 2)", () => {
  test("cancel: the turn ends cancelled, the new process is killed, the next send tries again", async () => {
    const { fake, session } = await open({ relaunch: { hangInitialize: true } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    const iterator = await startTurn(session, () => fake.callsTo("initialize").length === 2);
    session.cancel();
    expect(endOf(await rest(iterator)).status).toBe("cancelled");
    // The in-memory launcher counts every kill: the dead process's (a no-op on a real one) and the half-started one.
    expect(fake.kills()).toBe(2);
    const again = await startTurn(session, () => fake.callsTo("initialize").length === 3);
    session.cancel();
    expect(endOf(await rest(again)).status).toBe("cancelled");
  });

  test("close: resolves, the turn ends, the half-started process is killed", async () => {
    const { fake, session } = await open({ relaunch: { hangInitialize: true } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    const iterator = await startTurn(session, () => fake.callsTo("initialize").length === 2);
    await session.close();
    expect(endOf(await rest(iterator)).status).toBe("cancelled");
    // The dead process's kill (a no-op on a real one) and the half-started one's.
    expect(fake.kills()).toBe(2);
  });
});
```

The facade cancels the active turn on `close()` before it closes the backend, so the turn reports `cancelled` from its signal.

- [ ] **Step 3: Remove the S4-2 refusal test, and add the subprocess reconnect**

In `test/unit/client/backend.test.ts`, delete the whole block from `describe("acpBackend: stages not built yet are refused before spawning (D-b)", () => {` through its closing `});`, which contains the single test `"resume -> CAPABILITY_UNSUPPORTED resume"`. If `resumeAgentSession` is then unused in that file, remove it from the import.

In `test/unit/client/backend-process.test.ts`:
- rename the test `"a crash mid-turn: BACKEND_UNAVAILABLE with redacted stderr; later turns AGENT_SESSION_CLOSED"` to `"a crash mid-turn: BACKEND_UNAVAILABLE with redacted stderr; an agent without resume: later turns AGENT_SESSION_CLOSED"`
- after that test, add:

```ts
  test("a crash mid-turn, then the next turn reconnects with session/resume in a new process (S4-6)", async () => {
    const session = await open({
      capabilities: { sessionCapabilities: { resume: {} } },
      turns: [{ steps: [{ kind: "text", text: "partial" }, { kind: "exit", code: 7 }] }],
      relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] },
    });
    expect(endOf(await drain(session.send("x"))).status).toBe("errored");
    expect(endOf(await drain(session.send("y")))).toMatchObject({ status: "completed", output: "back" });
    const records = readRecords(record);
    const pids = records.filter((r) => r.method === "start").map((r) => JSON.parse(JSON.stringify(r.params)).pid);
    expect(new Set(pids).size).toBe(2);
    expect(records.filter((r) => r.method === "session/resume").map((r) => r.params)).toEqual([
      { sessionId: "fake-session-1", cwd: workdir, mcpServers: [] },
    ]);
  });
```

- [ ] **Step 4: Run the new tests to see them fail**

Run:
```bash
bun test ./test/unit/client/backend-resume.test.ts ./test/unit/client/backend-reconnect.test.ts ./test/unit/client/backend-process.test.ts --timeout=60000
```
Expected: FAIL. Resume is refused with `CAPABILITY_UNSUPPORTED resume`, and a turn after a crash ends `AGENT_SESSION_CLOSED`.

- [ ] **Step 5: Replace `src/client/backend.ts`**

```ts
/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. Embedder tools are served by a per-session MCP
 * tool host (§6.6, tool-host.ts) and pre-approved at the adapter (R12); the
 * host's token joins the session's redaction set before the agent starts (D4-i).
 * The agent's updates become turn events with per-turn usage priced by one cost
 * meter per agent process (§6.7, events.ts, usage.ts), and its form elicitations
 * become questions under `ask` and `full` (§6.8, elicitation.ts). A turn's
 * permission decisions, questions and tool calls are cancelled when the turn is
 * cancelled, times out, ends or loses its process (D3-d, D4-f, D5-j).
 *
 * A stored session is restored with session/resume, else session/load, never as
 * a fresh one (§6.9, resume.ts). A crashed or killed agent leaves the session
 * disconnected; the next turn reconnects once the same way, with a new process,
 * router and tool host token, and the cost baseline carried over (§6.3 step 5,
 * S4-6 D6-a, D6-g). An agent that can do neither, or a reconnect that fails,
 * leaves the session closed: later turns end AGENT_SESSION_CLOSED. The baseline
 * is written to the transcript document after each priced turn, so a resume in a
 * new process prices its first turn from it (D6-a).
 */
import {
  type AgentSessionAdapter,
  type BackendInfo,
  type BackendOpenContext,
  getLogger,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { answerElicitation } from "#src/client/elicitation";
import { sessionLost } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { canRestore, type Restore, storedSessionOf } from "#src/client/resume";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";
import { type CostMeter, createCostMeter } from "#src/client/usage";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

/** One agent process and everything bound to it. A reconnect replaces it whole (D6-g). */
interface Live {
  readonly options: ResolvedAcpOptions;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly state: TurnState;
  /** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */
  readonly gone: AbortController;
  /** The embedder tools' MCP host; undefined when the session has no tools. */
  readonly host: ToolHost | undefined;
  /** The process's cumulative cost readings (D5-b), seeded with the session's baseline (D6-a). */
  readonly meter: CostMeter;
  /** Every tool host token the session has used; retired ones stay in the redaction set (D6-g). */
  readonly tokens: readonly string[];
  /** Set when the process exits or is killed. */
  readonly status: { disconnected: boolean };
}

/** The session across its agent processes. */
interface AcpSession {
  readonly base: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  live: Live;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
  /** No reconnect is possible any more: later turns end AGENT_SESSION_CLOSED (§6.3 step 5). */
  lost: boolean;
  /** The cost baseline the transcript document holds (D6-a). */
  savedBaseline: number;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

/** The process's options: the session's tool host tokens join the redaction set (D4-i, D6-g). */
function withTokens(options: ResolvedAcpOptions, tokens: readonly string[]): ResolvedAcpOptions {
  if (tokens.length === 0) return options;
  return Object.freeze({ ...options, secrets: Object.freeze([...options.secrets, ...tokens]) });
}

function toolHostFor(
  ctx: BackendOpenContext,
  router: InboundRouter,
  secrets: readonly string[],
  token: string | undefined,
): ToolHost | undefined {
  if (token === undefined) return undefined;
  const calls = createToolCalls({
    sessionId: ctx.sessionId,
    tools: ctx.tools,
    asks: ctx.asks,
    currentTurnId: ctx.currentTurnId,
    turnSignal: () => router.activeSignal(),
    secrets,
  });
  return createToolHost(calls, token);
}

/** Permission requests and elicitations, decided by profile with the session's redaction set. */
function routerFor(ctx: BackendOpenContext, secrets: readonly string[]): InboundRouter {
  const base = { profile: ctx.profile, asks: ctx.asks, secrets };
  return createInboundRouter(
    (request, signal) => decidePermission(request, { ...base, signal }),
    (request, signal) => answerElicitation(request, { ...base, signal }),
  );
}

/** One agent process: a new agent session, or `restore` restored in it (§6.3 step 1, §6.9). */
async function connect(
  base: ResolvedAcpOptions,
  ctx: BackendOpenContext,
  restore: Restore | undefined,
  retiredTokens: readonly string[],
): Promise<Live> {
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const tokens = token === undefined ? retiredTokens : [...retiredTokens, token];
  const options = withTokens(base, tokens);
  const gone = new AbortController();
  const router = routerFor(ctx, options.secrets);
  const host = toolHostFor(ctx, router, options.secrets, token);
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch, host, restore).catch(
    async (err: unknown) => {
      await host?.stop();
      throw err;
    },
  );
  const status = { disconnected: false };
  void acp.launched.exited.then(() => {
    status.disconnected = true;
    gone.abort();
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      status.disconnected = true;
    },
  };
  const meter = createCostMeter(restore?.costUsd ?? 0);
  return { options, acp, router, state, gone, host, meter, tokens, status };
}

async function openBackend(base: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  // §6.9 step 1 runs before anything is spawned.
  const restore = ctx.resume === undefined ? undefined : storedSessionOf(ctx.resume.doc, ctx, base);
  const live = await connect(base, ctx, restore, []);
  return assemble({
    base,
    ctx,
    live,
    closing: undefined,
    // A restored agent already holds the instructions once a turn has run (D6-f).
    instructionsSent: ctx.resume?.doc.turn !== undefined,
    lost: false,
    savedBaseline: restore?.costUsd ?? 0,
  });
}

/** D6-h: the live process's capability record; a restored process adds restoredWith. */
function infoOf(s: AcpSession): BackendInfo {
  const { record, restoredWith } = s.live.acp;
  const capabilities = restoredWith === undefined ? { ...record } : { ...record, restoredWith };
  return Object.freeze({ kind: s.base.kind, capabilities: Object.freeze(capabilities) });
}

function assemble(s: AcpSession): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: s.ctx.sessionId, agentName: s.base.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(s, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    // Read at access: a reconnect replaces the process and its capability record (D6-h).
    get info() {
      return infoOf(s);
    },
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      s.closing ??= shutdown(s);
      return s.closing;
    },
  };
}

/** The process a turn runs on: reconnects once after a crash or kill (§6.3 step 5). */
async function liveFor(s: AcpSession, signal: AbortSignal): Promise<Live> {
  if (s.closing !== undefined || s.lost) {
    throw sessionLost(s.ctx.sessionId, "its agent process is gone and cannot be reconnected");
  }
  if (!s.live.status.disconnected) return s.live;
  if (!canRestore(s.live.acp.record)) {
    s.lost = true;
    throw sessionLost(
      s.ctx.sessionId,
      "its agent process is gone and the agent supports neither session/resume nor session/load",
    );
  }
  return reconnect(s, signal);
}

/** D6-g: a new process restores the session; a stopped attempt may be retried, a failed one ends the session. */
async function reconnect(s: AcpSession, signal: AbortSignal): Promise<Live> {
  const old = s.live;
  old.acp.launched.kill();
  old.acp.link.close();
  // The old tool host stops and its token is revoked (§6.6).
  await old.host?.stop();
  const restore: Restore = {
    agentSessionId: old.acp.agentSessionId,
    cwd: old.acp.cwd,
    costUsd: old.meter.baseline(),
  };
  // close() aborts openSignal; cancel() and the turn timeout abort the turn signal.
  const ctx: BackendOpenContext = { ...s.ctx, openSignal: AbortSignal.any([s.ctx.openSignal, signal]) };
  try {
    s.live = await connect(s.base, ctx, restore, old.tokens);
    return s.live;
  } catch (err) {
    if (!signal.aborted && !s.ctx.openSignal.aborted) s.lost = true;
    throw err;
  }
}

async function sendTurn(s: AcpSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const signal = opts.signal ?? s.ctx.turnSignal();
  const live = await liveFor(s, signal);
  const instructions = s.instructionsSent ? undefined : s.ctx.instructions;
  s.instructionsSent = true;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  const collector = createTurnCollector(opts.onTurnEvent, { secrets: live.options.secrets, meter: live.meter });
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
    // The release aborted this turn's tool calls; wait for their answers (D4-f).
    await live.host?.drain();
    // Held text and calls left without a result go out before turn_end (D5-e, D5-g).
    collector.finish();
    await saveBaseline(s, live.meter.baseline());
  }
}

/** D6-a: load-merge the baseline into the document. Best effort: a failure is logged, never fatal. */
async function saveBaseline(s: AcpSession, baseline: number): Promise<void> {
  if (baseline === s.savedBaseline) return;
  const { transcriptStore: store, sessionId } = s.ctx;
  try {
    const doc = await store.load(sessionId);
    if (doc?.acp === undefined) return;
    await store.save(sessionId, { ...doc, acp: { ...doc.acp, costUsd: baseline } });
    s.savedBaseline = baseline;
  } catch {
    warn("Could not save the ACP cost baseline", sessionId);
  }
}

function warn(message: string, sessionId: string): void {
  try {
    getLogger().warn("acp", message, { sessionId });
  } catch {
    // A throwing host logger must not fail the turn.
  }
}

async function shutdown(s: AcpSession): Promise<void> {
  const { acp, options, status, host } = s.live;
  if (!status.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  // §6.3 close step 4: stop the tool host and revoke its token.
  await host?.stop();
  await saveFinal(s.ctx.transcriptStore, s.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker and the baseline. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
```

- [ ] **Step 6: Run the backend tests, then the whole unit suite**

Run:
```bash
bun test ./test/unit/client/backend-resume.test.ts ./test/unit/client/backend-reconnect.test.ts ./test/unit/client/backend-process.test.ts ./test/unit/client/backend.test.ts --timeout=60000
bun test ./test/unit/ --timeout=60000
bun run typecheck
```
Expected: PASS.

If `getLogger().warn`'s signature differs from `inbound.ts`'s call (`warn("acp", message, { reason })`), copy that call's exact shape.

If the facade reads `opened.info` only once (it does not today: `agent-session.ts` reads `this.parts.opened.info` in the `backend` getter), D6-h needs no facade change.

- [ ] **Step 7: Lint and the package gates**

Run (from `packages/nax-agent-acp`):
```bash
bun run lint:fix
bun run check:all
bun run test:coverage
```
Expected: PASS.
- `resume.ts` and `backend.ts` are each at or above 80% (`resume.ts`'s last `throw` is reached only when the capability check is bypassed; the line count keeps the file above the floor).
- Complexity stays at or below 20 per function.
- The per-file coverage baseline stays empty.

- [ ] **Step 8: Commit**

```bash
git add packages/nax-agent-acp/src/client/backend.ts packages/nax-agent-acp/test/unit/client
git commit -m "feat(nax-agent-acp): resume and reconnect with a persisted cost baseline (S4-6 §6.9, §6.3 step 5)"
```

---

### Task 7: Node: cross-process resume and the packed smoke (§9, §11.1, D6-i)

**Files:**
- Modify: `packages/nax-agent-acp/test/node/acp-backend.test.ts`
- Create: `packages/nax-agent-acp/test/helpers/smoke-command.ts`
- Create: `packages/nax-agent-acp/test/node/pack-smoke.test.ts`
- Create: `packages/nax-agent-acp/test/node/fixtures/packed-smoke.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `buildStagedManifest(source, { repository, directory, naxAgentVersion })` from `scripts/lib/stage-manifest.ts`; nax-agent's `bun run build` and `bun scripts/stage-publish.ts`.

- [ ] **Step 1: Cross-process resume on Node**

Append to `test/node/acp-backend.test.ts` (add `createFileTranscriptStore` and `resumeAgentSession` to its `@nathapp/nax-agent` import):

```ts
test("resume over Node: a second session object restores the agent session in a new process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-resume-"));
  const storeDir = mkdtempSync(join(tmpdir(), "acp-node-store-"));
  dirs.push(workdir, storeDir);
  const record = join(workdir, "record.jsonl");
  const options = () => ({
    backend: acpBackend({
      agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
      allowUnsandboxed: true,
      env: fakeEnv(
        {
          capabilities: { sessionCapabilities: { resume: {} } },
          turns: [{ steps: [{ kind: "text", text: "first" }] }],
          relaunch: { turns: [{ steps: [{ kind: "text", text: "resumed" }] }] },
        },
        record,
      ),
    }),
    profile: "full" as const,
    workdir,
    transcriptStore: createFileTranscriptStore(storeDir),
    sessionId: "node-resume",
  });
  const first = await createAgentSession(options());
  for await (const _event of first.send("one")) {
    // drain
  }
  await first.close();
  const second = await resumeAgentSession("node-resume", options());
  expect(second.backend.capabilities).toMatchObject({ restoredWith: "resume" });
  const events: SessionEvent[] = [];
  for await (const event of second.send("two")) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", output: "resumed" });
  await second.close();
  expect(readRecords(record).filter((r) => r.method === "session/resume")).toHaveLength(1);
});
```

If biome rejects the empty `for await` body, replace it with `for await (const event of first.send("one")) void event;`.

- [ ] **Step 2: The smoke command helper**

Create `test/helpers/smoke-command.ts`:

```ts
/** Runs one packed-smoke command; any other exit status, signal or deadline throws with its output. */
import { spawnSync } from "node:child_process";

export function runSmokeCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  acceptedExitCodes: readonly number[] = [0],
): string {
  const proc = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (proc.error || proc.status === null || !acceptedExitCodes.includes(proc.status)) {
    throw new Error(
      `${cmd} ${args.join(" ")} (cwd ${cwd}) failed with status ${proc.status}, signal ${proc.signal}, deadline ${timeoutMs}ms: ${proc.error?.message ?? "command exited unsuccessfully"}\n${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    );
  }
  return proc.stdout + proc.stderr;
}
```

- [ ] **Step 3: The consumer script**

Create `test/node/fixtures/packed-smoke.mjs`:

```js
/**
 * nax-agent-acp tarball smoke (S4 spec §9, §11.1). Runs in a clean Node project
 * that installed the packed @nathapp/nax-agent and @nathapp/nax-agent-acp, with
 * the fake ACP agent copied next to it: a turn, a close, a resume in a new agent
 * process, a second turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createFileTranscriptStore, resumeAgentSession } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

assert.equal(process.versions.bun, undefined, "the packed smoke must run on native Node");

const fakeMain = fileURLToPath(new URL("./fake-agent/main.ts", import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), "acp-packed-"));
const storeDir = mkdtempSync(join(tmpdir(), "acp-packed-store-"));
const record = join(workdir, "record.jsonl");
const script = {
  capabilities: { sessionCapabilities: { resume: {} } },
  turns: [{ steps: [{ kind: "text", text: "packed-pong" }] }],
  relaunch: { turns: [{ steps: [{ kind: "text", text: "packed-again" }] }] },
};

const options = () => ({
  backend: acpBackend({
    agent: { name: "fake", command: process.execPath, args: [fakeMain] },
    allowUnsandboxed: true,
    env: { PATH: process.env.PATH ?? "", FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_RECORD: record },
  }),
  profile: "full",
  workdir,
  transcriptStore: createFileTranscriptStore(storeDir),
  sessionId: "packed-1",
});

async function turn(session, message) {
  let end;
  for await (const event of session.send(message)) end = event;
  return end;
}

try {
  const first = await createAgentSession(options());
  const end1 = await turn(first, "ping");
  assert.equal(end1.status, "completed", JSON.stringify(end1.error));
  assert.equal(end1.output, "packed-pong");
  await first.close();

  const second = await resumeAgentSession("packed-1", options());
  assert.equal(second.backend.capabilities.restoredWith, "resume");
  const end2 = await turn(second, "again");
  assert.equal(end2.status, "completed", JSON.stringify(end2.error));
  assert.equal(end2.output, "packed-again");
  await second.close();
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}
console.log("packed smoke ok");
```

- [ ] **Step 4: The pack smoke test**

Create `test/node/pack-smoke.test.ts`:

```ts
/**
 * The tarball smoke for both packages (S4 spec §9, §11.1). Builds and stages
 * nax-agent and nax-agent-acp into temporary directories at one version (D6-i:
 * the staged nax-agent copy takes nax-agent-acp's version until the release PR
 * bumps both; the source tree is never touched), packs both, installs them into
 * a clean Node project, runs the fake-agent chat and resume there, then
 * typechecks a consumer with skipLibCheck:false. Only diagnostics under the
 * installed nax-agent-acp's dist/ fail; third-party ones are ignored.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildStagedManifest } from "../../scripts/lib/stage-manifest.ts";
import { runSmokeCommand as run } from "#test/helpers/smoke-command";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const AGENT_PKG = join(PKG, "../nax-agent");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";

const temps: string[] = [];
let consumer = "";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** npm pack `dir` into a fresh directory; the tarball's path. */
function pack(dir: string): string {
  const into = temp("acp-pack-");
  run("npm", ["pack", dir, "--pack-destination", into], PKG, 60_000);
  const tgz = readdirSync(into).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`npm pack produced no tarball in ${into}`);
  return join(into, tgz);
}

/** nax-agent's own stage-publish, copied out and given `version` (D6-i). */
function stageAgent(version: string): string {
  run("bun", ["run", "build"], AGENT_PKG, 180_000);
  run("bun", ["scripts/stage-publish.ts"], AGENT_PKG, 60_000);
  const out = temp("acp-stage-agent-");
  cpSync(join(AGENT_PKG, ".publish"), out, { recursive: true });
  const manifest = readJson(join(out, "package.json"));
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return out;
}

/** nax-agent-acp staged as stage-publish stages it, with the peer range on `version`. */
function stageAcp(version: string): string {
  run("bun", ["run", "build"], PKG, 180_000);
  const out = temp("acp-stage-acp-");
  cpSync(join(PKG, "dist"), join(out, "dist"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(out, file));
  const manifest = buildStagedManifest(readJson(join(PKG, "package.json")), {
    repository: REPOSITORY,
    directory: "packages/nax-agent-acp",
    naxAgentVersion: version,
  });
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

beforeAll(() => {
  const version = String(readJson(join(PKG, "package.json")).version);
  const agentTgz = pack(stageAgent(version));
  const acpTgz = pack(stageAcp(version));
  consumer = temp("acp-consumer-");
  run("npm", ["init", "-y"], consumer);
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", agentTgz, acpTgz, "typescript@7.0.2", "@types/node@25.2.3"],
    consumer,
    240_000,
  );
  cpSync(join(PKG, "test/fixtures/fake-agent"), join(consumer, "fake-agent"), { recursive: true });
}, 600_000);

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the packed tarballs", () => {
  test("a fake-agent turn, a close and a resume in a new process", () => {
    cpSync(join(PKG, "test/node/fixtures/packed-smoke.mjs"), join(consumer, "packed-smoke.mjs"));
    expect(run("node", ["packed-smoke.mjs"], consumer, 120_000)).toContain("packed smoke ok");
  }, 180_000);

  test("typechecks for a skipLibCheck:false consumer; only third-party diagnostics are allowed", () => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        'import { ACP_STOP_CODES, acpBackend, type AcpBackendOptions, type AcpStopCode } from "@nathapp/nax-agent-acp/client";',
        'import * as server from "@nathapp/nax-agent-acp/server";',
        "export type Options = AcpBackendOptions;",
        "export type Stop = AcpStopCode;",
        "export const names = [typeof acpBackend, ACP_STOP_CODES, server];",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["ES2023", "DOM"],
          types: ["node"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      }),
    );
    const output = run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer, 120_000, [0, 1, 2]);
    // tsc prints paths relative to its cwd (Linux CI): match the fragment, never an absolute path.
    const ownDist = "node_modules/@nathapp/nax-agent-acp/dist/";
    const errorLines = output.split("\n").filter((line) => line.includes("error TS"));
    expect(errorLines.filter((line) => line.includes(ownDist))).toEqual([]);
    expect(errorLines.filter((line) => line.includes("@nathapp/nax-agent-acp") && !line.includes(ownDist))).toEqual(
      [],
    );
  }, 180_000);
});
```

`lib` includes `"DOM"` because the ACP SDK's typings use web stream types (`ReadableStream`, `WritableStream`). If tsc still reports diagnostics only inside `@agentclientprotocol/sdk`, those are third-party and ignored by the filter.

If vitest cannot import `../../scripts/lib/stage-manifest.ts`, check `tsconfig.json`'s `include`. The import is a plain relative TS import, which vitest transpiles; nothing else changes.

- [ ] **Step 5: Run the Node suite**

Run (from `packages/nax-agent-acp`): `bun run test:node`
Expected: PASS. The new resume test and both pack-smoke tests pass, and the run prints `packed smoke ok`. The first run takes a few minutes: two builds, two packs and an npm install.

Confirm the source tree is untouched:
```bash
git status --short packages/nax-agent/package.json packages/nax-agent-acp/package.json
```
Expected: no output. `packages/nax-agent/.publish/` is git-ignored.

- [ ] **Step 6: CI time budget**

In `.github/workflows/ci.yml`, replace:

```yaml
  nax-agent-acp-node:
    name: "nax-agent-acp: node ${{ matrix.node }}"
    runs-on: ubuntu-latest
    timeout-minutes: 10
```

with:

```yaml
  # S4-6: the contract suite now includes the packed smoke (two builds, two packs,
  # an npm install), so it needs more than the unit job's time.
  nax-agent-acp-node:
    name: "nax-agent-acp: node ${{ matrix.node }}"
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

- [ ] **Step 7: Lint and commit**

```bash
cd packages/nax-agent-acp && bun run lint:fix && bun run check:all && cd ../..
git add packages/nax-agent-acp/test/node packages/nax-agent-acp/test/helpers/smoke-command.ts .github/workflows/ci.yml
git commit -m "test(nax-agent-acp): cross-process resume on Node and the packed-tarball smoke (S4-6 §11.1)"
```

---

### Task 8: Maintainer fixtures and RELEASING "S4 acceptance" (§11.2, §11.3)

**Files:**
- Create: `packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs`
- Create: `packages/nax-agent-acp/test/node/fixtures/init-smoke.mjs`
- Modify: `packages/nax-agent-acp/RELEASING.md`

These fixtures are never run by CI or by the unit suite. vitest only collects `test/node/**/*.test.ts`. The live one is billed.

- [ ] **Step 1: The live Claude smoke**

Create `test/node/fixtures/live-claude-smoke.mjs`:

```js
/**
 * S4 acceptance §11.2: the live Claude smoke. BILLED: run only with the
 * maintainer's approval at launch (RELEASING.md, "S4 acceptance"). Runs on Node
 * inside a temporary consumer that installed the packed @nathapp/nax-agent and
 * @nathapp/nax-agent-acp. Claude Code authenticates itself: an existing `claude`
 * login, or ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in the environment.
 * NAX_AGENT_ACP_LIVE_MODEL picks a model (the agent's default otherwise).
 *
 *   node live-claude-smoke.mjs                                   all phases
 *   node live-claude-smoke.mjs --resume-child <workdir> <store>  phase E's second process (internal)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createFileTranscriptStore,
  createMemoryTranscriptStore,
  resumeAgentSession,
} from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

assert.equal(process.versions.bun, undefined, "the live smoke must run on native Node");

const model = process.env.NAX_AGENT_ACP_LIVE_MODEL;
const TURN_SECONDS = 300;
const costs = [];
const results = [];

const backend = () =>
  acpBackend({
    agent: "claude",
    allowUnsandboxed: true,
    initializeTimeoutMs: 180_000,
    ...(model === undefined ? {} : { model }),
  });
const dir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const usageOf = (events) => events.find((event) => event.type === "usage");

async function turn(session, message, onEvent = () => {}) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    onEvent(event);
  }
  const end = events.at(-1);
  costs.push(end.costUsd);
  console.log(`  turn_end ${end.status} $${end.costUsd.toFixed(4)} ${JSON.stringify(end.output).slice(0, 160)}`);
  assert.equal(end.status, "completed", JSON.stringify(end.error));
  return events;
}

const allowAll = (session) => (event) => {
  if (event.type === "approval_requested") session.answer(event.requestId, { decision: "allow" });
};

function lookupTool(runs) {
  return {
    name: "lookup_order",
    description: "Look up an order by its numeric id. Returns the order's status.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    approval: "never",
    async run(input) {
      runs.push(input);
      return { content: JSON.stringify({ id: input?.id, status: "shipped" }) };
    },
  };
}

/** A: ask profile; an approved edit lands; a file read pairs tool_call/tool_result; usage is reported and per turn. */
async function phaseAsk() {
  const workdir = dir("acp-live-ask-");
  writeFileSync(join(workdir, "notes.txt"), "alpha\n");
  const session = await createAgentSession({
    backend: backend(),
    profile: "ask",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const approvals = [];
  const first = await turn(
    session,
    "Read notes.txt with your Read tool, then use your Edit tool to replace the word alpha with beta. Do not use Bash.",
    (event) => {
      if (event.type !== "approval_requested") return;
      approvals.push(event.tool);
      assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
    },
  );
  assert.ok(approvals.length >= 1, "no approval_requested under ask");
  assert.match(readFileSync(join(workdir, "notes.txt"), "utf8"), /beta/, "the approved edit did not land");
  const read = first.find((e) => e.type === "tool_call" && JSON.stringify(e.input).includes("notes.txt"));
  assert.ok(read, "no tool_call whose input names notes.txt");
  assert.ok(
    first.some((e) => e.type === "tool_result" && e.callId === read.callId),
    "the read's tool_call has no tool_result",
  );
  const u1 = usageOf(first);
  assert.ok(u1 && u1.outputTokens > 0 && u1.inputTokens + (u1.cacheRead ?? 0) > 0, "turn 1 usage has no tokens");
  assert.equal(u1.costSource, "reported", "turn 1 cost is not reported");
  const second = await turn(session, "Reply with the single word: done.", allowAll(session));
  const u2 = usageOf(second);
  assert.ok(u2.outputTokens < u1.outputTokens, `turn 2 output ${u2.outputTokens} looks cumulative (turn 1: ${u1.outputTokens})`);
  results.push({ phase: "ask", approvals, turn1: u1, turn2: u2, capabilities: session.backend.capabilities });
  await session.close();
}

/** B and C: the embedder tool through MCP without a permission prompt; under read, a write is rejected by profile. */
async function phaseTool(profile) {
  const workdir = dir(`acp-live-${profile}-`);
  const runs = [];
  const session = await createAgentSession({
    backend: backend(),
    profile,
    workdir,
    tools: [lookupTool(runs)],
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const events = await turn(session, "Use the lookup_order tool to look up order 42 and tell me its status.");
  assert.ok(runs.length >= 1, `the embedder tool never ran under ${profile}`);
  assert.ok(
    !events.some((e) => e.type === "approval_requested" && e.tool.includes("lookup_order")),
    `the embedder tool met a permission prompt under ${profile}`,
  );
  const result = { phase: profile, toolRuns: runs.length };
  if (profile === "read") {
    const write = await turn(session, "Now create a file named created.txt containing the word hello.");
    const denied = write.filter((e) => e.type === "approval_resolved" && e.decidedBy === "profile");
    assert.ok(!existsSync(join(workdir, "created.txt")), "a write landed under read");
    assert.ok(
      denied.some((e) => e.decision === "deny"),
      "no write attempt was rejected with decidedBy profile (record the agent's behaviour)",
    );
    result.profileDenials = denied.length;
  }
  results.push(result);
  await session.close();
}

/** D: a question round trip, if Claude emits an elicitation. Not observed is recorded, not failed. */
async function phaseQuestion() {
  const session = await createAgentSession({
    backend: backend(),
    profile: "ask",
    workdir: dir("acp-live-q-"),
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  let asked = false;
  const events = await turn(
    session,
    "Use your AskUserQuestion tool to ask me whether I prefer red or blue, then tell me which I chose.",
    (event) => {
      if (event.type === "question") {
        asked = true;
        session.answer(event.requestId, { text: "blue" });
      }
      allowAll(session)(event);
    },
  );
  if (asked) assert.match(events.at(-1).output, /blue/i, "the answer did not reach the agent");
  else console.log("  question: not observed (recorded, not failed)");
  results.push({ phase: "question", observed: asked });
  await session.close();
}

/** E: a nonce survives close and resumeAgentSession in a new process, through session/resume. */
async function phaseResume() {
  const workdir = dir("acp-live-resume-");
  const storeDir = dir("acp-live-store-");
  const nonce = randomBytes(4).toString("hex");
  const session = await createAgentSession({
    backend: backend(),
    profile: "full",
    workdir,
    transcriptStore: createFileTranscriptStore(storeDir),
    sessionId: "live-resume",
    turnTimeoutSeconds: TURN_SECONDS,
  });
  await turn(session, `Remember this code word for later: ${nonce}. Reply only with OK.`);
  await session.close();
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--resume-child", workdir, storeDir], {
    encoding: "utf8",
    timeout: 600_000,
    env: process.env,
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  assert.equal(child.status, 0, "the resume child failed");
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("RESUME_RESULT "));
  assert.ok(line, "the resume child printed no result");
  const result = JSON.parse(line.slice("RESUME_RESULT ".length));
  assert.equal(result.restoredWith, "resume", "session/resume was not used");
  assert.ok(result.output.includes(nonce), "the resumed agent did not return the nonce");
  costs.push(result.costUsd);
  results.push({ phase: "resume", ...result });
}

async function resumeChild(workdir, storeDir) {
  const session = await resumeAgentSession("live-resume", {
    backend: backend(),
    profile: "full",
    workdir,
    transcriptStore: createFileTranscriptStore(storeDir),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const restoredWith = session.backend.capabilities.restoredWith;
  const events = [];
  for await (const event of session.send("What was the code word I gave you? Reply with the code word only.")) {
    events.push(event);
  }
  const end = events.at(-1);
  await session.close();
  // D6-a: the first resumed turn's cost is its own share; recorded for the master plan.
  console.log(
    `RESUME_RESULT ${JSON.stringify({ restoredWith, status: end.status, output: end.output, costUsd: end.costUsd, usage: usageOf(events) })}`,
  );
}

if (process.argv[2] === "--resume-child") {
  await resumeChild(process.argv[3], process.argv[4]);
} else {
  console.log("phase A: ask");
  await phaseAsk();
  console.log("phase B: embedder tool under full");
  await phaseTool("full");
  console.log("phase C: embedder tool and a write under read");
  await phaseTool("read");
  console.log("phase D: question");
  await phaseQuestion();
  console.log("phase E: resume");
  await phaseResume();
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  console.log(JSON.stringify({ model: model ?? "agent default", totalUsd: Number(total.toFixed(4)), results }, null, 2));
  console.log(`live claude smoke ok ($${total.toFixed(4)})`);
}
```

- [ ] **Step 2: The initialize-only smoke**

Create `test/node/fixtures/init-smoke.mjs`:

```js
/**
 * S4 acceptance §11.3: initialize plus session/new for each registered non-Claude
 * agent whose launch command is installed. No prompt is sent. Prints each agent's
 * capability record (or its error code) for the master plan's capability matrix.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

const AGENTS = [
  ["codex", "codex-acp"],
  ["gemini", "gemini"],
  ["opencode", "opencode"],
  ["pi", "pi-acp"],
];

const installed = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

for (const [agent, command] of AGENTS) {
  if (!installed(command)) {
    console.log(`${agent}: not installed (${command} is not on PATH)`);
    continue;
  }
  const workdir = mkdtempSync(join(tmpdir(), `acp-init-${agent}-`));
  try {
    const session = await createAgentSession({
      backend: acpBackend({ agent, allowUnsandboxed: true, initializeTimeoutMs: 120_000 }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    console.log(`${agent}: ${JSON.stringify(session.backend.capabilities)}`);
    await session.close();
  } catch (error) {
    console.log(`${agent}: ${error?.code ?? "error"} ${error?.message ?? String(error)}`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
console.log("init smoke done");
```

- [ ] **Step 3: Syntax-check both fixtures**

Run (from `packages/nax-agent-acp`):
```bash
node --check test/node/fixtures/live-claude-smoke.mjs
node --check test/node/fixtures/init-smoke.mjs
node --check test/node/fixtures/packed-smoke.mjs
```
Expected: no output, exit 0. Do NOT run the live fixture.

- [ ] **Step 4: RELEASING "S4 acceptance"**

In `packages/nax-agent-acp/RELEASING.md`, insert before `## First publish: 0.3.0 (manual, maintainer 2FA)`:

````md
## S4 acceptance (0.3.0)

S4 is complete when the four checks of the S4 spec §11 pass on the release
candidate, the S4-6 PR's merged `main` commit. The live smoke is billed and needs
explicit approval **at launch**.

1. **CI.** Green on the candidate: `nax-agent-acp` (unit, fake-agent conformance,
   MCP security tests, coverage, API snapshot) and `nax-agent-acp: node 22/24`
   (Node contract suite and the packed smoke of both tarballs).
2. **Live Claude smoke (billed).** From the repo root on the candidate:

   ```sh
   (cd packages/nax-agent && rtk bun run build && rtk bun run stage-publish)
   (cd packages/nax-agent-acp && rtk bun run build)
   ```

   Then pack both at one version, as `test/node/pack-smoke.test.ts` does. Before the
   release PR merges, give the staged nax-agent copy the acp version. After that PR,
   `rtk bun run stage-publish` works for both packages directly. Install both
   tarballs into a fresh `npm init -y` project, copy
   `packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs` into it, and run:

   ```sh
   node live-claude-smoke.mjs
   ```

   It needs a Claude Code login (or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`).
   `NAX_AGENT_ACP_LIVE_MODEL` picks a model. It must print `live claude smoke ok`.
   Record the printed JSON (model, per-phase usage, whether a question was observed,
   the first resumed turn's cost), the total cost and the commit in the master plan.
   A question that is not observed is recorded, not failed.
3. **Initialize-only smoke.** In the same project, copy
   `test/node/fixtures/init-smoke.mjs` and run `node init-smoke.mjs`. It starts each
   installed non-Claude agent (codex, gemini, opencode, pi), sends `initialize` and
   `session/new`, and prompts nothing. Record the capability lines as the master
   plan's capability matrix.
4. **nax unaffected.** `git diff --exit-code <S4 base> -- packages/nax/` is empty
   apart from the lockfile, and the nax suite and `bun run typecheck` pass. The S4-0
   and S4-6 billed `nax run` S1-recipe smoke results are already recorded.

````

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs packages/nax-agent-acp/test/node/fixtures/init-smoke.mjs packages/nax-agent-acp/RELEASING.md
git commit -m "docs(nax-agent-acp): S4 acceptance procedure, live Claude and init-only smoke fixtures (§11)"
```

---

### Task 9: Docs, context and the spec amendments

**Files:**
- Modify: `packages/nax-agent-acp/README.md`
- Modify: `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `packages/nax-agent-acp/src/client/index.ts` (doc comment only)
- Modify: `.nax/mono/packages/nax-agent-acp/context.md`, then `nax generate`
- Modify: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`

- [ ] **Step 1: README**

Replace the status paragraph:

```md
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves sessions under all four profiles, with
thinking, tool and usage events, questions from the agent, and embedder tools on
Claude. Resume (S4-6) is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until
its stage lands. `./server` is reserved for a later ACP server.
```

with:

```md
**Status: pre-release (0.3.0, not yet published).** `acpBackend()` serves sessions
under all four profiles, with thinking, tool and usage events, questions from the
agent, embedder tools on Claude, resume across processes and reconnect after a
crash. `./server` is reserved for a later ACP server.
```

Replace the bullet:

```md
- **A crashed or killed agent leaves the session disconnected.** Later turns end
  `AGENT_SESSION_CLOSED`. A cancel the agent ignores for `cancelGraceMs` kills it.
```

with:

```md
- **A crashed or killed agent is reconnected once.** The next turn starts a new agent
  process and restores the session in it. See "Resume and reconnect". A cancel the
  agent ignores for `cancelGraceMs` kills it.
```

Before `## Profiles on ACP`, add:

````md
## Resume and reconnect

```ts
const store = createFileTranscriptStore("/path/to/transcripts");
const session = await resumeAgentSession(sessionId, {
  backend: acpBackend({ agent: "claude", allowUnsandboxed: true }),
  profile: "full",
  workdir: "/path/to/repo", // the directory the session was created in
  transcriptStore: store,
});
```

- **The agent keeps the history.** The transcript document holds the agent's
  session id, its directory and the cost baseline, not the messages. A resume asks
  the agent to restore its own session: `session/resume` when it supports it, else
  `session/load`. It never starts a fresh session in its place.
- **What can fail:**
  - The agent supports neither: `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (`capability: "resume"`).
  - The agent no longer has the session: `AGENT_SESSION_NOT_FOUND`.
  - It restores a different one: `AGENT_SESSION_TURN_FAILED` (`detail: "identity"`).
  - The document was written by another backend: `AGENT_SESSION_BACKEND_MISMATCH`.
  - Its ACP record is damaged: `TRANSCRIPT_CORRUPT`.
- **Same directory.** `workdir` must be the directory the session was created in.
  Another spelling of it (a symlink, a trailing slash) is fine. A `none` session
  created without `workdir` cannot be resumed, so pass a `workdir` if you will
  resume it.
- **`session.backend.capabilities.restoredWith`** is `"resume"` or `"load"` for a
  restored agent process.
- **History is not replayed into your events.** A `session/load` replay never
  reaches `send()`, and requests the agent makes during it are refused.
- **Instructions** are sent again only when the session never ran a turn.
- **Cost after a resume.** The baseline is saved in the document after each priced
  turn, so the first turn after a resume costs only its own share, even when the
  agent's running total includes the earlier turns.
- **Reconnect.** When the agent process dies (a crash, or a kill after an ignored
  cancel), the turn that was running ends `errored`. The next `send()` starts a new
  process and restores the session once:
  - The tool host gets a new token.
  - A cancel or `close()` while it starts stops the attempt; the next `send()` tries again.
  - If the agent supports neither resume nor load, or the reconnect fails, later
    turns end `AGENT_SESSION_CLOSED`.

````

- [ ] **Step 2: CHANGELOG**

Append to `packages/nax-agent-acp/CHANGELOG.md` under `## [Unreleased]`:

```md
- Resume and reconnect on `acpBackend()` (S4-6). `resumeAgentSession` restores the
  agent's own session in a new process with `session/resume`, else `session/load`,
  never as a fresh session. The stored record is checked before anything starts:
  backend, agent, session id and directory. A lost session is
  `AGENT_SESSION_NOT_FOUND`, and a different restored session is
  `AGENT_SESSION_TURN_FAILED` (`detail: "identity"`). A `session/load` replay never
  reaches the caller. The mode and model are re-applied, and the tool host restarts
  with a new token. After a crash or kill, the next turn reconnects once the same
  way; otherwise later turns end `AGENT_SESSION_CLOSED`. The cost baseline is saved
  in the transcript (`acp.costUsd`), so the first turn after a resume costs only its
  own share. `AgentSession.backend.capabilities.restoredWith` reports `"resume"` or
  `"load"`.
- Packed-tarball smoke of both packages on Node 22 and 24, and the S4 acceptance
  procedure with its live Claude and initialize-only fixtures (`RELEASING.md`).
```

- [ ] **Step 3: `src/client/index.ts` doc comment**

Replace:

```ts
 * S4-5 serves sessions under all four profiles: permission requests decided by
 * profile (approved through answer() under `ask`), embedder tools through a
 * per-session loopback MCP tool host that Claude's adapter pre-approves, thinking,
 * tool and usage events, and the agent's form elicitations as questions. Resume
 * (S4-6) is refused with AGENT_SESSION_CAPABILITY_UNSUPPORTED until its stage
 * lands. Nothing is released before S4-6.
```

with:

```ts
 * Sessions under all four profiles: permission requests decided by profile
 * (approved through answer() under `ask`), embedder tools through a per-session
 * loopback MCP tool host that Claude's adapter pre-approves, thinking, tool and
 * usage events, the agent's form elicitations as questions, resume of a stored
 * session in a new process (session/resume, else session/load), and one reconnect
 * after the agent process dies (S4-6).
```

- [ ] **Step 4: Package context**

In `.nax/mono/packages/nax-agent-acp/context.md`, replace the sentences from `Resume (S4-6) is refused with \`AGENT_SESSION_CAPABILITY_UNSUPPORTED\`` up to and including `Nothing is released before S4-6.` with:

```md
S4-6 added resume (`resume.ts`: stored-record check before spawning, `session/resume`
else `session/load`, identity via the id Claude echoes) and one reconnect after the
agent process dies (`backend.ts`: a new process, router and tool host token; the cost
baseline is carried over and persisted as `acp.costUsd`). `./server` is reserved for S5.
The packed smoke (`test/node/pack-smoke.test.ts`) stages both packages at one version.
The live Claude and initialize-only fixtures in `test/node/fixtures/` are
maintainer-run and billed, and never run in CI.
```

Read the file first and keep the surrounding sentences intact. Then run from the repo root:

```bash
bun packages/nax/bin/nax.ts generate
git status --short
```
Expected: only `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md` and the context file change. If `nax generate` also rewrites the root files, keep them only when the diff stems from this context edit.

- [ ] **Step 5: Spec amendments**

In `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`:

1. §5.5, the `TranscriptDoc` bullet: replace `` - `acp?: { agentSessionId: string; agent: string; agentVersion?: string; cwd: string }` `` with `` - `acp?: { agentSessionId: string; agent: string; agentVersion?: string; cwd: string; costUsd?: number }` (`costUsd`: the cumulative cost reading at the last priced turn, S4-6 D6-a) ``.
2. §6.7, the **Cost (D5-b)** bullet: replace `(0 for a new agent process; S4-6 resets it on reconnect and resume)` with `(0 for a new session; a resume or reconnect starts from the stored baseline, because the agent's running total survives a resume, S4-6 D6-a)`.
3. §6.9: replace steps 1 to 4 and the paragraph after them with:

```md
1. **Validate the stored document** before anything is spawned (S4-6 D6-b, D6-c):
   - `backend` equals this backend's `kind`, else `AGENT_SESSION_BACKEND_MISMATCH`
   - `acp` is present with a usable `agentSessionId` (non-empty, at most 512 characters) and non-empty `agent` and `cwd`, else `TRANSCRIPT_CORRUPT`
   - `acp.agent` is this backend's agent, else `TRANSCRIPT_CORRUPT`
   - `acp.cwd` is the same directory as `workdir` (compared canonically), else `AGENT_SESSION_INVALID_OPTIONS`; the agent is given the stored spelling
2. **Spawn and initialize, then choose:**
   - `session/resume` if advertised (no replay)
   - else `session/load`; its replayed updates reach no turn and are dropped, and inbound requests are refused until it returns
   - else `AGENT_SESSION_CAPABILITY_UNSUPPORTED`

   The backend never silently creates a fresh session. JSON-RPC -32002, or agent text "session not found" / "no conversation found", on either → `AGENT_SESSION_NOT_FOUND`.
3. **Identity:** the protocol's responses carry no session id; Claude's adapter echoes one. An echoed id other than `acp.agentSessionId` → `AGENT_SESSION_TURN_FAILED`, detail `identity` (S4-6 D6-d).
4. **Re-supply:** `mcpServers` and `_meta` (new tool host, new token), then the mode and `model`. The cost meter starts from `acp.costUsd` (D6-a).

The document's `messages` stay empty; the agent's own store holds history. A restore writes no initial document. `instructions` go with the first prompt only when the document has no turn marker (D6-f). `AgentSession.backend.capabilities.restoredWith` is `"resume"` or `"load"` for a restored process (D6-h). The facade's `markTurn` handling is unchanged, so a turn left `running` by a dead process reports `interrupted`.
```

4. §6.3 step 5: after `if the reconnect fails, the turn ends \`errored\` and later \`send()\`s throw \`AGENT_SESSION_CLOSED\``, add the bullet: `` - a reconnect stopped by `cancel()`, the turn timeout or `close()` is not a failure; the next `send()` tries again. An agent with neither resume nor load throws `AGENT_SESSION_CLOSED` without spawning (S4-6 D6-g) ``.
5. §9, the **Conformance suite** bullet: replace it with: `` - **Conformance** (S4-6 D6-j): the fake-agent suites (in process, subprocess, Node) are the always-on target; the billed live Claude fixture (`test/node/fixtures/live-claude-smoke.mjs`, §11.2) is the Claude target, run by the maintainer before release. ``
6. §12, the usage risk row: append `; the meter's baseline is persisted so a resumed session's first turn is priced from it (S4-6 D6-a)` to its mitigation cell.

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md packages/nax-agent-acp/src/client/index.ts .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "docs(nax-agent-acp): resume and reconnect, S4-6 spec amendments (D6-a to D6-j)"
```

---

### Task 10: Whole-repo gates, review, billed nax smoke, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

From `packages/nax-agent-acp`, as CI runs them:
```bash
bun run check:api && bun run test:coverage && bun run test:node
```
Expected: all exit 0. The API snapshot is unchanged (no new export), coverage is at least 80% per file, and the pack smoke prints `packed smoke ok`.

From `packages/nax-agent`:
```bash
bun run check:api && bun run test
```
Expected: exit 0, no snapshot change.

- [ ] **Step 2: Confirm the scope fence**

```bash
git diff --stat origin/main...HEAD -- packages/nax/ | cat
git diff --stat origin/main...HEAD -- packages/nax-agent/ | cat
```
Expected: the first is empty. The second lists exactly `src/native/session/transcript-types.ts`, `test/unit/native/transcript-store.test.ts` and `CHANGELOG.md`.

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it:
- spec §6.9, §6.3 (steps 1, 4, 5), §6.6 "Close and resume", §6.7 usage and §11, as amended in Task 9
- this plan's Decisions and Review Focus

Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Billed `nax run` S1-recipe smoke (S4-0 Done-when; maintainer approval at launch)**

Task 0 changes nax-agent `src/native/`, so spec §10's S4-0 Done-when applies. Ask the maintainer for approval before launching; do not launch without it.

Follow the S4-5 recipe:
1. Rebuild the clamp-helper fixture as the maintainer workspace memory "S1 smoke fixture recovery" describes. The S4-5 clone `/private/tmp/nax-s4-5-acceptance-20261006` may already be gone. In that case rebuild the PRD from the newest `~/.nax/nax-s*-smoke/prompt-audit/` implementer prompt.
2. Give `.nax/config.json` the unique name `nax-s4-6-smoke`.
3. Run `nax trust add <dir> --yes`.
4. Run the local build from this branch's head:

```bash
bun <repo>/packages/nax/bin/nax.ts run -f s1-smoke -a native --headless --max-cost 2
```

Checks:
- `naxCommit` on `run.start` equals the branch head.
- 1/1 story passed with its five ACs.
- The pre-run auto-commit's parent is the head, and it changes only config and features.
- The cost jsonl keys match the S4-5 run.
- The tool-audit errors are the known ones: stale-context ENOENT reads, the TDD red step, the `:!__tests__/` pathspec.

Record the cost, duration and result for the PR body.

- [ ] **Step 5: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-6-acp-resume
gh pr create --base main --title "feat(nax-agent-acp): S4-6 resume, reconnect and the packed smoke" --body-file <body>
```

The body covers:
- the S4-6 scope (spec §10 row)
- decisions D6-a to D6-l, with the D6-a, D6-d and D6-e evidence (adapter file references) and the D6-a maintainer ruling
- the README "Resume and reconnect" guarantees
- the nax-agent change (`TranscriptAcpRecord.costUsd`) and the billed smoke result
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `nax-agent`, `nax`, `tooling`
- a statement that nothing is released and that `packages/nax/` is untouched
- the follow-ups in Tasks 11 and 12 (acceptance runs, then the 0.3.0 release)

---

### Task 11: S4 acceptance runs (after merge; billed; maintainer approval at launch)

Run on the merge commit of the S4-6 PR, following `packages/nax-agent-acp/RELEASING.md` "S4 acceptance".

- [ ] **Step 1:** CI green on the merge commit. Record the run ids for `nax-agent-acp` and `nax-agent-acp: node 22/24`.
- [ ] **Step 2:** Ask for approval, then run the live Claude smoke as RELEASING.md describes. Record:
  - the printed JSON
  - the total cost and the model
  - whether a question was observed
  - the first resumed turn's cost (D6-a check: its own share, not the session total)
  - the commit

  If an assertion fails, stop and report it with the output; do not change the fixture to pass.
- [ ] **Step 3:** Run `init-smoke.mjs`. Record each installed agent's capability line, or "not installed".
- [ ] **Step 4:** `git diff --exit-code <S4-0 base> -- packages/nax/` (aside from the lockfile) and the nax suite. Record the result.
- [ ] **Step 5:** Record all of it in the master plan row S4 (maintainer workspace `projects/nax/nax-agent-master-plan.md`): acceptance passed, the capability matrix, and the costs.

### Task 12: Release 0.3.0 (maintainer-run; approval at each gate)

Only after Task 11 passes. Follow `packages/nax-agent/RELEASING.md` and `packages/nax-agent-acp/RELEASING.md` in order. Never send or store an OTP.

- [ ] **Step 1:** Release PR: from `packages/nax-agent` on clean main, run `rtk bun run release --dry-run minor`, then `rtk bun run release minor` (the maintainer runs it in their own TTY). Both packages go to 0.3.0 with dated changelogs. Merge after review.
- [ ] **Step 2:** `rtk bun run release tag` publishes `nax-agent-v0.3.0` through OIDC. Wait until `npm view @nathapp/nax-agent@0.3.0 version` prints it.
- [ ] **Step 3:** nax-agent-acp 0.3.0 first publish: manual, with maintainer 2FA, as RELEASING.md "First publish: 0.3.0" describes. Then add the trusted-publisher entry with `--allow-publish`, then run `rtk bun run release tag-acp`, which verifies the artifact and creates the prerelease.
- [ ] **Step 4:** Verify:
  - `latest` is 0.3.0 for both packages
  - nax-agent has provenance
  - the acp peer range is `^0.3.0`
  - `npm audit signatures` passes in a fresh consumer
  - the packed smoke passes against the registry tarballs

  Record the results in the master plan. Then ship the deferred nax release that carries #2362 (maintainer ruling 2026-10-06: it ships with the S4 release), as its own approved step.

---

## Self-review notes

- **Spec coverage:**
  - §6.9 step 1: Task 4 (`storedSessionOf`), Task 6 (before any spawn).
  - §6.9 step 2 (resume, else load, else unsupported; NOT_FOUND): Task 2, Task 4, Task 5, Task 6.
  - §6.9 step 3 (identity): Task 4 (`checkRestored`), Task 5, Task 6.
  - §6.9 step 4 (`mcpServers` + `_meta`, mode, model, baseline): Task 5 (setup reused, model), Task 6 (tool host token, baseline).
  - "messages stay empty; interrupted": Task 6.
  - §6.3 step 5 (claim slot, `markTurn(running)` first, one reconnect, failure → CLOSED, close aborts via `openSignal`): the facade writes `markTurn(running)` before `sendTurn`, and Task 6 reconnects inside `sendTurn`. Task 6 tests cancel and close during a reconnect.
  - §6.3 "inbound during `session/load` replay → refused": Task 6 (load permission rejected locally).
  - §6.6 "Close and resume": Task 6 (new token, same `_meta`).
  - §6.7 load suppression: Task 6.
  - §8/§9 packed smoke for both packages: Task 7; nax-agent's own pack smoke already runs in its CI job.
  - §9 fake agent resume/load matrix, a disappeared session, identity mismatch: Task 3, Task 6.
  - §9 conformance: D6-j, Task 9.
  - §10 S4-6 row (docs, packed smoke, live-smoke fixture, RELEASING "S4 acceptance"): Tasks 7 to 9.
  - §11: Task 11. Release (§8): Task 12.
- **Type consistency:**
  - `Restore` is used by `storedSessionOf`, `restoreSession`, `openAcpSession` and `backend.ts`.
  - `RestoredWith` is used by `OpenedAcp.restoredWith` and `infoOf`.
  - `SessionSetup` moves from `open.ts` to `resume.ts`, and `open.ts` imports it.
  - `createCostMeter(seed)` and `baseline()` are used in `connect` and `reconnect`.
  - `sessionLost(sessionId, reason)` is used in `liveFor`.
  - `AcpLink.resumeSession` / `loadSession` are used in `restoreSession`.
  - `scriptFor` is used by `main.ts` and `in-memory-launch.ts`.
- **Placeholder scan:** none. Conditional instructions name the exact fallback, for example the `ctx.client` accessor and the `getLogger().warn` shape.
