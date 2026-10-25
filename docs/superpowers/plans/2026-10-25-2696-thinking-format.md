# Per-model thinking format implementation plan

**Goal:** Implement GitHub issue #2696 so self-hosted OpenAI-compatible models can select an existing thinking wire format.
**Spec:** https://github.com/nathapp-io/nax/issues/2696
**Architecture:** Carry an optional enumerated model declaration through config, native mapping, and ResolvedModel. Merge it onto the synthesised backend model compat while preserving all other settings; validate protocol compatibility in both catalogs.
**Tech stack:** TypeScript, Zod, Vitest, Bun.

## Constraints and review focus
- Preserve omitted-field wire bodies and template compatibility settings.
- Reject unsupported protocols with model id and protocol in the message.
- Cover the five proposed format spellings, per-model isolation, routing coexistence, and off/unset/positive levels.
- Keep dependencies, package versions, credentials and general compat configuration unchanged.

## Task 1: Regression coverage
- [x] Add schema acceptance/rejection and native mapping tests.
- [x] Add real backend wire-body tests for qwen-chat-template, legacy Together payloads and routing coexistence.
- [x] Add construction rejection tests for both catalog paths.
- [x] Run new tests and verify expected failures before implementation.

## Task 2: Implement and document
- [x] Add ThinkingFormat to nax-ai and mirror the model field in config types/schema.
- [x] Forward the declaration and validate it in both catalogs.
- [x] Merge it into backend compat conditionally alongside openRouterRouting.
- [x] Document formats, protocol constraint and a self-hosted example next to routing.

## Task 3: Verification
- [x] Run focused regressions, package tests, typechecks and repository gates.
- [x] Review the final diff against all issue acceptance criteria.

## Execution notes
- Initial regression run: 12 expected config/mapping failures and 12 expected backend failures before implementation.
- Independent review found additional backend formats required unexposed prerequisites. Kept the five formats proposed in the issue and rejected explicit OpenAI format when inherited compat disables reasoning_effort. Added regressions and observed failures before those fixes.
- Final focused checks: 590 nax-ai tests and 109 config/mapping tests pass.
- Root `bun run test`: passed all workspace suites, including CLI unit/integration/UI. An earlier run hit seven executor-logging timeouts; the final run passed.
- Root `bun run typecheck` and `bun run check:all`: passed. nax-ai build and nax-agent API snapshot: passed.
- `packages/nax` coverage run: 27,536 passed, 45 skipped, zero failures; 96.40% lines and 94.28% functions. Per-file gate fails on unchanged `src/execution/pid-registry.ts` at 79.03% (80% required). No baseline was relaxed.
- Independent review: no remaining findings after narrowing the enum and guarding suppressed OpenAI reasoning.
