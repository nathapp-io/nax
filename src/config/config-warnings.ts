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
export function collectCommandChainWarnings(
  commands: Partial<Record<string, QualityCommandSpec>> | undefined,
): string[] {
  if (commands === undefined) return [];
  return (
    Object.entries(commands)
      // Runs pre-safeParse on raw, unvalidated config — a malformed entry (e.g.
      // `commands.test: 42`) must fall through to Zod's own error rather than
      // crash normalizeCommandSpec here.
      .filter(([, spec]) => (typeof spec === "string" || Array.isArray(spec)) && containsShellChain(spec))
      .map(
        ([key]) =>
          `quality.commands.${key} chains with \`&&\`, so it stops at the first failing step and hides the rest. ` +
          `Declare it as a list instead — e.g. ["step one", "step two"] — to run every step and report every failure in one invocation.`,
      )
  );
}
