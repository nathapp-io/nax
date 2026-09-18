# Handover: fixes for the verified 2026-09-18 review

**Branch:** `fix/review-20260918-verified-findings` (cut from `main` @ `cf8c3baaa`, which equals `origin/main`)
**Source of truth:** `docs/20260918-review-nax.md` (revised, post-verification)
**Scope ruled:** all 14 actionable items (P0 through P3). Rulings below are decided - do not re-litigate them.

Every finding here survived a second verification pass against source. The review doc's
original severities and several of its proposed fixes did not survive, so **follow the rulings in
this document, not the fix suggestions in the review doc where the two differ.**

**Provenance of the citations below.** Every file:line referenced in a ruling was opened and read at
`cf8c3baaa`, including on a third pass over this document itself, which corrected three of its own
errors: the MEM-2 delegation did not typecheck, MEM-2 said "three maps" when there are nine, and
SEC-9 said to import a constant that is module-private. Treat the code facts as proven.

MEM-2's one open risk - whether `descriptor.handle` is populated for native sessions, without which
the fix would be inert - **has since been closed empirically**: a probe against the real
`SessionManager` and `NativeAgentAdapter` confirmed it is set, that it equals `handle.id`, and that
the leak reproduces after `closeStory`. The output is recorded in the MEM-2 section and doubles as
the failing-first test recipe. Nothing in this document is now unverified.

---

## Read this first: fixes that must NOT be applied

Five recommendations in the original review would cause regressions. They are listed here because
they look reasonable and a fresh reader will be tempted by them.

| Do NOT do | Why |
|:---|:---|
| Flush `CostAggregator` events to disk per story | Breaks `drain()`'s documented re-push invariant (`cost-aggregator.ts:578-587`); double-counts or diverges from the audit trail |
| Clear `PromptAuditor._turnOrdinals` on `flush()` | `flush()` runs mid-run; ordinals would restart and corrupt turn numbering |
| Share `resolveEffectiveRef`/`collectDiffStat` once per story | Reintroduces US-002: review sees a stale/empty diff and skips every AC. They are re-collected per dispatch on purpose (`run-phase.ts:121,143`) |
| Move `usage-auditor` to the logger's batched `appendFile` | `appendFile` is documented (2026-04-29 incident, `prompt-auditor.ts:1-23`) as silently dropping JSONL bytes under load. The `appendFileSync` choice is deliberate |
| Delete the descriptor in `SessionManager.closeSession` | Breaks `getForStory`, the orphan sweep, and audit consumers |

**Also out of scope (withdrawn findings - do not "fix" them):** SEC-4, SEC-1, MEM-9, MEM-10, MEM-11.
SEC-4 and SEC-1 rest on an untrusted-repo threat model that
`docs/architecture/agent-adapters.md:317-345` (§17, decision D-1) explicitly rejects, and D-1 says
"Do not raise these again in reviews." MEM-9's premise is factually false.

---

## Repo constraints that will bite you

1. **`src/config/loader.ts` is at 600/600 lines - exactly the file-size gate limit**
   (`scripts/check-file-sizes.ts:30`, `SRC_LIMIT = 600`). PERF-3 adds a cache there. **You cannot add
   a single line.** Extract the cache into a new leaf module (e.g.
   `src/config/package-config-cache.ts`) and import it. Do not raise the baseline.
   Other files near the limit: `static-rules.ts` 591, `cost-aggregator.ts` 592, `run-completion.ts` 571.
2. **`typecheck` is NOT in `check:all`.** Run `bunx tsc --noEmit` separately, every time. A
   declared-but-unwired field has passed the entire suite and every ratchet before.
3. **Use the repo's own commands:** `bun run test`, `bun run test:e2e`, `bun run lint`.
   **Never bare `bun test`** - it gives a confident false signal.
4. **`.claude/rules/` is a generated mirror** (`nax rules export --agent=claude`, enforced by
   pre-commit). Never hand-edit it.
5. Run `bun run check:all` plus `bunx tsc --noEmit` before claiming green.

---

## P0

### 1. SEC-5 - refuse agent writes to `.queue.txt`

**File:** `src/tools/nax-owned-writes.ts`

