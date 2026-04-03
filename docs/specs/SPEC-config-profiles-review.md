# Review: SPEC-config-profiles

Source spec: [SPEC-config-profiles.md](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md)

## Findings

### 1. High: resolved active profile can be wrong in the final config

The spec says the loader consumes `profile` and then sets the resolved profile name in the final config.

Relevant sections:
- [docs/specs/SPEC-config-profiles.md:95](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L95)
- [docs/specs/SPEC-config-profiles.md:103](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L103)
- [docs/specs/SPEC-config-profiles.md:121](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L121)

Risk:
- The spec still merges `global config.json` and `project config.json` after profile resolution.
- If activation comes from `NAX_PROFILE`, later config layers can overwrite the `profile` field value even though the applied settings came from a different profile.

Current implementation context:
- [src/config/loader.ts:105](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L105)
- [src/config/loader.ts:133](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L133)

Example:
- `NAX_PROFILE=fast`
- project `config.json` contains `"profile": "slow"`
- effective settings come from `fast`
- final `config.profile` may incorrectly end up as `"slow"`

Recommendation:
- Explicitly require one of these behaviors:
- Strip `profile` from later config layers before merge, or
- Force-set `result.profile = resolvedProfileName` after all merges and before returning.

### 2. High: monorepo package-level profile behavior is not actually supported

The spec says no monorepo changes are needed and mentions that a package could later set its own `"profile"`.

Relevant section:
- [docs/specs/SPEC-config-profiles.md:169](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L169)

Risk:
- `loadConfigForWorkdir()` loads root config first, then merges package overrides after that.
- There is no second profile-resolution pass for package config.
- A package-level `"profile"` would therefore not apply a package-specific profile layer.

Current implementation context:
- [src/config/loader.ts:168](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L168)
- [src/config/loader.ts:192](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L192)

Recommendation:
- Either forbid `profile` in per-package config for now, or
- Define a package-aware profile resolution step explicitly.

### 3. Medium: persisted profile fallback precedence is underspecified

The spec says `resolveProfileName()` falls back to reading the `config.json "profile"` field, but it does not define whether that means:
- project config only
- global then project
- project then global

Relevant section:
- [docs/specs/SPEC-config-profiles.md:143](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L143)

Risk:
- Different implementations could produce different active profiles.
- `profile current` and startup resolution could disagree.

Current implementation context:
- The existing loader has a clear global-then-project precedence:
- [src/config/loader.ts:105](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L105)
- [src/config/loader.ts:127](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/src/config/loader.ts#L127)

Recommendation:
- Specify the same precedence explicitly for profile-field fallback.

### 4. Medium: `profile show` masking rules are too vague and may leak secrets

The command says it should print profile contents plus resolved env, with secrets masked.

Relevant sections:
- [docs/specs/SPEC-config-profiles.md:111](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L111)
- [docs/specs/SPEC-config-profiles.md:231](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L231)

Risk:
- The spec does not define whether raw env values are ever shown.
- It does not define which keys are secret.
- It does not define whether masking is based on key names, config paths, or values.

Recommendation:
- Define an explicit masking policy before implementation.
- Safer default: never print raw companion `.env` values; only show resolved config with secret-like fields redacted.

## Open Questions

### Dotenv wording conflicts

There is a small contradiction:
- [docs/specs/SPEC-config-profiles.md:48](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L48) says dotenv format has no `export` prefix
- [docs/specs/SPEC-config-profiles.md:219](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L219) says lines starting with `export ` are accepted after stripping

Recommendation:
- Normalize the wording to say `export ` is tolerated and stripped during parsing.

### `use default` behavior should be singular

The spec currently allows two behaviors:
- remove `"profile"` from config
- or set it to `"default"`

Relevant sections:
- [docs/specs/SPEC-config-profiles.md:187](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L187)
- [docs/specs/SPEC-config-profiles.md:233](/home/williamkhoo/Desktop/projects/nathapp/ai-coder/ngent/docs/specs/SPEC-config-profiles.md#L233)

Recommendation:
- Pick one behavior so the CLI contract and tests stay simple and deterministic.

## Overall

The feature direction is strong, but the spec should be tightened before implementation in these areas:
- final `config.profile` correctness
- monorepo/package behavior
- fallback precedence
- secret masking policy
