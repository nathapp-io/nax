import { dirname } from "node:path";
import type { InteractionHandler } from "#src/session/interaction-handler";
import { withInstructionAccess } from "#src/tools/instruction-access";
import type { RepositoryInstructions } from "./repository-instructions.ts";

/** Scope discovery runs in the authorized coding runtime without coupling host handlers to native. */
export function createInstructionInteraction(
  instructions: RepositoryInstructions | undefined,
  handler: InteractionHandler,
): { handler: InteractionHandler; acknowledge: () => void } {
  let acknowledged = instructions?.render() ?? "";
  return {
    acknowledge: () => {
      acknowledged = instructions?.render() ?? "";
    },
    handler: {
      onInteraction: (request) =>
        withInstructionAccess(
          async (paths, canRead, protectedPaths) => {
            if (instructions === undefined) return undefined;
            for (const path of paths) await instructions.discover(dirname(path), canRead, protectedPaths);
            if (instructions.render() === acknowledged) return undefined;
            return "Repository instructions were discovered before this mutation. No files were changed. Review the directory-scoped instructions in your updated system context and retry the tool call.";
          },
          () => handler.onInteraction(request),
        ),
    },
  };
}
