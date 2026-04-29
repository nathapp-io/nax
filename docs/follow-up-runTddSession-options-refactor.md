# Follow-up: Refactor `runTddSession` from 19 positional params to options object

**Origin:** Code review of ADR-020 Wave 2 (`docs/20260428-review-adr020-wave2.md`, STYLE-1)
**Priority:** P4 / Medium
**Effort:** Large
**Breaking change:** Yes — all callers of `runTddSession` must be updated

## Problem

`runTddSession` in `src/tdd/session-runner.ts` currently accepts **19 positional parameters**:

```typescript
export async function runTddSession(
  role: TddSessionRole,
  agent: AgentAdapter,
  agentManager: IAgentManager,   // added in ADR-020 Wave 2
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  modelTier: ModelTier,
  beforeRef: string,
  contextMarkdown?: string,
  lite = false,
  skipIsolation = false,
  constitution?: string,
  featureName?: string,
  interactionBridge?: InteractionBridge,
  projectDir?: string,
  featureContextMarkdown?: string,
  contextBundle?: ContextBundle,
  sessionBinding?: TddSessionBinding,
  abortSignal?: AbortSignal,
): Promise<TddSessionResult>
```

This violates the project's own convention (AGENTS.md: "<=3 positional params, options objects").

## Impact

- **Readability:** Callers are impossible to scan without named parameters
- **Refactoring hazard:** Adding/removing parameters requires touching every caller
- **Review friction:** Reviewers cannot tell at a glance which parameter is which
- **Type safety:** Optional params with defaults (`lite = false`) are error-prone when reordered

## Proposed Solution

Migrate to a single `RunTddSessionOptions` object:

```typescript
export interface RunTddSessionOptions {
  role: TddSessionRole;
  agent: AgentAdapter;
  agentManager: IAgentManager;
  story: UserStory;
  config: NaxConfig;
  workdir: string;
  modelTier: ModelTier;
  beforeRef: string;
  contextMarkdown?: string;
  lite?: boolean;
  skipIsolation?: boolean;
  constitution?: string;
  featureName?: string;
  interactionBridge?: InteractionBridge;
  projectDir?: string;
  featureContextMarkdown?: string;
  contextBundle?: ContextBundle;
  sessionBinding?: TddSessionBinding;
  abortSignal?: AbortSignal;
}

export async function runTddSession(options: RunTddSessionOptions): Promise<TddSessionResult>
```

## Callers to Update

- `src/tdd/session-op.ts` (`runTddSessionOp`)
- `src/tdd/orchestrator-ctx.ts` (`runThreeSessionTddFromCtx`)
- `test/unit/tdd/session-runner-*.test.ts` (all session-runner unit tests)
- `test/integration/agents/acp/tdd-flow-*.test.ts` (ACP TDD flow tests)
- Any other test files calling `runTddSession` directly

## Acceptance Criteria

- [ ] `runTddSession` accepts exactly one positional parameter (`options: RunTddSessionOptions`)
- [ ] `RunTddSessionOptions` interface is exported from `src/tdd/session-runner.ts`
- [ ] All callers in `src/` and `test/` are updated
- [ ] Typecheck passes (`bun run typecheck`)
- [ ] Full test suite passes (`bun run test`)
- [ ] No regression in TDD integration tests

## Notes

- `runTddSessionOp` and `runThreeSessionTdd` already use options objects — follow their pattern
- This is a pure refactor; no runtime behavior should change
- Consider doing this as part of ADR-020 Wave 3 (cleanup) or as a standalone PR
