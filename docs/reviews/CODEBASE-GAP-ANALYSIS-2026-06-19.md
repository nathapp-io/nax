# nax — Codebase Gap Analysis

**Date:** 2026-06-19
**Scope:** `src/` (653 files), `test/` (834 files), `docs/` (220 files, 22 ADR files)
**Method:** 5 parallel exploration passes (incomplete code, test coverage, documentation, tracked tech-debt/rule violations, architectural wiring) + direct verification of key claims.

> **Headline:** The codebase is architecturally complete and well-tested in its core paths. "What's missing" is concentrated in five areas: a handful of genuine stubs (scoped permissions, structured test parsing, `setup-write`), file-size hard-limit breaches, stale documentation (CLAUDE.md, ADRs), duplicated/dead modules, and the absence of any coverage tooling despite a stated 80% requirement.

---

## 1. Severity Summary

| # | Finding | Severity | Effort |
|:--|:--------|:--------:|:------:|
| 1 | `story-orchestrator.ts` (1462 LOC) + its test (1734 LOC) — 2.4×/2.2× over hard limit | **HIGH** | L |
| 2 | Scoped permission profile is a non-functional Phase-2 stub | **HIGH** | M |
| 3 | `setup-write.ts` `writeSetupConfig()` throws "not implemented", no callers | **HIGH** | M |
| 4 | No test coverage tooling at all (vs. stated 80% rule) | **HIGH** | S |
| 5 | Structured test-output parsing (pytest / go test) deferred — 4 TODOs | **MED** | M |
| 6 | CLAUDE.md documents removed `src/agents/claude/` CLI adapter (ACP-only now) | **MED** | S |
| 7 | Duplicate logging subsystems: `src/logger/` **and** `src/logging/` | **MED** | M |
| 8 | 11 more source files over 600-line limit; 4 more tests over 800 | **MED** | L |
| 9 | 15+ src subsystems have no architecture doc; duplicate ADR-014; missing ADR-001–004 | **MED** | M |
| 10 | Thin/zero unit coverage in optimizer, session-manager extracts, ACP output parsing, review parsers | **MED** | M |
| 11 | `console.log/error` outside CLI boundary (precheck, logger fallback) | **LOW** | S |
| 12 | Misleading "STUB"/"placeholder" headers on fully-implemented files | **LOW** | S |
| 13 | Empty catch swallows file-read errors in `test-scanner.ts:312` | **LOW** | S |

---

## 2. Genuine Incomplete Implementations

### 2.1 Scoped permission profile — HIGH
`src/config/permissions.ts` — `resolveScopedPermissions()` is a Phase-2 stub returning `{ mode: "approve-reads", skipPermissions: false }` (identical to `safe`). The `allowedTools?: string[]` field is declared but never populated.

**Impact:** `execution.permissionProfile: "scoped"` silently behaves like `safe`. A user who sets it believes they have tool-scoped permissions but does not. Either implement Phase 2 or reject the value at config-parse time until it lands.

### 2.2 `setup-write.ts` — HIGH
`src/cli/setup-write.ts:14` — `writeSetupConfig()` is `throw new Error("not implemented")` and has **no callers anywhere in `src/`**. Dead orphan stub: either wire it up or remove it.

### 2.3 Structured test-output parsing — MED
`src/test-runners/parser.ts:10-11, 261-262, 301-302` — pytest and `go test` fall back to the common heuristic regex parser; structured error/stack extraction is `TODO`. Reduces failure-diagnosis quality for Python/Go monorepo packages (a core polyglot promise of nax).

### 2.4 `init-context.ts` injected LLM — MED
`src/cli/init-context.ts:55` — `_initContextDeps.callLLM()` throws "callLLM not implemented"; it is a DI seam meant to be overridden by callers. Confirm every production caller injects a real `callLLM`, or it will fail at runtime.

### 2.5 Constitution section parsing — LOW
`src/constitution/generator.ts:60` — `sections: {}, // TODO: implement section parsing if needed`. Markdown loads fine; structured section access unavailable. Likely intentional ("if needed").

