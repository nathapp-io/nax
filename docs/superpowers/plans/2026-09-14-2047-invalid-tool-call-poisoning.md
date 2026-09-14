# Invalid Tool Call Poisoning — Implementation Plan (nax#2047)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool call that violates its own declared `inputSchema` must never be executed, and must never be persisted in the transcript in its malformed form — because the persisted malformed call is a few-shot example the model then copies.

**Architecture:** Three layers, in dependency order.

1. A new, transport-level **schema gate** in the native turn loop. `call.input` is checked against the tool's own `inputSchema` — which `turn-loop.ts` already holds in its local `tools` array — before dispatch. Validation is *fail-open on constructs it does not understand*: it rejects only on positive knowledge.
2. On a violation, the assistant message's `toolCall.input` is **replaced with a schema-derived exemplar** before it is persisted, paired with an `isError` result naming the violation. The transcript then carries a correct-shaped example instead of a wrong one, and the model keeps its memory of having tried.
3. A **per-key invalid-call budget** (hard stop at 3) plus two fixes to the spin breaker that this run exposed: a cumulative per-key counter that an interleave cannot reset, and session lifetime instead of turn lifetime.

**Tech Stack:** TypeScript, Bun (`bun:test`), Zod v4.

**Spec:** GitHub issue [nathapp-io/nax#2047](https://github.com/nathapp-io/nax/issues/2047) plus [this investigation comment](https://github.com/nathapp-io/nax/issues/2047#issuecomment-5663682729), which establishes the measurements below. Read both before starting.

---

## The measurements this plan rests on

Replaying attempt 1's own `tool-audit` records through the real `createSpinBreaker` algorithm:

| session | calls | malformed | maxRepeatRun | nudge at |
|---|---:|---:|---:|---:|
| `1789376162585-US-001-implementer` | 120 | **70** | **22** | 25 |
| `1789379051445-US-001-implementer` (re-run) | 56 | 28 | **8** | 25 |

```
..................MMMMMMM.MMMMMMMM.MMM.MMM.MMM.MMM.MMMMM.M..MM.MM.M....MMMMM.MMM..M...MMMMMMM...MM.MMMMMM.MMM.MM..M..M..

   69x  RunCommand {"command":"testScoped","values":""}
   13x  RunCommand {"command":"testScoped","values":"\t"}
```

Three facts follow, and every task below depends on one of them:

- The breaker **was** wired (`manager.ts:464` -> `session.ts:131` -> `adapter.ts:302`, keyed on `handle.id` which equals `name`) and **was** keyed correctly (`stableStringify` collapses all 69 to one key). It reached 22 of 25 and never nudged. **Threshold, not wiring.**
- `repeatsSinceProgress` resets to 0 on any *new* key, so one interleaved `Read` launders the whole run; `{"values":"\t"}` is a second key that halves every counter while being one defect.
- `createSpinBreaker` is called inside `runNativeTurn` (`turn-loop.ts:208`), so the breaker is **per-turn**. The 98 malformed calls spanned 2 turns.

And separately: grepping `src/` for schema validation of `call.input` returns **zero hits**. Every tool hand-rolls its own shape guard (`run-command.ts:330` is #2046's; `#2044` added another). `ToolDefinition.inputSchema` exists (`registry.ts:71`), is forwarded verbatim to the provider by `tool-mapping.ts`, and is never enforced on the way back.

---

## Global Constraints

- **The gate rejects only on positive knowledge.** A schema construct the validator does not implement must **pass**, never fail. A false reject breaks a working session; a false accept only leaves today's behaviour. This is the single most important property in this plan — every validator test must include a "schema we do not understand -> allowed" case.
- **This is a harness fix, not a RunCommand fix.** `RunCommand`/`values` is the instance that surfaced it. Do not special-case `RunCommand` anywhere in Tasks 1-4. #2046's and #2044's per-tool guards stay in place and keep working; this plan does not delete them (see Task 8 for why that is deliberately out of scope).
- **`turn-loop.ts` is at 586 of 600 lines.** `bun run check:file-sizes` enforces a 600-line source limit and the file is *not* grandfathered. **Roughly 14 lines of headroom exist for the entire plan.** Every new mechanism goes in a new file under `src/agents/native/session/`; the turn-loop change must be a single guarded delegation. If a task cannot fit, extract the per-call body of the `for (const call of res.toolCalls)` loop into a new module rather than growing the file.
- **No mutation.** The assistant message is already pushed to `messages` before the tool-call loop runs. Rewriting a `toolCall.input` means producing a **new `messages` array** containing a new assistant-message object — never assigning into the existing array and never mutating the pushed message. `messages` is already `let`-bound (`turn-loop.ts:168`) and is already reassigned wholesale by the compaction path, so this is how the file already works. Thinking blocks and `toolCallId`s must survive the rewrite byte-for-byte — Anthropic needs the exact thinking block back (ADR-028 §8).
- **Strictly additive to the success path.** A call whose input validates must reach `opts.interactionHandler.onInteraction` with byte-identical input, taking exactly the path it takes today.
- **Native transport only.** ACP executes tools inside the spawned agent; nax never sees the call. Do not attempt an ACP equivalent.
- **Error handling:** use `NaxError` per `.nax/rules/error-handling.md`; a plain `Error` requires a `// nax-lint-allow: plain-error` marker.
- Commands: test `bun run test`, scoped `CI=1 AGENT=1 bun test --timeout=60000 <files>`, typecheck `bun run typecheck`, lint `bun run check:all`, sizes `bun run check:file-sizes`, coverage `bun run test:coverage` (**not** in `check:all` — run it after adding any `src/` file).

### Why a hand-rolled subset validator rather than ajv

Measured across every built-in tool's `inputSchema` (`read/write/edit/grep/glob/git/delete/bash/run-command/git-commit/request-capability`), the entire keyword surface is:

```
 47 type:      43 description:   11 required:   11 properties:
  5 pattern:    5 enum:           4 items:       2 minimum:      1 default:
```

No `anyOf`, `oneOf`, `allOf`, or `$ref`. A closed subset covering `type` / `properties` / `required` / `enum` / `items` is sufficient for every shipped tool and is ~80 lines. Provider-registered external tools (`provider-sanitize.ts`) may carry arbitrary schemas — which is exactly what the fail-open rule is for: an unrecognised construct passes, so an external tool is never worse off than today. Revisit ajv only if a measured external-tool schema needs it; adding a runtime dependency to validate five keywords is not warranted now.

---

### Task 1: A fail-open subset validator for tool inputs

Create `src/agents/native/session/tool-input-validation.ts`.

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/native/session/tool-input-validation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { validateToolInput } from "@/agents/native/session/tool-input-validation";
```

Cases, all against a schema shaped like `RunCommand`'s:

| case | input | expect |
|---|---|---|
| the live defect | `{command:"testScoped", values:""}` | violation on `values`, `expected:"object"`, `actual:"string"` |
| the second shape | `{command:"testScoped", values:"\t"}` | same violation (both bad shapes are one defect) |
| tab is not special | `{values:"\t"}` | violation names `a string`, never a placeholder key |
| null | `{values:null}` | violation, `actual:"null"` |
| array | `{values:[]}` | violation, `actual:"an array"` |
| correct | `{command:"testScoped", values:{files:"a.test.ts"}}` | `undefined` |
| absent optional | `{command:"typecheck"}` | `undefined` |
| enum violation | `{command:"nope"}` | violation naming the enum members |
| missing required | `{}` against `required:["path"]` | violation naming `path` |
| **fail-open: unknown keyword** | `{x:1}` against `{type:"object",properties:{x:{anyOf:[…]}}}` | **`undefined`** |
| **fail-open: no schema** | anything against `{}` or `undefined` | **`undefined`** |
| **fail-open: non-object schema** | anything against `{type:"string"}` at top level | **`undefined`** |
| extra property | `{command:"typecheck", nope:1}` | `undefined` (no `additionalProperties` in the schema -> not our business) |

- [ ] **Step 2: Run the tests to verify they fail**

`CI=1 AGENT=1 bun test --timeout=60000 test/unit/agents/native/session/tool-input-validation.test.ts`

- [ ] **Step 3: Implement**

```ts
export interface ToolInputViolation {
  readonly property: string;          // "values", or "" for a top-level/required violation
  readonly expected: string;          // "object", "one of: a, b, c", "present"
  readonly actual: string;            // "a string", "null", "an array", "absent"
  readonly message: string;           // one sentence, names the property and both shapes
}

export function validateToolInput(schema: unknown, input: unknown): ToolInputViolation | undefined;
```

Rules, in order — every one of them returns `undefined` (allow) when it cannot decide:

1. Schema is not a plain object, or has no `properties` object, or `type` is present and not `"object"` -> allow.
2. `input` is not a plain object -> allow (that is the provider's framing, not the model's shape).
3. For each `required` entry that is a string and absent from `input` -> violation `{expected:"present", actual:"absent"}`.
4. For each key of `input` that names a declared property whose schema is a plain object:
   - if that property schema has a `type` that is one of the six JSON types **and** the value's runtime type disagrees -> violation. `"integer"` accepts an integral number. Arrays are `"array"`, `null` is `"null"`, never `"object"`.
   - else if it has a string-array `enum` and the value is not a member -> violation naming the members.
   - else -> allow this property.
5. Otherwise allow.

Reuse `describeValuesType`'s vocabulary for `actual` ("a string", "an array", "null") so the message reads the same as #2046's. Extract that helper here and have `run-command.ts` import it, rather than keeping two copies — but do **not** change `run-command.ts`'s behaviour.

- [ ] **Step 4: Run the tests to verify they pass**
- [ ] **Step 5: `bun run typecheck && bun run check:all && bun run check:file-sizes`**
- [ ] **Step 6: Commit** — `feat(native): add a fail-open subset validator for tool inputs (#2047)`

---

### Task 2: Synthesize a corrected exemplar from the schema

Same new file or a sibling `tool-input-exemplar.ts`, whichever keeps both under 600 lines.

This is the lever. Probe 3 in the issue measured 10 corrective error texts with no bad example at **5/5 correct**, and 10 bad examples with no corrective text at **1/5**. The example is what the model copies, so the example has to be right.

- [ ] **Step 1: Write the failing tests**

| schema | bad input | exemplar |
|---|---|---|
| `RunCommand` | `{command:"testScoped", values:""}` | `{command:"testScoped", values:{files:"<FILL IN: files>"}}` |
| property has `enum` | `{command:5}` | first enum member |
| property is `array of string` | `{argv:"bun test"}` | `{argv:["<FILL IN: argv>"]}` |
| nested object with no declared properties | `{values:""}` where `values` has no `properties` | `{values:{"<FILL IN>":"<FILL IN>"}}` |
| valid input | (n/a — never called) | — |

Key case: **the exemplar preserves every property that validated.** `command:"testScoped"` survives; only the violating property is replaced. A test must assert that.

Second key case: **the exemplar itself validates.** Assert `validateToolInput(schema, exemplarFor(schema, input, violation)) === undefined` for every row. A wrong-shaped exemplar would be the bug this plan exists to fix, so this is a property test, not an example test.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

```ts
export function exemplarFor(
  schema: unknown, input: Record<string, unknown>, violation: ToolInputViolation,
): Record<string, unknown>;
```

Where does `files` come from in `{values:{files:"<FILL IN: files>"}}`? **Not** from parsing the description. `RunCommand`'s `values` schema declares no `properties` — the placeholder names are per-declared-command and live in the description prose. So the generic answer is the nested-object fallback: `{"<FILL IN>": "<FILL IN>"}`. That is still shape-correct, which is what the probes measured as the lever.

Getting the *named* placeholder is a genuine improvement but requires `RunCommand` to declare `values` per-command, which it cannot in static JSON Schema (`run-command.ts:296` documents the same limitation for `required`). **Out of scope here** — file it as a follow-up after Task 8's run, and only if the run shows the generic exemplar is insufficient.

- [ ] **Step 4-6:** tests pass, gates green, commit — `feat(native): synthesize a schema-derived exemplar for an invalid tool call (#2047)`

---

### Task 3: Gate and rewrite in the turn loop

The 14-line task. Read the Global Constraints on file size and mutation again before starting.

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/native/session/turn-loop-invalid-input.test.ts`, driving `runNativeTurn` with a stub `complete` that returns a malformed `RunCommand` call then a clean text answer:

1. **Not executed** — `interactionHandler.onInteraction` is never called for the invalid call.
2. **Exemplar persisted** — the saved transcript's assistant message carries `toolCalls[0].input` equal to the exemplar, **not** `{"values":""}`. Assert the raw malformed string appears **nowhere** in the serialized transcript.
3. **Error result present** — a `tool-result` with the matching `toolCallId`, `isError: true`, and content naming both the property and the exemplar.
4. **Thinking survives** — a `thinking` block on the assistant message is byte-identical after the rewrite.
5. **Sibling calls unaffected** — an assistant message with one valid and one invalid call executes the valid one and rewrites only the invalid one.
6. **Two invalid calls in one assistant message** — both are rewritten. The second rewrite must compose onto the result of the first, not onto the original message. This is the case a naive implementation silently drops, because each iteration re-reads `messages`.
7. **Valid path untouched** — a valid call reaches `onInteraction` with byte-identical input.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

Inside `for (const call of res.toolCalls)`, immediately **before** `spinBreaker?.observe` (an invalid call must not consume spin budget — it gets its own, Task 4), delegate:

```ts
const invalid = handleInvalidToolCall(call, tools, messages);
if (invalid) { messages = invalid.messages; continue; }
```

`handleInvalidToolCall` lives in the new module and does all three things: look the tool's schema up in the local `tools` array by `call.name`, validate, and — on a violation — return a new `messages` array whose last assistant message has the rewritten `toolCalls` entry plus the appended error `tool-result`. It returns `undefined` when the call is fine, so the success path costs one function call and no allocation.


- [ ] **Step 4: Run the tests to verify they pass**
- [ ] **Step 5: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/agents/native/` — the whole native suite**
- [ ] **Step 6: `bun run check:file-sizes`** — if `turn-loop.ts` breaches 600, do **not** trim comments. Extract the per-call loop body to a new module and re-run.
- [ ] **Step 7: Commit** — `feat(native): reject an invalid tool call and persist a corrected exemplar (#2047)`

---

### Task 4: A hard budget for repeated invalid calls

A repeated *invalid* call is never productive. It gets a far tighter budget than the spin breaker's, because there is no legitimate shape of work it resembles.

- [ ] **Step 1: Write the failing tests**

- 3 identical invalid calls (same tool, same `stableStringify`d input) end the turn.
- The 3rd is **not** answered with a tool-result (matching the existing `stop` branch at `turn-loop.ts:470-476`: a result nobody reads only grows the transcript).
- The `TurnResult` carries a classification distinguishable from `fail-spin` — extend the existing `spinStopped` reporting rather than inventing a parallel channel.
- 3 invalid calls with *different* inputs do **not** stop (the model is exploring, not looping).
- 2 invalid calls followed by a valid one do not stop, and the counter for that key persists (it is cumulative, not consecutive — see Task 5's rationale, which applies identically here).

- [ ] **Step 2-4:** fail, implement in the Task-3 module, pass.
- [ ] **Step 5:** full native suite + gates.
- [ ] **Step 6: Commit** — `feat(native): hard-stop a turn after 3 identical invalid tool calls (#2047)`

---

### Task 5: Close the spin breaker's laundering hole

`src/runtime/spin-breaker/index.ts` (188 lines — comfortable headroom).

The measured failure: 69 identical calls, `maxRepeatRun` 22, threshold 25. `repeatsSinceProgress` resets on any new key, so interleaving launders it.

- [ ] **Step 1: Write the failing tests**

Add to the existing spin-breaker suite:

- **The regression case, from the real data.** Feed the exact 120-call sequence shape above (69 of key A, 13 of key B, the rest distinct) and assert the breaker now stops. This is the acceptance test for the whole task — write it first and name it after the run.
- A cumulative counter per key: the Nth occurrence of one key trips regardless of what came between.
- Interleaving does **not** reset the cumulative counter (it still resets `repeatsSinceProgress`, which stays as-is for the #2013 case).
- 600 *varied* calls still never trip. #2013's design note is explicit that a session making 600 varied calls is working, not spinning — a test must pin that this change does not regress it.
- The window bound still holds: cumulative counts live in the same bounded `recentKeyWindow` Map, so memory stays bounded. A key evicted from the window loses its count — assert that, and document it the way `newKeyEvents`' doc comment already documents the same tradeoff.

- [ ] **Step 2: Run the tests to verify they fail**

- [ ] **Step 3: Implement**

Store a count rather than `true` in the `recent` Map (`Map<string, number>`) — the structure is already there and already bounded, so this is a value-type change, not a second structure. Add `stopAfterSameKeyRepeats` to `ResolvedSpinBreakerSettings`, default **12**, with the config knob in `schemas-infra.ts` + `config-descriptions.ts` alongside the existing four. A `0` disables it.

Why 12: the observed loop reaches 12 occurrences of key A by roughly call 40 of 120, so it cuts the loop to a third. It is also comfortably above any legitimate repeat — re-running one failing test 12 times without varying anything is already a spin.

Leave `nudgeAfterRepeats: 25` alone. It is the instrument for #2013's 622-call varied verifier, and re-tuning it would trade false negatives for false positives on the shape it does catch.

- [ ] **Step 4-5:** pass, gates.
- [ ] **Step 6: Commit** — `fix(spin-breaker): count cumulative per-key repeats so interleaving cannot launder a loop (#2047)`

---

### Task 6: Give the breaker session lifetime

`createSpinBreaker` at `turn-loop.ts:208` is per-turn, so fix rounds start from zero even though they inherit the whole transcript.

- [ ] **Step 1: Write the failing tests**

- Two `runNativeTurn` calls on the same `handle.id`, each making 7 identical calls, trip a cap of 12 on the second turn.
- Two turns on *different* session names do not share a counter.
- `closeNativeSession` clears it (the map's existing lifecycle already does this at `session.ts:177` — assert it, since the whole point is that a stale counter must not leak into a reused name).
- A session with no registered breaker still behaves exactly as today (`undefined` -> no breaker).

- [ ] **Step 2-3:** fail, then change `nativeSessionSpinBreaker` from `Map<string, ResolvedSpinBreakerSettings>` to hold the live `SpinBreaker` instance, created once at `openNativeSession` (`session.ts:131`) from the settings. `adapter.ts:302` then passes the instance and `turn-loop.ts:208` stops constructing one. **`turn-loop.ts` loses a line here** — bank it against Task 3's budget.

Watch the `check:adapter-no-config-import` gate: the breaker is already config-free by construction (it takes resolved settings), so moving construction to `session.ts` keeps that property. Verify with `bun run check:all`.

- [ ] **Step 4-5:** pass, gates, full native suite.
- [ ] **Step 6: Commit** — `fix(spin-breaker): give the breaker session lifetime so fix rounds inherit its count (#2047)`

---

### Task 7: Coverage and the full gate

- [ ] `bun run test` (full suite)
- [ ] `bun run typecheck`
- [ ] `bun run check:all`
- [ ] `bun run check:file-sizes`
- [ ] **`bun run test:coverage`** — not in `check:all`, and this plan adds two or three `src/` files. Run it.
- [ ] Commit any coverage-driven test additions separately.

---

### Task 8: Dogfood — re-run the story that produced the measurements

This is the acceptance step, and it is the only one that can confirm the mechanism rather than the implementation.

- [ ] **Ask before running.** `nax run` requires explicit approval at the launch moment. Do not launch it as part of executing this plan; surface the command and wait.
- [ ] Re-run the `cost-row-rate-provenance` story on `openrouter/deepseek/deepseek-v4-flash-0731[high]`, same workdir, same effort.
- [ ] **Measure from `tool-audit`, not by inspection.** It records `input`, so the attempt-1 table is directly reproducible. Compute, per session file: total calls, malformed count, `maxRepeatRun`, and cumulative max-per-key.
- [ ] **Pass condition:** zero invalid calls reach dispatch, **or** the turn hard-stops within 3 identical invalid calls. Either outcome is a pass — the second means the gate worked and the model still could not recover, which is itself the answer.
- [ ] **Also record:** whether the story completed, and whether a scoped test ever ran successfully. Attempt 1 passed only because nax's own gates ran the tests; "the story passed" is not evidence here.
- [ ] Post the resulting table as a comment on #2047 and close it against that table.

---

## Deliberately out of scope

- **Deleting the per-tool shape guards** (#2046's `run-command.ts:330`, #2044's redirect). They are correct, they are tested, and the generic gate makes them redundant rather than wrong. Removing them is a separate cleanup with its own regression risk, and it must come *after* Task 8 proves the gate covers them.
- **Named placeholders in the exemplar** (`{files:"…"}` rather than `{"<FILL IN>":"…"}`). Requires `RunCommand` to declare `values` per-command, which static JSON Schema cannot express. File only if Task 8 shows the generic exemplar is insufficient.
- **Re-tuning `nudgeAfterRepeats`.** See Task 5.
- **An ACP equivalent.** nax never sees an ACP tool call.
