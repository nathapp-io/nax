# Code Review Report: Context Engine / Session Manager Stack

Date: 2026-04-17

## Scope

Reviewed the commit range from `f7f41d42cda59ed4466081e851c43d650b26d2c5` through `b4888122ee276e996f4f0585274e56642e32770e`.

Compared against the latest `main` branch as of 2026-04-17:

- `HEAD`: `b4888122ee276e996f4f0585274e56642e32770e`
- `origin/main`: `b4888122ee276e996f4f0585274e56642e32770e`

Specs reviewed:

- `docs/specs/SPEC-context-engine-agent-fallback.md`
- `docs/specs/SPEC-context-engine-canonical-rules.md`
- `docs/specs/SPEC-context-engine-v2-amendments.md`
- `docs/specs/SPEC-context-engine-v2-compilation.md`
- `docs/specs/SPEC-context-engine-v2.md`
- `docs/specs/SPEC-session-manager-integration.md`

## Overall Assessment

This stack contains substantial, high-quality implementation work and good targeted test coverage for several slices of the design.

However, I do **not** think it is accurate to conclude that all acceptance criteria are met or that all required functions are fully wired up end to end. The largest remaining gaps are in:

- availability fallback execution/wiring
- centralized session-manager ownership
- canonical-rules completeness
- structured fallback classification
- manifest / protocol-correlation / budget threading completeness

## Findings

### 1. Critical: fallback rebuild is not actually delivered to the fallback agent, and session handoff is not persisted

Files:

- [src/pipeline/stages/execution.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/stages/execution.ts:247)
- [src/pipeline/stages/execution.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/stages/execution.ts:289)
- [src/pipeline/stages/execution.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/stages/execution.ts:198)

Why this matters:

- The stage rebuilds `ctx.contextBundle` for the swap target, but the retry still runs with the original `ctx.prompt`.
- The fallback agent therefore does not actually receive the rebuilt push block, failure note, or agent-specific rendering produced by `rebuildForAgent()`.
- The swap path also does not call any `sessionManager.handoff()` equivalent and does not re-bind the swapped session handle/protocol IDs after the fallback run.

Spec impact:

- AC-37 `Rebuild portable state`
- AC-41 `Fallback observability`
- AC-67 `Handoff`
- AC-76 `Protocol ID capture`

Risk:

- Fallback appears implemented in tests and manifests, but the runtime handoff is incomplete.
- Operators may think Codex/Gemini received preserved context when the real prompt did not change.

### 2. High: fallback traversal stops after a single alternate agent instead of walking the configured map

Files:

- [src/execution/escalation/agent-swap.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/escalation/agent-swap.ts:39)
- [src/pipeline/stages/execution.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/pipeline/stages/execution.ts:332)

Why this matters:

- `resolveSwapTarget()` chooses one candidate by index.
- If that single swap attempt fails, execution escalates immediately.
- There is no runtime loop that tries the next candidate in `fallback.map`, and there is no `all-agents-unavailable` terminal outcome once the configured map is exhausted.

Spec impact:

- AC-35 `Fallback map resolution`
- AC-40 `Fallback hop bound`
- Agent fallback spec AC-4/5/9

Example:

- With `claude -> [codex, gemini]`, a Claude availability failure can reach Codex.
- If Codex also fails, Gemini is not attempted in the same flow.

### 3. High: Session Manager is still partial and not yet the centralized lifecycle owner described by the spec

Files:

- [src/execution/iteration-runner.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/iteration-runner.ts:148)
- [src/execution/lifecycle/run-setup.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/execution/lifecycle/run-setup.ts:173)
- [src/session/manager.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/session/manager.ts:82)
- [src/session/manager.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/session/manager.ts:266)
- [src/session/types.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/session/types.ts:26)
- [src/tdd/session-runner.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/tdd/session-runner.ts:196)
- [src/agents/types.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/agents/types.ts:104)

Why this matters:

