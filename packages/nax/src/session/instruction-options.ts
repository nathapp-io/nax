import { isAbsolute, relative } from "node:path";
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { DEFAULT_INSTRUCTION_FILE_NAME } from "@nathapp/nax-agent/internal";
import { naxProtectedPaths } from "../agents/nax-protected-paths";
import type { AgentRunOptions } from "../agents/types";
import { packageOverrideKey } from "../runtime/packages";

type InstructionOptions = Pick<
  OpenSessionOpts,
  "instructionFileName" | "instructionDirectories" | "instructionProtectedPaths" | "instructionDenyPaths"
>;

/** Instructions follow package identity; the session's file-tool root stays unchanged. */
export function instructionOptionsForSession(agentName: string, options: AgentRunOptions): InstructionOptions {
  if (agentName !== "native") return {};
  const packageDir = options.codingToolPackageDir;
  const packageScope = packageDir
    ? isAbsolute(packageDir)
      ? relative(options.workdir, packageDir)
      : packageOverrideKey(packageDir)
    : ".";
  return {
    instructionFileName: options.config.agent?.native?.instructionFileName ?? DEFAULT_INSTRUCTION_FILE_NAME,
    instructionDirectories: options.instructionDirectories ?? [options.codingToolWorkdirLabel ?? (packageScope || ".")],
    instructionProtectedPaths: naxProtectedPaths(),
    instructionDenyPaths: options.config.execution?.denyPaths,
  };
}
