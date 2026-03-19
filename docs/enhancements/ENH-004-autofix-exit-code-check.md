# ENH-004: Autofix — check exit codes before reporting success

**Type:** Bug fix
**Component:** `src/review/autofix.ts` (or equivalent)
**Filed:** 2026-03-19
**Status:** ✅ Verified — fix at commit `18eea738` (on master, 13/13 tests pass)
**Source:** Post-mortem koda/fix/refactor-standard (ENH-002)

## Problem

Autofix stage reports "Mechanical autofix succeeded" even when both `lintFix` and `formatFix` commands fail (exit code 1):

```
[warn][autofix] lintFix command failed (exitCode: 1)
[warn][autofix] formatFix command failed (exitCode: 1)
[info][autofix] Mechanical autofix succeeded — retrying review  ← WRONG
```

This causes a 5-cycle review → autofix loop that never escalates to agent rectification.

## Root Cause

The "succeeded" check likely looks at whether the autofix function completed without throwing, rather than checking if the underlying commands actually fixed anything.

## Expected Behavior

1. If both lintFix and formatFix fail → report "Mechanical autofix failed" → escalate to agent rectification
2. If at least one succeeds → retry review (partial fix may help)
3. If typecheck is the failure reason and no typecheck-fix command exists → skip mechanical autofix entirely, go straight to agent rectification

## Verification Steps

```bash
cd /home/ubuntu/subrina-coder/projects/nax/repos/nax
git log --oneline 18eea738 -1
git show 18eea738 --stat
# Review the fix in autofix.ts
```

## Related

- ENH-008 (review scoping) — even if autofix works, it shouldn't touch files outside story.workdir
- The same commit `18eea738` may also address ENH-009 (typecheck escalation)
