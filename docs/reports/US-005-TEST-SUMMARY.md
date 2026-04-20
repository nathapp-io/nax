# US-005: Plugin Routing Integration - Test Summary

**Story:** Plugin routing strategies integrate into router chain

**Test File:** `test/integration/plugin-routing.test.ts`

**Status:** ✅ Tests written and failing (as expected)

---

## Test Coverage

### AC1: Plugin routers are tried before the built-in routing strategy

**Tests (4):**
- ✅ Plugin routers execute before built-in keyword strategy
- ✅ Multiple plugin routers maintain load order
- ✅ Plugin routers are inserted before manual strategy
- ✅ Plugin routers are inserted before llm strategy

**Coverage:** Validates that plugin routers are prepended to the strategy chain and execute in load order before any built-in strategies.

---

### AC2: First plugin router that returns a non-null result wins

**Tests (5):**
- ✅ First plugin router decision is used
- ✅ Second plugin router is used when first returns null
- ✅ Plugin router overrides built-in keyword strategy
- ✅ Third plugin router is used when first two return null
- ✅ Plugin router can delegate based on conditional logic (integration test)

**Coverage:** Validates the chain precedence rules where the first non-null decision wins, and tests realistic scenarios where plugins selectively handle certain stories.

---

### AC3: If all plugin routers return null, built-in strategy is used as fallback

**Tests (4):**
- ✅ Keyword strategy is used when all plugin routers return null
- ✅ Keyword strategy handles complex story when plugins return null
- ✅ Manual strategy is used as fallback when plugins return null
- ✅ Empty plugin registry falls back to keyword strategy

**Coverage:** Validates that the chain properly falls through to built-in strategies (keyword, manual) when all plugin routers return null or when no plugins are loaded.

---

### AC4: Plugin routers receive the same story context as built-in routers

**Tests (5):**
- ✅ Plugin router receives story object
- ✅ Plugin router receives routing context with config
- ✅ Plugin router receives codebase context when available
- ✅ Plugin router receives metrics when available
- ✅ Multiple plugin routers receive same context

**Coverage:** Validates that plugin routers receive the complete `UserStory` and `RoutingContext` objects, including optional fields like `codebaseContext` and `metrics`.

---

### AC5: Router errors are caught and logged; fallback to next router in chain

**Tests (6):**
- ❌ Error in plugin router is caught and next router is tried
- ❌ Error in plugin router is logged
- ❌ Multiple router errors are caught and keyword fallback succeeds
- ❌ Async error in plugin router is caught
- ❌ Error in last plugin router falls back to keyword strategy
- ❌ Error message includes plugin name for debugging

**Coverage:** Validates that errors thrown by plugin routers don't crash the routing system and that proper error logging occurs with router names for debugging.

**Status:** Currently failing (expected) - error handling not yet implemented in `StrategyChain.route()`

---

## Integration Tests

**Real-world scenarios (6):**
- ✅ Premium plugin forces security stories to expert tier
- ✅ Cost-optimization plugin downgrades simple docs to fast tier
- ✅ Domain-specific plugin routes database migrations to expert tier
- ✅ Multiple plugins: first matching plugin wins
- ✅ Plugin router can delegate based on conditional logic (duplicate coverage)

**Coverage:** Tests realistic plugin use cases that demonstrate the value of the plugin router system.

---

## Test Results

```
 22 pass
 6 fail
 54 expect() calls
Ran 28 tests across 1 file.
```

**Passing Tests (22):** Plugin router chain integration, precedence, fallback, and context passing all work correctly with the current implementation.

**Failing Tests (6):** All failures are in AC5 (error handling). The errors are propagating instead of being caught, logged, and triggering fallback to the next router.

---

## Implementation Gaps

The tests reveal that the following needs to be implemented:

1. **Error handling in `StrategyChain.route()`** (`src/routing/chain.ts:38-44`)
   - Wrap each `strategy.route()` call in try-catch
   - Log errors with strategy name
   - Continue to next strategy on error

2. **Error logging with plugin context**
   - Include plugin router name in error logs
   - Use `getSafeLogger()` to log routing errors
   - Log at error level with category "routing"

---

## Next Steps for Implementer

1. Modify `src/routing/chain.ts` to wrap `strategy.route()` in try-catch
2. Add error logging that includes strategy name
3. Continue chain iteration on error (same as null return)
4. Run tests: `bun test ./test/integration/plugin-routing.test.ts`
5. All 28 tests should pass after implementation

---

## Notes

- Tests use mock plugins with custom routing logic
- Tests verify both sync and async router error handling
- Tests validate error log messages include router names for debugging
- Integration tests demonstrate realistic plugin use cases (security enforcement, cost optimization, domain-specific routing)
