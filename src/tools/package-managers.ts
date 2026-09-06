/**
 * Classification and normalization for the install-shaped exec branch.
 *
 * A call is install-shaped only when `argv[0]` is a known manager AND the
 * verb is one of that manager's install verbs; such calls are hardened (a
 * no-scripts mechanism, when one is known) and normalized (scoped to the
 * story's own workspace member) by `normalizeExec`. Everything else is
 * generic: it runs exactly as given, at the target cwd, with no rewriting
 * and no mechanism — reachable only through an explicit `Exec(...)` grant
 * elsewhere in the policy.
 *
 * Both directions matter. Without the generic class, something like
 * `bun x tsc --noEmit` could never be permitted by any grant. Without the
 * "known manager plus install verb" test, a loosely classified `bun add`
 * could reach the generic path and skip its no-scripts mechanism entirely.
 * Neither class may borrow the other's treatment — this module is pure
 * classification/data lookup, no spawning, no policy, no I/O.
 *
 * Classification is FAIL-CLOSED (fix round 1, Critical finding 1). A global
 * flag ahead of the verb (`npm --loglevel=silent install x`) must not push
 * a real install onto the unhardened generic path, but a flag's own VALUE
 * token must not be mistaken for the verb either. Three branches, in order:
 *
 *   1. Find the first token after argv[0] that does not start with "-". If
 *      it (or the token sequence starting there, for multi-token verbs
 *      like `go mod download`) matches one of this manager's install verbs
 *      (aliases included), the call is install-shaped.
 *   2. Otherwise, if ANY token anywhere in argv equals one of this
 *      manager's install verb tokens, DENY, naming the token. This is the
 *      fail-closed branch: `npm --loglevel silent install x` has "silent"
 *      as its first non-flag token (branch 1 misses, because a flag's
 *      value is not the verb), so the "install" token later in argv trips
 *      this branch instead. That is deliberate — a visible refusal the
 *      model can retry without the global flag beats a silent unhardened
 *      install. Do not "improve" this into a fall-through to generic.
 *   3. Otherwise the call is generic.
 *
 * A manager invocation can also be DISGUISED rather than merely flag-led
 * (addendum finding B): `npx`/`bunx`/`pnpx` run an arbitrary package outside
 * this table's model entirely, and `pnpm dlx npm install x` / `yarn dlx bun
 * add x` launder a real manager invocation through a dlx-style verb. Both
 * shapes are denied before verb classification even runs — there is no
 * argv shape here this table can normalize safely, so neither may fall
 * through to generic. `argv[0]` is also case- and executable-suffix-
 * normalized (`NPM`, `npm.cmd`, `npm.exe` all resolve to the `npm` entry)
 * before every manager lookup; the path-separator form (`./npm`) is already
 * refused upstream by `validateArgv` in `exec-guard.ts` and is not
 * duplicated here.
 *
 * A directory-redirect flag (`--cwd`, `--dir`, `--manifest-path`, ...) is
 * denied on the same basis (fix round 2): `target` is a closed enum
 * precisely so no path can arrive from the model, and a flag like this
 * hands that choice straight back. Manager-global redirect flags are
 * screened for install-shaped AND generic calls alike — see
 * `package-managers-table.ts`'s file header for the full per-manager table
 * of which flags are global versus install-only.
 */

import { normalizeFlagToken } from "./exec-guard";
import { MANAGER_TABLE } from "./package-managers-table";
import type { NormalizeResult, NoScripts, WorkspaceContext } from "./package-managers-types";

export type { ExecTarget, NormalizeResult } from "./package-managers-types";

import type { ExecTarget } from "./package-managers-types";

export interface NormalizeInput extends WorkspaceContext {
  readonly argv: readonly string[];
  readonly target: ExecTarget;
}

/** Package runners that execute an arbitrary, model-named package outside
 * this table's model entirely — always denied, never generic. */
const RUNNER_BINARIES: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

const DLX_VERB = "dlx";