### 2.6 Silent error swallow — LOW
`src/context/test-scanner.ts:312` — empty `} catch {}` hides file-I/O errors during the glob scan. Add a `logger.debug` with `storyId`/`packageDir`.

---

## 3. File-Size Hard-Limit Breaches

Project rule: **600-line hard limit (source), 800 (test)** — "split before adding more code."

### Source (>600)
| File | LOC | Over |
|:-----|---:|---:|
| `src/execution/story-orchestrator.ts` | 1462 | **+862** |
| `src/prompts/builders/rectifier-builder.ts` | 902 | +302 |
| `src/agents/manager.ts` | 820 | +220 |
| `src/agents/acp/spawn-client.ts` | 737 | +137 |
| `src/session/manager.ts` | 707 | +107 |
| `src/execution/unified-executor.ts` | 689 | +89 |
| `src/operations/call.ts` | 631 | +31 |
| `src/agents/acp/adapter.ts` | 629 | +29 |
| `src/config/runtime-types.ts` | 626 | +26 |
| `src/review/adversarial.ts` | 622 | +22 |
| `src/context/engine/providers/code-neighbor.ts` | 613 | +13 |
| `src/execution/post-run.ts` | 607 | +7 |

### Test (>800)
| File | LOC | Over |
|:-----|---:|---:|
| `test/unit/execution/story-orchestrator.test.ts` | 1734 | **+934** |
| `test/unit/cli/plan.test.ts` | 1087 | +287 |
| `test/unit/debate/runner-plan.test.ts` | 1048 | +248 |
| `test/unit/execution/escalation/tier-escalation.test.ts` | 948 | +148 |
| `test/unit/operations/plan-refine.test.ts` | 818 | +18 |

**Priority:** `story-orchestrator.ts` is the clear outlier and the orchestration hub — split by concern (CANONICAL_ORDER stages vs. fix cycle vs. wiring). No lint rule currently enforces the limit; consider a `scripts/check-file-sizes.ts` gate so the baseline cannot grow.

---

## 4. Duplication & Dead Code

- **Two logging subsystems:** `src/logger/` (`logger.ts`, `formatters.ts`, `redact.ts`, `types.ts`) and `src/logging/` (`formatter.ts`, `types.ts`). The project standard cites `src/logger`. `src/logging/` looks like a leftover/parallel implementation — confirm which is canonical and delete or merge the other. Singleton-fragmentation risk if both are imported.
- **`writeSetupConfig`** — orphan stub (see §2.2).

---

## 5. Stale / Inconsistent Documentation

