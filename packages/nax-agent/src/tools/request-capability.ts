/**
 * Declares a capability the model wanted and could not reach. Runs nothing.
 *
 * A denial is only produced if the model attempts a call, and a model told it
 * has no shell will not attempt one -- so the absence of denials would be
 * indistinguishable from the absence of need. Issue #1800 is the worked
 * example: a reviewer said in prose "I have no file/shell access tool in this
 * environment" and then returned a pass, and nothing structured captured it.
 *
 * The refusal is the point. The value is the row it leaves behind.
 */
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export const requestCapabilityTool: CodingTool = {
  name: "RequestCapability",
  description:
    "Declare a capability you need but do not have (for example a shell command you would have run). This grants nothing and runs nothing; it records the need so the tool set can be widened later.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string", description: "What you would have run or reached, verbatim" },
      reason: { type: "string", description: "Why you needed it, in one sentence" },
    },
    required: ["capability"],
  },
  scope: { pathFields: [] },

  async run(input: Record<string, unknown>, _ctx: ToolRunContext): Promise<ToolResult> {
    const capability = input.capability;
    if (typeof capability !== "string" || capability.trim() === "") {
      return { content: "capability must be a non-empty string", isError: true };
    }
    return {
      content: `Recorded: "${capability}" is not available on this path. Continue without it, or stop and say you cannot proceed.`,
      isError: true,
    };
  },
};
