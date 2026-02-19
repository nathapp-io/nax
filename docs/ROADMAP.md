# nax Roadmap

## v0.8 (Next)
- [ ] Structured logging (see `docs/v0.8-structured-logging.md`)

## v1.0+ (Future)
- [ ] **Parallel execution with git worktree** — Run independent stories concurrently using git worktrees as isolated workspaces. Scope: parallel independent branches/features first (no intra-feature parallelism due to dependency chains and context injection benefits). Requires: worktree lifecycle management, merge conflict resolution agent, memory budget (300MB per Claude instance). See ADR discussion from 2026-02-19.

---
*Updated 2026-02-19*
