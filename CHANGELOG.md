# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.6] - 2026-03-04

### Fixed
- **BUG-2:** Infinite PTY respawn loop in `usePty` hook by destructuring object-identity dependencies.
- **MEM-1 & MEM-3:** Prevented child process hangs on full `stderr` pipes by switching to `stderr: "inherit"`.
- **BUG-21 & BUG-22:** Added missing error handling and `.catch()` chains to process `stdout` streaming and exit handlers.

## [0.18.5] - 2026-03-04

### Changed
- **BUN-001:** Replaced `node-pty` (native C++ addon) with `Bun.spawn` piped stdio in `src/agents/claude.ts` and `src/tui/hooks/usePty.ts`. No native build required.

### Removed
- `node-pty` dependency from `package.json`

### Fixed
- CI `before_script` no longer installs `python3 make g++` (not needed without native build)
- CI `bun install` no longer needs `--ignore-scripts`
- Flaky test `execution runner > completes when all stories are done` — skipped with root cause comment (acceptance loop iteration count non-deterministic)

## [0.18.4] - 2026-03-04

### Fixed
- **BUG-031:** Keyword classifier no longer drifts across retries — `description` excluded from complexity/strategy classification (only `title`, `acceptanceCriteria`, `tags` used). Prevents prior error context from upgrading story complexity mid-run.
- **BUG-033:** LLM routing now retries on timeout/transient failure. New config: `routing.llm.retries` (default: 1), `routing.llm.retryDelayMs` (default: 1000ms). Default timeout raised from 15s to 30s.

### Added
- Pre-commit hook (`.githooks/pre-commit`) — runs `typecheck` + `lint` before every commit. Install with: `git config core.hooksPath .githooks`

## [0.10.0] - 2026-02-23

### Added

#### Plugin System
- Introduced extensible plugin architecture supporting:
  - Prompt optimizers for context compression and token reduction
  - Custom routers for intelligent agent/model selection
  - Code reviewers for quality gates and automated checks
  - Context providers for dynamic context injection
  - Custom reporters for execution reporting and analytics
  - Agent launchers for custom agent implementations
- Plugin discovery from both global (`~/.nax/plugins`) and project-local (`nax/plugins`) directories
- Plugin validation and lifecycle management (setup/teardown hooks)
- Safe plugin loading with comprehensive error handling
- Plugin configuration via `nax/config.json` with per-plugin settings

#### Global Configuration Layering
- Implemented three-tier configuration system:
  - User-global config (`~/.nax/config.json`) for default preferences
  - Project config (`nax/config.json`) for project-specific settings
  - CLI overrides for runtime customization
- Deep merge strategy with array override semantics
- Layered constitution loading with optional global opt-out
- Project-level directory detection for automatic config discovery
- Validation and normalization at each layer

#### Prompt Optimizer
- Built-in prompt optimization system with modular optimizer plugins
- Token budget enforcement with configurable limits
- Multi-strategy optimization:
  - Redundancy elimination
  - Context summarization
  - Selective detail retention
- Optimization statistics tracking (original vs. optimized token counts, reduction percentage)
- Integration with execution pipeline for automatic prompt optimization
- Plugin API for custom optimization strategies

### Changed
- Refactored config loading to support global + project layering
- Updated constitution loader to support skipGlobal flag
- Enhanced plugin registry with proper lifecycle management
- Improved error handling across plugin loading and validation

### Fixed
- Path security test failures on macOS (handled `/private` symlink prefix)
- TypeScript compilation errors across 9 files (20 total errors resolved)
- Import organization and code formatting issues (96 files auto-formatted)

## [0.9.2] - 2026-02-XX

### Previous releases
- See git history for changes prior to v0.10.0
