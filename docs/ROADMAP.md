# nax Roadmap

## v0.8 (Next)
- [ ] **LLM-enhanced routing** (HIGH) — Replace keyword-based routing with LLM classifier. Batch mode, async strategy chain, keyword fallback. See `docs/v0.8-llm-routing.md`
- [ ] Structured logging — See `docs/v0.8-structured-logging.md`
- [ ] BUG-20: TDD orchestrator empty session detection

## v1.0+ (Future)
- [ ] **Parallel execution with git worktree** — Run independent stories concurrently using git worktrees as isolated workspaces. Scope: parallel independent branches/features first (no intra-feature parallelism due to dependency chains and context injection benefits). Requires: worktree lifecycle management, merge conflict resolution agent, memory budget (300MB per Claude instance). See ADR discussion from 2026-02-19.
- [ ] Direct API routing calls (Option B) — Skip Claude Code overhead for routing
- [ ] Adaptive routing — Learn from historical run data to auto-calibrate tier selection

---
*Updated 2026-02-19*
