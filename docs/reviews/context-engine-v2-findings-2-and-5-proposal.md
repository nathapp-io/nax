# Context Engine v2 — Findings 2 & 5 Proposal

Date: 2026-04-17
Related: `docs/reviews/context-engine-v2-architecture-review.md` (Findings 2 and 5)

This document proposes solutions for the two structural findings left open after Findings 1, 3, and 4 were fixed. Each finding is treated independently so they can be discussed one at a time.

---

## Finding 2 — Disk-backed session discovery

**Decision (locked):** Option A with **4-hour TTL** on disk discovery. Cross-iteration continuity is the primary goal; cross-invocation continuity is a side benefit within the TTL window. TTL value mirrors `DEFAULT_ORPHAN_TTL_MS` in `src/session/manager.ts` so the two cleanup concepts stay aligned.

### Current state

- `SessionManager` is an in-memory `Map<string, SessionDescriptor>` ([src/session/manager.ts:71](src/session/manager.ts#L71)).
- `new SessionManager()` is instantiated fresh per iteration in [src/execution/iteration-runner.ts:148](src/execution/iteration-runner.ts#L148).
- Scratch directories are persisted under `.nax/features/<feature>/sessions/<id>/`.
- Context manifests are persisted under `.nax/features/<feature>/<storyId>/<stage>/manifest.json` (via `writeContextManifest`).
- Discovery in `stage-assembler.ts` relies on `sessionManager.getForStory(storyId)` ([src/context/engine/stage-assembler.ts:44](src/context/engine/stage-assembler.ts#L44)).
- **No cross-invocation reader today.** `SessionManager` docstring ([src/session/manager.ts:54-70](src/session/manager.ts#L54-L70)) states "sessions do NOT persist across separate nax invocations in Phase 0."
- **No cleanup of disk scratch dirs today.** They accumulate indefinitely. `sweepFeatureSessions()` in [runner.ts:251](src/execution/runner.ts#L251) closes ACP sidecar sessions only, not scratch.

### The bug this fixes

On tier escalation (fast → balanced → powerful), [iteration-runner.ts:83](src/execution/iteration-runner.ts#L83) reuses the worktree but [iteration-runner.ts:148](src/execution/iteration-runner.ts#L148) constructs a fresh `SessionManager`. Iteration 1's scratch is still on disk but invisible to iteration 2's `stage-assembler`. This is the concrete cross-iteration continuity loss the architecture review flagged.

### Root problem

In-memory discovery forgets everything at iteration boundaries. Scratch and manifests remain on disk, but `stage-assembler` has no way to see them after the manager is re-instantiated. Prior-attempt context is therefore invisible to later attempts even though the artifacts exist.

### What continuity actually needs

Context Engine v2 wants two things from prior sessions:

1. **Scratch directory paths** — to hand to `SessionScratchProvider`.
2. **Story linkage** — "which sessions belong to this story".

It does **not** need live adapter handles, protocol IDs, or in-flight state. That asymmetry lets us pick a cheaper design than a full write-through session registry.

### Chosen approach — Option A with 4-hour TTL

Teach `getStoryScratchDirs()` in `stage-assembler.ts` to also enumerate the filesystem, filter by `storyId` and TTL, and union with the in-memory manager result.

**Implementation sketch:**

```typescript
// src/context/engine/stage-assembler.ts

const DISK_DISCOVERY_TTL_MS = 4 * 60 * 60 * 1000; // mirrors DEFAULT_ORPHAN_TTL_MS

function getStoryScratchDirs(ctx: PipelineContext, options: StageAssembleOptions): string[] {
  if (options.storyScratchDirs) return dedupeScratchDirs(options.storyScratchDirs);

  const managerDirs = ctx.sessionManager
      ?.getForStory(ctx.story.id)
      .flatMap((s) => (s.scratchDir ? [s.scratchDir] : [])) ?? [];

  const diskDirs =
    ctx.projectDir && ctx.prd.feature
      ? discoverSessionScratchDirsOnDisk(
          ctx.projectDir,
          ctx.prd.feature,
          ctx.story.id,
          DISK_DISCOVERY_TTL_MS,
        )
      : [];

  return dedupeScratchDirs([ctx.sessionScratchDir, ...managerDirs, ...diskDirs]);
}
```

`discoverSessionScratchDirsOnDisk(projectDir, featureName, storyId, ttlMs)`:
1. `readdir(.nax/features/<feature>/sessions/)`.
2. For each `<sessionId>/` entry, read `descriptor.json`.
3. Skip when `storyId` does not match.
4. Skip when `lastActivityAt` is older than `ttlMs` (or descriptor mtime if the field is absent).
5. Return the `scratchDir` path.
6. All I/O failures are caught and logged (non-fatal) — a broken descriptor must not block context assembly.

**Precondition:** `SessionManager.create()` writes a one-shot `descriptor.json` next to the scratch dir. No write-through on every transition — the descriptor is "created at birth, read by later iterations/invocations".

### Scope of change

1. **`src/session/manager.ts`** — `create()` writes `<scratchDir>/descriptor.json` after the in-memory insert. Shape: `{ id, role, storyId, featureName, workdir, scratchDir, createdAt, lastActivityAt }`. No transition tracking in the file — only the create-time snapshot.
2. **`src/context/engine/stage-assembler.ts`** — new `discoverSessionScratchDirsOnDisk()` helper + union in `getStoryScratchDirs()`.
3. **Tests** — unit coverage for: valid descriptor surfaces scratch; missing descriptor is skipped; stale descriptor beyond TTL is skipped; wrong-storyId descriptor is skipped; unreadable descriptor logs and continues.

### Tradeoffs

**Pros:**
- ~60 lines of new code, no `SessionManager` refactor.
- Fixes the concrete cross-iteration bug.
- Cross-invocation continuity within 4h is a natural side benefit — aligns with the existing orphan TTL.
- TTL prevents unbounded accumulation from leaking into future runs.

**Cons:**
- `SessionManager.listActive()` and `sweepOrphans()` remain oblivious to disk state. Nothing depends on this today; defer until a real consumer appears.
- Two discovery paths (memory + disk). Dedup on absolute path keeps them consistent.
- Descriptor files accumulate on disk beyond the TTL (they're just ignored, not deleted). A future `nax clean` command or post-run sweep can address this; out of scope here.

### Rejected alternatives

- **Option B (full write-through + rehydration):** Too much surface area for the current need. Revisit if a future subsystem needs authoritative cross-invocation `listActive()` / transition state.
- **runId-scoped discovery (Phase 0 strict):** Rejected — the 4h TTL achieves the same "don't trust ancient state" property while also giving cross-invocation continuity for free within the window.
- **No TTL:** Rejected — unbounded accumulation risks stale scratch from week-old failed runs polluting new runs.

---

## Finding 5 — Plugin provider lifecycle

**Decision (locked):** Path B — minimal scaffold only. Add optional `dispose?()` to the provider interface and document the concurrency contract on `IContextProvider.fetch()`. Do **not** build the `PluginProviderCache` yet. No heavy plugin (embedding index, graph backend, socket-backed service) is on the near roadmap, so building the cache now is preemptive. Revisit when the first heavy plugin lands.

### Current state

- `loadPluginProviders()` is called **per `assemble()`** in two places:
  - [src/pipeline/stages/context.ts:136](src/pipeline/stages/context.ts#L136)
  - [src/context/engine/stage-assembler.ts:72](src/context/engine/stage-assembler.ts#L72)
- Each call dynamically imports modules (Bun caches the import, so disk reads are deduped) and constructs a **fresh provider instance**.
- `provider.init(config)` is re-run on each load when config is present.
- There is no teardown hook. Long-lived handles leak until GC or process exit.

### Root problem

The architecture assumes providers are cheap and disposable. Today's built-in providers are — they read files or run git commands. But the Phase 7 plugin slot was designed for heavy integrations: RAG indexes, graph backends, KB clients. For those, per-assemble re-init is wasteful, and the absence of `dispose()` risks handle/socket leaks.

### Design choice 1 — Cache scope

| Scope | Pros | Cons |
|:---|:---|:---|
| **Per-run (recommended)** | Natural lifecycle bounds; one `init()` and one `dispose()` per provider per `nax` invocation | Providers must be safe under concurrent `fetch()` calls across parallel stories |
| Per-story | Easier per-story isolation | Defeats the purpose — still re-inits for each story in a run |
| Per-process (module-level singleton) | Cheapest | Leaks across tests; violates `_deps` pattern; hard to reset |

### Design choice 2 — Ownership

Owned by `Runner`, threaded through `PipelineContext.pluginProviderCache`. **Not** on the orchestrator — orchestrators are constructed per-`assemble()` (`createDefaultOrchestrator` in `orchestrator-factory.ts`) and would inherit the wrong lifetime.

### Proposed shape

```typescript
// new: src/context/engine/providers/plugin-cache.ts

export interface InitialisableProvider extends IContextProvider {
  init(config: Record<string, unknown>): Promise<void>;
  dispose?(): Promise<void>;  // NEW — optional teardown
}

export class PluginProviderCache {
  private readonly entries = new Map<string, IContextProvider>();
  private disposed = false;

  async loadOrGet(
    configs: ContextPluginProviderConfig[],
    rootDir: string,
  ): Promise<IContextProvider[]> {
    if (this.disposed) throw new Error("PluginProviderCache used after dispose");
    // key: `${module}:${stableHash(config)}`
    // miss → loadSingleProvider (extract from plugin-loader.ts) + cache
    // hit  → return cached instance
    // failures are logged and skipped (same as today)
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // best-effort: iterate entries, call dispose() on InitialisableProvider
    // bounded timeout per call (5s), log + continue on error
  }
}
```

### Wiring

1. `runSetupPhase` in `src/execution/lifecycle/run-setup.ts` constructs `new PluginProviderCache()` and attaches it to the root context.
2. `PipelineContext` gains `pluginProviderCache: PluginProviderCache`.
3. `stage-assembler.ts` and `pipeline/stages/context.ts` call `ctx.pluginProviderCache.loadOrGet(configs, ctx.projectDir ?? ctx.workdir)` instead of `loadPluginProviders(...)`.
4. `runCompletionPhase` in `src/execution/lifecycle/run-completion.ts` calls `await cache.disposeAll()` before final teardown.
5. `loadPluginProviders` stays as a thin fallback for call paths that don't have a cache (tests that don't wire the runner context).

### Tradeoffs and risks

- **Concurrency contract becomes explicit.** Today parallel stories already share provider instances implicitly (`Promise.all` over providers inside a single `assemble()`). Caching across stories formalises this. Must document: `IContextProvider.fetch()` must be safe under concurrent calls with distinct `ContextRequest`s.
- **Config-change invalidation.** Config is immutable within a `nax` run. Cache key `(module, stableHash(config))` is safe. Revisit if live config reload is ever added.
- **Per-story state opt-out.** Unlikely to need. If a future provider genuinely needs per-story state, add `scope: "run" | "story"` on the plugin config entry — default `"run"`. Do not build this until a real case demands it.
- **Test isolation.** Each test constructs its own `PluginProviderCache`. The cache itself injects `_deps.loadSingleProvider` so tests can stub the loader. No module-level state.
- **Dispose error handling.** If a provider's `dispose()` throws or hangs, wrap each call in `Promise.race` with a 5-second timeout and `logger.warn`. A misbehaving plugin must not block run completion.

### Chosen approach — Path B (minimal scaffold)

**What ships now:**

1. Extend `InitialisableProvider` in `src/context/engine/providers/plugin-loader.ts`:

   ```typescript
   export interface InitialisableProvider extends IContextProvider {
     init(config: Record<string, unknown>): Promise<void>;
     /**
      * Optional teardown hook. Called by the plugin cache (when introduced)
      * on run completion. Must not throw — implementations handle their own
      * errors. Currently not invoked by any caller; see Finding 5 in
      * docs/reviews/context-engine-v2-findings-2-and-5-proposal.md.
      */
     dispose?(): Promise<void>;
   }
   ```

2. Add a concurrency contract comment on `IContextProvider.fetch()` in `src/context/engine/types.ts`:

   > `fetch()` must be safe under concurrent invocation with distinct `ContextRequest` values. The orchestrator calls providers in parallel within a single assemble pass, and a future plugin cache (Finding 5) will share provider instances across parallel stories.

3. **Do not** build `PluginProviderCache`. Leave `loadPluginProviders()` unchanged — it keeps returning fresh instances per assemble pass.

### Why not build the cache now

- No near-term plugin owns an expensive handle, so per-assemble re-init has no measurable cost today.
- Current built-in providers (static-rules, feature-context, session-scratch, git-history, neighbor, prior-digest) are all cheap file/git reads. Bun's module cache already dedupes the dynamic import.
- CLAUDE.md explicitly discourages designing for hypothetical future requirements.
- The scaffold keeps the API forward-compatible: a plugin author can ship a `dispose()` method today, and it will be honored automatically once the cache is introduced.

### When to revisit

The first plugin that meets any of these criteria should trigger building `PluginProviderCache`:

- Owns a long-lived handle (socket, DB connection, file descriptor, spawned subprocess)
- `init()` runs longer than ~100ms (embedding index load, graph hydrate, remote auth handshake)
- Allocates memory that scales with repo size and shouldn't be re-built per assemble

At that point, revisit the cache design from the proposal in git history and size it against the concrete provider.

### Rejected alternatives

- **Path A (full cache + dispose now):** Rejected — preemptive. No concrete driver on the near roadmap.
- **Path C (nothing, TODO only):** Rejected — Path B costs ~5 lines more and makes the API forward-compatible, so plugin authors can write `dispose()` today without waiting for the cache.
- **Renaming `InitialisableProvider` → `ManagedProvider`:** Rejected for Path B — renaming without a behavioral driver adds churn. Revisit when the cache lands.

---

## Summary

| Finding | Recommendation | Status | Risk | Preemptive? |
|:---|:---|:---|:---|:---|
| 2 — session discovery | Option A + 4h TTL (descriptor.json write in `create()` + disk union in `getStoryScratchDirs`) | **Decided** | Low | No — fixes observed bug |
| 5 — plugin lifecycle | Path B scaffold: optional `dispose?()` + concurrency contract doc, no cache yet | **Decided** | Very low | No — forward-compatible API only |

Both fixes are scoped to stay within the existing architecture. Neither requires a migration or breaking config change.
