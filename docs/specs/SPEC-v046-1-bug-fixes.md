# SPEC: v0.46.1 Bug Fixes — Runtime Gitignore Audit + Precheck Allowlist + HOME Sanitization

**Version:** v0.46.1
**Branch:** fix/v046-precheck-runtime-files
**Status:** Ready to implement
**Spec created:** 2026-03-17

---

## Overview

Three bugs, all Simple complexity, ~6 files total. Implement all, run full suite, commit each bug separately.

---

## BUG-074: working-tree-clean blocks on nax runtime files

### Root Cause

`checkWorkingTreeClean` in `src/precheck/checks-git.ts` runs `git status --porcelain` with zero exceptions. nax writes runtime files during execution — if any aren't gitignored (e.g. user skipped `nax init`, or init added incomplete entries), the precheck blocks re-runs.

### BUG-074-1: Allowlist in `src/precheck/checks-git.ts`

Parse `--porcelain` output line by line, filter out nax runtime paths before evaluating `passed`.

```typescript
// Current (broken):
const passed = exitCode === 0 && output.trim() === "";

// Fixed:
const NAX_RUNTIME_PATTERNS = [
  /^.{2} nax\.lock$/,
  /^.{2} nax\/metrics\.json$/,
  /^.{2} nax\/features\/[^/]+\/status\.json$/,
  /^.{2} nax\/features\/[^/]+\/runs\//,
  /^.{2} nax\/features\/[^/]+\/plan\//,
  /^.{2} nax\/features\/[^/]+\/acp-sessions\.json$/,
  /^.{2} nax\/features\/[^/]+\/interactions\//,
  /^.{2} nax\/features\/[^/]+\/progress\.txt$/,
  /^.{2} nax\/features\/[^/]+\/acceptance-refined\.json$/,
  /^.{2} \.nax-verifier-verdict\.json$/,
  /^.{2} \.nax-pids$/,
  /^.{2} \.nax-wt\//,
];

const lines = output.trim() === "" ? [] : output.trim().split("\n");
const nonNaxDirtyFiles = lines.filter(
  (line) => !NAX_RUNTIME_PATTERNS.some((pattern) => pattern.test(line))
);
const passed = exitCode === 0 && nonNaxDirtyFiles.length === 0;
```

Update the `message` to list what's dirty (filtered) when not passed:
```typescript
message: passed
  ? "Working tree is clean"
  : `Uncommitted changes detected: ${nonNaxDirtyFiles.map(l => l.slice(3)).join(", ")}`,
```

### BUG-074-2: Complete `NAX_GITIGNORE_ENTRIES` in `src/cli/init.ts`

Current:
```typescript
const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  "nax/**/runs/",
  "nax/metrics.json",
];
```

Replace with the complete set:
```typescript
const NAX_GITIGNORE_ENTRIES = [
  ".nax-verifier-verdict.json",
  "nax.lock",
  "nax/**/runs/",
  "nax/metrics.json",
  "nax/features/*/status.json",
  "nax/features/*/plan/",
  "nax/features/*/acp-sessions.json",
  "nax/features/*/interactions/",
  "nax/features/*/progress.txt",
  "nax/features/*/acceptance-refined.json",
  ".nax-pids",
  ".nax-wt/",
  "~/",
];
```

### BUG-074-3: Expand warning patterns in `src/precheck/checks-warnings.ts`

Function: `checkGitignoreCoversNax`

Current patterns: `["nax.lock", "runs/", "test/tmp/"]`

Replace with:
```typescript
const patterns = [
  "nax.lock",
  "nax/**/runs/",
  "nax/metrics.json",
  "nax/features/*/status.json",
  ".nax-pids",
  ".nax-wt/",
];
```

Remove `"test/tmp/"` — that's a test artifact, not a nax runtime file.
Update the comment: `* Patterns: nax.lock, runs/, status.json, .nax-pids, .nax-wt/`

---

## BUG-075: acceptance-refined.json written to workdir root instead of feature dir

### Root Cause

`src/acceptance/generator.ts` writes to `join(options.workdir, "acceptance-refined.json")` — repo root. Should be `join(options.featureDir, "acceptance-refined.json")`.

### BUG-075-1: Fix path in `src/acceptance/generator.ts`

Find the `generateFromPRD()` options interface and the write call:

```typescript
// Current:
await _generatorPRDDeps.writeFile(join(options.workdir, "acceptance-refined.json"), refinedJsonContent);

// Fixed:
await _generatorPRDDeps.writeFile(join(options.featureDir, "acceptance-refined.json"), refinedJsonContent);
```

