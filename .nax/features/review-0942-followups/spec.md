# SPEC: Finish the actionable v0.94.2 review findings

## Summary

One maintenance run, requested as one branch and PR, against main after #3077. Source of truth: `docs/reviews/nax-v0.94.2-verified-code-review.md` (reviewed tag v0.94.2). Map findings 5 → US-001/002, 6 → US-003, 7 → US-004, 8 → US-005, 11 → US-006, 12 → US-007, 14 → US-008. Findings 1–4 and 9–10 have shipped; 13 is measurement-dependent and stays deferred. Numbers in this map are report headings, not issue numbers.

## Motivation

A lost MCP reply can turn one note into two; a pending ACP write can hold a close caller indefinitely. The remaining defects concern custom SDK routing, missing code neighbors, repeated replay work, unbounded job-panel text, and a local coverage runner whose child exits before its pipes close. None requires a live provider or production latency claim to verify.

## Design

Extend existing packages in place. For ambiguous remote writes prefer reporting uncertainty to silently reissuing or claiming success. Treat reply loss in the pool and the independent timeout in the outbox as separate failure paths. Use an opt-in provider contract for non-replayable writes; retain legacy retry semantics for providers whose operations are safe to repeat. A non-replayable MCP add must not rely on a search hit, matching text, or an unsupported wire idempotency key to prove delivery. Use the existing outbox and persist a non-auto-retry outcome with its client ID and reason; do not drop the operator's pending note. For close, distinguish the deadline for the caller from the lifetime of the resource. For performance tests count input visits, bytes and rows rather than using wall-clock benchmarks.

## Stories

**US-001: Hold uncertain non-replayable pushes (5, drain).** Workdir: `packages/nax-agent`. No dependencies. Extend the provider contract, immediate save path in operations.ts, and sync drain so a provider can mark an operation unsafe to repeat. Bound scope to observed dispatch failures and timeouts; distinguish definite pre-dispatch failures. Exercise `sync` with a fake provider and timer, then reopen the outbox. Verify from this workdir: `CI=1 timeout 90 bun test ./test/unit/memory/operations-undelivered.test.ts ./test/unit/memory/sync-drain.test.ts ./test/unit/memory/sync-drain-awaits.test.ts --timeout=60000`.

**US-002: Do not resend ambiguous MCP writes (5, transport and wiring).** Workdir: `packages/nax`. Depends on US-001. Wire the MCP memory provider to that contract and the pool to explicit replay safety at dispatch; do not infer safety from arbitrary tool names. Test the full provider/outbox/pool path with an offline fake server. Verify: `CI=1 timeout 90 bun test ./test/unit/mcp/pool-retry.test.ts ./test/unit/memory/mcp-provider.test.ts ./test/unit/memory/mcp-provider-id-map.test.ts ./test/integration/memory/mcp-uncertain-save.test.ts --timeout=60000`.

**US-003: Validate custom SDK OpenRouter routing (6).** Workdir: `packages/nax-ai`. No dependencies. Compare effective model-level `openRouterRouting` on the two declared catalogs, including base models; preserve order where wire arrays are ordered. No new native CLI routing layer. Verify: `CI=1 timeout 90 bun x vitest run test/protocols/override-declaration.test.ts test/protocols/pi-client-custom-provider.test.ts`.

**US-004: Bound ordinary ACP session close (7).** Workdir: `packages/nax-agent-acp`. No dependencies. Exercise ordinary session close via the registry with an unresolved output notification. Reuse shutdown's bounded-wait pattern (default five seconds); retain a distinct cleanup completion, not a timeout that falsely signals disposal. Verify: `CI=1 timeout 90 bun test ./test/unit/server/server-session.test.ts ./test/unit/server/server-session-close-switch.test.ts ./test/unit/server/registry-hardening.test.ts ./test/unit/server/registry-close-switch.test.ts --timeout=60000`.

**US-005: Resolve existing code neighbors in both directions (8).** Workdir: `packages/nax`. No dependencies. The forward and reverse resolver must agree on actual files under the existing workdir/package boundary. Exercise code-neighbor collection on real temporary source files. Verify: `CI=1 timeout 90 bun test ./test/unit/context/engine/providers/code-neighbor.test.ts ./test/unit/context/engine/providers/code-neighbor-collect-edges.test.ts --timeout=60000`.

**US-006: Stream and index replay events once (11).** Workdir: `packages/nax`. No dependencies. Read JSONL incrementally from the same no-follow, nonblocking, regular-file-checked handle, never reopen by pathname; accumulate phase inputs by story instead of filtering the full history once per story. Preserve run-level context and report semantics. Verify: `CI=1 timeout 90 bun test ./test/unit/replay/reconstruct.test.ts ./test/unit/commands/replay.test.ts --timeout=60000`.