The run-control file is unguarded: `grep -rn "queue.txt" src/tools/` returns zero hits, the default
permission profile is `unrestricted` (an unconditional `"*"` grant, `policy.ts:73-74`), and there are
no default `denyPaths` entries anywhere. An agent calling `Write(".queue.txt", "ABORT")` reaches
`queue-check.ts:130-141`, which marks every pending story skipped and persists the PRD.

**Ruling: extend `naxOwnedWriteRefusal`, do not add a `denyPaths` default.** The refusal set is the
right seam - it is already the "nax's own run state" guard, it is tool-scoped (`Write`/`Edit`/
`Delete`/`GitCommit`), and it matches on the policy's own canonical `rel` spelling. A `denyPaths`
default would be a second, weaker mechanism with only one consumer (`delete.ts:102`, Delete only).

**Verified safe:** `.queue.txt` is written only by the user's own shell (`echo "PAUSE" > .queue.txt`,
documented at `queue-check.ts:74`) and by nax's own `writeQueueCommand` (`src/utils/queue-writer.ts`,
reached from `bin/nax.ts:579`). Neither goes through the agent tool layer, so nothing legitimate breaks.

Guard `.queue.txt` **and** `.queue.txt.processing` (`queue-handler.ts:102` uses the latter as the
atomic-rename target; leaving it writable leaves the same hole one rename downstream).

Follow the existing style: match on segments of the canonical `rel`, and return a refusal message
explaining why. Reuse the shape of the `isFeaturePrd` branch.

**Acceptance:** a unit test asserting `naxOwnedWriteRefusal("Write", ".queue.txt")` and
`("Edit", ".queue.txt.processing")` both return a refusal, that `Read`/`Grep` are unaffected, and
that an unrelated `.txt` at root is still writable.

---

## P1

### 2. SEC-3 - redaction key list

**File:** `src/logger/redact.ts:18-19`

Confirmed empirically: `authorization`, `cookie`, `Set-Cookie`, `session`, `credential`, `passwd` all
return `false` against `SECRET_KEY_PATTERN`, and a round-trip through the real `redactEntry` leaves
`Cookie: sessionid=...` and `{authorization: ...}` fully intact in the JSONL run log.

**Ruling: use this narrowed addition, NOT the one in the review doc.**

```
|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWD
```

**The review doc's proposed `AUTH(?:ORIZATION)?|COOKIE|SET-COOKIE|SESSION|CREDENTIAL|PASSWD` is a
regression and must not be used.** The pattern is an unanchored substring test, so:
- `SESSION` matches `sessionName`, `sessionId`, `sessionScratchDir`, `sessionManager`. There are 265
  `sessionName`/`sessionId` references and 54 `sessionScratchDir` references in `src/`. Redacting them
  destroys the primary correlation key in the run log, and directly violates the assumption stated at
  `prompt-auditor.ts:300-302` ("session names, story IDs, etc. are never secret-shaped"). Filenames
  derive from the raw entry so they survive, but the JSONL body would no longer correlate to them.
- `AUTH` matches `author`, `authorName`, `authors`.
- `SET-COOKIE` is redundant once `COOKIE` is present.

Session tokens are already covered: `sessionToken` matches via the existing `TOKEN` branch.

I verified the narrowed pattern in both directions. It matches `authorization`, `Authorization`,
`authorizationHeader`, `cookie`, `Cookie`, `Set-Cookie`, `setCookie`, `cookieJar`, `credential`,
`credentials`, `passwd`, and still matches `sessionToken`/`apiKey`/`GH_TOKEN`. It does **not** match
`sessionName`, `sessionId`, `session`, `sessionScratchDir`, `sessionManager`, `author`, `authorName`,
`authors`, `agentName`, `storyId`, `recordId`, `url`, `status`, `workdir`, `featureName`.

Also add a value pattern for `Cookie:` / `Set-Cookie:` headers to `SECRET_VALUE_PATTERNS`
(`redact.ts:26-84`); the key pattern alone does not catch a cookie interpolated into a `message`
string, which is how agent stderr arrives.

**Acceptance:** a table-driven test asserting the full must-match / must-not-match sets above, plus a
`redactEntry` round-trip proving a `Cookie:` header in `message` is redacted while a `sessionName`
in `data` survives untouched.