- **CLAUDE.md is stale on the agent adapter.** It documents two protocol modes ("CLI and ACP") and a `src/agents/claude/` directory. **Verified: that directory does not exist** — the registry hard-codes `protocol: "acp"` (`src/agents/registry.ts:50`) and the config schema only accepts `"acp"`. Update the "Agent Adapter & LLM Calls" section and the `src/agents/claude/` row in the directory table.
- **ADR hygiene:**
  - Missing **ADR-001–004** (sequence starts at 005) with no explanation.
  - **Duplicate ADR-014**: `ADR-014-runscope-and-middleware.md` and `ADR-014-runscope-and-operation-standardization.md` (both rejected, superseded by ADR-018) — collapse to one with a historical note.
  - **ADR-006 / ADR-009** still read as "proposed" though their decisions are in force (ADR-009's test-pattern SSOT is implemented and its tracked violations are resolved — see §6). Finalize their status.
- **Architecture doc coverage:** 15+ `src/` subsystems have no dedicated architecture doc — notably `agents/`, `config/`, `runtime/`, `logger`/`logging`, `cli/`, `commands/`, `optimizer/`, `plan/`, `precheck/`, `project/`. Consider one "remaining subsystems" overview rather than 15 stubs.
- **Index gap:** `docs/architecture/spec-to-prd-pipeline.md` exists but isn't linked from `ARCHITECTURE.md`.

---

## 6. Tracked Tech Debt — Status

The "Known Violations (2026-04-18)" table in `.claude/rules/monorepo-awareness.md` is **stale in a good way**: all four code violations appear **resolved**.

| Issue | Site | Status |
|:------|:-----|:------:|
| #533 | `context/test-scanner.ts` hardcoded test dirs | Resolved |
| #534 | `verification/smart-runner.ts` hardcoded layout | Resolved |
| #535 | `context/builder.ts` cwd fallback | Resolved |
| #536 | `prompts/sections/role-task.ts` `startsWith("bun test")` | Resolved (now uses `buildTestFrameworkHint()`) |
| #530 | descriptor absolute-path migration | Design item, still open |

**Action:** update/retire the table so it doesn't mislead. ~40 `#NNN` issue refs remain in source comments (e.g. #1131 agent-swap metrics, #993 disk recovery, #1116 regression timeout) tracking genuine but non-blocking follow-ups.

**Compliant (no violations found):** `process.cwd()` outside CLI, `mock.module()`, `setTimeout`-for-delay (all paired with `clearTimeout`), real-home `.nax` paths. `as any` appears only twice; zero `@ts-ignore`.

---

## 7. Test Coverage Gaps

**No coverage tooling exists.** `package.json` has no `--coverage` script and no threshold gate, despite the stated 80% requirement. This is the single highest-leverage fix: add `bun test --coverage` with a CI threshold so the rest of this section becomes measurable rather than estimated.

Overall ratio ~1.28 tests:source. Well-covered: `execution/` (~2.1:1), `tdd/` (~3:1), `config/` (~1.9:1), `operations/` (~1.5:1).

Thin or zero **isolated** coverage:
- **`src/optimizer/`** — ~0.25:1; `rule-based.optimizer.ts` core logic untested.
- **`src/session/`** — recently-extracted `manager-deps.ts`, `manager-sweep.ts`, `session-runner.ts` lack dedicated tests.
- **`src/agents/acp/`** — `adapter-output.ts` (the agent-output parsing integration point), `adapter-session-types.ts`, `wire-types.ts`.
- **`src/review/lint-parsing` & `typecheck-parsing`** — only `biome-json` has a dedicated test; `eslint-json`, `ruff-annotated`, `tsc`, `text-block` parsers untested (polyglot risk).
- **`src/context/engine/`** — `available-budget.ts`, `render-utils.ts`.
- **`src/tui/hooks`** — hook implementations not unit-tested in isolation.
- **E2E** — 6 journeys (happy-path, agent-fix, mechanical-fix, exhaustion-edge, scripted-agent, harness). Gaps: multi-story parallel runs, worktree execution, escalation-to-exhaustion across tiers, error-recovery paths.

---

## 8. Quick Wins (recommended order)

1. **Add coverage tooling** + CI threshold (`bun test --coverage`). Small, unblocks everything else. *(§7)*
2. **Fix or reject scoped permissions** so it can't silently degrade to `safe`. *(§2.1)*
3. **Update CLAUDE.md** — remove CLI-adapter / `src/agents/claude/` references. Cheap, prevents agent confusion (it's loaded into every session). *(§5)*
4. **Resolve the duplicate logging dir** — pick canonical, delete the other. *(§4)*
5. **Add a file-size lint gate** and split `story-orchestrator.ts`. *(§3)*
6. **Refresh the Known-Violations table** (mark #533–536 resolved). *(§6)*
7. **Land structured test parsers** for pytest/go test. *(§2.3)*

---

## 9. What's Healthy (for balance)

- All **6 plugin extension points** are loaded and invoked — no dead seams.
- All **10 pipeline stages** registered and run; tier escalation (fast→balanced→powerful) fully implemented.
- **60+ operations** exported and used; dispatch flows through the middleware chain per ADR-019/020.
- Permission SSOT (`resolvePermissions`) is honored — no hardcoded `?? true`/`approve-all` fallbacks.
- Error handling (`NaxError` + cause chaining), Bun-native API usage, and barrel-import discipline are consistently applied.

---

*Generated from a 5-way parallel codebase analysis. File:line citations are point-in-time (HEAD `fd1e0cf5`); verify before acting on any single item.*
