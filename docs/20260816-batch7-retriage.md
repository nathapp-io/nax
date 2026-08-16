# Batch 7 Re-triage (L1…L38)

**Date:** 2026-08-16
**Source doc:** `docs/20260814-review-current.md`
**Reason:** that doc's Batch 7 triage proved unreliable in *both* directions. It promoted three items as having "live failure modes" — two of which were wrong (L5 described code that does not exist; L8 assumed pipe semantics `Bun.spawn` does not have) — while filing the remainder as "hygiene". At least four of those "hygiene" items are real defects, one of them silent data corruption on the PRD path.

This pass re-verifies every L-item against current source and re-assigns severity.

## Verification depth

Each item is tagged with how far it was actually checked. Do not treat these as equivalent.

| Tag | Meaning |
|:---|:---|
| `[probe]` | Empirically reproduced with a runnable script |
| `[read]` | Confirmed by reading the cited code and its consumers |
| `[shallow]` | Pattern spotted at the cited site; consumers not traced |

## Re-assigned severities

### Promoted — real defects, not hygiene

| ID | Severity | Status | Finding |
|:---|:---|:---|:---|
| **L11** | HIGH | ✅ **Fixed** | `[probe]` `stripTrailingCommas` was regex-only and string-blind, so `,}` / `,]` inside string *values* were deleted. The rewrite still parsed, so the corruption was silent. `prd/schema.ts:523` and `acceptance/refinement.ts:28,62` call it **unconditionally** before any parse, so AC text quoting code was mangled into `prd.json`. |
| **L10** | HIGH | ✅ **Fixed** | `[read]` `markStoryPassed` sets **both** `passes = true` and `status`; `markStoryFailed` set **only** `status = "failed"` and never cleared `passes`. The asymmetry between the two sibling functions is the tell. **Correction to an earlier draft of this row:** the consequence is *not* that the story is skipped — both selectors exclude `status === "failed"` independently, so the story itself is handled correctly. The damage is one level out, in **dependency** resolution: `story-selector.ts:174` reads `dep.passes \|\| dep.status === "passed"` and `story-context.ts:232` builds `completedIds` from `s.passes`, so a dependency that went passed → failed still reads as satisfied and its **dependents unblock and run**. `unified-executor.ts:719` marks a story failed on merge conflict after its pipeline passed, so the work never reached the base branch. |
| **L33** | MEDIUM | ✅ **Fixed** | `[read]` Two distinct defects. `skipPermissions` has **zero readers** outside `permissions.ts` (only `.mode` is consumed, in `acp/adapter.ts` and `middleware/audit.ts`) — dead output that `CLAUDE.md` still advertises as the destructuring pattern. Worse: the `execution.permissions` schema block has **zero readers** — it parses and silently does nothing, so a user configuring it gets no error and no effect. |
| **L16** | MEDIUM | ✅ **Fixed** | `[read]` `parseRunLog` does `lines.map(line => JSON.parse(line))` inside one try/catch returning `[]`. A single truncated final line — exactly what a crashed run leaves — blanks the entire log for `nax runs list/show`, defeating the diagnostic tool precisely when it is needed. Should skip bad lines, not the file. |

### Confirmed, correctly rated as low

