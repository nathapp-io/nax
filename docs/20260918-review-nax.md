# Deep Code Review: @nathapp/nax

**Date:** 2026-09-18 (revised 2026-09-18 after independent verification)
**Reviewer:** Subrina (AI, opencode)
**Verification:** second pass, five parallel sweeps, every finding re-read against source
**Version:** 0.82.0-canary.16 (branch `main`, HEAD `cf8c3baaa`)
**Files:** 1,049 src `.ts`/`.tsx` (~168,691 LOC) - verified exact
**Baseline:** `bun audit` clean (257 packages, no advisories)
**Scope:** Deep review focused on memory/resource lifetime, performance, and security.

---

## Revision note: what the first pass got wrong

Every finding in the original draft was re-verified against source. Line numbers and quoted
snippets were almost entirely accurate, but **the causal claims and severities were not**. The
corrections below are material enough that the original priority order should not be acted on.

| Correction | Effect |
|:---|:---|
| **SEC-4 rests on a threat model nax explicitly rejects** | **Withdrawn.** `docs/architecture/agent-adapters.md:317-345` (§17, decision D-1) states "nax trusts the repository it is pointed at" and lists SEC-4's proposed fix under "Explicitly NOT being built ... Do not raise these again in reviews." |
| **SEC-1 reports documented, ruled-on behaviour** | Downgraded to INFO. §17's table names project-config override of `quality.stripEnvVars` as in-boundary, "warned, not blocked." |
| **MEM-9's headline is false** | **Withdrawn.** `telegram.ts:331-332` *is* the per-request release the finding says does not exist. |
| **MEM-1's stated mechanism is backwards** | `drain()` (`cost-aggregator.ts:583-587`) deliberately **re-pushes** committed events into `_events` under a documented invariant. The proposed "flush per story" fix would break it. |
| **PERF-4's headline number is 10x too high** | 5,000 is the total across all 10 touched files, not the per-file figure. Misses `MAX_NEIGHBORS_PER_FILE = 8` + `break outer`. |
| **PERF-7 is disabled by default** | Never stated. `runtime/index.ts:345` defaults `usageAudit.enabled` to false. |
| **PERF-16's promise-link half is false** | `logger.ts:217` early-returns before touching `writeQueueTail`; batching already exists. |
| **PERF-13 never fires in a configured repo** | It is step 5 of 6 and `build` is explicitly excluded (`review/runner/index.ts:145-152`). |
| **Appendix undercounts `close()`** | Seven bus subscribers, not five. |
| **`PERF-6` is cited but never written** | Dangling ID removed. |
| **Five proposed fixes would cause regressions** | Flagged inline: MEM-1, MEM-10, MEM-11, PERF-7, PERF-10. |

**Grade revised upward** from B+ (82) to **A- (86)**: two findings withdrawn, seven downgraded,
and the confirmed set is smaller and less severe than the first pass claimed.

---

## Overall Grade: A- (86/100)

A mature, heavily-guarded codebase with an explicit, documented threat model. Command execution
uses argv arrays (no `shell: true`), paths are contained via `resolveWithin`, webhook auth uses
HMAC + `timingSafeEqual`, and the repo ships dedicated `check:*` gates for permission SSOT, error
policy, import cycles, and file sizes. No critical or remote-exploitable vulnerability was found.
Remaining deductions are a genuine agent-authority gap (SEC-5), two redaction gaps, and bounded
repeated I/O on the opt-in context engine.

| Dimension | Score | Notes |
|:---|:---:|:---|
| Security | 17/20 | Strong exec/path/auth hygiene; two real redaction gaps, one agent-authority gap |
| Reliability | 17/20 | Session-map teardown gap; most "leaks" are run-scoped and reclaimed |
| API Design | 18/20 | Clean `_deps` DI seams, typed boundaries |
| Code Quality | 18/20 | Guarded, well-commented, consistent |
| Best Practices | 16/20 | Module-level mutable state; repeated per-stage work on the v2 path |
| **Total** | **86** | **A-** |

---

## Method note: what is actually reachable

`context.v2.enabled` defaults to **`false`** (`src/config/schemas-context.ts:162`), gated at
`stage-assembler.ts:181`. PERF-1, PERF-2, PERF-4, PERF-5, PERF-8, PERF-11, PERF-12 and MEM-6 sit
behind it.

**But "default false" understates reachability.** This repo's own `.nax/config.json:199-206` sets
`context.v2.enabled: true`, so on every nax-on-nax dogfood run these findings are fully live. Treat
them as real for opted-in operators, not dormant.

PERF-8 is **double-gated**: it additionally requires `context.featureEngine.enabled`, which also
defaults false (`schemas-context.ts:34`). PERF-7 requires `agent.usageAudit.enabled`, default false
(`runtime/index.ts:345`). PERF-3, MEM-1 and the SEC findings are always-on.

*Correction:* the original P0 row described PERF-1 and PERF-2 as "not behind a flag," contradicting
this note. They are flag-gated. Resolved below.

---

## The trust boundary (context for all SEC findings)

`docs/architecture/agent-adapters.md:317-345`, §17, decision D-1 (2026-08-14):

> **nax trusts the repository it is pointed at.** An untrusted repo is **NOT** in nax's threat model.
> [...] **Explicitly NOT being built:** Sandboxing, out-of-process plugin isolation, env allowlists,
> prompt-injection delimiter escaping, first-run per-repo trust prompts. **Do not raise these again
> in reviews.**

The real trust boundary is **the agent (LLM), not the repo**. That is why `nax-owned-writes.ts`
exists. A security finding is in scope when it concerns what a *prompt-injected agent* can reach,
not what a hostile repo author can configure.

*Housekeeping:* §17 cites `docs/reviews/2026-08-14-deep-code-review.md`, which does not exist in the
tree. The ruling is authoritative regardless, but the citation is dangling.

---

## Findings

### MEDIUM

---

#### SEC-5: `.queue.txt` run-control file is writable by agent tools

**Severity:** MEDIUM | **Category:** Security | **Verdict: CONFIRMED - strongest finding in the set**

**Location:** `src/tools/nax-owned-writes.ts:34,57,72-91`; `src/execution/queue-handler.ts:100-102`;
`src/pipeline/stages/queue-check.ts:121-141`

This is the one finding squarely inside the real trust boundary: it concerns agent authority, not
repo authority.

