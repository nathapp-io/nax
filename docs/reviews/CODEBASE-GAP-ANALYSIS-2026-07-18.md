# Codebase Gap Analysis — 2026-07-18

> Successor to [CODEBASE-GAP-ANALYSIS-2026-06-19.md](./CODEBASE-GAP-ANALYSIS-2026-06-19.md).
> Produced by a 4-track parallel survey: (1) core execution/orchestration, (2) CLI/UX/config/observability, (3) quality subsystems (review/TDD/verification/acceptance), (4) ecosystem/integrations.
> Snapshot at `main` = `18a1906c` (v0.73.2).

---

## 1. Executive Summary

nax's core loop (pipeline, escalation, checkpoint/resume, worktrees, cost capping, hooks) is mature. The dominant gap pattern is **"backend built, front door missing"**: several complete subsystems are unreachable from the CLI or config, and several config surfaces are schema-valid but have zero runtime consumers. The second pattern is **language-coverage asymmetry**: test *discovery* is polyglot (TS/Py/Go/Rust) but test-output *parsing*, mutation operators, and acceptance fix-diagnosis are effectively TS-first, which contradicts the monorepo-awareness rules the project enforces on itself.

Top 5 findings by impact:

| # | Finding | Type | Severity |
|---|---------|------|----------|
| 1 | `nax interact list/respond/cancel` fully implemented but never registered in `bin/nax.ts` | Dead CLI surface | High |
| 2 | Agent bake-off mode (`src/bakeoff/`) fully implemented per spec, but no `--compare` flag or any CLI wiring exists | Dead feature | High |
| 3 | No coverage-diff / finding-materialization gate — only Phase-0 telemetry (the project's own stated next QA investment) | Missing feature | High |
| 4 | `aider` in `KNOWN_AGENT_NAMES` silently falls back to the `claude` binary (no ACP adapter, Aider doesn't speak ACP) | Silent-fallback bug | Med-High |
| 5 | Acceptance `fix-diagnosis.ts` import parsing is JS/TS-only — non-TS projects get zero source context for fix generation (hallucinated-signature risk) | Language gap | Med-High |

---

## 2. Dead or Unreachable Surface (built but not wired)

| Gap | Evidence | Severity |
|-----|----------|----------|
| **`nax interact` commands unregistered.** `interactListCommand` / `interactRespondCommand` / `interactCancelCommand` exist in `src/cli/interact.ts` and are exported from `src/cli/index.ts:48-55`, but no `program.command("interact")` exists anywhere. Users of the interaction system (webhook/telegram/auto plugins) have no first-party terminal way to see or answer pending requests. | `src/cli/interact.ts`; grep of `bin/nax.ts` | High |
| **Bake-off mode unreachable.** `src/bakeoff/{coordinator,preflight,report,ranking,contestant}.ts` implement `runBakeoff` per `docs/specs/SPEC-agent-bakeoff-mode.md` ("completed-through-phase-6"), but nothing in `src/cli/` imports it and the spec's `--compare` flag is not registered. Bonus bug: the default `runSingleAgent` dep at `src/bakeoff/coordinator.ts:139-143` unconditionally throws `"not implemented"` and is only overridden in tests. | `src/bakeoff/coordinator.ts:139-157` | High |
| **`QueueManager` is orphaned.** `src/queue/manager.ts` (297 lines, priority queue) is referenced only by its barrel and its own test. The real PAUSE/ABORT/SKIP mechanism is the `.queue.txt` protocol in `src/execution/queue-handler.ts` + `src/pipeline/stages/queue-check.ts`, which never touches `QueueManager`. Delete it or wire in its priority ordering. | `src/queue/manager.ts` | Medium |
| **3 of 5 debate stages have zero runtime consumers.** `schemas-debate.ts` defines `plan`, `review`, `acceptance`, `rectification`, `escalation`; only `plan` and `review` (semantic) are read anywhere. `stages.acceptance` / `stages.rectification` / `stages.escalation` appear only in CLI help text. | `src/config/schemas-debate.ts:116-145`; `src/cli/config-descriptions.ts:268-273` | Medium |
| **Cost-rate override plumbing unreachable.** `calculateCost`'s `customRates` param (`src/agents/cost/calculate.ts:28-30`) has no config key; pricing table is a hardcoded "as of 2025-01" snapshot (`src/agents/cost/pricing.ts:8`) that silently drifts and can't be corrected without a release. | `src/agents/cost/` | Medium |
| **`permissionProfile: "scoped"` schema-valid but rejected at load.** `resolveScopedPermissions()` is a stub returning `"safe"` behavior; `loader.ts` throws `CONFIG_SCOPED_PROFILE_UNIMPLEMENTED`. Tracked by #374, spec at `docs/specs/scoped-permissions.md`. | `src/config/permissions.ts:54-66`; `src/config/loader.ts:175,190` | Medium |

---

## 3. Quality-Subsystem Gaps

### 3.1 Review

- **No Phase-1 finding-disposition machinery (High).** The project's own findings doc (`docs/findings/2026-07-17-adversarial-review-goalpost-gating.md` §9) gates the next investment — cross-run finding ledger, commit-the-failing-test materialization, pause-for-human disposition — on Phase-0 coverage-gap telemetry, which shipped (#1337, #1339, `scripts/analyze-coverage-gap.ts`) but is consumed only by manual offline scripts. Nothing automated closes the loop.
- **No security-focused review stance (Medium).** The only "security" handling is a complexity override forcing `three-session-tdd` (`src/config/test-strategy.ts:96`). Adversarial review's stances (input/error-path/abandonment, `src/review/adversarial.ts:1-13`) contain no security lens, and there is no dependency/CVE audit anywhere in the pipeline.
- **Adversarial review is one-shot by design (Medium).** `src/review/adversarial.ts:10` — no debate path, while semantic review has `semantic-debate.ts`. Given adversarial is the oscillation-prone reviewer (US-004, #1335), a second-juror pass is a plausible convergence aid.
- **AC-grounding is still syntactic.** `src/review/ac-quote-validator.ts:126-175` does substring matching (#1033); the new oscillation circuit breaker (`fe5ed1ee`, `src/execution/oscillation-breaker.ts`) pauses deadlocked stories but does not fix the grounding root cause.
- **#1338 residual SSOT drift** noted at `src/config/schemas.ts:264` (partially addressed by `d3527aa3`).

### 3.2 Verification / test-runners (language asymmetry)

- **Output parsing narrower than discovery (Medium).** Discovery covers TS/JS (7 frameworks), Python, Go, Rust (`src/test-runners/detect/framework-defaults.ts`), but `src/test-runners/parser.ts:1-40` has dedicated parsers only for Bun/Jest/Vitest/pytest/go — Rust, Mocha, Jasmine, Playwright, Cypress degrade to generic regex, losing structured failure info exactly where rectification needs it.
- **Mutation testing has no Rust operator table (Low-Med).** `src/verification/mutation/operators.ts:113-121` covers TS/JS/Py/Go only, while `src/analyze/scanner.ts:38` treats Rust as first-class.

### 3.3 Acceptance

- **`fix-diagnosis.ts` is JS/TS-only (Med-High).** `parseImportStatements` (`src/acceptance/fix-diagnosis.ts:9-17`) only matches ES `import ... from` syntax. Python/Go/Rust acceptance failures get zero source files loaded as fix context — a direct blind spot behind hallucinated-signature fixes. Meanwhile the sibling stub-detection in `heuristics.ts` *is* multi-language, an internal inconsistency.

### 3.4 Other

- **Prompt optimizer confirmed no-op/rule-based (Medium).** Default strategy is `"noop"` (`src/optimizer/index.ts:51`); the rule-based variant is four deterministic string ops (`src/optimizer/rule-based.optimizer.ts`). No semantic compression exists despite the "optimizer" pipeline stage.
- **Agent-swap fallback metrics not propagated** into `StoryMetrics.fallback` (`src/agents/manager.ts:217-221`, deferred, #1131).

---

## 4. CLI / UX / Observability Gaps

| Gap | Notes | Severity |
|-----|-------|----------|
| No `nax doctor` | No end-to-end health check (config validity, `~/.nax` perms, agent auth, webhook reachability, per-package mono config sanity). `nax agents` + `nax precheck --light` each cover a slice. | Med-High |
| No `nax runs compare <id1> <id2>` | Registry (`~/.nax/runs/*/meta.json`) supports only `--project/--last/--status`; no date-range, cost-threshold, or cross-run diff despite `replay` reconstructing single-run timelines. | Medium |
| `nax plugins` is list-only | No `install/enable/disable/init`; help text tells users to hand-copy files. Loader already resolves bare npm specifiers, so `plugins install` is low-effort. | Medium |
| TUI is live-run-only | Single view (`src/tui/App.tsx`); no historical-run browser, no in-TUI interaction-request approval (compounds the missing `interact` command). | Low-Med |
| `resume` / `replay` undocumented | Both production-quality but absent from `docs/guides/cli-reference.md`. | Low |
| Cost export limited to one JSON blob | `CostReportV1` via `emitCostReportJson` only; no CSV, trend, or per-feature/week aggregation. | Low |
| No Slack/Discord/desktop interaction plugins | Only `cli`, `telegram`, `webhook`, `auto` (`src/interaction/init.ts:19-32`). | Low-Med |

---

## 5. Ecosystem / Integration Gaps

| Gap | Notes | Severity |
|-----|-------|----------|
| **Aider registry mismatch** | `KNOWN_AGENT_NAMES` includes `aider` (`src/agents/registry.ts:13`) but `AGENT_REGISTRY` (`src/agents/acp/adapter.ts:76-106`) has no entry — it silently falls back to `binary: "claude"`. Aider is not ACP-native, and no non-ACP translation shim exists, so the agent surface only generalizes to ACP-speaking CLIs. | Med-High |
| No issue-tracker import | The idea→run path is entirely local files (`context.md` → spec → `nax plan` → `prd.json`). `IContextProvider` models external context but ships only `feature-context.ts`. No GitHub/GitLab Issues, Jira, or Linear ingestion. | Medium |
| No observability export | Zero hits for OTel/telemetry in `src/`; `IReporter` is interface-only with no built-in implementations. The webhook plugin covers interaction escalation, not run telemetry. | Medium |
| No CI onboarding | Headless mode + JSON status exist, but no `nax init --ci` workflow scaffolding and no SARIF/JUnit exporters — review findings can't surface in GitHub code scanning / GitLab MR widgets. | Medium |
| auto-pr hard-depends on `gh`/`glab` CLIs | `src/plugins/builtin/auto-pr/forge.ts` has no REST/GraphQL fallback; no labels/reviewers/CI-status support. | Low-Med |
| No standalone binary | Build targets Bun runtime only (no `bun build --compile`); npm-only distribution, no Homebrew/apt. | Low-Med |
| No custom pipeline-stage extension point | Plugins can bracket the pipeline (reporters, post-run, hooks) but cannot inject a stage. | Low |
| Constitution generators lag context generators | `src/constitution/generators/` lacks `gemini`/`codex` while `src/context/generators/` has them; `generator.ts:60` stubs section parsing. | Low |

---

## 6. Suggested New Features (ranked)

### Quick wins (small effort, immediate value)

1. **Register `nax interact`** — one `program.command()` block; the implementation already exists.
2. **Wire bake-off `--compare`** — implementation and spec are done; wire `handleRunAction` and replace the throwing `runSingleAgent` default.
3. **Fix or drop `aider`** — remove from `KNOWN_AGENT_NAMES` (or hard-error on selection) until a non-ACP shim exists; silent claude-binary fallback is a footgun.
4. **Config key for cost-rate overrides** (`models.pricing` or similar) — plumbing already accepts `customRates`.
5. **Document `resume`/`replay`** in `cli-reference.md`.
6. **Delete or integrate `QueueManager`**; prune the 3 dead debate stages from the schema (or mark experimental).

### Medium efforts (high leverage)

7. **`nax doctor`** — aggregate health check: config parse, agent binary + auth probe, `~/.nax` layout, mono per-package config validation, webhook/telegram reachability, pricing-table staleness warning.
8. **Phase-1 finding disposition** — the project's own gated roadmap: cross-run finding ledger + commit-the-failing-test materialization + pause-for-human for non-materializable critical findings. The Phase-0 telemetry to justify it is already flowing.
9. **Security review stance** — a dedicated reviewer persona (authN/authZ, injection, secrets, tenancy) alongside adversarial's existing stances, plus an optional dependency/CVE audit stage (`osv-scanner`/`npm audit` wrapper).
10. **Polyglot parity pass** — extend `fix-diagnosis.ts` import parsing to Python/Go/Rust; add Cargo + Playwright/Cypress/Mocha parsers to `test-runners/parser.ts`; add Rust mutation operators. Closes the discovery-vs-understanding asymmetry.
11. **`nax runs compare`** — cost/duration/escalation/outcome diff of two run IDs; the registry and replay data already exist.
12. **`nax plugins install/enable/disable`** — loader already imports bare npm names.
13. **Ship one built-in `IReporter`** (generic per-event webhook or OTel spans) so run telemetry can reach Datadog/Grafana without custom plugin code.

### Larger bets (strategic)

14. **Issue-tracker ingestion** — `nax plan --from-issue <url>` (GitHub/GitLab first; Jira/Linear later) seeding a spec/PRD from a ticket; closes the biggest workflow gap for team adoption.
15. **CI-native mode** — `nax init --ci github|gitlab` workflow scaffolding + SARIF export of review findings + JUnit export of verification results.
16. **Adversarial second-juror / debate path** — extend the existing debate machinery to adversarial review to attack the oscillation and goalpost-gating class at its source (complements, not replaces, the circuit breaker).
17. **Scoped permissions (Phase 2, #374)** — per-stage tool allowlists; currently schema-advertised and load-rejected.
18. **Standalone compiled binary** (`bun build --compile`) + Homebrew tap — removes the Bun prerequisite for CI/Docker adoption.
19. **Semantic prompt optimizer** — replace the no-op default with LLM-based context compression, measured against the token metrics already collected.

---

## 7. Method & Caveats

- Four read-only exploration agents ran in parallel over `src/`, `docs/`, `scripts/`, `bin/`, and `package.json`; findings above carry file:line evidence from that sweep.
- Line numbers are approximate to the 2026-07-18 snapshot and will drift.
- "Dead surface" claims are grep-based (no non-test consumers found); confirm with the team before deleting anything (`QueueManager`, debate stages) in case of in-flight branches.
- The 2026-06-19 analysis's HIGH finding (`setup-write.ts` stub) is confirmed resolved; its scoped-permissions and structured-parser MED findings remain open and are re-reported here.
