# FEAT-013 — Deprecate test-after from auto routing

## Decision
Remove `test-after` as the default fallback in `auto` mode.
Change simple/medium stories to route to `three-session-tdd-lite` instead.

## Why
- `test-after` has high test failure rate — tests rubber-stamp implementation rather than driving design
- Failed test-after stories escalate to powerful tier anyway → costs more in the end
- `three-session-tdd-lite` = better quality at moderate cost increase

## New auto routing decision tree
```
security/public-api keywords  → three-session-tdd
complex/expert complexity     → three-session-tdd (or lite if ui/cli tags)
simple/medium (default)       → three-session-tdd-lite  ← was test-after
```

## Backward compatibility
- `tddStrategy: "off"` in config still routes to `test-after` (explicit opt-in)
- `tddStrategy: "strict"` → three-session-tdd (unchanged)
- `tddStrategy: "lite"` → three-session-tdd-lite (unchanged)
