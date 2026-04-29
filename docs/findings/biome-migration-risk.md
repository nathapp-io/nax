# Biome v2 Migration Risk Findings

Date: 2026-04-28

## Scope

This note captures risks found while assessing migration from `@biomejs/biome` `^1.9.4` to Biome `2.x`, with special attention to replacing the current custom checks:

- `check:test-mocks`
- `check:process-cwd`

Current wiring:

- `package.json` runs `bun x biome check src/ bin/` for `lint`.
- `.github/workflows/ci.yml` runs `typecheck`, `lint`, `check:test-mocks`, and `check:process-cwd` as separate matrix jobs.
- `.githooks/pre-commit` runs `typecheck`, `lint`, and `check:process-cwd`.

## Summary

Migrating the Biome dependency itself is feasible, but migrating both custom checks into Biome rules is uneven.

- `check:process-cwd` is a good candidate for a Biome 2 GritQL plugin, provided path scoping is handled carefully.
- `check:test-mocks` is only a partial candidate. The current script has a large allowlist, custom false-positive handling, and grouped output that Biome GritQL plugins do not currently reproduce cleanly.

Recommended approach: upgrade Biome first without replacing both scripts, then pilot `check:process-cwd` as a GritQL plugin. Keep `check:test-mocks` as a script until its skip list and special cases are much smaller.

## High Risks

### `check:process-cwd` Can Over-Match

The current script scans only `src/` and excludes:

- `src/cli/**`
- `src/commands/**`
- `src/config/loader.ts`

There are many intentional `process.cwd()` calls in `bin/nax.ts`, so folding the rule into normal `lint` without precise path scoping would create false positives.

Risk: `bun run lint` starts failing on valid CLI entry-point usage.

Mitigation:

- Keep the Biome plugin scoped to the intended source paths.
- Exclude allowed CLI/config paths explicitly with Biome `linter.includes`, `files.includes`, or separate invocation boundaries.
- Validate with `bun run lint`, `bun run check:process-cwd`, and targeted negative fixtures before removing the shell script.

### `check:test-mocks` Is Not a Clean Full Replacement

The current script does more than simple pattern matching:

- Maintains a large `SKIP_FILES` allowlist.
- Detects four separate patterns:
  - inline agent manager mocks
  - inline agent adapter mocks
  - local `makeConfig()`
  - local `makeStory()`
- Includes a custom false-positive guard for `supportedTiers` inside helper calls.
- Produces grouped output with project-specific hints.

Biome 2 GritQL plugins can match code patterns and emit diagnostics, but they do not currently provide the same custom reporting, long-lived skip ledger, or script-level context logic.

Risk: replacing the script would either lose coverage or introduce noisy false positives.

Mitigation:

- Do not fully replace `check:test-mocks` yet.
- Optionally pilot only the simplest patterns as Biome plugins.
- Keep the TypeScript script as the source of truth until the skip list is reduced and special cases are minimized.

### CI Contract Changes

GitHub Actions currently reports `lint`, `check:test-mocks`, and `check:process-cwd` separately.

Risk: merging custom checks into `lint` changes failure ownership, developer triage, and CI signal.

Mitigation:

- Keep separate package scripts during migration.
- If a Biome plugin replaces `check:process-cwd`, consider preserving `check:process-cwd` as a wrapper around the Biome invocation.
- Update CI only after equivalent diagnostics and failure modes are verified.

## Medium Risks

### Biome v2 Configuration Shape Changes

Current `biome.json` uses the `1.9.4` schema and top-level `organizeImports`.

Biome v2 moves import organization into assist actions. The official migration command should update this, but the generated config needs review.

Mitigation:

- Run `biome migrate --write` in a scratch branch.
- Review the resulting `biome.json` manually.
- Keep config changes separate from code-formatting churn where possible.

### Lint Severity Semantics Changed

Biome v2 changed linter severity behavior:

- Recommended rules can emit diagnostics with different severities.
- Style rules no longer emit errors unless configured otherwise.
- The migration command may pin previous error behavior into config.

Risk: CI may become stricter or looser than intended.

Mitigation:

- Inspect generated rule severities after migration.
- Run `bun run lint` before and after migration and compare diagnostics.
- Decide explicitly whether style diagnostics should fail CI.

### Formatting And Import Churn

Biome v2 changes:

- Import organization behavior.
- `package.json` formatting defaults.
- Some fix safety classifications.

Risk: `bun run lint:fix` may produce broad mechanical diffs unrelated to the custom-rule migration.

Mitigation:

- Separate dependency/config migration from formatting changes.
- Run `bun run lint:fix` only after reviewing raw lint output.
- Avoid combining custom plugin rollout with mass formatting.

## Low / Operational Risks

### Lockfile And Dependency Updates

`package.json` and `bun.lock` both currently reference Biome `1.9.4`.

Risk: CI with `bun install --frozen-lockfile` fails if the package and lockfile are not updated together.

Mitigation:

- Update `package.json` and `bun.lock` in the same change.
- Verify with `bun install --frozen-lockfile` in CI or a clean checkout.

### Editor Compatibility

Biome v2 may require compatible editor extensions and LSP behavior.

Risk: local editor diagnostics differ from CI until developers update extensions.

Mitigation:

- Note the extension requirement in the migration PR.
- Prefer CI as the source of truth during rollout.

### Expanded Lint Scope

Current `lint` checks only `src/` and `bin/`. Moving custom checks into Biome may require including `test/`.

Risk: broadening lint scope to `.` may pull in extra areas such as worktrees, generated files, or documentation.

Mitigation:

- Use explicit includes for `src/`, `bin/`, and selected `test/**/*.test.ts`.
- Avoid switching directly to `biome check .` unless ignores are verified.

## Recommended Rollout

1. Upgrade Biome to `2.x` without custom-rule migration.
2. Run the official Biome migration command and review `biome.json`.
3. Run `bun run lint`, `bun run typecheck`, `bun run check:test-mocks`, and `bun run check:process-cwd`.
4. Inspect any formatting/import churn separately.
5. Add a Biome GritQL plugin for `process.cwd()` as a pilot.
6. Preserve `check:process-cwd` as a package script wrapper until CI parity is proven.
7. Leave `check:test-mocks` as a TypeScript script for now.

## References

- Biome v2 upgrade guide: https://biomejs.dev/guides/upgrade-to-biome-v2/
- Biome linter plugins: https://biomejs.dev/linter/plugins/
- Biome configuration reference: https://biomejs.dev/reference/configuration/
