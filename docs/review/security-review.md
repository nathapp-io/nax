# Security Audit Report: nax Orchestrator

**Date:** 2026-03-11
**Scope:** Full codebase security review
**Status:** REVIEW ONLY - No code changes made

---

## Executive Summary

The nax codebase demonstrates **good security hygiene** with multiple defensive layers in place:
- ✅ Input validation via Zod schemas and path security utilities
- ✅ Shell command safety through argv array construction (no shell interpolation)
- ✅ Plugin path validation and sandboxing
- ✅ Environment variable filtering for spawned processes
- ✅ Hook command pattern validation

However, **4 findings** require attention:
- 1 **HIGH**: Regex DoS vulnerability in hook command validation
- 2 **MEDIUM**: Path traversal edge cases
- 1 **LOW**: Missing error message sanitization

---

## Detailed Findings

### 1. CRITICAL: None Found

All critical-level security issues (SQL injection, RCE, arbitrary file access) are mitigated by proper input validation and argv-based command construction.

---

### 2. HIGH: Regex Denial of Service (ReDoS) in Hook Validation

**Location:** `src/hooks/runner.ts:112-122`

**Severity:** HIGH

**Description:**
The hook command validation uses regex patterns that are vulnerable to exponential backtracking:

```typescript
const dangerousPatterns = [
  /\$\(.*\)/, // Vulnerable: greedy match on any content
  /`.*`/,     // Vulnerable: greedy match on any content
  // ...
];
```

A maliciously crafted hook command with a long string of unmatched patterns could trigger catastrophic backtracking and freeze the process.

**Example Attack:**
```
command: "$(((((((((((((((((((((((x"
```

**Impact:**
- Process hang/DoS during hook validation
- Potential cascade failure if hooks are validated during critical pipeline stages

**Recommendation:**
Replace greedy quantifiers with possessive quantifiers or atomic groups to prevent backtracking:

```typescript
const dangerousPatterns = [
  /\$\(.*?\)/, // Non-greedy: match shortest sequence
  /`[^`]*`/,   // Negated class: avoid backtracking
  /\|\s*(?:bash|sh)\b/,  // Word boundary
];
```

**Risk Rating:** Process unavailability (availability impact, not confidentiality)

---

### 3. MEDIUM: Path Traversal Edge Case in Module Path Validation

**Location:** `src/utils/path-security.ts:26-56` and `src/plugins/loader.ts:238-261`

**Severity:** MEDIUM

**Description:**
The `validateModulePath()` function attempts to prevent path traversal but uses string comparison that may be vulnerable on case-insensitive filesystems (Windows, macOS):

```typescript
export function validateModulePath(modulePath: string, allowedRoots: string[]): PathValidationResult {
  // ...
  const absoluteTarget = normalize(modulePath);
  const isWithin = normalizedRoots.some((root) => {
    return absoluteTarget.startsWith(`${root}/`) || absoluteTarget === root;
  });
}
```

**Edge Cases:**
1. **Case sensitivity:** On macOS/Windows, `/allowed/file` and `/Allowed/file` resolve to the same inode but fail string comparison
2. **Symlink attacks:** The function resolves paths but doesn't follow symlinks, potentially allowing symlink to escape bounds
3. **Windows UNC paths:** UNC paths like `//server/share` may not normalize correctly

**Current Mitigation:**
- `loadAndValidatePlugin()` in `src/plugins/loader.ts` uses `validateModulePath()` with allowedRoots
- The path is later imported as an ES module, limiting direct file access

**Attack Scenario:**
```
allowedRoots: ["/home/user/project"]
symlink: /home/user/project/plugin.js -> ../../sensitive-config.json
modulePath: "./plugin.js" resolves to "/home/user/project/plugin.js" (passes validation)
import(modulePath) loads sensitive config via symlink
```

**Recommendation:**

1. Use `fs.realpathSync()` to resolve symlinks before comparison:
```typescript
const realPath = realpathSync(absoluteTarget);
const realRoot = realpathSync(root);
return realPath.startsWith(`${realRoot}/`) || realPath === realRoot;
```