```ts
// nax-owned-writes.ts:57 - refusal set guards only config/PRD writers
export const NAX_OWNED_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete", "GitCommit"]);
```
```ts
// queue-check.ts:121-141 - commands can PAUSE and ABORT (mark pending stories skipped)
if (cmd.type === "ABORT") { for (const s of ctx.prd.userStories) { if (s.status === "pending") markStorySkipped(ctx.prd, s.id); } ... }
```

**Reachability traced end-to-end** (the original asserted this; it is now proven):
- `policy.ts:97-101` `resolveWithin` refuses only `.git/` and `isNaxConfigFile`; `policy.ts:308`
  adds only the feature-PRD refusal.
- Default profile is `unrestricted` (`schemas-execution.ts:256`), documented at `policy.ts:73-74`
  as an unconditional `"*"` grant that skips glob matching entirely.
- `grep -rn "denyPaths" src/` finds **no default entries**; `deny-paths.ts:72` returns false on an
  empty list, and `delete.ts:102` is its only consumer (Delete, not Write).
- `grep -rn "queue.txt" src/tools/` returns **zero** occurrences. Nothing guards it.
- `queue-check.ts:100` reads `ctx.workdir`, the story's own root, which in a non-worktree run is
  exactly the agent's root.

So `Write(".queue.txt", "ABORT")` reaches `queue-check.ts:130-141` and marks every pending story
skipped, persisting the PRD. Same defect class the `nax-owned-writes.ts:20-31` comment exists to close.

**Fix:** add `.queue.txt` and `.queue.txt.*` to the nax-owned write refusal, plus a default
`denyPaths` entry.

---

#### SEC-3: Redaction key list omits `authorization`, `cookie`, `session`, `credential`

**Severity:** MEDIUM | **Category:** Security | **Verdict: CONFIRMED (proven empirically)**

**Location:** `src/logger/redact.ts:18-19`, value patterns `:26-84`

```ts
const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN(?!s\b)|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK|(?:\w+)?_URL|\w+_URI|\w+_DSN|CONNECTION\s*STRING)/i;
```

Tested literally against the real regex: `authorization → false`, `Authorization → false`,
`cookie → false`, `Set-Cookie → false`, `session → false`, `credential → false`, `passwd → false`.
Round-tripped through the real `redactEntry`:

```
in : message "Cookie: sessionid=abc123def456; Set-Cookie: s=zzz", data {authorization:…, cookie:"sid=xyz"}
out: unchanged
```

Value patterns do cover `Bearer`/`Basic`/JWT/PEM/`x-api-key`, but there is no `Cookie:` /
`Set-Cookie:` shape. Unredacted values persist to `~/.nax/<project>/prompt-audit/*.jsonl`.

**Fix:** add `AUTH(?:ORIZATION)?|COOKIE|SET-COOKIE|SESSION|CREDENTIAL|PASSWD` to the key pattern,
plus a `Cookie:`/`Set-Cookie:` value regex.

---

#### SEC-2: Webhook reporter URL (a bearer credential) is logged in cleartext

**Severity:** LOW-MEDIUM (was MEDIUM) | **Category:** Security | **Verdict: CONFIRMED (proven empirically)**

**Location:** `src/plugins/builtin/reporter-shared/post-json.ts:32,37`; `src/logger/redact.ts:18-19`

Ran the real `redactEntry`:
```
in : {url:"https://hooks.slack.com/services/T000/B000/abcdEFGH1234ijklMNOP5678", status:500}
out: {url:"https://hooks.slack.com/services/T000/B000/abcdEFGH1234ijklMNOP5678", status:500}
```
`SECRET_KEY_PATTERN.test("url") === false` - `(?:\w+)?_URL` requires the underscore, so `webhookUrl`
matches but bare `url` does not. For Slack/Discord the URL path *is* the secret; it persists to the
JSONL run log via `logger.ts:143`.

**Downgraded because:** it fires only on non-2xx/throw, the URL is user-supplied config (a
self-owned credential), and `webhook-reporter` is opt-in.

**Fix:** log `new URL(url).origin` plus a hash, or extend the redactor with webhook path shapes and
a bare `url` key.

---

#### MEM-2 (revised): native session maps are unreachable from run teardown

**Severity:** MEDIUM | **Category:** Memory | **Verdict: CONFIRMED, but via a different and stronger mechanism than originally argued**

**Location:** `src/agents/native/session/session.ts:28,35,43-49,122-139,168-182`;
`src/execution/session-manager-runtime.ts:19`; `src/agents/native/adapter.ts:458-463`

The original argued "any throw between open and close leaks." That is the **weak** form and is
mostly wrong: both production open sites already close in a `finally`
(`build-hop-callback.ts:575-597`, `session-run-hop.ts:214-226`).

The real defect is a teardown gap:

```ts
// execution/session-manager-runtime.ts:19 - optional method, silently skipped
await adapter.closePhysicalSession?.(descriptor.handle, descriptor.workdir, options);
```

`closePhysicalSession` is implemented **only on the ACP adapter** (`acp/adapter.ts:134`). The native
adapter has no such method - `grep -c closePhysicalSession src/agents/native/adapter.ts` returns 0;
it exposes only `closeSession` (`:458-463`). So every native session left open by design
(`keepOpen`, set by `implement.ts:64`, `write-test.ts:86`, `call.ts:230`; or `stale-retry`) is swept
out of `SessionManager._sessions` by `closeStory` **without `closeNativeSession` ever running**.
Only `iteration-runner.ts:232` and the hop's own `finally` clear the maps.

Second real gap: `closeNativeSession` performs `await retainTranscript(...)` /
`pruneRetainedTranscripts` at `:168-169` **before** the nine `delete` calls at `:174-182`. A throw in
that I/O skips all of them.

Also note the original quoted the file's docstring but cut before its own rebuttal: *"Harmless in
practice (it is a small in-memory map keyed by session name, not a handle to a real resource)."*
Retention is small (strings, a `SpinBreaker`, and the `nativeSessionStreamHooks` closure, which does
pin `agentStreamEvents` + `runId`). There is **no watch mode** in `src/cli`, so cross-run exposure is
in-process only (test suites, embedded TUI).

**Fix:** implement `closePhysicalSession` on the native adapter, and move the deletes in
`closeNativeSession` ahead of (or into a `finally` around) the transcript I/O.

