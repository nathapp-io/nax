import { afterEach, describe, expect, mock, test } from "bun:test";
import type { JobLaunchInput } from "@/chat/jobs/job-argv";
import { _workflowDefaultsDeps, applyWorkflowDefaults, unknownWorkflowProfile } from "@/chat/jobs/workflow-defaults";
import type { ChatWorkflowConfig } from "@/config";

const originalDeps = { ..._workflowDefaultsDeps };

afterEach(() => {
  Object.assign(_workflowDefaultsDeps, originalDeps);
});

function workflow(overrides: Partial<ChatWorkflowConfig> = {}): ChatWorkflowConfig {
  return { specFixRounds: 2, ...overrides };
}

const plan = (profiles: readonly string[]): JobLaunchInput => ({ kind: "plan", feature: "f1", profiles });
const publish = (profiles: readonly string[]): JobLaunchInput => ({ kind: "publish", feature: "f1", profiles });
const botReview = (profiles: readonly string[], model?: string): JobLaunchInput => ({
  kind: "bot_review",
  pr: 7,
  profiles,
  ...(model === undefined ? {} : { model }),
});
const botFix = (profiles: readonly string[], model?: string): JobLaunchInput => ({
  kind: "bot_fix",
  pr: 7,
  profiles,
  ...(model === undefined ? {} : { model }),
});

describe("applyWorkflowDefaults", () => {
  test("AC-1 a plan takes workflow.plan.profiles when the request names none", () => {
    const applied = applyWorkflowDefaults(plan([]), workflow({ plan: { profiles: ["p1", "p2"] } }));
    expect(applied.input.profiles).toEqual(["p1", "p2"]);
  });
  test("AC-2 names chat.workflow.plan as the source of plan profiles", () => {
    const applied = applyWorkflowDefaults(plan([]), workflow({ plan: { profiles: ["p1"] } }));
    expect(applied.profilesFrom).toBe("chat.workflow.plan");
  });
  test("AC-3 request profiles win over the configured list", () => {
    const applied = applyWorkflowDefaults(plan(["x"]), workflow({ plan: { profiles: ["p1"] } }));
    expect(applied.input.profiles).toEqual(["x"]);
    expect(applied.profilesFrom).toBeUndefined();
  });
  test("AC-9 publish takes workflow.run.profiles and names chat.workflow.run", () => {
    const applied = applyWorkflowDefaults(publish([]), workflow({ run: { profiles: ["r1"] } }));
    expect(applied.input.profiles).toEqual(["r1"]);
    expect(applied.profilesFrom).toBe("chat.workflow.run");
  });
  test("AC-5 bot_fix takes workflow.botFix.model when the request names no model", () => {
    const applied = applyWorkflowDefaults(botFix([]), workflow({ botFix: { model: "openai-codex/gpt-6.1-sol" } }));
    expect(applied.input).toMatchObject({ kind: "bot_fix", model: "openai-codex/gpt-6.1-sol" });
    expect(applied.modelFrom).toBe("chat.workflow.botFix");
  });
  test("AC-6 an explicit bot_review model is kept and has no source", () => {
    const applied = applyWorkflowDefaults(botReview([], "m/explicit"), workflow({ botReview: { model: "m/conf" } }));
    expect(applied.input).toMatchObject({ kind: "bot_review", model: "m/explicit" });
    expect(applied.modelFrom).toBeUndefined();
  });
  test("AC-7 request profiles and a configured model are applied independently", () => {
    const applied = applyWorkflowDefaults(
      botReview(["x"]),
      workflow({ botReview: { profiles: ["y"], model: "m/conf" } }),
    );
    expect(applied.input.profiles).toEqual(["x"]);
    expect(applied.input).toMatchObject({ model: "m/conf" });
    expect(applied.profilesFrom).toBeUndefined();
    expect(applied.modelFrom).toBe("chat.workflow.botReview");
  });
  test("AC-8 no workflow leaves the input unchanged with no sources", () => {
    const input = botFix(["x"], "m/explicit");
    const applied = applyWorkflowDefaults(input, undefined);
    expect(applied.input).toEqual(input);
    expect({ profilesFrom: applied.profilesFrom, modelFrom: applied.modelFrom }).toEqual({
      profilesFrom: undefined,
      modelFrom: undefined,
    });
  });
  test("AC-9 an empty configured list means not set", () => {
    const applied = applyWorkflowDefaults(plan([]), workflow({ plan: { profiles: [] } }));
    expect(applied.input.profiles).toEqual([]);
    expect(applied.profilesFrom).toBeUndefined();
  });
  test("does not mutate the caller's input", () => {
    const input = plan([]);
    applyWorkflowDefaults(input, workflow({ plan: { profiles: ["p1"] } }));
    expect(input.profiles).toEqual([]);
  });
});

describe("unknownWorkflowProfile", () => {
  test("AC-14 names the first unknown configured profile and the known ones", async () => {
    const listProfileNames = mock(async () => ["p1"]);
    _workflowDefaultsDeps.listProfileNames = listProfileNames;
    const applied = {
      input: { profiles: ["p1", "ghost"] },
      profilesFrom: "chat.workflow.plan",
    };
    expect(await unknownWorkflowProfile(applied, "/repo")).toBe(
      "[chat] chat.workflow.plan.profiles names unknown profile ghost; known: p1",
    );
    expect(listProfileNames).toHaveBeenCalledWith("/repo");
  });
  test("AC-15 no configured source means no lookup and no error", async () => {
    const listProfileNames = mock(async () => ["p1"]);
    _workflowDefaultsDeps.listProfileNames = listProfileNames;
    expect(await unknownWorkflowProfile({ input: { profiles: ["ghost"] } }, "/repo")).toBeUndefined();
    expect(listProfileNames).not.toHaveBeenCalled();
  });
  test("every known configured profile passes", async () => {
    _workflowDefaultsDeps.listProfileNames = async () => ["p1", "p2"];
    const applied = { input: { profiles: ["p1", "p2"] }, profilesFrom: "chat.workflow.plan" };
    expect(await unknownWorkflowProfile(applied, "/repo")).toBeUndefined();
  });
});