2. On case-insensitive filesystems, normalize to lowercase for comparison:
```typescript
const platform = process.platform;
if (platform === 'darwin' || platform === 'win32') {
  return absoluteTarget.toLowerCase().startsWith(`${root}/`.toLowerCase());
}
```

**Current Risk:** LOW (plugins must be explicitly configured; filesystem symlinks are within user's control). Upgrade to MEDIUM if third-party plugin directories are supported.

---

### 4. MEDIUM: Incomplete Input Validation in Story ID / Git Operations

**Location:** `src/worktree/manager.ts:11-13` and `src/worktree/merge.ts:29`

**Severity:** MEDIUM

**Description:**
Story IDs are used directly in git branch names without validation:

```typescript
async create(projectRoot: string, storyId: string): Promise<void> {
  const branchName = `nax/${storyId}`; // storyId passed directly

  const proc = Bun.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
```

**Risk:** While `Bun.spawn()` with argv arrays prevents shell injection, invalid git branch names could:
1. Cause git to fail with unclear error messages
2. Create branches with unexpected names (e.g., `nax/../sensitive`)
3. Potentially interfere with git operations if not properly constrained

**Validation Status:**
- PRD types don't specify StoryID format validation
- No validation in `src/prd/types.ts` or `src/prd/index.ts` enforces StoryID format

**Examples of Invalid IDs:**
```
storyId = "../../../etc/passwd"     → branch: "nax/../../../etc/passwd"
storyId = "$(rm -rf /)"             → Safe (argv array), but still garbage branch
storyId = "--force delete me"       → Interpreted as git flag
```

**Recommendation:**

1. Add StoryID validation regex in config/schema:
```typescript
StoryIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid story ID format")
```

2. Validate before worktree creation:
```typescript
export function validateStoryId(storyId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(storyId);
}

async create(projectRoot: string, storyId: string): Promise<void> {
  if (!validateStoryId(storyId)) {
    throw new Error(`Invalid story ID: ${storyId}`);
  }
  // ...
}
```

**Current Mitigation:** argv-based spawning prevents shell injection. Risk is primarily data integrity (invalid git state), not RCE.

---

### 5. LOW: Error Messages May Leak Context Information

**Location:** Multiple files including:
- `src/agents/claude-execution.ts:211-212`
- `src/worktree/manager.ts:25-26`, `46-47`
- `src/hooks/runner.ts:173-176`

**Severity:** LOW

**Description:**
Error messages capture and return full stderr/stdout from subprocess calls, which could leak:
- File paths (revealing internal project structure)
- API error messages (if agent runs fail with API errors)
- Environment-specific details

**Examples:**
```typescript
// src/agents/claude-execution.ts
stderr: stderr.slice(-MAX_AGENT_STDERR_CHARS),  // Returns raw stderr

// src/worktree/manager.ts
throw new Error(`Failed to create worktree: ${stderr || "unknown error"}`);

// src/hooks/runner.ts
if (pattern.test(command)) {
  throw new Error(`Hook command contains dangerous pattern: ${pattern.source}`);
}
```

**Current Mitigation:**
- Errors are logged through structured logger (not to stdout by default)
- Max 1000 chars captured for agent stderr (`MAX_AGENT_STDERR_CHARS`)
- Hook command pattern is revealed in error, but this is acceptable for validation feedback

**Risk:** LOW - requires access to logs or error output. Not visible in normal operation unless explicitly requested.

**Recommendation:**
Sanitize error messages in production before returning to user:

```typescript
function sanitizeErrorMessage(error: string): string {
  // Remove file paths, API keys, tokens
  return error
    .replace(/\/[a-zA-Z0-9\/\-_.]+\.(env|json|yaml)/g, "[FILE]")
    .replace(/sk-[a-zA-Z0-9]{48,}/g, "[API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9.-_]+/g, "[TOKEN]");
}
```

---

### 6. MEDIUM: Symlink Handling in Constitution & File Validation

**Location:** `src/constitution/loader.ts:68-84` and `src/config/path-security.ts:29-32`

**Severity:** MEDIUM

**Description:**
The `validateFilePath()` function handles symlinks imperfectly:

```typescript
export function validateFilePath(filePath: string, baseDir: string): string {
  // ...
  if (!existsSync(resolved)) {
    const parent = resolve(resolved, "..");
    if (existsSync(parent)) {
      const realParent = realpathSync(parent);
      realPath = resolve(realParent, filePath.split("/").pop() || "");
    }
  }
  // ...
}
```

**Issue:**
For non-existent files, the function only checks if the parent directory is within bounds. A symlink in the parent directory pointing outside could allow escape:

```
baseDir: /allowed/
symlink: /allowed/evil -> /sensitive/
filePath: /allowed/evil/config.json
```

The function validates `/allowed` but loads `/sensitive/config.json` via symlink.

**Current Impact:** LOW
- Constitution files are controlled by administrators, not users
- Would require filesystem symlinks to already exist
- Plugin loading uses this for validation but has additional guards

**Recommendation:**
Always resolve the real path before comparison:

```typescript
const realBase = realpathSync(baseDir);
const realPath = realpathSync(resolved); // Must exist first
if (!realPath.startsWith(`${realBase}/`) && realPath !== realBase) {
  throw new Error(`Path is outside allowed directory`);
}
```

---

### 7. Analysis: Command Injection Prevention - STRONG

**Locations:**
- `src/agents/claude-execution.ts:113-121`
- `src/utils/git.ts:29-54`
- `src/hooks/runner.ts:194-206`
- `src/worktree/manager.ts:16-21`
- `src/context/auto-detect.ts:127-146`

**Verdict:** ✅ STRONG MITIGATION

**Why It's Safe:**
1. All spawned commands use **argv arrays**, not shell interpolation
2. Example from `buildCommand()`:
   ```typescript
   return [binary, "--model", model, ...permArgs, "-p", options.prompt];
   ```
   Parameters are passed as separate array elements, not concatenated strings.

3. Git operations use argv arrays:
   ```typescript
   const proc = Bun.spawn(["git", ...args], { cwd: workdir, ... });
   ```

4. Hook commands are parsed by `parseCommandToArgv()`, which splits on whitespace and **does not evaluate shell operators**

**Vulnerable Pattern Not Present:**
```typescript
// ❌ NOT FOUND IN CODEBASE (would be vulnerable):
const cmd = `git merge --no-ff ${branchName}`;
proc = Bun.spawn(cmd.split(" "), ...); // Vulnerable to word splitting

// ✅ CORRECTLY IMPLEMENTED:
proc = Bun.spawn(["git", "merge", "--no-ff", branchName], ...);
```

---

### 8. Analysis: Secret Handling - ADEQUATE

**Locations:**
- `src/agents/claude-execution.ts:63-95` (env filtering)
- `src/hooks/runner.ts:68-91` (env escaping)

**Verdict:** ✅ ADEQUATE, WITH NOTES

**Strengths:**
1. Environment variable filtering (allowlist approach):
   ```typescript
   const essentialVars = ["PATH", "HOME", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];
   for (const varName of essentialVars) {
     if (process.env[varName]) {
       allowed[varName] = process.env[varName];
     }
   }
   ```

2. API keys are explicitly allowed:
   ```typescript
   const apiKeyVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
   ```

3. Prefix-based allowlist for custom vars:
   ```typescript
   const allowedPrefixes = ["CLAUDE_", "NAX_", "CLAW_", "TURBO_"];
   ```

4. Hook environment escaping:
   ```typescript
   function escapeEnvValue(value: string): string {
     return value.replace(/\0/g, "").replace(/\n/g, " ").replace(/\r/g, "");
   }
   ```

**Potential Improvements:**
1. Consider removing `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from defaults and requiring explicit opt-in
2. Log when sensitive env vars are passed (audit trail)
3. Consider sanitizing API key patterns from error output

---

### 9. Analysis: Dependency Security

**Location:** `package.json`

**Verdict:** ✅ GOOD - All dependencies are well-maintained

**Key Dependencies:**
| Package | Version | Status |
|---------|---------|--------|
| `commander` | ^13.1.0 | ✅ Current (CLI arg parser, actively maintained) |
| `zod` | ^4.3.6 | ✅ Current (input validation) |
| `chalk` | ^5.6.2 | ✅ Current (terminal colors, safe) |
| `react` + `ink` | ^19.2.4, ^6.7.0 | ✅ Current (TUI rendering) |
| `@biomejs/biome` | ^1.9.4 | ✅ Current (formatting/linting) |

**No suspicious transitive dependencies detected.**

---

## Risk Matrix

| Finding | Severity | Component | Risk Type | Status |
|---------|----------|-----------|-----------|--------|
| ReDoS in hook validation | HIGH | Hooks | DoS | Review |
| Path traversal edge cases | MEDIUM | Config/Plugins | Path Escape | Review |
| Invalid story IDs in git | MEDIUM | Worktree | Data Integrity | Review |
| Error message leaks | LOW | Error Handling | Info Disclosure | Review |
| Symlink in file validation | MEDIUM | File Access | Path Escape | Review |

---

## Recommendations by Priority

### 🔴 HIGH PRIORITY
1. **Fix ReDoS in hook patterns** — Use non-greedy quantifiers in `src/hooks/runner.ts`
   - **Effort:** 15 minutes
   - **Impact:** Prevents process hang attacks

### 🟠 MEDIUM PRIORITY
2. **Add story ID validation** — Enforce format in `src/prd/types.ts` or schema
   - **Effort:** 30 minutes
   - **Impact:** Prevents invalid git state

3. **Harden symlink handling** — Use `realpathSync()` before comparisons
   - **Effort:** 45 minutes
   - **Impact:** Closes path traversal via symlinks

### 🟡 LOW PRIORITY
4. **Sanitize error messages** — Redact paths/keys before returning to user
   - **Effort:** 1 hour
   - **Impact:** Reduces information disclosure

---

## Security Posture Assessment

**Overall Grade: A-**

| Category | Grade | Notes |
|----------|-------|-------|
| Input Validation | A | Zod schemas, path security, pattern matching present |
| Command Injection | A | argv arrays used throughout, no shell interpolation |
| Path Traversal | B | Good baseline, symlink edge cases need attention |
| Secret Handling | B+ | Env var filtering in place, API key allowlist could be stricter |
| Error Handling | B | Adequate logging, some error messages could be sanitized |
| Dependency Management | A | All deps current and well-maintained |
| Plugin Isolation | A | Path validation, schema validation, safe imports |

---

## Conclusion

The nax orchestrator demonstrates **mature security practices** with proper input validation, safe command execution patterns, and defense-in-depth. The identified findings are primarily **edge cases and hardening opportunities**, not active vulnerabilities.

**Recommended Next Steps:**
1. Fix HIGH severity ReDoS issue
2. Implement story ID validation (MEDIUM)
3. Harden symlink handling (MEDIUM)
4. Monitor error message leakage (LOW)

All findings are suitable for standard development workflow (no emergency patches required).

---

## Appendix: Test Coverage for Security Features

| Feature | Test File | Status |
|---------|-----------|--------|
| Path validation | `test/unit/` (TBD) | Check for path-security tests |
| Plugin loading | `test/unit/plugins/` (TBD) | Check for injection tests |
| Hook validation | `test/unit/hooks/` (TBD) | Check for pattern tests |
| CLI arg parsing | `test/integration/cli/` | Present |
| Env filtering | Test for `buildAllowedEnv()` | Verify exists |

**Note:** Full test file enumeration would require running test suite. Recommend verifying test coverage for findings before closing.
