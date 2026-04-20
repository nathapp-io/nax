# Testing Conventions

This document defines size and quality standards for test files in the nax project.

## File Size Limits

Test files must respect the following size constraints:

| Limit | Lines | Action |
|-------|-------|--------|
| **Soft Limit** | 500 | ⚠ Warning printed during checks |
| **Hard Limit** | 800 | ✗ Build fails (unless `NAX_SKIP_PRECHECK=1`) |

### Rationale

Test files exceeding these limits become difficult to navigate and maintain. Large test files indicate:
- Test logic should be split across multiple files
- Setup/helper code should be extracted to `test/helpers/`
- Test cases may be duplicated and could benefit from consolidation

## Checking Test File Sizes

Run the size checker with:

```bash
bun run check:test-sizes
```

This script:
- Scans all files matching `test/**/*.test.ts`
- Lists files exceeding the soft limit (500 lines)
- Fails the build if any file exceeds the hard limit (800 lines)
- Respects `NAX_SKIP_PRECHECK=1` to suppress the hard-limit failure

### Example Output

```
# Test File Size Report

Generated: 2026-03-10T10:05:46.365Z

Soft limit: 500 lines (warning)
Hard limit: 800 lines (fail)

Found **2** test file(s) exceeding the soft limit:

⚠ **test/unit/example.test.ts**: 550 lines (warning)
✗ **test/unit/large.test.ts**: 820 lines (HARD LIMIT EXCEEDED)

## Summary

- 2 test file(s) exceed the soft limit
- 1 test file(s) exceed the hard limit
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

The check-test-sizes script is automatically run as part of the build pipeline. For local development:

```bash
# Run size check only
bun run check:test-sizes

# Run with precheck skipped (useful during development)
NAX_SKIP_PRECHECK=1 bun test test/

# View files that need attention
bun run check:test-sizes | grep "✗\|⚠"
```

## See Also

- `.claude/rules/test-architecture.md` — Test directory structure and file placement
- `.claude/rules/test-writing.md` — Quick lookup for injectable test dependencies
- `docs/guides/testing-rules.md` — Test writing source of truth
- `docs/architecture/ARCHITECTURE.md` — General code size and design conventions