**US-007: Bound job-panel tail reads and wrapping (12).** Workdir: `packages/nax`. No dependencies. Pass a panel-only 64 KiB raw tail scan budget from job-panel-view through job-runner per refresh, at most 12 nonblank lines, and at most four wrapped content rows per logical line including a visible truncation indicator. Apply byte limits before wrapping; do not change persisted logs. Verify: `CI=1 timeout 90 bun test ./test/unit/chat/jobs/log-tail.test.ts ./test/unit/chat/jobs/job-panel-view.test.ts ./test/unit/tui/chat/layout-job.test.ts --timeout=60000`.

**US-008: Keep quiet coverage capture on deadline (14).** Workdir: `packages/repo-tooling`. No dependencies. A parent with `AGENT=1` drains both output streams from launch; child exit and stream EOF are separate. Inject a short deadline and fixture child command into the production runCoverage capture path for tests; keep 480 seconds by default. Keep the original deadline through drain, abort or detach pending capture on expiry, retain at most 64 KiB of diagnostics per stream. Verify: `CI=1 timeout 90 bun test ./test/unit/scripts/check-coverage.test.ts --timeout=60000`.

### Context Files

**US-001**
- `packages/nax-agent/src/memory/provider-types.ts`
- `packages/nax-agent/src/memory/sync-drain.ts`
- `packages/nax-agent/src/memory/outbox.ts`

**US-002**
- `packages/nax/src/mcp/pool.ts`
- `packages/nax/src/memory/mcp-provider.ts`
- `packages/nax/src/memory/mcp-id-map.ts`

**US-003**
- `packages/nax-ai/src/protocols/override-declaration.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`

**US-004**
- `packages/nax-agent-acp/src/server/server-session.ts`
- `packages/nax-agent-acp/src/server/registry-lifecycle.ts`

**US-005**
- `packages/nax/src/context/engine/providers/code-neighbor-phases.ts`

**US-006**
- `packages/nax/src/commands/replay.ts`
- `packages/nax/src/replay/reconstruct.ts`
- `packages/nax/src/replay/phase-infer.ts`

**US-007**
- `packages/nax/src/chat/jobs/log-tail.ts`
- `packages/nax/src/tui/chat/layout-job.ts`

**US-008**
- `packages/repo-tooling/scripts/check-coverage.ts`

### Creates

**US-002**
- `packages/nax/test/integration/memory/mcp-uncertain-save.test.ts` — first-save and later-drain dispatch counts with fake MCP transport and real persisted outbox.

### Seams

US-002 consumes US-001: start at a real remote memory save, reopen its persistent outbox, and sync twice through the MCP provider against a fake server that commits before losing its reply. Count tool dispatches on both connections and after reopening the outbox, not only calls to a mock of the provider.

### Modifies

**US-002**
- `packages/nax/test/unit/mcp/pool-retry.test.ts` — scope expectations for replay after an observed close to explicitly retry-safe calls; preserve the disconnect, reconnect budget and success assertions for those calls.

- `packages/nax/test/unit/memory/mcp-provider-id-map.test.ts` — replace retryable-after-id-map-write-failure expectation with no automatic remote resend; preserve the diagnostic.

**US-005**
- `packages/nax/test/unit/context/engine/providers/code-neighbor-collect-edges.test.ts` — correct the directory quick-check false negative and omit the reverse edge for absent ghost.ts; retain unrelated hints.
- `packages/nax/test/unit/context/engine/providers/code-neighbor.test.ts` — supply existing fake-filesystem dep.ts and shared.ts targets for positive scopePaths assertions; preserve missing sibling test hints.

**US-006**
- `packages/nax/test/unit/commands/replay.test.ts` — if streaming changes the loader return type, collect the stream before asserting empty or single-entry results; retain all missing/malformed-input expectations.

**US-007**
- `packages/nax/test/unit/chat/jobs/job-panel-view.test.ts` — exact runner call options now include the panel-only byte budget; preserve other fields.

## Acceptance Criteria

**US-001**
- With a non-replayable add pending past `MEMORY_OP_TIMEOUT_MS`, sync exposes its client ID and unknown delivery status rather than reporting it delivered.
- After reopening the outbox, another sync does not dispatch that add, even if the original push completed after timeout. Its payload and reason remain inspectable.
- An `awaits` dependent retirement does not execute on the assumption the uncertain replacement was saved. An ordinary forget with no `awaits` for the same scope and slug also stays undelivered behind an unresolved add, including after reopening the outbox; a missing remote ID is not proof of deletion.
- The immediate save result distinguishes unknown delivery with no automatic retry from a definite unsent write queued for sync; keep that distinction observable to callers.
- A retry-safe provider still retries a transient failure on the next sync; a definite pre-dispatch outage does not permanently park a note. Retry as unsent only once the attempt cannot dispatch later. A timeout during pending discovery is unknown unless cancellation prevents any late dispatch. Apply the same rules on the initial save and on the drain.