### 3. SEC-2 - webhook reporter URL logged in cleartext

**File:** `src/plugins/builtin/reporter-shared/post-json.ts:32,37`

For Slack/Discord the URL path **is** the credential, and it survives both redaction layers
(`SECRET_KEY_PATTERN.test("url") === false` - the `(?:\w+)?_URL` branch requires the underscore, so
`webhookUrl` matches but bare `url` does not). It is persisted to the JSONL run log on any
non-2xx or throw.

**Ruling: fix at the call site, not in the redactor.** Log `new URL(url).origin` plus a short hash of
the full URL (enough to correlate two failures to the same endpoint without carrying the secret). Do
**not** add a bare `url` key to `SECRET_KEY_PATTERN` - `url` is a pervasive non-secret field name and
blanket-redacting it would gut the diagnostic value of the run log, the same over-redaction trap as
SEC-3.

Guard the `new URL()` parse - a malformed configured URL must not throw out of the error path.

**Acceptance:** a test asserting a Slack-shaped webhook URL is not present verbatim in the logged
payload on a non-2xx response, and that the origin still is.

### 4. MEM-2 - native session maps are unreachable from run teardown

**Files:** `src/agents/native/adapter.ts`, `src/agents/native/session/session.ts:168-182`

Run teardown calls `adapter.closePhysicalSession?.(...)` (`execution/session-manager-runtime.ts:19`).
That method exists **only on the ACP adapter** (`acp/adapter.ts:134`);
`grep -c closePhysicalSession src/agents/native/adapter.ts` returns **0**. So every native session
left open by design (`keepOpen`, set by `implement.ts:64`, `write-test.ts:86`, `call.ts:230`; or
`stale-retry`) is swept out of `SessionManager._sessions` by `closeStory` **without
`closeNativeSession` ever running**, stranding entries in all three module-level maps.

**Ruling (user-decided): implement `closePhysicalSession` on the native adapter.** This makes teardown
identical for both adapters and honors the ADR-011 ownership model. Do **not** instead sweep the maps
from `runtime.close()` - that leaves the contract asymmetric and does not fix the `keepOpen` path
*during* a run.

#### The type contract - read before writing code

The two functions do **not** have compatible signatures, so a naive delegation will not compile:

```ts
// agents/acp/adapter.ts:134 - the contract you must mirror
async closePhysicalSession(handle: string, workdir: string,
                           options?: { force?: boolean; signal?: AbortSignal }): Promise<void>

// agents/native/session/session.ts:160 - takes an OBJECT, not a string
export async function closeNativeSession(handle: SessionHandle, failed?: boolean): Promise<void>
```

`return closeNativeSession(handle)` does **not** typecheck. Resolve it this way, which the data
model already supports:

- Every native map is keyed by the **session-name string**, set in `openNativeSession(name, ...)`
  (`session.ts:122-139`). `closeNativeSession` only ever reads `handle.id` - it never touches any
  other field of `SessionHandle`.
- `SessionHandle.id` is documented as "Protocol-agnostic session identifier"
  (`agents/session-types.ts:29`), and `SessionManager.openSession` stores `handle: name`
  (`manager.ts:493`) on the descriptor, agent-agnostically.
- So `descriptor.handle` (the string passed to `closePhysicalSession`) **is** the same string the
  maps are keyed by.

**Ruling: extract the nine deletes into a string-keyed helper** (e.g.
`clearNativeSessionState(sessionName: string)`), and have both `closeNativeSession` (passing
`handle.id`) and the new `closePhysicalSession` (passing its `handle` string) call it. Do not
reconstruct a synthetic `SessionHandle` just to satisfy the signature.

#### VERIFIED: `descriptor.handle` is populated, and the leak reproduces

`session-manager-runtime.ts:10` returns early on `if (!descriptor.handle)`, so the whole fix hinges
on that field being set for native sessions. **This was proven empirically**, not by reading: a probe
drove the real `SessionManager` against the real `NativeAgentAdapter`, then called `closeStory`.

