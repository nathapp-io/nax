# PRD fidelity — review-0942-followups

**Reviewed against:** `spec.md` and `prd.json`, repos/nax at `8c23cb93c`  
**Date:** 2026-11-28  
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)  
**Verdict:** Ready on PRD fidelity. No behavioral or structural correction required.

## Summary

- Phase 9: 27/27 source AC bullets mapped to 62/62 PRD criteria across 8 stories. All 8 exact verification commands are in their owning descriptions; 6/6 exclusions match verbatim. Checked 22 context entries (17 specified, 5 extra), 1 creation, 6 modifications, and the 1 named new file across descriptions/ACs; no new named API spelling was prescribed. No blockers or majors. One grouped minor finding covers 5 helpful extra read hints.

## Source AC → PRD AC

Numbers are one-based within the same story: source bullet and line in `spec.md` → `acceptanceCriteria` positions in `prd.json`. Each row preserves the stated behavior; splits and more-specific examples are accounted for, not counted as orphans.

| Story | Source (line) | PRD | Assertion carried forward |
|---|---:|---:|---|
| US-001 | 1 (97) | 1 | Past `MEMORY_OP_TIMEOUT_MS`, expose client ID and unknown delivery, not success. |
| | 2 (98) | 2 | Reopen: no redispatch even after late completion; retain payload and reason. |
| | 3 (99) | 3–4 | Block both `awaits` retirement and same-scope/slug ordinary forget behind unresolved add, including after reopen; absent ID proves nothing. |
| | 4 (100) | 5 | Immediate caller distinguishes unknown/no retry from definitely unsent/queued. |
| | 5 (101) | 6–8 | Retry safe transient failures; retry unsent only when late dispatch is impossible. Pending discovery timeout is unknown unless cancellation prevents dispatch, on save and drain. |
| US-002 | 1 (104) | 1–2 | Commit then close: one dispatch across connections; unknown tools not presumed safe. |
| | 2 (105) | 3–5 | First save then sync, no second add, invented ID or mirror success; CLI distinguishes “delivery unknown; no automatic retry” from “queued for sync”. |
| | 3 (106) | 6–7 | Neither late commit past outer timeout nor uncertain dispatched tool error permits resend. |
| | 4 (107) | 8–11 | Bounded lookup retry; remote/local ID distinction; acknowledged `ok` without ID succeeds unmapped; `idMap.add` failure preserves uncertainty without resend. |
| US-003 | 1 (110) | 1–4 | `createClient` checks effective `openRouterRouting` on bundled/new IDs; inheritance vs explicit replacement; unequal inherited restrictions rejected before dispatch, matching restrictions present on wire. |
| | 2 (111) | 5, 8 | Equal independent values accepted; serialized offline payload, not stub model. AC8 specializes equality to ordered arrays as required by the story. |
| | 3 (112) | 6–7 | Pricing-only differences accepted; undeclared hand-built entries retain contract. |
| US-004 | 1 (115) | 1 | Controlled clock bounds caller wait for stuck output, no new work admitted. |
| | 2 (116) | 2–3 | Ownership retained pending release; accounting and cleanup once despite repeated closes. |
| | 3 (117) | 4–8 | Bound output wait, not independent lock; normal/rejected writes close without timeout; shared real completion, delete after disposal, bounded shutdown. |
| US-005 | 1 (120) | 1 | Unshadowed `./Button`, `./x.js`, `./lib` resolve to the specified existing TSX, JS and directory-index targets. |
| | 2 (121) | 2 | Each target includes real importer; `import './lib'` needs no `index` text. |
| | 3 (122) | 3–6 | No missing/outside import edges, preserve sibling hints and `.ts` control; AC6 instantiates the `ghost.ts` correction from Modifies. |
| US-006 | 1 (125) | 1 | Interleaved run/story events preserve filtered and unfiltered reports, phases and missing-log behavior. |
| | 2 (126) | 2 | Real path, 10,000 records, 1 vs 100 stories, constant full-record passes including `--story`. |
| | 3 (127) | 3–7 | Either ID for phases, top-level first for discovery; no streaming nonregular files/symlinks; reassemble split and unterminated lines, preserve invalid-input handling. AC7 ties unsafe paths to existing handling. |
| US-007 | 1 (130) | 1 | 256 KiB input: ≤64 KiB read per refresh, one inspection per chunk, visible omission. |
| | 2 (131) | 2–5 | 12 complete lines unmarked/in order; mark only budget-cut line within four rows, preserve retained cross-chunk UTF-8 and unbudgeted callers. |
| | 3 (132) | 6–7 | At width 120 and narrower, ≤4 content rows including indicator; narrow width respected and wrapping work bounded before full layout. |
| US-008 | 1 (135) | 1–2, 7 | `AGENT=1`, leader exit with pipe held: runner 124 by injected deadline, CLI 1 without waiting, unconditional fixture cleanup. AC7 covers the silent-pipe instance. |
| | 2 (136) | 3–4 | Both streams bounded to diagnostic tails with terminal failure text; quiet success summary without output dump. |
| | 3 (137) | 5–6 | Timely EOF honors child status; non-quiet inherited streams unchanged. |

