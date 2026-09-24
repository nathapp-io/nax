# ADR-031: Root-Scoped Command-Safety Config

**Status:** Accepted, 2026-09-24
**Builds on:** ADR-030 (bash approval modes), ADR-027 (adapter protocol split)
**Review:** xreview item #10 (§2), against the native coding agent master plan (D18/D20)

---

## Context

Review #10 found that `mergePackageConfig`'s execution spread leaks the four agent-command
safety keys — `execution.bashApproval`, `execution.approvalTimeout`, `execution.sandbox` and
`execution.commandSafety` — into package configs, undocumented. A package config at
`.nax/mono/<pkg>/config.json` that sets `execution.bashApproval: "raw"` silently widens the
root posture for that package, and nothing in the docs or the schema says whether that is
intended.

Two more paths reach the same keys. Package profiles deep-merge AFTER the per-package merge,
so a profile can undo the root's value even where the overlay itself could not. And the three
whole-feature dispatch sites — `nax finish` (`finish/phase.ts`), the deferred regression gate
(`run-regression.ts`) and the acceptance fix scope (`acceptance-fix-scope.ts`) — build ONE ask
wiring for an op that can span several packages, so a single `config` value has to stand for
the whole feature no matter what any package resolved for itself.

The `interaction` section — the approval channel those keys feed — is already root-only. The
safety knobs that decide WHEN the channel is consulted being per-package is the incoherence:
a package could set a mode whose approvals route through a channel it cannot configure.

## Decision

The four keys are **root-only**. A package config or package profile that sets one gets a
warning — `execution.<key> is root-only (ADR-031); the value set for package "<dir>" is
ignored` — and root's value applies.

Enforced in two places, both after every package-scoped layer has merged:

- `loadConfigForWorkdir` (`src/config/loader.ts`) — pins the raw merged object after the
  package-profile loop, before the guards and `safeParse`, via `pinRootOnlyKeysRaw`.
- `PackageRegistry.hydrate` (`src/runtime/packages.ts`) — pins the typed merge result via
  `pinRootOnlyKeys`, so a hydrated package view carries root's values too.

The typed/raw pair keeps one definition of the key list (`ROOT_ONLY_EXECUTION_KEYS` in
`src/config/root-only-keys.ts`): the raw form warns per differing key before validation, the
typed form silently pins an already-parsed config.

`acceptance-fix-scope.ts` passes the root config to `buildRunDispatchAskWiring` while the fix
cycle's `FixCycleContext` keeps the package config — the wiring reads only root-scoped keys,
the cycle's ops read mergeable per-package keys.

## Exception: permissions stays per-package

`execution.permissions` (including the per-stage `bashApproval` inside it) and
`permissionProfile` remain per-package. A package's permissions map REPLACES root's, and a
stage's rules resolve block -> `inherit` -> `default` through that map. Pinning a per-stage
mode back to root's would change which block supplies the stage's allow/deny — a per-stage
override is meaningless divorced from the rules it gates. This is the documented way to make
one package stricter than the root posture.

## Alternatives rejected

- **Strictest-merge across a feature's packages.** A whole-feature op could take the most
  restrictive value among the packages it spans — but that still guesses for one multi-package
  agent, and makes the posture depend on which packages a feature happens to touch.
- **One dispatch per package group.** Would restructure `nax finish` to wire and dispose a
  resolver per package; disproportionate to the problem.
- **A hard validation error.** nax exits 0 on config validation errors, so scripts would not
  notice; a warning plus the root value degrades to the safe posture instead.
- **Pinning per-stage modes too.** Rejected above — it would change which block a stage's
  allow/deny come from.

## Consequences

- There is no per-package stricter top-level mode. Tighten root, or set a per-stage mode in
  the package's permissions map (the exception above).
- `collectEffectiveRunStageModes` stays correct — the root-only pinning does not disturb the
  per-stage resolution it reports. Simplifying it in light of this ADR is deferred.
- Existing package configs that set these keys change behaviour: the root value now applies,
  with a warning naming the package and the key.

## See also

- ADR-030: the bash approval modes, approval timeout, sandbox and command-safety shadow these
  keys configure.
- D18/D20 (native coding agent master plan).
- Review #10.
