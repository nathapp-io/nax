# nax Roadmap

## v0.8 ✅ (Current)
- [x] **LLM-enhanced routing** — LLM classifier with batch mode, async strategy chain, keyword fallback. See `docs/v0.8-llm-routing.md`
- [x] **Structured logging** — Logger class, stage events, JSONL run history, `--verbose/--quiet`. See `docs/v0.8-structured-logging.md`
- [x] `nax runs list/show` CLI commands
- [ ] BUG-20: TDD orchestrator empty session detection

## v0.9 (Next)
- [ ] **Split relevantFiles** (#1) — Decouple context injection (`contextFiles`) from asset verification (`expectedFiles`). Fixes false negatives in dogfood runs.
- [ ] **Configurable routing mode** (#2) — `one-shot` | `per-story` | `hybrid` LLM routing. Reduces cost and hook noise (9 Claude sessions → 1).

## v1.0 (Major)
- [ ] **Parallel execution with git worktree** — Run independent stories concurrently. ~300MB per Claude instance. Scope: parallel independent branches first (no intra-feature parallelism due to dependency chains).
- [ ] Stability & hardening for production use

## v1.1 (Architecture)
- [ ] **LLM service layer** (#3) — Direct API calls for non-coding LLM tasks (routing, review, acceptance). Decouples from `claude -p`. Enables multi-provider routing (e.g., Gemini Flash for free routing).
- [ ] Multi-agent support — Codex, OpenCode, Gemini adapters
- [ ] Direct API routing calls (skip Claude Code overhead)

## Future
- [ ] Adaptive routing — Learn from historical run data to auto-calibrate tier selection
- [ ] Acceptance testing via LLM
- [ ] Code review integration

---
*Updated 2026-02-21*