- A new in-memory `SessionManager` is created per story, not as a run-level durable owner.
- Startup/shutdown orphan sweep integration is explicitly deferred.
- `sweepOrphans()` deletes old terminal sessions rather than marking stale active sessions orphaned.
- The implemented state machine and types do not match the spec’s `created/active/suspended/failed/handed-off/completed/orphaned` model.
- The public interface still lacks key spec functions like `handoff()` and `recordStage()`.
- Many runtime paths still depend on legacy `acpSessionName`, `sessionRole`, `keepSessionOpen`, and `buildSessionName()` behavior.

Spec impact:

- AC-63 through AC-78 are only partially satisfied.
- Session-manager follow-up AC-79 through AC-83 are also not fully complete.

Assessment:

- I would classify this as “good phase progress,” not “fully integrated central session manager.”

### 4. Medium: canonical-rules implementation does not yet satisfy the full loader/scoping/export/migration spec

Files:

- [src/context/rules/canonical-loader.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/context/rules/canonical-loader.ts:38)
- [src/context/rules/canonical-loader.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/context/rules/canonical-loader.ts:128)
- [src/context/engine/providers/static-rules.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/context/engine/providers/static-rules.ts:83)
- [src/context/engine/providers/static-rules.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/context/engine/providers/static-rules.ts:161)
- [src/cli/rules.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/cli/rules.ts:84)
- [src/cli/rules.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/cli/rules.ts:222)

Why this matters:

- The canonical loader only scans top-level `*.md` files.
- There is no support for nested one-level directories, YAML frontmatter, `priority`, or `appliesTo`.
- `StaticRulesProvider` injects every loaded canonical rule for every story with no path scoping.
- The legacy fallback path reads only the first matching legacy shim file, not `CLAUDE.md + .claude/rules/*.md`.
- `rules export` and `rules migrate` exist, but they are simpler than the spec’s stated behavior.

Spec impact:

- Canonical-rules AC-2, AC-3, AC-5, AC-6, AC-7, AC-9, AC-12, AC-14, AC-15, AC-16 are not fully met.
- Context-engine AC-28 through AC-31 are only partially met.

### 5. Medium: adapter failure classification still depends on free-text parsing

Files:

- [src/agents/acp/parse-agent-error.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/agents/acp/parse-agent-error.ts:13)
- [src/agents/acp/adapter.ts](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/agents/acp/adapter.ts:602)

Why this matters:

- The spec explicitly requires that classification not infer from free text.
- The implementation still classifies by substring matches like `429`, `rate limit`, `401`, `403`, `unauthorized`, and `forbidden`.
- Unrecognized failures are mapped to `category: "quality"` rather than a distinct `other` path.

Spec impact:

- Agent fallback AC-15 `Classification never infers from free text`
- Agent fallback AC-1/2

Risk:

- The fallback/escalation decision boundary can still change based on wording rather than structured backend failure data.

## Acceptance / Wiring Summary

### Clearly implemented or largely in place

- Context orchestrator core pipeline
- provider registration model
- greedy packing and budget-floor behavior
- manifest writing per stage
- stage-specific assembly helpers
- monorepo `repoRoot` / `packageDir` support in the context engine
- static-rules canonical path with package overlay
- `nax context inspect`
- targeted agent-swap tests for the currently implemented behavior

### Not yet fully met or not fully wired

- end-to-end fallback prompt rebuild delivery
- multi-hop fallback candidate traversal
- session-manager handoff ownership
- orphan recovery semantics
- stage digest persistence through session-manager APIs
- protocol ID display in context inspection / manifests as specified
- full canonical-rules frontmatter, scoping, and migration behavior
- structured adapter-failure classification without message parsing
- `availableBudgetTokens` propagation from prompt-building call sites

## Verdict

The implementation is materially advanced and includes many real improvements, but the full spec set is **not yet complete**.

Most importantly:

- fallback is not fully wired end to end
- the session manager is not yet the single authoritative lifecycle owner
- canonical rules are not yet implemented to the full spec contract

## Verification Performed

Targeted tests run:

```bash
bun test test/integration/execution/agent-swap.test.ts test/unit/session/manager.test.ts test/unit/context/engine/providers/static-rules.test.ts
```

Result:

- 61 passing
- 0 failing

Note:

These tests validate the current implementation behavior, but several acceptance criteria above remain broader than what the runtime wiring presently guarantees.
