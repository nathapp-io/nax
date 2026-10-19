import { isAbsolute, relative } from "node:path";
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { DEFAULT_INSTRUCTION_FILE_NAME } from "@nathapp/nax-agent/internal";
// US-007: the nested barrel, by exact alias — the same module the run-setup check
// and the workflow use, never an internal path inside it.
import { rootInstructionDenyPaths } from "@/context/project-context-override";
import { naxProtectedPaths } from "../agents/nax-protected-paths";
import type { AgentRunOptions } from "../agents/types";
import { packageOverrideKey } from "../runtime/packages";

type InstructionOptions = Pick<
  OpenSessionOpts,
  "instructionFileName" | "instructionDirectories" | "instructionProtectedPaths" | "instructionDenyPaths"
>;

/**
 * US-007 — the root instruction names a `projectContext.mode: "replace"` run denies.
 *
 * The deny is only meaningful when the run also supplies a project-context file:
 * with nothing to replace the repository's own context with, dropping the root
 * instruction file would lose context rather than substitute it. `undefined`
 * means "no extra denies", so the caller keeps the configured list as it stands.
 */
function replaceModeDenyPaths(options: AgentRunOptions, instructionFileName: string): string[] | undefined {
  const projectContext = options.config.context?.projectContext;
  if (projectContext?.mode !== "replace" || projectContext.file === undefined) return undefined;
  return rootInstructionDenyPaths(instructionFileName);
}

/** Instructions follow package identity; the session's file-tool root stays unchanged. */
export function instructionOptionsForSession(agentName: string, options: AgentRunOptions): InstructionOptions {
  if (agentName !== "native") return {};
  const packageDir = options.codingToolPackageDir;
  const packageScope = packageDir
    ? isAbsolute(packageDir)
      ? relative(options.workdir, packageDir)
      : packageOverrideKey(packageDir)
    : ".";
  const instructionFileName = options.config.agent?.native?.instructionFileName ?? DEFAULT_INSTRUCTION_FILE_NAME;
  const configuredDenyPaths = options.config.execution?.denyPaths;
  const replaceDenyPaths = replaceModeDenyPaths(options, instructionFileName);
  return {
    instructionFileName,
    instructionDirectories: options.instructionDirectories ?? [options.codingToolWorkdirLabel ?? (packageScope || ".")],
    instructionProtectedPaths: naxProtectedPaths(),
    instructionDenyPaths:
      replaceDenyPaths === undefined ? configuredDenyPaths : [...(configuredDenyPaths ?? []), ...replaceDenyPaths],
  };
}
