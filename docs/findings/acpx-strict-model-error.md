# acpx 0.6.1 — Strict `--model` Validation: Error Mapping & Early Check

**Parent:** [2026-04-26-acpx-0.6.x-adapter-opportunities.md](./2026-04-26-acpx-0.6.x-adapter-opportunities.md)
**Priority:** High (defensive)
**Effort:** S

## What changed in acpx

From the 0.6.1 changelog:

> CLI/models: fail clearly when `--model` targets a non-Claude ACP agent that does not advertise ACP model support, and reject model ids outside an adapter's advertised `availableModels` instead of silently falling back to the adapter default.

Before 0.6.1: an unknown model id silently fell back to the adapter default. After 0.6.1: acpx errors out.

## Why we care

[src/agents/acp/spawn-client.ts:137-138](../../src/agents/acp/spawn-client.ts#L137-L138) always passes `--model <model>` to the `prompt` subcommand. The model string comes from `resolveModelForAgent(config.models, agentName, tier, defaultAgent)`. Mis-resolution that previously "worked" (silent fallback) will now hard-fail.

Risks:

- A user adds a new tier mapping with a typoed model id → every prompt fails until they spot it.
- Adapter-specific model lists drift from our static config — Codex adds/removes models faster than our config catches up.
- The failure surfaces as a generic acpx exit-code-1 with stderr; today our `parse-agent-error.ts` may not classify it cleanly, leading to confused escalation/rectification.

## Proposed change

### A. Error classification

Update [src/agents/acp/parse-agent-error.ts](../../src/agents/acp/parse-agent-error.ts) to recognise the strict-model rejection pattern (exact strings TBD — capture from a deliberate misuse run against acpx 0.6.1) and map it to a dedicated error code:

- New code: `ACP_MODEL_NOT_AVAILABLE` (or align with whatever acpx surfaces).
- Mark as **non-retryable** — a tier escalation will not help if the configured model literally does not exist.
- Surface a remediation hint pointing at the agent's `availableModels` (acpx exposes this — confirm via `acpx <agent> --help` or `acpx <agent> models`).

### B. Early validation — DEFERRED

Add a fast pre-flight check in the model-resolution layer (likely [src/agents/shared/model-resolution.ts](../../src/agents/shared/model-resolution.ts) — verify path) so we fail before spawning:

- At config load (or first adapter use), ask acpx for each agent's `availableModels` once and cache.
- If `resolveModelForAgent()` returns a model id not in that set, throw `NaxError("MODEL_NOT_AVAILABLE", { agent, model, available })`.
- If acpx itself does not yet expose a programmatic models query, defer this to a follow-up and rely solely on (A).

**Deferred 2026-04-26**: acpx does not yet expose a stable programmatic `availableModels` query outside of `session/new` response data. Implementing (B) would require a one-shot session just to probe the model list. Deferred until acpx exposes a lighter-weight models query (e.g. `acpx <agent> models`). Part (A) is implemented and provides sufficient coverage for the 0.6.1 regression risk.

### C. Tests

- Unit: `parse-agent-error.ts` recognises the new error string → returns `{ code: ACP_MODEL_NOT_AVAILABLE, retryable: false }`.
- Integration (real acpx): pass a known-bad model id, assert clean error surface.
- Optional: snapshot `acpx <agent> models` output if such a command exists.

## Open questions

- What is the exact stderr text acpx 0.6.1 emits? Need to capture verbatim before writing the regex.
- Does acpx expose a non-JSONRPC way to query `availableModels` per agent? If yes, (B) is cheap; if no, defer.
- Should we degrade gracefully (warn + send anyway) for non-Claude agents whose model lists may be stale, or fail hard? Lean fail-hard — silent fallback is exactly what acpx removed.

## Acceptance criteria

- [ ] `parse-agent-error.ts` returns a stable `code` for the strict-model error.
- [ ] Unit test covering the parser branch.
- [ ] If feasible, early validation throws `NaxError` before spawning acpx.
- [ ] Docs: short note in [docs/architecture/agent-adapters.md](../../docs/architecture/agent-adapters.md) about the 0.6.1 behaviour change.