---

### LOW

---

#### PERF-1: `ProviderWeightsCache` is invalidated on every stage assembly, so it never hits

**Severity:** LOW (was HIGH) | **Category:** Performance | **Verdict: CONFIRMED, severity corrected**

**Location:** `src/context/engine/stage-assembler.ts:302-306`

```ts
const bundle = await orchestrator.assemble(request);
if (ctx.projectDir && ctx.prd.feature) {
  await writeContextManifest(ctx.projectDir, ctx.prd.feature, ctx.story.id, stage, bundle.manifest);
  ctx.providerWeightsCache?.invalidate(ctx.prd.feature);   // invalidates what it just used
}
```

Cache-key identity confirmed: `loadOrGet` keys on `request.featureId ?? "_unattached"` (`:283`),
`request.featureId = ctx.prd.feature` (`:219`), `invalidate` keys on `ctx.prd.feature` (`:305`).
Same key, so the self-defeat is total - hit rate is effectively zero.

The "no correctness benefit" argument verifies: `deriveProviderWeights` reads only
`manifest.chunkEffectiveness` (`provider-weights.ts:85`), written solely by
`annotateManifestEffectiveness` (`effectiveness.ts:474`, called post-story from
`completion.ts:102`). **And `completion.ts` never calls `invalidate()`** - the only two call sites
are `stage-assembler.ts:305` and `context.ts:266`, both in the useless position. The cache is
invalidated where it is pointless and not where it would matter.

*Correction to the original:* `loadOrGet` is populated at `:285-286`, not `:290-294` (that is the
non-cached `loadFeatureManifests` fallback).

**Downgraded because:** v2-gated, and the cost is manifest JSON reads, not model tokens.

**Fix:** invalidate in `annotateManifestEffectiveness`, not after `writeContextManifest`.

---

#### PERF-3: Per-story config re-read, re-merge, and full Zod re-validation

**Severity:** LOW (was HIGH) | **Category:** Performance | **Verdict: CONFIRMED, reach much narrower than claimed**

**Location:** `src/config/loader.ts:419-432,443-446,581`; `src/execution/iteration-runner.ts:130-135`

`_rootConfigCache` (`loader.ts:368`, LRU cap 20 at `:367`) covers only the root load. Everything
after `:443` - read, compat shims, merge, `stripRemovedNoOpKeys`, env resolution, profile chain,
four reject guards, and the full `NaxConfigSchema.safeParse` (`:581`) - re-runs per story with no
result cache. Confirmed: this is the one always-on finding among the original HIGHs.

**Two mitigations the original missed, which together gut the impact claim:**
1. **Non-monorepo and root stories never enter the uncached path.** `iteration-runner.ts:129` uses
   `storyPackageDir(story)`; undefined falls straight through to `ctx.config`. The nax#2067 comment
   at `:126-128` documents the `"."` root-story exclusion explicitly.
2. **When no per-package config file exists, the function returns at `loader.ts:454`** before any
   shim, merge, env-resolve or Zod parse. The "dominant cost, a full Zod parse N times" therefore
   only materialises for packages that actually ship `.nax/mono/<pkg>/config.json`.

So this fires only for a monorepo package that has its own override file. The residual in the
common case is one `loadJsonFileStrict` plus the per-story info log (`:448-453`).

**Fix:** cache the merged `NaxConfig` by `(resolvedRootConfigPath, packageDir, profileKey)`.

---

#### MEM-1 / PERF-9: `CostAggregator` retains every dispatch event and rebuilds O(n) aggregates

**Severity:** LOW (was HIGH) | **Category:** Memory + Performance | **Verdict: PARTIALLY-WRONG - retention real, stated mechanism backwards**

**Location:** `src/runtime/cost-aggregator.ts:400-404,412-418,430-435,467-511,583-587`

The O(n) accessor claim holds and is **worse** than originally written: `byCall()`/`byScope()` each
build two full spread copies per call, and `openScope().snapshot()` (`:522-523`) does two full-array
`filter`s per scope read. Consumers the original missed: `execution/cost-guard.ts:27`,
`execution/run-cost-reconcile.ts:25`, `run-phase.ts:373`.

**The retention mechanism was described backwards.** The original said `_events` is "only spliced in
`drain()` (run end)", implying release. `drain()` actually splices, writes the JSONL, then
**deliberately re-pushes every committed event back**:

```ts
// cost-aggregator.ts:578-587
// Post-drain, committed is now the full persisted set. Replace _events
// so snapshot()/byX() readers see exactly what was flushed to disk -
// otherwise a late arrival that raced the final write would be counted
// twice [...] or a settled in-memory total would permanently diverge
// from the audit trail.
this._events.length = 0;
this._events.push(...committedEvents);
```

**The original's proposed fix - "flush committed events to disk per story" - would break this
documented invariant.** Do not apply it.

**Downgraded because:** `CostEvent` is a flat scalar record, one row per *agent dispatch*, so
hundreds to low thousands per run - not per token or per tool call. Hundreds of KB retained, and
O(n²) scalar reduces over n≈10³, is hygiene, not a run-threatening cost.

**Fix:** add single-key accessors (`spendForStory(id)`) that scan once, and maintain incremental
aggregates. Leave `drain()`'s re-push alone.

---

#### PERF-2: `PriorRunFailureProvider` re-reads and re-parses `metrics.json` per rectify stage

**Severity:** LOW (was HIGH) | **Category:** Performance | **Verdict: PARTIALLY-WRONG - magnitude inflated**

**Location:** `src/context/engine/providers/prior-run-failure.ts:175,179`; `src/metrics/tracker.ts:44,594-598`

No memoization exists (`loadRunMetrics` is a bare `loadJsonFile` per call), and the immutability
premise holds (the only production write is `saveRunMetrics` at `run-completion.ts:458`, run end).

**"Multi-MB read + parse" is inflated.** The file is capped at `MAX_RETAINED_RUNS = 200`, and the
provider's own docstring at `prior-run-failure.ts:67-68` says so: *"already capped to
MAX_RETAINED_RUNS (200) by `saveRunMetrics()`, so this is bounded."* The original cited the cap and
then argued past it.

**Fix:** memoize `loadRunMetrics` per `outputDir` for the run lifetime.

---

