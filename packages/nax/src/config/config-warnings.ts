// Leaf import, NOT `@/quality`. The quality barrel re-exports
// self-verification.ts, which imports ../config — routing this through the
// barrel closes a config -> quality -> config cycle that `check:import-cycles`
// rejects. command-spec.ts has zero imports, so the leaf is safe, and a
// relative path is not an `@/` alias so `check:alias-internals` does not fire.
// Do not "tidy" this into a barrel import.
import { containsShellChain, type QualityCommandSpec } from "../quality/command-spec";

/**
 * Warn about `&&`-chained quality commands. A chain short-circuits, so every
 * failure after the first is hidden — and an agent pays a full round trip on a
 * growing context to discover each one (nax#1990). The chain still runs
 * exactly as before; this only points at the list form.
 */
/**
 * True when `spec` is a well-formed `QualityCommandSpec` — a string, or an
 * array whose every element is a string. Runs pre-safeParse on raw,
 * unvalidated config, where the schema is `z.union([z.string(),
 * z.array(z.string()).min(1)])` but nothing has checked that yet: a scalar
 * non-string (`42`) OR a mixed-type array (`["ok", 42]`) are both plausible
 * raw inputs. Either must fall through to Zod's own validation error rather
 * than crash `normalizeCommandSpec`'s `.trim()` call here.
 */
function isWellFormedCommandSpec(spec: unknown): spec is QualityCommandSpec {
  if (typeof spec === "string") return true;
  return Array.isArray(spec) && spec.every((entry) => typeof entry === "string");
}

export function collectCommandChainWarnings(
  commands: Partial<Record<string, QualityCommandSpec>> | undefined,
): string[] {
  if (commands === undefined) return [];
  return Object.entries(commands)
    .filter(([, spec]) => isWellFormedCommandSpec(spec) && containsShellChain(spec))
    .map(
      ([key]) =>
        `quality.commands.${key} chains with \`&&\`, so it stops at the first failing step and hides the rest. ` +
        `Declare it as a list instead — e.g. ["step one", "step two"] — to run every step and report every failure in one invocation.`,
    );
}
