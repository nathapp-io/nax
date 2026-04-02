# SPEC: Config Profiles

## Summary

Add named configuration profiles so users can define reusable config presets and switch between them via CLI flag, env var, or persistent setting — without manually editing `config.json`.

## Motivation

Switching between configurations today requires editing `.nax/config.json` by hand — toggling debate on/off, swapping agent models, adjusting cost limits. This is error-prone and tedious when alternating between modes (e.g. "fast cheap iteration" vs "thorough expensive review" vs "minimax benchmark").

There is no way to:
1. Store named presets and switch instantly
2. Keep per-profile API keys separate from config (security)
3. Apply a different config for a single run without persisting the change
4. Share global profiles across projects while allowing project-level overrides

## Design

### Profile storage

Two scopes — global (user-wide) and project-level:

```
~/.nax/profiles/           ← global
  fast.json
  fast.env                 ← optional companion env file
.nax/profiles/             ← project
  minimax.json
  minimax.env
```

Each profile JSON is a **partial** `NaxConfig` — only fields to override:

```json
{
  "agent": { "model": "$NAX_MODEL" },
  "execution": { "costLimit": 5.0 },
  "debate": { "enabled": false }
}
```

`default` is reserved — means "no profile applied" (today's behavior).

### `$VAR` resolution

String values may contain `$VAR` references, resolved at load time from companion `.env` files and system env. Pattern: `/\$([A-Z_][A-Z0-9_]*)/g`. Use `$$` for literal `$`.

Env resolution order: project `.env` > global `.env` > `process.env`. Env values are used **only** for `$VAR` substitution — they do NOT overwrite `process.env`.

**Fail-fast:** unresolved `$VAR` throws at startup with the variable name and profile name in the error message.

### Companion `.env` files

Standard dotenv format: `KEY=value`, `KEY="quoted"`, `# comments`, blank lines. Lines starting with `export ` are stripped to bare `KEY=value`.

### Profile merge order

```
DEFAULT_CONFIG → profile (global+project merged) → global config.json → project config.json → CLI overrides
```

Profile merge uses existing `deepMergeConfig()` — arrays replace entirely, objects deep-merge, `null` removes keys. No changes to merger logic.

### Activation mechanisms

| Method | Persists? | Priority |
|:-------|:----------|:---------|
| `--profile <name>` on `nax run`/`nax plan` | ❌ | 1 (highest) |
| `NAX_PROFILE` env var | ❌ | 2 |
| `"profile"` field in config.json | ✅ | 3 (lowest) |

Fallback when none set: `default` (no profile).

### New schema field

```typescript
// Added to NaxConfigSchema
profile: z.string().default("default")
```

### Integration point: `loadConfig()` in `src/config/loader.ts`

Profile resolution inserts between defaults and global config:

```typescript
// 1. Start with DEFAULT_CONFIG
// 2. NEW: resolve profile name (--profile > NAX_PROFILE > config "profile" field)
// 3. NEW: loadProfile() — load global + project JSON, merge, load .env, resolve $VAR
// 4. Existing: merge global config.json
// 5. Existing: merge project config.json
// 6. Existing: merge CLI overrides
```

`resolveProfileName()` for the config.json fallback: reads raw JSON from project then global config, extracts only the `profile` field — avoids circular dependency with full config loading.

### New functions

| Function | File | Purpose |
|:---------|:-----|:--------|
| `resolveProfileName(cliOverrides, env)` | `src/config/profile.ts` | Determine active profile from 3 sources |
| `loadProfile(name, startDir)` | `src/config/profile.ts` | Load + merge global/project profile JSON |
| `loadProfileEnv(name, startDir)` | `src/config/profile.ts` | Load companion `.env` files, merge into env map |
| `resolveEnvVars(config, envMap)` | `src/config/profile.ts` | Recursively replace `$VAR` in string values |
| `parseDotenv(content)` | `src/config/dotenv.ts` | Parse dotenv string → `Record<string, string>` |
| `listProfiles(startDir)` | `src/config/profile.ts` | Scan both scopes, return profile names + paths |

### CLI commands

New subcommand group under `nax config`:

```
nax config profile list              # list profiles (both scopes), mark active
nax config profile show <name>       # print resolved profile (secrets masked)
nax config profile use <name>        # persist to config.json
nax config profile current           # print active profile name
nax config profile create <name>     # scaffold empty profile JSON
```

Wired in `bin/nax.ts` under the existing `config` command using Commander `.command("profile")`.

### Error handling

- `--profile foo` when `foo.json` not found → error with profile name + available list
- `$VAR` unresolved → error with variable name + profile name + hint about `.env`
- Profile JSON parse failure → error with profile name + parse details
- Invalid config after merge → existing `NaxConfigSchema.safeParse()` handles it
- `nax config profile use default` → sets `"profile": "default"` in config.json

### Monorepo

Per-package config merges **after** profile, so profiles apply at root level. No changes to `loadConfigForWorkdir()`. The full chain:

```
defaults → profile → global config → project config → per-package config → CLI overrides
```

### Context Files (optional)

- `src/config/loader.ts` — `loadConfig()` merge chain, insertion point for profile layer
- `src/config/merger.ts` — `deepMergeConfig()`, reused as-is for profile merging
- `src/config/paths.ts` — `globalConfigDir()`, `PROJECT_NAX_DIR` constants
- `src/config/schema.ts` — `NaxConfigSchema`, add `profile` field
- `bin/nax.ts` — CLI wiring for `run --profile`, `plan --profile`, `config profile` subcommands
- `src/cli/config.ts` — config command re-exports, add profile subcommand exports

## Stories

### US-001: Profile loading and env resolution

Add `src/config/profile.ts` and `src/config/dotenv.ts`. Implement `loadProfile()`, `resolveEnvVars()`, `parseDotenv()`, and `resolveProfileName()`. Integrate into `loadConfig()` merge chain. Add `profile` field to `NaxConfigSchema`.

**Depends on:** none

**Acceptance Criteria:**
- `loadProfile("fast", projectDir)` returns deep-merged contents of `~/.nax/profiles/fast.json` and `.nax/profiles/fast.json` when both exist, with project values taking precedence
- `loadProfile("fast", projectDir)` returns only the global profile contents when no project-level `fast.json` exists
- `loadProfile("nonexistent", projectDir)` throws an error whose message contains `"nonexistent"` and at least one available profile name
- `resolveEnvVars({ a: "$FOO", b: { c: "$BAR" } }, { FOO: "x", BAR: "y" })` returns `{ a: "x", b: { c: "y" } }` (recursive resolution)
- `resolveEnvVars({ a: "$MISSING" }, {})` throws an error whose message contains `"$MISSING"`
- `resolveEnvVars({ n: 5, arr: [1,2] }, {})` returns the input unchanged (non-string values pass through)
- `resolveEnvVars({ a: "$$LITERAL" }, {})` returns `{ a: "$LITERAL" }` (escape handling)
- `parseDotenv("FOO=bar\n# comment\n\nexport BAZ=qux\nQUOTED=\"hello world\"")` returns `{ FOO: "bar", BAZ: "qux", QUOTED: "hello world" }`

### US-002: Profile activation in config loader

Wire `resolveProfileName()` into `loadConfig()` so profiles are applied between defaults and global config. Support all three activation sources: `--profile` flag, `NAX_PROFILE` env, and config.json `"profile"` field.

**Depends on:** US-001

**Acceptance Criteria:**
- `loadConfig(dir, { profile: "fast" })` merges the `fast` profile between defaults and global config.json
- `loadConfig(dir)` with `NAX_PROFILE=fast` in `process.env` applies the `fast` profile when no CLI override is present
- `loadConfig(dir)` with `"profile": "fast"` in project config.json applies the `fast` profile when neither CLI nor env override is set
- `loadConfig(dir, { profile: "fast" })` takes priority over `NAX_PROFILE=thorough` in `process.env`
- `loadConfig(dir)` with no profile set anywhere applies no profile — result matches today's behavior exactly
- Companion `.env` file values are used for `$VAR` resolution but `process.env.FOO` remains unchanged after `loadConfig()` returns

### US-003: Profile CLI commands

Add `nax config profile` subcommands: `list`, `show`, `use`, `current`, `create`. Wire into `bin/nax.ts` under the existing `config` command.

**Depends on:** US-001, US-002

**Acceptance Criteria:**
- `nax config profile list` outputs profile names from both `~/.nax/profiles/` and `.nax/profiles/`, grouped by scope label (`global` / `project`), with the active profile marked with `*`
- `nax config profile show fast` outputs the profile JSON contents with `$VAR` values resolved and any value matching known env var patterns (containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`) masked as `***`
- `nax config profile use fast` writes `"profile": "fast"` into `.nax/config.json` and prints a confirmation message
- `nax config profile use default` sets `"profile": "default"` in `.nax/config.json`
- `nax config profile current` prints the resolved profile name following the priority chain (`--profile` > `NAX_PROFILE` > config.json > `"default"`)
- `nax config profile create myprofile` creates `.nax/profiles/myprofile.json` containing `{}` and prints the created file path
- `nax config profile create myprofile` when `.nax/profiles/myprofile.json` already exists prints an error and exits with code 1

### US-004: `--profile` flag on run and plan commands

Add `--profile <name>` option to `nax run` and `nax plan` in `bin/nax.ts`. Pass the value as `cliOverrides.profile` to `loadConfig()`.

**Depends on:** US-002

**Acceptance Criteria:**
- `nax run --profile fast -f my-feature` loads config with the `fast` profile applied, without modifying `.nax/config.json`
- `nax plan --profile fast -f my-feature --from spec.md` loads config with the `fast` profile applied
- `nax run -f my-feature` without `--profile` and without `NAX_PROFILE` uses the config.json `"profile"` field, defaulting to `"default"`
- The `--profile` option appears in `nax run --help` and `nax plan --help` output
