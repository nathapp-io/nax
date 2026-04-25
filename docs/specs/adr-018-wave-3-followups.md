# ADR-018 Wave 3 Follow-ups — Session Ownership + Middleware Context Alignment

**Status:** Proposed
**Owner:** TBD
**Predecessor:** ADR-018 Wave 2 (PR-697)
**Filed:** 2026-04-25
**Origin:** PR-697 review questions Q2 and Q3 — surfaced while landing Finding 5 (lost ACP audit metadata).

---

## Problem 1 — Adapter still owns session lifecycle

### Current state

The ACP adapter (`src/agents/acp/adapter.ts`) owns:

| Concern | Location |
|:---|:---|
| Session-name derivation | `computeAcpHandle()` / `buildSessionName()` |
| Multi-turn loop + `turnCount` | inline `let turnCount = 0` in `run()` |
| `ensureAcpSession()` / `closeAcpSession()` | adapter lifecycle |
| `sessionResumed` detection | derived inside `run()` |

Wave 2's Finding 5 fix (commit `68a67816`) had to plumb three of those values
(`sessionName`, `turn`, `resumed`) back up through `AgentResult.sessionMetadata`
so the audit middleware could record them. That plumbing exists only because
`SessionManager` does not own session lifecycle today.

### Target state (per ADR-018 §3.1)

```
SessionManager (owns: name, lifecycle, turn count, resumed flag)
  └─ AgentManager.runAs(req, sessionManager)
       └─ middleware chain (audit reads from sessionManager.snapshot())
            └─ adapter.sendTurn(handle, prompt)   ← primitive only
```

`AgentResult.sessionMetadata` goes away. `SessionManager` exposes a snapshot
that the audit middleware reads directly. Adapters expose lower-level
primitives (`openHandle`, `sendTurn`, `closeHandle`); `SessionManager`
orchestrates the multi-turn loop.

### Why this matters

- **Ownership clarity.** Today the same concern is partially in the adapter,
  partially in `SessionManager`, partially threaded through `AgentResult`.
  One place wins.
- **Audit completeness.** When the adapter throws mid-turn, audit never sees
  `protocolIds` or `sessionMetadata` — they live in `AgentResult` which was
  never returned. With `SessionManager` owning state, the snapshot is always
  available to `onError`.
- **Multi-adapter parity.** A future non-ACP adapter would otherwise need to
  re-implement session naming + turn counting. The primitives + orchestrator
  split removes that duplication.

### Migration

1. **Phase A — extract primitives.** Add `openHandle`/`sendTurn`/`closeHandle`
   to `AgentAdapter`. ACP adapter implements them by extracting code from
   `run()`. CLI adapter no-ops or wraps the existing single-call shape.
2. **Phase B — SessionManager orchestrates.** `SessionManager.runInSession`
   takes ownership of the turn loop. Updates a `SessionSnapshot`
   (`{ handle, turn, resumed, protocolIds }`) at each transition.
3. **Phase C — middleware reads from SessionManager.** `MiddlewareContext`
   gains `sessionSnapshot: () => SessionSnapshot | null`. Audit middleware
   replaces its `result.sessionMetadata`/`result.protocolIds` reads with the
   snapshot accessor.
4. **Phase D — remove `AgentResult.sessionMetadata`** and the adapter's
   internal turn counter. ACP adapter `run()` becomes a thin wrapper or
   deletes entirely (replaced by `SessionManager.runInSession`).

### Estimated cost

- Phase A: ~3 days. Mostly mechanical extraction.
- Phase B: ~5 days. Touches `SessionManager`, snapshot persistence, and the
  ACP retry loop's interaction-bridge handling.
- Phase C–D: ~2 days. Mostly delete.

Total: ~2 weeks. Should be its own PR sequence, not bundled with feature work.

---

## Problem 2 — `MiddlewareContext` shape diverges from ADR-018 §3.1

### Current state

