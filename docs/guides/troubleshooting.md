---
title: Troubleshooting
description: Common issues and resolutions
---

## Troubleshooting

**`nax.lock` blocking a new run**

```bash
# Check if nax is actually running first
pgrep -fa nax

# If nothing is running, remove the lock
rm nax.lock
```

**Story keeps failing**

```bash
nax diagnose -f my-feature
```

**Precheck fails**

```bash
nax precheck -f my-feature
# Fix reported issues, then re-run
```

**Run stopped mid-way**

nax saves progress in `nax/features/<name>/prd.json`. Re-run with the same command — completed stories are skipped automatically.

---

**Debugging with ACP session IDs**

Every ACP session logs its session ID in the prompt audit header. Use these IDs to correlate nax logs with ACP-level audit logs:

1. Look in `.nax/prompt-audit/<featureName>/` for JSON files — each contains the `sessionName` and `sessionId`
2. The session name format is `nax-<hash8>-<feature>-<storyId>-<role>` (e.g., `nax-abc12345-my-feature-US-001-implementer`)
3. Resumed sessions include `resumed: true` in the audit entry — useful for verifying session continuity across rectification cycles

To correlate review decisions, check `.nax/review-audit/<featureName>/` — each audit file includes the `sessionName` matching the prompt audit entries.

[Back to README](../README.md)