#### PERF-4: `code-neighbor` sequential reads and full-content substring scans

**Severity:** LOW (was HIGH) | **Category:** Performance | **Verdict: PARTIALLY-WRONG - 10x arithmetic error**

**Location:** `src/context/engine/providers/code-neighbor.ts:280-302,425,448-456`

**The headline number is wrong by 10x.** The original claimed "up to 5,000 sequential `readCached`
calls [...] **per touched file**." The reverse loop is bounded by the scanned-dir size, so it is
**at most 500 per touched file**; 5,000 is the total across all 10.

**Two mitigations missed:**
1. `MAX_NEIGHBORS_PER_FILE = 8` (`:56`) with `break outer` (`:283`) - the loop short-circuits at 8
   reverse dependents. The 500-candidate worst case needs a file with almost no dependents.
2. The scan is already hoisted: `scannedDirs` is built once per fetch (`:448`) with a shared
   `contentCacheState` (`:449`), and is a single root since nax#2074. The glob is not repeated.

*One aggravating factor the original missed:* `readCached` (`code-neighbor-cache.ts:78-125`) stats
before every uncached read, and stops retaining content past
`MAX_NEIGHBOR_CACHE_TOTAL_BYTES = 50MB` (`:113-116`), so beyond that later files **do** re-hit disk -
contradicting the original's flat "the content cache avoids disk re-reads."

*Snippet fidelity:* the original's "exact code as proof" silently dropped `:281`
(`if (truncated) anyTruncated = true;`) and the nax#2074 comment at `:285-287`.

**Fix:** build a basename→candidates index once per fetch; parallelize reads with a bounded pool.

---

#### PERF-5: Session-scratch disk discovery on every stage assembly

**Severity:** LOW-MEDIUM | **Category:** Performance | **Verdict: CONFIRMED**

**Location:** `src/context/engine/stage-assembler.ts:88-146,147-163`; callers
`src/pipeline/stages/execution.ts:130` **and `src/pipeline/stages/prompt.ts:81`**

The critical claim holds: both production callers pass only `scopeFiles`, never
`storyScratchDirs`, so `getStoryScratchDirs` always falls through to disk discovery (readdir at
`:112` plus one sequential descriptor read per entry at `:121-124`).

**No memoization.** `assembleForStage` *writes* `ctx.storyScratchDirs` at `:201` but
`getStoryScratchDirs` never reads it back; the write is consumed only downstream by the
`query_scratch` pull tool.

**`DISK_DISCOVERY_TTL_MS` does not gut this** (worth stating, since it looks like a cache): it is a
descriptor-*age filter* compared against `lastActivityAt` (`:119`), not a result cache.

*Correction:* the original's Location line missed `prompt.ts:81`, which for non-TDD strategies is
the *first* assembly site.

*Caveat on the fix:* `execution.ts:123-128` carries an explicit "Intentionally NOT memoized here"
comment. It concerns the *bundle*, not the dir list, so threading `ctx.storyScratchDirs` is probably
safe - but engage with that comment before changing it.

---

#### MEM-7: per-run detection memos cleared only on normal run completion

**Severity:** LOW | **Category:** Memory | **Verdict: CONFIRMED, under-scoped**

**Location:** `src/test-runners/detect/workspace.ts:165-170,205-209`;
`src/execution/lifecycle/run-completion.ts:406-414`

The structural claim holds: `runCompletionPhase` is called **inside the `try`**
(`runner.ts:312`), while `cleanupRun` and `runtime.close()` are the `finally`
(`runner.ts:364,395,419`). Any throw out of setup or execution skips the clear, and
`run-cleanup.ts` does not clear it.

**It is four memos, not one.** The same block also clears `clearLanguageCache()`,
`clearGitRootCache()` and `_resetCanonicalRulesCache()` (`:407-414`), all with identical exposure.
Raise this against the block, not `_workspaceCache` alone. The comment at `:410-414` already names
the exact scenario.

**Fix:** move the block into `cleanupRun`'s teardown path. Cheap and correct.

---

#### MEM-5: MCP per-call deadline `setTimeout` is never cleared

**Severity:** LOW | **Category:** Memory | **Verdict: CONFIRMED**

**Location:** `src/mcp/pool.ts:161-172`

`.unref?.()` returns the `Timeout` and it is immediately discarded inside the executor arrow, so no
`clearTimeout` is possible. Every call, including instant returns, arms a timer for the full
`timeoutMs`. The reasoning about `.unref()` (event-loop hold is not allocation) is correct.

*Scoping the original omitted:* `timeoutMs` defaults to 60s (`schemas-mcp.ts:25,53`) and
`mcp.servers` defaults to `{}` (`:66`), so the path is dead unless a server is configured. Steady
state is (call rate × 60s) small closures - bounded, not monotonic.

**Fix:** capture the id and `clearTimeout` in a `finally` around the race.

---

#### MEM-12: `StoryHopBudget._byStory` is never pruned; `clear()` has no production call site

**Severity:** LOW | **Category:** Memory | **Verdict: CONFIRMED**

**Location:** `src/agents/hop-budget.ts:79-102`; `src/agents/manager.ts:151`

Grep claim verified: `reset()` appears only as the declaration (`manager.ts:151`), the interface
member (`manager-types.ts:215`) and a doc comment (`hop-budget.ts:99`). **No production call site**;
only `resetTransientUnavailable()` ships. The reuse vector is real (`runtime/index.ts:278,410-412`
accept a pre-built manager).

*Not mentioned originally:* `reset()` also strands `_cooldowns` and `_prunedFallback` on a reused
manager.

**Fix:** prune per story at `closeStory`, or call `reset()` at run teardown.

---

#### MEM-13: `CostAggregator._openScopes` released only by the caller's `close()`

**Severity:** LOW | **Category:** Memory | **Verdict: CONFIRMED**

**Location:** `src/runtime/cost-aggregator.ts:405,514-532,535-539`

Any scope handle dropped without `close()` leaves a string id for the run. `drain()` already warns
(`:535-539`). Seven production `openScope()` call sites (`debate/runner.ts:81,82,118-121`;
`story-orchestrator/run-phase.ts:247`) - each worth confirming has `close()` in a `finally`.
Effectively a diagnostics item; the real memory is `_events`.

---

#### PERF-11: `manifest-store` does double I/O (stat + read) and sequential per-file reads