/**
 * Lowercases and strips a trailing executable suffix so `NPM`, `npm.cmd`
 * and `npm.exe` all resolve to the same `MANAGER_TABLE` entry as `npm`.
 * Path-separator forms (`./npm`, `..\npm.exe`) are refused upstream by
 * `validateArgv` in `exec-guard.ts` and are not re-checked here.
 */
function normalizeManagerBinary(token: string): string {
  return token.toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "");
}

export function isKnownManager(binary: string): boolean {
  return Object.hasOwn(MANAGER_TABLE, normalizeManagerBinary(binary));
}

/**
 * `pnpm dlx npm install x` / `yarn dlx bun add x`: a manager plus a
 * dlx-style verb whose remaining tokens name another known manager. That is
 * a manager invocation wearing a disguise, not an ordinary dlx package run
 * (`pnpm dlx cowsay hello` is untouched — "cowsay" is not a known manager).
 * Returns the disguised manager's token, or undefined when there is none.
 */
function disguisedManagerToken(argv: readonly string[]): string | undefined {
  const second = argv[1];
  if (second === undefined || second.toLowerCase() !== DLX_VERB) return undefined;
  return argv.slice(2).find((token) => isKnownManager(token));
}

/**
 * Longest-sequence-first so a multi-token verb like `["mod", "download"]`
 * matches as one verb rather than being pre-empted by a shorter prefix.
 */
function matchesVerbAt(argv: readonly string[], pos: number, installVerbs: readonly (readonly string[])[]): boolean {
  const sorted = [...installVerbs].sort((a, b) => b.length - a.length);
  for (const verb of sorted) {
    const candidate = argv.slice(pos, pos + verb.length);
    if (candidate.length === verb.length && candidate.every((token, i) => token === verb[i])) {
      return true;
    }
  }
  return false;
}

interface Classification {
  readonly kind: "install" | "generic" | "deny";
  readonly reason?: string;
}

function classify(argv: readonly string[]): Classification {
  const rawBinary = argv[0];
  if (rawBinary === undefined) return { kind: "generic" };

  if (RUNNER_BINARIES.has(normalizeManagerBinary(rawBinary))) {
    return {
      kind: "deny",
      reason: `"${rawBinary}" is a package runner that executes an arbitrary package; it cannot be classified as install-shaped or safely treated as generic`,
    };
  }

  if (isKnownManager(rawBinary)) {
    const disguised = disguisedManagerToken(argv);
    if (disguised !== undefined) {
      return {
        kind: "deny",
        reason: `"${rawBinary} ${argv[1]}" runs "${disguised}" — a disguised manager invocation via a dlx-style verb`,
      };
    }
  }

  const normalizedBinary = normalizeManagerBinary(rawBinary);
  const entry = MANAGER_TABLE[normalizedBinary];
  if (!entry) return { kind: "generic" };

  // Branch 1: the first non-flag token after argv[0] (or the sequence
  // starting there) matches an install verb.
  const firstNonFlagIndex = argv.findIndex((token, i) => i > 0 && !token.startsWith("-"));
  if (firstNonFlagIndex !== -1 && matchesVerbAt(argv, firstNonFlagIndex, entry.installVerbs)) {
    return { kind: "install" };
  }

  // Branch 2 (fail-closed): an install verb token appears somewhere else in
  // argv. The call looks like an install but is not in a position this
  // policy can normalize safely — deny, do not guess generic.
  const flatVerbTokens = new Set(entry.installVerbs.flat());
  for (let i = 1; i < argv.length; i++) {
    if (flatVerbTokens.has(argv[i] as string)) {
      return {
        kind: "deny",
        reason: `argv contains the install verb "${argv[i]}" but not in a position this policy can classify safely: ${argv.join(" ")}`,
      };
    }
  }

  // Branch 3: generic.
  return { kind: "generic" };
}

export function classifyExec(argv: readonly string[]): "install" | "generic" | "deny" {
  return classify(argv).kind;
}

/**
 * A scripts-control flag the model added itself (`--ignore-scripts`, or its
 * negation `--no-ignore-scripts`) is not trusted, in either direction: the
 * no-scripts mechanism this table appends must be the only thing deciding
 * that, driven by `install.allowScripts` in project config — a human
 * decision — never by a flag in the model-authored argv. Addendum finding
 * C. Matches case- and `=`-normalized, mirroring `deniedFlag` in
 * `exec-guard.ts`.
 */
