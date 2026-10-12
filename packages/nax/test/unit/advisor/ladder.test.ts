import { describe, expect, test } from "bun:test";
import { ADVISOR_DEFAULTS } from "@/config";
import { advisorLadder, usableAdvisorModels } from "@/advisor/ladder";

const ds = { agent: "native", model: "opencode-go/deepseek-v4.1-flash[high]" } as const;
const sol = { agent: "native", model: "openai-codex/gpt-6.1-sol[medium]" } as const;
const sonnet = { agent: "claude", model: "sonnet[medium]" } as const;

describe("advisor ladder", () => {
  test("primary first, then fallbacks in order, duplicates dropped", () => {
    const cfg = { ...ADVISOR_DEFAULTS, model: ds, fallbackModels: [sol, ds, sonnet] };
    expect(advisorLadder(cfg)).toEqual([ds, sol, sonnet]);
  });
  test("cooling entries are skipped", () => {
    const cfg = { ...ADVISOR_DEFAULTS, model: ds, fallbackModels: [sol, sonnet] };
    expect(usableAdvisorModels(cfg, (m) => m === ds)).toEqual([sol, sonnet]);
  });
  test("an empty fallback list keeps today's single-model behaviour", () => {
    expect(advisorLadder({ ...ADVISOR_DEFAULTS, model: ds })).toEqual([ds]);
  });
});
