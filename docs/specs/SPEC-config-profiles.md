# SPEC: Config Profiles

## Summary

Add named configuration profiles to nax so users can define reusable config presets (different agents, models, debate settings) and switch between them without manually editing `config.json`. Profiles are partial configs that deep-merge on top of defaults, with optional companion `.env` files for environment variables. Profiles can be activated persistently, per-run via `--profile`, or via `NAX_PROFILE` env var.

## Motivation

Today, switching between configurations requires manually editing `.nax/config.json` — e.g. toggling debate on/off, swapping agent models, or changing cost limits. This is error-prone and tedious, especially when running benchmarks or alternating between "fast cheap iteration" and "thorough expensive" modes.

Users need:
1. Named presets they can switch between instantly
2. Per-profile environment variables (API keys for different providers) without embedding secrets in config
3. Both project-level and user-global profiles
4. A way to apply a profile for a single run without persisting the change

## Design

### Profile storage

Profiles are JSON files stored in `profiles/` directories at two scopes:

```
~/.nax/profiles/           ← global (user-wide)
  fast.json
  fast.env                 ← optional companion env file
  thorough.json
.nax/profiles/             ← project-level
  minimax.json
  minimax.env
  debate-heavy.json
```

Each profile JSON is a **partial** `NaxConfig` — only the fields to override:

```json
{
  "agent": { "model": "$NAX_MODEL" },
  "execution": { "costLimit": 5.0, "sessionTimeoutSeconds": 600 },
  "debate": { "enabled": false }
}
```

The `default` profile name is reserved — it represents the baseline config with no profile applied.

### Companion `.env` files

A profile named `fast` may have a companion `fast.env` loaded automatically when the profile activates. Format: standard dotenv (`KEY=value`, `#` comments, no `export` prefix).

Resolution order for env vars:
1. Profile `.env` (project scope: `.nax/profiles/<name>.env`)
2. Profile `.env` (global scope: `~/.nax/profiles/<name>.env`)
3. System environment (`process.env`)

Project `.env` values override global `.env` values. Both override system env only for `$VAR` references inside the profile JSON — they do NOT overwrite `process.env` globally.

### `$VAR` resolution in profile JSON

String values in profile JSON may contain `$VAR` references, resolved at load time:

```json
{
  "agent": { "model": "$NAX_MODEL" },
  "routing": { "llm": { "apiKey": "$MINIMAX_API_KEY" } }
}
```

Resolution: load env from companion `.env` files (project > global > system), then replace `$VAR` tokens in string values. **Unresolved `$VAR` → throw error at startup** (fail-fast, no silent empty strings). Only top-level `$VAR` in string values — no nested interpolation, no `${VAR:-default}` syntax.

### Profile merge order

The full config resolution chain becomes:

```
DEFAULT_CONFIG → global profile → project profile → global config.json → project config.json → CLI overrides
```

Profile merge uses the existing `deepMergeConfig()` from `src/config/merger.ts` — arrays replace entirely, objects deep-merge, `null` removes keys. No changes to merger logic needed.

When both global and project scopes have a profile with the same name, they merge (global first, project on top) — then that merged profile merges under the config layers.

### Profile activation (4 mechanisms)

| Method | Persists? | Priority | Use case |
|:-------|:----------|:---------|:---------|
| `nax config profile use <name>` | ✅ writes `"profile"` to config.json | 4 (lowest) | Set project default |
| `"profile": "<name>"` in config.json | ✅ already persisted | 4 | Same as above (manual edit) |
| `NAX_PROFILE=<name> nax run` | ❌ one-shot | 3 | CI / scripts |
| `nax run --profile <name>` | ❌ one-shot | 2 (highest) | Quick experiment |

Resolution: `--profile` flag > `NAX_PROFILE` env > `config.json "profile"` field > `default` (no profile).

The `default` profile name means "no profile applied" — the config loads as it does today.

### New config field: `profile`

Add to `NaxConfigSchema`:

```typescript
profile: z.string().default("default").describe("Active configuration profile name")
```

This field is read-only during merge — it's consumed by the loader to determine which profile to apply, then set to the resolved profile name in the final config.

### CLI commands

Add `profile` subcommand to `nax config`:

```
nax config profile list              # list available profiles (both scopes)
nax config profile show <name>       # print profile contents + resolved env
nax config profile use <name>        # set active profile in config.json
nax config profile current           # print current active profile name
nax config profile create <name>     # create empty profile from template
```

### Integration with `loadConfig()`

The profile loading slots into `loadConfig()` in `src/config/loader.ts` between defaults and global config:

```typescript
export async function loadConfig(startDir?, cliOverrides?): Promise<NaxConfig> {
  let rawConfig = structuredClone(DEFAULT_CONFIG);

  // NEW: Determine active profile name
  const profileName = resolveProfileName(cliOverrides, process.env);

  // NEW: Layer 0.5 — Profile (global then project)
  if (profileName !== "default") {
    const profileConfig = await loadProfile(profileName, startDir);
    if (profileConfig) {
      rawConfig = deepMergeConfig(rawConfig, profileConfig);
    }
  }

  // Layer 1: Global config (existing)
  // Layer 2: Project config (existing)
  // Layer 3: CLI overrides (existing)
  // ...existing code...
}
```

`resolveProfileName()` checks (in priority order):
1. `cliOverrides?.profile` (from `--profile` flag)
2. `process.env.NAX_PROFILE`
3. Falls back to reading `config.json "profile"` field (requires pre-loading config — read raw JSON, extract `profile` field only)

`loadProfile()`:
1. Load `~/.nax/profiles/<name>.json` (global)
2. Load `.nax/profiles/<name>.json` (project)
3. Deep-merge global + project profile
4. Load companion `.env` files (global + project)
5. Resolve `$VAR` references in merged profile JSON
6. Return resolved partial config