**US-002**
- A non-idempotent tool that commits and closes before replying receives a single dispatch; the pool does not make a second attempt on the replacement connection. Unknown tools are not assumed read-only.
- Starting from a first save (not a pre-seeded drain), after that ambiguous MCP add, the next memory sync sends no second add for the same outbox entry. No invented remote ID or successful mirror delivery is recorded. Through the memory save CLI, the lost-reply result reports “delivery unknown; no automatic retry”, whereas a definitely unsent queued save reports “queued for sync”.
- A slow MCP add that commits after the outer drain timeout is not sent again. A dispatched add returning a tool error with uncertain effects is not automatically retried either.
- A known read-only lookup interrupted by a connection close can still use the existing bounded retry. An acknowledged add that returns a remote ID records it in the ID map, distinct from the local note ID returned by push. An acknowledged `ok` with no remote ID remains a success, returns the local ID, creates no mapping and is not resent. If idMap.add fails after remote success, preserve the uncertain entry without repeating the remote add.

**US-003**
- `createClient` rejects separately declared catalogs with equal IDs but conflicting effective `openRouterRouting`, including a missing wire restriction. Test both bundled and new model IDs; compare effective wire routing rather than the last declaration alone. Across successive overrides for a bundled provider, a later same-ID model omitting routing inherits the previous template restriction; explicit replacement routing takes precedence. When both final declarations omit routing but only one inherits an earlier restriction, reject the mismatch before dispatch. For matching inherited restrictions, capture a serialized offline request and assert the restriction is present.
- Independently built equal routing values are accepted; a captured serialized offline request (onPayload or intercepted fetch, not stubStream model inspection) contains the declared routing on the wire.
- Pricing-only differences remain accepted. Hand-built entries that never declared overrides keep their existing contract.

**US-004**
- Ordinary close returns by its configured wait when an output write never settles (controlled clock); it does not admit new work to the closing session.
- Before that write settles, a competing owner cannot acquire the same live session. After release, final accounting and ownership cleanup occur once, including after repeated closes.
- The ordinary registry close wait is bounded for pending output delivery only, not for an independently held lock guard. Normal and rejected writes close without the delivery timeout. Repeated close and shutdown share one true cleanup completion; delete waits for disposal before deleting storage. Server-wide shutdown remains bounded.

**US-005**
- Forward results for `./Button`, `./x.js` and `./lib` point to the existing `Button.tsx`, `x.js` and `lib/index.ts` respectively on a fixture with no shadowing candidates.
- Reverse results for each of those files include its actual importer, including `import './lib'` without the word `index` elsewhere in the importing source.
- No import edge to an absent target or outside the workdir is emitted; synthesized sibling test hints need not exist and stay unchanged; an ordinary `.ts` control still resolves.

**US-006**
- `replay` produces equivalent filtered and unfiltered report content to the existing reconstruction for interleaved run-level and multi-story events, including phase order and missing-log handling.
- With 10,000 input records, increasing the story set from 1 to 100 does not multiply record inspections: instrument the real ingestion/reconstruction path and assert a constant number of full-record passes, including `--story`.
- When top-level and nested story IDs differ, phase inference can match either; degraded story discovery still prefers the top-level ID. Nonregular files and symlinks are not streamed. JSONL records split across read chunks (including a final line without newline) reconstruct as whole records; preserve existing invalid-record handling.

**US-007**
- Tailing a single 256 KiB record reads at most 64 KiB of file data per refresh, examines each scanned chunk once and visibly indicates omitted text.
- A tail with 12 short nonblank lines fitting the budget returns them in order without a truncation mark for complete lines. If the budget cuts a multibyte character, mark only that partial line, not later complete lines; its marker counts toward the four rows. UTF-8 characters crossing chunk boundaries within retained text remain intact. Non-panel callers without a budget still get long complete lines.
- At width 120 a 256 KiB logical line yields no more than four content rows including the truncation indicator; narrow widths still respect row and width limits. Verify bounded wrapping work, not slicing after full layout.

**US-008**
- With `AGENT=1`, a fixture whose leader exits immediately but whose descendant holds a pipe open returns runner status 124 by its injected short deadline (not the test wrapper deadline); main maps this failure to CLI status 1 without waiting for that descendant. Clean up the fixture in all outcomes.
- Output from both streams exceeding the cap yields bounded diagnostic tails, including terminal failure text; a normal quiet success retains its existing summary without dumping child output.
- When EOF arrives within budget the original child status is honored; non-quiet inherited-stream execution keeps its current behavior.

## Out of Scope

- Do not redo findings 1–4 (#3075) or 9–10 (#3077), including changing replay run selection or log identity.
- Finding 13 (mirror listing) stays deferred until field evidence shows material cold I/O or memory pressure. Synthetic warm timings do not justify an inventory rewrite.
- No native CLI privacy incident is asserted for finding 6. No live-provider calls, pricing changes, new provider support, or changes to the default catalog wiring.
- No distributed exactly-once guarantee, crash recovery between dispatch and local persistence, server protocol changes, automatic reconciliation of ambiguous notes, or blanket disablement of safe retries.
- No new TypeScript compiler resolver, package alias support, global replay cache, log retention policy, CI runner migration, or production latency target.
- No merge, release, version bump or redesign of unrelated subsystems.
