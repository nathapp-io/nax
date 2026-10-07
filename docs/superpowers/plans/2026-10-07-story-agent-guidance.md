# Story agent guidance implementation plan

**Goal:** Fix #2380 by providing runnable, story-scoped acceptance instructions and automatically loading applicable repository instructions in native coding sessions.

**Design:** The user approved the preceding in-chat design and requested implementation in an isolated worktree. Keep acceptance resolution in nax; keep reusable instruction discovery in nax-agent. File-tool root, command cwd and instruction scope are distinct. Preserve config read/write refusals and ACP CLI discovery.

**Constraints:** TypeScript; Bun APIs only in nax, Node-compatible APIs in nax-agent; no new dependencies; existing deps seams and test helpers; no changes to the user's active checkout. Root-to-package instruction chains, nested/cross-package discovery, batch scopes and compaction/resume must preserve directory scope. Prefer AGENTS.md, fall back to CLAUDE.md in each directory, deduplicate imports and bound reads to authorized repository paths. Acceptance overrides win over ordinary testScoped; never advertise a tool call for a different command.

## Task 1: Acceptance execution description

- [x] Add regression tests using Jest acceptance override, AC-58..AC-67 mapping, package cwd and repo-relative file paths.
- [x] Demonstrate failures against existing code.
- [x] Add a shared resolver and prompt section with acceptance path, command, exact AC IDs and immutable-file instructions. Reuse existing path/command resolution and framework-specific selectors; unknown frameworks explicitly use an unfiltered fallback.
- [x] Wire three-session roles, single-session/batch prompts and rectification. Avoid full acceptance-file embedding by default; retain targeted source access and story AC mapping.
- [x] Verify missing/disabled acceptance, batch package selection, profiles, quoted paths and exact ID matching; run relevant existing tests and package gates.

## Task 2: Native repository instruction loading

- [x] Add regression tests for root/intermediate/package chains, AGENTS preference, CLAUDE fallback, nested and cross-package discovery, sibling scope isolation, bounded imports, symlinks and compaction/resume.
- [x] Demonstrate failures against existing code.
- [x] Add reusable instruction discovery and native-session lifecycle integration. Ensure both the adapter entry nax uses and the public session facade receive the behavior.
- [x] Keep applicable loaded instructions in persistent system context, with source paths and content hashes in the audit/transcript. Discover additional instructions before allowed file reads/edits without bypassing existing policy.
- [x] Expose the minimal package-directory input needed by the host; update the API snapshot if the public contract changes.
- [x] Run native/session regression tests, Node build/typecheck and package gates.

## Task 3: Host wiring and final verification

- [x] Pass actual execution checkout root and story package scopes through nax's session dispatch seam; include batch scopes without loading unrelated packages.
- [x] Verify package-root instructions are loaded even though file tools use the repository root; verify worktree paths.
- [x] Run relevant integration tests, full package tests, root quality/typecheck/build gates and coverage gates.
- [x] Independent review of the complete diff; fix material findings with regression tests.
- [x] Leave the worktree and branch available for review; do not merge or publish.

## Review focus

- Commands and file paths in different frames must not double-prefix a package.
- A normal Jest scoped command must not replace a dedicated acceptance configuration.
- AC regexes must not match numeric prefixes or unrelated stories.
- Native instruction discovery must honor protected paths and stay within the active checkout.
- Compaction, resume and concurrent sessions must not drop or share instruction state.

## Execution notes

The two production areas have disjoint ownership and may be implemented concurrently using the dispatching-parallel-agents skill. The parent owns host wiring, documentation, quality gates and integration. Existing uncommitted changes in the main checkout are intentionally excluded.

## Final verification

- Regression tests demonstrated the missing acceptance command, absent package guidance, first-mutation ordering, acceptance-framework mismatch and model-window overflow before their fixes.
- Full workspace test command passed, including nax unit, integration and UI phases.
- Workspace build, typecheck, check:all and native API snapshot checks passed.
- Coverage gates passed: nax 96.50% lines / 93.67% functions; nax-agent 97.99% lines / 95.63% functions. All new source files meet the per-file floor and no executable source files are missing from reports.
- Native Node compatibility: 79 tests passed.
- Independent review found no remaining material defects after fixes.
- Worktree moved to `/private/tmp/nax-fix-2380-agent-guidance` because Biome excludes `.worktrees` paths. Temporary formatting configuration changes were restored; the active checkout was not edited.
