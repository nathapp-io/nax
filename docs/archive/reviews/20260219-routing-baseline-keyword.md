# Keyword Routing Baseline — Config-Loader Dogfood

> Recorded from Run D + Run D2 (2026-02-19) for comparison with LLM routing.

## Run D (US-001 to US-007)

| Story | Title | Classified | Model | Test Strategy | Routing Reason | Cost | Status |
|:---|:---|:---|:---|:---|:---|:---|:---|
| US-001 | Define core types and error handling | simple | balanced | test-after | simple task (medium) | ~$0.08 | ✅ |
| US-002 | Implement environment variable interpolation | medium | balanced | test-after | simple task (medium) | ~$0.08 | ✅ |
| US-003 | Implement deep merge utility | medium | balanced | test-after | simple task (medium) | ~$0.08 | ✅ |
| US-004 | Implement config file discovery | simple | balanced | test-after | simple task (medium) | ~$0.08 | ✅ |
| US-005 | Implement synchronous config loader | medium | balanced | test-after | simple task (medium) | ~$0.10 | ✅ |
| US-006 | Implement async config loader | medium | balanced | test-after | simple task (medium) | ~$0.10 | ✅ |
| US-007 | Implement config file watcher | complex | powerful | three-session-tdd | complexity:expert | — | ❌ TDD failure (BUG-20) |

**Run D total: $0.65, 6/9 passed, 174 tests, 9.8 min**

## Run D2 (US-007 to US-009, resumed)

| Story | Title | Classified | Model | Test Strategy | Routing Reason | Cost | Status |
|:---|:---|:---|:---|:---|:---|:---|:---|
| US-007 | Implement config file watcher | complex | powerful | three-session-tdd | complexity:expert | $1.74 | ✅ |
| US-008 (attempt 1) | Export public API and create barrel exports | simple | powerful | three-session-tdd | public-api, complexity:complex | $1.26 | ✅ but ASSET_CHECK failed |
| US-008 (attempt 2) | Export public API and create barrel exports | simple | powerful | three-session-tdd | public-api, complexity:complex | $1.21 | ✅ |
| US-009 | Comprehensive integration tests and documentation | medium | powerful | three-session-tdd | complexity:complex | $4.95 | ⏸ Human review (verifier issues) |

**Run D2 total: $4.20 (completed) + $4.95 (US-009 paused) = ~$9.15, 41.4 min**

## Misroute Analysis

| Story | Keyword Route | Ideal Route | Wasted Cost |
|:---|:---|:---|:---|
| US-008 | powerful + three-session-tdd ($2.47 over 2 attempts) | fast + test-after (~$0.10) | **~$2.37** |
| US-009 | powerful + three-session-tdd ($4.95) | balanced + test-after (~$0.20) | **~$4.75** |

**Total misroute waste: ~$7.12** (77% of Run D2 spend)

### Why Keyword Routing Failed

**US-008:** Title "Export **public API** and create barrel exports" matches `PUBLIC_API_KEYWORDS` → forces TDD. But this is just creating `index.ts` barrel files — no logic, no contracts, no breaking changes. A 2-minute task got 3-session TDD with Opus.

**US-009:** "Comprehensive **integration tests** and documentation" — classified as medium by AC count, but routing reason says `complexity:complex`. The word "comprehensive" + AC count likely pushed it. Also got TDD despite the story literally being "write tests" — TDD for writing tests is circular.

### Expected LLM Routing (to validate later)

| Story | Expected LLM Route | Expected Cost |
|:---|:---|:---|
| US-001 | fast / test-after | ~$0.05 |
| US-002 | fast / test-after | ~$0.05 |
| US-003 | fast / test-after | ~$0.05 |
| US-004 | fast / test-after | ~$0.05 |
| US-005 | balanced / test-after | ~$0.10 |
| US-006 | balanced / test-after | ~$0.10 |
| US-007 | powerful / three-session-tdd | ~$1.50 |
| US-008 | fast / test-after | ~$0.05 |
| US-009 | balanced / test-after | ~$0.15 |

**Expected total with LLM routing: ~$2.10** vs actual $9.80 (Run D + D2)

---

*Recorded 2026-02-19 for A/B comparison with v0.8 LLM routing.*