**Severity:** LOW | **Category:** Performance | **Verdict: CONFIRMED**

**Location:** `src/context/engine/manifest-store.ts:190,195,197,221-223,270-272`

`listManifestFiles` (`:43-53`) is a `Bun.Glob(...).scan()`, so the `fileExists` probe is redundant
modulo TOCTOU.

*Caveat:* both are injectable `_manifestStoreDeps`, and several tests stub `listManifestFiles` with
synthetic names plus `fileExists = async () => true`
(`test/unit/metrics/tracker-context-metrics.test.ts:77,81`). Dropping the probe is safe but touches
those fixtures.

---

#### PERF-12: `globToRegex` compiled per pattern per file per rule

**Severity:** LOW | **Category:** Performance | **Verdict: CONFIRMED**

**Location:** `src/context/engine/providers/static-rules.ts:137-145`; `src/context/engine/scope-path-match.ts:50-88`

`globToRegex` has no memoization (`return new RegExp(...)` at `:87`) and is compiled inside
`files.some(...)` inside `appliesTo.some(...)`. `static-rules.ts:144` is the only un-hoisted site -
`path-filters.ts:141-142` (`compileMatcher`) and `scope-path-match.ts:152` both hoist correctly.

*Snippet defect in the original:* it splices `const normalizedPattern` onto `return files.some(`,
eliding a 3-line comment (`:140-142`) with no ellipsis.

**Fix:** module-level `Map` memo keyed by normalized pattern. Clean 3-line change.

---

#### SEC-9: `resolveEnvVars` copies `__proto__` as an own key

**Severity:** LOW | **Category:** Security (defense-in-depth) | **Verdict: CONFIRMED (proven in bun)**

**Location:** `src/config/dotenv.ts:116-122`

```
JSON.parse('{"__proto__":{"polluted":1},"a":2}') -> own keys ["__proto__","a"], hasOwn true
after the loop -> result keys ["a"]   (the key vanishes; setter invoked)
Object.getPrototypeOf(result) !== Object.prototype -> true
({}).polluted -> undefined     (global prototype NOT polluted)
result.polluted -> 1           (object-local)
```

The original was correctly careful about scope. `merger.ts:21` `DANGEROUS_MERGE_KEYS` is present and
confirmed **not** to cover this path. Practical effect: a config object silently gains phantom
inherited keys and loses the literal key.

**Fix:** skip `DANGEROUS_MERGE_KEYS` in `resolveEnvVars`, or build with `Object.create(null)`.

---

#### SEC-6: `installServePortZeroCompat` monkeypatches global `fetch` and `Bun.serve`

**Severity:** LOW | **Category:** Robustness (not Security) | **Verdict: CONFIRMED, over-categorised**

**Location:** `src/interaction/plugins/webhook-serve-compat.ts:196,222,225`

Accurate, but this is not a security boundary: the patch only intercepts `localhost`/`127.0.0.1`
plus `CALLBACK_PATH_PREFIX` plus a port in its own `inMemoryServers` map (`:210-215`). "Shadow an
unrelated local service" requires that service to own a port nax registered.

---

#### MEM-8 / MEM-9 (merged): interaction-plugin send/receive asymmetry

**Severity:** LOW | **Category:** Memory | **Verdict: MEM-8 PARTIALLY-WRONG; MEM-9 WITHDRAWN**

These were filed as two findings. They are one, and both overstated it.

**MEM-9 is withdrawn.** Its headline - "`pendingMessages` cleared only by `destroy()`" - is false.
The original's own Location list cites the disproof:

```ts
// telegram.ts:326-334
private resolveReceiverWithResponse(requestId: string, response: InteractionResponse): void {
  ...
  this.pendingMessages.delete(requestId);      // per-request release
  this.bufferedResponses.delete(requestId);
```
Reached from `completeReceiver`, `expireReceiver`/`resolveReceiver` (`:317-319`), `cancel()`
(`:253-257`) and `destroy()` (`:139`). The "no cap on `bufferedResponses`" claim is also misleading:
`dispatchUpdates` (`:277-284`) writes at most one entry per `pendingMessages` key and breaks, so
`bufferedResponses.size <= pendingMessages.size`. A `MAX_PENDING_RESPONSES` cap would be redundant.

**MEM-8 is narrowed.** The webhook id is released on **five** paths, not one: `webhook.ts:286`
(send failure), `:322` (early pickup), `:342` (receive timeout), `:355` (callback delivery),
`:361-365` (`cancel()`).

The genuine residual, common to both plugins: `send()` resolves, then neither `receive()` nor
`cancel()` is reached (abort between the two `await`s in `chain.ts:70`/`:100`).

**The more interesting finding underneath both:** `InteractionChain.cancel()`
(`src/interaction/chain.ts:146-150`) has **zero production callers**. The documented escape hatch is
dead code, which is why a `finally` around the send→receive handshake is the only workable fix.

---

#### MEM-3: CLI plugin `pendingRequests` leaks when `receive()` throws

**Severity:** LOW | **Category:** Memory | **Verdict: PARTIALLY-WRONG**

**Location:** `src/interaction/plugins/cli.ts:34,87-103`

The delete at `:101` is indeed only on success. But three sub-claims fail:
1. **"always in non-TTY/CI" is false.** `interaction/init.ts:67-70` returns `null` for
   headless + `plugin: "cli"` - no chain, no plugin, no map. The residual case is narrow:
   non-headless with piped stdin.
2. **"the map is never bounded" is false.** It is an instance field on a plugin owned by a per-run
   `InteractionChain`, destroyed in the run `finally` (`run-cleanup.ts:253-260`).
3. The `promptUser` timeout path **resolves** rather than throws (`:119-128`, `clearTimeout` in a
   `finally` at `:144-146`), so timeouts do reach the delete. Only the `!this.rl` throw and a genuine
   readline error leak.

Since only one plugin is ever registered (`init.ts:83`), the non-TTY case makes `chain.receive`
exhaust its cascade and throw `INTERACTION_ERROR`. **The broken interaction is the real defect; the
map entry is a side effect.**

---

#### MEM-4: `SessionManager` registry entries survive `closeSession`

**Severity:** LOW | **Category:** Memory | **Verdict: PARTIALLY-WRONG - facts right, impact not real**

**Location:** `src/session/manager.ts:63-66,364-365,531-555,675-678`