```
descriptor.handle                   = "nax-e12a329d-us-001-implementer"
descriptor.handle === name          = true
descriptor.handle === handle.id     = true      <- the exact key the nine maps use
descriptor.state                    = "RUNNING"
maps keyed by that exact string     = true
native adapter.closePhysicalSession = "undefined"   <- the gap, confirmed
AFTER closeStory: descriptor gone   = true
AFTER closeStory: transcriptDirs LEAKED = true
AFTER closeStory: timeouts LEAKED       = true
AFTER closeStory: streamHooks LEAKED    = true
```

**Conclusions, all now proven:**
1. The fix is **reachable** - `descriptor.handle` is set, so a native `closePhysicalSession` will be
   called at teardown.
2. `descriptor.handle === handle.id` exactly, which is why the string-keyed helper above is the right
   shape rather than a workaround.
3. The leak is **real and reproducible**: after `closeStory` the descriptor is gone while all the
   native maps still hold the session.

Why `handle` is always set where it matters: `_findByName` (`manager.ts:393-398`) matches on
`session.handle === name`, so a descriptor created without a handle can never be found by name.
`openSession` therefore always takes the `!existingDescriptor` branch for it and creates a fresh
descriptor with `handle: name` (`manager.ts:493`), agent-agnostically. The one production `create()`
that omits `handle` (`pipeline/stages/context.ts:83-90`, the context stage pre-allocating a scratch
dir) yields a descriptor that stays in `CREATED` and never has a physical session - so the early
return is *correct* for it, not a miss.

**Use the reproduction above as your failing-first test**, asserting all nine maps rather than the
three shown.

#### The two parts

1. Add `closePhysicalSession` to the native adapter with the signature above, delegating to the new
   string-keyed helper.
2. **Reorder `closeNativeSession`.** It performs `await retainTranscript(...)` /
   `pruneRetainedTranscripts` (`:168-169`) **before** the deletes (`:174-182`). A throw in that I/O
   skips every delete. Put the deletes in a `finally` around the transcript I/O.

**There are NINE maps/sets, not three.** The review doc quoted only the first three because it
quoted a truncated line range. The full set, all in `session.ts`, all string-keyed:
`nativeTranscriptDirs` (:28), `nativeSessionTimeouts` (:35), `nativeSessionStreamHooks` (:43),
`nativeSessionFailed` (:66), `nativeSessionTranscriptOwners` (:76), `nativeSessionCompaction` (:79),
`nativeSessionTransportRetry` (:85), `nativeSessionSpinBreaker` (:95), `nativeSessionLastUsage` (:106).
The helper must clear all nine, matching the nine deletes at `:174-182`.

Note the file's own docstring calls the retention "harmless in practice (a small in-memory map keyed
by session name, not a handle to a real resource)". That is true of the *size*; the defect is the
unreachable teardown path and the throw-skips-cleanup ordering, not the byte count.

**Acceptance:** a test that opens a native session with `keepOpen`, runs story close, and asserts
**all nine** maps are empty; plus a test that a throwing `retainTranscript` still clears them.
Assert on the maps by iterating the exported bindings, not by naming three of them, so a tenth map
added later fails the test rather than slipping through.

---

## P2

### 5. MEM-5 - MCP deadline timer is never cleared

**File:** `src/mcp/pool.ts:161-172`

`.unref?.()` returns the `Timeout` and it is discarded inside the executor arrow, so `clearTimeout` is
impossible. Every call, including instant returns, arms a timer for the full `timeoutMs` (default 60s,
`schemas-mcp.ts:25`). `.unref()` prevents holding the event loop open; it does not release the
allocation.

**Ruling:** capture the id, `clearTimeout` in a `finally` around the race. The repo already has
`cancellableDelay` / `makeStreamDrain` patterns - reuse one rather than hand-rolling.

Scope honestly in the commit message: `mcp.servers` defaults to `{}` (`schemas-mcp.ts:66`), so this is
dead unless a server is configured. It is a cheap, correct fix, not a live leak.

### 6. PERF-3 - per-package config re-read, re-merge, full Zod re-validation

**Files:** `src/config/loader.ts:419-432,443-446,581` - **new leaf module required, see constraints**

`_rootConfigCache` covers only the root load. Everything after `:443` re-runs per story with no result
cache, including the full `NaxConfigSchema.safeParse` at `:581`.

**Ruling:** cache the final merged `NaxConfig` keyed by
`(resolvedRootConfigPath, packageDir, profileKey)`. **The profile key must be in the key** - omitting
it would silently serve one profile's config to another run, which is the nax#2126 defect class.

