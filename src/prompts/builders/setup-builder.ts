import type { RepoAnalysis } from "../../cli/setup-types";
import type { ComposeInput } from "../compose";

export class SetupPromptBuilder {
  build(analysis: RepoAnalysis): ComposeInput {
    const isMonoRepo = analysis.shape === "mono";
    const packageCount = analysis.packages.length;

    return {
      role: {
        id: "setup-role",
        content:
          "You are an expert nax configuration generator. Generate a valid nax config JSON based on the repository analysis provided.",
        overridable: false,
      },
      task: {
        id: "setup-task",
        content: [
          `Generate a nax configuration for this ${isMonoRepo ? "monorepo" : "single-package"} repository`,
          `with ${packageCount} package(s).`,
          "",
          "Repository info:",
          `- Shape: ${analysis.shape}`,
          `- Package manager: ${analysis.pmRunPrefix}`,
          `- Orchestrator: ${analysis.orchestrator}`,
          "",
          'Respond with a JSON code block containing a "config" key with the nax configuration object.',
        ].join("\n"),
        overridable: false,
      },
    };
  }
}