### BUG-075-2: Thread `featureDir` through `generateFromPRD()` options

Check `generateFromPRD()` options type. If `featureDir` is not already in the options interface, add it:

```typescript
export interface GenerateFromPRDOptions {
  workdir: string;
  featureDir: string;  // add if missing
  // ... existing fields
}
```

Find all call sites of `generateFromPRD()` and ensure `featureDir` is passed. Check:
- `src/cli/analyze.ts`
- `src/pipeline/stages/acceptance-setup.ts` (if applicable)

---

## BUG-076: Literal `~` directory created in repo root when HOME is unexpanded

### Root Cause

Both `buildAllowedEnv` functions pass `process.env.HOME` to spawned agents without validation. If `HOME` is set to a literal `~` string (not shell-expanded — from a misconfigured launch script), Claude Code resolves `~/.claude` relative to cwd, creating a literal `~/` directory inside the repo.

### BUG-076-1: Sanitize HOME in `src/agents/claude/execution.ts`

In `buildAllowedEnv`, replace the raw HOME pass-through with a validated version:

```typescript
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

// ... inside buildAllowedEnv, replace the HOME handling:
// Instead of including HOME in essentialVars loop, handle it separately:

const essentialVars = ["PATH", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"]; // remove HOME
for (const varName of essentialVars) {
  if (process.env[varName]) {
    allowed[varName] = process.env[varName];
  }
}

// Sanitize HOME — must be absolute path. Unexpanded "~" causes literal ~/dir in cwd.
const rawHome = process.env.HOME ?? "";
const safeHome = rawHome && isAbsolute(rawHome) ? rawHome : homedir();
if (rawHome !== safeHome) {
  const logger = getLogger();
  logger.warn("env", `HOME env is not absolute ("${rawHome}"), falling back to os.homedir(): ${safeHome}`);
}
allowed.HOME = safeHome;
```

### BUG-076-2: Same fix in `src/agents/acp/spawn-client.ts`

The local `buildAllowedEnv` function has identical structure. Apply the same sanitization pattern.

### BUG-076-3: New precheck warning in `src/precheck/checks-warnings.ts`

Add `checkHomeEnvValid()`:

```typescript
export async function checkHomeEnvValid(): Promise<Check> {
  const home = process.env.HOME ?? "";
  const passed = home !== "" && isAbsolute(home);
  return {
    name: "home-env-valid",
    tier: "warning",
    passed,
    message: passed
      ? `HOME env is valid: ${home}`
      : home === ""
        ? "HOME env is not set — agent may write files to unexpected locations"
        : `HOME env is not an absolute path ("${home}") — may cause literal "~" directories in repo`,
  };
}
```

Wire it into the precheck runner (find where other warning checks are registered and add it).

### BUG-076-4: Add `~/` to `NAX_GITIGNORE_ENTRIES` in `src/cli/init.ts`

Already included in BUG-074-2 above (`"~/"` in the entries list).

---

## Test Requirements

For each bug, add or update tests:

### BUG-074 tests (`test/unit/precheck/checks-git.test.ts`)
- `checkWorkingTreeClean` passes when only nax runtime files are dirty
- `checkWorkingTreeClean` fails when non-nax files are dirty
- `checkWorkingTreeClean` includes dirty non-nax filenames in message

### BUG-075 tests (`test/unit/acceptance/generator.test.ts` or wherever generateFromPRD is tested)
- `acceptance-refined.json` is written to `featureDir`, not `workdir`

### BUG-076 tests (`test/unit/agents/execution.test.ts` or similar)
- `buildAllowedEnv` uses `os.homedir()` when HOME is `~`
- `buildAllowedEnv` uses `os.homedir()` when HOME is empty
- `buildAllowedEnv` uses the original HOME when it is absolute

---

## Commit Order

```
fix(precheck): allowlist nax runtime files in working-tree-clean check (BUG-074-1)
fix(init): complete NAX_GITIGNORE_ENTRIES with all runtime file patterns (BUG-074-2)
fix(precheck): expand gitignore-covers-nax warning patterns (BUG-074-3)
fix(acceptance): write acceptance-refined.json to featureDir not workdir (BUG-075)
fix(agents): sanitize HOME env in buildAllowedEnv, prevent literal ~ dir (BUG-076)
```

## Test Command

```bash
NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail
```

Run after all fixes. Do NOT push to remote.