### `resolveEnvVars()` — env variable resolution

```typescript
function resolveEnvVars(
  config: Record<string, unknown>,
  envMap: Record<string, string>,
): Record<string, unknown>
```

Walks the config object recursively. For each string value containing `$`, replaces `$VAR_NAME` patterns using `envMap`. Throws `Error` if any `$VAR` has no matching key in `envMap`.

Pattern: `/\$([A-Z_][A-Z0-9_]*)/g` — matches `$VAR_NAME` (uppercase + underscore convention). Literal `$` that shouldn't be interpolated: use `$$` escape (resolves to single `$`).

### Monorepo consideration

Per-package config (loaded via `loadConfigForWorkdir`) merges **after** profile + root config — no changes needed. The merge chain:

```
defaults → profile → global config → root project config → per-package config → CLI overrides
```

Profiles apply at the root level. If a monorepo package needs a different profile, it can set `"profile": "<name>"` in its own `.nax/config.json` — but this is an edge case for future consideration, not in scope for this spec.

### Error handling

| Condition | Behavior |
|:----------|:---------|
| `--profile foo` but `foo.json` doesn't exist | Error: `Profile "foo" not found. Available: [list]` |
| `$VAR` in profile but env var missing | Error: `Unresolved env var "$VAR" in profile "foo". Set it in foo.env or system env.` |
| Profile JSON is invalid (parse error) | Error: `Failed to parse profile "foo": <parse error>` |
| Profile field fails Zod validation | Handled by existing `NaxConfigSchema.safeParse()` — errors surface normally |
| `nax config profile use default` | Removes `"profile"` field from config.json (or sets to `"default"`) |

## Stories

### US-001: Profile loading and `$VAR` resolution

Add `loadProfile()` and `resolveEnvVars()` to `src/config/`. Integrate profile loading into `loadConfig()` merge chain. Add `profile` field to `NaxConfigSchema`.

**Depends on:** none

**Acceptance Criteria:**
- `loadProfile("fast", projectDir)` returns the deep-merged contents of `~/.nax/profiles/fast.json` and `.nax/profiles/fast.json` when both exist
- `loadProfile("fast", projectDir)` returns only the global profile when no project profile exists
- `loadProfile("nonexistent", projectDir)` throws an error containing the profile name and a list of available profiles
- `resolveEnvVars({ "model": "$NAX_MODEL" }, { NAX_MODEL: "haiku" })` returns `{ "model": "haiku" }`
- `resolveEnvVars({ "model": "$MISSING" }, {})` throws an error containing `$MISSING`
- `resolveEnvVars({ "cost": 5.0 }, {})` passes through non-string values unchanged
- `resolveEnvVars({ "literal": "$$ESCAPED" }, {})` returns `{ "literal": "$ESCAPED" }`
- `loadConfig()` with `cliOverrides = { profile: "fast" }` applies the `fast` profile between defaults and global config
- `loadConfig()` with `NAX_PROFILE=fast` in `process.env` applies the `fast` profile when no `--profile` flag is set
- `loadConfig()` with `profile: "default"` in config.json applies no profile (same as today)

### US-002: Companion `.env` file loading

Add dotenv-style parser for `<profile>.env` files. Load from both global and project scopes, merge into env map for `$VAR` resolution.

**Depends on:** US-001

**Acceptance Criteria:**
- `loadProfileEnv("fast", projectDir)` loads `~/.nax/profiles/fast.env` and `.nax/profiles/fast.env`, with project values overriding global
- `loadProfileEnv("fast", projectDir)` returns an empty map when no `.env` files exist for the profile
- Env file parser handles `KEY=value`, `KEY="quoted value"`, blank lines, and `# comments`
- Env file parser ignores lines starting with `export ` (strips the prefix)
- Env vars from `.env` files are used for `$VAR` resolution but do NOT overwrite `process.env`
- System `process.env` values are used as fallback when a `$VAR` is not in any `.env` file

### US-003: Profile CLI commands

Add `nax config profile` subcommands: `list`, `show`, `use`, `current`, `create`.

**Depends on:** US-001, US-002

**Acceptance Criteria:**
- `nax config profile list` prints profile names from both `~/.nax/profiles/` and `.nax/profiles/`, grouped by scope, with the active profile marked
- `nax config profile show fast` prints the contents of the `fast` profile with resolved `$VAR` values (secrets masked as `***`)
- `nax config profile use fast` writes `"profile": "fast"` to `.nax/config.json`
- `nax config profile use default` removes the `"profile"` field from `.nax/config.json` (or sets it to `"default"`)
- `nax config profile current` prints the active profile name resolved from `--profile` > `NAX_PROFILE` > config.json > `"default"`
- `nax config profile create myprofile` creates `.nax/profiles/myprofile.json` with an empty object `{}` and prints the path
- `nax config profile create myprofile` returns an error if `.nax/profiles/myprofile.json` already exists

### US-004: `--profile` flag on `nax run`

Wire `--profile <name>` flag into `nax run` (and `nax plan`) CLI argument parsing. Pass as `cliOverrides.profile` to `loadConfig()`.

**Depends on:** US-001

**Acceptance Criteria:**
- `nax run --profile fast -f my-feature` loads the `fast` profile for that run without modifying config.json
- `nax plan --profile fast --from spec.md` loads the `fast` profile for planning
- `--profile` flag takes priority over `NAX_PROFILE` env var
- `--profile` flag takes priority over `"profile"` in config.json
- Running `nax run` without `--profile` when `NAX_PROFILE` is set uses the env var value
- Running `nax run` without `--profile` or `NAX_PROFILE` uses config.json `"profile"` field, defaulting to `"default"`
