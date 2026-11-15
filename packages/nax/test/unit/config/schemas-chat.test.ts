import { describe, expect, test } from "bun:test";
import type { ChatWorkflowConfig, NaxConfig } from "@/config";
import * as config from "@/config";

/** Every issue path a rejected config reports, dotted — the shape the operator sees. */
function issuePaths(input: unknown): string[] {
  const parsed = config.NaxConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
}

function expectRejectedAt(input: unknown, path: string): void {
  expect(issuePaths(input)).toContain(path);
}

describe("NaxConfigSchema chat.workflow", () => {
  test("AC-1: parse({}) has no chat key", () => {
    expect(Object.hasOwn(config.NaxConfigSchema.parse({}), "chat")).toBe(false);
  });

  test("AC-2: an empty workflow resolves specFixRounds to DEFAULT_SPEC_FIX_ROUNDS", () => {
    expect(config.DEFAULT_SPEC_FIX_ROUNDS).toBe(2);
    const parsed = config.NaxConfigSchema.parse({ chat: { workflow: {} } });
    expect(parsed.chat?.workflow?.specFixRounds).toBe(config.DEFAULT_SPEC_FIX_ROUNDS);
  });

  test("AC-3: keeps plan.profiles as the list given", () => {
    const parsed = config.NaxConfigSchema.parse({
      chat: { workflow: { plan: { profiles: ["codex-plan", "cc-acceptance"] } } },
    });
    expect(parsed.chat?.workflow?.plan?.profiles).toEqual(["codex-plan", "cc-acceptance"]);
  });

  test("AC-4: keeps botReview.model as given", () => {
    const parsed = config.NaxConfigSchema.parse({
      chat: { workflow: { botReview: { model: "openai-codex/gpt-6.1-sol" } } },
    });
    expect(parsed.chat?.workflow?.botReview?.model).toBe("openai-codex/gpt-6.1-sol");
  });

  test("AC-5: keeps specWriter exactly as given", () => {
    const parsed = config.NaxConfigSchema.parse({
      chat: { workflow: { specWriter: { agent: "general", model: "openai-codex/gpt-6.1-sol" } } },
    });
    expect(parsed.chat?.workflow?.specWriter).toEqual({ agent: "general", model: "openai-codex/gpt-6.1-sol" });
  });

  test("AC-6: rejects an invalid profile name at chat.workflow.plan.profiles.0", () => {
    expectRejectedAt({ chat: { workflow: { plan: { profiles: ["-bad"] } } } }, "chat.workflow.plan.profiles.0");
  });

  test("AC-7: rejects an invalid model at chat.workflow.botFix.model", () => {
    expectRejectedAt({ chat: { workflow: { botFix: { model: "bad model" } } } }, "chat.workflow.botFix.model");
  });

  test("AC-8: rejects specFixRounds 0", () => {
    expectRejectedAt({ chat: { workflow: { specFixRounds: 0 } } }, "chat.workflow.specFixRounds");
  });

  test("AC-9: rejects specFixRounds 11", () => {
    expectRejectedAt({ chat: { workflow: { specFixRounds: 11 } } }, "chat.workflow.specFixRounds");
  });

  test("AC-10: rejects specFixRounds 2.5", () => {
    expectRejectedAt({ chat: { workflow: { specFixRounds: 2.5 } } }, "chat.workflow.specFixRounds");
  });

  test("AC-11: rejects an empty specReviewer.agent", () => {
    expectRejectedAt({ chat: { workflow: { specReviewer: { agent: "" } } } }, "chat.workflow.specReviewer.agent");
  });

  test("AC-12: a profile layer replaces the project layer's profile list", () => {
    const project = { chat: { workflow: { plan: { profiles: ["a", "c"] } } } };
    const profile = { chat: { workflow: { plan: { profiles: ["b"] } } } };
    const merged = config.deepMergeConfig<NaxConfig>(project, profile);
    expect(merged.chat?.workflow?.plan?.profiles).toEqual(["b"]);
  });

  test("exports the chat types and DEFAULT_SPEC_FIX_ROUNDS from the config surface", () => {
    const workflow: ChatWorkflowConfig = { specFixRounds: config.DEFAULT_SPEC_FIX_ROUNDS };
    const parsedWorkflow: ChatWorkflowConfig | undefined = config.NaxConfigSchema.parse({ chat: { workflow } }).chat
      ?.workflow;
    expect(parsedWorkflow).toEqual(workflow);
  });

  test("an empty profiles array means not set and parses unchanged", () => {
    const parsed = config.NaxConfigSchema.parse({ chat: { workflow: { botReview: { profiles: [] } } } });
    expect(parsed.chat?.workflow?.botReview?.profiles).toEqual([]);
  });
});
