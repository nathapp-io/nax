/** Additional destructive git forms, evaluated with locateGit's effective frames. */
import { NAX_OWNED_RUN_STATE_EXPLANATION } from "./denial-redirect.ts";
import { findNaxDirs, type NaxGuardContext } from "./nax-dirs.ts";
import { coversNax, isExclusionSpec, operandTouchesNax, splitOperands } from "./nax-revert.ts";

const PATH_VERBS: ReadonlySet<string> = new Set(["checkout", "restore", "rm", "reset"]);
const AUTOSTASH_VERBS: ReadonlySet<string> = new Set(["rebase", "pull", "merge"]);

/** No new refusal applies when no run-state directory is near the invocation. */
export function verbGapsRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!PATH_VERBS.has(verb) && !AUTOSTASH_VERBS.has(verb) && verb !== "sparse-checkout") return undefined;
  const nax = findNaxDirs(ctx);
  if (nax.length === 0) return undefined;
  if (AUTOSTASH_VERBS.has(verb)) {
    const flags = splitOperands(verb, args).flags;
    return flags.includes("--autostash") ? NAX_OWNED_RUN_STATE_EXPLANATION : undefined;
  }
  if (verb === "sparse-checkout") {
    return args[0] === "list" ? undefined : NAX_OWNED_RUN_STATE_EXPLANATION;
  }
  const ops = splitOperands(verb, args);
  const specs = [...ops.before, ...ops.after].filter((spec) => !isExclusionSpec(spec));
  if (specs.some((spec) => /[*?[]/.test(spec))) {
    return `${NAX_OWNED_RUN_STATE_EXPLANATION} Glob pathspecs may also select files under \`.nax/\`; name literal paths instead.`;
  }
  if (verb === "rm" || verb === "reset") {
    if (specs.some((spec) => operandTouchesNax(spec, ctx) || coversNax(spec, ctx, nax))) {
      return NAX_OWNED_RUN_STATE_EXPLANATION;
    }
  }
  return undefined;
}