const SCRIPTS_CONTROL_FLAG = /^--(no-)?ignore-scripts$/;

function scriptsControlConflict(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (SCRIPTS_CONTROL_FLAG.test(normalizeFlagToken(token))) return token;
  }
  return undefined;
}

function applyNoScripts(result: NormalizeResult, mechanism: NoScripts): NormalizeResult {
  if ("error" in result) return result;
  if ("none" in mechanism) return result;
  if ("flag" in mechanism) {
    return { ...result, argv: [...result.argv, mechanism.flag] };
  }
  return { ...result, env: { ...result.env, ...mechanism.env } };
}

export function normalizeExec(input: NormalizeInput): NormalizeResult {
  const { argv, target, packageRelPath, allowScripts } = input;

  // Rule: packageRelPath === "" means the story IS the repo root — both
  // targets collapse to repoRoot, and no scoping flag naming a member is
  // ever added.
  const effectiveTarget: ExecTarget = packageRelPath === "" ? "repoRoot" : target;

  const classification = classify(argv);
  if (classification.kind === "deny") {
    return { error: classification.reason as string };
  }

  const binary = argv[0] as string;
  const entry = MANAGER_TABLE[normalizeManagerBinary(binary)];

  // Fix round 2: a directory-redirect flag global to the manager hands cwd
  // control back to the model regardless of whether the call is
  // install-shaped or generic — `target` is a closed enum precisely so no
  // path can arrive from the model, and this is the containment property
  // itself. Checked before branching on classification kind so a generic
  // call (`bun x tsc --cwd /elsewhere`) cannot escape it either.
  if (entry) {
    const globalDirConflict = entry.globalDirectoryConflict(argv);
    if (globalDirConflict !== undefined) {
      return {
        error: `argv already redirects the working directory via "${globalDirConflict}"; this policy computes and controls cwd, never the model-authored argv`,
      };
    }
  }

  if (classification.kind === "generic") {
    // Generic calls get cwd from the target and nothing else — no
    // mechanism, no scoping, no rewriting of any argument.
    return { argv, cwd: effectiveTarget === "package" ? input.packageWorkdir : input.repoRoot };
  }

  if (!entry) {
    // Unreachable: classify() only returns "install" for a binary that
    // resolved to a MANAGER_TABLE entry. Kept as a defensive fallback
    // rather than a non-null assertion (postfix `!` is banned in this repo).
    return { argv, cwd: effectiveTarget === "package" ? input.packageWorkdir : input.repoRoot };
  }

  const installDirConflict = entry.installDirectoryConflict(argv);
  if (installDirConflict !== undefined) {
    return {
      error: `argv already redirects the install destination via "${installDirConflict}"; this policy computes and controls cwd, never the model-authored argv`,
    };
  }

  // Fix round 1, Critical finding 2 + addendum C: DENY rather than strip
  // when the incoming argv already carries a flag that would smuggle in a
  // second workspace member, or a scripts-control flag the model is not
  // entitled to set. Stripping either would change what the model asked
  // for while reporting success.
  const scopeConflict = entry.scopingConflict(argv);
  if (scopeConflict !== undefined) {
    return {
      error: `argv already scopes this call via "${scopeConflict}"; refusing rather than combining it with the story's own package scoping`,
    };
  }
  const scriptsConflict = scriptsControlConflict(argv);
  if (scriptsConflict !== undefined) {
    return {
      error: `argv already carries the scripts-control flag "${scriptsConflict}"; the no-scripts mechanism is decided by project config (install.allowScripts), never by the model-authored argv`,
    };
  }

  if (effectiveTarget === "package" && entry.needsPackageName && !input.packageName) {
    return { error: `${binary} workspace scoping requires the member package's manifest name` };
  }

  const base = effectiveTarget === "package" ? entry.packageForm(argv, input) : entry.rootForm(argv, input);
  if (allowScripts) return base;
  return applyNoScripts(base, entry.noScripts(input));
}
