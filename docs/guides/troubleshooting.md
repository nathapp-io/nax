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

[Back to README](../README.md)
