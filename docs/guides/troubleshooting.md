---
title: Troubleshooting
description: Common issues and resolutions
---

## Troubleshooting

**`nax.lock` blocking a new run**

A run holds two locks: a checkout lock at `<project>/nax.lock` and a feature lock at `<outputDir>/features/<feature>/nax.lock` (`outputDir` defaults to `~/.nax/<project>`). A lock whose holder process is dead is reclaimed automatically on the next run, so a refusal usually means another run really is active.

```bash
# Check if nax is actually running first
pgrep -fa nax

# Release a stale lock (checks the holder is dead first)
nax unlock
nax unlock -f my-feature        # the feature-scoped lock

# Remove unconditionally, skipping the liveness check
nax unlock --force
```

**Story keeps failing**

```bash
# Inspect run logs to see where the story is failing
nax logs --story US-003

# Check current run status
nax status -f my-feature
```

**Precheck fails**

```bash
nax precheck -f my-feature
# Fix reported issues, then re-run

# Environment-only check (no PRD needed) — useful before `nax plan`
nax precheck --light
```

A `story-size-gate` blocker names the `nax plan -f <feature> --decompose <storyId>` command to run — see [Story Decomposition](decomposition.md).

**Agent command refused, waiting for approval, or failing inside the sandbox**

Native-agent `Bash`/`RunCommand` calls pass through the permission policy, the interactive approval gate, and (by default) the OS sandbox. See [Approvals](approvals.md) for pending and remembered approvals (`nax approvals list` / `nax approvals rm`), and [Sandbox and Command Safety](sandbox-and-command-safety.md) for sandbox verification and troubleshooting.

**Run stopped mid-way**

nax saves progress in `.nax/features/<name>/prd.json`. Re-run with the same command — completed stories are skipped automatically.

`nax resume -f <feature>` resumes an interrupted run from its checkpoint (auto-detected).

---

**Debugging with session IDs**

Every agent session — ACP or native — carries a session name, and prompt-audit entries record it alongside the `sessionId`. Use these to correlate nax logs with agent-level audit logs:

1. Enable prompt auditing with `agent.promptAudit.enabled: true` (off by default). Entries are written to `<outputDir>/prompt-audit/<featureName>/` (override with `agent.promptAudit.dir`): a `<runId>.jsonl` plus one human-readable `.txt` per turn
2. The session name format is `nax-<hash8>-<feature>-<storyId>-<role>`, lowercased (e.g. `nax-abc12345-my-feature-us-001-implementer`); `<hash8>` is derived from the workdir
3. Each entry carries `recordId` (stable logical session), `sessionId` (physical, may change on reconnect), `turn` (ordinal within the session) and `turnId` (joins 1:1 with the turn's cost row) — useful for verifying session continuity across rectification cycles

To correlate review decisions, check `<outputDir>/review-audit/<featureName>/` — each audit file includes the `sessionName` matching the prompt audit entries. Native-agent tool calls are recorded per session under `<outputDir>/tool-audit/<featureName>/`.

[Back to README](../../README.md)
