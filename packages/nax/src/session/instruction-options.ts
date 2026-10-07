import { isAbsolute, relative } from "node:path";
import type { OpenSessionOpts } from "@nathapp/nax-agent";
import { naxProtectedPaths } from "../agents/nax-protected-paths";
import type { AgentRunOptions } from "../agents/types";
import { packageOverrideKey } from "../runtime/packages";

type InstructionOptions = Pick<
  OpenSessionOpts,
  "instructionDirectories" | "instructionProtectedPaths" | "instructionDenyPaths"
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
    instructionDirectories: options.instructionDirectories ?? [options.codingToolWorkdirLabel ?? (packageScope || ".")],
    instructionProtectedPaths: naxProtectedPaths(),
    instructionDenyPaths: options.config.execution?.denyPaths,
  };
}