Every quoted snippet matches. The impact claim does not survive:

- **"If a `SessionManager` is reused across `createRuntime()` calls"** - no production caller does
  this. The only injector is `run-setup.ts:254-256`, and the manager it passes is **freshly
  constructed one line up at `:243`**. The other two sites (`runtime/index.ts:383`,
  `runner-execution.ts:194`) are per-run. The manager is per-run by construction, so `close()`
  clearing nothing costs nothing; the whole object is garbage after the run.
- `sweepOrphans()` (`manager.ts:671-673`, called at `run-setup.ts:419`) is the designed reclaim path,
  unmentioned originally.
- `_liveHandles` is deleted in both `closeSession:534` and `closeStory:365`, so "can pin adapter
  handles" is wrong on the normal paths.

Real residue: one COMPLETED descriptor per storyless session retained for the run, intentionally,
for audit. **The proposed fix (delete terminal descriptors in `closeSession`) would break
`getForStory`, the orphan sweep, and audit consumers.**

---

#### MEM-6: `floorOverageOccurrences` is module-level and never cleared

**Severity:** INFO (was MEDIUM) | **Category:** Correctness (not Memory) | **Verdict: PARTIALLY-WRONG**

**Location:** `src/context/engine/orchestrator.ts:106,482-484`

`run-cleanup.ts` genuinely does not reset it. But **this is not a memory defect**: the value is one
small integer per `storyId|stage`, bounded by (stories × stages) per run. It is an INFO-grade
correctness nit about a `logger.debug` field, not a MEDIUM memory finding.

Doubly gated: v2-only, and only when `manifest.usedTokens > manifest.totalBudgetTokens`
(`:470`). The one true residue - a second in-process run reusing `US-001` sees an inflated ordinal -
is cosmetic and in practice only reachable from tests.

---

#### PERF-8: `resolveFeatureId` re-reads the active-feature PRD on the fast path

**Severity:** LOW (was MEDIUM) | **Category:** Performance | **Verdict: CONFIRMED, blast radius much smaller**

**Location:** `src/context/feature-resolver/index.ts:120-124,154-157`

No caching on the hint path: `tryResolveFromActiveFeature` runs first and returns on success, so the
`_index` map (`:25`) and its build-once machinery (`:160-176`) are never reached. The docstring irony
at `:145-147` is real.

**Double-gated, and the original named only one gate.** `FeatureContextProvider.getContext` returns
null at `providers/feature-context/index.ts:63` **before** calling `resolveFeatureId` unless
`context.featureEngine.enabled` is true - `.optional()`, default false
(`schemas-context.ts:34`). So this needs `context.v2.enabled` **and**
`context.featureEngine.enabled`. The pure-v1 site (`pipeline/stages/context.ts:414-415`) passes no
`activeFeature` and takes the O(1) index path.

---

#### PERF-7: `usage-auditor` issues one `appendFileSync` per `usage_update` event

**Severity:** LOW (was MEDIUM) | **Category:** Performance | **Verdict: PARTIALLY-WRONG - do not apply the proposed fix**

**Location:** `src/runtime/usage-auditor.ts:60-67,99-101,125-134`

Code claims accurate. Three problems with the finding:

1. **Disabled by default, never stated.** `runtime/index.ts:345`:
   `const usageEnabled = config.agent?.usageAudit?.enabled ?? false;`. When false,
   `createNoOpUsageAuditor()` is installed (`:359`) and `record()` is a no-op. **Zero syscalls on a
   default run.**
2. **The "~161 events" figure is circular.** It comes from the audited file's own header comment
   (`usage-auditor.ts:4`), which the original cites while omitting that the same sentence calls the
   volume *"negligible as its own file."*
3. **The proposed fix regresses a known bug.** `prompt-auditor.ts:1-23` (which `usage-auditor.ts:9-11`
   explicitly defers to) records a 2026-04-29 dogfood incident where async `appendFile` **silently
   dropped JSONL bytes** under event-loop pressure. "Mirror the logger's batching" means moving to
   `appendFile` (`logger.ts:234`) - the exact API documented as unreliable here. The original
   contrasts the two without noticing they use different write APIs deliberately.

---

#### PERF-10: Semantic and adversarial review re-spawn git for the same ref/stat

**Severity:** INFO (was LOW) | **Category:** Performance | **Verdict: PARTIALLY-WRONG - the proposed fix is a regression**

**Location:** `src/review/prepare-inputs.ts:113,125,145,170,185`

Duplication is real: neither `collectDiffStat` (`diff-utils.ts:146-161`) nor `resolveEffectiveRef`
(`:191-213`) memoizes.

**But "resolve once per story and share" reintroduces a fixed bug.** The two prepares are not called
together on the hot path. At plan-build time they are back-to-back (`plan-inputs.ts:340,397`), but
that diff is *deliberately stale* ("test-writer/implementer haven't run yet",
`plan-inputs.ts:333-339`). The values that matter are re-collected **per dispatch**, independently,
in `refreshReviewInputForDispatch` (`run-phase.ts:121,143`) precisely because semantic and
adversarial dispatch at different times and the diff moves between them. Caching per story
reintroduces US-002 (review sees an empty diff and skips every AC).

**Corrected scope:** only the plan-build pair is safely shareable - 2 redundant spawns per story,
once.

---

#### PERF-13: `resolveCommand` reads `package.json` per review check

**Severity:** INFO (was LOW) | **Category:** Performance | **Verdict: PARTIALLY-WRONG**

**Location:** `src/review/runner/index.ts:69-77,145-152`

**The reach claim is false.** `loadPackageJson` is step 5 of 6 and guarded twice:

```ts
// review/runner/index.ts:145-152
// 5. Check package.json - only for built-in checks (typecheck/lint/test), not build.
if (check !== "build") {
  const packageJson = await loadPackageJson(workdir);
```

It is reached only after `executionConfig.{lint,typecheck}Command`, `config.commands[check]`,
`qualityCommands[check]` and the language fallback all miss (`:113-144`). "Invocations for
lint/typecheck/build/test each call it" is false for `build` and false for any configured check -
that is, false for a normally-configured repo.

---

#### PERF-16: Logger re-redacts every payload string per call

**Severity:** LOW | **Category:** Performance | **Verdict: PARTIALLY-WRONG - half the finding is false**

