---
"@nathapp/nax": patch
---

- Added `--status-file` CLI flag for machine-readable JSON status tracking.
- Implemented TDD escalation with `retryAsLite` fallback on isolation violations.
- Integrated structured verifier verdicts via `.nax-verifier-verdict.json`.
- Improved runner stability with atomic status file writes and better failure categorization.
