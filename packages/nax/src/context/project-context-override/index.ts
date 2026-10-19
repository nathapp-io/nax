/**
 * US-007 (SPEC-lazy-rules-delivery) — the run's project-context override file.
 *
 * An orchestrator that runs `nax run` across many repositories cannot commit
 * organisation-wide context into every target repo, so
 * `context.projectContext.file` names a Markdown file the run appends to each
 * story brief and to the branch review package.
 *
 * Reading it is deliberately fail-closed. The operator asked for that file, and a
 * run that silently proceeded without it would look identical to a run that
 * honoured it, so a missing file and a file past the byte cap both throw before
 * any story starts. The cap is never applied as truncation: half a context file
 * is a different document, and the agent reading it cannot tell it was cut.
 *
 * `rootInstructionDenyPaths` answers the other half of the feature. Under
 * `mode: "replace"` a native session must stop auto-loading the repository's
 * *root* instruction file, and it does that by denying reads of the names the
 * native session would otherwise discover (`instructionDenyPaths` on
 * `OpenSessionOpts`). `matchesDenyPaths`
 * (`packages/nax-agent/src/tools/deny-paths.ts`) anchors on the whole
 * repo-relative path, so a bare `AGENTS.md` denies the root file alone and a
 * package-level `packages/api/AGENTS.md` still loads.
 *
 * This module is a nested barrel reached by exact alias
 * (`@/context/project-context-override`) — the sanctioned pattern for a module
 * the workflow and the session layers both need without pulling in the
 * `@/context` parent barrel.
 */

import { DEFAULT_INSTRUCTION_FILE_NAME } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";

/** The most bytes `context.projectContext.file` may hold. Never a truncation point. */
export const MAX_PROJECT_CONTEXT_BYTES = 32_768;

/**
 * The names the native session discovers at the repository root when the
 * configured `instructionFileName` is the default.
 *
 * Mirrors `RepositoryInstructions`'s constructor
 * (`packages/nax-agent/src/native/session/repository-instructions.ts`) — the deny
 * list is only correct while it names the same files that loader would try. A
 * configured name replaces the trio there and here alike.
 */
const DEFAULT_ROOT_INSTRUCTION_FILE_NAMES = ["AGENTS.override.md", DEFAULT_INSTRUCTION_FILE_NAME, "CLAUDE.md"] as const;

/** The error both failures share; `stage: "run-setup"` matches the rules-override check beside it. */
function projectContextError(
  message: string,
  code: string,
  file: string,
  extra: Record<string, unknown> = {},
): NaxError {
  return new NaxError(message, code, { stage: "run-setup", file, ...extra });
}

/**
 * The configured `context.projectContext.file` content, verbatim, or `undefined`
 * when no file is configured.
 *
 * The size is measured in UTF-8 bytes on the bytes read from disk rather than on
 * the decoded string: a body that does not round-trip through UTF-8 would
 * otherwise measure differently from the file the operator sized.
 */
export async function loadProjectContextOverride(config: NaxConfig): Promise<string | undefined> {
  // Defensive reads: a sparse test config, or a config assembled before this key
  // existed, must not throw here — the same shape as the `context?.rules?.` reads.
  const file = config.context?.projectContext?.file;
  if (file === undefined) return undefined;
  const handle = Bun.file(file);
  if (!(await handle.exists())) {
    throw projectContextError(
      `context.projectContext.file does not exist: ${file}`,
      "PROJECT_CONTEXT_FILE_NOT_FOUND",
      file,
    );
  }
  const bytes = new Uint8Array(await handle.arrayBuffer());
  if (bytes.byteLength > MAX_PROJECT_CONTEXT_BYTES) {
    throw projectContextError(
      `context.projectContext.file is ${bytes.byteLength} bytes, over the ${MAX_PROJECT_CONTEXT_BYTES}-byte limit: ${file}`,
      "PROJECT_CONTEXT_FILE_TOO_LARGE",
      file,
      { bytes: bytes.byteLength, maxBytes: MAX_PROJECT_CONTEXT_BYTES },
    );
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The deny patterns that stop a native session auto-loading the repository's
 * *root* instruction file under `projectContext.mode: "replace"`.
 *
 * Bare basenames on purpose: a path-bearing pattern would deny one directory's
 * file, and package-level instruction files are explicitly still loaded. The name
 * arrives schema-validated (`agent.native.instructionFileName` is refined with
 * `isInstructionFileName`), so this only has to decide which names the loader
 * would have discovered — the same decision `RepositoryInstructions`'s
 * constructor makes.
 */
export function rootInstructionDenyPaths(instructionFileName: string): string[] {
  return instructionFileName === DEFAULT_INSTRUCTION_FILE_NAME
    ? [...DEFAULT_ROOT_INSTRUCTION_FILE_NAMES]
    : [instructionFileName];
}