```typescript
// src/runtime/agent-middleware.ts (current)
export interface MiddlewareContext {
  readonly runId: string;
  readonly agentName: string;
  readonly kind: "run" | "complete" | "plan";
  readonly request: AgentRunRequest | null;   // null for complete
  readonly prompt: string | null;              // null for run/plan
  readonly config: NaxConfig;
  readonly signal?: AbortSignal;
  readonly resolvedPermissions: ResolvedPermissions;
  readonly storyId?: string;
  readonly stage?: string;
}
```

The two correlated fields `request` and `prompt` are split — for `run`/`plan`
the prompt lives at `request.runOptions.prompt`; for `complete` it lives at
`ctx.prompt`. Reading "the prompt" requires kind-awareness at every call site.

The PR-697 review surfaced this when Finding 5 had to extract `workdir` /
`projectDir` / `featureName` from `ctx.request?.runOptions` — workable, but
the discriminator on `kind` was not used to narrow types automatically.

### Target state (per ADR-018 §3.1)

```typescript
type MiddlewareContext = RunMiddlewareContext | CompleteMiddlewareContext;

interface MiddlewareContextBase {
  readonly runId: string;
  readonly agentName: string;
  readonly resolvedPermissions: ResolvedPermissions;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly signal?: AbortSignal;
}

interface RunMiddlewareContext extends MiddlewareContextBase {
  readonly kind: "run" | "plan";
  readonly options: AgentRunOptions;
  /** Prompt actually sent to the final hop (after fallback transformation). */
  readonly finalPrompt?: string;
}

interface CompleteMiddlewareContext extends MiddlewareContextBase {
  readonly kind: "complete";
  readonly options: CompleteOptions;
  readonly prompt: string;
}
```

`audit.ts` becomes:

```typescript
async after(ctx, result, durationMs) {
  const prompt = ctx.kind === "complete" ? ctx.prompt : (ctx.finalPrompt ?? ctx.options.prompt);
  if (!prompt) return;
  const entry: PromptAuditEntry = {
    // ...
    workdir: ctx.options.workdir,                                        // typed
    featureName: ctx.options.featureName,                                // typed
    projectDir: ctx.kind !== "complete" ? ctx.options.projectDir : undefined,
    // ...
  };
}
```

No casts. TypeScript narrows via `kind`.

### Why not done in Wave 2

The current shape is functionally equivalent (`AgentRunRequest.runOptions` is
already strongly typed). The unsafe-looking casts in `audit.ts` were defensive
coding, not a structural typing requirement, and were removed in the same
commit that filed this follow-up. The remaining benefit is ergonomic /
consistency-with-ADR, not correctness.

### Scope

| File | Change |
|:---|:---|
| `src/runtime/agent-middleware.ts` | Redefine `MiddlewareContext` as discriminated union |
| `src/agents/manager.ts` | Update 3 ctx constructions (`runAs`, `completeAs`, `hopCtx`) |
| `src/runtime/middleware/audit.ts` | Replace `request.runOptions` reads with `options` |
| `src/runtime/middleware/cost.ts` | Minor — uses shared base fields only |
| `src/runtime/middleware/logging.ts` | Minor — uses shared base fields only |
| `src/runtime/middleware/cancellation.ts` | Minor — uses `signal` |
| `test/unit/runtime/agent-middleware.test.ts` | Update `makeCtx` helper |
| `test/unit/runtime/middleware/audit.test.ts` | Update ctx fixtures |
| `test/unit/agents/manager.test.ts` | Update middleware spy setup |

Estimated cost: ~1 day. Single PR, mostly mechanical.

### Optional: also remove `ctx.config`

ADR-018 §3 specifies `AgentManager` reads its own `this._config` rather than
threading it through `runOptions.config`. The current `MiddlewareContext.config`
field is unused by any middleware (`audit`, `cost`, `logging`, `cancellation`
all access `ctx.runId`/`ctx.agentName`/`ctx.stage` instead). Worth removing in
the same PR for shape consistency.

---

## Sequencing

These two follow-ups are independent. Recommended order:

1. **Problem 2 first** (small, isolated, ADR-aligning). Lands as a single PR.
2. **Problem 1 second** (multi-week refactor). Can be split into the four
   phases above as separate PRs.

Tracking issues: TBD (file when picking up).
