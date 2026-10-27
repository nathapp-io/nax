import type { ToolProvider } from "@nathapp/nax-agent";
import type { HostApprovalCard } from "../ask-controller";
import type { ChatJobs } from "./job-runner";
import type { ChatJobKind } from "./job-types";
import { launchToolRun } from "./jobs-launch";

export interface JobsProviderOptions {
  readonly repoRoot: string;
  readonly naxEntry: readonly string[];
  readonly maxIterations: number;
  readonly interactionPlugin: string;
  readonly jobs: ChatJobs;
  readonly approve: (card: HostApprovalCard) => Promise<"allow" | "deny">;
  readonly sessionId: () => string;
  readonly now: () => Date;
}
const profiles = { type: "array", items: { type: "string" } };
const schemas = {
  plan: { feature: { type: "string" }, spec: { type: "string" }, profiles },
  run: { feature: { type: "string" }, profiles, maxIterations: { type: "integer" }, maxCost: { type: "number" } },
  bot_review: { pr: { type: "integer" }, profiles, model: { type: "string" }, decisions: { type: "string" } },
  bot_fix: {
    pr: { type: "integer" },
    profiles,
    model: { type: "string" },
    trust: { type: "boolean" },
    noRereview: { type: "boolean" },
  },
} satisfies Record<ChatJobKind, Record<string, unknown>>;
const LAUNCH_KINDS: readonly ChatJobKind[] = ["plan", "run", "bot_review", "bot_fix"];

/** Repo-scoped static tools; every billed launch asks through the host approval port. */
export function createJobsProvider(options: JobsProviderOptions): ToolProvider {
  return {
    id: "nax-jobs",
    kind: "static",
    stages: ["*"],
    tools: async () =>
      LAUNCH_KINDS.map((kind) => ({
        localName: kind,
        description: `Billed nax ${kind} background launch; asks the user for explicit approval before starting.`,
        inputSchema: {
          type: "object",
          properties: schemas[kind],
          additionalProperties: false,
          required: [kind === "plan" || kind === "run" ? "feature" : "pr"],
        },
        run: launchToolRun(kind, options),
      })),
  };
}
