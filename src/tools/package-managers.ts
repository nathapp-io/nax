/**
 * Classification and normalization for the install-shaped exec branch.
 *
 * A call is install-shaped only when `argv[0]` is a known manager AND the
 * verb is one of that manager's install verbs (`classifyExec`); such calls
 * are hardened (a no-scripts mechanism, when one is known) and normalized
 * (scoped to the story's own workspace member) by `normalizeExec`.
 * Everything else is generic: it runs exactly as given, at the target cwd,
 * with no rewriting and no mechanism — reachable only through an explicit
 * `Exec(...)` grant elsewhere in the policy.
 *
 * Both directions matter. Without the generic class, something like
 * `bun x tsc --noEmit` could never be permitted by any grant. Without the
 * "known manager plus install verb" test, a loosely classified `bun add`
 * could reach the generic path and skip its no-scripts mechanism entirely.
 * Neither class may borrow the other's treatment — this module is pure
 * classification/data lookup, no spawning, no policy, no I/O.
 */

import { MANAGER_TABLE } from "./package-managers-table";
import type { NormalizeResult, NoScripts, WorkspaceContext } from "./package-managers-types";

export type { ExecTarget, NormalizeResult } from "./package-managers-types";

import type { ExecTarget } from "./package-managers-types";

export interface NormalizeInput extends WorkspaceContext {
  readonly argv: readonly string[];
  readonly target: ExecTarget;
}

export function isKnownManager(binary: string): boolean {
  return Object.hasOwn(MANAGER_TABLE, binary);
}

/**
 * Longest-sequence-first so a multi-token verb like `["mod", "download"]`
 * matches as one verb rather than being pre-empted by a shorter prefix.
 */
function matchesInstallVerb(argv: readonly string[], installVerbs: readonly (readonly string[])[]): boolean {
  const sorted = [...installVerbs].sort((a, b) => b.length - a.length);
  for (const verb of sorted) {
    const candidate = argv.slice(1, 1 + verb.length);
    if (candidate.length === verb.length && candidate.every((token, i) => token === verb[i])) {
      return true;
    }
  }
  return false;
}

export function classifyExec(argv: readonly string[]): "install" | "generic" {
  const binary = argv[0];
  if (binary === undefined || !isKnownManager(binary)) return "generic";
  const entry = MANAGER_TABLE[binary];
  if (!entry) return "generic";
  return matchesInstallVerb(argv, entry.installVerbs) ? "install" : "generic";
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

  if (classifyExec(argv) === "generic") {
    // Generic calls get cwd from the target and nothing else — no
    // mechanism, no scoping, no rewriting of any argument.
    return { argv, cwd: effectiveTarget === "package" ? input.packageWorkdir : input.repoRoot };
  }

  const binary = argv[0] as string;
  const entry = MANAGER_TABLE[binary];
  if (!entry) return { argv, cwd: effectiveTarget === "package" ? input.packageWorkdir : input.repoRoot };

  const base = effectiveTarget === "package" ? entry.packageForm(argv, input) : entry.rootForm(argv, input);
  if (allowScripts) return base;
  return applyNoScripts(base, entry.noScripts(input));
}
