# Phase 4: Cleanup & Minor Fixes (MEDIUM + LOW priority)

**Branch:** `feat/code-audit` (continue from current HEAD)
**Estimated effort:** 3–4 hours
**Risk:** Low

---

## Task 4.1: Verify `llm.ts` setTimeout cancellation (MEDIUM, 30 min)

**File:** `src/routing/strategies/llm.ts`

Check all `setTimeout` calls have corresponding `clearTimeout` on every exit path (success, error, early return). Fix any missing cleanup.

**Commit:** `fix(routing): ensure clearTimeout on all llm.ts exit paths`

---

## Task 4.2: Extract shared JSON file I/O utility (MEDIUM, 1 hr)

Multiple files implement independent JSON read/write patterns. Create:

**New file:** `src/utils/json-file.ts`
```typescript
export async function loadJsonFile<T>(path: string): Promise<T | null>
export async function saveJsonFile<T>(path: string, data: T): Promise<void>
```

Find all files that do `Bun.file(path).json()` with try/catch + `Bun.write(path, JSON.stringify(...))` and replace with the shared utility.

**Commit:** `refactor(utils): extract shared json-file read/write utility`

---

## Task 4.3: Spot-check magic numbers (MEDIUM, 1 hr)

Check these files for inline numeric/string literals that should be named constants:
- `src/review/runner.ts`
- `src/execution/crash-recovery.ts`

Extract any magic numbers to named constants at the top of the file or in a shared constants file.

**Commit:** `refactor: extract magic numbers to named constants`

---

## Task 4.4: Cosmetic `existsSync` import swap (LOW, 30 min)

In 18 files, change:
```typescript
import { existsSync } from "node:fs";
```
to:
```typescript
import { existsSync } from "bun";
```

**Files:** metrics/tracker.ts, context/generator.ts, context/injector.ts, config/loader.ts, constitution/loader.ts, constitution/generator.ts, verification/runners.ts, execution/pid-registry.ts, hooks/runner.ts, analyze/scanner.ts, precheck/checks-warnings.ts, cli/analyze.ts, cli/init.ts, cli/analyze-parser.ts, cli/generate.ts, cli/config.ts, cli/plan.ts, commands/precheck.ts

Can be done with sed:
```bash
cd src && grep -rl 'from "node:fs"' --include='*.ts' | while read f; do
  # Only replace if the only import from node:fs is existsSync
  if grep -q 'import { existsSync } from "node:fs"' "$f"; then
    sed -i 's/import { existsSync } from "node:fs"/import { existsSync } from "bun"/' "$f"
  fi
done
```

**Important:** Some files import BOTH existsSync AND other node:fs APIs (mkdirSync, etc.). Only change files where existsSync is the ONLY import from node:fs. Leave mixed imports alone.

**Commit:** `refactor: import existsSync from bun instead of node:fs`

---

## Completion Checklist

- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun test` — no regressions
- [ ] Do NOT push to remote
