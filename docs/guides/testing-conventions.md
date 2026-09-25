# Testing Conventions

This document defines size and quality standards for test files in the nax project.

## File Size Limits

Test files must respect the following size constraints:

| Limit | Lines | Action |
|-------|-------|--------|
| **Soft Limit** | 500 | Review guideline — not gated |
| **Hard Limit** | 800 | `bun run lint` fails for new files over the limit and for grandfathered files that grow |

Source files (`src/**/*.ts`) have a 600-line hard limit enforced by the same check.

### Rationale

Test files exceeding these limits become difficult to navigate and maintain. Large test files indicate:
- Test logic should be split across multiple files
- Setup/helper code should be extracted to `test/helpers/`
- Test cases may be duplicated and could benefit from consolidation

## Checking Test File Sizes

Run the size checker with:

```bash
bun run check:file-sizes
```

This script (`scripts/check-file-sizes.ts`):
- Scans `src/**/*.ts` (600-line limit) and `test/**/*.test.ts` (800-line limit)
- Ratchets against `scripts/baselines/file-sizes-baseline.json`: files already over the limit are grandfathered but may not grow, and new files must be under the limit
- Runs inside `bun run lint` (via `lint:checks`), so CI and the pre-commit hook (`.githooks/pre-commit`, which runs `check:all`) both enforce it

There is no bypass flag — split the file instead.

### Example Output

```
ERROR: file-size hard limit breached (see .claude/rules/project-conventions.md).

New files over the limit (600 src / 800 test) — split before merging:
  test/unit/large.test.ts: 820 lines (limit 800)

Grandfathered files that GREW past their recorded size — do not add more code:
  test/unit/legacy.test.ts: 910 lines (was 900, limit 800)
```

## Reducing Test File Size

When a test file exceeds the soft limit, consider these strategies:

### 1. Use `test.each()` for Parametric Tests

**Before:** Duplicated test cases
```typescript
test("adds positive numbers", () => {
  expect(add(1, 2)).toBe(3);
  expect(add(10, 20)).toBe(30);
  expect(add(100, 200)).toBe(300);
});

test("adds negative numbers", () => {
  expect(add(-1, -2)).toBe(-3);
  expect(add(-10, -20)).toBe(-30);
});
```

**After:** Consolidated with `test.each()`
```typescript
test.each([
  [1, 2, 3],
  [10, 20, 30],
  [100, 200, 300],
  [-1, -2, -3],
  [-10, -20, -30],
])("adds %i + %i = %i", (a, b, expected) => {
  expect(add(a, b)).toBe(expected);
});
```

**Benefits:** Reduces line count, improves readability, easier to add test cases.

### 2. Split by `describe()` Block

When a test file has multiple logical concerns, split it into separate files:

```
Before:
test/unit/routing/router.test.ts (850 lines)
  - describe("route matching") { ... 400 lines ... }
  - describe("route building") { ... 300 lines ... }
  - describe("error handling") { ... 150 lines ... }

After:
test/unit/routing/router-match.test.ts (400 lines)
test/unit/routing/router-build.test.ts (300 lines)
test/unit/routing/router-errors.test.ts (150 lines)
```

Keep split files in the same mirrored directory as the source file, and preserve the source filename as the module prefix.

### 3. Extract Helper Logic

Move repeated setup and mock factories to `test/helpers/`:

**Before:** Test file with repeated setup
```typescript
describe("user creation", () => {
  let mockDb: any;
  let mockLogger: any;

  beforeEach(() => {
    mockDb = { save: mock(() => Promise.resolve({ id: "123" })) };
    mockLogger = { info: mock(), error: mock() };
  });

  test("creates user with valid data", () => { ... });
  test("logs on creation", () => { ... });
  test("handles db errors", () => { ... });
});
```

**After:** Extract to helper
```typescript
// test/helpers/user-factory.ts
export function createMockUserService() {
  return {
    mockDb: { save: mock(() => Promise.resolve({ id: "123" })) },
    mockLogger: { info: mock(), error: mock() },
  };
}

// test/unit/user-service.test.ts
describe("user creation", () => {
  const { mockDb, mockLogger } = createMockUserService();
  test("creates user with valid data", () => { ... });
  test("logs on creation", () => { ... });
  test("handles db errors", () => { ... });
});
```

## Continuous Monitoring

`bun run check:file-sizes` runs as part of `bun run lint`, so the hard limits are enforced in CI
and by the pre-commit hook. For local development:

```bash
# Run the size check on its own
bun run check:file-sizes

# List every oversized file, grandfathered or not
bun run scripts/check-file-sizes.ts --list
```

After splitting a grandfathered file, lower the baseline with
`bun run check:file-sizes:update`.

## See Also

- `.nax/rules/test-architecture.md` — Test directory structure and file placement (generated copy in `.claude/rules/`)
- `.nax/rules/test-writing.md` — What a test must assert to count
- `.nax/rules/test-ratchets.md` — Escape-hatch and coverage baselines
- `docs/guides/testing-rules.md` — Test writing source of truth
- `docs/architecture/ARCHITECTURE.md` — General code size and design conventions