| ID | Severity | Finding |
|:---|:---|:---|
| L2 | LOW-MED | `[read]` Uncancellable `await Bun.sleep(iterationDelayMs)` at `unified-executor.ts:554,647`. Violates the repo's own forbidden-patterns rule; `cancellableDelay` exists in `utils/bun-deps`. Ctrl+C will not interrupt the delay. |
| L9 | LOW-MED | `[read]` `matchesAllowedPath` builds `new RegExp` from glob patterns. A `(`, `+`, or `[` in a scope pattern throws or matches wrongly. The `nosemgrep` note calls patterns "not user input", but PRD scope config is LLM-authored. |
| L15 | LOW-MED | `[read]` `promptForConfirmation` registers only a `data` listener — no `end`/`error`, so stdin EOF on a TTY hangs forever with raw mode still set. Raw mode *is* restored on the normal and Ctrl+C paths, so that half of the original claim is weaker than filed. Both callers are interactive (`bin/nax.ts:493,647`). |
| L12 | LOW | `[read]` `parseCommandToArgv` applies `~` expansion via `.map()` *after* quote parsing, so `"~/x"` expands inside quotes; `if (current.length > 0)` drops a legitimately empty `""` argument. |
| L21 | LOW | `[read]` `sink({ ...entry })` is a shallow clone, so nested `entry.data` is shared across sinks — the isolation the doc comment claims is not provided. |
| L1 | LOW | `[read]` `Bun.spawnSync` git call on the main thread at `run-setup.ts:322`. One-time and fast; cosmetic in practice. |
| L3 | LOW | `[read]` `filePath.includes("../")` traversal check. `..//` *is* caught (it contains `../`); the real gap is absolute paths. Inputs are internal. |
| L7 | LOW | `[shallow]` Feature name flows unvalidated into `runDir` path construction at `subscribers/registry.ts:53`. Overlaps L17. |
| L14 | LOW | `[shallow]` `followLogs` re-reads the whole file per poll; stalls on rotation, crashes on deletion. |

### Downgraded or refuted

| ID | Verdict | Basis |
|:---|:---|:---|
| **L5** | ❌ **Refuted** | `[read]` `pipeline/runner.ts` already reads `if (result.cost) stageCostAccum += result.cost;` — since PR #304. That guard is falsy for `undefined`, `0`, **and `NaN`**. The unguarded `+=` the finding described does not exist. |
| **L8** | ❌ **Refuted** | `[probe]` The pattern (awaiting `proc.exited` before draining `proc.stdout`) is real at four sites, but the deadlock assumes POSIX 64KB pipe-buffer semantics `Bun.spawn` does not have — it buffers child stdout internally. Measured on Bun 1.3.13: this repo's own `git ls-files` (132KB) and a synthetic **64MB** stream both complete with every byte recovered. |
| **L13** | ✅ **Fixed (PR #1595)** | Confirmed and *worse* than filed — six sites, no SSOT, and `execution/lock.ts` more dangerous than the cited `unlock.ts`. |
| **L20** | ⚠️ Partially refuted | `[read]` `registeredRequestIds` is **not** simply unbounded — there is a `.delete()` at `webhook.ts:290` and a `.clear()` at `:237`. Growth is limited to requests that never reach the delete path. Re-scope or close. |

### Not re-verified in this pass

L4, L6, L17, L18, L19, L22–L32, L34–L38 were left at their original severity. They are predominantly type-safety nits, dead surfaces, and documentation drift, and nothing in the promoted set suggests a systematic under-rating in that group. **They still carry a single verification pass** — read the cited line before acting, and record it in the commit if the code no longer matches.

## Recommended order

1. ~~**L11**~~ — done.
2. ~~**L10**~~ — done. `markStoryFailed` now clears `passes`.
3. ~~**L16**~~ — done. Per-line tolerant parse; malformed lines are skipped and counted in a warning.
4. ~~**L33**~~ — done, both halves. `skipPermissions` and the unused `allowedTools` are gone from `ResolvedPermissions`; `execution.permissions` is now rejected at config load by `rejectUnimplementedPermissionsBlock`, alongside the `"scoped"` profile it belongs to, and its schema and `runtime-types.ts` entries were removed.
5. **L2, L9, L15** — the remaining confirmed set; one small batch.
6. Everything else — hygiene, genuinely.

### Why L33 was rejected rather than implemented

Per-stage permissions are **frozen, not merely unfinished**: acpx's own permission support is not mature enough to build on, which is also why SEC-01 was discarded. So the config surface for a frozen feature had to stop accepting input rather than grow an implementation. Rejecting at load mirrors `rejectUnimplementedScopedProfile` and is safe in practice — neither the global `~/.nax/config.json` nor this repo's `.nax/config.json` carried the key.

## Method note

Two of the three items the source doc ranked highest were wrong, and four it dismissed were real. Severity labels in that document carry no signal in either direction; the only reliable input is the cited `file:line`, and even those drift. Reproduce before fixing — a ten-line script settled L8 and L11 in one shot each.
