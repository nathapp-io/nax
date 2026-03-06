# FEAT-012 — TDD Test Writer Tier Validation

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

nax TDD runs two sessions: **testWriter** then **implementer**. The testWriter tier is configured separately (`tdd.sessionTiers.testWriter`, default `"balanced"`). The implementer uses the story's routed `modelTier`.

**Risk:** If testWriter runs `"fast"` and the implementer runs `"powerful"`, the tests written may be too shallow — they test happy paths but miss edge cases a powerful model's implementation handles. Result: powerful implementer writes sophisticated code, all tests pass (trivially), then the deferred regression gate catches real failures.

---

## 2. Tier Ordering

```
fast (1) < balanced (2) < powerful (3)
```

**Invariant:** `testWriterTier >= implementerTier`

---

## 3. Validation Logic

In `src/tdd/session-runner.ts` before launching testWriter:

```typescript
const tierOrder = { fast: 1, balanced: 2, powerful: 3 };
const writerTier = config.tdd.sessionTiers?.testWriter ?? "balanced";
const implementerTier = story.routing.modelTier ?? "balanced";

if (tierOrder[writerTier] < tierOrder[implementerTier]) {
  if (config.tdd.enforceWriterTierParity) {
    effectiveWriterTier = implementerTier; // auto-elevate
    logger.warn("tdd", `Auto-elevated testWriter tier ${writerTier} → ${implementerTier}`);
  } else {
    logger.warn("tdd", `testWriter tier (${writerTier}) < implementer tier (${implementerTier}) — tests may be shallow`);
  }
}
```

---

## 4. Config Changes

```jsonc
{
  "tdd": {
    "sessionTiers": { "testWriter": "balanced", "verifier": "fast" },
    "enforceWriterTierParity": false   // NEW — auto-elevates testWriter when true
  }
}
```

`nax config --explain`: *"testWriter tier should be ≥ implementer tier. Enable enforceWriterTierParity to auto-elevate."*

---

## 5. Files Affected

| File | Change |
|---|---|
| `src/tdd/session-runner.ts` | Tier comparison + warn/elevate logic |
| `src/config/schemas.ts` | Add `tdd.enforceWriterTierParity` (boolean, default false) |
| `src/config/types.ts` | Add `enforceWriterTierParity` to `TddConfig` |
| `src/config/defaults.ts` | Default: `false` |

---

## 6. Test Plan

- `writerTier < implementerTier`, `enforceWriterTierParity: false` → warning logged, tier unchanged
- `writerTier < implementerTier`, `enforceWriterTierParity: true` → tier elevated, warning logged
- `writerTier >= implementerTier` → no warning, no change