No behavioral AC became a file-content check. No new stub-invocation path or explicit existing-function argument list was introduced by splitting; the US-002 real-save seam remains explicit, not replaced by a provider stub. No terminal deletion story or separate removal gate is specified.

## Corrections and verification visibility

Correction evidence is from each owning `description` or its ACs above, not `analysis`, tags, or routing metadata. Each source `Verify` command (spec Stories, lines 17–31) was compared literally to that story's description; its stated `workdir` was checked separately. Commands were inspected, **not executed**.

| Story | Workdir | Exact command in description | Correction evidence beyond the AC split |
|---|---|---|---|
| US-001 | `packages/nax-agent` | Yes, 3 Bun suites | Opt-in provider contract; persisted payload, client ID and reason; same save/drain rules, including late discovery and ordinary forget. |
| US-002 | `packages/nax` | Yes, 4 Bun suites incl. new integration test | No search/text/wire-key proof; explicit replay safety. Real save, reopen, sync twice, count both connections at fake server. Preserve disconnect/reconnect assertions and ID-map diagnostic. |
| US-003 | `packages/nax-ai` | Yes, 2 Vitest suites | Effective ordered routing across successive overrides; matching inherited value checked on serialized wire request, not `stubStream`. |
| US-004 | `packages/nax-agent-acp` | Yes, 4 Bun suites | Via registry, default five seconds; caller deadline distinct from cleanup. AC4–8 distinguish locks, writes, delete and shutdown. |
| US-005 | `packages/nax` | Yes, 2 Bun suites | Real temp-source collection; description directs fixture corrections for `ghost.ts`, `dep.ts`, `shared.ts` and preserved sibling hints. |
| US-006 | `packages/nax` | Yes, 2 Bun suites | Same checked no-follow/nonblocking regular-file handle; no pathname reopen. Count visits, not time; adapt stream test without dropping malformed/missing cases. |
| US-007 | `packages/nax` | Yes, 3 Bun suites | Panel-only byte budget threaded via runner before wrapping; preserve other runner options, persisted logs, and unbudgeted behavior. |
| US-008 | `packages/repo-tooling` | Yes, 1 Bun suite | Inject fixture and deadline into production `runCoverage`; 480 s default, concurrent capture from launch, original deadline through drain, abort/detach on expiry, 64 KiB per stream. |

All eight literal matches include `CI=1 timeout 90`, the specific runner and ordered suite paths, and (for all seven `bun test` commands) `--timeout=60000`.

## Structural fields and boundaries

- **Stories and dependencies:** IDs, finding assignments, order and stated workdirs match for 8/8. US-002 has exactly `["US-001"]`; the other seven have explicit `[]`. Branch is `feat/review-0942-followups`; all eight stories are pending with zero attempts.
- **Read/create/modify:** All 17 specified read hints remain in the right stories. All 22 PRD read entries exist. US-002 alone has `expectedFiles`: `packages/nax/test/integration/memory/mcp-uncertain-save.test.ts`, absent before implementation and not listed as context. No upstream-created read is dropped or moved. The 6 specified test paths have separate `modifiedFiles` entries with the specified reasons (US-002: 2; US-005: 2; US-006: 1; US-007: 1). No swallowed path or missing reason.
- **Minor — additional existing context** (spec `Context Files`, lines 33–66): US-001 adds `operations.ts`; US-002 adds `memory-write.ts` and `provider-types.ts`; US-007 adds `job-runner.ts` and `job-panel-view.ts`. Each is a read hint for work already described, not new creation or scope. Recommendation: retain them.
- **Exclusions:** All six spec bullets, in order, equal root `outOfScope`: shipped findings/run selection/log identity; evidence-gated mirror listing; no live-provider, pricing or catalog expansion; no exactly-once/reconciliation/protocol changes or blanket retry ban; no resolver/cache/retention/CI/latency expansion; no merge/release/version bump/redesign. No added exclusion, inverted AC, conflicting story scope, or unprefixed story-only waiver. Preserving pricing-only acceptance and safe retries tests existing behavior; neither reopens deferred work.