**Location:** `src/logger/logger.ts:143,217`; `src/logger/redact.ts:88-95`

**Redaction half: CONFIRMED.** `logger.ts:143` runs `redactEntry(rawEntry)` unconditionally, before
sink dispatch (`:149`) and before the level/file gate (`:151-152`). A level-dropped entry with no
file still pays the full 16-pattern scan.

**Promise-link half: WRONG.** `writeToFile` returns at `:217` (`if (!this.filePath) return;`)
*before* touching `writeQueueTail`. **No promise is chained when no log file is configured** - the
exact case the original highlighted. When a file is configured, the chain is already coalesced:
`:221-237` drains the whole `pendingLines` buffer in one batched `appendFile` per burst, with the
rationale documented at `:206-215`. **The original's proposed "single scheduled flush task" is
already implemented.**

*On the surviving half:* any short-circuit must check the sink registry, not just the level.
`logger.ts:139-148` documents redact-before-all-sinks as a deliberate security invariant after
secrets previously reached the terminal via `message`.

---

#### PERF-15: `applyTokenGuard` materializes a join just to measure length

**Severity:** INFO (was LOW) | **Category:** Performance | **Verdict: CONFIRMED, negligible**

**Location:** `src/prompts/builders/prior-iterations-builder.ts:159-166`

Accurate. `MAX_BLOCK_CHARS = 6000` (`:24`); called once per rectifier prompt build (`:70`). Cost is
one transient string of at most tens of KB, immediately GC'd, on a path whose next step is an LLM
call. The `sum(len)+2` fix is correct and trivial, but this is cleanliness, not performance.

---

#### SEC-7 / SEC-8: filename and path containment (defense-in-depth)

**Severity:** LOW / INFO | **Verdict: CONFIRMED as hypothetical**

**SEC-7** (`prompt-auditor.ts:135-143,305`): mitigation is **stronger** than originally stated. The
only model-authored component, `storyId`, is hard-validated at `prd/validate.ts:24-49` against
`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`, rejecting `..` and making `/` impossible. Not exploitable by
any current path.

**SEC-8** (`verification/runners.ts:17-27`): impact is **weaker** than implied. The schema guard
(`prd/schema-story.ts:392-416`) rejects leading `/` and any `..`, and `verifyAssets` only calls
`existsSync` and echoes the caller-supplied relative string back. It is a pure existence oracle with
no read. **INFO.**

Both are worth the one-line hardening (`resolveWithin`), neither is a defect today.

---

#### Correctness note: `memoizedLoadCanonicalRules` ignores its `options` argument

**Severity:** LOW | **Verdict: CONFIRMED but currently unreachable**

**Location:** `src/context/engine/providers/canonical-rules-cache.ts:13-27`

All real callers checked. The memo is imported in exactly one place (`static-rules.ts:31`, wired as
`_staticRulesDeps.loadCanonicalRules` at `:51`), with two call sites:

```
static-rules.ts:189:  await _staticRulesDeps.loadCanonicalRules(request.repoRoot);
static-rules.ts:240:  await _staticRulesDeps.loadCanonicalRules(request.packageDir);
```

**Neither passes `options`**, and the two keys are distinct strings, so the cache is correct today.
Every other `loadCanonicalRules` consumer (`cli/rules.ts:297`, `cli/rules-lint.ts:267`,
`precheck/checks-system.ts:126`) calls the unmemoized loader directly, also with no options.

`LoadCanonicalRulesOptions` is `{ budgetTokens?, enforce? }`, so a wrong-options hit would silently
apply the first caller's budget. The hazard is real but latent.

**Better fix than originally proposed:** drop the dead `options` parameter from the memo wrapper
entirely, or throw if passed.

---

### Withdrawn

---

#### SEC-4: Project config selects command-execution surfaces - WITHDRAWN

All seven citations are accurate. The finding is nonetheless out of scope: it assumes "a
cloned/untrusted repo's `.nax/config.json`", which §17 rules is **not** in nax's threat model. The
original **quotes the refutation in its own citation range** and passes over it -
`verification/executor.ts:92-97` states `.nax/config.json` is *"a **trusted** file, equivalent in
trust to a Makefile or shell script."* §17 additionally lists SEC-4's exact proposed fix
("first-run per-repo trust prompts") under "Explicitly NOT being built. Do not raise these again in
reviews."

#### SEC-1: `stripEnvVars` can be emptied by a project config - DOWNGRADED TO INFO