**`loader.ts` is at exactly 600/600 lines.** Put the cache in a new leaf module and import it.

Scope this accurately when you write it up: it only fires for a monorepo package that actually ships
`.nax/mono/<pkg>/config.json`. Non-monorepo and root stories return early at
`iteration-runner.ts:129` (`storyPackageDir(story)` undefined), and a missing package config returns
`rootConfig` at `loader.ts:453` before any shim, merge, env-resolve or Zod parse.

### 7. PERF-1 - `ProviderWeightsCache` invalidated where it is useless

**File:** `src/context/engine/stage-assembler.ts:302-306`

`invalidate(ctx.prd.feature)` runs immediately after `writeContextManifest`, on the same key
`loadOrGet` populated at `:283-286`. Hit rate is effectively zero. The invalidation buys nothing:
`deriveProviderWeights` reads only `manifest.chunkEffectiveness` (`provider-weights.ts:85`), written
solely by `annotateManifestEffectiveness` (`effectiveness.ts:474`, post-story from
`completion.ts:102`), and the manifest just written carries none.

**Ruling:** move the `invalidate` call into `annotateManifestEffectiveness`. Remove it from both
useless sites (`stage-assembler.ts:305` and `pipeline/stages/context.ts:266`).

Gated behind `context.v2.enabled` (default `false`, `schemas-context.ts:162`) - but note this repo's
own `.nax/config.json:201` sets it `true`, so it is live on every dogfood run.

### 8. MEM-7 - per-run detection memos cleared only on the success path

**Files:** `src/execution/lifecycle/run-completion.ts:406-414` -> `src/execution/lifecycle/run-cleanup.ts`

`runCompletionPhase` is called **inside the `try`** (`runner.ts:312`); `cleanupRun` is the `finally`
(`runner.ts:364,395,419`). Any throw out of setup or execution skips the clear.

**Ruling:** move the whole four-memo block to `cleanupRun`. It is **four** memos, not one -
`clearWorkspaceCache()`, `clearLanguageCache()`, `clearGitRootCache()` and
`_resetCanonicalRulesCache()` all share the exposure. Leaving a duplicate call in `run-completion` is
harmless but pointless; remove it so there is one owner.

---

## P3 - small hardening, all independent

### 9. MEM-12 - `StoryHopBudget._byStory` never pruned

`src/agents/hop-budget.ts:99-102`, `src/agents/manager.ts:151`. Verified: `reset()` has **no
production call site** (only the declaration, the interface member at `manager-types.ts:215`, and a
doc comment). Only `resetTransientUnavailable()` ships.
**Ruling:** call `reset()` at run teardown. Note it also clears `_cooldowns` and `_prunedFallback`,
which is the desired behaviour for a reused manager (`runtime/index.ts:278,410-412` accept a
pre-built one).

### 10. MEM-13 - `CostAggregator._openScopes` released only by the caller

`src/runtime/cost-aggregator.ts:405,514-532`. **Ruling:** clear the set in `drain()`, which already
warns about unclosed scopes at `:535-539`. Keep the warning - it is the diagnostic. While here,
confirm the seven production `openScope()` sites (`debate/runner.ts:81,82,118-121`,
`story-orchestrator/run-phase.ts:247`) each close in a `finally`.
File is at 592/600 - keep it to a couple of lines.

### 11. PERF-11 - redundant `fileExists` probe before every manifest read

`src/context/engine/manifest-store.ts:190,195,197`. `listManifestFiles` (`:43-53`) is a
`Bun.Glob(...).scan()`, so the probe is redundant modulo TOCTOU.
**Ruling:** drop the probe, catch ENOENT on the read instead.
**Watch out:** both are injectable `_manifestStoreDeps`, and tests stub `listManifestFiles` with
synthetic names plus `fileExists = async () => true`
(`test/unit/metrics/tracker-context-metrics.test.ts:77,81`). Update those fixtures.
Bounded `Promise.all` on the sequential loops at `:221-223,270-272` is optional; skip it if it
complicates the diff.

### 12. PERF-12 - `globToRegex` recompiled per pattern per file

