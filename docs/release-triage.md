# Pre-Release Issue Triage

> Generated: 2026-04-21

## Fix before release — bugs

| Issue | Title | Effort | Risk |
|-------|-------|--------|------|
| [#565](https://github.com/nathapp-io/nax/issues/565) | `git diff` paths mismatch when project root ≠ git root | Small — strip prefix in 2 functions in `smart-runner.ts` | Low — falls back to full suite today, no regression |

**#565** causes smart-runner Pass 0/1/2 to return zero files and silently defer to full-suite gate when `.nax/` is not the git root. Affected functions: `getChangedSourceFiles()` and `getChangedTestFiles()` in `src/verification/smart-runner.ts`. Fix: resolve the true git root via `git rev-parse --show-toplevel`, compute `relative(gitRoot, repoRoot)`, and prepend that prefix to the `startsWith` filter.

---

## Quick wins — safe to include

| Issue | Title | Effort | Risk |
|-------|-------|--------|------|
| [#584](https://github.com/nathapp-io/nax/issues/584) | ADR-012 codemod AC: drop or recover artefact | Trivial — one-line doc edit | Zero |
| [#582](https://github.com/nathapp-io/nax/issues/582) | Extract 86-line `executeHop` closure into helper | Medium — refactor `execution.ts`, add unit tests | Low — no behaviour change |

**#584** has two options; Option 1 (drop the AC) is recommended — the migration diff in PR #568 is a sufficient audit record and the script has no reuse value.

**#582** extracts the 86-line `executeHop` closure in `src/pipeline/stages/execution.ts:188-273` into a named `buildAndRunHop()` helper. No behaviour change; each internal step (context rebuild, manifest write, session handoff, prompt regen, agent dispatch) becomes independently testable.

---

## Defer to post-release

| Issue | Title | Reason |
|-------|-------|--------|
| [#391](https://github.com/nathapp-io/nax/issues/391) | `modelDef.env` overrides ignored in `complete()`, `decompose()`, `plan()` | Requires threading `envOptions` through `SpawnAcpClient`, `createClient`, and `CompleteOptions` — architectural scope |
| [#577](https://github.com/nathapp-io/nax/issues/577) | Convert `runReview` / `runSemanticReview` / `runAdversarialReview` to options-object params | Large call-site migration (13–17 positional params); high merge-conflict risk |
| [#574](https://github.com/nathapp-io/nax/issues/574) | Worktree dependencies: fix `inherit` semantics, parallel routing, repo-root provisioning | Multi-problem follow-up; `mode=off` default already safe |
| [#615](https://github.com/nathapp-io/nax/issues/615) | Enforce inline-mock rule in CI | Blocked by 364-violation sweep; CI gate is a post-sweep task |
| [#530](https://github.com/nathapp-io/nax/issues/530) | Store relative paths in session descriptor | Explicitly not a current blocker; context manifests regenerated each run |
| [#523](https://github.com/nathapp-io/nax/issues/523) | Move prompt-audit ownership from ACP adapter to `SessionManager` | Architectural move; no user-visible bug today |
| [#473](https://github.com/nathapp-io/nax/issues/473) | Per-run plugin provider cache | Performance enhancement |
| [#374](https://github.com/nathapp-io/nax/issues/374) | Scoped tool allowlists (PERM-002 Phase 2) | New feature |
| [#355](https://github.com/nathapp-io/nax/issues/355) | Debate: early-exit rebuttal loop on convergence | New feature |
| [#163](https://github.com/nathapp-io/nax/issues/163) | Debate-based root cause diagnosis in rectification | New feature |
| [#155](https://github.com/nathapp-io/nax/issues/155) | LLM-based escalation judgment | New feature |
| [#154](https://github.com/nathapp-io/nax/issues/154) | Structured per-AC output in semantic review | New feature |

---

## Recommended order

1. **#565** — smart-runner path bug (zero-file deferral in nested repos)
2. **#584** — drop codemod AC from ADR-012 (1-line doc edit)
3. **#582** — extract `executeHop` helper (if time allows before release)