Mechanics confirmed empirically. With a project `.nax/config.json` of
`{"quality":{"stripEnvVars":[]}}`, the empty array survives the merge (`merger.ts:5,28` - "Arrays:
replace, not merge"), no warning fires, and the sink copies `process.env` wholesale
(`quality/runner.ts:138-142`, the primary sink the original missed; it cited only
`argv-exec.ts:46-49`).

But §17's table names this exact behaviour as in-boundary: *"Override security-sensitive config |
project `.nax/config.json` (**warned, not blocked**)"*, and the proposed fix ("fail closed or
require confirmation") is explicitly ruled out by D-1. Re-file as a **documentation/warn-coverage
note**: the guard's blindness to the schema default narrows a warn-only affordance. Not a security
defect.

#### MEM-9: Telegram per-request release - WITHDRAWN

See MEM-8/MEM-9 merged entry. The release exists at `telegram.ts:331-332`.

#### MEM-10: `ReviewAuditor` maps never trimmed - DOWNGRADED TO INFO

`_dispatches` is keyed `auditKey(reviewer, storyId)` (`review-audit.ts:311`), so a dispatch with no
decision is **overwritten by the next dispatch for the same key**. The map is bounded by distinct
(reviewer × story) pairs - the same bound the original's own appendix calls "run-scoped maps bounded
by story count" and declares clean.

`_advisoryFindings` growth is **by design**: `getAdvisoryFindings()` (`:350-352`) is the run-summary
API. "Cap or stream" changes behaviour rather than fixing a leak, and expiring `_dispatches` on
`flush()` would drop late-arriving decisions' merged metadata.

#### MEM-11: `PromptAuditor._turnOrdinals` - WITHDRAWN (self-refuting)

The map is per-auditor, the auditor is per-run, and the original states its own mitigation
("bounded by sessions per run and reclaimed with the auditor"). The source comment at
`prompt-auditor.ts:218-224` documents the scoping deliberately. **The proposed fix is a
regression:** clearing on `flush()` would restart turn numbering mid-run and corrupt the ordinals.

---

## Proposed fixes that would cause regressions

Five of the original recommendations are actively harmful. Do not apply as written.

| Finding | Proposed fix | What it breaks |
|:---|:---|:---|
| MEM-1 | "flush committed events to disk per story" | `drain()`'s documented re-push invariant (`cost-aggregator.ts:578-587`); double-counts or diverges from the audit trail |
| MEM-11 | "clear on `flush()`" | Restarts turn numbering mid-run |
| PERF-10 | "resolve ref/stat once per story" | Reintroduces US-002: review sees a stale/empty diff and skips every AC |
| PERF-7 | "mirror the logger's batching" | Moves to async `appendFile`, the API documented (2026-04-29 incident) as silently dropping JSONL bytes |
| MEM-4 | "delete the descriptor in `closeSession`" | Breaks `getForStory`, the orphan sweep, and audit consumers |

---

## Revised Priority Fix Order

| Priority | IDs | Effort | Description |
|:---|:---|:---:|:---|
| **P0** | SEC-5 | S | Agent (or prompt-injected agent) can abort the run and skip stories. The only finding squarely inside the real trust boundary |
| **P1** | SEC-3, SEC-2 | S | Credentials persisted unredacted to the run log / prompt audit |
| **P1** | MEM-2 (native `closePhysicalSession` gap) | M | Run teardown cannot clear native session maps; `keepOpen` sessions always strand |
| **P2** | PERF-3, MEM-7, MEM-5 | S-M | Always-on repeated Zod validation (monorepo w/ overrides); memo block on the crash path; trivial `clearTimeout` |
| **P2** | PERF-1 | S | Cache with a zero hit rate on the v2 path; one-line move of the `invalidate` call |
| **P3** | MEM-12, MEM-13, PERF-11, PERF-12, SEC-9, canonical-rules key | S | Hardening and cleanliness, all small |
| **P4** | PERF-2, PERF-4, PERF-5, PERF-8, PERF-15, PERF-16, SEC-6, SEC-7, SEC-8, MEM-3, MEM-6, MEM-8, PERF-10, PERF-13 | S | Bounded, gated, or negligible; fix opportunistically |

**Fix first: SEC-5.** The original's "fix first: PERF-1 and MEM-1" was wrong on both counts - PERF-1
is flag-gated manifest I/O, and MEM-1's proposed fix breaks an invariant.

*The original P0 row described PERF-1/PERF-2 as "not behind a flag," contradicting its own method
note. Corrected: both are `context.v2`-gated. Only PERF-3 and MEM-1 among the original HIGHs are
always-on.*

---

## Appendix: Areas checked - no issues found

Re-verified by grep and by reading the cited ranges.

- **Command execution:** no `shell: true`, no `Bun.$`, no `child_process.exec` in `src/` - **verified,
  zero hits** (every `exec(` hit is `RegExp.prototype.exec`). The `sh -c` sites are real and
  `shellQuoteArg`-quoted: `quality/runner.ts:153`, `verification/executor.ts:114`,
  `tools/bash.ts:100`. Git helpers use argv arrays + `validateStoryId`.
- **`eval` / `new Function`:** **verified.** One grep hit, `acceptance/generator-helpers.ts:140`,
  inside a comment. No executable occurrence.
- **TLS:** no `rejectUnauthorized: false` / `NODE_TLS_REJECT_UNAUTHORIZED` - **verified, zero hits.**
- **File watches:** no `fs.watch` / `Bun.watch` - **verified, zero hits.**
- **Path traversal:** tools resolve through `ctx.resolvedPaths` + `resolveWithin`;
  `utils/realpath.ts` resolves symlinks; `glob.ts:137`, `sanitizeTestFileName`,
  `validateFeatureName`, `validateProfileName` present.
- **Prototype pollution:** `deepMergeConfig` guards dangerous keys (`config/merger.ts:21,46,167`).
  Note SEC-9: `resolveEnvVars` is a separate, unguarded path.
- **Webhook/Telegram auth:** HMAC with `timingSafeEqual`, two-bucket rate limit, byte-limited
  streaming body, chat-id gating; no shell.
- **Permission SSOT:** native tool path enforces compiled policy at `tools/runtime.ts:300-354`.
- **`NaxRuntime.close()`** (`runtime/index.ts:486-517`): **corrected - it unsubscribes seven bus
  subscribers, not five.** `offLogging` (:490), `offCost` (:491), `offAudit` (:492),
  `offReviewAudit` (:493), `offUsageAudit` (:494), `offAgentStreamLogging` (:495), `offWatchdog`
  (:496). Everything else in the original claim confirmed: `parentSignal` listener removal
  (:497-499), `mcpPool.close()` (:502), `Promise.allSettled` flush/drain of the four auditors
  (:506-511), idempotent via the `closed` guard (:487-488).
- **Other resource lifetimes (verified clean):** `idle-watchdog` clears tick/grace timers and
  `activeStates`; `killProcessTree` deletes `activeKillTimers` on grace/exit/cancel;
  `crash-signals.installSignalHandlers` removes exactly the six handlers it added; `logger.ts:428`
  exit handler guarded by `exitFlushRegistered`; TUI `App.tsx:86-90` and `useAgentStreamEvents`
  clean up correctly.
- **Dependencies:** `bun audit` clean (257 packages).

---

## Verification methodology

Five parallel sweeps, each re-reading every cited range in source rather than trusting the draft.
Claims were tested rather than inspected where testable: the `SECRET_KEY_PATTERN` regex was run
against each claimed key, `redactEntry` was round-tripped on real payloads, the `__proto__` behaviour
was executed in bun, and the `stripEnvVars` merge was reproduced with a real project config. Every
"no production caller" claim was re-grepped. Headline arithmetic (PERF-4) and file statistics were
recomputed.

**Outcome:** line numbers and quoted snippets were reliable (three snippets silently elided lines:
PERF-4, PERF-12, MEM-8). Causal claims and severities were not. Two findings withdrawn outright, two
more effectively withdrawn, seven downgraded, five proposed fixes identified as regressions, one
appendix count corrected, one dangling ID (`PERF-6`) removed, and one new and more serious mechanism
found beneath MEM-2.