`src/context/engine/providers/static-rules.ts:137-145`, `src/context/engine/scope-path-match.ts:50-88`.
Compiled inside `files.some(...)` inside `appliesTo.some(...)`.
**Ruling:** memoize inside `globToRegex` itself (module-level `Map` keyed by the pattern string) in
`scope-path-match.ts` (155 lines, plenty of headroom) - **not** at the `static-rules.ts` call site,
which is at 591/600. This also fixes every other caller for free.

### 13. SEC-9 - `resolveEnvVars` copies `__proto__` as an own key

`src/config/dotenv.ts:116-122`. Proven in bun: the key vanishes from the result, the fresh object's
prototype changes (object-local, **not** global pollution), and the config silently gains phantom
inherited keys while losing the literal one. `merger.ts:21` `DANGEROUS_MERGE_KEYS` exists but does not
cover this path.
**Ruling:** skip `DANGEROUS_MERGE_KEYS` in the loop, reusing the existing constant - do not define a
second copy.
**It is currently module-private**: `merger.ts:21` is `const DANGEROUS_MERGE_KEYS = ...`, not
`export const`. Export it (and check `check:alias-internals` / the barrel conventions still pass), or
move it to a shared leaf module if `merger.ts` should not widen its surface. Do not copy the literal
set into `dotenv.ts` - two copies of a security constant is how one of them goes stale.

### 14. Correctness note - `memoizedLoadCanonicalRules` ignores its `options`

`src/context/engine/providers/canonical-rules-cache.ts:13-27`. The cache key is `workdir` only.
Verified inert today: the memo has exactly one importer (`static-rules.ts:31`) and its two call sites
(`:189` `request.repoRoot`, `:240` `request.packageDir`) **both pass no options**, and the keys are
distinct strings. Every other `loadCanonicalRules` consumer calls the unmemoized loader directly.
**Ruling: drop the dead `options` parameter from the memo wrapper** rather than adding it to the key.
A wrong-options hit would silently apply the first caller's `budgetTokens`; removing the parameter
makes that unrepresentable instead of merely unlikely.

---

## Suggested commit sequence

Each item is independent. Land them as separate commits on this branch so a bisect stays useful:

```
fix(tools): refuse agent writes to .queue.txt run-control file   # SEC-5
fix(logger): redact authorization, cookie and credential keys     # SEC-3
fix(reporter): log webhook origin and hash, never the full URL    # SEC-2
fix(agents): implement closePhysicalSession on the native adapter # MEM-2
fix(mcp): clear the per-call deadline timer on the fast path      # MEM-5
perf(config): cache merged per-package config for the run         # PERF-3
fix(context): invalidate provider weights where effectiveness lands # PERF-1
fix(lifecycle): clear per-run detection memos in cleanup, not completion # MEM-7
fix(agents): reset hop budget at run teardown                     # MEM-12
fix(runtime): clear open cost scopes on drain                     # MEM-13
perf(context): drop the redundant manifest stat probe             # PERF-11
perf(context): memoize globToRegex by pattern                     # PERF-12
fix(config): skip dangerous keys in resolveEnvVars                # SEC-9
refactor(context): drop the dead options param from the rules memo # canonical-rules
```

Conventional commits, no attribution footer (disabled globally).

## Definition of done

- [ ] `bun run test` green
- [ ] `bunx tsc --noEmit` clean (**not** covered by `check:all`)
- [ ] `bun run lint` green
- [ ] `bun run check:all` green, **including the file-size gate** (`loader.ts` must not grow)
- [ ] Each fix has a test that fails without it - especially SEC-3, where the test must assert the
      must-NOT-match set, not just the must-match set
- [ ] No change to `.claude/rules/` by hand
- [ ] Code review before opening the PR, not after

## Open follow-ups (not in this branch)

Two nax-side documentation defects found during verification, worth separate issues:

1. `docs/architecture/agent-adapters.md:345` cites `docs/reviews/2026-08-14-deep-code-review.md`,
   which does not exist in the tree. The D-1 ruling is authoritative regardless, but the citation is
   dangling.
2. `src/config/schemas-context.ts:303` comments "Phase 6: enabled by default" while the actual
   default is `false` (`:162`). The field-level docstring at `:157-161` is correct; the summary
   comment contradicts it.
